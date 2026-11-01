/**
 * 개요 '지금 값' 표시 규칙(lib/paperCurrent, 장중 명세 2026-10-31 §3·§4-1) — 단계 표기는 한 함수, 없는 값은 짓지 않는다.
 *
 *  - 단계 표기: 다섯 단계와 출발 전, 장부 표기는 지금 세션일 때만 시각만(아니면 날짜를 붙임), 시각·거래일을 모르면 그것 없이
 *  - '오늘' 이름: 정규장·마감 뒤의 같은 세션만 '오늘', 휴장(세션 날짜 = 직전 거래일)·개장 전은 'MM-DD 변화'('하루'라 적지 않음 — 기준 줄이
 *    바로 전 거래일이 아닐 수 있음)
 *  - 기준 글·덧붙임(섞임·체결 대기 미국·한국)·지금 값 보기(옛 응답은 장부 값 그대로)·카드 부제·출처·장부 한 줄
 *  - 한 표 한 기준: 모두 장중이면 지금 값 칸, 비중립 하나라도 아니면 장부 칸 + 사유, 기준 중립은 판정에서 뺌, '최근 변화' 이름
 */
import { describe, expect, it } from "vitest";

import {
  accountsBasisText,
  comparisonBasis,
  currentNotes,
  currentSource,
  currentView,
  dayBaseText,
  dayChange,
  dayLabel,
  inCurrentSession,
  isLiveStage,
  ledgerObservedLine,
  stageLabel,
} from "../paperCurrent";
import { PAPER_SOURCES } from "../paper";
import type { PaperCurrentValue, PaperLiveSessionSummary, PaperOverviewBook } from "../types";

const REGULAR: PaperLiveSessionSummary = { phase: "REGULAR", sessionDate: "2026-10-30" };
const AFTER: PaperLiveSessionSummary = { phase: "AFTER", sessionDate: "2026-10-30" };
// 일요일 — 휴장의 세션 날짜는 직전 거래일(금요일)입니다(서버 LiveValuation.session).
const SUNDAY: PaperLiveSessionSummary = { phase: "CLOSED", sessionDate: "2026-10-30" };
const PRE: PaperLiveSessionSummary = { phase: "PRE", sessionDate: "2026-11-02" };

function current(over: Partial<PaperCurrentValue> = {}): PaperCurrentValue {
  return {
    nav: 101234.56, returnPct: 1.23, exposurePct: 98.7, dayChangePct: 0.42, previousTradingDate: "2026-10-29", previousNavFinal: false,
    basis: "LIVE", stage: "LIVE", tradingDate: "2026-10-30", atKst: "2026-10-30 23:58 KST", isEstimated: true, livePriced: 2,
    positionCount: 2, pendingOrders: 0, neutral: false, note: null, ...over,
  };
}

function book(code: string, over: Partial<PaperOverviewBook> = {}): PaperOverviewBook {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000, cash: 200, nav: 101200,
    equityValue: 101000, exposurePct: 99.8, returnPct: 1.2, lastObservedAtKst: "2026-10-30 23:15 KST", positions: 2, staleCount: 0,
    stats: null, benchmark: null, ...over,
  };
}

describe("단계 표기 — 한 함수", () => {
  it("다섯 단계와 출발 전", () => {
    expect(stageLabel(current())).toBe("장중 추정 23:58");
    expect(stageLabel(current({ stage: "LIVE_LAST", atKst: "2026-10-31 05:00 KST" }))).toBe("장중 마지막 추정 05:00 · 종가 확정 전");
    expect(stageLabel(current({ stage: "PROVISIONAL", tradingDate: "2026-10-30" }))).toBe("10-30 잠정");
    expect(stageLabel(current({ stage: "FINAL", tradingDate: "2026-10-30" }))).toBe("10-30 확정");
    expect(stageLabel(current({ stage: "LEDGER" }), { status: "NOT_STARTED" })).toBe("출발 전");
  });

  it("장부 단계는 값의 거래일이 지금 세션일 때만 시각만 — 장 밖·주말·다른 세션이면 날짜를 붙인다(KST 자정을 넘긴 미국 정규장 포함)", () => {
    const ledger = current({ stage: "LEDGER", basis: "LEDGER", isEstimated: false, atKst: "2026-10-31 02:15 KST", tradingDate: "2026-10-30" });
    expect(stageLabel(ledger, { session: REGULAR })).toBe("장부 02:15");
    expect(stageLabel(ledger, { session: AFTER })).toBe("장부 02:15");
    expect(stageLabel(ledger, { session: SUNDAY })).toBe("장부 10-31 02:15");
    expect(stageLabel(ledger, { session: PRE })).toBe("장부 10-31 02:15");
    expect(stageLabel(ledger)).toBe("장부 10-31 02:15");
    expect(stageLabel({ ...ledger, tradingDate: "2026-10-29" }, { session: REGULAR })).toBe("장부 10-31 02:15");
  });

  it("시각·거래일을 모르면 그것 없이 — 짐작하지 않는다", () => {
    expect(stageLabel(current({ atKst: null }))).toBe("장중 추정");
    expect(stageLabel(current({ stage: "LIVE_LAST", atKst: "언젠가" }))).toBe("장중 마지막 추정 · 종가 확정 전");
    expect(stageLabel(current({ stage: "LEDGER", atKst: null }), { session: REGULAR })).toBe("장부");
    expect(stageLabel(current({ stage: "FINAL", tradingDate: null }))).toBe("확정");
    // 모르는 단계(새 서버 값)는 받은 글 그대로
    expect(stageLabel(current({ stage: "SOMETHING" as PaperCurrentValue["stage"] }))).toBe("SOMETHING");
  });

  it("장중 단계 판정·지금 세션 판정", () => {
    expect([isLiveStage("LIVE"), isLiveStage("LIVE_LAST"), isLiveStage("LEDGER"), isLiveStage("FINAL"), isLiveStage(undefined)])
      .toEqual([true, true, false, false, false]);
    expect(inCurrentSession("2026-10-30", REGULAR)).toBe(true);
    expect(inCurrentSession("2026-10-30", SUNDAY)).toBe(false);
    expect(inCurrentSession(null, REGULAR)).toBe(false);
    expect(inCurrentSession("2026-10-30", null)).toBe(false);
    expect(inCurrentSession("", { phase: "REGULAR", sessionDate: null })).toBe(false);
  });
});

describe("'오늘' 이름과 기준 글", () => {
  it("정규장·마감 뒤의 같은 세션만 '오늘' — 휴장(직전 거래일)·개장 전은 'MM-DD 변화', 거래일을 모르면 '변화'", () => {
    expect(dayLabel("2026-10-30", REGULAR)).toBe("오늘");
    expect(dayLabel("2026-10-30", AFTER)).toBe("오늘");
    expect(dayLabel("2026-10-30", SUNDAY)).toBe("10-30 변화");
    expect(dayLabel("2026-10-30", PRE)).toBe("10-30 변화");
    expect(dayLabel("2026-10-30", null)).toBe("10-30 변화");
    expect(dayLabel(null, REGULAR)).toBe("변화");
  });

  it("기준 글 — 잠정·확정·모름, 기준 줄이 없으면 null", () => {
    expect(dayBaseText("2026-10-29", false)).toBe("10-29 잠정 대비");
    expect(dayBaseText("2026-10-29", true)).toBe("10-29 확정 대비");
    expect(dayBaseText("2026-10-29", null)).toBe("10-29 대비");
    expect(dayBaseText(null, true)).toBeNull();
  });

  it("변화 한 줄 — 서버 값 그대로, 모르면 줄 없음(0.00%를 짓지 않음)", () => {
    expect(dayChange(current(), REGULAR)).toEqual({ pct: 0.42, label: "오늘", base: "10-29 잠정 대비", text: "오늘 +0.42% · 10-29 잠정 대비" });
    expect(dayChange(current({ dayChangePct: -0.1, previousNavFinal: true }), SUNDAY).text).toBe("10-30 변화 -0.10% · 10-29 확정 대비");
    // 앞의 마지막 순자산 줄이 바로 전 거래일이 아니면(10-30 값의 기준이 10-23 줄 — 그 사이 줄 없음) 기준 글이 그 간격을 밝힘('하루'라 적지 않음)
    expect(dayChange(current({ dayChangePct: -1.54, previousTradingDate: "2026-10-23", previousNavFinal: true }), SUNDAY).text)
      .toBe("10-30 변화 -1.54% · 10-23 확정 대비");
    expect(dayChange(current({ dayChangePct: 0.42, previousTradingDate: "2026-10-23", previousNavFinal: true }), REGULAR).text)
      .toBe("오늘 +0.42% · 10-23 확정 대비");
    expect(dayChange(current({ previousTradingDate: null }), REGULAR).text).toBe("오늘 +0.42%");
    expect(dayChange(current({ dayChangePct: null }), REGULAR)).toMatchObject({ pct: null, text: null, label: "오늘" });
  });
});

describe("덧붙임", () => {
  it("섞임 — 장중 추정인데 장중가로 평가하지 못한 보유가 있으면 '장중가 n/m종목'", () => {
    expect(currentNotes(current({ livePriced: 1, positionCount: 2 }))).toEqual(["장중가 1/2종목"]);
    expect(currentNotes(current())).toEqual([]);
    // 장부 단계는 섞임이 아님(livePriced 0)
    expect(currentNotes(current({ isEstimated: false, livePriced: 0, positionCount: 2 }))).toEqual([]);
  });

  it("체결 대기 — 미국 '체결 대기 n건 반영 전', 한국 '시가 체결 대기 n건 반영 전', 모르면(null) 없음", () => {
    expect(currentNotes(current({ pendingOrders: 1 }))).toEqual(["체결 대기 1건 반영 전"]);
    expect(currentNotes(current({ pendingOrders: 3 }), "KR")).toEqual(["시가 체결 대기 3건 반영 전"]);
    expect(currentNotes(current({ pendingOrders: null }))).toEqual([]);
    expect(currentNotes(current({ livePriced: 1, pendingOrders: 2 }))).toEqual(["장중가 1/2종목", "체결 대기 2건 반영 전"]);
  });
});

describe("지금 값 보기", () => {
  it("지금 값 — 순자산·수익률·노출은 current, 단계 표기·추정·덧붙임·변화 한 줄", () => {
    const view = currentView(book("rules", { current: current({ livePriced: 1, note: "장중가 1/2종목 — 나머지는 장부 관측가" }) }), { session: REGULAR });
    expect(view).toEqual({
      from: "current", nav: 101234.56, returnPct: 1.23, exposurePct: 98.7, stageLabel: "장중 추정 23:58", isEstimated: true, neutral: false,
      notes: ["장중가 1/2종목"], note: "장중가 1/2종목 — 나머지는 장부 관측가",
      day: { pct: 0.42, label: "오늘", base: "10-29 잠정 대비", text: "오늘 +0.42% · 10-29 잠정 대비" }, atKst: "2026-10-30 23:58 KST",
    });
  });

  it("옛 응답(current 없음·null) — 장부 값 그대로, 단계 표기 자리에 '마지막 관측 …', 덧붙임·변화 한 줄 없음, 추정 아님", () => {
    for (const entry of [book("rules"), book("rules", { current: null })]) {
      expect(currentView(entry, { session: REGULAR })).toEqual({
        from: "ledger", nav: 101200, returnPct: 1.2, exposurePct: 99.8, stageLabel: "마지막 관측 2026-10-30 23:15", isEstimated: false,
        neutral: false, notes: [], note: null, day: null, atKst: "2026-10-30 23:15 KST",
      });
    }
    expect(currentView(book("x", { lastObservedAtKst: null })).stageLabel).toBeNull();
  });

  it("지금 순자산이 null(출발 전·장부 상태 없음)이면 장부 칸 셋을 함께 — 섞지 않음, 서버 글 '출발 전'은 단계 표기와 겹쳐 빼고", () => {
    const waiting = book("claude", {
      status: "NOT_STARTED", nav: 100000, returnPct: null, exposurePct: 0,
      current: current({ nav: null, returnPct: 5, exposurePct: 50, stage: "LEDGER", basis: "LEDGER", isEstimated: false, neutral: true,
        note: "출발 전", dayChangePct: null }),
    });
    const view = currentView(waiting);
    expect(view).toMatchObject({ nav: 100000, returnPct: null, exposurePct: 0, stageLabel: "출발 전", neutral: true, note: null, isEstimated: false });
    expect(view.day?.text).toBeNull();
  });

  it("현금뿐(기준 중립) — 추정 아님, 배지 없이 단계 표기만", () => {
    const cash = currentView(book("bench_mix", {
      current: current({ stage: "LEDGER", basis: "LEDGER", isEstimated: false, neutral: true, livePriced: 0, positionCount: 0,
        tradingDate: "2026-10-30", atKst: "2026-10-30 23:15 KST" }),
    }), { session: REGULAR });
    expect(cash).toMatchObject({ isEstimated: false, neutral: true, stageLabel: "장부 23:15", notes: [] });
  });

  it("'계좌' 카드 부제 — 옛 응답이면 null, 지금 값이면 '행마다 단계 표기', 장중 추정이 있으면 '표시 전용'", () => {
    expect(accountsBasisText([book("rules"), book("bench_spy")])).toBeNull();
    expect(accountsBasisText([book("rules", { current: current({ stage: "FINAL", isEstimated: false }) })])).toBe("지금 값 기준(행마다 단계 표기)");
    expect(accountsBasisText([book("rules", { current: current() }), book("x")])).toBe("지금 값 기준(행마다 단계 표기) — 장중 추정은 표시 전용");
  });

  it("출처 — 장부 출처, 추정이면 장중 시세로 다시 평가한 표시 전용 추정(데이터셋 이름은 적지 않음)", () => {
    expect(currentSource(false)).toBe(PAPER_SOURCES.ledger);
    expect(currentSource(false, "KR")).toBe(PAPER_SOURCES.krLedger);
    expect(currentSource(true)).toBe(`${PAPER_SOURCES.ledger} · 보유를 장중 1분봉 시세로 다시 평가한 표시 전용 추정(장중 시세 카드의 출처)`);
    expect(currentSource(true, "KR")).not.toMatch(/paper\.live|SPY|SHY|사후 체결/);
  });

  it("계좌 상세의 장부 한 줄 — 장부 순자산과 마지막 관측(MM-DD HH:MM), 모르면 '—'·괄호 없이", () => {
    expect(ledgerObservedLine({ nav: 101200, lastObservedAtKst: "2026-10-24 05:15" }))
      .toBe("장부 마지막 관측 101,200.00 달러 (10-24 05:15) — 아래 구성·현금·보유·체결은 장부 값");
    expect(ledgerObservedLine({ nav: 100_312_450, lastObservedAtKst: "2026-10-30 22:05 KST" }, "KR"))
      .toBe("장부 마지막 관측 100,312,450원 (10-30 22:05) — 아래 구성·현금·보유·체결은 장부 값");
    expect(ledgerObservedLine({ nav: null, lastObservedAtKst: null })).toBe("장부 마지막 관측 — — 아래 구성·현금·보유·체결은 장부 값");
  });
});

describe("한 표 한 기준(계좌 비교)", () => {
  const live = (code: string, over: Partial<PaperCurrentValue> = {}) => book(code, { label: `${code} 계좌`, current: current(over) });
  const ledgerDay = (tradingDate: string | null) => ({ tradingDate, dayChangePct: 0.1, previousTradingDate: "2026-10-29", previousNavFinal: true });

  it("판정 대상이 모두 LIVE·LIVE_LAST면 지금 값 칸('오늘 변화'), 사유 없음", () => {
    expect(comparisonBasis([live("rules"), live("bench_spy", { stage: "LIVE_LAST" })], AFTER))
      .toEqual({ hasCurrent: true, mode: "live", reason: null, dayLabel: "오늘 변화" });
  });

  it("비중립 계좌 하나라도 장중이 아니면 표 전체 장부 칸 + 사유(그 계좌의 단계 표기)", () => {
    const basis = comparisonBasis([
      live("rules"),
      live("bench_spy", { stage: "LEDGER", basis: "LEDGER", isEstimated: false, atKst: "2026-10-30 23:15 KST" }),
    ], REGULAR);
    expect(basis.mode).toBe("ledger");
    expect(basis.reason).toBe("장중 추정이 아닌 계좌가 있어 표 전체를 장부 기준으로 둡니다 — bench_spy 계좌(장부 23:15)");
  });

  it("기준 중립(현금뿐·출발 전)은 판정에서 뺀다 — current가 null인 계좌는 장중이 아닌 것으로 셈", () => {
    const cash = live("bench_mix", { stage: "LEDGER", basis: "LEDGER", isEstimated: false, neutral: true });
    expect(comparisonBasis([live("rules"), cash], REGULAR).mode).toBe("live");
    const gone = book("claude", { label: "Claude 계좌", current: null });
    expect(comparisonBasis([live("rules"), gone], REGULAR).reason).toBe(
      "장중 추정이 아닌 계좌가 있어 표 전체를 장부 기준으로 둡니다 — Claude 계좌(지금 값 없음)",
    );
  });

  it("장중 계좌가 없으면(장 밖) 장부 칸이고 사유는 없다 — 관측 세션이 지금 세션이 아니면 '최근 변화'", () => {
    const final = (code: string) => book(code, {
      current: current({ stage: "FINAL", basis: "LEDGER", isEstimated: false }), ledgerDay: ledgerDay("2026-10-30"),
    });
    expect(comparisonBasis([final("rules"), final("bench_spy")], SUNDAY))
      .toEqual({ hasCurrent: true, mode: "ledger", reason: null, dayLabel: "최근 변화" });
    expect(comparisonBasis([final("rules"), final("bench_spy")], AFTER).dayLabel).toBe("오늘 변화");
  });

  it("옛 응답이면 hasCurrent false — 표는 지금과 같은 줄 목록", () => {
    expect(comparisonBasis([book("rules"), book("bench_spy")], REGULAR)).toEqual({ hasCurrent: false, mode: "ledger", reason: null, dayLabel: "최근 변화" });
  });
});
