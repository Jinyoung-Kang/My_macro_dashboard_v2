/**
 * 매크로 카드의 실시간 값(ADR 0024 2단계) — 화면에서 고정하는 것
 *  - 자동 갱신 간격으로 실시간 시세 SSE에 붙는다(카드의 종목만, 간격 = 고른 값). 받은 값이 카드 숫자·출처·시각을 덮는다
 *  - 실시간이 없는 카드는 저장본 그대로, 받지 못하면 그 사실을 한 줄로 적고 카드는 저장본
 *  - 마지막 응답에서 빠진 종목·받지 못한 응답·닫힌 연결의 카드는 저장본, 일부만 받아도 출처별 사유 한 줄(QA-184)
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), apiBase: () => "http://backend", UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import MacroPage from "../macro/page";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  onerror: (() => void) | null = null;
  /** 2면 CLOSED(200이 아닌 응답으로 닫힘 — QA-183) */
  readyState = 0;
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

const card = (over: Record<string, unknown>) => ({
  status: "ok", deltaStr: "+0.00 (+0.00%)", prevStr: "1.00", delta: 0, delayMinutes: 0, ...over,
});

const OVERVIEW = {
  available: true,
  collectedAtKst: "2026-11-03 06:30 KST",
  categories: [
    { id: "fx", title: "환율", items: [
      card({ key: "dxy", name: "달러 인덱스", priceStr: "101.77", source: "TradingView (TVC:DXY)", lastTs: "2026-11-03 06:30 KST" }),
      card({ key: "vix", name: "변동성", priceStr: "18.20", source: "Yahoo Finance (^VIX)", lastTs: "2026-11-03 06:30 KST" }),
    ] },
  ],
};

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  window.localStorage.clear();
  window.localStorage.setItem("macro.autoRefreshSeconds", "5");
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path.startsWith("/api/macro/overview") ? Promise.resolve(OVERVIEW) : new Promise(() => {}));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("매크로 카드 실시간 값", () => {
  it("고른 간격(5초)으로 카드 종목만 구독하고, 받은 값이 카드 숫자·출처·시각을 덮는다 — 실시간이 없는 카드는 그대로", async () => {
    render(<MacroPage />);
    expect(await screen.findByText("101.77")).toBeTruthy();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const url = decodeURIComponent(FakeEventSource.instances[0].url);
    expect(url).toContain("items=TV:TVC:DXY");
    expect(url).toContain("interval=5");

    await act(async () => {
      FakeEventSource.instances[0].emit("prices", { available: true, prices: {
        fetchedAt: "2026-11-02T21:40:05Z", missing: [], errors: {},
        items: { "TV:TVC:DXY": { market: "TV", code: "TVC:DXY", price: 101.812, prevClose: 101.964, change: -0.152, changePct: -0.149,
          currency: null, tradedAt: null, status: "OPEN", source: "TradingView", delayMinutes: 0, overPrice: null, overChange: null,
          overChangePct: null, overTradedAt: null, overSession: null } },
      } });
    });
    expect(screen.getByText("101.81")).toBeTruthy();
    expect(screen.queryByText("101.77")).toBeNull();
    expect(screen.getAllByText(/실시간 TradingView \(TVC:DXY\)/).length).toBeGreaterThan(0);
    expect(screen.getByText(/실시간 \d{2}:\d{2}:\d{2} 수신/)).toBeTruthy();
    expect(screen.getByText("18.20")).toBeTruthy();
  });

  it("받지 못하면 그 사실을 한 줄로 적고 카드는 저장본 값", async () => {
    render(<MacroPage />);
    await screen.findByText("101.77");
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await act(async () => {
      FakeEventSource.instances[0].emit("prices", { available: false, message: "수집기에서 응답을 받지 못했습니다." });
    });
    expect(screen.getByText(/실시간 시세: 수집기에서 응답을 받지 못했습니다\. — 카드는 저장본 값입니다\./)).toBeTruthy();
    expect(screen.getByText("101.77")).toBeTruthy();
  });

  // QA-184: 훅이 앞 값 위에 받은 것만 덮고(빠진 종목의 값은 남김) 받은 시각은 이벤트마다 하나(지금)라, TradingView만 실패한 이벤트 뒤에도 달러 인덱스
  // 카드가 옛 가격을 '방금 받은 실시간'으로 그렸고, 네이버 지수를 받았으면 사유 줄도 없었습니다. 이번 응답에서 빠진 종목은 저장본으로 돌아가고, 일부만
  // 받아도 출처별 사유를 한 줄로 적습니다. 받지 못한 응답(available:false)·닫힌 연결(QA-183)이면 모든 카드가 저장본입니다.
  it("QA-184 이번 응답에서 빠진 종목의 카드는 저장본으로 돌아가고 출처별 사유를 한 줄로 — 받지 못한 응답·닫힌 연결이면 모든 카드가 저장본", async () => {
    const overview = { ...OVERVIEW, categories: [{ id: "idx", title: "지수", items: [
      card({ key: "dxy", name: "달러 인덱스", priceStr: "101.77", source: "TradingView (TVC:DXY)", lastTs: "2026-11-03 06:30 KST" }),
      card({ key: "sp500", name: "S&P 500", priceStr: "6,800.00", source: "Yahoo Finance (^GSPC)", lastTs: "2026-11-03 06:00 KST" }),
    ] }] };
    api.apiGetShared.mockImplementation((path: string) =>
      path.startsWith("/api/macro/overview") ? Promise.resolve(overview) : new Promise(() => {}));
    const none = { currency: null, overPrice: null, overChange: null, overChangePct: null, overTradedAt: null, overSession: null };
    const dxy = { market: "TV", code: "TVC:DXY", price: 101.812, prevClose: 101.964, change: -0.152, changePct: -0.149, tradedAt: null,
      status: "OPEN", source: "TradingView", delayMinutes: 0, ...none };
    const inx = (price: number) => ({ market: "NI", code: ".INX", price, prevClose: 6790.1, change: price - 6790.1, changePct: null,
      tradedAt: "2026-11-02T21:40:00Z", status: "OPEN", source: "네이버", delayMinutes: 0, ...none });
    const event = (items: Record<string, unknown>, missing: string[] = [], errors: Record<string, string> = {}) =>
      ({ available: true, prices: { fetchedAt: "2026-11-02T21:40:05Z", items, missing, errors } });

    render(<MacroPage />);
    await screen.findByText("101.77");
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    await act(async () => source.emit("prices", event({ "TV:TVC:DXY": dxy, "NI:.INX": inx(6812.5) })));
    expect(screen.getByText("101.81")).toBeTruthy();
    expect(screen.getByText("6,812.50")).toBeTruthy();

    // TradingView만 실패 — 달러 인덱스는 저장본, 지수는 새 값, 사유 한 줄
    await act(async () => source.emit("prices", event({ "NI:.INX": inx(6815.25) }, ["TV:TVC:DXY"], { TradingView: "HTTP 429" })));
    expect(screen.getByText("101.77")).toBeTruthy();
    expect(screen.queryByText("101.81")).toBeNull();
    expect(screen.getByText("6,815.25")).toBeTruthy();
    expect(screen.getByText(/실시간 시세: TradingView: HTTP 429/)).toBeTruthy();

    // 받지 못한 응답 — 모든 카드가 저장본
    await act(async () => source.emit("prices", { available: false, message: "수집기에서 응답을 받지 못했습니다." }));
    expect(screen.getByText("6,800.00")).toBeTruthy();
    expect(screen.queryByText("6,815.25")).toBeNull();
    expect(screen.getByText(/실시간 시세: 수집기에서 응답을 받지 못했습니다\. — 카드는 저장본 값입니다\./)).toBeTruthy();

    // 다시 받으면 덮고, 연결이 닫히면(200이 아닌 응답) 다시 저장본
    await act(async () => source.emit("prices", event({ "TV:TVC:DXY": dxy, "NI:.INX": inx(6812.5) })));
    expect(screen.getByText("101.81")).toBeTruthy();
    await act(async () => { source.readyState = 2; source.onerror?.(); });
    expect(screen.getByText("101.77")).toBeTruthy();
    expect(screen.getByText("6,800.00")).toBeTruthy();
    expect(screen.getByText(/실시간 시세: .*끊김.* — 카드는 저장본 값입니다\./)).toBeTruthy();
  });
});
