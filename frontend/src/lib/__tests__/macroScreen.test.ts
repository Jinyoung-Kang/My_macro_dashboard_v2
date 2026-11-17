/**
 * 매크로 화면 모델(lib/macroScreen) — 목차 항목, 지표 표의 줄과 미리보기 칸, 절마다의 KPI 타일.
 *  - 목차: 회원 일곱·운영자 여덟, 절 id는 MACRO_SECTIONS, 지표 개수 = 카드 수(모르면 null), 하위 = 범주(닻 id 'macro-cat-…')
 *  - 지표 줄: 홈 시장 표 줄(macroCardRow)에 전일·전일값 출처·티커·장 상태 글·기준 시각을 덧붙임, 실시간 줄의 시각은 실시간 시각, 실패는 값·변화·전일 없음
 *  - KPI: 모르는 값 null('—' — 0 아님)과 사유, 음수 −(U+2212), 단위는 값과 따로, 대리 지표 배지와 주의 상태, 심화 해석 색 → 상태 톤
 */
import { describe, expect, it } from "vitest";

import { EMPTY } from "../format";
import { type MarketClock } from "../home";
import type { MacroCardView } from "../macroLive";
import {
  advancedKpis,
  advancedStatus,
  COLLECT_FAILED,
  fxKpis,
  macroCategoryAnchor,
  macroIndexItems,
  macroIndicatorGroups,
  macroIndicatorRow,
  macroRowIndex,
  riskKpis,
  spreadKpis,
} from "../macroScreen";
import { MACRO_SECTIONS } from "../marketSections";
import type { AdvancedIndicators, FxSeries, MacroItem, RiskIndicators, SpreadBlock } from "../types";

/** 2026-10-20 19:54 KST = 뉴욕 06:54 — 미국 국채 전자거래는 개장, 뉴욕 증시는 장 전(마감). */
const CLOCK: MarketClock = { now: new Date("2026-10-20T10:54:00Z"), krOfficial: null, collectedAt: "2026-10-20 19:54 KST" };

const item = (over: Partial<MacroItem>): MacroItem => ({
  key: "us10y",
  name: "미국채 10년물 수익률(%)",
  status: "ok",
  priceStr: "4.123",
  price: 4.123,
  delta: -0.012,
  pct: -0.29,
  deltaStr: "-0.012 (-0.29%)",
  prevStr: "4.135",
  ...over,
});

describe("목차 항목", () => {
  const groups = macroIndicatorGroups(
    [
      { id: "fx", title: "💱 환율", items: [item({ key: "usdkrw", name: "원/달러" }), item({ key: "dxy", name: "달러 인덱스" })] },
      { id: "us_equity", title: "미국 주가지수", items: [item({ key: "sp500", name: "S&P 500" })] },
    ],
    CLOCK,
  );

  it("회원은 일곱, 운영자는 경제 캘린더를 더해 여덟 — 절 id는 MACRO_SECTIONS", () => {
    const member = macroIndexItems(groups, false);
    expect(member.map((entry) => entry.label)).toEqual(["지표", "환율 비교", "장단기 금리차", "신용·변동성", "심화 지표", "단독 차트", "비공식 시세"]);
    expect(member.map((entry) => entry.id)).toEqual([
      MACRO_SECTIONS.indicators, MACRO_SECTIONS.fx, MACRO_SECTIONS.spreads, MACRO_SECTIONS.risk,
      MACRO_SECTIONS.advanced, MACRO_SECTIONS.single, MACRO_SECTIONS.scraped,
    ]);
    const owner = macroIndexItems(groups, true);
    expect(owner).toHaveLength(8);
    expect(owner[7]).toEqual({ id: MACRO_SECTIONS.calendar, label: "경제 캘린더" });
  });

  it("지표 개수는 카드 수, 하위 칸은 범주(앞 그림 문자 뗌·닻 id)", () => {
    const [indicators] = macroIndexItems(groups, false);
    expect(indicators.count).toBe(3);
    expect(indicators.children).toEqual([
      { id: "macro-cat-fx", label: "환율", count: 2 },
      { id: "macro-cat-us-equity", label: "미국 주가지수", count: 1 },
    ]);
  });

  it("개요를 아직 받지 못했으면 지표 개수를 모르고(null — 0 아님) 하위 칸이 없다", () => {
    const [indicators] = macroIndexItems(null, false);
    expect(indicators.count).toBeNull();
    expect(indicators.children).toEqual([]);
  });

  it("범주 닻 id는 소문자·숫자·하이픈만", () => {
    expect(macroCategoryAnchor("us_equity")).toBe("macro-cat-us-equity");
    expect(macroCategoryAnchor("KR Rates")).toBe("macro-cat-kr-rates");
  });
});

describe("지표 표의 줄", () => {
  it("홈 시장 표의 줄에 전일·티커·출처·장 상태 글·기준 시각을 덧붙인다", () => {
    const row = macroIndicatorRow(
      item({ market: "ust", ticker: "^TNX", delayMinutes: 0, isReference: true, source: "TradingView Scanner", prevSource: "FRED DGS10 (공식)",
        lastTs: "2026-10-20 19:54 KST (TradingView 수집 시각)" }),
      CLOCK,
    );
    expect(row).toMatchObject({
      id: "us10y",
      name: "미국채 10년물 수익률(%)",
      valueText: "4.123",
      change: -0.012,
      changePct: -0.29,
      changeDigits: 3,
      href: "/markets/i/us10y",
      failed: false,
      prevText: "4.135",
      prevSource: "FRED DGS10 (공식)",
      ticker: "^TNX",
      originSource: "TradingView Scanner · 참고 시세",
      sessionText: "개장 · 실시간",
      timeText: "2026-10-20 19:54 (TradingView 수집 시각)",
      legacyNote: null,
      live: false,
    });
    // 출처 배지(표의 기준 칸)는 홈과 같은 '출처 · 장 상태'와 열린 장의 지연.
    expect(row.source).toBe("TradingView Scanner · 참고 시세 · 개장");
    expect(row.delayMin).toBe(0);
  });

  it("닫힌 장은 장 상태만(지연은 툴팁), 수집 실패는 값·변화·전일이 없고 경고 '수집 실패'", () => {
    const closed = macroIndicatorRow(item({ key: "sp500", name: "S&P 500", market: "nyse", delayMinutes: 10, lastTs: "2026-10-20 04:59 KST" }), CLOCK);
    expect(closed.sessionText).toBe("마감");
    expect(closed.provenanceTitle).toContain("10분 지연");
    const failed = macroIndicatorRow(item({ status: "fail", priceStr: "N/A", deltaStr: "N/A", delta: null, pct: null }), CLOCK);
    expect(failed).toMatchObject({ failed: true, value: null, valueText: null, change: null, changePct: null, prevText: null, warning: "수집 실패", cardWarning: null });
    // 카드 경고는 따로(수집 실패와 합치지 않은 글 — 표의 기준 칸·미리보기 '알림' 줄).
    expect(macroIndicatorRow(item({ warning: "선물 조회 실패 · 지수 값" }), CLOCK).cardWarning).toBe("선물 조회 실패 · 지수 값");
  });

  it("실시간 값을 얹은 줄은 출처 배지의 시각과 기준 시각이 실시간 시각(받은 시각인지 거래 시각인지와 세션)", () => {
    const view: MacroCardView = {
      ...item({ key: "dxy", name: "달러 인덱스", source: "실시간 TradingView (TVC:DXY)", delayMinutes: 0, lastTs: "2026-11-03 06:30 KST" }),
      live: { at: "06:40:05", received: true, session: null },
    };
    const row = macroIndicatorRow(view, CLOCK);
    expect(row.live).toBe(true);
    expect(row.asOf).toBe("06:40:05 수신");
    expect(row.timeText).toBe("실시간 06:40:05 수신");
    const traded = macroIndicatorRow({ ...view, live: { at: "06:40:00", received: false, session: "프리장" } }, CLOCK);
    expect(traded.timeText).toBe("실시간 06:40:00 거래 · 프리장");
  });

  it("예전 저장본(지연 칸 없음)은 카드 알림 글을 넘긴다 — 앞 그림 문자는 뗌", () => {
    expect(macroIndicatorRow(item({ note: "⏱️ 15분 지연" }), CLOCK).legacyNote).toBe("15분 지연");
    expect(macroIndicatorRow(item({ note: "15분 지연", delayMinutes: 15 }), CLOCK).legacyNote).toBeNull();
  });

  it("범주 묶음 — 제목 그림 문자 뗌, 부제는 지연 요약, 출처는 겹치지 않게, 키로 줄을 찾음", () => {
    const groups = macroIndicatorGroups(
      [{ id: "ust", title: "🏛️ 미국 국채 수익률", items: [
        item({ key: "us02y", delayMinutes: 0, source: "TradingView Scanner", isReference: true }),
        item({ key: "us10y", delayMinutes: 0, source: "TradingView Scanner", isReference: true }),
      ] }],
      CLOCK,
    );
    expect(groups[0]).toMatchObject({ id: "ust", anchorId: "macro-cat-ust", title: "미국 국채 수익률", subtitle: "시세: 실시간" });
    expect(groups[0].source).toBe("TradingView Scanner · 참고 시세");
    expect(macroRowIndex(groups).get("us10y")?.id).toBe("us10y");
    expect(macroIndicatorGroups(null, CLOCK)).toEqual([]);
  });
});

describe("금리차 KPI", () => {
  const block = (over: Partial<SpreadBlock>): SpreadBlock => ({
    longId: "DGS10", shortId: "DGS2", points: [{ date: "2026-11-13", value: -0.25 }], latest: -0.25, previous: -0.2, ...over,
  });

  it("공식 값은 부호(+/−)·셋째 자리와 '%p'를 따로, 변화는 칩(셋째 자리·'%p'), 기준일은 시계열 마지막 날", () => {
    const { official, scraped } = spreadKpis(block({}), "10Y−2Y", -0.05);
    expect(official[0]).toMatchObject({
      label: "10Y−2Y 스프레드", value: "−0.250", unit: "%p", source: "FRED DGS10 − DGS2", asOf: "2026-11-13",
      change: { change: -0.05, digits: 3, unit: "%p" },
    });
    expect(official[1]).toMatchObject({ label: "직전 확정치", value: "−0.200", unit: "%p" });
    expect(scraped).toBeNull();
  });

  it("모르는 값은 null(0이 아님), 스크래핑 스프레드를 못 받았으면 '수집 실패', 이어받은 금리면 '이전 값'", () => {
    const { official, scraped } = spreadKpis(
      block({ latest: null, previous: null, scraped: { longValue: 4.1, shortValue: null, spread: null, previousSpread: null, delta: null, isStale: true } }),
      "10Y−2Y",
      null,
    );
    expect(official.map((tile) => tile.value)).toEqual([null, null]);
    expect(scraped?.[0]).toMatchObject({ value: null, emptyReason: COLLECT_FAILED, isStale: true, staleReason: "이전 금리 포함(수집 실패)" });
    expect(scraped?.slice(1).map((tile) => [tile.label, tile.value, tile.unit])).toEqual([["미국채 10년물", "4.100", "%"], ["미국채 2년물", null, "%"]]);
  });

  it("금리차 값 글 — 부호 + 셋째 자리(단위 '%p'는 타일 단위 칸), 모르면 null('—' — 단위 없음)", () => {
    const values = [0.5, -0.25, 0, null, Number.NaN].map((latest) => spreadKpis(block({ latest }), "10Y−2Y", null).official[0]);
    expect(values.map((tile) => tile.value)).toEqual(["+0.500", "−0.250", "0.000", null, null]);
    expect(values.every((tile) => tile.unit === "%p")).toBe(true);
  });
});

describe("신용·변동성 KPI", () => {
  const entry = (over: Record<string, unknown>) => ({ available: true, value: 18.2, delta: -0.4, asOf: "2026-11-14", ...over });
  const risk = {
    vix: entry({}),
    move: entry({ value: 92.1, isProxy: true, sourceLabel: "^TNX 변동성 기반 추정 (실제 ICE BofA MOVE 아님)" }),
    hyOas: entry({ value: 2.95, delta: 0.03 }),
    cpSpread: entry({ available: false, value: null, delta: null, asOf: null }),
    stlfsi: entry({ value: -0.52, delta: 0.1 }),
  } as unknown as RiskIndicators;

  it("다섯 타일 — 값·단위·변화(직전 대비)·기준일·출처, 음수는 −", () => {
    const tiles = riskKpis(risk);
    expect(tiles.map((tile) => tile.key)).toEqual(["vix", "move", "hyOas", "cpSpread", "stlfsi"]);
    expect(tiles[0]).toMatchObject({ value: "18.20", unit: null, note: "기준일 2026-11-14", source: "Yahoo Finance (^VIX)", change: { change: -0.4, digits: 2 } });
    expect(tiles[2]).toMatchObject({ value: "2.95", unit: "%p", change: { change: 0.03, unit: "%p" } });
    expect(tiles[4]).toMatchObject({ value: "−0.52", unit: "pt" });
  });

  it("받지 못한 지표는 '—'(null)와 '수집 실패', 대리 지표는 배지와 주의 상태 글", () => {
    const tiles = riskKpis(risk);
    expect(tiles[3]).toMatchObject({ value: null, emptyReason: COLLECT_FAILED, note: null, change: { change: null } });
    expect(tiles[1]).toMatchObject({ isProxy: true, status: { tone: "warn", text: "실제 지표가 아닙니다 — ^TNX 변동성 기반 추정 (실제 ICE BofA MOVE 아님)" } });
    expect(tiles[0].status).toBeUndefined();
  });

  it("응답이 비어도(빈 객체·null) 다섯 타일이 모두 '수집 실패'", () => {
    expect(riskKpis({}).map((tile) => [tile.value, tile.emptyReason])).toEqual(Array(5).fill([null, COLLECT_FAILED]));
    expect(riskKpis(null)).toHaveLength(5);
  });
});

describe("심화 지표 KPI", () => {
  const data: AdvancedIndicators = {
    order: ["T10Y3M", "NFCI", "DFII10", "MISSING", "BAMLC0A0CM"],
    latest: {
      T10Y3M: { id: "T10Y3M", label: "10Y-3M", unit: "%p", digits: 2, group: "금리", why: "", source: "FRED T10Y3M", available: true,
        value: -0.62, delta: -0.04, asOf: "2026-11-13", percentile: 3.4, percentileFrom: "2016-11-14", percentileCount: 2500, percentileYears: 10,
        status: "깊은 역전", color: "red", note: "침체가 뒤따른 구간입니다." },
      NFCI: { id: "NFCI", label: "NFCI", unit: "", digits: 3, group: "금융상황", why: "", source: "FRED NFCI", available: true,
        value: -0.5, delta: 0.01, asOf: "2026-11-07", status: "완화", color: "blue" },
      DFII10: { id: "DFII10", label: "10년 실질금리", unit: "%", digits: 2, group: "금리", why: "", source: "FRED DFII10", available: false },
      BAMLC0A0CM: { id: "BAMLC0A0CM", label: "IG 스프레드", unit: "%p", digits: 2, group: "신용", why: "", source: "FRED", available: true,
        value: 0.8, delta: null, status: "정상", color: "green" },
    },
    derived: {},
  };

  it("응답 차례 그대로(없는 id는 뺌), 값·단위·변화·출처, 메모는 해석 글 다음에 '표본 백분위 · 표본 · 기준일'", () => {
    const tiles = advancedKpis(data);
    expect(tiles.map((tile) => tile.key)).toEqual(["T10Y3M", "NFCI", "DFII10", "BAMLC0A0CM"]);
    expect(tiles[0]).toMatchObject({
      value: "−0.62", unit: "%p", source: "FRED T10Y3M", change: { change: -0.04, digits: 2, unit: "%p" },
      note: "침체가 뒤따른 구간입니다. 표본 백분위 3.4% · 표본 2016-11-14 이후 2,500개 · 약 10.0년 · 기준일 2026-11-13",
    });
  });

  it("해석 색은 아이콘 + 글의 상태 톤 — 초록 정상·주황 주의·빨강 위험('주의:' 머리말), 파랑은 톤 없이 메모 맨 앞 '상태: ….'", () => {
    const tiles = advancedKpis(data);
    expect(tiles[0].status).toEqual({ tone: "danger", text: "깊은 역전", srPrefix: "주의: ", icon: "alert" });
    expect(tiles[1].status).toBeUndefined();
    expect(tiles[1].note).toBe("상태: 완화. 기준일 2026-11-07");
    // 해석 글이 있으면 '상태' 다음, 표본·기준일 앞.
    const blue = advancedKpis({ ...data, latest: { ...data.latest, NFCI: { ...data.latest.NFCI, note: "평균보다 완화적입니다." } } })[1];
    expect(blue.note).toBe("상태: 완화. 평균보다 완화적입니다. 기준일 2026-11-07");
    expect(tiles[3].status).toEqual({ tone: "ok", text: "정상" });
    expect(advancedStatus({ status: "경계", color: "orange" })).toEqual({ tone: "warn", text: "경계" });
    expect(advancedStatus({ status: "경계", color: "yellow" })).toEqual({ tone: "warn", text: "경계" });
    expect(advancedStatus({ status: "", color: "red" })).toBeNull();
  });

  it("받지 못한 지표는 '—'와 '수집 실패'(상태·표본 없음), 응답이 없으면 타일 없음", () => {
    const tiles = advancedKpis(data);
    expect(tiles[2]).toMatchObject({ value: null, emptyReason: COLLECT_FAILED });
    expect(tiles[2].status).toBeUndefined();
    expect(tiles[2].note).toBeUndefined();
    expect(advancedKpis(null)).toEqual([]);
  });
});

describe("환율 비교 KPI", () => {
  const series = (over: Partial<FxSeries>): FxSeries => ({
    id: "usdkrw", label: "원/달러", unit: "원", ticker: "KRW=X", available: true, latest: 1389.456, latestDate: "2026-11-14",
    baseDate: "2025-11-14", baseValue: 1300, changePct: 6.88, points: [], ...over,
  });

  it("끝값(둘째 자리)·단위, 기간 변화율, 메모 '기준일 … · 최근 …' — 모르면 null", () => {
    const [krw, dxy] = fxKpis([series({}), series({ id: "dxy", label: "달러 인덱스", unit: null, latest: null, changePct: -1.2, latestDate: null })]);
    expect(krw).toMatchObject({ value: "1,389.46", unit: "원", change: { changePct: 6.88, pctDigits: 2, caption: "기간" }, note: "기준일 2025-11-14 · 최근 2026-11-14" });
    expect(dxy).toMatchObject({ value: null, unit: null, note: `기준일 2025-11-14 · 최근 ${EMPTY}` });
  });
});
