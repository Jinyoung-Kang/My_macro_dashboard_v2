/**
 * 검색 상세 화면의 표시 규칙(lib/detail) — 주소와 주소 조각 검사, 차트 행, 값 글(없으면 "—"), 뉴스 시각, 검색어, 외부 링크, AI 요약 줄.
 */
import { describe, expect, it } from "vitest";
import {
  briefSummary,
  chartRows,
  chartSymbol,
  countText,
  externalLinks,
  findIndicator,
  holderQuery,
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
import type { DetailQuote, MacroOverview } from "../types";

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
