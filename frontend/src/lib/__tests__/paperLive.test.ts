/**
 * 장중 시세 화면 자료(lib/paperLive) — 고정하는 규칙
 *  - 새로고침 간격: 선택지(끄기·1·2·5·10·15·30분·1시간·3시간) 밖의 저장 값은 기본 30분, 정규장에만 그 간격(그 밖은 0 — 다시 읽지 않음)
 *  - 장 밖이면 다음 개장 + 1분에 한 번 깨어남(하루 넘게 남거나 시각을 모르면 깨지 않음)
 *  - 고른 계좌의 종목 줄(없거나 모르는 계좌면 첫 계좌, 계좌가 없으면 null) — 모든 가격에 기준 시각("장중 …"·"마지막 관측 …"), 모르는 값은 "—"
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIVE_REFRESH_MINUTES,
  LIVE_REFRESH_OPTIONS,
  liveIntervalText,
  livePositionsFor,
  livePositionView,
  liveQuotesWarning,
  liveRefreshMs,
  liveRevision,
  liveSessionView,
  msUntilNextOpen,
  normalizeLiveMinutes,
  parseKstStamp,
} from "../paperLive";
import { latestObserved } from "../paperOverview";
import type { PaperBookSummary, PaperLiveBook, PaperLiveResponse, PaperLiveSession } from "../types";

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
  it("선택지에 없는 저장 값은 기본 30분(사용자 결정)", () => {
    expect(DEFAULT_LIVE_REFRESH_MINUTES).toBe(30);
    expect(normalizeLiveMinutes("5")).toBe(5);
    expect(normalizeLiveMinutes("0")).toBe(0);
    expect(normalizeLiveMinutes("3")).toBe(30);
    expect(normalizeLiveMinutes("45")).toBe(30);
    expect(normalizeLiveMinutes(undefined)).toBe(30);
  });

  it("1시간·3시간(사용자 결정 2026-10-31, 장중 명세 L5) — 저장된 60·180은 정규화에서 살아남고 이름은 '1시간'·'3시간'", () => {
    expect(LIVE_REFRESH_OPTIONS.map((option) => option.value)).toEqual([0, 1, 2, 5, 10, 15, 30, 60, 180]);
    expect(normalizeLiveMinutes("60")).toBe(60);
    expect(normalizeLiveMinutes("180")).toBe(180);
    expect(normalizeLiveMinutes(60)).toBe(60);
    expect(liveIntervalText(30)).toBe("30분");
    expect(liveIntervalText(60)).toBe("1시간");
    expect(liveIntervalText(180)).toBe("3시간");
    expect(liveIntervalText(45)).toBe("45분");
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
  it("고른 계좌의 종목 — 가격 기준(장중·마지막 관측)과 시각·직전 종가 대비·평균 단가 대비·비중", () => {
    const response = { available: true, books: [book(), book({ code: "rules", label: "규칙 계좌", positionCount: 0, positions: [] })] };
    const view = livePositionsFor(response, "claude");
    expect(view).toMatchObject({ code: "claude", label: "Claude 계좌" });
    expect(view?.positions[0]).toMatchObject({ ticker: "AAA", price: "420.0000", priceAt: "장중 10-30 23:58", live: true,
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
    expect(livePositionView({ ...book().positions[0], price: 71000, priceBasis: null, priceAtKst: null }, "KR"))
      .toMatchObject({ price: "71,000", priceAt: "—" });
    expect(livePositionView({ ...book().positions[0], weightPct: null, returnPct: null, dayChangePct: null }))
      .toMatchObject({ weight: "—", returnText: "—", dayText: "—" });
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
