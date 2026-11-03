/**
 * 섹터·자산군 현재가의 실시간 값(ADR 0024 2단계) — 고정하는 것
 *  - 표의 ETF를 모두 'US:티커'로 실시간 시세 SSE에 붙고, 주기는 모의 매매 화면과 같은 설정(머리말의 '현재가 실시간 주기')
 *  - 받은 값이 있으면 현재가 칸이 그 가격과 오늘 등락, 없으면 저장본 현재가 — 수익률·순위는 저장본 그대로
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), apiBase: () => "http://backend", UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import SectorPage from "../sector/page";
import { resetLiveSecondsForTest } from "@/hooks/useLiveSeconds";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  close() {}
  emit(name: string, body: unknown) {
    (this.listeners.get(name) ?? []).forEach((listener) => listener({ data: JSON.stringify(body) } as MessageEvent<string>));
  }
}

const row = (ticker: string, name: string, price: number) => ({
  ticker, name, kind: "공격 / 성장", price, returns: { "1M": 1.5 }, ranks: { "1M": 1 },
});

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  window.localStorage.clear();
  window.localStorage.setItem("live.priceRefreshSeconds", "10");
  resetLiveSecondsForTest();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path.startsWith("/api/sector/rotation")
      ? Promise.resolve({ available: true, periods: ["1M"], period: "1M", benchmark: "SPY", benchmarkReturns: {},
                          sectors: [row("XLK", "정보기술", 250.1)], assetClasses: [row("GLD", "금", 370.4)] })
      : new Promise(() => {}));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  resetLiveSecondsForTest();
});

describe("섹터·자산군 현재가 실시간", () => {
  it("표의 ETF를 고른 주기로 구독하고, 받은 종목만 현재가·오늘 등락을 바꾼다", async () => {
    render(<SectorPage />);
    await screen.findByText("정보기술");
    expect((screen.getByLabelText("현재가 실시간 주기") as HTMLSelectElement).value).toBe("10");
    // 표를 그린 커밋의 effect가 구독을 엽니다 — 그 뒤를 기다립니다.
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const last = FakeEventSource.instances.at(-1)!;
    const url = decodeURIComponent(last.url);
    expect(url).toContain("items=US:XLK,US:GLD");
    expect(url).toContain("interval=10");

    await act(async () => {
      last.emit("prices", { available: true, prices: {
        fetchedAt: "2026-11-03T14:40:05Z", missing: ["US:GLD"], errors: {},
        items: { "US:XLK": { market: "US", code: "XLK", price: 252.34, prevClose: 250.1, change: 2.24, changePct: 0.9, currency: "USD",
          tradedAt: "2026-11-03T14:40:01Z", status: "OPEN", source: "네이버", delayMinutes: 0, overPrice: null, overChange: null,
          overChangePct: null, overTradedAt: null, overSession: null } },
      } });
    });
    const xlk = screen.getByText("정보기술").closest("tr")!;
    expect(within(xlk).getByText("252.34")).toBeTruthy();
    expect(within(xlk).getByText("+0.90%")).toBeTruthy();
    expect(within(xlk).getByTitle(/실시간 네이버 · 기준 23:40:01 KST · 정규장/)).toBeTruthy();
    const gld = screen.getByText("금").closest("tr")!;
    expect(within(gld).getByText("370.40")).toBeTruthy();
  });
});
