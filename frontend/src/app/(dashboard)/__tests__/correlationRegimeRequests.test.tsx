/**
 * 상관(/correlation)·국면(/regime) 화면의 요청 지킴 — 작업대 개편(P5a 분석 갈래)이 화면을 다시 짜도 읽는 경로·횟수·시점이 그대로인지 봅니다.
 *
 * - 열 때 읽는 경로와 횟수(같은 경로를 두 번 읽지 않음), 응답을 기다리지 않고 함께 부름(차례로 기다리지 않음).
 * - 자동 갱신 간격(상관 5분 · 국면 5분 · 판정 기록 10분 · 판정 성과 10분) — 걸린 타이머를 하나씩 불러 어느 경로를 다시 읽는지 봅니다.
 * - 조작 뒤에는 바뀐 조건의 경로만 한 번 더(나머지는 다시 읽지 않음).
 *
 * 개편 전 코드에서 통과시켜 두고, 개편 커밋들이 그대로 통과해야 합니다(계획 §4 '요청 지킴 시험'). 탭·판정 기록 고르기처럼 개편이 새로 만드는
 * 조작의 '+0' 사례는 그 조작을 만드는 커밋에서 더합니다.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { endpoints } from "@/lib/endpoints";
import CorrelationPage from "../correlation/page";
import RegimePage from "../regime/page";

/** 경로 → 응답(정확히 일치). 없는 경로는 끝나지 않는 요청(불러오는 중). */
let reads: Record<string, unknown> = {};
let intervals: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  reads = {};
  signal.token = 0;
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  intervals = vi.spyOn(globalThis, "setInterval");
});
afterEach(() => cleanup());

/** 부른 경로 목록(부른 차례 그대로). */
const calledPaths = () => (api.apiGetShared.mock.calls as unknown as [string][]).map(([path]) => path);
/** 경로마다 부른 횟수. */
function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const path of calledPaths()) out[path] = (out[path] ?? 0) + 1;
  return out;
}

/**
 * 1분 이상 간격의 타이머(자동 갱신)를 하나씩 불러 다시 읽은 경로를 모읍니다 — 간격 → 그 타이머가 읽은 경로 목록(정렬).
 * 1분 미만 타이머(화면 안 시계 등)는 자동 갱신이 아니라 보지 않습니다.
 */
async function refreshTimers(): Promise<Record<number, string[]>> {
  const out: Record<number, string[]> = {};
  const calls = intervals.mock.calls as unknown as [() => void, number][];
  for (const [callback, delay] of calls) {
    if (typeof delay !== "number" || delay < 60_000) continue;
    const before = calledPaths().length;
    await act(async () => callback());
    const added = calledPaths().slice(before);
    out[delay] = [...(out[delay] ?? []), ...added].sort();
  }
  return out;
}

const SERIES = endpoints.insight.series;
const CORRELATION = endpoints.insight.correlation({ x: "liquidity:net", y: "etf:QQQ", window: "60", years: "3", mode: "change" });
const REGIME = endpoints.insight.regime("5");
const REGIME_LOG = endpoints.insight.regimeLog(60);
const TRACK_SPY = endpoints.insight.regimeTrackRecord("SPY");

describe("상관 화면의 요청", () => {
  it("열 때 계열 목록과 상관을 한 번씩 함께 부르고, 자동 갱신은 상관만 5분마다", async () => {
    render(<CorrelationPage />);
    // 둘 다 끝나지 않는 요청인데도 둘이 함께 나갑니다 — 계열 목록을 받은 뒤에 상관을 부르지 않습니다.
    await waitFor(() => expect(calledPaths()).toHaveLength(2));
    expect(counts()).toEqual({ [SERIES]: 1, [CORRELATION]: 1 });

    expect(await refreshTimers()).toEqual({ 300_000: [CORRELATION] });
  });

  it("지표 X를 바꾸면 상관만 한 번 더 — 계열 목록은 다시 읽지 않는다", async () => {
    reads[SERIES] = {
      series: [
        { id: "liquidity:net", label: "연준 순유동성", group: "유동성", unit: "조 달러", source: "FRED" },
        { id: "etf:QQQ", label: "나스닥 100 (QQQ)", group: "ETF", unit: "달러", source: "Yahoo" },
        { id: "fred:NFCI", label: "NFCI", group: "금융 여건", unit: "", source: "FRED" },
      ],
    };
    render(<CorrelationPage />);
    await screen.findAllByRole("option", { name: "NFCI · 금융 여건" });

    fireEvent.change(screen.getByLabelText("지표 X"), { target: { value: "fred:NFCI" } });

    const next = endpoints.insight.correlation({ x: "fred:NFCI", y: "etf:QQQ", window: "60", years: "3", mode: "change" });
    await waitFor(() => expect(counts()[next]).toBe(1));
    expect(counts()).toEqual({ [SERIES]: 1, [CORRELATION]: 1, [next]: 1 });
  });
});

describe("국면 화면의 요청", () => {
  it("열 때 국면·판정 기록·판정 성과를 한 번씩 함께 부르고, 자동 갱신은 국면 5분·기록과 성과 10분", async () => {
    render(<RegimePage />);
    // 셋 모두 끝나지 않는 요청인데도 함께 나갑니다 — 국면 응답을 기다린 뒤에 기록·성과를 부르지 않습니다.
    await waitFor(() => expect(calledPaths()).toHaveLength(3));
    expect(counts()).toEqual({ [REGIME]: 1, [REGIME_LOG]: 1, [TRACK_SPY]: 1 });

    expect(await refreshTimers()).toEqual({ 300_000: [REGIME], 600_000: [REGIME_LOG, TRACK_SPY].sort() });
  });

  it("이력 기간을 바꾸면 국면만 한 번 더 — 판정 기록·판정 성과는 다시 읽지 않는다", async () => {
    reads[REGIME] = { available: true, timeline: [] };
    render(<RegimePage />);
    await waitFor(() => expect(calledPaths()).toHaveLength(3));

    fireEvent.change(await screen.findByLabelText("이력 기간"), { target: { value: "10" } });

    const next = endpoints.insight.regime("10");
    await waitFor(() => expect(counts()[next]).toBe(1));
    expect(counts()).toEqual({ [REGIME]: 1, [REGIME_LOG]: 1, [TRACK_SPY]: 1, [next]: 1 });
  });

  it("판정 성과의 자산을 바꾸면 그 성과만 한 번 더", async () => {
    reads[TRACK_SPY] = {
      available: false, locked: false, message: "가격이 부족합니다.", asset: "SPY", assetLabel: "S&P 500 (SPY)",
      assets: [{ ticker: "SPY", label: "S&P 500 (SPY)" }, { ticker: "QQQ", label: "나스닥 100 (QQQ)" }], horizons: [], limits: [],
    };
    render(<RegimePage />);
    await screen.findByRole("option", { name: "나스닥 100 (QQQ)" });

    fireEvent.change(screen.getByLabelText("자산"), { target: { value: "QQQ" } });

    const next = endpoints.insight.regimeTrackRecord("QQQ");
    await waitFor(() => expect(counts()[next]).toBe(1));
    expect(counts()).toEqual({ [REGIME]: 1, [REGIME_LOG]: 1, [TRACK_SPY]: 1, [next]: 1 });
  });
});
