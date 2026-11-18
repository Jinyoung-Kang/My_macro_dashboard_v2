/**
 * 모의매매 검사 칸 안 절 머리 단계(작업대 P6 검토 — patterns InspectorSubheading): 결정 상세는 옆 검사 칸(제목 h3)에서는 절이 h4, 위쪽 대화상자(제목 h2)에서는
 * 절이 h3입니다 — 예전에는 절이 늘 h3이라 옆 칸에서는 칸 제목과 같은 단계였습니다. 값은 모두 합성 값입니다(QA-747 시험과 같은 자료).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 객체를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  LineChart: () => null,
  MultiLineSeries: () => null,
  DonutChart: () => null,
}));

import PaperPage from "@/components/screens/paper/PaperScreen";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";

function book(code: string, over: Record<string, unknown> = {}) {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000,
    cash: 50, nav: 100000, equityValue: 99950, exposurePct: 99.95, returnPct: 0,
    lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: null, benchmark: null, ...over,
  };
}

function overview(books: unknown[], over: Record<string, unknown> = {}) {
  return {
    available: true, initialized: true, startDate: "2026-10-23", limits: [], jobs: [], pendingBackfill: [], books,
    navSeries: { dates: [], books: {} }, quotes: null, selection: null, gate: null, ...over,
  };
}

function decision(id: number, bookCode: string, over: Record<string, unknown> = {}) {
  return {
    id, book: bookCode, asOfTradingDate: "2026-10-23", kind: "INITIAL", status: "OK", decidedAtKst: "2026-10-24 09:12",
    model: null, frameworkVersion: null, settingsVersion: 1, selectionAsOf: "2026-10-23", targetExposurePct: null,
    summary: "매수 AAPL · 남는 현금 SHY", orderCount: 1, rejectedCount: 0, pricesFinal: true, error: null, ...over,
  };
}

function detail(row: ReturnType<typeof decision>) {
  return {
    available: true,
    decision: { ...row, packet: null, packetHash: null, usage: null, noteIds: null, latencyMs: 35, retryCount: 0, response: { notes: ["처리 메모 한 줄"] } },
    orders: [],
  };
}

/** 경로(정확히 일치) → 응답. 없는 경로는 끝나지 않는 요청. */
let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = {};
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 넓은 화면(lg 이상 — 왼쪽 메뉴가 보이는 폭)의 matchMedia 대역. jsdom은 틀 폭이 0이라 목록-검사가 크기 질의 배치(옆 칸)를 따릅니다. */
function stubWide() {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: query === WIDE_SHELL_MEDIA, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
}

/** 결정 하나의 상세를 엽니다 — 고치기 전은 그 행의 '상세 펼치기', 고친 뒤는 시각순 목록의 그 결정 줄 단추(목록-검사 data-item-key = 결정 번호). */
async function openDetail(id: number) {
  await waitFor(() => {
    const ready = screen.queryAllByRole("button", { name: "상세 펼치기" }).length > 0 || document.querySelector(`button[data-item-key="${id}"]`) !== null;
    expect(ready).toBe(true);
  });
  const expand = screen.queryAllByRole("button", { name: "상세 펼치기" })[0];
  fireEvent.click(expand ?? document.querySelector<HTMLButtonElement>(`button[data-item-key="${id}"]`)!);
}

/** 영역 안 머리들의 단계(숫자). */
const levels = (root: HTMLElement) => [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((node) => Number(node.tagName.slice(1)));

describe("결정 상세 — 절 머리는 검사 칸 제목 바로 아래 단계", () => {
  beforeEach(() => {
    reads["/api/paper/overview"] = overview([book("rules", { kind: "RULES", label: "규칙 계좌" }), book("bench_spy", { label: "SPY 계좌" })]);
    reads["/api/paper/decisions?book=rules&limit=50"] = { available: true, decisions: [decision(7, "rules")] };
    reads["/api/paper/decisions/7"] = detail(decision(7, "rules"));
  });

  it("좁은 화면(대화상자 — 제목 h2): 상세 안 머리는 h3부터", async () => {
    render(<PaperPage initialTab="decisions" market="US" />);
    await openDetail(7);
    const section = await screen.findByRole("region", { name: "2026-10-23 초기 결정 상세" });
    await waitFor(() => expect(levels(section).length).toBeGreaterThan(0));
    expect(within(screen.getByRole("dialog")).getAllByRole("heading", { level: 2 }).length).toBeGreaterThan(0);
    expect(Math.min(...levels(section))).toBe(3);
  });

  it("넓은 화면(옆 검사 칸 — 제목 h3): 상세 안 머리는 h4부터", async () => {
    stubWide();
    render(<PaperPage initialTab="decisions" market="US" />);
    await openDetail(7);
    const section = await screen.findByRole("region", { name: "2026-10-23 초기 결정 상세" });
    await waitFor(() => expect(levels(section).length).toBeGreaterThan(0));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(Math.min(...levels(section))).toBe(4);
  });
});
