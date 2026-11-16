/**
 * 순유동성(/liquidity)·섹터(/sector)·COT(/cot) 화면의 요청 지킴 — 작업대 개편(P5a 가벼운 갈래)이 화면 배치를 바꿔도 읽는 경로·횟수·자동 갱신 간격·
 * 실시간 구독이 그대로인지 봅니다. 개편 전 코드에서 먼저 통과시켜 두고, 배치를 바꾸는 커밋들이 그대로 통과해야 합니다(계획 §4 '요청 지킴 시험').
 *
 * - 열 때: 화면마다 읽는 경로와 횟수(각 한 번), 자동 갱신 간격(setInterval에 건 간격 — 순유동성 5분·환율 2분, 섹터 5분, COT 개요 10분).
 * - 조작 뒤: 섹터 '조회 기간'은 그 기간 한 번 더, '표시 기준'은 0번. COT '자산' 고르기는 그 자산의 추이·극단 성적 두 경로를 한 번씩(개요·자산 목록은 다시 읽지 않음),
 *   '극단 기준'은 극단 성적 한 경로만.
 * 행으로 고르기·검사 열기처럼 개편이 새로 두는 조작은 그 조작을 두는 커밋에서 이 파일에 사례를 더합니다(고르기와 같은 요청·검사 +0).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), apiBase: () => "http://backend", UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 함수를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import CotPage from "../cot/page";
import LiquidityPage from "../liquidity/page";
import SectorPage from "../sector/page";
import { resetLiveSecondsForTest } from "@/hooks/useLiveSeconds";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener() {}
  close() {}
}

const S_AND_P = "S&P 500 E-Mini";
const enc = encodeURIComponent;

const sectorRow = (ticker: string, name: string, value: number) => ({
  ticker, name, kind: "공격 / 성장", price: 100,
  returns: { "1W": value, "1M": value, "3M": value, "6M": value, YTD: value, "1Y": value },
  alpha: { "1W": 0.5, "1M": 0.5, "3M": 0.5, "6M": 0.5, YTD: 0.5, "1Y": 0.5 }, ranks: { "1M": 1, "3M": 1 },
});

const cotSummary = (asset: string, category: string) => ({
  asset, category, available: true, date: "2026-10-27", ncNet: -134368, commNet: 17301, nrNet: 117067,
  change1w: 8303, change4w: -8131, change13w: -117172, percentile: 34.9, ageDays: 21, error: null,
});

/** 경로 앞부분 → 응답 본문. 없는 경로는 끝나지 않는 요청. */
const BODIES: Record<string, unknown> = {
  "/api/liquidity": {
    available: true, isEstimated: false, collectedAtKst: "2026-11-04 19:34 KST", ageSeconds: 60, stale: false,
    rows: [{ date: "2026-11-03", netLiquidityT: 5.745, walclT: 6.745, wtregenB: 999.7, rrpB: 0.427 }],
    latest: { date: "2026-11-03", netLiquidityT: 5.745, previousT: 5.74, deltaT: 0.0047, pct: 0.08, walclT: 6.745, tgaB: 999.7, rrpB: 0.427 },
    momentum: { change4w: -0.048, change12w: -0.094 },
  },
  "/api/macro/usdkrw": { available: true, rate: 1339.28, lastTs: "2026-11-04 20:19 KST" },
  "/api/sector/rotation": {
    available: true, periods: ["1W", "1M", "3M", "6M", "YTD", "1Y"], period: "1M", benchmark: "SPY",
    benchmarkReturns: { "1W": -1.99, "1M": -2.64, "3M": -1.76, "6M": 4.75, YTD: 11.49, "1Y": 11.79 },
    collectedAtKst: "2026-11-04 19:35 KST", ageSeconds: 60, stale: false,
    sectors: [sectorRow("XLK", "정보기술", -12.15), sectorRow("XLE", "에너지", 3.2)],
    assetClasses: [sectorRow("GLD", "금", 1.1)],
  },
  "/api/cot/assets": { assets: [
    { name: S_AND_P, code: "13874A", category: "주식" },
    { name: "금", code: "088691", category: "원자재" },
  ] },
  "/api/cot/overview": { available: true, collectedAtKst: "2026-11-04 19:36 KST", ageSeconds: 60,
    assets: [cotSummary("금", "원자재"), cotSummary(S_AND_P, "주식")] },
  "/api/cot/asset": { asset: S_AND_P, code: "13874A", available: true, rows: [
    { date: "2026-10-20", ncNet: -142671, commNet: 20000, nrNet: 122671 },
    { date: "2026-10-27", ncNet: -134368, commNet: 17301, nrNet: 117067 },
  ], summary: cotSummary(S_AND_P, "주식") },
  "/api/cot/extremes": { available: true, asset: S_AND_P, percentile: 95, lookbackWeeks: 52, priceProxy: "SPY", priceProxyLabel: "SPDR S&P 500 ETF",
    proxyNotice: "대용 가격입니다.", priceFrom: "2024-11-04", priceTo: "2026-11-03", sides: [], recentEvents: [] },
};

/** 부른 경로(apiGetShared의 첫 인자) 차례대로. */
const calls = (): string[] => api.apiGetShared.mock.calls.map((call) => String(call[0]));
/** 경로 → 부른 횟수. */
const counts = (): Record<string, number> =>
  calls().reduce<Record<string, number>>((acc, path) => ({ ...acc, [path]: (acc[path] ?? 0) + 1 }), {});

let intervals: number[] = [];

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  window.localStorage.clear();
  window.localStorage.setItem("live.priceRefreshSeconds", "10");
  resetLiveSecondsForTest();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(BODIES).find((prefix) => path.startsWith(prefix));
    return key ? Promise.resolve(BODIES[key]) : new Promise(() => {});
  });
  // 자동 갱신 간격 — 화면이 건 setInterval의 간격만 모읍니다(타이머는 그대로 겁니다). 1분 이하의 시계(경과 초·분 시계)는 요청이 아니라 뺍니다.
  intervals = [];
  const realSetInterval = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: TimerHandler, timeout?: number, ...rest: unknown[]) => {
    if (typeof timeout === "number" && timeout > 60_000) intervals.push(timeout);
    return realSetInterval(handler as () => void, timeout, ...rest);
  }) as typeof setInterval);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  resetLiveSecondsForTest();
});

describe("순유동성 요청", () => {
  it("열 때 순유동성(3년)과 원/달러 환율을 한 번씩 읽고, 5분·2분 간격으로 다시 읽는다", async () => {
    render(<LiquidityPage />);
    await waitFor(() => expect(calls()).toHaveLength(2));
    await screen.findByLabelText("조회 기간");

    expect(counts()).toEqual({ "/api/liquidity?years=3": 1, "/api/macro/usdkrw": 1 });
    expect([...intervals].sort((a, b) => a - b)).toEqual([120_000, 300_000]);
  });

  it("조회 기간을 바꾸면 그 기간만 한 번 더 읽는다(환율은 다시 읽지 않음)", async () => {
    render(<LiquidityPage />);
    const select = await screen.findByLabelText("조회 기간");
    await waitFor(() => expect(calls()).toHaveLength(2));

    fireEvent.change(select, { target: { value: "5" } });

    await waitFor(() => expect(counts()["/api/liquidity?years=5"]).toBe(1));
    expect(counts()).toEqual({ "/api/liquidity?years=3": 1, "/api/liquidity?years=5": 1, "/api/macro/usdkrw": 1 });
  });
});

describe("섹터 요청", () => {
  it("열 때 1M 로테이션을 한 번 읽고 5분 간격, 표의 ETF 전부를 실시간 시세 한 연결로 구독한다", async () => {
    render(<SectorPage />);
    await screen.findAllByText("정보기술");
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    expect(counts()).toEqual({ "/api/sector/rotation?period=1M": 1 });
    expect(intervals).toEqual([300_000]);
    // 구독은 한 연결(표를 그린 뒤 열리고, 같은 종목 목록이면 다시 열지 않음).
    expect(FakeEventSource.instances).toHaveLength(1);
    const url = decodeURIComponent(FakeEventSource.instances[0].url);
    expect(url).toContain("items=US:XLK,US:XLE,US:GLD");
    expect(url).toContain("interval=10");
  });

  it("조회 기간을 바꾸면 그 기간을 한 번 더 읽고, 표시 기준을 바꾸면 읽지 않는다", async () => {
    render(<SectorPage />);
    await screen.findAllByText("정보기술");

    fireEvent.change(screen.getByLabelText("표시 기준"), { target: { value: "alpha" } });
    await act(async () => {});
    expect(counts()).toEqual({ "/api/sector/rotation?period=1M": 1 });

    fireEvent.change(screen.getByLabelText("조회 기간"), { target: { value: "3M" } });
    await waitFor(() => expect(counts()["/api/sector/rotation?period=3M"]).toBe(1));
    expect(counts()).toEqual({ "/api/sector/rotation?period=1M": 1, "/api/sector/rotation?period=3M": 1 });
  });
});

describe("COT 요청", () => {
  const assetPath = (name: string) => `/api/cot/asset?name=${enc(name)}`;
  const extremesPath = (name: string, percentile = "95", lookback = "52") =>
    `/api/cot/extremes?name=${enc(name)}&percentile=${percentile}&lookbackWeeks=${lookback}`;

  it("열 때 자산 목록·개요·기본 자산(S&P 500 E-Mini)의 추이·극단 성적을 한 번씩 읽고, 개요만 10분 간격으로 다시 읽는다", async () => {
    render(<CotPage />);
    await waitFor(() => expect(calls()).toHaveLength(4));
    await screen.findAllByText("금");

    expect(counts()).toEqual({
      "/api/cot/assets": 1,
      "/api/cot/overview": 1,
      [assetPath(S_AND_P)]: 1,
      [extremesPath(S_AND_P)]: 1,
    });
    expect(intervals).toEqual([600_000]);
  });

  it("'자산' 고르기로 바꾸면 그 자산의 추이·극단 성적만 한 번씩 더 읽는다", async () => {
    render(<CotPage />);
    await waitFor(() => expect(calls()).toHaveLength(4));
    const select = await screen.findByLabelText("자산");
    await waitFor(() => expect((select as HTMLSelectElement).options.length).toBe(2));

    fireEvent.change(select, { target: { value: "금" } });

    await waitFor(() => expect(counts()[extremesPath("금")]).toBe(1));
    expect(counts()).toEqual({
      "/api/cot/assets": 1,
      "/api/cot/overview": 1,
      [assetPath(S_AND_P)]: 1,
      [extremesPath(S_AND_P)]: 1,
      [assetPath("금")]: 1,
      [extremesPath("금")]: 1,
    });
  });

  it("'극단 기준'을 바꾸면 극단 성적만 한 번 더 읽는다", async () => {
    render(<CotPage />);
    await waitFor(() => expect(calls()).toHaveLength(4));

    fireEvent.change(await screen.findByLabelText("극단 기준"), { target: { value: "98" } });

    await waitFor(() => expect(counts()[extremesPath(S_AND_P, "98")]).toBe(1));
    expect(calls()).toHaveLength(5);
  });
});
