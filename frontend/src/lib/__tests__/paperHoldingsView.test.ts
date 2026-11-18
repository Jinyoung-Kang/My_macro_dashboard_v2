/**
 * 보유·체결 탭의 순수 규칙(lib/paperHoldingsView — 작업대 P6): 보유 검사 칸 속성과 받은 줄 거르기.
 *
 *  - positionProperties: 보유 응답 값 그대로(서식은 보유 표와 같은 함수) — 모르면 '—'(0으로 채우지 않음), 등락 칸만 글자색, 표지는 배지 글과 설명,
 *    실시간은 받았을 때만(표시 전용), 한국은 원 정수·'수량(주)'
 *  - 주문 상태·체결 방향 거르기: 칸마다 받은 줄 수, 고른 칸의 줄만(서버 차례 그대로), '전체'는 모두
 */
import { describe, expect, it } from "vitest";

import { fillSideOptions, filterFills, filterOrders, orderStatusOptions, positionProperties } from "../paperHoldingsView";
import type { PaperPosition } from "../types";

const POSITION: PaperPosition = {
  ticker: "NVDA", qty: 10, avgCost: 200, lastPrice: null, lastPriceAtKst: null, marketValue: 2000, weightPct: 2, unrealizedPct: -1.5,
  highWatermark: 205, stopPrice: null, stopDistancePct: null, openedOn: "2026-10-23", holdingTradingDays: null, priceStale: true,
  splitNote: null, cashLike: false, backfilled: false,
};

describe("positionProperties", () => {
  it("모르는 값은 '—', 평가 손익은 부호 글과 하락색, 표지는 배지 글과 설명", () => {
    const rows = positionProperties(POSITION);
    const value = (key: string) => rows.find((row) => row.key === key);
    expect(rows.map((row) => row.label)).toEqual([
      "수량", "평단", "가격(장부)", "평가액", "비중(순자산 대비)", "평가 손익(평단 대비)", "최고가", "스탑 가격 · 거리", "보유 기간", "표지",
    ]);
    expect(value("avgCost")?.value).toBe("200.0000 달러");
    expect(value("lastPrice")?.value).toBe("—");
    expect(value("lastPrice")?.note).toBeNull();
    expect(value("unrealized")).toMatchObject({ value: "-1.50%", tone: "text-down" });
    expect(value("stop")?.value).toBe("—");
    expect(value("held")?.value).toBe("2026-10-23부터 · —");
    expect(value("badges")?.value).toContain("가격 없음");
    expect(value("badges")?.note).toBeTruthy();
  });

  it("한국은 원 정수와 '수량(주)', 실시간을 받으면 한 줄 더(표시 전용)", () => {
    const rows = positionProperties({ ...POSITION, ticker: "005930", avgCost: 70000, lastPrice: 71000, marketValue: 710000 }, "KR", {
      price: 72000, tradedAt: "2026-11-03T01:00:00Z", session: null, prevClose: null,
    } as never);
    expect(rows[0].label).toBe("수량(주)");
    expect(rows.find((row) => row.key === "avgCost")?.value).toBe("70,000 원");
    const live = rows.find((row) => row.key === "live");
    expect(live?.label).toBe("실시간(표시 전용)");
    expect(live?.value).toMatch(/^72,000 원 · 평단 대비 \+2\.86%$/);
  });
});

describe("주문·체결 거르기", () => {
  const orders = [{ status: "PENDING" }, { status: "FILLED" }, { status: "REJECTED" }, { status: null }];
  it("주문 상태 칸마다 받은 줄 수, 고른 칸의 줄만", () => {
    expect(orderStatusOptions(orders).map((option) => [option.key, option.count])).toEqual([
      ["all", 4], ["pending", 1], ["filled", 1], ["other", 2],
    ]);
    expect(filterOrders(orders, "other")).toEqual([{ status: "REJECTED" }, { status: null }]);
    expect(filterOrders(orders, "all")).toHaveLength(4);
  });

  it("체결 방향 칸마다 받은 줄 수, 고른 방향만", () => {
    const fills = [{ side: "BUY" }, { side: "SELL" }, { side: "BUY" }];
    expect(fillSideOptions(fills).map((option) => [option.label, option.count])).toEqual([["전체", 3], ["매수", 2], ["매도", 1]]);
    expect(filterFills(fills, "SELL")).toEqual([{ side: "SELL" }]);
    expect(filterFills([], "BUY")).toEqual([]);
  });
});
