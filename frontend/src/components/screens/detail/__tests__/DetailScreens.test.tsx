/**
 * 검색 상세 화면 — 종목(/s/…)·지표(/markets/i/…)·기관(/institutions/<CIK>)을 고정 응답으로 그려 본다.
 *  - 값 있음: 시세 히어로·핵심 지표·회사 개요·애널리스트 의견·뉴스(원문 새 창 링크)·13F 보유 기관(기관 상세 링크)·외부 링크
 *  - 값 없음: 조회하지 않음(store_only)·받지 못함은 그 이유, 모르는 값은 "—"(0으로 채우지 않음), http(s)가 아닌 주소는 링크로 두지 않음
 *  - AI 요약: 유료·운영자만 단추, 누를 때만 부르고 근거 번호를 출처 링크로, 무료 회원은 자물쇠 안내
 *  - 라우트: 시장·코드·CIK·지표 키 모양이 틀리면 404(notFound)
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import { macroOverview } from "@/lib/__tests__/homeFixtures";
import type { DetailQuote, SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({
  LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} />,
}));
const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => navigation);

import IndicatorDetailPage from "@/app/(dashboard)/markets/i/[id]/page";
import InstitutionDetailPage from "@/app/(dashboard)/institutions/[cik]/page";
import StockDetailPage from "@/app/(dashboard)/s/[market]/[code]/page";
import { IndicatorDetailScreen } from "../IndicatorDetailScreen";
import { InstitutionDetailScreen } from "../InstitutionDetailScreen";
import { StockDetailScreen } from "../StockDetailScreen";

const PRO: SessionUser = { email: "p@test.local", role: "MEMBER", tier: "PRO" };
const FREE: SessionUser = { email: "f@test.local", role: "MEMBER", tier: "FREE" };

let reads: Record<string, unknown> = {};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-01T14:30:00Z"));
  reads = {};
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (!(path in reads)) return new Promise(() => {});
    const body = reads[path];
    return body instanceof Error ? Promise.reject(body) : Promise.resolve(body);
  });
  api.apiPost.mockReset();
  navigation.notFound.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderAs(user: SessionUser | undefined, page: ReactElement) {
  return render(<SessionUserProvider user={user}>{page}</SessionUserProvider>);
}

const requested = () => api.apiGetShared.mock.calls.map(([path]) => path as string);

function appleQuote(overrides: Partial<DetailQuote> = {}): DetailQuote {
  return {
    market: "us",
    code: "AAPL",
    yahooSymbol: "AAPL",
    name: "Apple Inc.",
    exchange: "NasdaqGS",
    currency: "USD",
    kind: "EQUITY",
    price: 344.63,
    previousClose: 348.91,
    change: -4.28,
    changePct: -1.2267,
    asOf: "2026-10-30T20:00:01+00:00",
    marketState: "CLOSED",
    stats: [
      { key: "marketCap", label: "시가총액", value: 5_029_592_301_568, text: null, unit: "money" },
      { key: "trailingPE", label: "PER", value: 39.517, text: null, unit: "x" },
      { key: "dividendYield", label: "배당수익률", value: null, text: null, unit: "pct" },
    ],
    profile: { sector: "Technology", industry: "Consumer Electronics", country: "United States", website: "https://www.apple.com", employees: 166000, summary: "Apple designs devices." },
    consensus: { targetMean: 360.5, recommendation: "buy", analysts: 41 },
    research: [],
    source: { label: "Yahoo Finance(yfinance)", url: "https://finance.yahoo.com/quote/AAPL" },
    error: null,
    fetchedAt: "2026-11-01T14:29:00+00:00",
    ...overrides,
  };
}

const QUOTE = endpoints.detail.quote("us", "AAPL");
const NEWS = endpoints.detail.news({ market: "us", code: "AAPL", q: "Apple Inc." });
const TICKER = endpoints.macro.ticker("AAPL", "1y");
const HOLDERS = endpoints.institution.guruHolders("APPLE");

function appleReads(): Record<string, unknown> {
  return {
    [QUOTE]: { available: true, quote: appleQuote() },
    [NEWS]: {
      available: true,
      news: {
        items: [
          { title: "Apple beats estimates", url: "https://news.example/a", publisher: "Reuters", publishedAt: "2026-11-01T12:30:00Z", source: "Google News" },
          { title: "Odd link", url: "javascript:alert(1)", publisher: null, publishedAt: null, source: "Yahoo Finance" },
        ],
        errors: { "네이버 증권": "HTTP 503" },
        error: null,
        fetchedAt: "2026-11-01T14:29:00Z",
      },
    },
    [TICKER]: { available: true, points: [{ date: "2026-10-29", close: 348.9 }, { date: "2026-10-30", close: 344.6 }] },
    [HOLDERS]: {
      available: true,
      query: "APPLE",
      rows: [{ institution: "🇺🇸 버크셔 해서웨이 (Berkshire Hathaway)", cik: "0001067983", name: "APPLE INC", cusip: "037833100", weight: 21.5, value: 60_000_000_000, reportDate: "2026-06-30" }],
    },
  };
}

describe("종목 상세 — 미국", () => {
  it("시세 히어로·핵심 지표·개요·의견·뉴스·13F 보유 기관·외부 링크를 그린다", async () => {
    reads = appleReads();
    renderAs(PRO, <StockDetailScreen market="us" code="AAPL" />);

    expect(await screen.findByRole("heading", { level: 1, name: "Apple Inc." })).toBeTruthy();
    expect(screen.getByText("AAPL · NasdaqGS · 주식 · USD")).toBeTruthy();
    const hero = screen.getByRole("region", { name: "Apple Inc. 시세" });
    expect(within(hero).getByText("344.63")).toBeTruthy();
    expect(within(hero).getByText("장 마감")).toBeTruthy();
    expect(within(hero).getByRole("link", { name: /출처 보기/ }).getAttribute("href")).toBe("https://finance.yahoo.com/quote/AAPL");
    expect(await within(hero).findByRole("img", { name: "Apple Inc. 시세 가격 차트" })).toBeTruthy();
    expect(within(hero).getByRole("tablist", { name: "Apple Inc. 시세 차트 기간" })).toBeTruthy();

    // 핵심 지표 — 단위대로, 모르는 값은 "—"
    const stats = screen.getByRole("heading", { name: "핵심 지표" }).closest("section") as HTMLElement;
    expect(within(stats).getByText("5.030조 달러")).toBeTruthy();
    expect(within(stats).getByText("39.52배")).toBeTruthy();
    expect(within(stats).getByText("—")).toBeTruthy();

    expect(screen.getByText("Consumer Electronics")).toBeTruthy();
    expect(screen.getByText("166,000명")).toBeTruthy();
    expect(screen.getByText("360.50 USD")).toBeTruthy();
    expect(screen.getByText("매수")).toBeTruthy();

    // 뉴스 — 원문 새 창 링크, http(s)가 아닌 주소는 글만, 실패한 출처는 한 줄
    const article = await screen.findByRole("link", { name: /Apple beats estimates/ });
    expect(article.getAttribute("href")).toBe("https://news.example/a");
    expect(article.getAttribute("target")).toBe("_blank");
    expect(article.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByText("Reuters · 2시간 전 · Google News")).toBeTruthy();
    expect(screen.getByText("Odd link").closest("a")).toBeNull();
    expect(screen.getByText(/일부 출처를 받지 못했습니다 — 네이버 증권: HTTP 503/)).toBeTruthy();
    // 뉴스는 시세(회사 이름)를 읽은 뒤 한 번만 — 이름 없는 요청을 먼저 보내지 않는다
    expect(requested().filter((path) => path.startsWith("/api/detail/news"))).toEqual([NEWS]);

    // 13F 보유 기관 — 공시 이름으로 찾은 줄, 기관 이름은 기관 상세 링크
    const holder = await screen.findByRole("link", { name: "버크셔 해서웨이 (Berkshire Hathaway)" });
    expect(holder.getAttribute("href")).toBe("/institutions/0001067983");
    expect(screen.getByText("21.50%")).toBeTruthy();

    const links = screen.getByRole("heading", { name: "다른 곳에서 보기" }).closest("section") as HTMLElement;
    expect(within(links).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "https://finance.yahoo.com/quote/AAPL",
      "https://www.google.com/finance?q=AAPL",
      "https://www.investing.com/search/?q=Apple%20Inc.",
      "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=AAPL",
    ]);
  });

  it("한국어 개요(네이버 해외주식)가 있으면 제목은 한글 이름·영문은 보조 줄, 개요·업종·섹터·나라는 한국어, 출처 링크", async () => {
    reads = appleReads();
    reads[QUOTE] = {
      available: true,
      quote: appleQuote({
        nameKo: "애플",
        profile: { sector: "Technology", industry: "Consumer Electronics", country: "United States", website: null, employees: null,
          summary: "Apple designs devices.", summaryKo: "애플은 기기를 설계한다.\n서비스도 판다.", industryKo: "전화 및 소형 장치",
          koSource: { label: "네이버 증권 해외주식 기업 개요", url: "https://m.stock.naver.com/worldstock/stock/AAPL.O/overview" } },
      }),
    };
    renderAs(PRO, <StockDetailScreen market="us" code="AAPL" />);
    expect(await screen.findByRole("heading", { level: 1, name: "애플" })).toBeTruthy();
    expect(screen.getByText("Apple Inc. · AAPL · NasdaqGS · 주식 · USD")).toBeTruthy();
    const card = screen.getByRole("heading", { name: "회사 개요" }).closest("section") as HTMLElement;
    expect(within(card).getByText("기술")).toBeTruthy();
    expect(within(card).getByText("전화 및 소형 장치")).toBeTruthy();
    expect(within(card).getByText("미국")).toBeTruthy();
    expect(within(card).getByText(/애플은 기기를 설계한다/)).toBeTruthy();
    expect(within(card).queryByText("Apple designs devices.")).toBeNull();
    expect(within(card).getByRole("link", { name: /한국어 개요 출처/ }).getAttribute("href")).toBe(
      "https://m.stock.naver.com/worldstock/stock/AAPL.O/overview");
  });

  it("뉴스는 한 쪽에 5건 — 이전·다음 단추와 쪽 표시", async () => {
    reads = appleReads();
    reads[NEWS] = {
      available: true,
      news: {
        items: Array.from({ length: 12 }, (_, at) => ({
          title: `기사 ${at + 1}`, url: `https://news.example/${at + 1}`, publisher: "연합인포맥스",
          publishedAt: "2026-11-01T12:30:00Z", source: "연합인포맥스",
        })),
        errors: {}, error: null, fetchedAt: "2026-11-01T14:29:00Z",
      },
    };
    renderAs(PRO, <StockDetailScreen market="us" code="AAPL" />);
    expect(await screen.findByRole("link", { name: /기사 1\b/ })).toBeTruthy();
    const pager = screen.getByRole("navigation", { name: "뉴스 쪽" });
    expect(within(pager).getByText("1 / 3쪽 · 12건")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /기사 6/ })).toBeNull();
    expect((within(pager).getByRole("button", { name: "이전" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(pager).getByRole("button", { name: "다음" }));
    expect(screen.getByRole("link", { name: /기사 6/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /기사 1\b/ })).toBeNull();
    fireEvent.click(within(pager).getByRole("button", { name: "다음" }));
    expect(within(pager).getByText("3 / 3쪽 · 12건")).toBeTruthy();
    expect((within(pager).getByRole("button", { name: "다음" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("AI 요약 — 누를 때만 부르고, 근거 번호를 출처 링크로 바꾼다", async () => {
    reads = appleReads();
    api.apiPost.mockResolvedValue({
      status: true,
      summary: "한 줄 요약: 애플은 하락 마감 [1]\n핵심:\n- 실적 상회 [2]",
      model: "claude-haiku-5-5",
      generatedAtKst: "2026-11-01 23:30 KST",
      cached: false,
      sources: [
        { n: 1, label: "시세·지표 — Yahoo Finance(yfinance)", url: "https://finance.yahoo.com/quote/AAPL" },
        { n: 2, label: "Reuters — Apple beats estimates", url: "https://news.example/a" },
      ],
      quota: { used: 1, limit: 20 },
      error: null,
    });
    renderAs(PRO, <StockDetailScreen market="us" code="AAPL" />);
    await screen.findByRole("heading", { level: 1, name: "Apple Inc." });
    expect(api.apiPost).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "AI 요약 만들기" }));
    });
    expect(api.apiPost).toHaveBeenCalledWith("/api/detail/summary", { market: "us", code: "AAPL", q: "Apple Inc.", label: "Apple Inc." });
    const card = screen.getByRole("heading", { name: "AI 요약" }).closest("section") as HTMLElement;
    expect(within(card).getByText("한 줄 요약: 애플은 하락 마감")).toBeTruthy();
    expect(within(card).getByText("실적 상회")).toBeTruthy();
    const marks = within(card).getAllByRole("link", { name: /^\[\d\]/ });
    expect(marks.map((mark) => mark.getAttribute("href"))).toEqual(["https://finance.yahoo.com/quote/AAPL", "https://news.example/a"]);
    expect(within(within(card).getByRole("list", { name: "요약 근거" })).getAllByRole("listitem")).toHaveLength(2);
    expect(within(card).getByText("claude-haiku-5-5 · 2026-11-01 23:30 KST · 오늘 1/20건")).toBeTruthy();
  });

  it("무료 회원에게는 요약 단추 대신 유료 등급 안내, 데모 열람은 쓰지 않는다는 안내", async () => {
    reads = appleReads();
    renderAs(FREE, <StockDetailScreen market="us" code="AAPL" />);
    await screen.findByRole("heading", { level: 1, name: "Apple Inc." });
    let card = screen.getByRole("heading", { name: "AI 요약" }).closest("section") as HTMLElement;
    expect(within(card).queryByRole("button")).toBeNull();
    expect(within(card).getByText("유료 등급 기능")).toBeTruthy();
    cleanup();

    renderAs({ email: null, role: "MEMBER", tier: "PRO", demo: true }, <StockDetailScreen market="us" code="AAPL" />);
    await screen.findByRole("heading", { level: 1, name: "Apple Inc." });
    card = screen.getByRole("heading", { name: "AI 요약" }).closest("section") as HTMLElement;
    expect(within(card).queryByRole("button")).toBeNull();
    expect(within(card).getByText("데모 열람에서는 AI 요약을 쓰지 않습니다.")).toBeTruthy();
  });

  it("시세를 조회하지 않으면(store_only) 그 이유를 적고, 값은 지어내지 않는다", async () => {
    reads = { [QUOTE]: { available: false, message: "store_only 모드에서는 외부 시세를 조회하지 않습니다." } };
    renderAs(PRO, <StockDetailScreen market="us" code="AAPL" />);
    expect(await screen.findByText("store_only 모드에서는 외부 시세를 조회하지 않습니다.")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "AAPL" })).toBeTruthy();
    // 회사 이름을 모르면 13F 보유 기관을 찾지 않는다
    expect(requested().some((path) => path.startsWith("/api/guru/holders"))).toBe(false);
  });
});

describe("종목 상세 — 국내", () => {
  it("네이버 시세(원 정수)·증권사 리포트, 13F 보유 기관은 찾지 않는다, 외부 링크는 네이버가 먼저", async () => {
    const quote = appleQuote({
      market: "kr", code: "005930", yahooSymbol: "005930.KS", name: "삼성전자", exchange: "코스피", currency: "KRW", kind: "stock",
      price: 71200, change: -800, changePct: -1.11, marketState: "CLOSE",
      stats: [{ key: "per", label: "PER", value: null, text: "13.21배", unit: "text" }],
      profile: null, consensus: { targetMean: 89000, recommendation: "4.00", analysts: null },
      research: [{ title: "메모리 회복", broker: "키움증권", date: "2026-10-30", url: "https://finance.naver.com/research/company_read.naver?nid=1" }],
      source: { label: "네이버 증권", url: "https://m.stock.naver.com/domestic/stock/005930" },
    });
    reads = { [endpoints.detail.quote("kr", "005930")]: { available: true, quote } };
    renderAs(PRO, <StockDetailScreen market="kr" code="005930" />);

    const hero = await screen.findByRole("region", { name: "삼성전자 시세" });
    expect(within(hero).getByText("71,200")).toBeTruthy();
    expect(within(hero).getByText("원")).toBeTruthy();
    expect(screen.getByText("13.21배")).toBeTruthy();
    expect(screen.getByText("89,000 원")).toBeTruthy();
    expect(screen.getByText("평균 4.00 / 5")).toBeTruthy();
    expect(screen.getByRole("link", { name: /메모리 회복/ }).getAttribute("href")).toBe("https://finance.naver.com/research/company_read.naver?nid=1");
    expect(requested()).toContain(endpoints.macro.ticker("005930.KS", "1y"));
    expect(requested().some((path) => path.startsWith("/api/guru/holders"))).toBe(false);
    const links = screen.getByRole("heading", { name: "다른 곳에서 보기" }).closest("section") as HTMLElement;
    expect(within(links).getAllByRole("link")[0].textContent).toContain("네이버 증권");
  });
});

describe("지표 상세", () => {
  const KR_HOLIDAYS = "/api/calendar/kr-holidays";

  it("카드 값 히어로·Yahoo 차트·같은 범주 지표(상세 링크)·뉴스 검색어·Yahoo 시세 상세 링크", async () => {
    reads = { [endpoints.macro.overview(false)]: macroOverview(), [KR_HOLIDAYS]: { available: true, years: {} } };
    renderAs(PRO, <IndicatorDetailScreen indicatorKey="sp500" />);

    expect(await screen.findByRole("heading", { level: 1, name: "S&P 500" })).toBeTruthy();
    const hero = screen.getByRole("region", { name: "S&P 500" });
    expect(within(hero).getByText("7,622.99")).toBeTruthy();
    expect(within(hero).getByText("차트: Yahoo Finance ^GSPC 일별 종가")).toBeTruthy();
    expect(requested()).toContain(endpoints.macro.ticker("^GSPC", "1y"));
    expect(requested()).toContain(endpoints.detail.news({ q: "S&P 500" }));
    expect(screen.getByRole("link", { name: /S&P 500 선물 \(ES\)/ }).getAttribute("href")).toBe("/markets/i/sp500_fut");
    expect(screen.getByRole("link", { name: "^GSPC 시세·핵심 지표 보기" }).getAttribute("href")).toBe("/s/us/%5EGSPC");
  });

  it("뜻이 다른 티커(2년물 ZT=F)는 차트를 부르지 않고 이유를 적는다, 없는 키는 그렇게 말한다", async () => {
    const overview = macroOverview();
    overview.categories.push({
      id: "ust",
      title: "미국 국채 수익률",
      items: [{ key: "us02y", name: "미국채 2년물 수익률(%)", ticker: "ZT=F", status: "ok", priceStr: "3.512", market: "ust" }],
    });
    reads = { [endpoints.macro.overview(false)]: overview, [KR_HOLIDAYS]: { available: true, years: {} } };
    renderAs(PRO, <IndicatorDetailScreen indicatorKey="us02y" />);
    expect(await screen.findByText(/Yahoo 티커 ZT=F는 선물 가격이라 차트를 그리지 않습니다/)).toBeTruthy();
    expect(requested().some((path) => path.startsWith("/api/macro/ticker"))).toBe(false);
    expect(requested()).toContain(endpoints.detail.news({ q: "미국채 2년물 수익률" }));
    cleanup();

    renderAs(PRO, <IndicatorDetailScreen indicatorKey="nope" />);
    expect(await screen.findByRole("heading", { level: 1, name: "지표를 찾지 못했습니다" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "매크로 지표 전체 보기" }).getAttribute("href")).toBe("/macro");
  });
});

describe("기관 상세", () => {
  it("13F 보고 평가액·분기 추이·상위 보유 종목·기관 소개·뉴스(영문 이름)·SEC 링크", async () => {
    reads = {
      [endpoints.institution.portfolio("0001067983", 8, 30)]: {
        available: true,
        cik: "0001067983",
        institution: { name: "🇺🇸 버크셔 해서웨이 (Berkshire Hathaway)", desc: "가치투자 포트폴리오" },
        collectedAtKst: "2026-11-01 09:00 KST",
        ageSeconds: 3600,
        quarters: [
          { filingDate: "2026-08-14", reportDate: "2026-06-30", totalValue: 280_000_000_000, holdingCount: 40 },
          { filingDate: "2026-05-15", reportDate: "2026-03-31", totalValue: 260_000_000_000, holdingCount: 41 },
        ],
        latest: { reportDate: "2026-06-30", filingDate: "2026-08-14", totalValue: 280_000_000_000 },
        holdings: [
          { name: "APPLE INC", cusip: "037833100", class: "COM", value: 60_000_000_000, shares: 300_000_000, weight: 21.5, weightDiff: -1.25, sharesDiff: null, action: "감소" },
          { name: "NEW CO", cusip: "000000000", class: "COM", value: null, shares: null, weight: null, weightDiff: null, sharesDiff: null, action: "신규" },
        ],
      },
    };
    renderAs(PRO, <InstitutionDetailScreen cik="0001067983" />);

    expect(await screen.findByRole("heading", { level: 1, name: "버크셔 해서웨이 (Berkshire Hathaway)" })).toBeTruthy();
    const hero = screen.getByRole("region", { name: "13F 보고 평가액" });
    expect(within(hero).getByText("2,800억 달러")).toBeTruthy();
    expect(within(hero).getByText("보고 기준일 2026-06-30 · 공시일 2026-08-14")).toBeTruthy();
    expect(within(hero).getByRole("img", { name: "버크셔 해서웨이 (Berkshire Hathaway) 분기별 13F 보고 평가액" })).toBeTruthy();
    expect(screen.getByText("COM · 감소 · 비중 −1.25%p")).toBeTruthy();
    expect(screen.getByText("21.50%")).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getByText("가치투자 포트폴리오")).toBeTruthy();
    expect(requested()).toContain(endpoints.detail.news({ q: "Berkshire Hathaway" }));
    expect(screen.getByRole("link", { name: /SEC EDGAR 13F 공시/ }).getAttribute("href")).toBe(
      "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001067983&type=13F-HR",
    );
  });
});

describe("라우트", () => {
  it("시장·코드·CIK·지표 키 모양이 틀리면 404, 맞으면 그 화면", async () => {
    await expect(StockDetailPage({ params: Promise.resolve({ market: "jp", code: "7203" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(StockDetailPage({ params: Promise.resolve({ market: "kr", code: "5930" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(InstitutionDetailPage({ params: Promise.resolve({ cik: "abc" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(IndicatorDetailPage({ params: Promise.resolve({ id: "a%2Fb" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    const page = await StockDetailPage({ params: Promise.resolve({ market: "us", code: "brk-b" }) });
    expect(page.props).toMatchObject({ market: "us", code: "BRK-B" });
  });
});
