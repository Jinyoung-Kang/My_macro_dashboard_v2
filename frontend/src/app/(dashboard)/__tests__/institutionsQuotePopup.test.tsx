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

// QA-681: 후보 고르기 창의 한국어 글(안내·검색어 이름표·경고·후보 없음·출처 실패·목록 머리·고른 뒤 안내)에 줄바꿈 규칙이 없어 word-break가 기본(normal)이었고,
// 390(창 안 글 폭 324px)에서 '찾은 후보|입니다'·'값이 다|릅니다'처럼 음절 사이에서 꺾였습니다(D3 전 QA 스택 qa@65caf1e8 — 같은 빌드의 본문 팝업 ArticleDialog는
// KEEP 상수로 지킴, 공용 글 부품 규약 QA-568·QA-664). word-break·overflow-wrap은 상속되므로 글에서 대화상자까지의 조상 줄 어디에 걸려도 됩니다
// (DetailQaHolderBreak.test의 inChain 꼴). jsdom은 배치를 재지 못해 클래스 구조를 대조하고, 실제 폭은 QA 스택 브라우저로 확인합니다.
// 수정 전(재현 커밋에서는 it.fails)에는 경고·안내·이름표 등이 조상 어디에도 break-keep이 없었습니다(공용 ErrorState 글과 후보 이름만 지킴).
// 고침: 후보 창 본문(PickBody) 바깥 div에 break-keep wrap-break-word — 상속으로 경고 Callout과 고른 뒤 시세 본문까지(공용 Callout·다른 화면 StockQuickView는 그대로).
describe("QA-681 후보 고르기 창의 한국어 글은 낱말 사이에서만 줄을 바꾼다", () => {
  const classes = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  /** element에서 stop(포함)까지 올라가는 조상 줄. */
  function chainTo(element: Element, stop: Element): Element[] {
    const chain: Element[] = [];
    for (let node: Element | null = element; node && stop.contains(node); node = node.parentElement) chain.push(node);
    return chain;
  }
  const inChain = (chain: Element[], words: string[]) => chain.some((node) => classes(node).some((word) => words.includes(word)));
  /** 낱말 사이에서만 꺾고(break-keep) 칸보다 긴 토큰만 칸 안에서 꺾는다(wrap-break-word — 후보 이름처럼 wrap-anywhere를 따로 건 글도 됨). */
  const kept = (element: Element, dialog: Element) => {
    const chain = chainTo(element, dialog);
    return inChain(chain, ["break-keep"]) && inChain(chain, ["wrap-break-word", "wrap-anywhere"]);
  };
  const looseTexts = (elements: Element[], dialog: Element) => elements.filter((element) => !kept(element, dialog)).map((element) => element.textContent);

  it("안내·검색어 이름표·경고·후보 없음·출처 실패·목록 머리·일부 출처 실패·고른 뒤 안내와 시세 본문 — 글에서 대화상자까지 break-keep과 wrap-break-word", async () => {
    const query = "FICTIONAL MOTOR CO";
    reads[endpoints.detail.symbols(query)] = { available: true, symbols: { items: [], errors: {}, error: null } };
    reads[endpoints.detail.quote("us", "FMCX")] = { available: true, quote: quote("FMCX", "Fictional Motor Company") };
    render(<StockPickQuickView name={query} cusip="999999ZZ1" cls="NOTE 2.500% 3/1" tickerNote="debt" trigger={<button type="button">후보 열기</button>} />);
    fireEvent.click(screen.getByRole("button", { name: "후보 열기" }));
    const dialog = await screen.findByRole("dialog");

    // 후보 없음 — 안내·검색어 이름표·경고(Callout 안 글)·후보 없음
    const empty = [
      within(dialog).getByText(/^13F 공시에는 티커가 없어 공시 이름으로 찾은 후보입니다/),
      dialog.querySelector("label") as HTMLLabelElement,
      within(dialog).getByText("이 줄은 채권(사채·전환사채 등)이라 아래 종목의 주가와 값이 다릅니다."),
      await within(dialog).findByText(`‘${query}’에 맞는 종목 후보가 없습니다 — 검색어를 줄이거나 고쳐 다시 찾아 보세요.`),
    ];
    // 결함을 직접 보는 단언(수정 전에는 여기서 실패).
    expect(looseTexts(empty, dialog)).toEqual([]);

    // 출처 실패(다시 시도 줄)
    reads[endpoints.detail.symbols(query)] = { available: true, symbols: { items: [], errors: { "Yahoo Finance": "HTTP 429" }, error: "HTTP 429" } };
    fireEvent.click(within(dialog).getByRole("button", { name: "찾기" }));
    const failed = await within(dialog).findByText("출처를 받지 못해 후보를 보이지 못했습니다(Yahoo Finance) — 맞는 종목이 없다는 뜻은 아닙니다.");
    expect(looseTexts([failed], dialog)).toEqual([]);

    // 후보 목록 머리·일부 출처 실패·후보 이름
    reads[endpoints.detail.symbols(query)] = {
      available: true, symbols: { items: [symbol("FMCX", "Fictional Motor Company", { kind: "EQUITY", exchange: "NYSE" })], errors: { "네이버 증권": "HTTP 503" }, error: null },
    };
    fireEvent.click(within(dialog).getByRole("button", { name: "다시 시도" }));
    const list = await within(dialog).findByRole("list", { name: /종목 후보 1건/ });
    const listed = [
      within(dialog).getByText(/^종목 후보 1건 — 누르면 이 창에서 그 종목의 시세를 봅니다/),
      within(dialog).getByText("일부 출처를 받지 못했습니다(네이버 증권) — 후보가 더 있을 수 있습니다."),
      within(list).getByText("Fictional Motor Company"),
    ];
    expect(looseTexts(listed, dialog)).toEqual([]);

    // 고른 뒤 — 안내 줄과 시세 본문(같은 창 안)
    fireEvent.click(within(list).getByRole("button", { name: /^Fictional Motor Company FMCX/ }));
    await within(dialog).findByRole("button", { name: "후보 다시 고르기" });
    const picked = [
      within(dialog).getByText("찾은 후보에서 고른 종목입니다 — 이 13F 보유와 같은 증권인지 확인하세요."),
      within(dialog).getByText("이 줄은 채권(사채·전환사채 등)이라 아래 종목의 주가와 값이 다릅니다."),
      await within(dialog).findByRole("link", { name: "상세 화면 열기" }),
    ];
    expect(looseTexts(picked, dialog)).toEqual([]);
  });
});

// QA-682: 후보 창의 '다시 시도'(출처 실패·available:false 줄의 단추, 읽기 실패의 공용 ErrorState 단추)를 누르면, 결과가 와서(또는 읽기 실패의 다시 읽기가
// 시작돼 자리표시로 바뀌어) 누른 단추가 사라질 때 포커스가 대화상자 틀(DIV role=dialog — Radix FocusScope가 body 대신 잡음)로 떨어졌습니다. 다음 Tab은 창의
// 처음(입력칸)부터였고 낭독기는 창 이름부터 다시 읽었습니다(D3 전 QA 스택 qa@65caf1e8 390·1440, 키보드·마우스 같음 — 같은 빌드의 본문 팝업 ArticleDialog는
// 다시 시도 전에 고정 자리로 옮김). 다시 읽는 동안에는 창 안 결과 자리에, 결과가 오면 첫 후보(후보가 왔을 때)·새 '다시 시도'(다시 실패)·입력칸(맞는 후보
// 없음)으로 옮겨야 합니다. 그 사이 사용자가 포커스를 옮겼으면 그대로 둡니다. 수정 전(재현 커밋에서는 it.fails)에는 포커스가 틀(또는 body)에 남았습니다.
// 고침: 다시 시도가 포커스를 먼저 결과 자리(tabIndex -1)로 옮기고, 다시 읽기가 끝나면 effect가 결과 자리의 첫 단추(후보·다시 시도) 또는 입력칸으로 옮김.
describe("QA-682 후보 창의 다시 시도 뒤 포커스는 결과로 옮긴다 — 대화상자 틀로 떨어지지 않음", () => {
  const trigger = <button type="button">후보 열기</button>;
  const open = async () => {
    render(<StockPickQuickView name="ISHARES TR" cusip="464287200" cls="CORE S&P500 ETF" trigger={trigger} />);
    fireEvent.click(screen.getByRole("button", { name: "후보 열기" }));
    return screen.findByRole("dialog");
  };
  /** 포커스가 창 안이고 창 틀 자체는 아님 — 다시 읽는 동안의 자리. */
  const focusInsideDialog = (dialog: HTMLElement) => document.activeElement !== dialog && dialog.contains(document.activeElement);
  const CANDIDATES = {
    available: true,
    symbols: { items: [symbol("IVV", "iShares Core S&P 500 ETF"), symbol("ITOT", "iShares Core S&P Total U.S. Stock Market ETF")], errors: {}, error: null },
  };

  it("출처 실패의 다시 시도 — 다시 찾는 동안 창 안에 있고, 후보가 오면 첫 후보로", async () => {
    reads[endpoints.detail.symbols("ISHARES TR")] = { available: true, symbols: { items: [], errors: { "Yahoo Finance": "HTTP 429" }, error: "HTTP 429" } };
    const dialog = await open();
    const retry = await within(dialog).findByRole("button", { name: "다시 시도" });
    let resolve: (body: unknown) => void = () => {};
    reads[endpoints.detail.symbols("ISHARES TR")] = () => new Promise((done) => { resolve = done; });
    retry.focus();
    fireEvent.click(retry);
    expect(await within(dialog).findByText("다시 찾는 중…")).toBeTruthy();
    expect(focusInsideDialog(dialog)).toBe(true);

    await act(async () => resolve(CANDIDATES));
    const list = await within(dialog).findByRole("list", { name: /종목 후보 2건/ });
    // 결함을 직접 보는 단언(수정 전에는 포커스가 틀에 남아 여기서 실패).
    await waitFor(() => expect(document.activeElement).toBe(within(list).getAllByRole("button")[0]));
  });

  it("읽기 실패의 다시 시도 — 다시 읽는 동안(누른 단추가 자리표시로 바뀜)에도 창 안, 다시 실패하면 새 '다시 시도'로, 맞는 후보가 없으면 입력칸으로", async () => {
    reads[endpoints.detail.symbols("ISHARES TR")] = new Error("요청 시간이 지났습니다");
    const dialog = await open();
    await within(dialog).findByText("후보를 불러오지 못했습니다 — 요청 시간이 지났습니다", { selector: "span" });
    let fail: (error: Error) => void = () => {};
    reads[endpoints.detail.symbols("ISHARES TR")] = () => new Promise((_, reject) => { fail = reject; });
    const first = within(dialog).getByRole("button", { name: "다시 시도" });
    first.focus();
    fireEvent.click(first);
    // 다시 읽는 동안 오류 상자(와 그 단추)는 자리표시로 바뀜 — 포커스가 틀·문서 처음으로 떨어지지 않음(수정 전에는 여기서 실패).
    expect(within(dialog).queryByRole("button", { name: "다시 시도" })).toBeNull();
    expect(focusInsideDialog(dialog)).toBe(true);

    await act(async () => fail(new Error("연결 실패")));
    await within(dialog).findByText("후보를 불러오지 못했습니다 — 연결 실패", { selector: "span" });
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "다시 시도" })));

    reads[endpoints.detail.symbols("ISHARES TR")] = { available: true, symbols: { items: [], errors: {}, error: null } };
    fireEvent.click(within(dialog).getByRole("button", { name: "다시 시도" }));
    await within(dialog).findByText("‘ISHARES TR’에 맞는 종목 후보가 없습니다 — 검색어를 줄이거나 고쳐 다시 찾아 보세요.");
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("textbox", { name: /검색어/ })));
  });

  // QA-682 보강: 고침(8311c3bd)의 retry는 상태와 상관없이 포커스를 결과 자리(div tabIndex -1, 이름·역할 없음)로 옮겼습니다. 그런데 출처 실패·종목 찾기를 쓸
  // 수 없음 줄의 '다시 시도'는 다시 찾는 동안 앞 결과와 함께 단추가 그대로 남습니다(useApi가 같은 경로를 다시 읽는 동안 data를 둠). 크롬은 포커스 받는
  // generic의 접근 이름을 내용 전체로 계산해(머리 없는 크롬 CDP — '다시 찾는 중… 종목 찾기를 쓸 수 없습니다 다시 시도', nameSources contents) 낭독기가 누른
  // 직후 앞의 실패 사유를 결과처럼 읽었고, 다시 실패하면 포커스가 같은 '다시 시도' 단추로 돌아와 두 번 옮겼습니다. 단추가 남는 길은 포커스를 단추에 두고
  // 결과가 오면 옮기며, 단추가 사라지는 읽기 실패 길만 결과 자리로 먼저 옮기되 그 자리는 짧은 이름(group '종목 후보 결과')이어야 합니다.
  // 수정 전(재현 커밋에서는 it.fails)에는 누른 직후 포커스가 결과 자리(div)였고, 결과 자리에 역할·이름이 없었습니다.
  it("앞 결과가 남는 다시 시도(종목 찾기를 쓸 수 없음) — 다시 찾는 동안·다시 실패한 뒤 포커스는 누른 단추 그대로(옮기지 않음), 후보가 오면 첫 후보로", async () => {
    reads[endpoints.detail.symbols("ISHARES TR")] = { available: false, message: "수집기 점검 중입니다." };
    const dialog = await open();
    const retry = await within(dialog).findByRole("button", { name: "다시 시도" });
    let fail: (error: Error) => void = () => {};
    reads[endpoints.detail.symbols("ISHARES TR")] = () => new Promise((_, reject) => { fail = reject; });
    retry.focus();
    const moves: Element[] = [];
    const onFocusIn = (event: FocusEvent) => moves.push(event.target as Element);
    document.addEventListener("focusin", onFocusIn);
    try {
      fireEvent.click(retry);
      await within(dialog).findByText("다시 찾는 중…");
      // 결함을 직접 보는 단언(수정 전에는 포커스가 결과 자리 div — 크롬에서는 이름이 앞 결과 전체).
      expect(document.activeElement).toBe(retry);

      await act(async () => fail(new Error("연결 실패")));
      // 보이는 줄(라이브 영역 글은 '앞서 찾은 결과:'로 이어짐).
      await within(dialog).findByText(/^다시 찾지 못했습니다 — 연결 실패\. 아래는 앞서 찾은 결과입니다\.$/);
      expect(within(dialog).getByRole("button", { name: "다시 시도" })).toBe(retry);
      expect(document.activeElement).toBe(retry);
      expect(moves).toEqual([]);

      reads[endpoints.detail.symbols("ISHARES TR")] = CANDIDATES;
      fireEvent.click(retry);
      const list = await within(dialog).findByRole("list", { name: /종목 후보 2건/ });
      await waitFor(() => expect(document.activeElement).toBe(within(list).getAllByRole("button")[0]));
    } finally {
      document.removeEventListener("focusin", onFocusIn);
    }
  });

  it("읽기 실패의 다시 시도 — 단추가 자리표시로 바뀌는 동안 머무는 결과 자리는 짧은 이름(group '종목 후보 결과')", async () => {
    reads[endpoints.detail.symbols("ISHARES TR")] = new Error("요청 시간이 지났습니다");
    const dialog = await open();
    await within(dialog).findByText("후보를 불러오지 못했습니다 — 요청 시간이 지났습니다", { selector: "span" });
    reads[endpoints.detail.symbols("ISHARES TR")] = () => new Promise(() => {});
    const button = within(dialog).getByRole("button", { name: "다시 시도" });
    button.focus();
    fireEvent.click(button);
    expect(within(dialog).queryByRole("button", { name: "다시 시도" })).toBeNull();
    // 결함을 직접 보는 단언(수정 전에는 결과 자리에 역할·이름이 없음 — 크롬에서는 내용 전체가 이름).
    expect(document.activeElement).toBe(within(dialog).getByRole("group", { name: "종목 후보 결과" }));
  });

  it("다시 찾는 동안 사용자가 포커스를 옮겼으면(입력칸) 결과가 와도 그대로 — 찾기(같은 검색어 다시 찾기)도 포커스를 입력칸에 둔다", async () => {
    reads[endpoints.detail.symbols("ISHARES TR")] = { available: false, message: "수집기 점검 중입니다." };
    const dialog = await open();
    const retry = await within(dialog).findByRole("button", { name: "다시 시도" });
    let resolve: (body: unknown) => void = () => {};
    reads[endpoints.detail.symbols("ISHARES TR")] = () => new Promise((done) => { resolve = done; });
    retry.focus();
    fireEvent.click(retry);
    await within(dialog).findByText("다시 찾는 중…");
    const input = within(dialog).getByRole("textbox", { name: /검색어/ });
    input.focus();
    await act(async () => resolve(CANDIDATES));
    await within(dialog).findByRole("list", { name: /종목 후보 2건/ });
    expect(document.activeElement).toBe(input);

    // 같은 검색어로 찾기(입력칸에서 Enter와 같음) — 결과가 와도 포커스는 입력칸
    reads[endpoints.detail.symbols("ISHARES TR")] = { available: true, symbols: { items: [symbol("IVV", "iShares Core S&P 500 ETF")], errors: {}, error: null } };
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await within(dialog).findByRole("list", { name: /종목 후보 1건/ });
    expect(document.activeElement).toBe(input);
  });
});

// QA-690: 앞 결과가 남는 줄(출처 실패·종목 찾기를 쓸 수 없음)의 '다시 시도' 뒤 결과가 와 누른 단추가 사라지면, 포커스가 대화상자 틀(role=dialog)로 한 번
// 갔다가 첫 후보·입력칸으로 갔습니다(QA 스택 qa@2d111589 390·1440, 키보드·마우스·터치 — 틀에 머문 시간 0.5~14.9ms, CPU 4배 느림 3.2~9.3ms). 낭독기는 그
// 사이 창 이름을 다시 읽을 수 있습니다. 결과로 옮기는 effect가 수동(useEffect)이라 그림이 화면에 붙은 뒤 돌았고, 그 사이 누른 단추가 지워진 것을 본 Radix
// FocusScope의 MutationObserver가 activeElement가 body인 것을 보고 틀에 포커스했습니다. 읽기 실패의 다시 시도(포커스를 먼저 결과 자리로 옮김)와 다시
// 실패해 같은 단추가 남는 경우는 틀을 거치지 않았습니다(대조). act 안에서 응답을 보내면 effect가 act 끝에 함께 비워져 원본에서도 틀을 거치지 않으므로,
// 응답은 act 밖에서(IS_REACT_ACT_ENVIRONMENT false — 브라우저처럼 React 스케줄러가 그림) 보내고 focusin 기록에 틀이 없는지 봅니다.
// 수정 전(재현 커밋에서는 it.fails)에는 focusin 기록에 틀(DIALOG)이 있었습니다. 고침: 결과로 옮기는 effect를 useLayoutEffect로(조건·의존 그대로).
describe("QA-690 앞 결과가 남는 다시 시도 뒤 결과가 오면 포커스는 틀을 거치지 않고 결과로", () => {
  const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const CANDIDATES = {
    available: true,
    symbols: { items: [symbol("IVV", "iShares Core S&P 500 ETF"), symbol("ITOT", "iShares Core S&P Total U.S. Stock Market ETF")], errors: {}, error: null },
  };
  const SOURCE_FAILED = { available: true, symbols: { items: [], errors: { "Yahoo Finance": "HTTP 429" }, error: "HTTP 429" } };
  const UNAVAILABLE = { available: false, message: "수집기 점검 중입니다." };
  const NO_MATCH = { available: true, symbols: { items: [], errors: {}, error: null } };

  /** 처음 결과(initial)의 '다시 시도'를 누르고 다음 결과(next)를 act 밖에서 보낸 뒤, 그 사이 포커스가 옮겨 간 자리를 돌려줍니다. */
  async function retryOutsideAct(initial: unknown, next: unknown, arrived: (dialog: HTMLElement) => boolean) {
    reads[endpoints.detail.symbols("ISHARES TR")] = initial;
    render(<StockPickQuickView name="ISHARES TR" cusip="464287200" cls="CORE S&P500 ETF" trigger={<button type="button">후보 열기</button>} />);
    fireEvent.click(screen.getByRole("button", { name: "후보 열기" }));
    const dialog = await screen.findByRole("dialog");
    const retry = await within(dialog).findByRole("button", { name: "다시 시도" });
    let resolve: (body: unknown) => void = () => {};
    reads[endpoints.detail.symbols("ISHARES TR")] = () => new Promise((done) => { resolve = done; });
    retry.focus();
    fireEvent.click(retry);
    await within(dialog).findByText("다시 찾는 중…");
    expect(document.activeElement).toBe(retry);
    const moves: Element[] = [];
    const onFocusIn = (event: FocusEvent) => moves.push(event.target as Element);
    const before = actEnv.IS_REACT_ACT_ENVIRONMENT;
    document.addEventListener("focusin", onFocusIn);
    actEnv.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      resolve(next);
      for (let i = 0; i < 100 && !arrived(dialog); i++) await sleep(10);
      await sleep(50);
    } finally {
      actEnv.IS_REACT_ACT_ENVIRONMENT = before;
      document.removeEventListener("focusin", onFocusIn);
    }
    return { dialog, moves };
  }
  const listed = (dialog: HTMLElement) => within(dialog).queryAllByRole("listitem").length > 0;
  /** 포커스가 거쳐 간 대화상자 틀(role=dialog). */
  const frames = (moves: Element[]) => moves.filter((element) => element.getAttribute("role") === "dialog");

  it("출처 실패 → 후보: 틀을 거치지 않고 첫 후보로", async () => {
    const { dialog, moves } = await retryOutsideAct(SOURCE_FAILED, CANDIDATES, listed);
    const first = within(within(dialog).getByRole("list", { name: /종목 후보 2건/ })).getAllByRole("button")[0];
    expect(document.activeElement).toBe(first);
    // 결함을 직접 보는 단언(수정 전에는 첫 후보 앞에 틀이 있음).
    expect(frames(moves)).toEqual([]);
    expect(moves).toEqual([first]);
  });

  it("종목 찾기를 쓸 수 없음 → 후보: 틀을 거치지 않고 첫 후보로", async () => {
    const { dialog, moves } = await retryOutsideAct(UNAVAILABLE, CANDIDATES, listed);
    const first = within(within(dialog).getByRole("list", { name: /종목 후보 2건/ })).getAllByRole("button")[0];
    expect(document.activeElement).toBe(first);
    expect(frames(moves)).toEqual([]);
    expect(moves).toEqual([first]);
  });

  it("출처 실패 → 맞는 후보 없음: 틀을 거치지 않고 입력칸으로", async () => {
    const { dialog, moves } = await retryOutsideAct(SOURCE_FAILED, NO_MATCH, (box) => /맞는 종목 후보가 없습니다/.test(box.textContent ?? ""));
    const input = within(dialog).getByRole("textbox", { name: /검색어/ });
    expect(document.activeElement).toBe(input);
    expect(frames(moves)).toEqual([]);
    expect(moves).toEqual([input]);
  });
});

// QA-691: 공용 시세 창 본문(StockQuickBody — 13F 티커 줄·모의 매매 보유 표 등의 종목 팝업, 후보 창의 고른 뒤 본문)에 줄바꿈 규칙이 없어 word-break가
// 기본(normal)이었습니다. 기업 설명·보조 줄·출처 줄의 한국어가 음절 사이에서 꺾였고(QA 스택 qa@2d111589 /institutions 티커 줄 — 합성 기업 설명 340~1000px
// 31폭·1024~1920px 6폭 모두 '가상의 부품|과' 꼴, 보조 줄 430·출처 줄 340), 공백 없는 긴 이름(합성 75자)이면 창이 가로로 스크롤됐습니다(390 602px·768~1440
// 288px). 후보 창의 고른 뒤 본문은 QA-681 고침이 바깥(PickBody)에 건 규칙을 상속해 꺾이지 않았습니다(대조). 운영본 D2(a5cdae2f)부터 있던 것을 13F 티커 줄
// 입구(사용자 요청 2026-11-18)가 /institutions에도 드러냈습니다. 이름 줄은 창의 닫기 단추와 같은 줄이라, 줄바꿈만 고치면 긴 이름의 첫 줄이 닫기 단추와
// 겹쳤습니다(390 17px·1440 12px — 대화상자 제목의 pr-10과 같은 자리가 필요). jsdom은 배치를 재지 못해 클래스 구조(QA-681과 같은 inChain 꼴)를 봅니다.
// 수정 전(재현 커밋에서는 it.fails)에는 글에서 대화상자까지 어디에도 break-keep이 없었고 이름 줄에 pr-10이 없었습니다.
// 고침: 본문 바깥 div에 break-keep wrap-break-word(상속), 이름 줄에 pr-10. 공용 부품이라 모의 매매·실제 계좌·ISA 표의 시세 창도 함께 바뀝니다.
describe("QA-691 시세 창 본문의 한국어 글은 낱말 사이에서만 줄을 바꾸고, 이름 줄은 닫기 단추 자리를 비운다", () => {
  const LONG_NAME = "SUPERCALIFRAGILISTICEXPIALIDOCIOUSSYNTHETICHOLDINGSCORPORATIONINTERNATIONAL";
  const SUMMARY = "합성 지주 회사는 화면 확인용으로 지어낸 가상의 회사이며 실제 회사와 관계가 없습니다. 가상의 부품과 서비스를 만들어 여러 나라에 판다고 가정합니다.";
  const classes = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  function chainTo(element: Element, stop: Element): Element[] {
    const chain: Element[] = [];
    for (let node: Element | null = element; node && stop.contains(node); node = node.parentElement) chain.push(node);
    return chain;
  }
  const inChain = (chain: Element[], words: string[]) => chain.some((node) => classes(node).some((word) => words.includes(word)));
  const looseTexts = (elements: Element[], dialog: Element) =>
    elements
      .filter((element) => {
        const chain = chainTo(element, dialog);
        return !(inChain(chain, ["break-keep"]) && inChain(chain, ["wrap-break-word", "wrap-anywhere"]));
      })
      .map((element) => element.textContent);

  it("13F 티커 줄의 시세 창 — 이름·보조 줄·업종·기업 설명·출처 줄·시세 머리가 break-keep과 wrap-break-word 안, 이름 줄은 pr-10", async () => {
    reads[endpoints.detail.quote("us", "BRK-B")] = {
      available: true,
      quote: {
        ...quote("BRK-B", LONG_NAME),
        profile: {
          sector: "Financial Services", industry: "Insurance—Diversified", country: "United States", website: null, employees: null,
          summary: null, summaryKo: SUMMARY, industryKo: "다각화 보험", koSource: { label: "합성 개요 출처", url: "https://profile.example/x" },
        },
      },
    };
    render(<InstitutionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "BERKSHIRE HATHAWAY INC DEL 시세 창 열기" }));
    const dialog = await screen.findByRole("dialog", { name: "BRK-B" });
    const name = await within(dialog).findByText(LONG_NAME, { selector: "p" });
    const texts = [
      name,
      within(dialog).getByText("BRK-B · NYSEArca · 주식 · USD"),
      within(dialog).getByText(/다각화 보험$/),
      within(dialog).getByText(SUMMARY),
      within(dialog).getByText(/^출처 합성 개요 출처 · 전체 개요는 상세 화면$/),
      within(dialog).getByRole("heading", { name: `${LONG_NAME} 시세` }),
    ];
    // 결함을 직접 보는 단언(수정 전에는 여기서 실패 — 여섯 글 모두 규칙 없음).
    expect(looseTexts(texts, dialog)).toEqual([]);
    // 이름 줄은 닫기 단추(오른쪽 위 — 대화상자 제목의 pr-10과 같은 자리)와 겹치지 않게 오른쪽을 비운다.
    expect(classes(name)).toContain("pr-10");
  });

  // 보강(검토 지적): 닫기 단추 자리(pr-10)는 제목을 숨겨(hideTitle) 이름 줄이 닫기 단추와 같은 줄에 오는 시세 창에만 필요합니다. 후보 창은 제목(Dialog의
  // pr-10)·설명(CUSIP)·고른 뒤 안내 줄 아래에 본문이 와서 이름 줄이 닫기 단추 줄이 아닌데도, 고침 첫 판은 공용 본문에 조건 없이 걸어 이름 줄만 오른쪽
  // 40px를 비웠습니다(위아래 안내 줄·기업 설명은 끝까지 차서 이름만 어긋남). 보강 전(재현 커밋에서는 it.fails)에는 고른 뒤 본문의 이름 줄에 pr-10이 있었습니다.
  it.fails("후보 창의 고른 뒤 본문 — 이름 줄은 닫기 단추 줄이 아니라 오른쪽을 비우지 않는다(pr-10 없음), 줄바꿈 규칙은 그대로", async () => {
    reads[endpoints.detail.symbols("ISHARES TR")] = { available: true, symbols: { items: [symbol("IVV", "iShares Core S&P 500 ETF")], errors: {}, error: null } };
    reads[endpoints.detail.quote("us", "IVV")] = { available: true, quote: quote("IVV", LONG_NAME, "ETF") };
    render(<StockPickQuickView name="ISHARES TR" cusip="464287200" cls="CORE S&P500 ETF" trigger={<button type="button">후보 열기</button>} />);
    fireEvent.click(screen.getByRole("button", { name: "후보 열기" }));
    const dialog = await screen.findByRole("dialog", { name: "ISHARES TR" });
    fireEvent.click(await within(dialog).findByRole("button", { name: /^iShares Core S&P 500 ETF IVV/ }));
    const name = await within(dialog).findByText(LONG_NAME, { selector: "p" });
    expect(looseTexts([name], dialog)).toEqual([]);
    // 결함을 직접 보는 단언(보강 전에는 여기서 실패 — 이름 줄에 pr-10).
    expect(classes(name)).not.toContain("pr-10");
  });
});
