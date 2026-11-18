/**
 * QA-779 — 모의매매 개요 KPI 띠(작업대 P6)의 변화 타일 추정 배지가 값의 출처와 어긋나던 결함(QA-770 고침의 가장자리 — P6 검토 반박 검증이 코드로 찾음).
 * 실시간 순자산이 있고 그 실시간 값에 직전 종가 대비 변화(`dayChangePct`)가 없으면 변화 타일은 서버 지금 값의 변화(`view.day`)를 그대로 보입니다. 그런데
 * 배지는 히어로 모델의 추정(실시간이면 늘 참)을 따라, 확정된 서버 값에도 추정 배지가 붙었습니다(원칙: 추정치는 isEstimated와 함께 — 값의 출처대로).
 * 값은 합성 값입니다.
 */
import { describe, expect, it } from "vitest";

import { overviewHeroModel, overviewKpiItems } from "../paperOverview";
import type { PaperCurrentValue, PaperOverviewBook, PaperOverviewResponse } from "../types";

function current(over: Partial<PaperCurrentValue> = {}): PaperCurrentValue {
  return {
    nav: 101234.56, returnPct: 1.23, exposurePct: 98.7, dayChangePct: 0.42, previousTradingDate: "2026-10-29", previousNavFinal: true,
    basis: "LEDGER", stage: "FINAL", tradingDate: "2026-10-30", atKst: "2026-10-31 06:10 KST", isEstimated: false, livePriced: 0,
    positionCount: 2, pendingOrders: 0, neutral: false, note: null, ...over,
  };
}

function book(over: Partial<PaperOverviewBook> = {}): PaperOverviewBook {
  return {
    code: "rules", kind: "RULES", label: "규칙 계좌", status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000, cash: 200, nav: 101200,
    equityValue: 101000, exposurePct: 99.8, returnPct: 1.2, lastObservedAtKst: "2026-10-30 23:15 KST", positions: 2, staleCount: 0,
    stats: null, benchmark: "bench_spy", ...over,
  } as PaperOverviewBook;
}

const overview = (books: PaperOverviewBook[]) =>
  ({ books, pendingBackfill: [], quotes: null, liveSession: null, navEstimate: null }) as unknown as Pick<
    PaperOverviewResponse,
    "books" | "pendingBackfill" | "quotes" | "liveSession" | "navEstimate"
  >;
const WINDOW = { dates: ["2026-10-29", "2026-10-30"], books: { rules: [100000, 101200] } };

describe("QA-779 — 변화 타일의 추정 배지는 보이는 변화 값의 출처대로", () => {
  it("실시간 순자산에 변화가 없어 서버의 확정 변화를 보이면 변화 타일에 추정 배지가 없다(순자산·수익률은 실시간이라 추정)", () => {
    const realtime = { code: "rules", nav: 101500, returnPct: 1.5, dayChangePct: null, at: null, priced: 2, total: 2 };
    const model = overviewHeroModel(overview([book({ current: current() })]), "rules", WINDOW, "US", realtime);
    if (!model) throw new Error("모델 없음");
    const [nav, ret, day] = overviewKpiItems(model, { pct: 98.7, cashLike: "SHY", isEstimated: false });
    expect(day.value).toBe(0.42);
    expect([nav.isEstimated, ret.isEstimated, day.isEstimated]).toEqual([true, true, false]);
  });

  it("실시간 변화가 있으면 변화 타일도 추정 배지(실시간 값)", () => {
    const realtime = { code: "rules", nav: 101500, returnPct: 1.5, dayChangePct: 0.61, at: null, priced: 2, total: 2 };
    const model = overviewHeroModel(overview([book({ current: current() })]), "rules", WINDOW, "US", realtime);
    if (!model) throw new Error("모델 없음");
    const [, , day] = overviewKpiItems(model, { pct: 98.7, cashLike: "SHY", isEstimated: false });
    expect(day.value).toBe(0.61);
    expect(day.isEstimated).toBe(true);
  });
});
