/**
 * QA-971(작업대 P8 후속 검토): 결정 기록 목록의 화면 높이 자리(min-h-dvh — QA-955)가 처음 마운트의 첫 적재뿐 아니라 머리에서 계좌를 바꿀 때마다(경로가
 * 바뀌어 useApi가 값을 비움) 다시 생겼다가, 짧은 목록이 오면 다시 줄었습니다 — 한국 '출발·게이트 기록' 패널이 계좌를 바꿀 때마다 아래로 내려갔다 올라왔습니다.
 *
 * 기대: 화면 높이 자리는 이 화면에서 결정 기록을 아직 한 번도 받지 못한 첫 적재에만. 한 번이라도 받았으면(값·오류) 그 뒤 계좌를 바꿔 읽는 동안은 예전
 * 한 줄('결정 기록을 읽는 중…')이고 아래 패널은 그대로 남습니다. jsdom은 배치를 재지 않아 자리 클래스를 봅니다. 값은 모두 합성 값입니다.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.startsWith("/api/paper/overview")) return Promise.resolve(KR_OVERVIEW);
    if (path.startsWith("/api/paper/status")) return Promise.resolve({ available: true, jobs: [] });
    // 규칙 계좌의 결정 기록은 짧은 목록으로 바로 답하고, 다른 계좌(바꾼 뒤)의 결정 기록은 끝나지 않음.
    if (path.startsWith("/api/paper/decisions?") && path.includes("book=kr_rules")) return Promise.resolve({ available: true, decisions: [] });
    return new Promise(() => {});
  });
});
afterEach(() => cleanup());

const settled = () => act(async () => {});
const tokens = (element: Element | null) => (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

describe("결정 기록 화면 높이 자리는 처음 마운트의 첫 적재에만(QA-971)", () => {
  // 수정 전(재현 커밋에서는 it.fails): 계좌를 바꾸면 다시 화면 높이 자리(min-h-dvh)가 생겼습니다.
  it("목록을 한 번 받은 뒤 계좌를 바꿔 읽는 동안은 한 줄 — 아래 '출발·게이트 기록' 패널은 그대로", async () => {
    render(<PaperScreen market="KR" initialTab="decisions" />);
    await settled();
    expect(screen.queryByText("결정 기록을 읽는 중…")).toBeNull();   // 규칙 계좌 목록이 옴
    expect(screen.getByRole("heading", { name: "출발·게이트 기록" })).toBeTruthy();

    await act(async () => fireEvent.change(screen.getByLabelText("계좌 고르기"), { target: { value: "kr_claude" } }));
    const loading = screen.getByText("결정 기록을 읽는 중…").parentElement;
    expect(tokens(loading)).not.toContain("min-h-dvh");
    expect(document.querySelector(".min-h-dvh")).toBeNull();
    expect(screen.getByRole("heading", { name: "출발·게이트 기록" })).toBeTruthy();
  });
});
