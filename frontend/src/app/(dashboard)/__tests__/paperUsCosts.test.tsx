/**
 * 미국 모의 계좌의 매매 수수료·매도 제비용(ADR 0030, 명세 docs/specs/2026-11-06-us-costs-backfill.md §4) — 화면.
 *
 *  - 미국 체결 표(규칙·Claude 계좌1·벤치마크)에 '수수료·제비용(달러)' 칸 — 한국 krFills와 같은 응답 칸(fee·tax), 소급 조정 행(costAdjustment)이 있으면
 *    그 값과 '비용 소급 — 수량은 당시 그대로'(현금 흐름은 title), 비용 칸이 없는 옛 응답은 '—'(값 없음)
 *  - 설정 탭은 새 키 넷(commissionBp·regFees.*)을 기존 설정 표 생성 방식 그대로 보이고, 바꾼 값은 점 경로 키로 모인다
 * 값은 모두 합성 값입니다.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
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

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };

function book(code: string, over: Record<string, unknown> = {}) {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000,
    cash: 50.12, nav: 100050.12, equityValue: 100000, exposurePct: 99.95, returnPct: 0.05,
    lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: STATS, benchmark: "bench_spy", ...over,
  };
}

const RULES = book("rules", { kind: "RULES", label: "규칙 계좌" });

const OVERVIEW = {
  available: true, initialized: true, startDate: "2026-10-23", jobs: [], pendingBackfill: [], limits: [],
  books: [RULES, book("claude", { kind: "CLAUDE", label: "Claude 계좌1" }), book("bench_spy", { label: "SPY 계좌", benchmark: null })],
  navSeries: { dates: [], books: {} }, quotes: null, selection: null, gate: null, claudeExposureSeries: [],
};

function fill(over: Record<string, unknown> = {}) {
  return {
    id: 91, orderId: 61, ticker: "AAA", side: "BUY", qty: 80, price: 100.05, rawPrice: 100, slippageBp: 5, gross: 8004,
    observedAtKst: "2026-11-04 01:10", observationDate: "2026-11-03", priceSource: "quotes_hourly", backfill: false, ...over,
  };
}

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않는 요청. 긴 경로부터 맞춥니다. */
let reads: Record<string, () => Promise<unknown>> = {};

beforeEach(() => {
  reads = {
    "/api/paper/overview": () => Promise.resolve(OVERVIEW),
    "/api/paper/books/rules/positions": () => Promise.resolve({ available: true, book: RULES, cash: 50.12, lockouts: [], positions: [] }),
    "/api/paper/books/rules/orders": () => Promise.resolve({ available: true, orders: [] }),
  };
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
    return key ? reads[key]() : new Promise(() => {});
  });
});

afterEach(() => cleanup());

const settled = () => act(async () => {});
const headersOf = (table: HTMLElement) => within(table).getAllByRole("columnheader").map((th) => th.textContent);
const costCells = (table: HTMLElement) => {
  const index = headersOf(table).indexOf("수수료·제비용(달러)");
  return within(table).getAllByRole("row").slice(1).map((row) => row.children[index] as HTMLElement);
};

describe("미국 체결 표 — 수수료·제비용 칸(ADR 0030)", () => {
  it("규칙 계좌 체결 표에 '수수료·제비용(달러)' — 매수는 수수료만, 매도는 제비용까지(센트), 소급 조정 행은 '비용 소급 — 수량은 당시 그대로'", async () => {
    reads["/api/paper/books/rules/fills"] = () => Promise.resolve({
      available: true,
      costAdjustmentTotal: { rows: 1, fee: 8.0, tax: 0, cashDelta: -8.0 },
      fills: [
        fill({ id: 93, side: "SELL", fee: 8.0, tax: 0.18, costAdjustment: null }),
        fill({ id: 92, fee: 8.0, tax: 0, costAdjustment: null }),
        fill({
          id: 91, fee: 0, tax: 0,
          costAdjustment: {
            fee: 8.0, tax: 0, cashDelta: -8.0, fillDate: "2026-11-03", settingsVersion: 16, rates: { commissionBp: 10 }, reason: "us-cost-backfill",
            createdAtKst: "2026-11-07 02:10", note: "비용 소급 — 수량은 당시 그대로",
          },
        }),
      ],
    });
    render(<PaperPage initialTab="holdings" />);
    await settled();

    const fills = screen.getByRole("table", { name: "체결" });
    const headers = headersOf(fills);
    expect(headers.slice(headers.indexOf("금액(달러)"), headers.indexOf("금액(달러)") + 2)).toEqual(["금액(달러)", "수수료·제비용(달러)"]);
    const cells = costCells(fills);
    expect(cells.map((cell) => cell.textContent)).toEqual([
      "8.00 · 0.18",
      "8.00 · 0.00",
      "8.00 · 0.00비용 소급 — 수량은 당시 그대로",
    ]);
    // 소급 행의 설명(title)에 현금 흐름 — 체결 행(수량·체결가)은 그대로라는 것.
    const retro = within(cells[2]).getByText("비용 소급 — 수량은 당시 그대로").parentElement as HTMLElement;
    expect(retro.getAttribute("title")).toMatch(/^비용 소급 — 수량은 당시 그대로: .*수량이 조금 달랐을 것입니다\. 현금 -8\.00달러\.$/);
    // 소급 행도 수량·체결가는 체결 행 그대로.
    expect(within(fills).getAllByText("80")).toHaveLength(3);
    // 표 위에 그 계좌 전체의 소급 합계.
    expect(screen.getByText("비용 소급 1건(계좌 전체) — 수수료 8.00 · 제비용 0.00 · 현금 -8.00달러 — 수량은 당시 그대로")).toBeTruthy();
    expect(screen.getByText(/비용은 수수료\(매수·매도\) · 제비용\(매도만 — SEC fee \+ FINRA TAF, 달러\)이고 체결가와 따로 현금에서 뺍니다/)).toBeTruthy();
  });

  it("비용 칸을 싣지 않는 옛 응답은 '—'(값 없음) — 0으로 채우지 않는다", async () => {
    reads["/api/paper/books/rules/fills"] = () => Promise.resolve({ available: true, fills: [fill()] });
    render(<PaperPage initialTab="holdings" />);
    await settled();

    const [cell] = costCells(screen.getByRole("table", { name: "체결" }));
    expect(cell.textContent).toBe("—값 없음");
    expect(cell.textContent).not.toContain("0.00");
    expect(screen.queryByText(/^비용 소급 \d+건/)).toBeNull();
  });
});

describe("설정 탭 — 미국 비용 키 넷", () => {
  const SETTINGS = {
    available: true,
    version: 16,
    body: { slippageBp: 5, commissionBp: 10, regFees: { secPerMillion: 20.6, tafPerShare: 0.000195, tafMaxPerTrade: 9.79 } },
    defaults: { slippageBp: 5, commissionBp: 10, regFees: { secPerMillion: 20.6, tafPerShare: 0.000195, tafMaxPerTrade: 9.79 } },
    keys: [
      { key: "slippageBp", type: "number", min: 0, max: 100, affectsRules: true, market: "US", description: "체결가에 얹는 슬리피지(bp)" },
      { key: "commissionBp", type: "number", min: 0, max: 100, affectsRules: true, market: "US", description: "매매 수수료(bp, 매수·매도)" },
      { key: "regFees.secPerMillion", type: "number", min: 0, max: 1000, affectsRules: true, market: "US", description: "SEC fee($/백만 달러, 매도만)" },
      { key: "regFees.tafPerShare", type: "number", min: 0, max: 0.01, affectsRules: true, market: "US", description: "FINRA TAF($/주, 매도만)" },
      { key: "regFees.tafMaxPerTrade", type: "number", min: 0, max: 100, affectsRules: true, market: "US", description: "TAF 1건 상한($)" },
    ],
  };

  it("새 키 넷이 지금 값·범위·설명과 함께 보이고, regFees.*는 '미국 계좌 — 매도 제비용' 묶음 — 바꾼 값은 점 경로 키로", async () => {
    reads["/api/paper/settings"] = () => Promise.resolve(SETTINGS);
    reads["/api/paper/settings/history"] = () => Promise.resolve({ available: true, history: [] });
    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "설정" }));
    await screen.findByLabelText("commissionBp");

    expect(screen.getByText("미국 계좌 — 매도 제비용(SEC fee · FINRA TAF — 매도만, 다섯 계좌 공통, ADR 0030)")).toBeTruthy();
    const values: Record<string, string> = {
      commissionBp: "10", "regFees.secPerMillion": "20.6", "regFees.tafPerShare": "0.000195", "regFees.tafMaxPerTrade": "9.79",
    };
    for (const [key, value] of Object.entries(values)) {
      const input = screen.getByLabelText(key) as HTMLInputElement;
      expect(input.value, key).toBe(value);
    }
    const taf = (screen.getByLabelText("regFees.tafPerShare") as HTMLInputElement).closest("div.grid") as HTMLElement;
    expect(taf.textContent).toContain("0~0.01");
    expect(taf.textContent).toContain("FINRA TAF($/주, 매도만)");

    fireEvent.change(screen.getByLabelText("regFees.tafPerShare"), { target: { value: "0" } });
    const changes = within(screen.getByRole("region", { name: "바꿀 값" })).queryAllByRole("listitem").map((li) => li.textContent);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatch(/^regFees\.tafPerShare: 0\.000195 → 0/);
  });
});
