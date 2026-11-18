/**
 * 모의매매 개요 계좌 표의 검사 칸(작업대 P6) — 요청 수가 늘지 않는가(계획 §2-6 '기본 계좌는 요약만', 요청 지킴 시험 paperRequests의 +0 사례).
 *
 *  - 넓은 화면(옆 검사 칸): 처음 화면은 규칙 계좌의 요약(곡선·속성)만 — 그 계좌의 보유·체결·설정을 읽지 않는다
 *  - 줄 단추를 누르면 그 계좌의 보유·최근 체결 5건·설정을 한 번씩(예전 계좌 행 누르기와 같은 GET 셋), 같은 줄을 다시 눌러도 더 읽지 않는다
 *  - 머리의 계좌 고르기·옆 칸 Esc(상세만 닫음)는 읽지 않는다, 상세를 닫은 뒤 다시 열면 다시 한 번(예전 행 다시 열기와 같음)
 *  - 좁은 틀(대화상자)도 같은 GET 셋 — 대화상자를 닫으면 상세가 빠지고 더 읽지 않는다
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };
const book = (code: string, kind: string, label: string) => ({
  code, kind, label, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000, cash: 200, nav: 100000, equityValue: 99800,
  exposurePct: 99.8, returnPct: 0, lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: STATS, benchmark: null,
});
const OVERVIEW = {
  available: true, initialized: true, startDate: "2026-10-23", limits: [], jobs: [], pendingBackfill: [], quotes: null,
  navSeries: { dates: ["2026-10-23", "2026-10-24"], books: { rules: [100000, 100000] } },
  books: [book("rules", "RULES", "규칙 계좌"), book("claude", "CLAUDE", "Claude 계좌"), book("bench_spy", "BENCHMARK", "SPY 계좌")],
};

/** 계좌 상세가 읽는 셋(보유·최근 체결 5건·설정). */
const detailPaths = (code: string) => [endpoints.paper.positions(code), endpoints.paper.fills(code, 5), endpoints.paper.settings];
const calls = () => (api.apiGetShared.mock.calls as unknown as [string][]).map(([path]) => path);
const countOf = (path: string) => calls().filter((entry) => entry === path).length;
const settled = () => act(async () => {});

function stubWide() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === WIDE_SHELL_MEDIA, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path === endpoints.paper.market("US").overview) return Promise.resolve(OVERVIEW);
    if (path.includes("/positions")) return Promise.resolve({ available: true, book: OVERVIEW.books[0], cash: 200, lockouts: [], positions: [] });
    if (path.includes("/fills")) return Promise.resolve({ available: true, fills: [] });
    if (path === endpoints.paper.settings) return Promise.resolve({ available: true, version: 1, body: {}, keys: [] });
    return new Promise(() => {});
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("개요 계좌 표 검사 칸 — 요청 +0", () => {
  it("넓은 화면: 처음은 요약만(상세 GET 0), 줄 단추로 그 계좌 셋을 한 번씩, 다시 눌러도·머리 고르기·Esc는 더 읽지 않는다", async () => {
    stubWide();
    render(<PaperScreen initialTab="overview" market="US" />);
    await settled();
    expect(screen.getByRole("region", { name: "계좌 자세히 — 규칙 계좌" })).toBeTruthy();
    for (const path of detailPaths("rules")) expect(countOf(path), path).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "규칙 계좌 상세 보기" }));
    await screen.findByRole("region", { name: "규칙 계좌 상세" });
    await settled();
    for (const path of detailPaths("rules")) expect(countOf(path), path).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "규칙 계좌 상세 보기" }));
    await settled();
    for (const path of detailPaths("rules")) expect(countOf(path), path).toBe(1);

    // 머리의 계좌 고르기 — 보는 계좌만 바꾸고 상세를 닫음(읽지 않음)
    const before = calls().length;
    fireEvent.change(screen.getByRole("combobox", { name: "계좌 고르기" }), { target: { value: "claude" } });
    await settled();
    expect(screen.getByRole("region", { name: "계좌 자세히 — Claude 계좌" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Claude 계좌 상세" })).toBeNull();
    expect(calls().slice(before)).toEqual([]);

    // 줄 단추로 SPY 계좌 상세를 열었다가 Esc(상세만 닫음) — 다시 읽지 않음
    fireEvent.click(screen.getByRole("button", { name: "SPY 계좌 상세 보기" }));
    const panel = await screen.findByRole("region", { name: "SPY 계좌 상세" });
    await settled();
    const opened = calls().length;
    fireEvent.keyDown(panel, { key: "Escape" });
    await settled();
    expect(screen.queryByRole("region", { name: "SPY 계좌 상세" })).toBeNull();
    expect(calls().slice(opened)).toEqual([]);
    for (const path of detailPaths("bench_spy").slice(0, 2)) expect(countOf(path), path).toBe(1);
  });

  it("좁은 틀(대화상자): 줄 단추로 같은 셋을 한 번씩, 대화상자를 닫으면 더 읽지 않는다", async () => {
    render(<PaperScreen initialTab="overview" market="US" />);
    await settled();
    // 계좌 상세의 셋(보유·체결·설정)은 아직 없음 — 실행 감사(Claude 계좌가 있으면 체결 시점 실험 카드)는 예전 그대로 따로 읽습니다.
    expect(calls().filter((path) => /\/(positions|fills)|\/api\/paper\/settings$/.test(path))).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "SPY 계좌 상세 보기" }));
    await screen.findByRole("region", { name: "SPY 계좌 상세" });
    await settled();
    for (const path of detailPaths("bench_spy")) expect(countOf(path), path).toBe(1);
    const opened = calls().length;
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await settled();
    expect(calls().slice(opened)).toEqual([]);
  });
});
