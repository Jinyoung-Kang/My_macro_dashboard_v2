/**
 * 검색 상세 화면의 표시 규칙(lib/detail) — 주소와 주소 조각 검사, 차트 행, 값 글(없으면 "—"), 뉴스 시각, 검색어, 외부 링크, AI 요약 줄.
 */
import { describe, expect, it } from "vitest";
import {
  briefSummary,
  chartRows,
  consensusItems,
  holderDetailItems,
  holdingDetailItems,
  indicatorForSymbol,
  indicatorProperties,
  infoSearchEntityLink,
  institutionEntityKey,
  institutionProperties,
  moneyPriceText,
  profileItems,
  stockEntityKey,
  stockStatItems,
  websiteHref,
  chartSymbol,
  countText,
  externalLinks,
  findIndicator,
  holderQuery,
  indicatorChartRows,
  indicatorChartSymbol,
  indicatorHref,
  indicatorNewsQuery,
  indicatorSearchName,
  institutionHref,
  institutionLinks,
  institutionNames,
  institutionValueRows,
  kindText,
  countryKo,
  marketStateText,
  moneyText,
  newsPage,
  newsTime,
  sectorKo,
  parseCik,
  parseIndicatorKey,
  parseStockRoute,
  priceDigits,
  recommendationText,
  statText,
  stockHref,
  quickProfile,
  summaryLines,
} from "../detail";
import { macroOverview } from "./homeFixtures";
import type { DetailQuote, GuruHoldersResponse, Holding, MacroOverview, PortfolioResponse, SessionUser } from "../types";

describe("주소", () => {
  it("상세 주소는 코드를 한 조각으로 인코딩한다", () => {
    expect(stockHref("us", "^GSPC")).toBe("/s/us/%5EGSPC");
    expect(stockHref("us", "KRW=X")).toBe("/s/us/KRW%3DX");
    expect(stockHref("kr", "005930")).toBe("/s/kr/005930");
    expect(indicatorHref("us10y")).toBe("/markets/i/us10y");
    expect(institutionHref("0001067983")).toBe("/institutions/0001067983");
  });

  it("종목 주소 조각 — 백엔드와 같은 규칙(us는 Yahoo 심볼 형식·대문자, kr는 6자리), 틀리면 null", () => {
    expect(parseStockRoute("us", "aapl")).toEqual({ market: "us", code: "AAPL" });
    expect(parseStockRoute("US", "%5Egspc")).toEqual({ market: "us", code: "^GSPC" });
    expect(parseStockRoute("us", "BRK-B")).toEqual({ market: "us", code: "BRK-B" });
    expect(parseStockRoute("kr", "005930")).toEqual({ market: "kr", code: "005930" });
    expect(parseStockRoute("kr", "0088m0")).toEqual({ market: "kr", code: "0088M0" });
    expect(parseStockRoute("kr", "05930")).toBeNull();
    expect(parseStockRoute("jp", "7203")).toBeNull();
    expect(parseStockRoute("us", "a b")).toBeNull();
    expect(parseStockRoute("us", "%E0%A4%A")).toBeNull();
    expect(parseStockRoute("us", "x".repeat(25))).toBeNull();
  });

  it("CIK·지표 키 조각 — CIK는 숫자 1~10자리(앞 0 유지), 키는 영문·숫자·_·-", () => {
    expect(parseCik("0001067983")).toBe("0001067983");
    expect(parseCik("12a")).toBeNull();
    expect(parseCik("12345678901")).toBeNull();
    expect(parseIndicatorKey("sp500_fut")).toBe("sp500_fut");
    expect(parseIndicatorKey("a%2Fb")).toBeNull();
    expect(parseIndicatorKey("%")).toBeNull();
  });

  it("차트 심볼 — 시세 응답의 값, 아직 없으면 미국은 코드·국내는 .KS 어림", () => {
    expect(chartSymbol("kr", "035720", { yahooSymbol: "035720.KQ" } as DetailQuote)).toBe("035720.KQ");
    expect(chartSymbol("kr", "005930", null)).toBe("005930.KS");
    expect(chartSymbol("us", "AAPL", undefined)).toBe("AAPL");
  });
});

describe("차트 행", () => {
  it("종가(없으면 값)를 날짜별로, 모르는 값은 null — 0으로 채우지 않는다", () => {
    expect(
      chartRows([
        { date: "2026-10-30T00:00:00-04:00", close: 344.6 },
        { date: "2026-10-31", close: null, value: 345 },
        { date: "2026-11-01", close: null },
        { date: "2026-11-02", close: Number.NaN },
      ]),
    ).toEqual([
      { date: "2026-10-30", close: 344.6 },
      { date: "2026-10-31", close: 345 },
      { date: "2026-11-01", close: null },
      { date: "2026-11-02", close: null },
    ]);
    expect(chartRows(undefined)).toEqual([]);
  });

  it("기관 평가액 추이 — 보고 기준일 오름차순", () => {
    expect(
      institutionValueRows([
        { reportDate: "2026-06-30", totalValue: 300 },
        { reportDate: "2026-03-31", totalValue: null },
      ]),
    ).toEqual([
      { date: "2026-03-31", close: null },
      { date: "2026-06-30", close: 300 },
    ]);
  });
});

describe("값 글", () => {
  it("핵심 지표 — 국내 글은 그대로, 단위별 서식, 없으면 '—'", () => {
    expect(statText({ key: "per", label: "PER", value: null, text: "39.52배", unit: "text" }, "KRW")).toBe("39.52배");
    expect(statText({ key: "cap", label: "시가총액", value: 5_029_592_301_568, text: null, unit: "money" }, "USD")).toBe("5.030조 달러");
    expect(statText({ key: "vol", label: "거래량", value: 45_210_000, text: null, unit: "count" }, "USD")).toBe("4,521만");
    expect(statText({ key: "pe", label: "PER", value: 39.517, text: null, unit: "x" }, "USD")).toBe("39.52배");
    expect(statText({ key: "dy", label: "배당수익률", value: 0.41, text: null, unit: "pct" }, "USD")).toBe("0.41%");
    expect(statText({ key: "hi", label: "52주 최고", value: 360.1, text: null, unit: "price" }, "USD")).toBe("360.10");
    expect(statText({ key: "pe", label: "PER", value: null, text: null, unit: "x" }, "USD")).toBe("—");
    expect(moneyText(null, "USD")).toBe("—");
    expect(moneyText(1.2e12, "KRW")).toBe("1.200조 원");
    expect(moneyText(2.5e8, "EUR")).toBe("2.5억 EUR");
    expect(countText(undefined)).toBe("—");
  });

  it("가격 자릿수 — 원·엔 정수, 1 미만 넷째, 그 밖 둘째", () => {
    expect(priceDigits(71_000, "KRW")).toBe(0);
    expect(priceDigits(150.2, "JPY")).toBe(0);
    expect(priceDigits(0.0072, "USD")).toBe(4);
    expect(priceDigits(344.6, "USD")).toBe(2);
    expect(priceDigits(null, null)).toBe(2);
  });

  it("투자의견·장 상태·종류를 한국어로, 모르면 null(종류는 그대로)", () => {
    expect(recommendationText("us", "strong_buy")).toBe("적극 매수");
    expect(recommendationText("us", "weird")).toBe("weird");
    expect(recommendationText("kr", "4.00")).toBe("평균 4.00 / 5");
    expect(recommendationText("kr", null)).toBeNull();
    expect(marketStateText("REGULAR")).toBe("장중");
    expect(marketStateText("CLOSE")).toBe("장 마감");
    expect(marketStateText("POSTPOST")).toBe("시간 외 거래");
    expect(marketStateText(null)).toBeNull();
    expect(kindText("EQUITY")).toBe("주식");
    expect(kindText("stock")).toBe("주식");
    expect(kindText("OPTION")).toBe("OPTION");
    expect(kindText(null)).toBeNull();
  });

  it("뉴스 시각 — 분·시간·일 전, 일주일이 넘거나 앞날이면 KST 시각, 모르면 '시각 모름'", () => {
    const now = new Date("2026-11-01T14:30:00Z");
    expect(newsTime("2026-11-01T14:29:50Z", now)).toBe("1분 전");
    expect(newsTime("2026-11-01T14:00:00Z", now)).toBe("30분 전");
    expect(newsTime("2026-11-01T09:00:00Z", now)).toBe("5시간 전");
    expect(newsTime("2026-10-29T14:30:00Z", now)).toBe("3일 전");
    expect(newsTime("2026-10-01T00:00:00Z", now)).toBe("2026-10-01 09:00");
    expect(newsTime("2026-11-02T00:00:00Z", now)).toBe("2026-11-02 09:00");
    expect(newsTime(null, now)).toBe("시각 모름");
    expect(newsTime("어제", now)).toBe("시각 모름");
  });
});

describe("팝업 창의 기업 설명", () => {
  it("짧으면 그대로, 길면 상한 안의 문장까지 — 줄바꿈은 공백, 띄어 쓰지 않은 한국어 문장 끝도 나눔", () => {
    expect(briefSummary("동사는 반도체 기업임.\n주력은 DRAM임.", 160)).toBe("동사는 반도체 기업임. 주력은 DRAM임.");
    expect(briefSummary("첫 문장입니다. 둘째 문장은 조금 깁니다. 셋째 문장은 상한을 넘깁니다.", 30)).toBe("첫 문장입니다. 둘째 문장은 조금 깁니다.");
    expect(briefSummary("목표로 합니다.한국거래소가 산출하는 지수는 200개 종목입니다.", 20)).toBe("목표로 합니다.");
    expect(briefSummary("  ", 10)).toBeNull();
    expect(briefSummary(null)).toBeNull();
  });

  it("첫 문장부터 길거나 짧은 조각뿐이면 상한에서 단어 경계로 자르고 '…'", () => {
    const apple = "Apple Inc. designs, manufactures, and markets smartphones, personal computers, tablets, wearables, and accessories worldwide.";
    expect(briefSummary(apple, 40)).toBe("Apple Inc. designs, manufactures, and…");
    expect(briefSummary("가".repeat(50), 20)).toBe(`${"가".repeat(20)}…`);
  });

  it("한국어 개요가 있으면 한국어와 그 출처, 없으면 원문(미국이면 영문 표시), 업종은 한국어 이름, 개요가 없으면 null", () => {
    const base = { market: "us", source: { label: "Yahoo Finance", url: "https://finance.yahoo.com/quote/AAPL" } };
    const profile = { sector: "Technology", industry: "Consumer Electronics", country: null, website: null, employees: null,
      summary: "Apple designs phones.", summaryKo: "애플은 휴대폰을 설계한다.", industryKo: "전화 및 소형 장치",
      koSource: { label: "네이버 증권 해외주식 기업 개요", url: "https://m.stock.naver.com/worldstock/stock/AAPL.O/overview" } };
    expect(quickProfile({ ...base, profile } as unknown as DetailQuote)).toEqual({
      industry: "기술 · 전화 및 소형 장치", text: "애플은 휴대폰을 설계한다.", english: false, source: "네이버 증권 해외주식 기업 개요" });
    expect(quickProfile({ ...base, profile: { ...profile, summaryKo: null, industryKo: null, koSource: null } } as unknown as DetailQuote))
      .toEqual({ industry: "기술 · Consumer Electronics", text: "Apple designs phones.", english: true, source: "Yahoo Finance" });
    const etf = { market: "kr", source: { label: "네이버 증권", url: "https://m.stock.naver.com" },
      profile: { sector: null, industry: null, country: "대한민국", website: null, employees: null, summary: "KOSPI200을 따라갑니다." } };
    expect(quickProfile(etf as unknown as DetailQuote)).toEqual({ industry: null, text: "KOSPI200을 따라갑니다.", english: false, source: "네이버 증권" });
    expect(quickProfile({ ...etf, profile: { ...etf.profile, summary: null } } as unknown as DetailQuote)).toBeNull();
    expect(quickProfile({ ...etf, profile: null } as unknown as DetailQuote)).toBeNull();
    expect(quickProfile(null)).toBeNull();
  });
});

describe("한국어 이름·뉴스 쪽", () => {
  it("섹터·나라는 한국어 이름, 모르면 받은 글 그대로, 없으면 null", () => {
    expect(sectorKo("Technology")).toBe("기술");
    expect(sectorKo("Consumer Cyclical")).toBe("경기소비재");
    expect(sectorKo("Shell Companies")).toBe("Shell Companies");
    expect(sectorKo(null)).toBeNull();
    expect(countryKo("United States")).toBe("미국");
    expect(countryKo("Luxembourg")).toBe("Luxembourg");
    expect(countryKo(undefined)).toBeNull();
  });

  it("뉴스는 쪽당 5건 — 쪽 수는 올림, 범위 밖 쪽은 가까운 끝, 비면 1쪽", () => {
    const items = Array.from({ length: 12 }, (_, at) => at);
    expect(newsPage(items, 1)).toEqual({ items: [0, 1, 2, 3, 4], page: 1, pages: 3 });
    expect(newsPage(items, 3)).toEqual({ items: [10, 11], page: 3, pages: 3 });
    expect(newsPage(items, 9).page).toBe(3);
    expect(newsPage(items, 0).page).toBe(1);
    expect(newsPage([], 1)).toEqual({ items: [], page: 1, pages: 1 });
  });
});

describe("지표", () => {
  const OVERVIEW = {
    categories: [
      { id: "ust", title: "미국 국채 수익률", items: [{ key: "us02y", name: "미국채 2년물 수익률(%)", ticker: "ZT=F", status: "ok" }, { key: "us10y", name: "미국채 10년물 수익률(%)", ticker: "^TNX", status: "ok" }] },
      { id: "x", title: "기타", items: [{ key: "odd", name: "티커 없음", ticker: null, status: "ok" }] },
    ],
  } as unknown as MacroOverview;

  it("저장본에서 지표와 범주를 찾고, 없으면 null", () => {
    expect(findIndicator(OVERVIEW, "us10y")?.category.id).toBe("ust");
    expect(findIndicator(OVERVIEW, "nope")).toBeNull();
    expect(findIndicator(null, "us10y")).toBeNull();
  });

  it("QA-185 지표 차트 행은 카드 단위 — 엔/원은 1엔당 점만 × 100(이미 100엔당인 점·모르는 값은 그대로), 다른 지표는 원값", () => {
    const points = [{ date: "2026-10-01", close: 9.31 }, { date: "2026-10-02", close: 935.5 }, { date: "2026-10-03", close: null }];
    expect(indicatorChartRows("jpykrw", points).map((row) => row.close)).toEqual([931, 935.5, null]);
    expect(indicatorChartRows("usdjpy", [{ date: "2026-10-01", close: 9.31 }])).toEqual(chartRows([{ date: "2026-10-01", close: 9.31 }]));
    expect(indicatorChartRows("jpykrw", undefined)).toEqual([]);
  });

  it("차트 심볼 — 카드 티커, 뜻이 다른 티커(2년물 ZT=F 선물 가격)·티커 없음은 null", () => {
    const [us02y, us10y] = OVERVIEW.categories[0].items;
    expect(indicatorChartSymbol(us10y)).toBe("^TNX");
    expect(indicatorChartSymbol(us02y)).toBeNull();
    expect(indicatorChartSymbol(OVERVIEW.categories[1].items[0])).toBeNull();
  });

  it("검색어 — 뉴스는 괄호(단위·약칭)를 뗀 이름, 외부 검색은 괄호 안 영문 약칭", () => {
    expect(indicatorNewsQuery("미국채 10년물 수익률(%)")).toBe("미국채 10년물 수익률");
    expect(indicatorNewsQuery("달러 인덱스 (DXY)")).toBe("달러 인덱스");
    expect(indicatorNewsQuery("S&P 500")).toBe("S&P 500");
    expect(indicatorSearchName("달러 인덱스 (DXY)")).toBe("DXY");
    expect(indicatorSearchName("WTI 원유 ($)")).toBe("WTI 원유");
  });
});

describe("이름·검색어", () => {
  it("기관 — 화면은 국기만 뗀 이름, 뉴스 검색어는 괄호 안 영문(없으면 한글 이름)", () => {
    expect(institutionNames("🇺🇸 버크셔 해서웨이 (Berkshire Hathaway)")).toEqual({ display: "버크셔 해서웨이 (Berkshire Hathaway)", query: "Berkshire Hathaway" });
    expect(institutionNames("국민연금")).toEqual({ display: "국민연금", query: "국민연금" });
  });

  it("13F 보유 기관 검색어 — 법인 꼬리·기호를 뗀 대문자, 너무 짧으면 null", () => {
    expect(holderQuery("Apple Inc.")).toBe("APPLE");
    expect(holderQuery("NVIDIA Corporation")).toBe("NVIDIA");
    expect(holderQuery("Berkshire Hathaway Inc. Class B")).toBe("BERKSHIRE HATHAWAY");
    expect(holderQuery("The Walt Disney Company")).toBe("WALT DISNEY");
    expect(holderQuery("X")).toBeNull();
    expect(holderQuery(null)).toBeNull();
  });
});

describe("외부 링크", () => {
  it("미국 보통주는 Yahoo·Google Finance·Investing.com·SEC EDGAR, 지수·환율·선물에는 SEC를 붙이지 않는다", () => {
    expect(externalLinks("us", "AAPL", "AAPL", "Apple Inc.").map((link) => link.label)).toEqual(["Yahoo Finance", "Google Finance", "Investing.com", "SEC EDGAR 공시"]);
    expect(externalLinks("us", "BRK-B", "BRK-B").at(-1)?.url).toBe("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=BRK-B");
    const index = externalLinks("us", "^GSPC", "^GSPC");
    expect(index.map((link) => link.label)).toEqual(["Yahoo Finance", "Google Finance", "Investing.com"]);
    expect(index[0].url).toBe("https://finance.yahoo.com/quote/%5EGSPC");
    expect(index[2].url).toBe("https://www.investing.com/search/?q=%5EGSPC");
  });

  it("국내는 네이버 증권을 먼저, Google Finance는 KRX, DART 공시 검색까지", () => {
    const links = externalLinks("kr", "005930", "005930.KS", "삼성전자");
    expect(links.map((link) => link.label)).toEqual(["네이버 증권", "Google Finance", "Yahoo Finance", "Investing.com", "DART 공시"]);
    expect(links[0].url).toBe("https://m.stock.naver.com/domestic/stock/005930");
    expect(links[1].url).toBe("https://www.google.com/finance/quote/005930:KRX");
    expect(links[2].url).toBe("https://finance.yahoo.com/quote/005930.KS");
  });

  it("기관은 SEC EDGAR 13F 공시 목록", () => {
    expect(institutionLinks("0001067983")).toEqual([
      { label: "SEC EDGAR 13F 공시", url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001067983&type=13F-HR" },
    ]);
  });
});

describe("AI 요약 줄", () => {
  it("줄 끝 근거 번호를 떼어 refs로, '- '는 목록·'…:'는 머리 줄, 빈 줄은 뺀다", () => {
    expect(summaryLines("한 줄 요약: 애플은 하락 마감 [1]\n\n핵심:\n- 실적 상회 [2][3]\n- 목표가 상향 [1, 4]\n지켜볼 점: 없음")).toEqual([
      { text: "한 줄 요약: 애플은 하락 마감", refs: [1], kind: "text" },
      { text: "핵심:", refs: [], kind: "heading" },
      { text: "실적 상회", refs: [2, 3], kind: "bullet" },
      { text: "목표가 상향", refs: [1, 4], kind: "bullet" },
      { text: "지켜볼 점: 없음", refs: [], kind: "text" },
    ]);
    expect(summaryLines(null)).toEqual([]);
  });
});

describe("속성(대상 화면 왼쪽 칸·검사 칸)", () => {
  const quote = (overrides: Partial<DetailQuote> = {}): DetailQuote => ({
    market: "us", code: "SYNQ", yahooSymbol: "SYNQ", name: "Synthetic Quote Inc.", exchange: "NYSE", currency: "USD", kind: "EQUITY",
    price: 10, previousClose: 9.5, change: 0.5, changePct: 5.26, asOf: null, marketState: null,
    stats: [
      { key: "marketCap", label: "시가총액", value: 5_029_592_301_568, text: null, unit: "money" },
      { key: "trailingPE", label: "PER", value: 0, text: null, unit: "x" },
      { key: "dividendYield", label: "배당수익률", value: null, text: null, unit: "pct" },
      { key: "per", label: "PER(네이버)", value: null, text: "13.21배", unit: "text" },
    ],
    profile: null, consensus: null, research: [], source: null, error: null, fetchedAt: null,
    ...overrides,
  });

  it("핵심 지표 — 단위대로, 0은 값, 모르면 null(화면이 '—')", () => {
    expect(stockStatItems(quote())).toEqual([
      { key: "marketCap", label: "시가총액", value: "5.030조 달러" },
      { key: "trailingPE", label: "PER", value: "0.00배" },
      { key: "dividendYield", label: "배당수익률", value: null },
      { key: "per", label: "PER(네이버)", value: "13.21배" },
    ]);
  });

  it("회사 개요 — 받은 값만, 섹터·나라는 한국어, 직원 수는 '명', 홈페이지는 http(s)만 새 창 링크(호스트 글)", () => {
    const profile = { sector: "Technology", industry: "Consumer Electronics", country: "United States", website: "https://www.apple.com/kr", employees: 166000, summary: "x" };
    expect(profileItems(quote({ profile }))).toEqual([
      { label: "섹터", value: "기술" },
      { label: "업종", value: "Consumer Electronics" },
      { label: "나라", value: "미국" },
      { label: "직원 수", value: "166,000명" },
      { label: "홈페이지", value: "apple.com", link: { href: "https://www.apple.com/kr", external: true } },
    ]);
    // 한국어 업종이 있으면 그것, 모르는 값·javascript: 주소는 줄을 두지 않음, 0명은 값
    expect(profileItems(quote({ profile: { ...profile, industryKo: "전화 및 소형 장치", sector: null, website: "javascript:alert(1)", employees: 0 } })).map((row) => [row.label, row.value])).toEqual([
      ["업종", "전화 및 소형 장치"],
      ["나라", "미국"],
      ["직원 수", "0명"],
    ]);
    expect(profileItems(quote({ profile: null }))).toEqual([]);
    expect(websiteHref("ftp://x")).toBeNull();
  });

  it("애널리스트 의견 — 평균 목표가는 통화 자릿수·단위, 국내 점수는 '평균 n / 5', 모르면 null", () => {
    expect(consensusItems("us", quote({ consensus: { targetMean: 360.5, recommendation: "buy", analysts: 41 } }))).toEqual([
      { label: "평균 목표가", value: "360.50 USD" },
      { label: "투자의견", value: "매수" },
      { label: "의견 수", value: "41곳" },
    ]);
    expect(consensusItems("kr", quote({ currency: "KRW", consensus: { targetMean: 89000, recommendation: "4.00", analysts: null } }))).toEqual([
      { label: "평균 목표가", value: "89,000 원" },
      { label: "투자의견", value: "평균 4.00 / 5" },
      { label: "의견 수", value: null },
    ]);
    expect(consensusItems("us", quote())).toEqual([]);
    expect(moneyPriceText(0.5, "USD")).toBe("0.5000 USD");
  });

  it("지표 — 범주·티커·카드 키(고정폭)·값(추정·이전 값)·전일·출처·장 상태·기준 시각, 경고는 있을 때만", () => {
    const rows = indicatorProperties(
      { key: "sp500", ticker: "^GSPC", prevStr: "7,600.00" },
      { valueText: "7,622.99", asOf: "2026-10-26 16:51 KST", isEstimated: true, isStale: true, staleReason: "수집 실패", warning: null },
      { category: "미국 주가지수", source: "Yahoo Finance (^GSPC)", session: "마감" },
    );
    expect(rows.map((row) => row.label)).toEqual(["범주", "티커", "카드 키", "값", "전일", "값 출처", "장 상태", "기준 시각"]);
    expect(rows.filter((row) => row.mono).map((row) => row.value)).toEqual(["^GSPC", "sp500"]);
    expect(rows[3]).toMatchObject({ value: "7,622.99", isEstimated: true, isStale: true, staleReason: "수집 실패" });
    const missing = indicatorProperties(
      { key: "k", ticker: null, prevStr: "N/A" },
      { valueText: null, asOf: null, isEstimated: false, isStale: false, staleReason: null, warning: "수집 실패" },
      { category: "범주", source: null, session: null },
    );
    expect(missing.find((row) => row.label === "티커")?.value).toBeNull();
    expect(missing.find((row) => row.label === "값")?.value).toBeNull();
    expect(missing.find((row) => row.label === "전일")?.value).toBe("N/A");
    expect(missing.at(-1)).toEqual({ label: "경고", value: "수집 실패" });
  });

  it("기관 — 받기 전은 CIK 한 줄, 받은 뒤 보고 기준일·공시일·평가액·최신 분기 보유 종목 수·분기 수·수집 시각·기관 소개(긴 글)", () => {
    expect(institutionProperties(null, "0001067983")).toEqual([{ label: "CIK", value: "0001067983", mono: true }]);
    const data: PortfolioResponse = {
      available: true, cik: "0001067983", institution: { name: "x", desc: "가치투자 포트폴리오" }, collectedAtKst: "2026-11-01 09:00 KST",
      quarters: [
        { filingDate: "2026-05-15", reportDate: "2026-03-31", totalValue: 260e9, holdingCount: 41 },
        { filingDate: "2026-08-14", reportDate: "2026-06-30", totalValue: 280e9, holdingCount: 40 },
      ],
      latest: { reportDate: "2026-06-30", filingDate: "2026-08-14", totalValue: 280e9 },
      holdings: [],
    };
    const rows = institutionProperties(data, "0001067983");
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ["CIK", "0001067983"],
      ["보고 기준일", "2026-06-30"],
      ["공시일", "2026-08-14"],
      ["13F 보고 평가액", "2,800억 달러"],
      ["보유 종목 수", "40종목"],
      ["분기 수", "2분기"],
      ["수집 시각", "2026-11-01 09:00 KST"],
      ["기관 소개", "가치투자 포트폴리오"],
    ]);
    expect(rows.at(-1)?.block).toBe(true);
    // 평가액을 모르면 null, 소개가 없으면 줄 없음
    const empty = institutionProperties({ ...data, latest: { ...data.latest!, totalValue: null }, institution: { name: "x", desc: "" }, quarters: [] }, "1");
    expect(empty.find((row) => row.label === "13F 보고 평가액")?.value).toBeNull();
    expect(empty.find((row) => row.label === "분기 수")?.value).toBeNull();
    expect(empty.some((row) => row.label === "기관 소개")).toBe(false);
  });

  it("보유 줄 — 비중 '<0.01%'(QA-454), 변화는 −(U+2212)·%p, 모르면 null(0으로 채우지 않음)", () => {
    const holding: Holding = { name: "APPLE INC", cusip: "037833100", class: "COM", value: 60e9, shares: 300_000_000, weight: 0.0032, weightDiff: -1.25, sharesDiff: -1_000_000, action: "감소" };
    expect(holdingDetailItems(holding).map((row) => [row.label, row.value])).toEqual([
      ["공시 이름", "APPLE INC"],
      ["클래스", "COM"],
      ["CUSIP", "037833100"],
      ["비중", "<0.01%"],
      ["평가액", "600.0억 달러"],
      ["주식 수", "300,000,000주"],
      ["주식 수 변화", "\u22121,000,000주"],
      ["비중 변화", "\u22121.25%p"],
      ["동작", "감소"],
    ]);
    const unknown = holdingDetailItems({ ...holding, value: null, shares: null, weight: null, weightDiff: null, sharesDiff: null, action: "신규" });
    expect(unknown.filter((row) => row.value === null).map((row) => row.label)).toEqual(["비중", "평가액", "주식 수", "주식 수 변화", "비중 변화"]);
    expect(holdingDetailItems({ ...holding, weightDiff: 0.5, sharesDiff: 0 }).slice(6, 8).map((row) => row.value)).toEqual(["0주", "+0.50%p"]);
  });

  it("보유 기관 줄 — 기관 이름은 앞 국기를 떼고, CUSIP 고정폭", () => {
    const row: GuruHoldersResponse["rows"][number] = {
      institution: "🇺🇸 버크셔 해서웨이 (Berkshire Hathaway)", cik: "0001067983", name: "APPLE INC", cusip: "037833100", weight: 21.5, value: 60e9, reportDate: "2026-06-30",
    };
    const items = holderDetailItems(row);
    expect(items.map((item) => [item.label, item.value])).toEqual([
      ["기관", "버크셔 해서웨이 (Berkshire Hathaway)"],
      ["공시 이름", "APPLE INC"],
      ["CUSIP", "037833100"],
      ["비중", "21.50%"],
      ["평가액", "600.0억 달러"],
      ["보고일", "2026-06-30"],
    ]);
    expect(items.find((item) => item.label === "CUSIP")?.mono).toBe(true);
  });

  it("값 글에 말줄임 표지('…')를 만들지 않는다 — 긴 업종·기관 소개도 받은 글 그대로", () => {
    const long = "Semiconductor Equipment & Materials Distribution and Global Logistics Services";
    expect(profileItems(quote({ profile: { sector: null, industry: long, country: null, website: null, employees: null, summary: null } }))).toEqual([
      { label: "업종", value: long },
    ]);
  });
});

describe("연결(대상 화면 오른쪽 칸)", () => {
  const OWNER: SessionUser = { email: "o@test.local", role: "OWNER", tier: "PRO" };
  const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };

  it("같은 Yahoo 심볼의 지표 — 차트 심볼이 같은 첫 카드(대소문자 무시), 뜻이 다른 티커(ZT=F)·없는 심볼은 null", () => {
    const overview: MacroOverview = macroOverview();
    overview.categories.push({ id: "ust", title: "미국 국채", items: [{ key: "us02y", name: "미국채 2년물 수익률(%)", ticker: "ZT=F", status: "ok" }] });
    expect(indicatorForSymbol(overview, "^GSPC")).toEqual({ key: "sp500", name: "S&P 500", href: "/markets/i/sp500" });
    expect(indicatorForSymbol(overview, "krw=x")).toEqual({ key: "usdkrw", name: "원/달러 (USD/KRW)", href: "/markets/i/usdkrw" });
    expect(indicatorForSymbol(overview, "ZT=F")).toBeNull();
    expect(indicatorForSymbol(overview, "AAPL")).toBeNull();
    expect(indicatorForSymbol(null, "^GSPC")).toBeNull();
    expect(indicatorForSymbol(overview, "")).toBeNull();
  });

  it("정보 검색 대상 키 — 종목 us:·kr:, 기관 cik:<10자리>(앞을 0으로)", () => {
    expect(stockEntityKey("us", "brk-b")).toBe("us:BRK-B");
    expect(stockEntityKey("kr", "005930")).toBe("kr:005930");
    expect(institutionEntityKey("1067983")).toBe("cik:0001067983");
    expect(institutionEntityKey("0001067983")).toBe("cik:0001067983");
    expect(institutionEntityKey("abc")).toBeNull();
  });

  it("정보 검색 대상 링크 — 키 문법에 맞고 /search가 보일 때만(지수·환율 심볼은 대상이 아님)", () => {
    expect(infoSearchEntityLink("us:AAPL", "정보 검색에서 보기", MEMBER)).toEqual({
      label: "정보 검색에서 보기",
      href: "/search?e=us:AAPL&tab=timeline&range=30d",
    });
    expect(infoSearchEntityLink(institutionEntityKey("1067983"), "x", OWNER)?.href).toBe("/search?e=cik:0001067983&tab=timeline&range=30d");
    expect(infoSearchEntityLink(stockEntityKey("us", "^GSPC"), "x", MEMBER)).toBeNull();
    expect(infoSearchEntityLink(stockEntityKey("us", "KRW=X"), "x", MEMBER)).toBeNull();
    expect(infoSearchEntityLink(null, "x", MEMBER)).toBeNull();
  });
});
