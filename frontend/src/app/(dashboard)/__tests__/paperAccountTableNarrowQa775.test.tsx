/**
 * QA-775 — 모의매매 개요 계좌 표(작업대 P6)의 좁은 화면(md 미만 — 두 칸) '순자산' 칸 둘째 줄의 수익률 칩에 이름이 없고, 수익률을 모르면 칩이 아무것도
 * 그리지 않던 결함. 칸 머리는 '순자산'뿐이라 값 아래 칩이 출발 이후 수익률인지 알 수 없고(다른 화면의 같은 꼴은 대개 하루 변화), 모르는 값은 넓은 화면
 * '수익률(출발 이후)' 칸처럼 '—'여야 합니다(원칙: null → '—'). 값은 모두 합성 값입니다.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
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

import PaperScreen from "@/components/screens/paper/PaperScreen";
import { endpoints } from "@/lib/endpoints";

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };
const book = (code: string, kind: string, label: string, over: Record<string, unknown> = {}) => ({
  code, kind, label, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000, cash: 200, nav: 100500, equityValue: 100300,
  exposurePct: 99.8, returnPct: 0.5, lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: STATS, benchmark: null, ...over,
});
const OVERVIEW = {
  available: true, initialized: true, startDate: "2026-10-23", limits: [], jobs: [], pendingBackfill: [], quotes: null,
  navSeries: { dates: ["2026-10-23", "2026-10-24"], books: { rules: [100000, 100500] } },
  books: [
    book("rules", "RULES", "규칙 계좌"),
    book("claude", "CLAUDE", "Claude 계좌", { status: "NOT_STARTED", startedOn: null, nav: null, returnPct: null, exposurePct: null, positions: 0 }),
  ],
};

beforeEach(() => {
  // 좁은 표(md 미만) — 계좌 표가 두 칸(계좌·순자산)입니다.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(width < 48rem)", media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path === endpoints.paper.market("US").overview ? Promise.resolve(OVERVIEW) : new Promise(() => {}),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 계좌 표에서 그 계좌 줄의 '순자산' 칸. */
function navCell(label: string): HTMLElement {
  const table = screen.getByRole("table", { name: "계좌 목록" });
  const row = within(table).getAllByRole("row").find((tr) => (tr.textContent ?? "").includes(label)) as HTMLElement;
  // 첫 칸(계좌)은 행 머리(th)일 수 있어 칸 차례로 봅니다.
  return row.children[1] as HTMLElement;
}

describe("QA-775 — 좁은 계좌 표의 수익률 칩은 '출발 이후' 이름과 함께, 모르면 '—'", () => {
  it.fails("값이 있으면 '출발 이후' 글과 칩, 모르면 '출발 이후' 글과 '—'(값 없음)", async () => {
    render(<PaperScreen initialTab="overview" market="US" />);
    await act(async () => {});
    expect(screen.getByRole("table", { name: "계좌 목록" }).querySelectorAll("thead th")).toHaveLength(2);

    const known = navCell("규칙 계좌");
    expect(known.textContent).toContain("출발 이후");
    expect(known.textContent).toContain("+0.50%");

    const unknown = navCell("Claude 계좌");
    expect(unknown.textContent).toContain("출발 이후");
    // 순자산 '—'와 수익률 '—' 둘 — 0으로 채우지 않음.
    expect(within(unknown).getAllByText("값 없음")).toHaveLength(2);
  });
});
