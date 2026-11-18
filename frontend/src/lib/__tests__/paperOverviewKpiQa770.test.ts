/**
 * QA-770 — 모의매매 개요 KPI 띠(작업대 P6)에서 추정 배지가 값과 어긋나던 결함. 예전 히어로는 한 덩어리 안의 추정·이전 값 배지 하나가 순자산·수익률·변화를
 * 함께 덮었는데, 타일로 나누며 플래그를 순자산 타일에만 두었습니다 — 같은 추정에서 나온 '수익률(출발 이후)'·'오늘 변화' 타일에는 배지가 없고, 실시간
 * 순자산(표시 전용 추정)과 상관없는 서버 값인 '주식 노출' 타일에는 추정 배지가 붙었습니다(원칙: 추정치는 isEstimated와 함께). 값은 합성 값입니다.
 */
import { describe, expect, it } from "vitest";

import { overviewHeroModel, overviewKpiItems } from "../paperOverview";
import type { PaperCurrentValue, PaperOverviewBook, PaperOverviewResponse } from "../types";

function current(over: Partial<PaperCurrentValue> = {}): PaperCurrentValue {
  return {
    nav: 101234.56, returnPct: 1.23, exposurePct: 98.7, dayChangePct: 0.42, previousTradingDate: "2026-10-29", previousNavFinal: false,
    basis: "LIVE", stage: "LIVE", tradingDate: "2026-10-30", atKst: "2026-10-30 23:58 KST", isEstimated: true, livePriced: 2,
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

describe("QA-770 — KPI 타일마다 그 값의 추정 플래그", () => {
  it("서버 지금 값이 장중 추정이면 순자산·수익률·변화·노출 네 타일 모두 추정 배지", () => {
    const model = overviewHeroModel(overview([book({ current: current() })]), "rules", WINDOW);
    if (!model) throw new Error("모델 없음");
    // 노출 타일의 플래그는 그 값의 출처(서버 지금 값)에서 — 부르는 쪽이 넘깁니다(변수로 넘겨 옛 형도 받음).
    const exposure = { pct: 98.7, cashLike: "SHY", isEstimated: true };
    const [nav, ret, day, share] = overviewKpiItems(model, exposure);
    expect(day.value).toBe(0.42);
    expect([nav.isEstimated, ret.isEstimated, day.isEstimated, share.isEstimated]).toEqual([true, true, true, true]);
  });

  it("실시간 순자산(표시 전용 추정)만 추정이면 수익률은 추정 배지, 노출(장부 값)은 배지 없음", () => {
    const realtime = { code: "rules", nav: 101500, returnPct: 1.5, dayChangePct: null, at: null, priced: 2, total: 2 };
    const model = overviewHeroModel(overview([book()]), "rules", WINDOW, "US", realtime);
    if (!model) throw new Error("모델 없음");
    const exposure = { pct: 99.8, cashLike: "SHY", isEstimated: false };
    const [nav, ret, , share] = overviewKpiItems(model, exposure);
    expect(ret.value).toBe(1.5);
    expect([nav.isEstimated, ret.isEstimated, share.isEstimated]).toEqual([true, true, false]);
  });
});
