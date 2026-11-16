/**
 * 섹터(/sector) 화면 — 표의 등락 표시(QA-628).
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

/** 줄 처음·공백·여는 괄호 뒤의 ASCII 하이픈 음수 부호(lib/format withMinusSign이 바꾸는 자리). */
const ASCII_MINUS = /(^|[\s(])-(?=[\d.])/;
const PERIODS = ["1W", "1M", "3M", "6M", "YTD", "1Y"];
const all = (value: number | null) => Object.fromEntries(PERIODS.map((period) => [period, value]));

const sector = (ticker: string, name: string, value: number | null, alpha: number | null, rank: number) => ({
  ticker, name, kind: "공격 / 성장", price: 176.51, returns: all(value), alpha: all(alpha), ranks: { "1M": rank },
  isStale: false, staleReason: null,
});

const rotation = () => ({
  available: true, periods: PERIODS, period: "1M", benchmark: "SPY",
  benchmarkReturns: { "1W": -1.99, "1M": -2.64, "3M": -1.76, "6M": 4.75, YTD: 11.49, "1Y": 11.79 },
  collectedAtKst: "2026-11-04 19:35 KST", ageSeconds: 60, stale: false,
  sectors: [sector("XLK", "정보기술", -12.15, -9.51, 11), sector("XLE", "에너지", 3.2, 5.84, 1)],
  assetClasses: [{ ...sector("GLD", "금", 1.1, null, 3), alpha: undefined }],
});

/** 그 이름의 표 행(tbody tr) — 이름은 막대 이름표·고르기에도 나올 수 있어 표 행 안의 것만 봅니다. */
function rowOf(name: string): HTMLElement {
  const row = screen.getAllByText(name).map((node) => node.closest("tbody tr")).find(Boolean);
  if (!row) throw new Error(`표 행을 찾지 못함: ${name}`);
  return row as HTMLElement;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  window.localStorage.clear();
  window.localStorage.setItem("live.priceRefreshSeconds", "10");
  resetLiveSecondsForTest();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path.startsWith("/api/sector/rotation") ? Promise.resolve(rotation()) : new Promise(() => {}));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  resetLiveSecondsForTest();
});

describe("QA-628 섹터 표의 수익률·α·오늘 등락", () => {
  // 수정 전에는 하락 행의 기간 수익률 여섯 칸('-12.15%' 여섯)·α('-9.51%p')가 하락색과 ASCII '-'뿐이었다(▲▼·−·읽어 주는 '하락' 0개).
  it("기간 수익률 여섯 칸과 α가 ▲▼·−·읽어 주는 방향 글을 갖는다(색만이 아님)", async () => {
    render(<SectorPage />);
    await screen.findAllByText("정보기술");

    const down = rowOf("정보기술");
    // 여섯 기간 + α — 칸마다 sr '하락' 한 번(변화 칩의 읽어 주는 방향 글).
    expect(within(down).getAllByText("하락")).toHaveLength(7);
    expect(within(down).getAllByText("−12.15%").length).toBeGreaterThanOrEqual(6);
    expect(within(down).getByText("−9.51")).toBeTruthy();
    expect(within(down).queryAllByText(ASCII_MINUS).map((node) => node.textContent)).toEqual([]);
    const up = rowOf("에너지");
    expect(within(up).getAllByText("상승")).toHaveLength(7);
  });

  // 수정 전에는 실시간 오늘 등락('-0.90%')이 현재가 아래 하락색 글뿐이었다(읽어 주는 '하락' 0개).
  it("실시간 오늘 등락이 ▲▼·−·읽어 주는 방향 글을 갖는다", async () => {
    render(<SectorPage />);
    await screen.findAllByText("정보기술");
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    await act(async () => {
      FakeEventSource.instances.at(-1)!.emit("prices", { available: true, prices: {
        fetchedAt: "2026-11-03T14:40:05Z", missing: [], errors: {},
        items: { "US:XLE": { market: "US", code: "XLE", price: 90.1, prevClose: 90.92, change: -0.82, changePct: -0.9, currency: "USD",
          tradedAt: "2026-11-03T14:40:01Z", status: "OPEN", source: "네이버", delayMinutes: 0, overPrice: null, overChange: null,
          overChangePct: null, overTradedAt: null, overSession: null } },
      } });
    });

    const up = rowOf("에너지");
    expect(within(up).getByText("90.10")).toBeTruthy();
    // 기간 여섯 + α는 상승, 오늘 등락 하나만 하락.
    expect(within(up).getAllByText("하락")).toHaveLength(1);
    expect(within(up).getByText("−0.90%")).toBeTruthy();
    expect(within(up).queryAllByText(ASCII_MINUS).map((node) => node.textContent)).toEqual([]);
  });
});
