/**
 * QA-972(작업대 P8 후속 검토): 한국 '출발·게이트 기록' 패널은 결정 기록이 처음 온 뒤부터 그립니다(QA-955). 그런데 화면의 읽기(hooks/useApi)에는 시간 한도가
 * 없어, 결정 기록 요청이 답하지 않고 연결도 끊기지 않으면 이미 받은 작업 기록과 그 오류·다시 시도 칸이 끝내 그려지지 않았습니다.
 *
 * 기대: 정보 수집 화면의 같은 문제(QA-897·929)와 같은 2초 상한(lib/info FIRST_ANSWER_CAP_MS) 뒤에는 결정 기록 없이도 그 패널을 그립니다. 상한 안에는
 * 예전처럼 그리지 않습니다(목록이 오기 전 — QA-955). 값은 모두 합성 값입니다.
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
import { FIRST_ANSWER_CAP_MS } from "@/lib/info";

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };
const book = (code: string, kind: string, label: string) => ({
  code, kind, label, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000, cash: 500, nav: 101200, equityValue: 100700,
  exposurePct: 99.5, returnPct: -1.2, lastObservedAtKst: "2026-10-24 05:15", positions: 3, staleCount: 0, stats: STATS, benchmark: null,
});
const KR_OVERVIEW = {
  available: true, initialized: true, market: "KR", startDate: "2026-10-23", limits: [], jobs: [], pendingBackfill: [], quotes: null,
  navSeries: { dates: [], books: {} }, dormantReason: null,
  books: [book("kr_rules", "RULES", "한국 규칙 계좌"), book("kr_claude", "CLAUDE", "한국 Claude 계좌1")],
};

beforeEach(() => {
  vi.useFakeTimers();
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.startsWith("/api/paper/overview")) return Promise.resolve(KR_OVERVIEW);
    // 작업 기록(상태)은 실패로 답함 — 그 오류·다시 시도 칸이 보여야 합니다.
    if (path.startsWith("/api/paper/status")) return Promise.reject(new Error("작업 기록 응답 500"));
    // 결정 기록 등은 끝나지 않는 요청.
    return new Promise(() => {});
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const settled = () => act(async () => {});

describe("결정 기록이 답하지 않아도 상한 뒤 '출발·게이트 기록' 패널(QA-972)", () => {
  // 수정 전(재현 커밋에서는 it.fails): 결정 기록이 끝나지 않으면 패널이 끝내 그려지지 않았습니다.
  it.fails("상한 안에는 그리지 않고, 상한 뒤에는 결정 기록 없이 패널과 작업 기록의 오류·다시 시도", async () => {
    render(<PaperScreen market="KR" initialTab="decisions" />);
    await settled();
    expect(screen.getByText("결정 기록을 읽는 중…")).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(FIRST_ANSWER_CAP_MS - 100); });
    expect(screen.queryByRole("heading", { name: "출발·게이트 기록" })).toBeNull();

    await act(async () => { vi.advanceTimersByTime(200); });
    expect(screen.getByText("결정 기록을 읽는 중…")).toBeTruthy();   // 결정 기록은 아직
    expect(screen.getByRole("heading", { name: "출발·게이트 기록" })).toBeTruthy();
    expect(screen.getByText("작업 기록 응답 500")).toBeTruthy();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
  });
});
