/**
 * 매크로 카드의 실시간 값(lib/macroLive, ADR 0024 2단계) — 고정하는 것
 *  - 카드마다 같은 상품의 실시간 종목(지수는 지수, 선물은 같은 연결 선물), 선물 대신 지수로 보이는 카드에는 얹지 않음
 *  - 가격·전일 대비 자릿수는 카드 글을 따르고, 엔/원은 100엔당으로(1엔당 값 × 100), 지연은 출처가 밝힌 값
 *  - 거래 시각이 있으면 그 시각을 카드 시각으로(개장 배지가 읽는 형식), 없으면(TradingView) 받은 시각을 적되 카드 시각은 그대로
 *  - 값이 없으면 카드 그대로, 이어받은 예전 값 표시는 실시간 값이 오면 사라짐
 */
import { describe, expect, it } from "vitest";
import { MACRO_LIVE, macroLiveItem, macroLiveItems, withLive } from "../macroLive";
import type { LivePrice, MacroItem } from "../types";

const card = (over: Partial<MacroItem>): MacroItem => ({
  key: "dxy", name: "달러 인덱스", status: "ok", priceStr: "101.77", price: 101.77, delta: -0.19, pct: -0.19,
  deltaStr: "-0.19 (-0.19%)", prevStr: "101.96", lastTs: "2026-11-03 06:30 KST", source: "TradingView (TVC:DXY)", delayMinutes: 0,
  ...over,
});

const live = (over: Partial<LivePrice>): LivePrice => ({
  market: "TV", code: "TVC:DXY", price: 101.812, prevClose: 101.964, change: -0.152, changePct: -0.149, currency: null,
  tradedAt: null, status: "OPEN", source: "TradingView", delayMinutes: 0, overPrice: null, overChange: null, overChangePct: null,
  overTradedAt: null, overSession: null, ...over,
});

describe("카드 → 실시간 종목", () => {
  it("환율·국채·지수는 실시간 출처, 원자재·지수 선물은 같은 연결 선물", () => {
    expect(MACRO_LIVE.usdkrw).toBe("TV:FX_IDC:USDKRW");
    expect(MACRO_LIVE.us10y).toBe("TV:TVC:US10Y");
    expect(MACRO_LIVE.sp500).toBe("NI:.INX");
    expect(MACRO_LIVE.wti).toBe("TV:NYMEX:CL1!");
    expect(MACRO_LIVE.sp500_fut).toBe("TV:CME_MINI:ES1!");
  });

  it("선물 조회가 실패해 지수로 대신 보이는 카드에는 선물 값을 얹지 않는다, 모르는 카드는 없음", () => {
    expect(macroLiveItem(card({ key: "nikkei_fut_scraped", name: "닛케이225 선물" }))).toBe("TV:OSE:NK2251!");
    expect(macroLiveItem(card({ key: "nikkei_fut_scraped", name: "닛케이225 지수 (선물 대체)" }))).toBeNull();
    expect(macroLiveItem(card({ key: "vix" }))).toBeNull();
  });

  it("화면 카드들의 종목 — 순서 유지, 같은 것은 하나", () => {
    expect(macroLiveItems([
      { id: "fx", title: "환율", items: [card({}), card({ key: "usdkrw" })] },
      { id: "x", title: "x", items: [card({}), card({ key: "vix" })] },
    ])).toEqual(["TV:TVC:DXY", "TV:FX_IDC:USDKRW"]);
    expect(macroLiveItems(undefined)).toEqual([]);
  });
});

describe("카드에 얹기", () => {
  it("가격·전일 대비·전일은 카드 자릿수로, 출처·지연은 실시간 값, 거래 시각이 없으면 받은 시각(카드 시각은 그대로)", () => {
    const view = withLive(card({}), live({}), Date.parse("2026-11-02T21:40:05Z"));
    expect(view).toMatchObject({
      priceStr: "101.81", deltaStr: "-0.15 (-0.15%)", prevStr: "101.96", source: "실시간 TradingView (TVC:DXY)", delayMinutes: 0,
      isReference: true, lastTs: "2026-11-03 06:30 KST", prevSource: null,
    });
    expect(view.live).toEqual({ at: "06:40:05", received: true, session: null });
  });

  it("국채는 소수 셋째 자리, 거래 시각이 있으면 카드 시각을 그 시각(KST 초까지)으로", () => {
    const view = withLive(
      card({ key: "us02y", priceStr: "4.596" }),
      live({ code: "TVC:US02Y", price: 4.6012, prevClose: 4.594, change: 0.0072, changePct: 0.157, tradedAt: "2026-11-02T21:41:07Z" }),
      null,
    );
    expect(view).toMatchObject({ priceStr: "4.601", deltaStr: "+0.007 (+0.16%)", lastTs: "2026-11-03 06:41:07 KST" });
    expect(view.live).toEqual({ at: "06:41:07", received: false, session: null });
  });

  it("엔/원은 100엔당 — 1엔당으로 온 가격·전일·전일 대비에 100을 곱한다(% 그대로)", () => {
    const view = withLive(
      card({ key: "jpykrw", priceStr: "850.2" }),
      live({ code: "FX_IDC:JPYKRW", price: 8.5112, prevClose: 8.444, change: 0.0672, changePct: 0.796 }),
      null,
    );
    expect(view).toMatchObject({ priceStr: "851.1", deltaStr: "+6.7 (+0.80%)", prevStr: "844.4" });
  });

  it("지연 시세는 그 지연, 모르면 null — 전일 대비가 없으면 전일 종가로 계산", () => {
    const view = withLive(
      card({ key: "wti", priceStr: "95.90" }),
      live({ code: "NYMEX:CL1!", price: 96.4, prevClose: 104.12, change: null, changePct: null, delayMinutes: 10 }),
      null,
    );
    expect(view).toMatchObject({ priceStr: "96.40", deltaStr: "-7.72 (-7.41%)", delayMinutes: 10 });
    expect(withLive(card({}), live({ delayMinutes: undefined }), null).delayMinutes).toBeNull();
  });

  it("값이 없으면 카드 그대로, 이어받은 예전 값 표시는 실시간 값이 오면 사라진다", () => {
    const stale = card({ isStale: true, staleReason: "수집 실패" });
    expect(withLive(stale, undefined, null)).toBe(stale);
    expect(withLive(stale, live({}), null)).toMatchObject({ isStale: false, staleReason: null, status: "ok" });
  });
});
