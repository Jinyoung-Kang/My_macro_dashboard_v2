/**
 * 13F 포트폴리오 '보유 종목 상세' 표의 종목 이름 → 종목 팝업 창(사용자 요청·결정 2026-11-18). 응답은 모두 합성 값입니다.
 *  - 티커 있는 줄: 이름 단추가 기존 종목 팝업(StockQuickView)을 열고 시세는 us/티커로 읽는다(종목 찾기를 부르지 않음)
 *  - 티커 없는 줄: 같은 창에서 공시 이름으로 찾은 후보(GET /api/detail/symbols)를 보이고 자동으로 고르지 않는다 — 고르면 같은 창에 시세 본문,
 *    '후보 다시 고르기'로 되돌아감, 실시간 시세는 본문이 보이는 동안만
 *  - 수집기 티커가 같은 회사의 다른 클래스일 수 있는 줄(tickerIsProxy — BRK CL A의 BRK-B)은 그 티커를 바로 열지 않고 후보 고르기, 까닭을 경고
 *  - 수집기가 일부러 티커를 뺀 줄(채권·보통주 아닌 증권)은 경고 줄 — 경고는 입력칸·'후보 다시 고르기'의 설명으로도 읽힌다
 *  - 후보 상태: 맞는 후보 없음·종목 찾기를 쓸 수 없음(available:false)·읽기 실패·출처 실패는 각각 그 사실, 다시 시도 — 다시 찾는 동안·다시 찾기
 *    실패도 보이고, 결과는 라이브 영역(role=status)으로 알린다
 *  - 검색어는 공시 이름을 40자 안에서 낱말 경계로 자른 것이고 고칠 수 있다 — 고친 검색어로 찾은 후보면 안내가 그 검색어를 적는다
 *  - 후보 고르기 창은 위쪽에 붙여 그린다(내용 높이가 바뀌어도 입력칸이 움직이지 않게)
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
// jsdom에서는 차트를 재지 못해 그림은 빼고 이름만 둡니다.
vi.mock("@/components/charts", () => ({
  LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} />,
  MultiLineSeries: () => null,
  WeightHeatmap: () => null,
}));

import { StockPickQuickView } from "@/components/screens/detail/StockPickQuickView";
import { resetLiveSecondsForTest } from "@/hooks/useLiveSeconds";
import { endpoints } from "@/lib/endpoints";
import type { DetailQuote, DetailSymbol, Holding, PortfolioResponse } from "@/lib/types";
import InstitutionsPage from "../institutions/page";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener() {}
  close() {
    this.closed = true;
  }
}

const CIK = "0001067983";
let reads: Record<string, unknown> = {};
const requested = () => api.apiGetShared.mock.calls.map(([path]) => path as string);
const quoteRequests = () => requested().filter((path) => path.startsWith("/api/detail/quote"));
const symbolRequests = () => requested().filter((path) => path.startsWith("/api/detail/symbols"));

function quote(code: string, name: string, kind = "EQUITY"): DetailQuote {
  return {
    market: "us", code, yahooSymbol: code, name, exchange: "NYSEArca", currency: "USD", kind,
    price: 101.5, previousClose: 100, change: 1.5, changePct: 1.5, asOf: "2026-11-17T21:00:00+00:00", marketState: "CLOSED",
    stats: [], profile: null, consensus: null, research: [], source: { label: "합성 출처", url: "https://quote.example/x" }, error: null,
    fetchedAt: "2026-11-18T00:00:00+00:00",
  };
}

function symbol(code: string, name: string, overrides: Partial<DetailSymbol> = {}): DetailSymbol {
  return { market: "us", code, yahooSymbol: code, name, exchange: "NYSEArca", kind: "ETF", source: "Yahoo Finance", ...overrides };
}

function row(overrides: Partial<Holding>): Holding {
  return {
    name: "SYNTHETIC CO", cusip: "000000000", class: "COM", value: 100, shares: 10, weight: 10, weightDiff: null, sharesDiff: null,
    action: "비교 데이터 없음", ...overrides,
  };
}

function portfolio(holdings: Holding[]): PortfolioResponse {
  return {
    available: true, cik: CIK,
    quarters: [{ filingDate: "2026-08-14", reportDate: "2026-06-30", totalValue: 1000, holdingCount: holdings.length }],
    latest: { reportDate: "2026-06-30", filingDate: "2026-08-14", totalValue: 1000 },
    holdings,
  };
}

const HOLDINGS: Holding[] = [
  row({ name: "BERKSHIRE HATHAWAY INC DEL", cusip: "084670702", class: "CL B NEW", value: 500, ticker: "BRK-B", tickerNote: null, tickerIsProxy: false }),
  row({ name: "ISHARES TR", cusip: "464287200", class: "CORE S&P500 ETF", value: 300, ticker: null, tickerNote: null }),
  row({ name: "FICTIONAL MOTOR CO", cusip: "999999ZZ1", class: "NOTE 2.500% 3/1", value: 200, shares: null, ticker: null, tickerNote: "debt" }),
  row({ name: "FICTIONAL BANK CORP", cusip: "999998804", class: "PERP PFD CNV A", value: 100, ticker: null, tickerNote: "non_common" }),
];

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  window.localStorage.clear();
  window.localStorage.setItem("live.priceRefreshSeconds", "10");
  resetLiveSecondsForTest();
  reads = {
    [endpoints.institution.institutions]: { institutions: [{ key: "brk", name: "버크셔 해서웨이", cik: CIK, desc: "" }] },
    [endpoints.institution.portfolio(CIK, "8", "30")]: portfolio(HOLDINGS),
  };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (!(path in reads)) return new Promise(() => {});
    const body = reads[path];
    if (typeof body === "function") return (body as () => Promise<unknown>)();
    return body instanceof Error ? Promise.reject(body) : Promise.resolve(body);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  resetLiveSecondsForTest();
});

describe("13F 보유 표의 종목 이름 → 종목 팝업", () => {
  it("티커 있는 줄은 기존 종목 팝업을 열고 시세를 us/티커로 읽는다 — 종목 찾기는 부르지 않고, CUSIP·클래스 보조 줄은 그대로", async () => {
    reads[endpoints.detail.quote("us", "BRK-B")] = { available: true, quote: quote("BRK-B", "Berkshire Hathaway Inc.") };
    render(<InstitutionsPage />);

    const name = await screen.findByRole("button", { name: "BERKSHIRE HATHAWAY INC DEL 시세 창 열기" });
    expect(name.getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.getByText("CUSIP 084670702 · CL B NEW")).toBeTruthy();
    expect(quoteRequests()).toEqual([]);

    fireEvent.click(name);
    const dialog = await screen.findByRole("dialog", { name: "BRK-B" });
    expect(await within(dialog).findByText("Berkshire Hathaway Inc.")).toBeTruthy();
    expect(quoteRequests()).toEqual([endpoints.detail.quote("us", "BRK-B")]);
    expect(within(dialog).getByRole("link", { name: "상세 화면 열기" }).getAttribute("href")).toBe("/s/us/BRK-B");
    expect(symbolRequests()).toEqual([]);
  });

  it("티커 없는 줄은 공시 이름으로 찾은 후보를 보이고 고르기 전에는 시세를 읽지 않는다 — 고르면 같은 창에 시세, '후보 다시 고르기'로 되돌아감", async () => {
    reads[endpoints.detail.symbols("ISHARES TR")] = {
      available: true,
      symbols: { items: [symbol("IVV", "iShares Core S&P 500 ETF"), symbol("ITOT", "iShares Core S&P Total U.S. Stock Market ETF")], errors: {}, error: null },
    };
    reads[endpoints.detail.quote("us", "IVV")] = { available: true, quote: quote("IVV", "iShares Core S&P 500 ETF", "ETF") };
    reads[endpoints.detail.quote("us", "ITOT")] = { available: true, quote: quote("ITOT", "iShares Core S&P Total U.S. Stock Market ETF", "ETF") };
    render(<InstitutionsPage />);

    const name = await screen.findByRole("button", { name: "ISHARES TR 종목 후보 창 열기" });
    expect(name.getAttribute("aria-haspopup")).toBe("dialog");
    expect(symbolRequests()).toEqual([]);   // 열기 전에는 찾지 않음

    fireEvent.click(name);
    const dialog = await screen.findByRole("dialog", { name: "ISHARES TR" });
    expect(within(dialog).getByText("CUSIP 464287200 · CORE S&P500 ETF")).toBeTruthy();
    expect(within(dialog).getByText(/13F 공시에는 티커가 없어 공시 이름으로 찾은 후보입니다 — 맞는 종목을 고르세요\. 자동으로 고르지 않습니다\./)).toBeTruthy();
    expect((within(dialog).getByRole("textbox", { name: /검색어/ }) as HTMLInputElement).value).toBe("ISHARES TR");

    const list = await within(dialog).findByRole("list", { name: /종목 후보 2건/ });
    const ivv = within(list).getByRole("button", { name: "iShares Core S&P 500 ETF IVV · NYSEArca · ETF · Yahoo Finance 시세 보기" });
    expect(within(list).getAllByRole("button")).toHaveLength(2);
    expect(symbolRequests()).toEqual([endpoints.detail.symbols("ISHARES TR")]);
    expect(quoteRequests()).toEqual([]);   // 첫 후보를 자동으로 고르지 않음
    expect(FakeEventSource.instances).toHaveLength(0);

    fireEvent.click(ivv);
    expect(await within(dialog).findByText("iShares Core S&P 500 ETF", { selector: "p" })).toBeTruthy();
    expect(quoteRequests()).toEqual([endpoints.detail.quote("us", "IVV")]);
    expect(within(dialog).getByText("찾은 후보에서 고른 종목입니다 — 이 13F 보유와 같은 증권인지 확인하세요.")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "상세 화면 열기" }).getAttribute("href")).toBe("/s/us/IVV");
    expect(within(dialog).queryByRole("list", { name: /종목 후보/ })).toBeNull();
    const back = within(dialog).getByRole("button", { name: "후보 다시 고르기" });
    expect(document.activeElement).toBe(back);
    // 실시간 시세는 본문이 보이는 동안만
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(decodeURIComponent(FakeEventSource.instances[0].url)).toContain("US:IVV");

    fireEvent.click(back);
    const again = within(dialog).getByRole("list", { name: /종목 후보 2건/ });
    expect(FakeEventSource.instances[0].closed).toBe(true);
    expect(document.activeElement).toBe(within(again).getByRole("button", { name: /^iShares Core S&P 500 ETF IVV/ }));
    expect(symbolRequests()).toHaveLength(1);   // 되돌아와도 다시 찾지 않음

    // 다시 고른 뒤 창을 닫으면 실시간 연결도 닫힘
    fireEvent.click(within(again).getByRole("button", { name: /^iShares Core S&P Total/ }));
    await waitFor(() => expect(quoteRequests()).toContain(endpoints.detail.quote("us", "ITOT")));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    fireEvent.click(within(dialog).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(FakeEventSource.instances[1].closed).toBe(true);
  });

  it("후보가 하나뿐이어도 자동으로 고르지 않는다", async () => {
    reads[endpoints.detail.symbols("ISHARES TR")] = { available: true, symbols: { items: [symbol("IVV", "iShares Core S&P 500 ETF")], errors: {}, error: null } };
    render(<InstitutionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "ISHARES TR 종목 후보 창 열기" }));
    const dialog = await screen.findByRole("dialog", { name: "ISHARES TR" });
    await within(dialog).findByRole("list", { name: /종목 후보 1건/ });
    expect(quoteRequests()).toEqual([]);
    expect(within(dialog).queryByRole("button", { name: "후보 다시 고르기" })).toBeNull();
  });

  it("수집기 티커가 같은 회사의 다른 클래스일 수 있는 줄(tickerIsProxy)은 그 시세를 바로 열지 않고 후보 고르기 — 까닭을 경고한다", async () => {
    reads[endpoints.institution.portfolio(CIK, "8", "30")] = portfolio([
      row({ name: "BERKSHIRE HATHAWAY INC DEL", cusip: "084670108", class: "CL A", value: 7000, shares: 10, ticker: "BRK-B", tickerNote: null, tickerIsProxy: true }),
      row({ name: "ALPHABET INC", cusip: "02079K107", class: "CAP STK CL C", value: 3000, ticker: "GOOGL", tickerNote: null, tickerIsProxy: true }),
    ]);
    reads[endpoints.detail.symbols("BERKSHIRE HATHAWAY INC DEL")] = {
      available: true,
      symbols: { items: [symbol("BRK-A", "Berkshire Hathaway Inc.", { kind: "EQUITY", exchange: "NYSE" }), symbol("BRK-B", "Berkshire Hathaway Inc. New", { kind: "EQUITY", exchange: "NYSE" })], errors: {}, error: null },
    };
    reads[endpoints.detail.quote("us", "BRK-A")] = { available: true, quote: quote("BRK-A", "Berkshire Hathaway Inc.") };
    render(<InstitutionsPage />);

    expect(await screen.findByRole("button", { name: "ALPHABET INC 종목 후보 창 열기" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "BERKSHIRE HATHAWAY INC DEL 종목 후보 창 열기" }));
    const dialog = await screen.findByRole("dialog", { name: "BERKSHIRE HATHAWAY INC DEL" });
    const warning =
      "수집기 이름 매핑표가 붙인 티커(BRK-B)는 회사 단위(클래스를 합침)라 이 줄의 클래스(CL A)와 같은 증권인지 확인되지 않아 바로 열지 않습니다 — 클래스가 다르면 주가도 다릅니다. 아래 후보에서 이 줄의 클래스를 고르세요.";
    expect(within(dialog).getByText(warning)).toBeTruthy();
    const list = await within(dialog).findByRole("list", { name: /종목 후보 2건/ });
    expect(quoteRequests()).toEqual([]);   // 수집기 티커(BRK-B)도, 첫 후보도 자동으로 열지 않음
    expect(symbolRequests()).toEqual([endpoints.detail.symbols("BERKSHIRE HATHAWAY INC DEL")]);

    fireEvent.click(within(list).getByRole("button", { name: /^Berkshire Hathaway Inc\. BRK-A/ }));
    await waitFor(() => expect(quoteRequests()).toEqual([endpoints.detail.quote("us", "BRK-A")]));
    expect(within(dialog).getByText(warning)).toBeTruthy();
  });

  it("경고는 입력칸과 '후보 다시 고르기' 단추의 설명으로 이어진다 — 포커스가 가는 곳에서 함께 읽힘", async () => {
    reads[endpoints.detail.symbols("FICTIONAL MOTOR CO")] = { available: true, symbols: { items: [symbol("FMCX", "Fictional Motor Company", { kind: "EQUITY", exchange: "NYSE" })], errors: {}, error: null } };
    reads[endpoints.detail.quote("us", "FMCX")] = { available: true, quote: quote("FMCX", "Fictional Motor Company") };
    render(<InstitutionsPage />);
    const describedText = (element: Element) =>
      (element.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean).map((id) => document.getElementById(id)?.textContent).join(" ");
    const debt = "이 줄은 채권(사채·전환사채 등)이라 아래 종목의 주가와 값이 다릅니다.";

    fireEvent.click(await screen.findByRole("button", { name: "FICTIONAL MOTOR CO 종목 후보 창 열기" }));
    const dialog = await screen.findByRole("dialog", { name: "FICTIONAL MOTOR CO" });
    const input = within(dialog).getByRole("textbox", { name: /검색어/ });
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(describedText(input)).toBe(debt);

    fireEvent.click(await within(dialog).findByRole("button", { name: /^Fictional Motor Company FMCX/ }));
    const back = await within(dialog).findByRole("button", { name: "후보 다시 고르기" });
    expect(document.activeElement).toBe(back);
    expect(describedText(back)).toBe(debt);
  });

  it("채권 줄과 보통주 아닌 증권 줄은 고른 종목의 주가와 값이 다르다고 경고한다 — 후보 목록과 시세 본문 모두에서", async () => {
    reads[endpoints.detail.symbols("FICTIONAL MOTOR CO")] = { available: true, symbols: { items: [symbol("FMCX", "Fictional Motor Company", { kind: "EQUITY", exchange: "NYSE" })], errors: {}, error: null } };
    reads[endpoints.detail.quote("us", "FMCX")] = { available: true, quote: quote("FMCX", "Fictional Motor Company") };
    render(<InstitutionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "FICTIONAL MOTOR CO 종목 후보 창 열기" }));
    let dialog = await screen.findByRole("dialog", { name: "FICTIONAL MOTOR CO" });
    const debt = "이 줄은 채권(사채·전환사채 등)이라 아래 종목의 주가와 값이 다릅니다.";
    expect(within(dialog).getByText(debt)).toBeTruthy();
    expect(within(dialog).getByText("주의:")).toBeTruthy();
    fireEvent.click(await within(dialog).findByRole("button", { name: /^Fictional Motor Company FMCX/ }));
    await within(dialog).findByRole("button", { name: "후보 다시 고르기" });
    expect(within(dialog).getByText(debt)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "FICTIONAL BANK CORP 종목 후보 창 열기" }));
    dialog = await screen.findByRole("dialog", { name: "FICTIONAL BANK CORP" });
    expect(within(dialog).getByText("이 줄은 보통주가 아닌 증권(우선주·워런트 등)이라 아래 종목(보통주)의 주가와 값이 다릅니다.")).toBeTruthy();

    // 티커 없는 보통 줄(ISHARES TR)에는 경고가 없음
    fireEvent.click(within(dialog).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "ISHARES TR 종목 후보 창 열기" }));
    dialog = await screen.findByRole("dialog", { name: "ISHARES TR" });
    expect(within(dialog).queryByText(/주의:/)).toBeNull();
  });

  it("티커가 없는 예전 응답(ticker 칸 없음)도 후보 창으로 연다", async () => {
    const legacy = { ...HOLDINGS[0] } as Partial<Holding>;
    delete legacy.ticker;
    delete legacy.tickerNote;
    reads[endpoints.institution.portfolio(CIK, "8", "30")] = portfolio([legacy as Holding]);
    render(<InstitutionsPage />);
    expect(await screen.findByRole("button", { name: "BERKSHIRE HATHAWAY INC DEL 종목 후보 창 열기" })).toBeTruthy();
  });
});

describe("후보 고르기 창의 상태와 검색어", () => {
  const trigger = <button type="button">후보 열기</button>;
  const open = async (name = "ISHARES TR", tickerNote: string | null = null) => {
    render(<StockPickQuickView name={name} cusip="464287200" cls="CORE S&P500 ETF" tickerNote={tickerNote} trigger={trigger} />);
    fireEvent.click(screen.getByRole("button", { name: "후보 열기" }));
    return screen.findByRole("dialog");
  };

  it("닫혀 있으면 찾지 않는다", () => {
    render(<StockPickQuickView name="ISHARES TR" trigger={trigger} />);
    expect(symbolRequests()).toEqual([]);
  });

  it("창은 위쪽에 붙여 그린다 — 후보 수·시세 본문으로 높이가 바뀌어도 입력칸이 오르내리지 않게(가운데 배치 아님)", async () => {
    const dialog = await open();
    expect(dialog.className).toContain("top-4");
    expect(dialog.className).not.toContain("-translate-y-1/2");
  });

  it("찾은 결과를 라이브 영역(role=status)으로 알린다 — 후보 N건·맞는 후보 없음", async () => {
    reads[endpoints.detail.symbols("ISHARES TR")] = { available: true, symbols: { items: [], errors: {}, error: null } };
    reads[endpoints.detail.symbols("ISHARES CORE")] = {
      available: true, symbols: { items: [symbol("IVV", "iShares Core S&P 500 ETF"), symbol("ITOT", "iShares Core Total")], errors: {}, error: null },
    };
    const dialog = await open();
    const status = () => within(dialog).getAllByRole("status").map((node) => node.textContent ?? "");
    await waitFor(() => expect(status()).toContain("‘ISHARES TR’에 맞는 종목 후보가 없습니다"));

    fireEvent.change(within(dialog).getByRole("textbox", { name: /검색어/ }), { target: { value: "ISHARES CORE" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "찾기" }));
    await waitFor(() => expect(status()).toContain("종목 후보 2건"));
  });

  it("다시 찾는 동안 '다시 찾는 중'을 보이고, 다시 찾기가 실패하면 앞의 결과와 함께 그 사유를 적는다", async () => {
    reads[endpoints.detail.symbols("ISHARES TR")] = { available: false, message: "수집기 점검 중입니다." };
    const dialog = await open();
    const unavailable = "종목 찾기를 쓸 수 없습니다 — 수집기 점검 중입니다.";
    expect(await within(dialog).findByText(unavailable)).toBeTruthy();

    let fail: (error: Error) => void = () => {};
    reads[endpoints.detail.symbols("ISHARES TR")] = () => new Promise((_, reject) => { fail = reject; });
    fireEvent.click(within(dialog).getByRole("button", { name: "다시 시도" }));
    expect(await within(dialog).findByText("다시 찾는 중…")).toBeTruthy();
    expect(within(dialog).getAllByRole("status").map((node) => node.textContent)).toContain("후보를 다시 찾는 중");
    expect(within(dialog).getByText(unavailable)).toBeTruthy();

    await act(async () => fail(new Error("연결 실패")));
    expect(await within(dialog).findByText("다시 찾지 못했습니다 — 연결 실패. 아래는 앞서 찾은 결과입니다.")).toBeTruthy();
    expect(within(dialog).getByText(unavailable)).toBeTruthy();
    expect(within(dialog).queryByText("다시 찾는 중…")).toBeNull();
    expect(within(dialog).getAllByRole("status").map((node) => node.textContent)).toContain(
      "다시 찾지 못했습니다 — 연결 실패. 앞서 찾은 결과: 종목 찾기를 쓸 수 없습니다",
    );
    expect(symbolRequests()).toHaveLength(2);
  });

  it("맞는 후보가 없으면 그렇게 적고 지어내지 않는다", async () => {
    reads[endpoints.detail.symbols("ISHARES TR")] = { available: true, symbols: { items: [], errors: {}, error: null } };
    const dialog = await open();
    expect(await within(dialog).findByText("‘ISHARES TR’에 맞는 종목 후보가 없습니다 — 검색어를 줄이거나 고쳐 다시 찾아 보세요.")).toBeTruthy();
    expect(within(dialog).queryByRole("list")).toBeNull();
  });

  it("종목 찾기를 쓸 수 없으면(available:false) 그 사유와 다시 시도", async () => {
    reads[endpoints.detail.symbols("ISHARES TR")] = { available: false, message: "store_only 모드에서는 외부 정보(시세·뉴스)를 조회하지 않습니다." };
    const dialog = await open();
    expect(await within(dialog).findByText("종목 찾기를 쓸 수 없습니다 — store_only 모드에서는 외부 정보(시세·뉴스)를 조회하지 않습니다.")).toBeTruthy();
    reads[endpoints.detail.symbols("ISHARES TR")] = { available: true, symbols: { items: [symbol("IVV", "iShares Core S&P 500 ETF")], errors: {}, error: null } };
    fireEvent.click(within(dialog).getByRole("button", { name: "다시 시도" }));
    expect(await within(dialog).findByRole("list", { name: /종목 후보 1건/ })).toBeTruthy();
    expect(symbolRequests()).toHaveLength(2);
  });

  it("읽기에 실패하면 오류와 다시 시도 — 다시 시도로 후보가 오면 목록", async () => {
    reads[endpoints.detail.symbols("ISHARES TR")] = new Error("요청 시간이 지났습니다");
    const dialog = await open();
    // 오류 상자(span)와 라이브 영역(status) 둘 다 같은 글
    expect(await within(dialog).findByText("후보를 불러오지 못했습니다 — 요청 시간이 지났습니다", { selector: "span" })).toBeTruthy();
    expect(within(dialog).getAllByRole("status").map((node) => node.textContent)).toContain("후보를 불러오지 못했습니다 — 요청 시간이 지났습니다");
    reads[endpoints.detail.symbols("ISHARES TR")] = { available: true, symbols: { items: [symbol("IVV", "iShares Core S&P 500 ETF")], errors: {}, error: null } };
    fireEvent.click(within(dialog).getByRole("button", { name: "다시 시도" }));
    expect(await within(dialog).findByRole("list", { name: /종목 후보 1건/ })).toBeTruthy();
  });

  it("출처를 받지 못해 0건이면 '없다'고 단정하지 않고, 일부만 받지 못했으면 받은 후보와 함께 적는다", async () => {
    reads[endpoints.detail.symbols("ISHARES TR")] = {
      available: true, symbols: { items: [], errors: { "Yahoo Finance": "HTTP 429(요청 제한)" }, error: "HTTP 429(요청 제한)" },
    };
    const dialog = await open();
    expect(await within(dialog).findByText("출처를 받지 못해 후보를 보이지 못했습니다(Yahoo Finance) — 맞는 종목이 없다는 뜻은 아닙니다.")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "다시 시도" })).toBeTruthy();

    reads[endpoints.detail.symbols("ISHARES TR")] = {
      available: true, symbols: { items: [symbol("IVV", "iShares Core S&P 500 ETF")], errors: { "네이버 증권": "HTTP 503" }, error: null },
    };
    fireEvent.click(within(dialog).getByRole("button", { name: "다시 시도" }));
    await within(dialog).findByRole("list", { name: /종목 후보 1건/ });
    expect(within(dialog).getByText("일부 출처를 받지 못했습니다(네이버 증권) — 후보가 더 있을 수 있습니다.")).toBeTruthy();
  });

  it("검색어는 공시 이름을 40자 안에서 낱말 경계로 자르고, 고쳐서 다시 찾을 수 있다", async () => {
    const longName = "FICTIONAL UNIVERSAL INTERNATIONAL HOLDINGS GROUP INC";
    expect(longName.length).toBeGreaterThan(40);
    const cut = "FICTIONAL UNIVERSAL INTERNATIONAL";
    reads[endpoints.detail.symbols(cut)] = { available: true, symbols: { items: [], errors: {}, error: null } };
    reads[endpoints.detail.symbols("FICTIONAL UNIVERSAL")] = { available: true, symbols: { items: [symbol("FUHG", "Fictional Universal Holdings")], errors: {}, error: null } };
    const dialog = await open(longName);

    expect(within(dialog).getByRole("heading", { name: longName })).toBeTruthy();
    const input = within(dialog).getByRole("textbox", { name: /검색어/ }) as HTMLInputElement;
    expect(input.value).toBe(cut);
    expect(input.maxLength).toBe(40);
    await within(dialog).findByText(`‘${cut}’에 맞는 종목 후보가 없습니다 — 검색어를 줄이거나 고쳐 다시 찾아 보세요.`);
    expect(symbolRequests()).toEqual([endpoints.detail.symbols(cut)]);

    expect(within(dialog).getByText(/공시 이름으로 찾은 후보입니다/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "  FICTIONAL   UNIVERSAL " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "찾기" }));
    expect(await within(dialog).findByRole("list", { name: /종목 후보 1건/ })).toBeTruthy();
    expect(symbolRequests()).toEqual([endpoints.detail.symbols(cut), endpoints.detail.symbols("FICTIONAL UNIVERSAL")]);
    // 고친 검색어로 찾은 후보면 안내가 공시 이름이라고 하지 않고 그 검색어를 적음
    expect(within(dialog).getByText("13F 공시에는 티커가 없어 검색어 ‘FICTIONAL UNIVERSAL’로 찾은 후보입니다 — 맞는 종목을 고르세요. 자동으로 고르지 않습니다.")).toBeTruthy();
    expect(within(dialog).queryByText(/공시 이름으로 찾은 후보입니다/)).toBeNull();

    // 같은 검색어로 다시 누르면 다시 찾음
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "찾기" }));
    });
    expect(symbolRequests()).toHaveLength(3);

    // 검색어를 비우면 찾지 않음
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "찾기" }));
    expect(await within(dialog).findByText("검색어를 넣고 찾기를 누르세요.")).toBeTruthy();
    expect(symbolRequests()).toHaveLength(3);
  });

  it("국내 후보를 고르면 국내 시세(kr/코드)를 읽는다", async () => {
    reads[endpoints.detail.symbols("ISHARES TR")] = {
      available: true, symbols: { items: [symbol("069500", "합성 국내 ETF", { market: "kr", yahooSymbol: "069500.KS", exchange: "KOSPI", source: "네이버 증권" })], errors: {}, error: null },
    };
    const dialog = await open();
    fireEvent.click(await within(dialog).findByRole("button", { name: /^합성 국내 ETF 069500/ }));
    await waitFor(() => expect(quoteRequests()).toEqual([endpoints.detail.quote("kr", "069500")]));
  });
});
