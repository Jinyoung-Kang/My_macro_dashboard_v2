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
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiPatch: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError, ApiError };
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
  for (const fn of [api.apiGetShared, api.apiGet, api.apiPost, api.apiDelete, api.apiPatch]) fn.mockReset();
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
  it("QA-986 후보마다 최근 13F 공시일, 최근 공시 목록에 13F-HR이 없으면 그 사실과 고르기 없음", async () => {
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

  it("즐겨찾기 목록은 보이는 이름 글자순 — 패널과 편집 목록 모두, 더한 순(서버 차례)이 아니라", async () => {
    reads[endpoints.institution.institutions] = {
      ...LIST,
      favorites: [
        { ...LIST.favorites[0], cik: "0009900003", key: "fav-0009900003", name: "시타델", secName: "CITADEL ADVISORS LLC" },
        { ...LIST.favorites[0], cik: "0009900004", key: "fav-0009900004", name: "ARK Invest", secName: "ARK Investment Management LLC" },
        { ...LIST.favorites[0], cik: "0009900005", key: "fav-0009900005", name: "르네상스", secName: "RENAISSANCE TECHNOLOGIES LLC" },
      ],
    };
    renderAs(OWNER);
    // 대화상자가 열리면 뒤 화면은 낭독기에서 숨으므로 패널 차례를 먼저 봅니다.
    const panel = await screen.findByRole("radiogroup", { name: "즐겨찾기 기관" });
    expect(within(panel).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["르네상스", "시타델", "ARK Invest"]);
    fireEvent.click(screen.getByRole("button", { name: "편집 13F 즐겨찾기" }));
    const dialog = await screen.findByRole("dialog", { name: "13F 즐겨찾기 편집" });
    const current = within(dialog).getByRole("region", { name: "지금 즐겨찾기" });
    expect(within(current).getAllByRole("button", { name: /^고치기/ }).map((button) => button.textContent)).toEqual([
      "고치기 르네상스", "고치기 시타델", "고치기 ARK Invest",
    ]);
  });

  it("표시 이름·설명 고치기 — 칸에 지금 값(표시 이름이 SEC 이름이면 빈 칸), 저장하면 PATCH 뒤 목록 다시 읽기, 취소는 보내지 않음", async () => {
    api.apiPatch.mockResolvedValue({ ok: true, message: "표시 이름·설명을 고쳤습니다." });
    const dialog = await openEditor();
    const current = within(dialog).getByRole("region", { name: "지금 즐겨찾기" });
    fireEvent.click(within(current).getByRole("button", { name: "고치기 가짜 운용 (Fake Capital)" }));
    const form = within(current).getByRole("form", { name: "가짜 운용 (Fake Capital) 표시 이름·설명 고치기" });
    const nameField = within(form).getByLabelText(/표시 이름/) as HTMLInputElement;
    const descField = within(form).getByLabelText(/설명/) as HTMLInputElement;
    expect(nameField.value).toBe("가짜 운용 (Fake Capital)");
    expect(descField.value).toBe("더한 기관");

    fireEvent.click(within(form).getByRole("button", { name: "취소" }));
    expect(api.apiPatch).not.toHaveBeenCalled();
    expect(within(current).queryByRole("form")).toBeNull();

    fireEvent.click(within(current).getByRole("button", { name: "고치기 가짜 운용 (Fake Capital)" }));
    const again = within(current).getByRole("form");
    fireEvent.change(within(again).getByLabelText(/표시 이름/), { target: { value: " 새 이름 " } });
    fireEvent.change(within(again).getByLabelText(/설명/), { target: { value: "" } });
    const before = paths().filter((path) => path === endpoints.institution.institutions).length;
    fireEvent.click(within(again).getByRole("button", { name: "저장" }));
    await within(dialog).findByText("표시 이름·설명을 고쳤습니다.");
    expect(api.apiPatch).toHaveBeenCalledWith(endpoints.institution.favorite(FAV), { displayName: "새 이름", description: "" });
    await waitFor(() => expect(paths().filter((path) => path === endpoints.institution.institutions).length).toBe(before + 1));
  });
});

// QA-1031: 13F 즐겨찾기 편집의 상태 잔류 넷 — (가) 지운 기관이 고른 채 남음(그 기관의 포트폴리오 400은 '추적하지 않는 기관' 안내 없이 오류 상자),
// (나) 지우기 실패의 사유가 열린 확인 창에 가려짐, (다) 찾기를 다시 할 때 앞 오류 문구·앞 후보·'즐겨찾기에 있음' 표지가 남음, (라) 저장 중 '취소'가 눌림.
// '가(대조)'를 뺀 여섯 시험은 재현 커밋에서 it.fails였습니다.
describe("QA-1031 13F 즐겨찾기 편집의 상태 잔류", () => {
  const LIST_PATH = endpoints.institution.institutions;
  const berkshireReads = () => paths().filter((path) => path === endpoints.institution.portfolio(BERKSHIRE, "8", "30")).length;
  const confirmDialog = () => screen.findByRole("dialog", { name: "즐겨찾기에서 지울까요?" });

  async function openEditorHere() {
    fireEvent.click(await screen.findByRole("button", { name: "편집 13F 즐겨찾기" }));
    return screen.findByRole("dialog", { name: "13F 즐겨찾기 편집" });
  }

  it("가: 고른 즐겨찾기를 지우면 기본 기관으로 돌아가 그 포트폴리오를 읽는다", async () => {
    api.apiDelete.mockImplementation(async () => {
      reads[LIST_PATH] = { ...LIST, favorites: [] };
      return { ok: true, message: "즐겨찾기에서 지웠습니다." };
    });
    renderAs(OWNER);
    const favorites = await screen.findByRole("radiogroup", { name: "즐겨찾기 기관" });
    fireEvent.click(within(favorites).getByRole("radio", { name: "가짜 운용 (Fake Capital)" }));
    await screen.findByRole("heading", { level: 2, name: "가짜 운용 (Fake Capital)" });
    const before = berkshireReads();

    const dialog = await openEditorHere();
    fireEvent.click(within(dialog).getByRole("button", { name: "지우기 가짜 운용 (Fake Capital)" }));
    fireEvent.click(within(await confirmDialog()).getByRole("button", { name: "지우기" }));
    await within(dialog).findByText("즐겨찾기에서 지웠습니다.");

    await waitFor(() => expect(berkshireReads()).toBe(before + 1));
    // 대화상자가 열려 있어 뒤 화면은 낭독기에서 숨습니다(hidden).
    expect(await screen.findByRole("heading", { level: 2, name: "가상 버크셔 (Fictional Berkshire)", hidden: true })).toBeTruthy();
  });

  it("가(대조): 고르지 않은 즐겨찾기를 지우면 보던 기관 그대로(포트폴리오를 다시 읽지 않음)", async () => {
    api.apiDelete.mockImplementation(async () => {
      reads[LIST_PATH] = { ...LIST, favorites: [] };
      return { ok: true, message: "즐겨찾기에서 지웠습니다." };
    });
    renderAs(OWNER);
    await screen.findByRole("heading", { level: 2, name: "가상 버크셔 (Fictional Berkshire)" });
    const before = berkshireReads();
    const dialog = await openEditorHere();
    fireEvent.click(within(dialog).getByRole("button", { name: "지우기 가짜 운용 (Fake Capital)" }));
    fireEvent.click(within(await confirmDialog()).getByRole("button", { name: "지우기" }));
    await within(dialog).findByText("즐겨찾기에서 지웠습니다.");
    await within(dialog).findByText("아직 없습니다.");
    expect(berkshireReads()).toBe(before);
    expect(paths()).not.toContain(endpoints.institution.portfolio(FAV, "8", "30"));
  });

  it("가: 고른 기관의 포트폴리오가 400(추적하지 않는 기관)이면 오류 상자·다시 시도가 아니라 그 안내", async () => {
    api.apiGetShared.mockImplementation((path: string) =>
      path === endpoints.institution.portfolio(FAV, "8", "30")
        ? Promise.reject(new api.ApiError("추적하지 않는 기관 CIK입니다 — /api/sec13f/institutions 목록의 cik를 쓰세요.", 400))
        : path in reads ? Promise.resolve(reads[path]) : new Promise(() => {}));
    renderAs(MEMBER);
    const favorites = await screen.findByRole("radiogroup", { name: "즐겨찾기 기관" });
    fireEvent.click(within(favorites).getByRole("radio", { name: "가짜 운용 (Fake Capital)" }));

    expect(await screen.findByText(`이 대시보드가 추적하는 13F 기관이 아닙니다(CIK ${FAV}).`)).toBeTruthy();
    expect(screen.queryByText(/\/api\/sec13f\/institutions/)).toBeNull();
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
  });

  it("나: 지우기가 실패하면 확인 창을 닫아 대화상자 본문의 사유가 보인다", async () => {
    api.apiDelete.mockRejectedValue(new api.ApiError("즐겨찾기를 지우지 못했습니다(가짜 500).", 500));
    renderAs(OWNER);
    const dialog = await openEditorHere();
    fireEvent.click(within(dialog).getByRole("button", { name: "지우기 가짜 운용 (Fake Capital)" }));
    fireEvent.click(within(await confirmDialog()).getByRole("button", { name: "지우기" }));

    await waitFor(() => expect(api.apiDelete).toHaveBeenCalledWith(endpoints.institution.favorite(FAV)));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "즐겨찾기에서 지울까요?" })).toBeNull());
    // 확인 창이 닫혀 편집 대화상자가 다시 낭독기에 보이고, 사유는 그 안에 있습니다.
    const editor = screen.getByRole("dialog", { name: "13F 즐겨찾기 편집" });
    expect(within(editor).getByText("즐겨찾기를 지우지 못했습니다(가짜 500).")).toBeTruthy();
    // 줄은 그대로 남아 다시 지울 수 있습니다.
    expect(within(editor).getByRole("button", { name: "지우기 가짜 운용 (Fake Capital)" })).toBeTruthy();
  });

  it("다: 찾기를 다시 하면 앞 오류 문구와 앞 후보를 함께 비운다", async () => {
    renderAs(OWNER);
    const dialog = await openEditorHere();
    const input = within(dialog).getByLabelText("기관 이름(영문) 또는 CIK");
    const find = () => fireEvent.click(within(dialog).getByRole("button", { name: "찾기" }));

    fireEvent.change(input, { target: { value: "가" } });
    find();
    expect(await within(dialog).findByText(/기관 이름은 2~60자/)).toBeTruthy();

    // 잘못된 이름 → CIK: 앞 오류 문구가 사라집니다.
    fireEvent.change(input, { target: { value: "9900003" } });
    find();
    expect(await within(dialog).findByRole("list", { name: "찾은 기관" })).toBeTruthy();
    expect(within(dialog).queryByText(/기관 이름은 2~60자/)).toBeNull();

    // CIK → 잘못된 이름: 앞 후보가 사라집니다.
    fireEvent.change(input, { target: { value: "가" } });
    find();
    expect(await within(dialog).findByText(/기관 이름은 2~60자/)).toBeTruthy();
    expect(within(dialog).queryByRole("list", { name: "찾은 기관" })).toBeNull();
    expect(api.apiGet).not.toHaveBeenCalled();
  });

  it("다: 즐겨찾기를 지운 뒤 같은 후보에 '즐겨찾기에 있음' 대신 '고르기'가 나온다", async () => {
    api.apiGet.mockResolvedValue({
      ok: true, query: "fake",
      candidates: [{ cik: FAV, name: "FAKE CAPITAL LLC", status: "favorite", latest13F: { filingDate: "2026-08-14", reportDate: "2026-06-30" }, checked: true }],
    });
    api.apiDelete.mockImplementation(async () => {
      reads[LIST_PATH] = { ...LIST, favorites: [] };
      return { ok: true, message: "즐겨찾기에서 지웠습니다." };
    });
    renderAs(OWNER);
    const dialog = await openEditorHere();
    fireEvent.change(within(dialog).getByLabelText("기관 이름(영문) 또는 CIK"), { target: { value: "fake" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "찾기" }));
    const found = await within(dialog).findByRole("list", { name: "찾은 기관" });
    expect(within(found).getByText("즐겨찾기에 있음")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "지우기 가짜 운용 (Fake Capital)" }));
    fireEvent.click(within(await confirmDialog()).getByRole("button", { name: "지우기" }));
    await within(dialog).findByText("아직 없습니다.");

    const again = within(dialog).getByRole("list", { name: "찾은 기관" });
    expect(within(again).queryByText("즐겨찾기에 있음")).toBeNull();
    expect(within(again).getByRole("button", { name: "고르기 FAKE CAPITAL LLC" })).toBeTruthy();
  });

  it("라: 표시 이름·설명을 저장하는 동안 '취소'는 눌리지 않는다", async () => {
    api.apiPatch.mockImplementation(() => new Promise(() => {}));
    renderAs(OWNER);
    const dialog = await openEditorHere();
    const current = within(dialog).getByRole("region", { name: "지금 즐겨찾기" });
    fireEvent.click(within(current).getByRole("button", { name: "고치기 가짜 운용 (Fake Capital)" }));
    const form = within(current).getByRole("form");
    fireEvent.click(within(form).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(api.apiPatch).toHaveBeenCalledTimes(1));

    const cancel = within(form).getByRole("button", { name: "취소" });
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(cancel);
    expect(within(current).queryByRole("form")).not.toBeNull();
  });
});

