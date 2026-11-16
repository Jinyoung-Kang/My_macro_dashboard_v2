/**
 * 상세 대상 화면의 속성·연결 모델(lib/detailEntity — 작업대 P4): 핵심 지표·회사 개요·애널리스트 의견·지표·기관·보유 줄 속성(모르면 null — 화면이 "—",
 * 0은 값, 말줄임 표지를 만들지 않음), 같은 Yahoo 심볼의 지표, 정보 검색 대상 키와 링크.
 */
import { describe, expect, it } from "vitest";
import {
  consensusItems,
  holderDetailItems,
  holderKey,
  holderRowTells,
  holdingDetailItems,
  holdingItemLabels,
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
} from "../detailEntity";
import { macroOverview } from "./homeFixtures";
import type { DetailQuote, GuruHoldersResponse, Holding, MacroOverview, PortfolioResponse, SessionUser } from "../types";

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
    ]);
    expect(consensusItems("us", quote())).toEqual([]);
    expect(moneyPriceText(0.5, "USD")).toBe("0.5000 USD");
  });

  // QA-580: 수집기는 지수·ETF·모르는 심볼에도 consensus를 값이 모두 null인 객체로 주고, 네이버(국내)는 의견 수를 늘 주지 않습니다. 회사 개요처럼
  // 받은 값만 — 세 값을 모두 모르면 빈 목록(패널을 그리지 않음), 국내는 늘 비는 '의견 수' 줄을 두지 않습니다.
  // 수정 전(재현 커밋에서는 it.fails)에는 미국 전부 null이 '—' 세 줄, 국내가 '의견 수' null 줄까지 세 줄이었습니다.
  it("애널리스트 의견 — 세 값을 모두 모르면 빈 목록, 국내는 '의견 수' 줄 없음 (QA-580)", () => {
    expect(consensusItems("us", quote({ consensus: { targetMean: null, recommendation: null, analysts: null } }))).toEqual([]);
    expect(consensusItems("kr", quote({ currency: "KRW", consensus: { targetMean: null, recommendation: null, analysts: null } }))).toEqual([]);
    expect(consensusItems("kr", quote({ currency: "KRW", consensus: { targetMean: 89000, recommendation: "4.00", analysts: null } }))).toEqual([
      { label: "평균 목표가", value: "89,000 원" },
      { label: "투자의견", value: "평균 4.00 / 5" },
    ]);
    // 미국의 일부 누락은 지금처럼 '—'(부분 누락 표시 규칙 그대로)
    expect(consensusItems("us", quote({ consensus: { targetMean: 360.5, recommendation: null, analysts: null } })).map((row) => row.value)).toEqual([
      "360.50 USD",
      null,
      null,
    ]);
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

  // QA-589: 2년물 카드 값은 TradingView 수익률(%)이고 카드 티커 ZT=F는 Yahoo 선물 가격이라 뜻이 다릅니다(INDICATOR_NO_CHART — 차트·연결에서 뺌).
  // 속성 '티커' 줄은 값을 그대로 두되(수집기 덮어쓰기 실패 경고가 이 이름을 가리킴) 이 카드 값의 출처가 아니라는 note를 붙입니다.
  // 수정 전(재현 커밋에서는 it.fails)에는 note가 없었습니다.
  it("지표 — 뜻이 다른 티커(us02y ZT=F)의 '티커' 줄은 값 그대로·고정폭에 note, 다른 지표는 note 없음 (QA-589)", () => {
    const row = { valueText: "3.512", asOf: null, isEstimated: false, isStale: false, staleReason: null, warning: null };
    const context = { category: "미국 국채 수익률", source: "TradingView Scanner", session: null };
    const ticker = indicatorProperties({ key: "us02y", ticker: "ZT=F", prevStr: null }, row, context).find((item) => item.label === "티커");
    expect(ticker).toMatchObject({ value: "ZT=F", mono: true });
    expect(ticker?.note).toBe("Yahoo 선물 가격 — 이 카드 값(수익률)의 출처가 아님");
    const plain = indicatorProperties({ key: "us10y", ticker: "^TNX", prevStr: null }, row, context).find((item) => item.label === "티커");
    expect(plain).toEqual({ label: "티커", value: "^TNX", mono: true });
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

  // QA-587: 13F 보유 줄은 공시 이름이 같은 다른 증권(A·C주, 'ISHARES TR' 아래 여러 ETF)이 흔한데 검사 칸·대화상자 제목이 이름뿐이라 똑같았습니다.
  // 백엔드 Sec13FService.lineLabels·lib/consensus consensusBars와 같은 규칙 — 이름이 겹치는 줄에만 ' · 클래스', 클래스로 가를 수 없으면 ' · CUSIP …'.
  // 수정 전(재현 커밋에서는 it.fails — 동적 import)에는 이 함수가 없었습니다(겹치는 줄의 이름표가 이름 그대로).
  it("보유 줄 이름표 — 이름이 겹치는 줄에만 클래스(가를 수 없으면 CUSIP), 하나뿐인 이름은 그대로 (QA-587)", () => {
    const row = (name: string, cusip: string, klass: string): Holding => ({
      name, cusip, class: klass, value: 1e9, shares: 1, weight: 1, weightDiff: null, sharesDiff: null, action: "유지",
    });
    const holdings = [
      row("ALPHABET INC", "02079K305", "CAP STK CL A"),
      row("ALPHABET INC", "02079K107", "CAP STK CL C"),
      row("ISHARES TR", "464287200", "CORE S&P500 ETF"),
      row("ISHARES TR", "464288588", "MBS ETF"),
      row("ISHARES TR", "464287242", "IBOXX INV CP ETF"),
      row("NVIDIA CORPORATION", "67066G104", "COM"),
      row("SYNTHETIC TWIN", "000000001", "COM"),
      row("SYNTHETIC TWIN", "000000002", "COM"),
      row("SYNTHETIC BLANK", "000000003", ""),
      row("SYNTHETIC BLANK", "000000004", "PFD"),
    ];
    const labels = holdingItemLabels(holdings);
    expect(holdings.map((holding) => labels.get(`${holding.cusip}:${holding.class}`))).toEqual([
      "ALPHABET INC · CAP STK CL A",
      "ALPHABET INC · CAP STK CL C",
      "ISHARES TR · CORE S&P500 ETF",
      "ISHARES TR · MBS ETF",
      "ISHARES TR · IBOXX INV CP ETF",
      "NVIDIA CORPORATION",
      "SYNTHETIC TWIN · CUSIP 000000001",
      "SYNTHETIC TWIN · CUSIP 000000002",
      "SYNTHETIC BLANK · CUSIP 000000003",
      "SYNTHETIC BLANK · CUSIP 000000004",
    ]);
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

  // QA-587(종목 상세 보유 기관): 한 기관이 같은 회사의 다른 증권(A·C주)을 함께 들면 두 줄의 기관·공시 이름('ALPHABET INC')·보고일이 같고 비중·평가액만
  // 달랐습니다 — 검사 칸·대화상자 제목이 기관 이름뿐이라 똑같았습니다. 기관이 겹치는 줄에만 ' · CUSIP …'(이름표)와 보조 글의 CUSIP.
  // 수정 전(재현 커밋에서는 it.fails — 동적 import)에는 이 함수가 없었습니다(이름표가 기관 이름 그대로).
  it("보유 기관 줄 구분 — 기관이 겹치는 줄에만 이름표 ' · CUSIP …'와 보조 글 CUSIP, 하나뿐인 기관은 그대로 (QA-587)", () => {
    type HolderRow = GuruHoldersResponse["rows"][number];
    const row = (institution: string, cik: string, name: string, cusip: string): HolderRow => ({
      institution, cik, name, cusip, weight: 1, value: 1e9, reportDate: "2026-06-30",
    });
    const rows = [
      row("합성 자산운용 (Synthetic Asset)", "0000000001", "SYNTHETIC ALPHA INC", "000000105"),
      row("가상 투자자문", "0000000002", "SYNTHETIC ALPHA INC CLASS A", "000000105"),
      row("합성 자산운용 (Synthetic Asset)", "0000000001", "SYNTHETIC ALPHA INC", "000000204"),
      row("예시 연기금", "0000000003", "SYNTHETIC ALPHA INC CL A", "000000105"),
      row("예시 연기금", "0000000003", "SYNTHETIC ALPHA INC CL C", "000000204"),
    ];
    const { labels, cusipKeys } = holderRowTells(rows);
    expect(rows.map((entry) => labels.get(holderKey(entry)))).toEqual([
      "합성 자산운용 (Synthetic Asset) · CUSIP 000000105",
      "가상 투자자문",
      "합성 자산운용 (Synthetic Asset) · CUSIP 000000204",
      "예시 연기금 · CUSIP 000000105",
      "예시 연기금 · CUSIP 000000204",
    ]);
    expect(rows.map((entry) => cusipKeys.has(holderKey(entry)))).toEqual([true, false, true, true, true]);
    expect(holderKey(rows[0])).toBe("0000000001:000000105");
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
