/**
 * QA-747(작업대 W13) — 모의 결정 로그의 결정 상세가 좁은 화면(390)에서 잘림.
 *
 * 펼친 결정 상세(DecisionDetail)가 min-w-[820px] 결정 표의 `<td colSpan>` 칸 안에 그려져, 좁은 화면에서는 상세가 표 폭(820px)만큼 넓어지고 글이
 * 화면 밖으로 밀렸습니다(가로로 넘겨야 읽힘). 상세는 표 밖의 검사 칸(넓은 틀은 오른쪽 칸, 좁은 틀·좁은 화면은 위쪽 대화상자)에 그려야 합니다.
 *
 * jsdom은 배치를 하지 않고(useWideShell 거짓 — 좁은 화면의 배치) 폭을 재지 못하므로, 상세 영역(`{거래일} {종류} 상세`)에 표 조상이 없고 조상 어디에도
 * 화면 폭(390px)보다 큰 최소 폭 클래스(`min-w-[…px]`)가 없는지를 DOM으로 봅니다. 상세는 여는 순간 그 결정 한 건만 한 번 읽습니다(요청은 그대로).
 * 여는 조작은 도우미 하나 — 표의 '상세 펼치기'(고치기 전) 또는 시각순 목록의 줄 단추(고친 뒤, 목록-검사 data-item-key).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

/** 좁은 화면 폭(px) — 이보다 큰 최소 폭 클래스가 상세의 조상에 있으면 상세가 화면 밖으로 넓어집니다. */
const NARROW = 390;

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
afterEach(() => cleanup());

/** 결정 하나의 상세를 엽니다 — 고치기 전은 그 행의 '상세 펼치기', 고친 뒤는 시각순 목록의 그 결정 줄 단추(목록-검사 data-item-key = 결정 번호). */
async function openDetail(id: number) {
  await waitFor(() => {
    const ready = screen.queryAllByRole("button", { name: "상세 펼치기" }).length > 0 || document.querySelector(`button[data-item-key="${id}"]`) !== null;
    expect(ready).toBe(true);
  });
  const expand = screen.queryAllByRole("button", { name: "상세 펼치기" })[0];
  fireEvent.click(expand ?? document.querySelector<HTMLButtonElement>(`button[data-item-key="${id}"]`)!);
}

/** 조상(자신 제외)의 클래스에서 `min-w-[Npx]`의 N 목록. */
function ancestorMinWidths(element: HTMLElement): number[] {
  const widths: number[] = [];
  for (let node = element.parentElement; node; node = node.parentElement) {
    for (const match of String(node.getAttribute("class") ?? "").matchAll(/(?:^|\s)min-w-\[(\d+)px\]/g)) widths.push(Number(match[1]));
  }
  return widths;
}

describe("QA-747 결정 상세 — 표 밖 검사 칸(좁은 화면은 대화상자)에 그린다", () => {
  it.fails("미국 규칙 계좌: 펼친 결정 상세에 표 조상이 없고, 조상에 390px보다 큰 최소 폭이 없다 — 상세는 그 결정 한 건만 한 번 읽는다", async () => {
    reads["/api/paper/overview"] = overview([book("rules", { kind: "RULES", label: "규칙 계좌" }), book("bench_spy", { label: "SPY 계좌" })]);
    reads["/api/paper/decisions?book=rules&limit=50"] = { available: true, decisions: [decision(7, "rules")] };
    reads["/api/paper/decisions/7"] = detail(decision(7, "rules"));
    render(<PaperPage initialTab="decisions" market="US" />);

    await openDetail(7);
    const section = await screen.findByRole("region", { name: "2026-10-23 초기 결정 상세" });
    expect(api.apiGetShared.mock.calls.filter(([path]) => path === "/api/paper/decisions/7")).toHaveLength(1);
    expect(section.closest("table"), "상세의 표 조상").toBeNull();
    expect(ancestorMinWidths(section).filter((width) => width > NARROW), "상세 조상의 최소 폭(px)").toEqual([]);
  });

  it.fails("한국 규칙 계좌: 같은 상세가 표 밖에 그려진다", async () => {
    window.history.replaceState(null, "", "/paper/kr/decisions");
    reads["/api/paper/overview?market=KR"] = overview(
      [book("kr_rules", { kind: "RULES", label: "한국 규칙 계좌" }), book("kr_bench_k200", { label: "KODEX 200 계좌" })],
      { market: "KR", currency: "KRW", dormantReason: null },
    );
    reads["/api/paper/decisions?book=kr_rules&limit=50"] = { available: true, decisions: [decision(41, "kr_rules", { kind: "SCHEDULED" })] };
    reads["/api/paper/decisions/41"] = detail(decision(41, "kr_rules", { kind: "SCHEDULED" }));
    render(<PaperPage initialTab="decisions" market="KR" />);

    await openDetail(41);
    const section = await screen.findByRole("region", { name: "2026-10-23 정기 상세" });
    expect(section.closest("table"), "상세의 표 조상").toBeNull();
    expect(ancestorMinWidths(section).filter((width) => width > NARROW), "상세 조상의 최소 폭(px)").toEqual([]);
  });
});
