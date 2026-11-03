/**
 * 장중 시세 화면 자료(lib/paperLive) — 고정하는 규칙
 *  - 새로고침 간격(분 — 실시간 시세 주기에서 lib/livePrices serverRefreshMinutes로 셈): 정규장에만 그 간격(그 밖은 0 — 다시 읽지 않음), 긴 간격은 미국만 안내
 *  - 장 밖이면 다음 개장 + 1분에 한 번 깨어남(하루 넘게 남거나 시각을 모르면 깨지 않음)
 *  - 고른 계좌의 종목 줄(없거나 모르는 계좌면 첫 계좌, 계좌가 없으면 null) — 모든 가격에 기준 시각("장중 …"·"마지막 관측 …"), 모르는 값은 "—"
 *  - 실시간 시세(ADR 0024)가 있는 종목은 그 가격으로 다시 셈 — 기준 시각 "실시간 HH:mm:ss", 평균 단가 대비·직전 종가 대비, 비중은 서버 값 그대로
 */
import { describe, expect, it } from "vitest";
import {
  liveIntervalNote,
  livePositionsFor,
  livePositionView,
  liveQuotesWarning,
  liveRefreshMs,
  liveRevision,
  liveSessionView,
  msUntilNextOpen,
  parseKstStamp,
  realtimeBookNav,
} from "../paperLive";
import { latestObserved } from "../paperOverview";
import type { LivePrice, PaperBookSummary, PaperLiveBook, PaperLiveResponse, PaperLiveSession } from "../types";

const REGULAR: PaperLiveSession = {
  phase: "REGULAR", sessionDate: "2026-10-30", openAtKst: "2026-10-30 22:30 KST", closeAtKst: "2026-10-31 05:00 KST",
  nextOpenAtKst: "2026-11-02 23:30 KST",
};

function book(over: Partial<PaperLiveBook> = {}): PaperLiveBook {
  return {
    code: "claude", label: "Claude 계좌", status: "ACTIVE", initialCash: 100000, cash: 10000, nav: 100000, returnPct: 0,
    previousNav: 99000, previousTradingDate: "2026-10-29", dayChangePct: 1.01, basis: "LIVE", basisAtKst: "2026-10-30 23:58 KST",
    liveCount: 1, positionCount: 2,
    positions: [
      { ticker: "AAA", qty: 100, avgCost: 400, price: 420, priceAtKst: "2026-10-30 23:58 KST", priceBasis: "LIVE", value: 42000,
        weightPct: 42, returnPct: 5, previousClose: 410, dayChangePct: 2.44 },
      { ticker: "BBB", qty: 200, avgCost: 250, price: 240, priceAtKst: "2026-10-30 06:05 KST", priceBasis: "LAST_OBSERVATION",
        value: 48000, weightPct: 48, returnPct: -4, previousClose: null, dayChangePct: null },
    ],
    ...over,
  };
}

describe("새로고침 간격", () => {
  it("긴 간격(1시간 이상)은 미국만 '대개 장부 단계' 안내 — 한국은 정규장에 장부 관측이 없음", () => {
    expect(liveIntervalNote(60)).toMatch(/^간격이 길면 그 사이 매시 장부 관측이 돌아/);
    expect(liveIntervalNote(180, "US")).not.toBeNull();
    expect(liveIntervalNote(30)).toBeNull();
    expect(liveIntervalNote(0)).toBeNull();
    expect(liveIntervalNote(180, "KR")).toBeNull();
    expect(liveRefreshMs({ available: true, session: REGULAR }, 180)).toBe(3 * 60 * 60_000);
  });

  it("정규장에만 그 간격, 끄기·장 밖이면 0", () => {
    const regular = { available: true, session: REGULAR } as PaperLiveResponse;
    expect(liveRefreshMs(regular, 5)).toBe(300_000);
    expect(liveRefreshMs(regular, 0)).toBe(0);
    expect(liveRefreshMs({ available: true, session: { ...REGULAR, phase: "AFTER" } }, 5)).toBe(0);
    expect(liveRefreshMs(null, 5)).toBe(0);
  });

  it("KST 시각 글을 읽고, 장 밖이면 다음 개장 + 1분까지 기다린다", () => {
    expect(parseKstStamp("2026-11-02 23:30 KST")).toBe(Date.parse("2026-11-02T14:30:00Z"));
    expect(parseKstStamp("2026-11-02T23:30")).toBeNull();
    const closed = { ...REGULAR, phase: "CLOSED" as const, nextOpenAtKst: "2026-10-31 00:00 KST" };
    const now = Date.parse("2026-10-30T14:00:00Z"); // KST 10-30 23:00
    expect(msUntilNextOpen(closed, now)).toBe(60 * 60_000 + 60_000);
    expect(msUntilNextOpen(REGULAR, now)).toBeNull();
    expect(msUntilNextOpen({ ...closed, nextOpenAtKst: "2026-11-02 23:30 KST" }, now)).toBeNull(); // 하루 넘게
    expect(msUntilNextOpen({ ...closed, nextOpenAtKst: null }, now)).toBeNull();
  });
});

describe("장 상태 문구", () => {
  it("정규장은 화면을 볼 때만 받는다는 것과 출처, 장 밖은 무엇을 기준으로 하는지", () => {
    const quotes = { source: "Yahoo(yfinance) 1분봉", collectedAtKst: null, refreshRequested: false, missing: [], error: null };
    expect(liveSessionView(REGULAR, quotes)).toEqual({
      label: "정규장", detail: "장중 1분봉 시세로 다시 평가 — 화면을 볼 때만 받습니다 · 출처 Yahoo(yfinance) 1분봉", live: true,
    });
    expect(liveSessionView({ ...REGULAR, phase: "PRE", nextOpenAtKst: "2026-10-30 22:30 KST" }, quotes).detail)
      .toBe("개장 10-30 22:30 KST부터 장중 값 — 지금은 장부의 마지막 관측치 기준");
    expect(liveSessionView({ ...REGULAR, phase: "CLOSED" }, null)).toEqual({
      label: "휴장", detail: "장부의 마지막 관측치 기준 · 다음 개장 11-02 23:30 KST", live: false,
    });
    expect(liveSessionView({ ...REGULAR, phase: "UNKNOWN" }, null).label).toBe("장 시각 모름");
  });
});

describe("종목 줄", () => {
  it("고른 계좌의 종목 — 평균 단가, 가격 기준(장중·마지막 관측)과 시각·직전 종가 대비·평균 단가 대비·비중", () => {
    const response = { available: true, books: [book(), book({ code: "rules", label: "규칙 계좌", positionCount: 0, positions: [] })] };
    const view = livePositionsFor(response, "claude");
    expect(view).toMatchObject({ code: "claude", label: "Claude 계좌" });
    expect(view?.positions[0]).toMatchObject({ ticker: "AAA", avgCost: "400.0000", price: "420.0000", priceAt: "장중 10-30 23:58", live: true,
      dayText: "+2.44%", returnText: "+5.00%", weight: "42.0%" });
    expect(view?.positions[1]).toMatchObject({ priceAt: "마지막 관측 10-30 06:05", live: false, dayText: "—" });
    expect(livePositionsFor(response, "rules")).toEqual({ code: "rules", label: "규칙 계좌", positions: [] });
  });

  it("고르지 않았거나 응답에 없는 계좌면 첫 계좌, 계좌가 없으면 null", () => {
    const response = { available: true, books: [book(), book({ code: "rules", label: "규칙 계좌" })] };
    expect(livePositionsFor(response, null)?.code).toBe("claude");
    expect(livePositionsFor(response, "gone")?.code).toBe("claude");
    expect(livePositionsFor({ available: true, books: [] }, "claude")).toBeNull();
    expect(livePositionsFor({ available: false }, "claude")).toBeNull();
    expect(livePositionsFor(null, "claude")).toBeNull();
  });

  it("모르는 값은 —, 한국은 원 정수", () => {
    expect(livePositionView({ ...book().positions[0], avgCost: 70250.5, price: 71000, priceBasis: null, priceAtKst: null }, "KR"))
      .toMatchObject({ avgCost: "70,251", price: "71,000", priceAt: "—" });
    expect(livePositionView({ ...book().positions[0], weightPct: null, returnPct: null, dayChangePct: null }))
      .toMatchObject({ weight: "—", returnText: "—", dayText: "—" });
  });

  it("실시간 시세가 있으면 그 가격으로 — 기준 시각은 실시간 거래 시각, 평균 단가·직전 종가 대비는 다시 셈, 비중은 서버 값", () => {
    const realtime: LivePrice = {
      market: "US", code: "AAA", price: 440, prevClose: 410, change: 30, changePct: 7.32, currency: "USD",
      tradedAt: "2026-10-30T14:58:07Z", status: "OPEN", source: "Yahoo", overPrice: null, overChange: null, overChangePct: null,
      overTradedAt: null, overSession: null,
    };
    const view = livePositionsFor({ available: true, books: [book()] }, "claude", "US", { "US:AAA": realtime });
    expect(view?.positions[0]).toMatchObject({
      avgCost: "400.0000", price: "440.0000", priceAt: "실시간 23:58:07", live: true, realtime: true, returnText: "+10.00%", dayText: "+7.32%",
      weight: "42.0%",
    });
    expect(view?.positions[0].priceTitle).toBe("실시간 Yahoo · 기준 23:58:07 KST · 정규장");
    expect(view?.positions[1]).toMatchObject({ realtime: false, priceTitle: null, priceAt: "마지막 관측 10-30 06:05" });
    // 등락률이 없으면 직전 종가로 셈, 평단을 모르면 "—"
    const noPct = livePositionView({ ...book().positions[0], avgCost: null }, "US", { ...realtime, changePct: null });
    expect(noPct).toMatchObject({ avgCost: "—", dayText: "+7.32%", returnText: "—" });
    // 애프터장이 열려 있으면 그 가격과 이름(사용자 요청 2026-11-03)
    const after = livePositionView(book().positions[0], "US", {
      ...realtime, status: "POST", overPrice: 450, overChange: 10, overChangePct: 2.27, overTradedAt: "2026-10-30T21:10:00Z", overSession: "AFTER_MARKET",
    });
    expect(after).toMatchObject({ price: "450.0000", priceAt: "애프터장 06:10:00", dayText: "+2.27%", returnText: "+12.50%" });
  });

  it("장중 값의 판 — 수집 시각과 계좌마다 기준 시각, 쓸 수 없는 응답이면 null", () => {
    const quotes = { source: null, collectedAtKst: "2026-10-30 23:58 KST", refreshRequested: false, missing: [], error: null };
    const first = liveRevision({ available: true, quotes, books: [book(), book({ code: "rules", basisAtKst: null })] });
    expect(first).toBe("2026-10-30 23:58 KST|claude=2026-10-30 23:58 KST,rules=");
    // 같은 저장본을 다시 읽으면 같은 판, 수집 시각이나 계좌의 기준 시각이 바뀌면 다른 판.
    expect(liveRevision({ available: true, quotes, books: [book(), book({ code: "rules", basisAtKst: null })] })).toBe(first);
    expect(liveRevision({ available: true, quotes: { ...quotes, collectedAtKst: "2026-10-31 00:28 KST" }, books: [book()] }))
      .not.toBe(first);
    expect(liveRevision({ available: true, quotes, books: [book({ basisAtKst: "2026-10-31 00:27 KST" })] }))
      .not.toBe(liveRevision({ available: true, quotes, books: [book()] }));
    expect(liveRevision({ available: false })).toBeNull();
    expect(liveRevision(null)).toBeNull();
  });

  it("받지 못한 종목 경고 — 없으면 null, 이름은 다섯 개까지", () => {
    const quotes = { source: null, collectedAtKst: null, refreshRequested: false, missing: [] as string[], error: null };
    expect(liveQuotesWarning(quotes)).toBeNull();
    expect(liveQuotesWarning({ ...quotes, missing: ["A", "B", "C", "D", "E", "F"] }))
      .toBe("장중 시세를 받지 못한 종목: A, B, C, D, E 외 1 — 마지막 관측 가격으로 평가");
    expect(liveQuotesWarning({ ...quotes, error: "거부됨 — Yahoo 429" })).toBe("장중 시세 수집 오류 — 거부됨 — Yahoo 429");
  });

  it("계좌 숫자의 기준 시각 — 마지막 관측 시각 중 가장 늦은 것, 모르면 null", () => {
    const summary = (stamp: string | null) => ({ lastObservedAtKst: stamp }) as PaperBookSummary;
    expect(latestObserved([summary("2026-10-30 06:05 KST"), summary("2026-10-30 06:15 KST"), summary(null)])).toBe("2026-10-30 06:15");
    expect(latestObserved([summary(null)])).toBeNull();
  });
});

describe("실시간 순자산(개요 히어로 — 사용자 결정 2026-11-03)", () => {
  const live = (code: string, price: number, extra: Partial<LivePrice> = {}): LivePrice => ({
    market: "US", code, price, prevClose: null, change: null, changePct: null, currency: "USD", tradedAt: "2026-10-30T14:58:07Z",
    status: "OPEN", source: "네이버", overPrice: null, overChange: null, overChangePct: null, overTradedAt: null, overSession: null, ...extra,
  });

  it("현금 + 보유 수량 × 가격(실시간이 있으면 그 가격, 없으면 서버 장중 가격) — 출발·앞 줄 대비 %와 실시간 가격 수", () => {
    // book(): 현금 10,000, AAA 100주(서버 420), BBB 200주(서버 240), 출발 100,000, 앞 줄 99,000
    const nav = realtimeBookNav(book(), "US", { "US:AAA": live("AAA", 430) });
    expect(nav).toMatchObject({ code: "claude", nav: 10_000 + 100 * 430 + 200 * 240, priced: 1, total: 2, at: "2026-10-30T14:58:07Z" });
    expect(nav?.returnPct).toBeCloseTo((101_000 / 100_000 - 1) * 100);
    expect(nav?.dayChangePct).toBeCloseTo((101_000 / 99_000 - 1) * 100);
  });

  it("애프터장이 열려 있으면 그 가격, 실시간 가격이 하나도 없거나 현금·가격을 모르면 null(지어내지 않음)", () => {
    const after = realtimeBookNav(book(), "US", { "US:AAA": live("AAA", 430, { status: "POST", overPrice: 440, overTradedAt: "2026-10-30T21:10:00Z" }) });
    expect(after?.nav).toBe(10_000 + 100 * 440 + 200 * 240);
    expect(after?.at).toBe("2026-10-30T21:10:00Z");
    expect(realtimeBookNav(book(), "US", {})).toBeNull();
    expect(realtimeBookNav({ ...book(), cash: null }, "US", { "US:AAA": live("AAA", 430) })).toBeNull();
    const unknown = book();
    unknown.positions[1] = { ...unknown.positions[1], price: null };
    expect(realtimeBookNav(unknown, "US", { "US:AAA": live("AAA", 430) })).toBeNull();
    expect(realtimeBookNav(null, "US", { "US:AAA": live("AAA", 430) })).toBeNull();
  });
});
