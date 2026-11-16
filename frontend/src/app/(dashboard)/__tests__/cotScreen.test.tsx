/**
 * COT(/cot) 화면 — 요약 표·극단 성적의 부호·등락 표시(QA-629).
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import CotPage from "../cot/page";

/** 줄 처음·공백·여는 괄호 뒤의 ASCII 하이픈 음수 부호(lib/format withMinusSign이 바꾸는 자리) — 날짜의 하이픈은 걸리지 않습니다. */
const ASCII_MINUS = /(^|[\s(])-(?=[\d.])/;
const S_AND_P = "S&P 500 E-Mini";

const summary = (asset: string, category: string, overrides: Record<string, unknown> = {}) => ({
  asset, category, available: true, date: "2026-10-27", ncNet: -134368, commNet: 17301, nrNet: -2500,
  change1w: -8303, change4w: 8131, change13w: -117172, percentile: 34.94, ageDays: 21, error: null, ...overrides,
});

const sideSummary = (mean: number | null, winRate: number | null, count = 13) => ({ count, mean, median: mean, winRate, best: 8.97, worst: -4.66 });

const BODIES: Record<string, unknown> = {
  "/api/cot/assets": { assets: [
    { name: S_AND_P, code: "13874A", category: "주식" },
    { name: "금", code: "088691", category: "원자재" },
  ] },
  "/api/cot/overview": { available: true, collectedAtKst: "2026-11-04 19:36 KST", ageSeconds: 60, assets: [
    summary("금", "원자재", { ncNet: 186451, commNet: -215624, change1w: 13414, change4w: 32181 }),
    summary(S_AND_P, "주식"),
  ] },
  "/api/cot/asset": { asset: S_AND_P, code: "13874A", available: true, rows: [
    { date: "2026-10-20", ncNet: -142671, commNet: 20000, nrNet: 122671 },
    { date: "2026-10-27", ncNet: -134368, commNet: 17301, nrNet: -2500 },
  ], summary: summary(S_AND_P, "주식") },
  "/api/cot/extremes": {
    available: true, asset: S_AND_P, percentile: 95, lookbackWeeks: 52, priceProxy: "SPY", priceProxyLabel: "SPDR S&P 500 ETF",
    proxyNotice: "대용 가격입니다.", priceFrom: "2024-11-04", priceTo: "2026-11-03",
    sides: [{ side: "극단 롱", rule: "비상업 순포지션이 과거 52주 중 상위 95% 이상",
      h4: sideSummary(-2.1, 30.77), h13: sideSummary(5.08, 90), baseline4: sideSummary(-1.21, 63.37, 101), baseline13: sideSummary(4.17, 78.26, 92) }],
    recentEvents: [
      { date: "2026-08-18", side: "극단 롱", net: -10560, percentile: 98.11, return4w: -1.53, return13w: null },
      { date: "2026-07-21", side: "극단 롱", net: 16784, percentile: 100, return4w: 3.3, return13w: 3.81 },
    ],
  },
};

/** 그 글이 든 표 행(tbody tr) 가운데 첫째 — 자산 이름은 고르기·패널 제목에도 나와 표 행 안의 것만 봅니다. */
function rowOf(text: string): HTMLElement {
  const row = screen.getAllByText(text).map((node) => node.closest("tbody tr")).find(Boolean);
  if (!row) throw new Error(`표 행을 찾지 못함: ${text}`);
  return row as HTMLElement;
}

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(BODIES).find((prefix) => path.startsWith(prefix));
    return key ? Promise.resolve(BODIES[key]) : new Promise(() => {});
  });
});

afterEach(() => cleanup());

describe("QA-629 COT 순포지션·변화·극단 성적의 부호와 방향", () => {
  // 수정 전에는 요약 표 1주·4주 변화가 색과 ASCII '-'뿐이고(읽어 주는 방향 글 없음), 순포지션 둘이 ASCII '-'였다. 순포지션 색(하락 파랑)은 뜻이라 그대로 둔다.
  it.fails("요약 표의 변화 둘은 변화 칩, 순포지션은 −(U+2212)이고 스마트머니 순포지션의 색은 그대로다", async () => {
    render(<CotPage />);
    await waitFor(() => expect(rowOf("2026-10-27")).toBeTruthy());

    const row = rowOf("주식");
    expect(within(row).getByText("하락")).toBeTruthy();
    expect(within(row).getByText("상승")).toBeTruthy();
    expect(within(row).getByText("−8,303")).toBeTruthy();
    const ncNet = within(row).getByText("−134,368");
    expect(ncNet.closest(".text-down")).toBeTruthy();
    expect(within(row).queryAllByText(ASCII_MINUS).map((node) => node.textContent)).toEqual([]);
    const gold = rowOf("원자재");
    expect(within(gold).getByText("−215,624")).toBeTruthy();
    expect(within(gold).getAllByText("상승")).toHaveLength(2);
  });

  // 수정 전에는 극단 성적 표의 평균 수익률·최근 신호의 이후 수익률이 색과 ASCII '-'뿐이고, 순포지션·중앙값·비교 값·고른 자산 요약 값이 ASCII '-'였다.
  it.fails("극단 성적의 수익률은 변화 칩이고, 화면 어디에도 ASCII 음수 부호가 없다", async () => {
    render(<CotPage />);
    await screen.findByText("최근 극단 신호");

    const recent = rowOf("2026-08-18");
    expect(within(recent).getByText("하락")).toBeTruthy();
    expect(within(recent).getByText("−1.53%")).toBeTruthy();
    expect(within(recent).getByText("−10,560")).toBeTruthy();
    const fourWeeks = rowOf("4주 뒤");
    expect(within(fourWeeks).getByText("하락")).toBeTruthy();
    expect(screen.queryAllByText(ASCII_MINUS).map((node) => node.textContent)).toEqual([]);
  });
});
