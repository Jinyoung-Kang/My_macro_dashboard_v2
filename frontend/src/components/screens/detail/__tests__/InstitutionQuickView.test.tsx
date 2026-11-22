/**
 * 기관 팝업(InstitutionQuickView — 모의매매 '신호 기관'의 기관 이름을 누르면, 사용자 요청 2026-11-22). 응답은 모두 합성 값입니다.
 *  - 누르기 전에는 읽지 않고, 열면 13F 포트폴리오 한 번(기관 상세와 같은 요청)
 *  - 속성(CIK·보고 기준일·평가액 등)과 비중 상위 보유 종목 표, '기관 상세 화면 열기'(/institutions/<CIK>)
 *  - 13F 메뉴 밖 기관(응답 이름 = CIK)은 받은 이름을 제목으로, 저장본이 없으면(400) 그 사실 글(다시 시도 없음)
 *  - 보유 종목 이름(2026-11-23 요청): 확인된 티커는 종목 상세(/s/us/<티커>), 티커 없음·대용 티커는 정보 검색(/search?q=<공시 이름>)(정보 검색을 볼 수
 *    없는 사용자면 글자 그대로 — 지금은 모든 사용자가 봄). 링크 이름은 보이는 공시 이름이 앞에(WCAG 2.5.3). 요청 수는 그대로(포트폴리오 한 번).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { InstitutionQuickView } from "../InstitutionQuickView";

const CIK = "0009900001";
const PATH = endpoints.institution.portfolio(CIK, 8, 30);
const PORTFOLIO = {
  available: true,
  cik: CIK,
  institution: { cik: CIK, name: CIK, desc: "" },
  collectedAtKst: "2026-11-22 09:00",
  ageSeconds: 60,
  quarters: [
    { reportDate: "2026-06-30", filingDate: "2026-08-14", totalValue: 1500, holdingCount: 2 },
    { reportDate: "2026-03-31", filingDate: "2026-05-15", totalValue: 1000, holdingCount: 1 },
  ],
  latest: { reportDate: "2026-06-30", filingDate: "2026-08-14", totalValue: 1500 },
  holdings: [
    { name: "FAKE ALPHA", cusip: "999999991", class: "COM", value: 1000, shares: 10, weight: 66.7, weightDiff: -33.3, sharesDiff: 0, action: "비중 축소 (Reduced)" },
    { name: "FAKE BETA", cusip: "999999992", class: "COM", value: 500, shares: 5, weight: 33.3, weightDiff: 33.3, sharesDiff: 5, action: "신규 매수 (New)" },
  ],
};

let reads: Record<string, unknown> = {};
beforeEach(() => {
  reads = {};
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (!(path in reads)) return new Promise(() => {});
    const body = reads[path];
    return body instanceof Error ? Promise.reject(body) : Promise.resolve(body);
  });
});
afterEach(cleanup);

const renderView = () =>
  render(
    <InstitutionQuickView
      cik={CIK}
      name="가짜 신호 기관"
      trigger={<button type="button">가짜 신호 기관</button>}
    />,
  );

describe("기관 팝업", () => {
  it("누르기 전에는 읽지 않고, 열면 포트폴리오를 한 번 읽어 속성·상위 보유·상세 화면 링크를 보인다", async () => {
    reads[PATH] = PORTFOLIO;
    renderView();
    expect(api.apiGetShared).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "가짜 신호 기관" }));
    const dialog = await screen.findByRole("dialog", { name: "가짜 신호 기관" });
    await waitFor(() => expect(within(dialog).getByText("FAKE ALPHA")).toBeTruthy());
    expect(api.apiGetShared.mock.calls.map(([path]) => path)).toEqual([PATH]);
    expect(within(dialog).getByText("FAKE BETA")).toBeTruthy();
    expect(within(dialog).getByText(/보고 기준일 2026-06-30 · 공시일 2026-08-14/)).toBeTruthy();
    expect(within(dialog).getByText(`CIK ${CIK}`)).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "기관 상세 화면 열기" }).getAttribute("href")).toBe(`/institutions/${CIK}`);
  });

  it("저장본이 없는 기관(400)은 그 사실 글만 — 다시 시도 단추 없음", async () => {
    const { ApiError } = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
    reads[PATH] = new ApiError("추적하지 않는 기관 CIK입니다", 400);
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "가짜 신호 기관" }));
    const dialog = await screen.findByRole("dialog", { name: "가짜 신호 기관" });
    await waitFor(() => expect(within(dialog).getByText(`이 기관의 13F 저장본이 없습니다(CIK ${CIK}).`)).toBeTruthy());
    expect(within(dialog).queryByRole("button", { name: /다시/ })).toBeNull();
  });

  it("보유 종목 이름 — 확인된 티커는 종목 상세, 티커 없음·대용 티커는 정보 검색(공시 이름), 요청은 포트폴리오 한 번", async () => {
    reads[PATH] = {
      ...PORTFOLIO,
      holdings: [
        { ...PORTFOLIO.holdings[0], name: "FAKE ALPHA", ticker: "FKA", tickerIsProxy: false },
        { ...PORTFOLIO.holdings[1], name: "FAKE BETA CL A", ticker: "FKB-B", tickerIsProxy: true },
        { name: "FAKE GAMMA", cusip: "999999993", class: "COM", value: 1, shares: 1, weight: 0.1, weightDiff: null, sharesDiff: null, action: "유지" },
      ],
    };
    const member: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
    render(
      <SessionUserProvider user={member}>
        <InstitutionQuickView cik={CIK} name="가짜 신호 기관" trigger={<button type="button">가짜 신호 기관</button>} />
      </SessionUserProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "가짜 신호 기관" }));
    const dialog = await screen.findByRole("dialog", { name: "가짜 신호 기관" });
    const alpha = await within(dialog).findByRole("link", { name: "FAKE ALPHA 종목 상세 화면" });
    expect(alpha.getAttribute("href")).toBe("/s/us/FKA");
    expect(within(dialog).getByRole("link", { name: "FAKE BETA CL A 정보 검색" }).getAttribute("href")).toBe(`/search?q=${encodeURIComponent("FAKE BETA CL A")}`);
    expect(within(dialog).getByRole("link", { name: "FAKE GAMMA 정보 검색" }).getAttribute("href")).toBe(`/search?q=${encodeURIComponent("FAKE GAMMA")}`);
    expect(api.apiGetShared.mock.calls.map(([path]) => path)).toEqual([PATH]);
  });
});
