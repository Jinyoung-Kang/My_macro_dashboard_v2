/**
 * useStockQuote — 종목 상세·종목 팝업의 가격은 실시간 시세가 '지금 값'일 때만 그 값(QA-1029).
 *
 * 실시간 응답에서 빠진 종목(missing)과 연결이 닫힌 동안(disconnected)의 앞 값은 멈춘 값입니다(hooks/useLivePrices — QA-183·184). 수정 전에는 그 값을
 * 지금 가격·전일 대비로 그대로 썼습니다. 그때는 시세 응답(GET /api/detail/quote)의 값으로 돌아갑니다. 응답은 모두 합성 값입니다.
 * 'QA-1029:' 두 시험은 재현 커밋에서 it.fails였습니다.
 */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LivePrice } from "@/lib/types";

const state = vi.hoisted(() => ({
  realtime: { prices: {}, receivedAt: null, receivedAtByKey: {}, missing: [], error: null, sourceError: null, disconnected: false } as Record<string, unknown>,
}));
vi.mock("@/hooks/useApi", () => ({
  useApi: () => ({ data: { available: true, quote: { name: "Fake Co", price: 100, change: 1, changePct: 1.01, currency: "USD" } }, loading: false, error: null }),
}));
vi.mock("@/hooks/useLivePrices", () => ({ useLivePrices: () => state.realtime }));
vi.mock("@/hooks/useLiveSeconds", () => ({ useLiveSeconds: () => [10, () => {}] }));

import { useStockQuote } from "../useStockQuote";

const LIVE: LivePrice = {
  market: "US", code: "FAKE", price: 123, prevClose: 120, change: 3, changePct: 2.5, currency: "USD", tradedAt: "2026-11-02T18:43:17Z",
  status: "OPEN", source: "네이버", overPrice: null, overChange: null, overChangePct: null, overTradedAt: null, overSession: null,
};
const realtime = (over: Record<string, unknown>) => ({
  prices: { "US:FAKE": LIVE }, receivedAt: 1, receivedAtByKey: { "US:FAKE": 1 }, missing: [], error: null, sourceError: null, disconnected: false, ...over,
});

beforeEach(() => {
  state.realtime = realtime({});
});
afterEach(cleanup);

describe("useStockQuote — 실시간 값이 지금 값일 때만", () => {
  it("실시간 가격을 받았으면 그 가격·전일 대비", () => {
    const { result } = renderHook(() => useStockQuote("us", "FAKE"));
    expect(result.current).toMatchObject({ price: 123, change: 3, changePct: 2.5 });
    expect(result.current.live).not.toBeNull();
  });

  it("QA-1029: 마지막 응답에서 빠진 종목(missing)의 앞 값은 쓰지 않는다 — 시세 응답의 값으로", () => {
    state.realtime = realtime({ missing: ["US:FAKE"] });
    const { result } = renderHook(() => useStockQuote("us", "FAKE"));
    expect(result.current).toMatchObject({ price: 100, change: 1, changePct: 1.01, live: null, shown: null });
  });

  it("QA-1029: 연결이 닫힌 동안(disconnected)의 앞 값도 쓰지 않는다", () => {
    state.realtime = realtime({ disconnected: true });
    const { result } = renderHook(() => useStockQuote("us", "FAKE"));
    expect(result.current).toMatchObject({ price: 100, change: 1, changePct: 1.01, live: null, shown: null });
  });
});
