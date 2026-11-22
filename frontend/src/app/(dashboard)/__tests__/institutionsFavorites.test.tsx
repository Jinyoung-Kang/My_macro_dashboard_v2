/**
 * 13F 포트폴리오의 '즐겨찾기'(ADR 0048) — 기관 목록 응답의 favorites를 왼쪽 두 번째 거르기 목록으로, 두 목록이 고른 기관 하나를 함께 씀, 처음 여는 요청 수는
 * 그대로(목록 응답 하나에 함께 옴), 운영자만 '편집'(찾기는 누를 때만 — 숫자는 CIK로 바로, 더하기 뒤 목록 다시 읽기, 지우기는 확인 창). 응답은 모두 합성 값.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  class ApiError extends Error {
    constructor(message: string, public status: number) {
      super(message);
    }
  }
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError, ApiError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ MultiLineSeries: () => null, WeightHeatmap: () => null }));

import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { SessionUser } from "@/lib/types";
import InstitutionsPage from "../institutions/page";

const BERKSHIRE = "0001067983";
const FAV = "0009900001";
const OWNER: SessionUser = { email: "o@test.local", role: "OWNER", tier: "PRO" };
const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "PRO" };

const LIST = {
  institutions: [{ key: "berkshire", name: "가상 버크셔 (Fictional Berkshire)", cik: BERKSHIRE, desc: "가치" }],
  favorites: [
    { key: `fav-${FAV}`, name: "가짜 운용 (Fake Capital)", cik: FAV, desc: "더한 기관", secName: "FAKE CAPITAL LLC", stored: true, source: "q8",
      latestReportDate: "2026-06-30", alertRules: 2 },
  ],
  favoriteLimit: 20,
};

function portfolio(cik: string, name: string) {
  return {
    available: true, cik, institution: { name, desc: "" }, quarters: [{ filingDate: "2026-08-14", reportDate: "2026-06-30", totalValue: 1e9, holdingCount: 1 }],
    latest: { reportDate: "2026-06-30", filingDate: "2026-08-14", totalValue: 1e9 },
    holdings: [{ name: "FAKE CO", cusip: "999999991", class: "COM", value: 1e9, shares: 1, weight: 100, weightDiff: null, sharesDiff: null, action: "유지" }],
    weightHistory: { dates: [], series: {} },
  };
}

let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = {
    [endpoints.institution.institutions]: LIST,
    [endpoints.institution.portfolio(BERKSHIRE, "8", "30")]: portfolio(BERKSHIRE, "가상 버크셔 (Fictional Berkshire)"),
    [endpoints.institution.portfolio(FAV, "8", "30")]: portfolio(FAV, "가짜 운용 (Fake Capital)"),
  };
  for (const fn of [api.apiGetShared, api.apiGet, api.apiPost, api.apiDelete]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(cleanup);

const renderAs = (user: SessionUser) =>
  render(
    <SessionUserProvider user={user}>
      <InstitutionsPage />
    </SessionUserProvider>,
  );
const paths = () => (api.apiGetShared.mock.calls as unknown as [string][]).map(([path]) => path);

describe("13F 즐겨찾기 목록", () => {
  it("기관 목록 응답의 favorites가 '즐겨찾기' 목록 — 고르면 그 기관 포트폴리오, 두 목록이 고름 하나를 함께 씀, 처음 요청은 그대로", async () => {
    renderAs(MEMBER);
    const favorites = await screen.findByRole("radiogroup", { name: "즐겨찾기 기관" });
    const fav = within(favorites).getByRole("radio", { name: "가짜 운용 (Fake Capital)" });
    expect(fav.getAttribute("aria-checked")).toBe("false");
    await screen.findByRole("heading", { level: 2, name: "가상 버크셔 (Fictional Berkshire)" });
    // 처음 여는 요청 — 기관 목록·포트폴리오·원/달러 셋(즐겨찾기는 목록 응답에 함께 옴)
    expect(new Set(paths())).toEqual(new Set([endpoints.institution.institutions, endpoints.institution.portfolio(BERKSHIRE, "8", "30"), endpoints.macro.usdkrw]));

    fireEvent.click(fav);
    expect(await screen.findByRole("heading", { level: 2, name: "가짜 운용 (Fake Capital)" })).toBeTruthy();
    expect(paths()).toContain(endpoints.institution.portfolio(FAV, "8", "30"));
    expect(within(favorites).getByRole("radio", { name: "가짜 운용 (Fake Capital)" }).getAttribute("aria-checked")).toBe("true");
    const defaults = screen.getByRole("radiogroup", { name: "분석할 기관" });
    expect(within(defaults).getByRole("radio", { name: "가상 버크셔 (Fictional Berkshire)" }).getAttribute("aria-checked")).toBe("false");
    // 회원에게는 편집이 없음
    expect(screen.queryByRole("button", { name: /편집/ })).toBeNull();
  });

  it("즐겨찾기가 없으면 안내 글(예전 응답 — favorites 없음도 같음)", async () => {
    reads[endpoints.institution.institutions] = { institutions: LIST.institutions };
    renderAs(MEMBER);
    const panel = (await screen.findByRole("heading", { level: 2, name: "즐겨찾기" })).closest("section") as HTMLElement;
    expect(within(panel).getByText("즐겨찾기한 기관이 없습니다.")).toBeTruthy();
  });
});

describe("13F 즐겨찾기 편집(운영자)", () => {
  async function openEditor() {
    renderAs(OWNER);
    fireEvent.click(await screen.findByRole("button", { name: "편집 13F 즐겨찾기" }));
    return screen.findByRole("dialog", { name: "13F 즐겨찾기 편집" });
  }

  it("이름으로 찾기(누를 때만) → 후보 상태 표시 → 고르기 → 표시 이름과 함께 더하기 → 목록 다시 읽기", async () => {
    api.apiGet.mockResolvedValue({
      ok: true, query: "fake",
      candidates: [{ cik: FAV, name: "FAKE CAPITAL LLC", status: "favorite" }, { cik: "0009900002", name: "FAKE TWO LLC", status: null }],
    });
    api.apiPost.mockResolvedValue({ ok: true, collection: "collected", message: "즐겨찾기에 더하고 13F를 모았습니다." });
    const dialog = await openEditor();
    const input = within(dialog).getByLabelText("기관 이름(영문) 또는 CIK");
    fireEvent.change(input, { target: { value: "fake" } });
    expect(api.apiGet).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "찾기" }));
    const found = await within(dialog).findByRole("list", { name: "찾은 기관" });
    expect(api.apiGet).toHaveBeenCalledWith(endpoints.institution.favoriteSearch("fake"));
    expect(within(found).getByText("즐겨찾기에 있음")).toBeTruthy();
    fireEvent.click(within(found).getByRole("button", { name: "고르기 FAKE TWO LLC" }));
    fireEvent.change(within(dialog).getByLabelText(/표시 이름/), { target: { value: " 가짜 둘 " } });
    const before = paths().filter((path) => path === endpoints.institution.institutions).length;
    fireEvent.click(within(dialog).getByRole("button", { name: "즐겨찾기에 더하기" }));
    await within(dialog).findByText("즐겨찾기에 더하고 13F를 모았습니다.");
    expect(api.apiPost).toHaveBeenCalledWith(endpoints.institution.favorites, { cik: "0009900002", displayName: "가짜 둘", description: undefined });
    await waitFor(() => expect(paths().filter((path) => path === endpoints.institution.institutions).length).toBe(before + 1));
  });

  // QA-986: 후보마다 최근 13F 공시일이 없어 오래 전에 멈춘 제출자인지 고르기 전에 알 수 없었습니다.
  it.fails("QA-986 후보마다 최근 13F 공시일, 최근 공시 목록에 13F-HR이 없으면 그 사실과 고르기 없음", async () => {
    api.apiGet.mockResolvedValue({
      ok: true, query: "fake",
      candidates: [
        { cik: "0009900002", name: "FAKE TWO LLC", status: null, latest13F: { filingDate: "2026-08-14", reportDate: "2026-06-30" }, checked: true },
        { cik: "0009900003", name: "FAKE THREE LLC", status: null, latest13F: null, checked: true },
        { cik: "0009900004", name: "FAKE FOUR LLC", status: null, latest13F: null, checked: false },
      ],
    });
    const dialog = await openEditor();
    fireEvent.change(within(dialog).getByLabelText("기관 이름(영문) 또는 CIK"), { target: { value: "fake" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "찾기" }));
    const found = await within(dialog).findByRole("list", { name: "찾은 기관" });
    const rows = within(found).getAllByRole("listitem");
    expect(rows[0].textContent).toContain("최근 13F 2026-08-14 공시(2026-06-30 기준)");
    expect(rows[1].textContent).toContain("최근 공시 목록에 13F-HR 없음");
    expect(within(rows[1]).queryByRole("button", { name: /고르기/ })).toBeNull();
    expect(rows[2].textContent).toContain("공시일 확인 못 함");
    expect(within(rows[2]).getByRole("button", { name: /고르기/ })).toBeTruthy();
  });

  it("숫자는 SEC 이름 검색 없이 CIK 후보로(10자리로 채움), 기본 12곳이면 그 표시", async () => {
    const dialog = await openEditor();
    const input = within(dialog).getByLabelText("기관 이름(영문) 또는 CIK");
    fireEvent.change(input, { target: { value: "9900003" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "찾기" }));
    const found = await within(dialog).findByRole("list", { name: "찾은 기관" });
    expect(within(found).getByText("CIK 0009900003", { selector: "span.font-mono" })).toBeTruthy();
    expect(api.apiGet).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "1067983" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "찾기" }));
    expect(await within(dialog).findByText("기본 12곳")).toBeTruthy();
  });

  it("더하기 실패는 서버 사유 그대로, 지우기는 확인 창 뒤 DELETE", async () => {
    api.apiPost.mockRejectedValue(new api.ApiError("이 CIK는 SEC 최근 공시 목록에 13F-HR(원본) 공시가 없습니다 — 13F 보고 기관인지 확인하세요.", 422));
    api.apiDelete.mockResolvedValue({ ok: true, message: "즐겨찾기에서 지웠습니다." });
    const dialog = await openEditor();
    fireEvent.change(within(dialog).getByLabelText("기관 이름(영문) 또는 CIK"), { target: { value: "9900004" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "찾기" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "고르기 CIK 0009900004" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "즐겨찾기에 더하기" }));
    expect(await within(dialog).findByText(/13F-HR\(원본\) 공시가 없습니다/)).toBeTruthy();

    const current = within(dialog).getByRole("region", { name: "지금 즐겨찾기" });
    fireEvent.click(within(current).getByRole("button", { name: "지우기 가짜 운용 (Fake Capital)" }));
    const confirm = await screen.findByRole("alertdialog", { name: "즐겨찾기에서 지울까요?" }).catch(() => screen.findByRole("dialog", { name: "즐겨찾기에서 지울까요?" }));
    // 그 기관의 13F 신규 편입 알림 규칙 수(운영자 목록의 alertRules — ADR 0048 단계 3)
    expect(confirm.textContent).toContain("알림 규칙 2개도 함께 지웁니다");
    expect(api.apiDelete).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "지우기" }));
    await waitFor(() => expect(api.apiDelete).toHaveBeenCalledWith(endpoints.institution.favorite(FAV)));
  });
});
