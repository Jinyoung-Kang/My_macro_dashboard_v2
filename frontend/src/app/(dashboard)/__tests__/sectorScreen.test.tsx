/**
 * 섹터(/sector) 화면 — 표의 등락 표시(QA-628)와 작업대 배치(SPY KPI 띠·공용 표·검사 대화상자 — P5a).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), apiBase: () => "http://backend", UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
// 막대 차트는 받은 이름만 봅니다(jsdom은 크기가 없어 그림을 그리지 않음).
vi.mock("@/components/charts", () => ({
  HorizontalBars: ({ ariaLabel, data }: { ariaLabel?: string; data: unknown[] }) => (
    <div data-chart="bars" data-name={ariaLabel ?? ""} data-count={data.length} />
  ),
}));

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

describe("섹터 작업대 배치(P5a)", () => {
  it("맨 위 KPI 띠가 S&P 500(SPY) 기간별 수익률 여섯이고 값의 부호가 −, 출처 줄은 첫 타일에만", async () => {
    render(<SectorPage />);
    const strip = await screen.findByRole("region", { name: "S&P 500 (SPY) 기간별 수익률" });
    // 읽는 중 자리표시 띠도 같은 이름이라(값이 오면 같은 띠가 값으로 바뀜) 값이 올 때까지 기다립니다 — 기다리지 않으면 느린 실행에서 자리표시를 봤습니다.
    await within(strip).findByText("−1.99%");

    const tiles = within(strip).getAllByRole("group");
    expect(tiles.map((tile) => tile.getAttribute("aria-label"))).toEqual(PERIODS.map((period) => `S&P 500 (SPY) ${period}`));
    expect(within(tiles[0]).getByText("−1.99%")).toBeTruthy();
    expect(within(tiles[4]).getByText("+11.49%")).toBeTruthy();
    expect(within(tiles[0]).getByText(/Yahoo Finance/)).toBeTruthy();
    expect(within(tiles[1]).queryByText(/Yahoo Finance/)).toBeNull();
  });

  it("처음 읽는 동안 KPI 띠 자리에 여섯 자리표시 타일이 있고(값이 온 뒤 아래가 밀리지 않게), 읽지 못하면 띠가 없다", async () => {
    api.apiGetShared.mockImplementation(() => new Promise(() => {}));
    const { unmount } = render(<SectorPage />);

    const strip = screen.getByRole("region", { name: "S&P 500 (SPY) 기간별 수익률" });
    expect(within(strip).getAllByRole("status")).toHaveLength(6);
    expect(within(strip).getByRole("status", { name: "S&P 500 (SPY) 1W 불러오는 중" })).toBeTruthy();
    unmount();

    api.apiGetShared.mockImplementation(() => Promise.reject(new Error("요청 실패 (HTTP 503)")));
    render(<SectorPage />);
    await screen.findByText(/요청 실패 \(HTTP 503\)/);
    expect(screen.queryByRole("region", { name: /기간별 수익률/ })).toBeNull();
  });

  it("막대 차트 이름이 '섹터 {기간} {수익률|초과성과}'이고 표시 기준을 바꾸면 따라 바뀐다", async () => {
    const { container } = render(<SectorPage />);
    await screen.findAllByText("정보기술");

    const bars = () => container.querySelector<HTMLElement>("[data-chart='bars']")!;
    expect(bars().dataset.name).toBe("섹터 1M 수익률");
    fireEvent.change(screen.getByLabelText("표시 기준"), { target: { value: "alpha" } });
    expect(bars().dataset.name).toBe("섹터 1M 초과성과");
  });

  it("두 표는 이름 있는 공용 표이고 패널 머리에 개수, 이름은 행 머리의 줄 단추, 고른 기간 열에 표시가 그대로", async () => {
    render(<SectorPage />);
    await screen.findAllByText("정보기술");

    const table = screen.getByRole("table", { name: "섹터 상세" });
    expect(screen.getByRole("table", { name: "자산군 상세" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "섹터 상세" }).parentElement?.textContent).toContain("2개");
    const headers = within(table).getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers).toEqual(["순위", "이름", "유형", "현재가", "1W", "1M ▪(순위 기준)", "3M", "6M", "YTD", "1Y", "α (1M)"]);
    // 수익률이 높은 차례(모르는 값은 맨 뒤) — 에너지(3.2%) → 정보기술(−12.15%).
    const rowHeaders = within(table).getAllByRole("rowheader");
    expect(rowHeaders.map((cell) => within(cell).getByRole("button").textContent)).toEqual(["에너지", "정보기술"]);
    const button = within(rowHeaders[1]).getByRole("button", { name: "정보기술" });
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    // 고른 기간(1M) 열 칸의 옅은 바탕.
    const cells = within(rowHeaders[1].closest("tr")!).getAllByRole("cell");
    expect(cells[4].className).toContain("bg-surface-2/50");
    // 자산군 표에는 α 열이 없다.
    expect(within(screen.getByRole("table", { name: "자산군 상세" })).queryByText("α (1M)")).toBeNull();
  });

  it("이름을 누르면 그 종목의 검사 대화상자 — 티커·기간별 수익률(칩)·α·순위와 종목 상세 링크, 닫으면 단추로 포커스가 돌아온다", async () => {
    render(<SectorPage />);
    await screen.findAllByText("정보기술");

    const button = screen.getByRole("button", { name: "정보기술" });
    fireEvent.click(button);

    const dialog = await screen.findByRole("dialog", { name: "정보기술 (XLK)" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const ticker = within(dialog).getByText("XLK");
    expect(ticker.className).toContain("font-mono");
    const oneMonth = within(dialog).getByText("1M 수익률").closest("div")!;
    expect(within(oneMonth).getByText("−12.15%")).toBeTruthy();
    expect(within(oneMonth).getByText("하락")).toBeTruthy();
    const alpha = within(dialog).getByText("α (1M) — S&P 500 대비").closest("div")!;
    expect(within(alpha).getByText("−9.51")).toBeTruthy();
    expect(within(alpha).getByText("%p")).toBeTruthy();
    expect(within(within(dialog).getByText("순위 (1M)").closest("div")!).getByText("11위")).toBeTruthy();
    expect(within(dialog).getByText("저장본 값(실시간 시세 없음)")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "종목 상세 열기" }).getAttribute("href")).toBe("/s/us/XLK");

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(button);
  });

  it("자산군 검사에는 α 줄이 없고, 이어받은 행은 '이전 값' 배지와 사유가 함께 보인다", async () => {
    const body = { ...rotation(), assetClasses: [{ ...rotation().assetClasses[0], isStale: true, staleReason: "HTTP 429" }] };
    api.apiGetShared.mockImplementation((path: string) =>
      path.startsWith("/api/sector/rotation") ? Promise.resolve(body) : new Promise(() => {}));
    render(<SectorPage />);
    await screen.findAllByText("금");

    fireEvent.click(screen.getByRole("button", { name: "금" }));
    const dialog = await screen.findByRole("dialog", { name: "금 (GLD)" });

    expect(within(dialog).queryByText(/^α/)).toBeNull();
    const stale = within(dialog).getByText("이전 값").parentElement!;
    expect(stale.textContent).toContain("HTTP 429");
    expect(within(stale.closest("div")!).getByText("수집")).toBeTruthy();
  });
});

// QA-649: 순위 기준 열을 알리는 것이 머리 글 뒤의 장식 기호 '▪'와 옅은 바탕(bg-surface-2/50)뿐이었습니다(개편 전부터). 낭독기에는 머리가 '1M ▪'로 읽히거나
// 기호가 빠져 이 열이 순위 기준이라는 뜻이 글로 전해지지 않고, 고대비(forced-colors)에서는 바탕이 지워집니다(P5a 검토). 부제의 '순위는 위에서 고른 1M 기준'은
// 표 머리와 이어져 있지 않습니다.
describe("QA-649 순위 기준 열은 글로도 알린다", () => {
  it("고른 기간 열 머리의 접근 이름이 '1M (순위 기준)' — 기호 '▪'는 읽기에서 빠지고 보이는 글은 그대로", async () => {
    render(<SectorPage />);
    await screen.findAllByText("정보기술");
    const table = screen.getByRole("table", { name: "섹터 상세" });
    const header = within(table).getByRole("columnheader", { name: "1M (순위 기준)" });
    expect(within(header).getByText("▪", { exact: false }).getAttribute("aria-hidden")).toBe("true");
    expect(within(table).getByRole("columnheader", { name: "3M" })).toBeTruthy();
  });
});
