/**
 * 검색 상세 화면 — 종목(/s/…)·지표(/markets/i/…)·기관(/institutions/<CIK>)을 고정 응답으로 그려 본다.
 *  - 값 있음: 시세 히어로·핵심 지표·회사 개요·애널리스트 의견·뉴스(원문 새 창 링크)·13F 보유 기관(기관 상세 링크)·외부 링크
 *  - 값 없음: 조회하지 않음(store_only)·받지 못함은 그 이유, 모르는 값은 "—"(0으로 채우지 않음), http(s)가 아닌 주소는 링크로 두지 않음
 *  - AI 요약: 유료·운영자만 단추, 누를 때만 부르고 근거 번호를 출처 링크로, 무료 회원은 자물쇠 안내
 *  - 라우트: 시장·코드·CIK·지표 키 모양이 틀리면 404(notFound)
 *  - 종목 팝업 창: 이름 아래 간략한 기업 설명(업종·한국어 개요 앞부분·출처), 영문 원문이면 그렇게 적고, 개요가 없으면 그리지 않는다
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
// 그림 대신 이름만 — 차트가 받은 행과 문지르기 함수는 마지막 것을 charts에 둡니다(지표 상세의 단위 배율 시험, QA-185).
const charts = vi.hoisted(() => ({ last: null as null | { data: Record<string, unknown>[]; onScrub?: (index: number | null) => void } }));
vi.mock("@/components/charts", () => ({
  LineChart: ({ ariaLabel, data, onScrub }: { ariaLabel?: string; data: Record<string, unknown>[]; onScrub?: (index: number | null) => void }) => {
    charts.last = { data, onScrub };
    return <div role="img" aria-label={ariaLabel} />;
  },
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
import { StockQuickView } from "../StockQuickView";

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

  // QA-190과 같은 원인: 시세 읽기가 실패했거나 조회하지 않으면(store_only) 히어로는 그 이유를 적지만, '핵심 지표' 카드는 시세가 없으면 늘 '불러오는 중'
  // (role=status, aria-busy)이었습니다. 카드도 그 이유를, 실패면 다시 시도 단추를 그립니다.
  it("QA-190 시세를 읽지 못했거나 조회하지 않으면 핵심 지표 카드도 '불러오는 중'이 아니라 그 이유(실패면 다시 시도)", async () => {
    reads = { [QUOTE]: { available: false, message: "store_only 모드에서는 외부 시세를 조회하지 않습니다." } };
    const { unmount } = renderAs(PRO, <StockDetailScreen market="us" code="AAPL" />);
    await screen.findAllByText("store_only 모드에서는 외부 시세를 조회하지 않습니다.");
    expect(screen.queryByRole("status", { name: "핵심 지표를 불러오는 중" })).toBeNull();
    expect(screen.getByText("시세를 받지 않아 핵심 지표가 없습니다.")).toBeTruthy();
    unmount();

    reads = { [QUOTE]: new Error("시세 서버가 응답하지 않습니다.") };
    renderAs(PRO, <StockDetailScreen market="us" code="AAPL" />);
    await waitFor(() => expect(screen.getAllByText("시세 서버가 응답하지 않습니다.").length).toBeGreaterThan(0));
    expect(screen.queryByRole("status", { name: "핵심 지표를 불러오는 중" })).toBeNull();
    const card = screen.getByRole("heading", { level: 2, name: "핵심 지표" }).closest("section") as HTMLElement;
    const before = requested().filter((entry) => entry === QUOTE).length;
    fireEvent.click(within(card).getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(requested().filter((entry) => entry === QUOTE)).toHaveLength(before + 1));
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
    await waitFor(() => expect(requested()).toContain(endpoints.macro.ticker("005930.KS", "1y")));
    expect(requested().some((path) => path.startsWith("/api/guru/holders"))).toBe(false);
    const links = screen.getByRole("heading", { name: "다른 곳에서 보기" }).closest("section") as HTMLElement;
    expect(within(links).getAllByRole("link")[0].textContent).toContain("네이버 증권");
  });
});

describe("종목 팝업 창", () => {
  const trigger = <button type="button">AAPL 열기</button>;
  const koSource = { label: "네이버 증권 해외주식 기업 개요", url: "https://m.stock.naver.com/worldstock/stock/AAPL.O/overview" };

  it("이름 아래 간략한 기업 설명 — 업종(한국어)·개요 앞 문장들·출처, 전체 개요는 상세 화면", async () => {
    const summaryKo = "애플은 스마트폰, 개인용 컴퓨터, 태블릿, 웨어러블을 설계·제조·판매한다.\n제품은 iPhone, Mac, iPad를 포함한다.\n\n"
      + "서비스는 광고, AppleCare, 클라우드 서비스, 디지털 콘텐츠와 결제 서비스를 포함하며 앱스토어를 통해 다양한 앱을 판다.\n"
      + "고객이 애플리케이션과 책, 음악, 비디오, 게임, 팟캐스트를 찾아 내려받을 수 있는 플랫폼도 운영한다.";
    reads = { [QUOTE]: { available: true, quote: appleQuote({ nameKo: "애플",
      profile: { ...appleQuote().profile!, summaryKo, industryKo: "전화 및 소형 장치", koSource } }) } };
    renderAs(PRO, <StockQuickView market="us" code="AAPL" trigger={trigger} />);
    fireEvent.click(screen.getByRole("button", { name: "AAPL 열기" }));

    const brief = await screen.findByRole("region", { name: "기업 설명" });
    expect(within(brief).getByText("기술 · 전화 및 소형 장치")).toBeTruthy();
    // 160자 안의 문장까지(넷째 문장은 빠짐 — 줄바꿈은 공백)
    expect(within(brief).getByText("애플은 스마트폰, 개인용 컴퓨터, 태블릿, 웨어러블을 설계·제조·판매한다. 제품은 iPhone, Mac, iPad를 포함한다. "
      + "서비스는 광고, AppleCare, 클라우드 서비스, 디지털 콘텐츠와 결제 서비스를 포함하며 앱스토어를 통해 다양한 앱을 판다.")).toBeTruthy();
    expect(within(brief).queryByText(/팟캐스트/)).toBeNull();
    expect(within(brief).getByText("출처 네이버 증권 해외주식 기업 개요 · 전체 개요는 상세 화면")).toBeTruthy();
    expect(screen.getByRole("link", { name: "상세 화면 열기" }).getAttribute("href")).toBe("/s/us/AAPL");
  });

  it("한국어 개요가 없으면 영문 원문 앞부분이라고 적고, 개요가 없으면 설명을 그리지 않는다", async () => {
    reads = { [QUOTE]: { available: true, quote: appleQuote() } };
    const { unmount } = renderAs(PRO, <StockQuickView market="us" code="AAPL" trigger={trigger} />);
    fireEvent.click(screen.getByRole("button", { name: "AAPL 열기" }));
    const brief = await screen.findByRole("region", { name: "기업 설명" });
    expect(within(brief).getByText("Apple designs devices.")).toBeTruthy();
    expect(within(brief).getByText(/한국어 개요가 없어 영문 원문의 앞부분입니다/)).toBeTruthy();
    unmount();

    reads = { [QUOTE]: { available: true, quote: appleQuote({ profile: null }) } };
    renderAs(PRO, <StockQuickView market="us" code="AAPL" trigger={trigger} />);
    fireEvent.click(screen.getByRole("button", { name: "AAPL 열기" }));
    await screen.findByRole("link", { name: "상세 화면 열기" });
    await waitFor(() => expect(screen.getByText("Apple Inc.")).toBeTruthy());
    expect(screen.queryByRole("region", { name: "기업 설명" })).toBeNull();
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
    await waitFor(() => expect(requested()).toContain(endpoints.macro.ticker("^GSPC", "1y")));
    await waitFor(() => expect(requested()).toContain(endpoints.detail.news({ q: "S&P 500" })));
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
    // 뉴스 카드는 지표를 찾은 뒤 따로 부르므로 이유 문장보다 늦게 요청될 수 있다(간헐 실패 — 2026-11-02 검증)
    await waitFor(() => expect(requested()).toContain(endpoints.detail.news({ q: "미국채 2년물 수익률" })));
    cleanup();

    renderAs(PRO, <IndicatorDetailScreen indicatorKey="nope" />);
    expect(await screen.findByRole("heading", { level: 1, name: "지표를 찾지 못했습니다" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "매크로 지표 전체 보기" }).getAttribute("href")).toBe("/macro");
  });

  // QA-185: 엔/원 카드는 100엔당(수집기 market.quote_scale이 1엔당 값에 100을 곱함)인데, 지표 상세 차트는 카드 티커 JPYKRW=X의 Yahoo 1엔당 원값을
  // 그대로 그려 차트·문지른 큰 숫자가 940에서 9.4로 바뀌었습니다. 차트 점에도 카드와 같은 배율 규칙(점마다 — 이미 100엔당이면 그대로)을 씁니다.
  it("QA-185 엔/원 100엔당 카드의 차트·문지른 값은 카드와 같은 단위(1엔당 점 × 100, 이미 100엔당인 점은 그대로)", async () => {
    const overview = macroOverview();
    overview.categories.push({
      id: "fx2",
      title: "환율",
      items: [{ key: "jpykrw", name: "엔/원 100엔당 (JPY/KRW)", ticker: "JPYKRW=X", status: "ok", priceStr: "940.12", deltaStr: "+1.20 (+0.13%)",
        market: "fx" }],
    });
    reads = {
      [endpoints.macro.overview(false)]: overview,
      [KR_HOLIDAYS]: { available: true, years: {} },
      [endpoints.macro.ticker("JPYKRW=X", "1y")]: { available: true, points: [
        { date: "2026-10-01", close: 9.31 }, { date: "2026-10-02", close: 935.5 }, { date: "2026-11-03", close: 9.41 },
      ] },
    };
    renderAs(PRO, <IndicatorDetailScreen indicatorKey="jpykrw" />);
    const hero = await screen.findByRole("region", { name: "엔/원 100엔당 (JPY/KRW)" });
    await waitFor(() => expect(within(hero).getByRole("img", { name: "엔/원 100엔당 (JPY/KRW) 가격 차트" })).toBeTruthy());
    const values = (charts.last?.data ?? []).map((row) => row.close as number);
    expect(values.map((value) => Math.round(value * 100) / 100)).toEqual([931, 935.5, 941]);
    act(() => charts.last?.onScrub?.(2));
    expect(within(hero).getByText("941.00")).toBeTruthy();
    expect(within(hero).queryByText("9.41")).toBeNull();
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
    await waitFor(() => expect(requested()).toContain(endpoints.detail.news({ q: "Berkshire Hathaway" })));
    expect(screen.getByRole("link", { name: /SEC EDGAR 13F 공시/ }).getAttribute("href")).toBe(
      "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001067983&type=13F-HR",
    );
  });

  // QA-190: 13F 포트폴리오 읽기가 실패하면(추적하지 않는 CIK는 400, 백엔드 일시 실패) 히어로는 오류를 보였지만 상위 보유 종목 카드는 error를 보지 않아
  // '불러오는 중'(role=status, aria-busy)으로 남았습니다. 카드도 오류와 다시 시도 단추를 그립니다.
  it("QA-190 13F 포트폴리오를 읽지 못하면 상위 보유 종목 카드는 '불러오는 중'이 아니라 오류와 다시 시도", async () => {
    const path = endpoints.institution.portfolio("1234567", 8, 30);
    reads = { [path]: new Error("추적하지 않는 기관입니다.") };
    renderAs(PRO, <InstitutionDetailScreen cik="1234567" />);
    await waitFor(() => expect(screen.getAllByText("추적하지 않는 기관입니다.").length).toBeGreaterThan(0));
    expect(screen.queryByRole("status", { name: "보유 종목을 불러오는 중" })).toBeNull();
    const card = screen.getByRole("heading", { level: 2, name: "상위 보유 종목" }).closest("section") as HTMLElement;
    expect(within(card).getByText("추적하지 않는 기관입니다.")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(requested().filter((entry) => entry === path)).toHaveLength(2));
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

describe("뉴스 카드의 정보 검색 링크(ADR 0041)", () => {
  const newsCard = async () => (await screen.findByRole("heading", { name: "주요 뉴스" })).closest("section") as HTMLElement;

  it("종목 — 회사 이름으로 정보 검색(/search?q=)", async () => {
    reads = appleReads();
    renderAs(FREE, <StockDetailScreen market="us" code="AAPL" />);
    const card = await newsCard();
    await waitFor(() =>
      expect(within(card).getByRole("link", { name: "정보 검색" }).getAttribute("href")).toBe(`/search?q=${encodeURIComponent("Apple Inc.")}`),
    );
  });

  it("기관 — 영문 이름, 지표 — 뉴스 검색어와 같은 말로", async () => {
    reads = { [endpoints.macro.overview(false)]: macroOverview(), "/api/calendar/kr-holidays": { available: true, years: {} } };
    renderAs(PRO, <IndicatorDetailScreen indicatorKey="sp500" />);
    expect(within(await newsCard()).getByRole("link", { name: "정보 검색" }).getAttribute("href")).toBe(`/search?q=${encodeURIComponent("S&P 500")}`);
    cleanup();

    reads = {};
    renderAs(PRO, <InstitutionDetailScreen cik="0001067983" />);
    await waitFor(async () =>
      expect(within(await newsCard()).getByRole("link", { name: "정보 검색" }).getAttribute("href")).toMatch(/^\/search\?q=/),
    );
  });
});
