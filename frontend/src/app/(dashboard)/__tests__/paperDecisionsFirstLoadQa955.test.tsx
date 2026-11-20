/**
 * 결정 로그 탭 첫 적재 자리 — QA-955(작업대 P8 후속, 결정 거리 `paper-first-load-placeholder` — P6 회귀).
 *
 * 결정 기록 목록의 읽는 중 자리가 한 줄('결정 기록을 읽는 중…')이라, 한국 화면에서 첫 화면 안에 들어온 아래 '출발·게이트 기록' 패널이 목록(최근 50건 —
 * 합성 20건이면 넓은 화면 약 2,150px) 응답 뒤 화면 밖으로 밀려났습니다. 빌드한 화면(합성 한국 자료) 첫 적재 CLS 1440 0.1418·1024 0.1217(D5 전 기록
 * 1440 0.0836·1024 0.0539 — P6 전 0.0193·0.0114).
 *
 * 기대(값이 온 뒤의 꼴로 자리 — QA-892 순위·QA-930 결과와 같은 원칙): 결정 기록은 최근 50건까지의 긴 목록이라, 처음 읽는 동안에는 화면 높이 이상의 자리
 * (min-h-dvh)를 둡니다. 읽기가 실패한 뒤 다시 읽는 동안은 예전 한 줄(QA-655). 응답 뒤의 겉모습·요청은 그대로입니다. jsdom은 배치를 재지 않아 자리 클래스를 봅니다.
 * 건수는 응답 전에 알 수 없어, 목록이 짧으면(출발 직후 등) 큰 자리가 줄며 아래 패널이 올라옵니다 — 그래서 한국 '출발·게이트 기록' 패널은 결정 기록이 처음
 * 한 번 온 뒤(값·오류)부터 그립니다(작업 기록 요청은 처음부터 그대로 — 고친 커밋에서 더한 사례).
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), apiBase: () => "", UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  LineChart: () => null,
  MultiLineSeries: () => null,
  DonutChart: () => null,
}));
vi.mock("next/navigation", () => ({ usePathname: () => null }));

import PaperScreen from "@/components/screens/paper/PaperScreen";
import type { PaperMarketCode } from "@/lib/paperMarket";

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };
const book = (code: string, kind: string, label: string) => ({
  code, kind, label, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000, cash: 500, nav: 101200, equityValue: 100700,
  exposurePct: 99.5, returnPct: -1.2, lastObservedAtKst: "2026-10-24 05:15", positions: 3, staleCount: 0, stats: STATS, benchmark: null,
});
const overviewOf = (market: PaperMarketCode) => ({
  available: true, initialized: true, market, startDate: "2026-10-23", limits: [], jobs: [], pendingBackfill: [], quotes: null,
  navSeries: { dates: [], books: {} }, dormantReason: null,
  books: market === "KR"
    ? [book("kr_rules", "RULES", "한국 규칙 계좌"), book("kr_claude", "CLAUDE", "한국 Claude 계좌1")]
    : [book("rules", "RULES", "규칙 계좌"), book("claude", "CLAUDE", "Claude 계좌1")],
});

let failList = false;

beforeEach(() => {
  failList = false;
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.startsWith("/api/paper/overview")) return Promise.resolve(overviewOf(path.includes("market=KR") ? "KR" : "US"));
    if (path.startsWith("/api/paper/decisions?") && failList) return Promise.reject(new Error("결정 기록 응답 500"));
    // 결정 기록·상태 등은 끝나지 않는 요청 — 첫 적재 자리를 봅니다.
    return new Promise(() => {});
  });
});
afterEach(() => cleanup());

const settled = () => act(async () => {});
const tokens = (element: Element | null) => (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

describe("결정 기록 목록 첫 적재 자리(QA-955)", () => {
  for (const market of ["KR", "US"] as const) {
    it(`${market}: 처음 읽는 동안 화면 높이 이상의 자리`, async () => {
      render(<PaperScreen market={market} initialTab="decisions" />);
      await settled();
      const loading = screen.getByText("결정 기록을 읽는 중…").parentElement;
      expect(tokens(loading)).toContain("min-h-dvh");
    });
  }

  it("한국 '출발·게이트 기록' 패널은 결정 기록이 처음 온 뒤부터 — 목록이 짧아 자리가 줄 때 위로 올라오지 않게", async () => {
    let resolveList: (value: unknown) => void = () => {};
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/paper/overview")) return Promise.resolve(overviewOf("KR"));
      if (path.startsWith("/api/paper/decisions?")) return new Promise((resolve) => { resolveList = resolve; });
      return new Promise(() => {});
    });
    render(<PaperScreen market="KR" initialTab="decisions" />);
    await settled();
    expect(screen.getByText("결정 기록을 읽는 중…")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "출발·게이트 기록" })).toBeNull();
    await act(async () => resolveList({ available: true, decisions: [] }));
    expect(screen.getByRole("heading", { name: "출발·게이트 기록" })).toBeTruthy();
    // 작업 기록(상태)은 결정 기록을 기다리지 않고 처음부터 읽습니다(요청 시각 그대로).
    expect(api.apiGetShared.mock.calls.map(([path]) => path)).toContain("/api/paper/status?market=KR");
  });

  it("읽기가 실패한 뒤에는 오류 상자(큰 자리를 그리지 않음)", async () => {
    failList = true;
    render(<PaperScreen market="KR" initialTab="decisions" />);
    await settled();
    expect(await screen.findByText("결정 기록 응답 500")).toBeTruthy();
    expect(document.querySelector(".min-h-dvh")).toBeNull();
  });
});
