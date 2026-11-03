/**
 * 화면 실시간 시세 훅(useLivePrices·useLiveSeconds, ADR 0024) — 고정하는 규칙
 *  - 주기가 있으면 SSE(/api/live/prices/stream?items=&interval=)에 쿠키와 함께 붙고, 'prices' 이벤트를 받을 때마다 가격을 덮어씀
 *  - 탭을 숨기면 연결을 닫고, 다시 보이면 다시 잇는다(보지 않는 동안 받지 않음) — 언마운트·종목·주기가 바뀌어도 앞 연결을 닫음
 *  - 끄기(0)면 연결하지 않고 한 번만 읽음(GET /api/live/prices), 비었거나 꺼진(enabled=false) 구독은 아무것도 하지 않음
 *  - 받지 못함(available:false·출처만 실패·연결 끊김)은 한 줄 문구, 받은 가격은 남김
 *  - 200이 아닌 응답으로 닫힌 연결(readyState CLOSED)은 닫고 5초부터 두 배씩(최대 60초) 뒤 새로 열고, 받으면 처음부터 — 그동안 disconnected(QA-183)
 *  - 주기 설정은 한 곳에서 바꾸면 같은 화면의 다른 구독도 따라 바뀌고, 이 브라우저에 기억됨(기본 1시간)
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ apiGet: vi.fn(), apiBase: () => "http://backend" }));
vi.mock("@/lib/api", () => api);

import { mergeLivePrices, useLivePrices } from "@/hooks/useLivePrices";
import { resetLiveSecondsForTest, useLiveSeconds } from "@/hooks/useLiveSeconds";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  onerror: (() => void) | null = null;
  /** 0 CONNECTING · 1 OPEN · 2 CLOSED(브라우저가 200이 아닌 응답으로 닫아 다시 잇지 않음) — 시험이 onerror 앞에 바꿉니다. */
  readyState = 0;
  closed = false;
  constructor(readonly url: string, readonly init?: EventSourceInit) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  emit(name: string, body: unknown) {
    (this.listeners.get(name) ?? []).forEach((listener) => listener({ data: JSON.stringify(body) } as MessageEvent<string>));
  }
}

let visibility: DocumentVisibilityState;

async function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
}

const AAPL = { market: "US", code: "AAPL", price: 337.2, prevClose: 344.63, change: -7.43, changePct: -2.16, currency: "USD",
  tradedAt: "2026-11-02T18:43:17Z", status: "OPEN", source: "Yahoo", overPrice: null, overSession: null };

function body(items: Record<string, unknown>, errors: Record<string, string> = {}) {
  return { available: true, prices: { fetchedAt: "2026-11-02T18:43:20Z", items, missing: [], errors } };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  api.apiGet.mockReset();
  window.localStorage.clear();
  resetLiveSecondsForTest();
});

afterEach(() => {
  cleanup();   // 앞 시험의 구독이 visibilitychange를 계속 듣지 않게
  vi.unstubAllGlobals();
});

describe("useLivePrices", () => {
  it("주기가 있으면 SSE에 쿠키와 함께 붙고 'prices' 이벤트마다 가격을 덮어쓴다", () => {
    const { result } = renderHook(() => useLivePrices(["US:AAPL", "KR:005930"], 5));
    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0];
    const url = new URL(source.url);
    expect(url.origin + url.pathname).toBe("http://backend/api/live/prices/stream");
    expect(url.searchParams.get("items")).toBe("US:AAPL,KR:005930");
    expect(url.searchParams.get("interval")).toBe("5");
    expect(source.init).toEqual({ withCredentials: true });

    act(() => source.emit("prices", body({ "US:AAPL": AAPL })));
    expect(result.current.prices["US:AAPL"].price).toBe(337.2);
    expect(result.current.receivedAt).not.toBeNull();
    expect(result.current.error).toBeNull();
    act(() => source.emit("prices", body({ "US:AAPL": { ...AAPL, price: 338 } })));
    expect(result.current.prices["US:AAPL"].price).toBe(338);
  });

  it("탭을 숨기면 닫고 다시 보이면 다시 잇는다 — 언마운트·주기가 바뀌어도 앞 연결을 닫는다", async () => {
    const { rerender, unmount } = renderHook(({ seconds }) => useLivePrices(["US:AAPL"], seconds), { initialProps: { seconds: 5 } });
    const first = FakeEventSource.instances[0];
    await setVisibility("hidden");
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
    await setVisibility("visible");
    expect(FakeEventSource.instances).toHaveLength(2);
    rerender({ seconds: 30 });
    expect(FakeEventSource.instances[1].closed).toBe(true);
    expect(new URL(FakeEventSource.instances[2].url).searchParams.get("interval")).toBe("30");
    unmount();
    expect(FakeEventSource.instances[2].closed).toBe(true);
  });

  it("끄기(0)면 연결하지 않고 한 번만 읽는다 — 빈 목록·꺼진 구독은 아무것도 하지 않는다", async () => {
    api.apiGet.mockResolvedValue(body({ "US:AAPL": AAPL }));
    const { result } = renderHook(() => useLivePrices(["US:AAPL"], 0));
    await act(async () => {});
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(api.apiGet).toHaveBeenCalledTimes(1);
    expect(api.apiGet.mock.calls[0][0]).toBe("/api/live/prices?items=US%3AAAPL");
    expect(result.current.prices["US:AAPL"].source).toBe("Yahoo");

    renderHook(() => useLivePrices([], 5));
    renderHook(() => useLivePrices(["US:AAPL"], 5, false));
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("연결이 끊기면 다시 잇는 중이라고 적고 받은 가격은 남긴다", () => {
    const { result } = renderHook(() => useLivePrices(["US:AAPL"], 5));
    const source = FakeEventSource.instances[0];
    act(() => source.emit("prices", body({ "US:AAPL": AAPL })));
    act(() => source.onerror?.());
    expect(result.current.error).toMatch(/다시 잇는 중/);
    expect(result.current.prices["US:AAPL"].price).toBe(337.2);
  });

  // QA-183: 200이 아닌 응답(배포 중 502·연결 상한 429·401)이면 브라우저가 연결을 닫고(readyState CLOSED) 다시 잇지 않습니다. 화면이 닫고 상한 있는
  // 백오프(5초에서 두 배씩, 최대 60초)로 새로 열고, 받으면 처음(5초)부터. 끊긴 동안 문구는 '끊김 — n초 뒤 다시 연결'(기다리면 될 것 같은 '다시 잇는 중'이 아님).
  it("QA-183 닫힌 연결(readyState CLOSED)은 닫고 5초부터 두 배씩(최대 60초) 뒤 새로 열고, 받으면 처음부터 — 끊긴 동안 '끊김 — n초 뒤 다시 연결'", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useLivePrices(["US:AAPL"], 5));
      const first = FakeEventSource.instances[0];
      act(() => first.emit("prices", body({ "US:AAPL": AAPL })));
      act(() => { first.readyState = 2; first.onerror?.(); });
      expect(first.closed).toBe(true);
      expect(result.current.error).toMatch(/끊김 — 5초 뒤 다시 연결/);
      expect(result.current.disconnected).toBe(true);
      expect(result.current.prices["US:AAPL"].price).toBe(337.2);
      act(() => { vi.advanceTimersByTime(4_999); });
      expect(FakeEventSource.instances).toHaveLength(1);
      act(() => { vi.advanceTimersByTime(1); });
      expect(FakeEventSource.instances).toHaveLength(2);
      expect(FakeEventSource.instances[1].url).toBe(first.url);
      // 또 닫히면 10·20·40초, 그 뒤는 60초에서 멈춤
      for (const wait of [10, 20, 40, 60, 60]) {
        const current = FakeEventSource.instances.at(-1)!;
        act(() => { current.readyState = 2; current.onerror?.(); });
        expect(current.closed).toBe(true);
        expect(result.current.error).toMatch(new RegExp(`끊김 — ${wait}초 뒤 다시 연결`));
        const count = FakeEventSource.instances.length;
        act(() => { vi.advanceTimersByTime(wait * 1000 - 1); });
        expect(FakeEventSource.instances).toHaveLength(count);
        act(() => { vi.advanceTimersByTime(1); });
        expect(FakeEventSource.instances).toHaveLength(count + 1);
      }
      // 받으면 문구를 지우고 백오프를 처음부터
      const last = FakeEventSource.instances.at(-1)!;
      act(() => last.emit("prices", body({ "US:AAPL": { ...AAPL, price: 338 } })));
      expect(result.current.disconnected).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.prices["US:AAPL"].price).toBe(338);
      act(() => { last.readyState = 2; last.onerror?.(); });
      expect(result.current.error).toMatch(/끊김 — 5초 뒤 다시 연결/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("QA-183 대조 — 다시 잇는 중(CONNECTING)이면 브라우저에 맡겨 새로 열지 않고, 닫힌 뒤 탭을 숨기면 기다리던 새로 열기도 하지 않는다", async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useLivePrices(["US:AAPL"], 5));
      const first = FakeEventSource.instances[0];
      act(() => first.onerror?.());
      act(() => { vi.advanceTimersByTime(120_000); });
      expect(FakeEventSource.instances).toHaveLength(1);
      expect(first.closed).toBe(false);

      // 닫힌 뒤 기다리는 동안 탭을 숨기면 열지 않고(보지 않는 동안 받지 않음), 다시 보이면 한 번만 엶
      act(() => { first.readyState = 2; first.onerror?.(); });
      await setVisibility("hidden");
      act(() => { vi.advanceTimersByTime(120_000); });
      expect(FakeEventSource.instances).toHaveLength(1);
      await setVisibility("visible");
      expect(FakeEventSource.instances).toHaveLength(2);
      act(() => { vi.advanceTimersByTime(120_000); });
      expect(FakeEventSource.instances).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mergeLivePrices", () => {
  const start = { prices: { "US:AAPL": AAPL as never }, receivedAt: 1, error: null, disconnected: false };

  it("available:false면 문구만 바꾸고 가격은 남긴다", () => {
    const next = mergeLivePrices(start, { available: false, message: "수집기에서 응답을 받지 못했습니다." }, 2);
    expect(next.error).toBe("수집기에서 응답을 받지 못했습니다.");
    expect(next.prices["US:AAPL"]).toBeDefined();
    expect(next.receivedAt).toBe(1);
  });

  it("가격을 하나도 받지 못하고 출처만 실패했으면 그 사유, 받은 것이 있으면 문구 없음", () => {
    expect(mergeLivePrices(start, body({}, { Yahoo: "거부됨" }) as never, 2).error).toBe("Yahoo: 거부됨");
    expect(mergeLivePrices(start, body({ "US:AAPL": AAPL }, { Yahoo: "거부됨" }) as never, 2).error).toBeNull();
  });
});

describe("useLiveSeconds", () => {
  it("기본 1시간, 한 곳에서 바꾸면 다른 구독도 따라 바뀌고 이 브라우저에 기억된다", () => {
    const a = renderHook(() => useLiveSeconds());
    const b = renderHook(() => useLiveSeconds());
    expect(a.result.current[0]).toBe(3600);
    act(() => a.result.current[1](10));
    expect(b.result.current[0]).toBe(10);
    expect(window.localStorage.getItem("live.priceRefreshSeconds")).toBe("10");
    act(() => a.result.current[1](7));
    expect(b.result.current[0]).toBe(3600);
  });

  it("예전 장중 카드의 분 단위 값을 옮겨 읽는다", () => {
    window.localStorage.setItem("paper.liveRefreshMinutes", "5");
    const { result } = renderHook(() => useLiveSeconds());
    expect(result.current[0]).toBe(300);
  });
});
