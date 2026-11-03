/**
 * 화면 실시간 시세의 주기·표시 규칙(lib/livePrices, ADR 0024) — 고정하는 것
 *  - 주기 선택지는 끄기·5·10·30초·1·2·5·10·15·30분·1·3시간(서버 목록과 같음), 기본 1시간(사용자 결정 2026-11-03), 선택지 밖은 기본값
 *  - 새 키가 없으면 예전 장중 카드의 분 단위 값을 옮겨 읽음(고른 값을 잃지 않게)
 *  - 장중 저장본은 1분보다 짧게 다시 읽지 않음, 끄기는 0
 *  - 거래 시각은 KST 초까지, 장 상태·출처 설명, 평균 단가 대비 %
 *  - 시간 외(프리장·애프터장, 국내 NXT)가 열려 있으면 그 가격·전일 대비·거래 시각을 보임(사용자 요청 2026-11-03)
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIVE_SECONDS,
  LIVE_SECONDS_OPTIONS,
  liveKey,
  livePriceTitle,
  liveSecondsText,
  liveShown,
  liveStatusText,
  normalizeLiveSeconds,
  returnVsCost,
  serverRefreshMinutes,
  storedLiveSeconds,
  tradedAtText,
} from "../livePrices";
import type { LivePrice } from "../types";

function storage(values: Record<string, string>): Pick<Storage, "getItem"> {
  return { getItem: (key: string) => values[key] ?? null };
}

describe("주기", () => {
  it("선택지와 기본 1시간 — 서버의 주기 목록(LivePriceService.INTERVALS)과 같다", () => {
    expect(LIVE_SECONDS_OPTIONS.map((option) => option.value)).toEqual([0, 5, 10, 30, 60, 120, 300, 600, 900, 1800, 3600, 10800]);
    expect(LIVE_SECONDS_OPTIONS.map((option) => option.label)).toEqual(
      ["끄기", "5초", "10초", "30초", "1분", "2분", "5분", "10분", "15분", "30분", "1시간", "3시간"]);
    expect(DEFAULT_LIVE_SECONDS).toBe(3600);
    expect(normalizeLiveSeconds("5")).toBe(5);
    expect(normalizeLiveSeconds(0)).toBe(0);
    expect(normalizeLiveSeconds("7")).toBe(3600);
    expect(normalizeLiveSeconds(undefined)).toBe(3600);
    expect(normalizeLiveSeconds("")).toBe(3600);
    expect(liveSecondsText(10)).toBe("10초");
    expect(liveSecondsText(3600)).toBe("1시간");
    expect(liveSecondsText(45)).toBe("45초");
  });

  it("저장 값 — 새 키가 먼저, 없으면 예전 분 단위 값을 초로(선택지에 있을 때), 둘 다 없으면 1시간", () => {
    expect(storedLiveSeconds(storage({ "live.priceRefreshSeconds": "10" }))).toBe(10);
    expect(storedLiveSeconds(storage({ "live.priceRefreshSeconds": "10", "paper.liveRefreshMinutes": "5" }))).toBe(10);
    expect(storedLiveSeconds(storage({ "paper.liveRefreshMinutes": "5" }))).toBe(300);
    expect(storedLiveSeconds(storage({ "paper.liveRefreshMinutes": "0" }))).toBe(0);
    expect(storedLiveSeconds(storage({ "paper.liveRefreshMinutes": "180" }))).toBe(10800);
    expect(storedLiveSeconds(storage({ "paper.liveRefreshMinutes": "3" }))).toBe(3600);
    expect(storedLiveSeconds(storage({}))).toBe(3600);
    expect(storedLiveSeconds(null)).toBe(3600);
  });

  it("장중 저장본(계좌의 지금 값)은 1분보다 짧게 다시 읽지 않는다 — 끄기는 0", () => {
    expect(serverRefreshMinutes(0)).toBe(0);
    expect(serverRefreshMinutes(5)).toBe(1);
    expect(serverRefreshMinutes(30)).toBe(1);
    expect(serverRefreshMinutes(120)).toBe(2);
    expect(serverRefreshMinutes(3600)).toBe(60);
  });
});

describe("표시", () => {
  const price: LivePrice = {
    market: "KR", code: "005930", price: 230000, prevClose: 225000, change: 5000, changePct: 2.22, currency: "KRW",
    tradedAt: "2026-11-03T01:15:02Z", status: "POST", source: "네이버", overPrice: 230500, overChange: 5500, overChangePct: 2.44,
    overTradedAt: "2026-11-03T10:59:58Z", overSession: "AFTER_MARKET",
  };

  it("종목 열쇠는 서버 응답과 같은 'US:AAPL'·'KR:005930'", () => {
    expect(liveKey("US", " brk-b ")).toBe("US:BRK-B");
    expect(liveKey("KR", "005930")).toBe("KR:005930");
  });

  it("거래 시각은 KST 초까지, 모르면 —", () => {
    expect(tradedAtText("2026-11-03T01:15:02Z")).toBe("10:15:02");
    expect(tradedAtText(null)).toBe("—");
    expect(tradedAtText("not a time")).toBe("—");
  });

  it("장 상태·출처 설명 — 시간 외 가격이 있으면 덧붙임", () => {
    expect(liveStatusText("OPEN")).toBe("정규장");
    expect(liveStatusText("PRE")).toBe("시간 외(장 전)");
    expect(liveStatusText(null)).toBe("");
    expect(livePriceTitle(price, (value) => value.toLocaleString("en-US"))).toBe(
      "실시간 네이버 · 기준 19:59:58 KST · 애프터장(NXT) · 정규장 종가 230,000");
  });

  // QA-167: 네이버 국내 polling의 정규장 localTradedAt은 체결 시각이 아니라 응답 시각입니다(2026-11-03 09:08 KST — 오늘 거래량이 없는
  // 종목도 매번 지금 시각). 설명은 '거래'가 아니라 '기준' 시각이라고 적어야 합니다(미국·다음·시간 외는 마지막 거래 시각이라 '기준'도 맞음).
  it("QA-167 설명의 시각은 '기준' — 네이버 국내 정규장은 응답 시각이라 '거래'라고 적지 않는다", () => {
    const regular = { ...price, status: "OPEN" as const, tradedAt: "2026-11-03T00:08:47Z", overPrice: null, overChange: null,
      overChangePct: null, overTradedAt: null, overSession: null };
    const title = livePriceTitle(regular, (value) => value.toLocaleString("en-US"));
    expect(title).toBe("실시간 네이버 · 기준 09:08:47 KST · 정규장");
    expect(title).not.toContain("거래");
  });

  it("시간 외가 열려 있으면 그 가격·전일 대비·거래 시각과 이름(국내는 NXT), 정규장·시간 외 가격이 없으면 정규장 값", () => {
    expect(liveShown(price)).toEqual({ price: 230500, change: 5500, changePct: 2.44, tradedAt: "2026-11-03T10:59:58Z", session: "애프터장(NXT)" });
    const us = { ...price, market: "US" as const, status: "PRE" as const, overPrice: 338.01, overChange: -0.31, overChangePct: -0.09 };
    expect(liveShown(us).session).toBe("프리장");
    expect(liveShown({ ...price, status: "OPEN" })).toMatchObject({ price: 230000, change: 5000, session: null });
    expect(liveShown({ ...price, overPrice: null })).toMatchObject({ price: 230000, session: null });
  });

  it("평균 단가 대비 % — 가격·평단 중 하나라도 모르면 null", () => {
    expect(returnVsCost(110, 100)).toBeCloseTo(10);
    expect(returnVsCost(null, 100)).toBeNull();
    expect(returnVsCost(110, null)).toBeNull();
    expect(returnVsCost(110, 0)).toBeNull();
  });
});
