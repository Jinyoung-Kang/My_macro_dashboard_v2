/**
 * 모의 매매 화면의 표기 — 서버가 준 숫자를 고르고 이름만 붙인다(ADR 0004). 모르는 값은 "—", 0으로 채우지 않는다.
 */
import { describe, expect, it } from "vitest";
import {
  bookCard,
  bookStatusBadge,
  collectionView,
  criteriaText,
  eligibilityBadge,
  filingSpanText,
  formatCoverage,
  formatExcessPoints,
  formatSharePrice,
  calendarLine,
  earningsLine,
  exposureNote,
  fundamentalsLine,
  heldText,
  initPrompt,
  initResultText,
  jsonSummary,
  navAxis,
  navChart,
  newsLine,
  noteAsOfHint,
  noteExpiryHint,
  notePayload,
  notesIntro,
  noteStateBadge,
  notStartedNote,
  orderSizeText,
  PAPER_TABS,
  periodCoverageText,
  periodsText,
  positionBadges,
  quartersText,
  quotesLine,
  rerankResultView,
  resetResultView,
  resolveBookCode,
  riskOutcomeText,
  riskResultView,
  sampleNote,
  selectedBadge,
  selectionHistoryRows,
  statCells,
  statusResultText,
  statusToggle,
  stopText,
  timingLabel,
  trackMetricLabel,
  trackRecordRows,
  withParticle,
} from "../paper";
import { formatNumber } from "../format";
import type {
  PaperBookSummary,
  PaperPosition,
  PaperRiskOutcome,
  PaperStats,
  PaperTrackRecordCandidate,
  PaperTrackRecordCollection,
} from "../types";

const STATS: PaperStats = {
  cumReturnPct: 1.234, cagrPct: 12.5, volPct: 15.2, mddPct: -3.4, sharpe: 0.81, excessPct: -0.52, beta: 0.97, sampleDays: 42,
};

function book(code: string, over: Partial<PaperBookSummary> = {}): PaperBookSummary {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000,
    cash: 12.34, nav: 100123.45, equityValue: 100111.11, exposurePct: 99.99, returnPct: 0.12345,
    lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: STATS, benchmark: null, ...over,
  };
}

const BOOKS = [
  book("rules", { kind: "RULES", label: "규칙 계좌", status: "NOT_STARTED", benchmark: "bench_spy" }),
  book("claude", { kind: "CLAUDE", label: "Claude 계좌", status: "NOT_STARTED", benchmark: "bench_spy" }),
  book("bench_spy", { label: "SPY 계좌" }),
  book("bench_mix", { label: "60/40 계좌", benchmark: "bench_spy" }),
];

function position(over: Partial<PaperPosition> = {}): PaperPosition {
  return {
    ticker: "SPY", qty: 150, avgCost: 660.33, lastPrice: 662.1, lastPriceAtKst: "2026-10-24 05:15", marketValue: 99315,
    weightPct: 99.2, unrealizedPct: 0.27, highWatermark: 662.1, stopPrice: 609.13, stopDistancePct: 8.0,
    openedOn: "2026-10-23", holdingTradingDays: 1, priceStale: false, splitNote: null, cashLike: false, backfilled: false,
    ...over,
  };
}

function outcome(over: Partial<PaperRiskOutcome> = {}): PaperRiskOutcome {
  return {
    filled: 0, stopped: 0, expired: 0, splits: 0, booksProcessed: [], skippedReason: null, notes: [], errors: [], ...over,
  };
}

describe("책 카드", () => {
  it("서버 값을 그대로 표기한다 — 금액은 센트까지, 비교 기준 이름을 통계 라벨에", () => {
    const card = bookCard(BOOKS[3], BOOKS);
    expect(card.nav).toBe("100,123.45 달러");
    expect(card.returnPct).toBe("+0.12%");
    expect(card.exposure).toBe("100.0%");
    expect(card.initialCash).toBe("100,000 달러");
    expect(card.status.label).toBe("운용 중");
    expect(card.staleWarning).toBeNull();
    expect(card.stats.find((s) => s.key === "excessPct")).toEqual({
      key: "excessPct", label: "초과 수익률(SPY 계좌 대비)", value: "-0.52%p",
    });
  });

  it("값을 모르면 0이 아니라 — (통계가 통째로 없어도)", () => {
    const empty = book("x", {
      nav: null, cash: null, exposurePct: null, returnPct: null, positions: null, staleCount: null, stats: null,
      startedOn: null, lastObservedAtKst: null,
    });
    const card = bookCard(empty, [empty]);
    expect([card.nav, card.cash, card.exposure, card.returnPct, card.positions, card.lastObserved]).toEqual(
      ["—", "—", "—", "—", "—", "—"],
    );
    expect(card.startedOn).toBe("시작 전");
    expect(card.stats.every((s) => s.value === "—")).toBe(true);
    expect(card.sample).toContain("통계 없음");
  });

  it("가격을 새로 받지 못한 보유가 있으면 경고 문구", () => {
    expect(bookCard(book("b", { staleCount: 2 }), []).staleWarning).toBe("가격 없음 2종목 — 지난 값으로 평가");
  });

  it("표본이 짧아 연율 통계가 비었으면 그 이유를 적는다(기준 일수는 서버가 정함)", () => {
    const short: PaperStats = { ...STATS, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 1 };
    expect(sampleNote(short)).toContain("누적 수익률만");
    expect(statCells(short, null).map((s) => s.value)).toEqual(["+1.23%", "—", "—", "—", "—", "—", "—"]);
    expect(sampleNote(STATS)).toBe("표본 42거래일");
    // 구간은 충분한데 하루 간격 기록이 모자라면 변동성 계열만 비고, 그 이유를 적는다
    expect(sampleNote({ ...STATS, volPct: null, sharpe: null, beta: null })).toContain("하루 간격 기록이 모자라");
    // 비교 기준이 없으면(SPY 책 자신) 라벨에 기준을 적지 않는다
    expect(statCells(STATS, null).find((s) => s.key === "beta")?.label).toBe("베타");
  });

  it("상태 배지 — 모르는 상태는 받은 글자 그대로", () => {
    expect(bookStatusBadge("PAUSED").label).toBe("일시정지");
    expect(bookStatusBadge("NOT_STARTED").label).toBe("시작 전 · 현금만");
    expect(bookStatusBadge("CLOSED").label).toBe("CLOSED");
    expect(bookStatusBadge(null).label).toBe("—");
  });
});

describe("순자산 곡선", () => {
  it("책 순서대로 계열을 만들고, 빠진 날은 null 그대로(선을 끊음), 모자란 배열도 null", () => {
    const { rows, series } = navChart(
      {
        dates: ["2026-10-23", "2026-10-26", "2026-10-27"],
        books: { bench_mix: [100000, 100050.5, null], bench_spy: [100000, 100210], rules: [null, null, null], ghost: [1, 2, 3] },
      },
      BOOKS,
    );
    expect(series).toEqual([
      { key: "rules", name: "규칙 계좌" },
      { key: "bench_spy", name: "SPY 계좌" },
      { key: "bench_mix", name: "60/40 계좌" },
      { key: "ghost", name: "ghost" },
    ]);
    expect(rows).toEqual([
      { date: "2026-10-23", rules: null, bench_spy: 100000, bench_mix: 100000, ghost: 1 },
      { date: "2026-10-26", rules: null, bench_spy: 100210, bench_mix: 100050.5, ghost: 2 },
      { date: "2026-10-27", rules: null, bench_spy: null, bench_mix: null, ghost: 3 },
    ]);
  });

  it("곡선이 없으면 빈 차트", () => {
    expect(navChart(null, BOOKS)).toEqual({ rows: [], series: [] });
    expect(navChart(undefined, BOOKS)).toEqual({ rows: [], series: [] });
  });
});

describe("순자산 곡선 세로축", () => {
  const SERIES = [{ key: "a", name: "A" }, { key: "b", name: "B" }];
  const rowsOf = (a: (number | null)[], b: (number | null)[] = []) =>
    a.map((value, index) => ({ date: `2026-10-${23 + index}`, a: value, b: b[index] ?? null }));
  /** 차트가 고정 범위에서 찍는 눈금(Recharts 기본 tickCount 5 = 4칸)을 같은 자릿수로 적은 것. */
  const tickLabels = ({ domain, precision }: ReturnType<typeof navAxis>) => {
    const [lower, upper] = domain!;
    return [0, 1, 2, 3, 4].map((k) => formatNumber(lower + ((upper - lower) * k) / 4, precision));
  };

  it("하루 1달러 미만 차이면 수준의 0.2% 이상으로 펼쳐 둥근 4칸 — 눈금이 서로 다르고 자료를 다 담는다", () => {
    const axis = navAxis({ rows: rowsOf([99950.22, 99951.0], [99950.5, null]), series: SERIES });
    expect(axis).toEqual({ domain: [99850, 100050], precision: 0 });
    expect(tickLabels(axis)).toEqual(["99,850", "99,900", "99,950", "100,000", "100,050"]);
  });

  it("수준이 작으면 간격도 작아지고 자릿수가 간격을 따른다(소수 눈금도 서로 다름)", () => {
    // 0.2% 폭 0.02 → 간격 0.005를 넘는 둥근 값 0.01, 4칸 = 0.04.
    const axis = navAxis({ rows: rowsOf([10.001, 10.002]), series: SERIES });
    expect(axis).toEqual({ domain: [9.98, 10.02], precision: 2 });
    expect(tickLabels(axis)).toEqual(["9.98", "9.99", "10.00", "10.01", "10.02"]);
  });

  it("범위가 0.2%보다 넓으면 차트 기본 축(자료에 맞춤)과 정수 눈금 그대로", () => {
    expect(navAxis({ rows: rowsOf([100000, 100800, 101500]), series: SERIES })).toEqual({ domain: undefined, precision: 0 });
  });

  it("점 하나(또는 모든 값이 같음)도 가운데 두고 펼친다", () => {
    expect(navAxis({ rows: rowsOf([100000]), series: SERIES })).toEqual({ domain: [99900, 100100], precision: 0 });
    expect(navAxis({ rows: rowsOf([null, 100000, null], [100000, null, 100000]), series: SERIES }))
      .toEqual({ domain: [99900, 100100], precision: 0 });
  });

  it("값이 하나도 없거나 계열 밖의 값뿐이면 기본 축 — 없는 숫자로 범위를 만들지 않는다", () => {
    expect(navAxis({ rows: rowsOf([null, null], [null, null]), series: SERIES })).toEqual({ domain: undefined, precision: 0 });
    expect(navAxis({ rows: [], series: SERIES })).toEqual({ domain: undefined, precision: 0 });
    expect(navAxis({ rows: [{ date: "2026-10-23", other: 5 }], series: SERIES })).toEqual({ domain: undefined, precision: 0 });
  });

  it("행은 건드리지 않는다(null은 null 그대로 — 선이 끊김)", () => {
    const rows = rowsOf([99950.22, null], [null, 99951]);
    const before = JSON.stringify(rows);
    navAxis({ rows, series: SERIES });
    expect(JSON.stringify(rows)).toBe(before);
  });

  it("0 근처 순자산에 0 아래 눈금을 만들지 않는다", () => {
    const axis = navAxis({ rows: rowsOf([0, 0]), series: SERIES });
    expect(axis.domain![0]).toBe(0);
    expect(new Set(tickLabels(axis)).size).toBe(5);
  });
});

describe("장부 관측치", () => {
  const QUOTES = {
    collectedAtKst: "2026-10-24 05:10", ageSeconds: 60, barDate: "2026-10-23", finalClose: true, tickers: 157,
    staleTickers: ["XLB"], stale: false,
  };

  it("tickers는 개수, staleTickers는 이름 목록(백엔드 계약) — 이어받은 수는 목록 길이", () => {
    expect(quotesLine(QUOTES)).toBe("봉 날짜 2026-10-23(미국 동부) · 티커 157개 · 지난 값 이어받음 1개");
    expect(quotesLine({ ...QUOTES, staleTickers: [] })).toBe("봉 날짜 2026-10-23(미국 동부) · 티커 157개 · 지난 값 이어받음 0개");
  });

  it("봉이 하나도 없으면 봉 날짜만 —, 저장본이 없으면 그렇다고 적는다", () => {
    expect(quotesLine({ ...QUOTES, barDate: null, tickers: 0, staleTickers: [] }))
      .toBe("봉 날짜 —(미국 동부) · 티커 0개 · 지난 값 이어받음 0개");
    expect(quotesLine(null)).toContain("저장본이 아직 없습니다");
  });
});

describe("재무 수집 범위(D28)", () => {
  const STATUS = {
    available: true, universe: 596, mapped: 571, covered: 560, latestFetchKst: "2026-10-25 12:10 KST", staleCompanies: 0,
    note: "SEC XBRL Company Facts",
  };

  it("재무가 있는 회사/유니버스·마지막 수집(KST) — 이어받은 회사가 있으면 그 수를 덧붙인다", () => {
    expect(fundamentalsLine(STATUS)).toBe("재무(SEC XBRL): 560/596곳 · 마지막 수집 2026-10-25 12:10");
    expect(fundamentalsLine({ ...STATUS, staleCompanies: 3 }))
      .toBe("재무(SEC XBRL): 560/596곳 · 마지막 수집 2026-10-25 12:10 · 이어받음 3곳");
  });

  it("저장본이 없으면 숫자·시각은 —(0으로 채우지 않음), 필드가 없는 백엔드면 줄을 그리지 않는다(null)", () => {
    expect(fundamentalsLine({
      available: false, universe: null, mapped: null, covered: null, latestFetchKst: null, staleCompanies: null, note: "없음",
    })).toBe("재무(SEC XBRL): —/—곳 · 마지막 수집 —");
    expect(fundamentalsLine(undefined)).toBeNull();
    expect(fundamentalsLine(null)).toBeNull();
  });
});

describe("발표·실적 일정 수집 범위(2단계 A)", () => {
  const CALENDAR = {
    available: true, macroCount: 9, earningsCovered: 120, universe: 576, generatedAtKst: "2026-10-25 15:40 KST", fredStatus: "ok",
  };

  it("거시 건수·실적 받은 종목/대상·갱신 시각(KST) — FRED가 정상이면 상태를 적지 않는다", () => {
    expect(calendarLine(CALENDAR)).toBe("일정(FRED·FOMC·실적): 거시 9건 · 실적 120/576종목 · 갱신 2026-10-25 15:40");
  });

  it("FRED 키 미설정·실패면 그 상태를 덧붙인다(FOMC 상수는 거시 건수에 남음)", () => {
    expect(calendarLine({ ...CALENDAR, macroCount: 2, fredStatus: "키 미설정" }))
      .toBe("일정(FRED·FOMC·실적): 거시 2건 · 실적 120/576종목 · 갱신 2026-10-25 15:40 · FRED 키 미설정");
    expect(calendarLine({ ...CALENDAR, fredStatus: "실패" })).toContain("· FRED 실패");
  });

  it("저장본이 없으면 숫자·시각은 —(0으로 채우지 않음), 필드가 없는 백엔드면 줄을 그리지 않는다(null)", () => {
    expect(calendarLine({
      available: false, macroCount: null, earningsCovered: null, universe: null, generatedAtKst: null, fredStatus: null,
    })).toBe("일정(FRED·FOMC·실적): 거시 —건 · 실적 —/—종목 · 갱신 —");
    expect(calendarLine(undefined)).toBeNull();
    expect(calendarLine(null)).toBeNull();
  });
});

describe("사건 뉴스 수집(2단계 B)", () => {
  const NEWS = {
    available: true, stored7d: 61, lastFetchKst: "2026-10-25 15:00 KST", feedsOk: 7, feedsTotal: 7, failedFeeds: [],
  };

  it("7일 보관 건수·받은 피드/전체·갱신 시각(KST) — 실패한 피드가 없으면 덧붙이지 않는다", () => {
    expect(newsLine(NEWS)).toBe("사건 뉴스(RSS): 7일 61건 · 피드 7/7 · 갱신 2026-10-25 15:00");
  });

  it("실패한 피드는 키를 덧붙인다(사유는 상태 화면)", () => {
    expect(newsLine({
      ...NEWS, feedsOk: 5,
      failedFeeds: [
        { feed: "bls_cpi", source: "BLS", reason: "HTTP 403 — BLS 차단(UA)" },
        { feed: "bls_empsit", source: "BLS", reason: "HTTP 403 — BLS 차단(UA)" },
      ],
    })).toBe("사건 뉴스(RSS): 7일 61건 · 피드 5/7 · 갱신 2026-10-25 15:00 · 실패 bls_cpi·bls_empsit");
  });

  it("저장본이 없으면 숫자·시각은 —(0으로 채우지 않음), 필드가 없는 백엔드면 줄을 그리지 않는다(null)", () => {
    expect(newsLine({
      available: false, stored7d: null, lastFetchKst: null, feedsOk: null, feedsTotal: null, failedFeeds: null,
    })).toBe("사건 뉴스(RSS): 7일 —건 · 피드 —/— · 갱신 —");
    expect(newsLine(undefined)).toBeNull();
    expect(newsLine(null)).toBeNull();
  });
});

describe("어닝 서프라이즈 수집(2단계 C)", () => {
  const EARNINGS = {
    available: true, covered: 98, universe: 576, withEstimate4: 91, generatedAtKst: "2026-10-25 21:30 KST",
  };

  it("행이 있는 종목/대상·추정치 4분기 이상 종목·갱신 시각(KST)", () => {
    expect(earningsLine(EARNINGS)).toBe("어닝 서프라이즈(yfinance): 98/576종목 · 4분기 91 · 갱신 2026-10-25 21:30");
  });

  it("저장본이 없으면 숫자·시각은 —(0으로 채우지 않음), 필드가 없는 백엔드면 줄을 그리지 않는다(null)", () => {
    expect(earningsLine({ available: false, covered: null, universe: null, withEstimate4: null, generatedAtKst: null }))
      .toBe("어닝 서프라이즈(yfinance): —/—종목 · 4분기 — · 갱신 —");
    expect(earningsLine(undefined)).toBeNull();
    expect(earningsLine(null)).toBeNull();
  });
});

describe("보유 표", () => {
  it("가격을 한 번도 못 받았으면 '가격 없음 · 평단 평가', 이번에 못 받았으면 '가격 없음 · 지난 값'", () => {
    expect(positionBadges(position({ lastPrice: null, priceStale: true })).map((b) => b.label)).toEqual(["가격 없음 · 평단 평가"]);
    expect(positionBadges(position({ priceStale: true })).map((b) => b.label)).toEqual(["가격 없음 · 지난 값"]);
    expect(positionBadges(position())).toEqual([]);
  });

  it("사후 체결·분할·현금성 배지", () => {
    const labels = positionBadges(position({ backfilled: true, splitNote: "2:1 분할 (2026-11-02)", cashLike: true })).map((b) => b.label);
    expect(labels).toEqual(["사후 체결", "분할 조정", "현금성"]);
  });

  it("스탑 칸 — 스탑 가격은 주당 가격이라 4자리, 현금성은 적용 안 함, 값이 없으면 —", () => {
    expect(stopText(position())).toBe("609.1300 · 거리 8.0%");
    expect(stopText(position({ stopPrice: 9.2046 }))).toBe("9.2046 · 거리 8.0%");
    expect(stopText(position({ cashLike: true }))).toBe("적용 안 함");
    expect(stopText(position({ stopPrice: null }))).toBe("—");
    expect(stopText(position({ stopDistancePct: null }))).toBe("609.1300");
  });

  it("주당 가격은 4자리 — 싼 종목의 5bp 슬리피지(9.00 → 9.0045)가 보인다, 모르면 —", () => {
    expect(formatSharePrice(9)).toBe("9.0000");
    expect(formatSharePrice(9.0045)).toBe("9.0045");
    expect(formatSharePrice(662.0808)).toBe("662.0808");
    expect(formatSharePrice(1234.5)).toBe("1,234.5000");
    expect(formatSharePrice(null)).toBe("—");
  });

  it("보유 기간 — 모르는 부분은 —", () => {
    expect(heldText(position())).toBe("2026-10-23부터 · 1거래일");
    expect(heldText(position({ openedOn: null, holdingTradingDays: null }))).toBe("— · —");
  });
});

describe("주문 표", () => {
  it("크기 — 수량 > 살 금액 > 매도 비율, 매도에 셋 다 없으면 전량, 매수는 —", () => {
    const base = { qty: null, targetWeightPct: null, sellFraction: null };
    expect(orderSizeText({ ...base, side: "BUY", qty: 151 })).toBe("151주");
    expect(orderSizeText({ ...base, side: "BUY", targetWeightPct: 20 })).toBe("순자산의 20.00% 매수");
    expect(orderSizeText({ ...base, side: "SELL", sellFraction: 0.5 })).toBe("보유의 50%");
    expect(orderSizeText({ ...base, side: "SELL" })).toBe("전량");
    expect(orderSizeText({ ...base, side: "BUY" })).toBe("—");
  });

  it("크기 — 거절된 Claude 매수는 받은 값 그대로라 '목표 …% (제안)', 통과한 Claude 매수는 살 금액과 목표(근거)", () => {
    const base = { qty: null, sellFraction: null, side: "BUY" as const };
    // HELD 8% 보유에 목표 12% → WEIGHT_CAP 거절: 행 값 12는 목표 비중(살 금액 아님)
    expect(orderSizeText({ ...base, status: "REJECTED", targetWeightPct: 12, reason: { targetWeightPct: 12, currentWeightPct: 8 } }))
      .toBe("목표 12.00% (제안)");
    // 목표 10% 통과: 행 값 2(= 10 − 8), 근거 targetWeightPct 10
    expect(orderSizeText({ ...base, status: "PENDING", targetWeightPct: 2, reason: { targetWeightPct: 10, proposed: { targetWeightPct: 10 } } }))
      .toBe("순자산의 2.00% 매수 (목표 10.00%)");
    // 거절된 매도는 비율 그대로
    expect(orderSizeText({ qty: null, targetWeightPct: null, side: "SELL", status: "REJECTED", sellFraction: 0.5 })).toBe("보유의 50%");
  });

  it("크기 — 주문 값은 목표 비중이 아니라 살 금액: 근거의 목표 비중이 다르면 함께(이미 든 종목·SHY 보충)", () => {
    const base = { qty: null, sellFraction: null, side: "BUY" as const };
    // reselectionDayBuysTopsUpAndParksShy와 같은 장부 — CCC는 5%를 들고 목표 10%, SHY는 늘릴 47.4885%(목표 71.4885%)
    expect(orderSizeText({ ...base, targetWeightPct: 5, reason: { targetWeightPct: 10, currentWeightPct: 5, orderWeightPct: 5 } }))
      .toBe("순자산의 5.00% 매수 (목표 10.00%)");
    expect(orderSizeText({ ...base, targetWeightPct: 47.4885, reason: { targetWeightPct: 71.4885, orderWeightPct: 47.4885 } }))
      .toBe("순자산의 47.49% 매수 (목표 71.49%)");
    // 새로 사는 종목은 살 금액 = 목표라 한 번만, 근거가 없거나 모양이 다르면 살 금액만
    expect(orderSizeText({ ...base, targetWeightPct: 10, reason: { targetWeightPct: 10 } })).toBe("순자산의 10.00% 매수");
    expect(orderSizeText({ ...base, targetWeightPct: 10, reason: { cashLimited: true } })).toBe("순자산의 10.00% 매수");
    expect(orderSizeText({ ...base, targetWeightPct: 10, reason: "문자열 근거" })).toBe("순자산의 10.00% 매수");
    expect(orderSizeText({ ...base, targetWeightPct: 10, reason: { targetWeightPct: "10" } })).toBe("순자산의 10.00% 매수");
  });

  it("체결 시점 이름 — 모르는 값은 그대로", () => {
    expect(timingLabel("BACKFILL")).toBe("사후 체결");
    expect(timingLabel("SOMEDAY")).toBe("SOMEDAY");
    expect(timingLabel(null)).toBe("—");
  });

  it("근거 JSON은 '키: 값'으로 한 줄, 비었으면 —, 길면 자른다", () => {
    expect(jsonSummary({ cashLimited: true, note: "현금 부족" })).toBe("cashLimited: true · note: 현금 부족");
    expect(jsonSummary({ nested: { a: 1 }, list: ["SPY", "SHY"], none: null })).toBe('nested: {"a":1} · list: SPY, SHY · none: —');
    expect(jsonSummary({})).toBe("—");
    expect(jsonSummary(null)).toBe("—");
    expect(jsonSummary("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("버튼", () => {
  it("일시정지·재개 — 시작 전인 책은 버튼이 없다(시작은 초기 결정이 함)", () => {
    expect(statusToggle("ACTIVE")).toEqual({ next: "PAUSED", label: "일시정지" });
    expect(statusToggle("PAUSED")).toEqual({ next: "ACTIVE", label: "재개" });
    expect(statusToggle("NOT_STARTED")).toBeNull();
    expect(statusToggle(undefined)).toBeNull();
  });

  it("시작 전 안내 — 벤치마크는 종가를 받은 뒤 초기화를 다시 누르라고, 규칙 책·Claude 책은 개요의 시작 카드로", () => {
    expect(notStartedNote("BENCHMARK")).toContain("종가를 받은 뒤 초기화를 다시 누르세요");
    expect(notStartedNote("BENCHMARK")).not.toContain("초기 결정");
    expect(notStartedNote("RULES")).toContain("개요 탭의 '규칙 계좌 시작'");
    expect(notStartedNote("RULES")).not.toContain("다음 단계");
    // 단계 3a부터 Claude 책도 개요의 시작 카드(초기 결정)로 시작합니다.
    expect(notStartedNote("CLAUDE")).toContain("개요 탭의 'Claude 계좌 시작'(초기 결정)");
    expect(notStartedNote("CLAUDE")).toContain("검증(하드 규칙)을 통과한 것만");
    expect(notStartedNote("CLAUDE")).not.toContain("다음 단계");
    expect(notStartedNote("CLAUDE")).not.toContain("종가를 받은 뒤");
  });

  it("기본 책 — 고른 책이 있으면 그것, 아니면 처음 시작한 책, 없으면 첫 책, 책이 없으면 null", () => {
    expect(resolveBookCode("claude", BOOKS)).toBe("claude");
    expect(resolveBookCode("", BOOKS)).toBe("bench_spy");
    expect(resolveBookCode("gone", BOOKS.slice(0, 2))).toBe("rules");
    expect(resolveBookCode("", [])).toBeNull();
  });

  it("결과 문구", () => {
    expect(initResultText({ ok: true, created: ["rules", "claude", "bench_spy", "bench_mix"], backfilled: ["bench_spy"],
      skipped: [{ code: "bench_mix", reason: "2026-10-23 SHY 종가 없음" }], settingsCreated: true, startPricesCaptured: 153 }))
      .toBe("만든 계좌 rules, claude, bench_spy, bench_mix · 사후 체결 bench_spy · bench_mix 시작하지 않음 — 2026-10-23 SHY 종가 없음");
    expect(initResultText({ ok: true, created: [], backfilled: [], skipped: [], settingsCreated: false, startPricesCaptured: 0 })).toBe("새로 만든 계좌 없음(이미 있음)");
    expect(riskOutcomeText(outcome({ filled: 1, expired: 2, booksProcessed: ["bench_spy"] })))
      .toBe("체결 1 · 스탑 0 · 만료 2 · 분할 0 · 처리한 계좌 bench_spy");
    expect(riskOutcomeText(outcome({ skippedReason: "새 저장본 없음" })))
      .toBe("체결 0 · 스탑 0 · 만료 0 · 분할 0 · 처리한 계좌 없음 — 새 저장본 없음");
    expect(riskOutcomeText(null)).toBe("결과를 받지 못했습니다.");
    expect(statusResultText({ ok: true, book: book("bench_spy", { label: "SPY 계좌", status: "PAUSED" }), cancelledOrders: 3 }))
      .toBe("SPY 계좌: 일시정지 · 대기 주문 3건 취소");
    expect(statusResultText({ ok: true, book: book("bench_spy", { label: "SPY 계좌" }), cancelledOrders: null }))
      .toBe("SPY 계좌: 운용 중");
  });
});

describe("초기화 카드", () => {
  const PENDING_BOOKS = BOOKS.map((entry) => (entry.kind === "BENCHMARK" ? { ...entry, status: "NOT_STARTED" as const } : entry));

  it("초기화 전이면 '장부 초기화'", () => {
    expect(initPrompt({ initialized: false, startDate: "2026-10-23", books: [] })?.title).toBe("장부 초기화");
  });

  it("책 네 개가 있어도 벤치마크가 사후 체결을 기다리면(pendingBackfill) 카드를 계속 보이고 다시 누르라고 적는다", () => {
    const prompt = initPrompt({
      initialized: true, startDate: "2026-10-23", books: PENDING_BOOKS, pendingBackfill: ["bench_spy", "bench_mix"],
    });
    expect(prompt?.title).toBe("벤치마크 사후 체결 대기");
    expect(prompt?.body).toContain("SPY 계좌, 60/40 계좌: 출발일(2026-10-23) 종가를 아직 받지 못해");
    expect(prompt?.body).toContain("종가를 받은 뒤 초기화를 다시 누르세요");
  });

  it("모두 시작했으면(pendingBackfill 비었거나 이 필드를 아직 안 보내는 백엔드) 카드 없음", () => {
    expect(initPrompt({ initialized: true, startDate: "2026-10-23", books: BOOKS, pendingBackfill: [] })).toBeNull();
    expect(initPrompt({ initialized: true, startDate: "2026-10-23", books: BOOKS })).toBeNull();
  });

  it("목록에 없는 책 코드는 코드 그대로", () => {
    expect(initPrompt({ initialized: true, startDate: null, books: [], pendingBackfill: ["bench_x"] })?.body)
      .toContain("bench_x: 출발일(—)");
  });
});

describe("리스크 작업 결과", () => {
  it("ok:false면 경고색 + 오류 목록 — HTTP 200이어도 실패를 성공처럼 보이지 않는다", () => {
    const view = riskResultView({
      ok: false,
      outcome: outcome({
        filled: 1, booksProcessed: ["bench_spy"],
        notes: ["bench_spy: 주문 7 BUY SPY 현금 부족으로 10주 중 9주"],
        errors: ["claude: IllegalStateException 상태 저장 실패"],
      }),
    });
    expect(view.tone).toBe("warn");
    expect(view.warning).toContain("오류가 난 계좌가 있습니다");
    expect(view.errors).toEqual(["claude: IllegalStateException 상태 저장 실패"]);
    expect(view.notes).toEqual(["bench_spy: 주문 7 BUY SPY 현금 부족으로 10주 중 9주"]);
    expect(view.summary).toBe("체결 1 · 스탑 0 · 만료 0 · 분할 0 · 처리한 계좌 bench_spy");
  });

  it("ok:true면 안내색, 경고 없음, 처리 메모는 그대로 보인다", () => {
    const view = riskResultView({ ok: true, outcome: outcome({ notes: ["rules: 주문 3 SELL XLE 취소 — 재진입 금지"] }) });
    expect(view.tone).toBe("info");
    expect(view.warning).toBeNull();
    expect(view.errors).toEqual([]);
    expect(view.notes).toEqual(["rules: 주문 3 SELL XLE 취소 — 재진입 금지"]);
  });

  it("테이블이 없어 outcome 없이 ok:false면 서버 문구를 요약으로", () => {
    const view = riskResultView({ ok: false, message: "모의 매매 테이블이 아직 없습니다." });
    expect(view.tone).toBe("warn");
    expect(view.warning).toBe("리스크 작업이 돌지 않았습니다.");
    expect(view.summary).toBe("모의 매매 테이블이 아직 없습니다.");
    expect(view.notes).toEqual([]);
  });
});

describe("책 초기화 결과", () => {
  const spy = book("bench_spy", { label: "SPY 계좌" });

  it("벤치마크를 다시 사후 체결하지 못했으면 서버 사유를 경고로", () => {
    const reason = "2026-10-23 SPY 종가가 아직 없습니다 — 수집기가 받은 뒤 초기화를 다시 누르세요.";
    const view = resetResultView({ ok: true, book: { ...spy, status: "NOT_STARTED" }, backfilled: false, skippedReason: reason });
    expect(view.tone).toBe("warn");
    expect(view.text).toBe(`SPY 계좌를 초기화했습니다 — 지금 시작 전 · 현금만. 출발일 종가로 다시 사후 체결하지 못했습니다 — ${reason}`);
  });

  it("다시 사후 체결했으면 그렇다고, 규칙·Claude 책은 상태만", () => {
    expect(resetResultView({ ok: true, book: spy, backfilled: true, skippedReason: null }))
      .toEqual({ tone: "info", text: "SPY 계좌를 초기화했습니다 — 지금 운용 중 · 출발일 종가로 다시 사후 체결했습니다" });
    expect(resetResultView({
      ok: true, book: book("rules", { label: "규칙 계좌", status: "NOT_STARTED" }), backfilled: false, skippedReason: null,
    })).toEqual({ tone: "info", text: "규칙 계좌를 초기화했습니다 — 지금 시작 전 · 현금만" });
  });

  it("옛 이름(서버가 아직 맞추지 않은 행)이나 모르는 이름도 조사를 맞추고, 받침을 모르면 둘 다 적는다", () => {
    const old = { ok: true, book: book("rules", { label: "규칙 책", status: "NOT_STARTED" }), backfilled: false, skippedReason: null };
    expect(resetResultView(old).text).toBe("규칙 책을 초기화했습니다 — 지금 시작 전 · 현금만");
    expect(resetResultView({ ...old, book: { ...old.book, label: "SPY 100%" } }).text)
      .toBe("SPY 100%을(를) 초기화했습니다 — 지금 시작 전 · 현금만");
  });
});

describe("조사 붙이기", () => {
  it("마지막 글자의 받침으로 고르고, 한글로 끝나지 않으면 둘 다", () => {
    expect(withParticle("규칙 계좌", "을")).toBe("규칙 계좌를");
    expect(withParticle("Claude 계좌", "은")).toBe("Claude 계좌는");
    expect(withParticle("60/40 계좌", "이")).toBe("60/40 계좌가");
    expect(withParticle("SPY 계좌", "과")).toBe("SPY 계좌와");
    expect(withParticle("규칙 책", "을")).toBe("규칙 책을");
    expect(withParticle("규칙 책", "은")).toBe("규칙 책은");
    expect(withParticle("SPY 100%", "을")).toBe("SPY 100%을(를)");
    expect(withParticle("Claude", "은")).toBe("Claude은(는)");
    expect(withParticle("", "이")).toBe("이(가)");
  });
});

describe("기관 선정 — 트랙레코드 표기", () => {
  function candidate(cik: string, over: Partial<PaperTrackRecordCandidate> = {}): PaperTrackRecordCandidate {
    return {
      cik, name: `기관 ${cik}`, style: "가치·집중", rank: null, eligible: false, ineligibleReason: null, cagrPct: 12.3456,
      cumReturnPct: 125.5, spyCumReturnPct: 110.25, excessVsSpyPct: 15.25, volPct: 18.2, mddPct: -32.1, sharpe: 0.71,
      periodsUsed: 27, periodsTotal: 28, coverageMin: 0.523, coverageAvg: 0.786, firstFilingDate: "2019-11-14",
      lastFilingDate: "2026-08-14", storedQuarters: 30, complete: true, selected: false, periods: [], ...over,
    };
  }

  const COLLECTION: PaperTrackRecordCollection = {
    filers: 27, completeCount: 20, storedFilings: 700, targetFilings: 810, updatedAtKst: "2026-10-24 03:10",
  };

  it("탭 — 기관 선정은 이제 내용이 있다(준비 중 아님)", () => {
    expect(PAPER_TABS.find((tab) => tab.key === "selection")?.opensIn).toBeNull();
  });

  it("커버리지는 0~1 비율을 소수 1자리 %로 — 49.7%가 '50%'로 보이지 않게, 모르면 —", () => {
    expect(formatCoverage(0.497)).toBe("49.7%");
    expect(formatCoverage(1)).toBe("100.0%");
    expect(formatCoverage(0)).toBe("0.0%");
    expect(formatCoverage(null)).toBe("—");
    expect(formatCoverage(undefined)).toBe("—");
  });

  it("초과는 %p, 모르면 —", () => {
    expect(formatExcessPoints(15.25)).toBe("+15.25%p");
    expect(formatExcessPoints(-3.1)).toBe("-3.10%p");
    expect(formatExcessPoints(null)).toBe("—");
  });

  it("순위 기준·자격 기준 문구 — 모르는 기준은 받은 글자 그대로, 기준이 없으면 null", () => {
    expect(trackMetricLabel("CAGR")).toBe("연율 수익률(CAGR)");
    expect(trackMetricLabel("EXCESS_VS_SPY")).toBe("SPY 대비 초과 수익률");
    expect(trackMetricLabel("SORTINO")).toBe("SORTINO");
    expect(trackMetricLabel(null)).toBe("—");
    expect(criteriaText({ windowYears: 7, minPeriods: 24, minCoverage: 0.5, avgCoverage: 0.7 }))
      .toBe("창 7년 · 구간 ≥ 24개 · 최소 커버리지 ≥ 50% · 평균 커버리지 ≥ 70%");
    expect(criteriaText(null)).toBeNull();
  });

  it("자격 배지 — 자격 · 수집 중(complete=false) · 자격 없음, 선정 배지는 선정된 기관만", () => {
    expect(eligibilityBadge(candidate("a", { eligible: true })).label).toBe("자격");
    expect(eligibilityBadge(candidate("b", { complete: false, collecting: true })).label).toBe("수집 중");
    // collecting을 보내지 않아도 complete=false면 수집 중
    expect(eligibilityBadge(candidate("c", { complete: false })).label).toBe("수집 중");
    const ineligible = eligibilityBadge(candidate("d"));
    expect(ineligible.label).toBe("자격 없음");
    expect(ineligible.className).toContain("text-warn");
    expect(selectedBadge(candidate("e", { selected: true }))?.label).toBe("선정");
    expect(selectedBadge(candidate("f"))).toBeNull();
  });

  it("행 순서 — 순위대로, 순위 없는 기관은 뒤에 서버 순서대로(순위를 다시 매기지 않음)", () => {
    const rows = trackRecordRows([
      candidate("x"), candidate("r2", { rank: 2, eligible: true }), candidate("y"), candidate("r1", { rank: 1, eligible: true }),
    ]);
    expect(rows.map((row) => row.cik)).toEqual(["r1", "r2", "x", "y"]);
    expect(rows.map((row) => row.rank)).toEqual([1, 2, null, null]);
    expect(trackRecordRows(undefined)).toEqual([]);
  });

  it("구간·공시 기간·수집 칸 — 모르는 값은 —, 완료는 30분기 미만이어도 완료", () => {
    expect(periodsText(candidate("a"))).toBe("27/28");
    expect(periodsText(candidate("b", { periodsUsed: null, periodsTotal: null }))).toBe("—");
    expect(filingSpanText(candidate("c"))).toBe("2019-11-14 ~ 2026-08-14");
    expect(filingSpanText(candidate("d", { firstFilingDate: null, lastFilingDate: null }))).toBe("—");
    expect(quartersText(candidate("e", { storedQuarters: 18, complete: false }), 30)).toBe("18/30 · 수집 중");
    expect(quartersText(candidate("f", { storedQuarters: 22, complete: true }), 30)).toBe("22/30 · 완료");
    expect(quartersText(candidate("g", { storedQuarters: 18, complete: false }), null)).toBe("18분기 · 수집 중");
    expect(quartersText(candidate("h", { storedQuarters: null, complete: false }), 30)).toBe("— · 수집 중");
  });

  it("수집 진행률 — 목표 분기는 서버 값, 없으면 목표 공시 ÷ 기관 수가 나누어떨어질 때만", () => {
    const view = collectionView(COLLECTION);
    expect(view.line).toBe("후보 27곳 중 수집 완료 20곳 · 저장 공시 700/810건 · 마지막 수집 2026-10-24 03:10");
    expect(view.targetQuarters).toBe(30);
    expect(collectionView({ ...COLLECTION, targetQuarters: 32 }).targetQuarters).toBe(32);
    expect(collectionView({ ...COLLECTION, targetFilings: 800 }).targetQuarters).toBeNull();
    expect(collectionView({ ...COLLECTION, filers: 0 }).targetQuarters).toBeNull();
    // 계약상 개수지만 목록으로 와도 개수를 센다
    expect(collectionView({ ...COLLECTION, filers: Array.from({ length: 27 }, () => ({})) as unknown as number }).line)
      .toContain("후보 27곳");
    const missing = collectionView(null);
    expect(missing.targetQuarters).toBeNull();
    expect(missing.line).toContain("아직 없습니다");
  });

  it("구간 커버리지 칸 — 비율과 티커 수 · 보유 줄 수", () => {
    expect(periodCoverageText({ coverage: 0.824, coveredTickers: 31, holdings: 40 })).toBe("82.4% (티커 31개 · 보유 40줄)");
  });

  it("선정 이력 — CIK를 후보 이름으로, 목록에 없으면 CIK 그대로, 빈 선정은 그렇다고", () => {
    const rows = selectionHistoryRows(
      [{ asOfDate: "2026-10-23", selectedCiks: ["a", "zzz"] }, { asOfDate: "2026-08-15", selectedCiks: [] }],
      [candidate("a")],
    );
    expect(rows).toEqual([
      { asOfDate: "2026-10-23", names: "기관 a, zzz" },
      { asOfDate: "2026-08-15", names: "선정 없음 — 자격 있는 기관이 없었습니다" },
    ]);
    expect(selectionHistoryRows(undefined, undefined)).toEqual([]);
  });

  it("재계산 결과 — 선정은 바꾸지 않았다고 적고, computed는 수·참거짓 둘 다 받는다, ok:false는 서버 문구", () => {
    expect(rerankResultView({ ok: true, asOfDate: "2026-10-23", computed: 27, selectedUnchanged: true })).toEqual({
      tone: "info",
      text: "2026-10-23 기준으로 다시 계산했습니다 · 후보 27곳 — 선정은 바꾸지 않았습니다(선정은 재선정일·초기 선정 때 한 번만 남깁니다).",
    });
    expect(rerankResultView({ ok: true, asOfDate: "2026-10-23", computed: true, selectedUnchanged: true }).text)
      .toBe("2026-10-23 기준으로 다시 계산했습니다 — 선정은 바꾸지 않았습니다(선정은 재선정일·초기 선정 때 한 번만 남깁니다).");
    expect(rerankResultView({ ok: true, asOfDate: "2026-10-23", computed: false, selectedUnchanged: true }).tone).toBe("warn");
    expect(rerankResultView({ ok: false, message: "모의 매매 테이블이 아직 없습니다." }))
      .toEqual({ tone: "warn", text: "모의 매매 테이블이 아직 없습니다." });
  });

  it("재계산 결과 — 서버가 계산하지 못한 이유를 보내면 그 문구 그대로(수집 진행률 안내로 바꾸지 않음)", () => {
    const reason = "후보가 없습니다 — 설정 trackRecord.candidateCiks가 수집 목록의 기관과 겹치지 않습니다.";
    expect(rerankResultView({
      ok: true, asOfDate: "2026-10-23", computed: 0, eligible: 0, collecting: 0, selectedUnchanged: true, skippedReason: reason,
    })).toEqual({ tone: "warn", text: `2026-10-23 기준 — 계산하지 못했습니다: ${reason}` });
    expect(rerankResultView({ ok: true, asOfDate: "2026-10-23", computed: 0, skippedReason: null }).text)
      .toBe("2026-10-23 기준 — 계산할 후보가 없었습니다. 수집 진행률을 보세요.");
  });
});

describe("메모 안내 — 시장 인자(미국 문구 그대로, 한국은 KRX 달력)", () => {
  it("미국: 인자 없음과 \"US\"가 예전 글자 그대로", () => {
    expect(notesIntro("2026-10-23", "US")).toBe(notesIntro("2026-10-23"));
    expect(notesIntro("2026-10-23")).toContain("기준일이 출발일(2026-10-23) 이하인 메모만 실립니다. 규칙 계좌는 메모를 읽지 않습니다.");
    expect(noteAsOfHint("2026-10-26", "US")).toBe(noteAsOfHint("2026-10-26"));
    expect(noteAsOfHint("2026-10-26")).toContain("(마지막으로 끝난 미국 세션 — Claude 결정이 보는 거래일)");
    expect(noteExpiryHint({ notesDefaultExpiryTradingDays: 5 }, "US")).toBe("비우면 기본 +5거래일(기준일부터 — 설정 notesDefaultExpiryTradingDays)");
    const draft = { kind: "MARKET" as const, asOfDate: "", expiresOn: "", title: "t", body: "b" };
    expect(notePayload(draft)).toEqual({ kind: "MARKET", title: "t", body: "b" });
    expect(notePayload(draft, "US")).toEqual({ kind: "MARKET", title: "t", body: "b" });
  });

  it("한국: 한국 결정 패킷에만·그날 세션 D 기준·KRX 거래일, 본문에 market:\"KR\"", () => {
    const intro = notesIntro("2026-10-29", "KR");
    expect(intro).toContain("한국 Claude 계좌 결정 패킷(섹션 11)에만");
    expect(intro).toContain("기준일 ≤ D ≤ 만료일인 메모가 실립니다(출발일 2026-10-29 밤의 출발 결정도 같은 규칙)");
    expect(intro).not.toContain("미국 세션");
    expect(noteAsOfHint("2026-10-28", "KR")).toMatch(/^비우면 2026-10-28\(마지막으로 끝난 한국 세션 — KRX 달력\)\. 오늘\(KST\) 날짜를 고르면 오늘 밤 결정/);
    expect(noteAsOfHint(null, "KR")).toMatch(/^비우면 마지막으로 끝난 한국 세션\(KRX 달력\)\./);
    expect(noteExpiryHint(null, "KR")).toBe("비우면 기본 +3 KRX 거래일(기준일부터 — 설정 notesDefaultExpiryTradingDays의 기본값, 두 책 공용)");
    expect(notePayload({ kind: "INSIGHT", asOfDate: "", expiresOn: "2026-11-02", title: "t", body: "b" }, "KR"))
      .toEqual({ kind: "INSIGHT", title: "t", body: "b", market: "KR" });
  });

  it("유효 여부 모름 — 한국 달력이 모르는 해의 active:null은 '패킷 밖'이 아님(미국의 false·없음은 그대로)", () => {
    expect(noteStateBadge({ kind: "MARKET", archived: false, active: null }).label).toBe("유효 여부 모름");
    expect(noteStateBadge({ kind: "MARKET", archived: false, active: false }).label).toBe("패킷 밖 — 만료·기준일 전");
    expect(noteStateBadge({ kind: "MARKET", archived: false }).label).toBe("패킷 밖 — 만료·기준일 전");
    expect(noteStateBadge({ kind: "INSIGHT", archived: false, active: null }).label).toBe("프레임 제안용");
  });
});

describe("노출 문구(2단계 명세 §4-16 — 미국 화면에도)", () => {
  it("미국은 13F 종목 신호 + 남는 현금 SHY, 한국은 153130과 노출 맞춘 참고선 — 인자 없음은 미국", () => {
    expect(exposureNote()).toBe(exposureNote("US"));
    expect(exposureNote("US")).toBe(
      "규칙 계좌 결과는 13F 종목 신호와 주식 노출(남는 현금은 SHY)이 섞인 값입니다 — 주식 비중이 낮은 날은 SHY 수익이 섞입니다",
    );
    expect(exposureNote("KR")).toContain("(후보가 모자란 만큼과 남는 현금은 153130)");
    expect(exposureNote("KR")).toContain("점선(노출 맞춘 참고선)");
    expect(exposureNote("KR")).not.toContain("SHY");
  });
});
