/**
 * 모의매매 개요 재배치(작업대 P6)의 순수 규칙 — lib/paperOverview에 더한 셋.
 *
 *  - overviewKpiItems: 히어로 모델 값 그대로 네 타일(순자산·수익률·변화·노출) — 모르면 null('—', 0을 짓지 않음), 부호 글은 '+'·'−'(U+2212),
 *    이전 값 사유·출처·경고는 순자산 타일(추정·이전 값 배지는 수익률·변화도 — QA-770), 노출 보조 글은 현금성 종목
 *  - accountTableRows: 계좌 행(bookAssetRow)과 같은 지금 값·기준 한 줄·배지·경고 + 종류 글·상태 배지·주식 노출 글
 *  - accountSummaryProperties: KPI 띠와 겹치지 않는 장부 속성(한 줄 소개·종류·처음 현금·현금·보유·출발일·마지막 관측·비교 기준) — 모르면 '—'
 */
import { describe, expect, it } from "vitest";

import { accountSummaryProperties, accountTableRows, overviewHeroModel, overviewKpiItems } from "../paperOverview";
import type { PaperOverviewBook, PaperOverviewResponse } from "../types";

function book(code: string, over: Partial<PaperOverviewBook> = {}): PaperOverviewBook {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000, cash: 200, nav: 100500,
    equityValue: 100300, exposurePct: 99.8, returnPct: 0.5, lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0,
    stats: null, benchmark: "bench_spy", ...over,
  } as PaperOverviewBook;
}

const BOOKS = [
  book("rules", { kind: "RULES", label: "규칙 계좌", returnPct: -1.234, nav: 98766, positions: 7 }),
  book("claude", { kind: "CLAUDE", label: "Claude 계좌", status: "NOT_STARTED", startedOn: null, nav: null, returnPct: null, exposurePct: null, positions: 0 }),
  book("bench_spy", { label: "SPY 계좌", benchmark: null }),
];

const OVERVIEW = {
  books: BOOKS, pendingBackfill: ["bench_spy"], quotes: null, liveSession: null, navEstimate: null,
} as unknown as Pick<PaperOverviewResponse, "books" | "pendingBackfill" | "quotes" | "liveSession" | "navEstimate">;
const WINDOW = { dates: ["2026-10-23", "2026-10-24"], books: { rules: [100000, 98766] } };

describe("overviewKpiItems", () => {
  it("네 타일 — 순자산(값 글·단위·단계 표기·출처), 수익률은 '−' 부호 글, 변화를 모르면 null, 노출 보조 글은 현금성 종목", () => {
    const model = overviewHeroModel(OVERVIEW, "rules", WINDOW);
    if (!model) throw new Error("모델 없음");
    const items = overviewKpiItems(model, { pct: 99.51, cashLike: "SHY" });
    expect(items.map((item) => item.key)).toEqual(["nav", "return", "day", "exposure"]);
    const [nav, ret, day, exposure] = items;
    expect(nav).toMatchObject({ label: "순자산", value: "98,766.00", unit: "달러", note: "마지막 관측 2026-10-24 05:15", isEstimated: false });
    expect(nav.source).toBeTruthy();
    expect(nav.status).toBeUndefined();
    expect(ret.label).toBe("수익률(출발 이후)");
    expect(ret.format?.(ret.value as number)).toBe("−1.23%");
    expect(ret.format?.(0.004)).toBe("0.00%");
    expect(ret.format?.(2)).toBe("+2.00%");
    expect(day).toMatchObject({ label: "변화", value: null, note: null });
    expect(exposure).toMatchObject({ label: "주식 노출", value: 99.51, unit: "%", note: "현금성(SHY) 포함", isEstimated: false });
    expect(exposure.format?.(99.51)).toBe("99.5");
  });

  it("사후 체결 대기 계좌면 순자산 타일에 주의 상태 글, 노출을 모르면 null(추정 배지도 없음)", () => {
    const model = overviewHeroModel(OVERVIEW, "bench_spy", WINDOW);
    if (!model) throw new Error("모델 없음");
    const [nav, , , exposure] = overviewKpiItems(model, { pct: null, cashLike: "SHY" });
    expect(nav.status).toEqual({ tone: "warn", text: "출발일 종가 대기 — 사후 체결 전(현금만)" });
    expect(exposure.value).toBeNull();
    expect(exposure.isEstimated).toBe(false);
  });
});

describe("accountTableRows", () => {
  it("줄마다 종류·상태 배지·순자산 글(모르면 '—')·수익률·노출 글·경고 — 출발 전 계좌는 수익률 null", () => {
    const rows = accountTableRows(BOOKS, { pendingBackfill: ["bench_spy"] });
    expect(rows.map((row) => [row.code, row.kind, row.status.label, row.navText, row.returnPct, row.exposureText, row.warning])).toEqual([
      ["rules", "규칙", "운용 중", "98,766.00", -1.234, "99.8%", null],
      ["claude", "Claude", "시작 전 · 현금만", "—", null, "—", null],
      ["bench_spy", "벤치마크", "운용 중", "100,500.00", 0.5, "99.8%", "출발일 종가 대기 — 사후 체결 전(현금만)"],
    ]);
    expect(rows[0].unit).toBe("달러");
    expect(rows[0].caption).toBeNull();
    expect(rows.every((row) => row.isEstimated === false)).toBe(true);
  });

  it("한국은 원 정수·사후 체결 대기 경고 없음", () => {
    const rows = accountTableRows([book("kr_rules", { kind: "RULES", label: "한국 규칙 계좌", nav: 100312450 })], { market: "KR", pendingBackfill: ["kr_rules"] });
    expect(rows[0].navText).toBe("100,312,450");
    expect(rows[0].unit).toBe("원");
    expect(rows[0].warning).toBeNull();
  });
});

describe("accountSummaryProperties", () => {
  it("한 줄 소개(긴 글)·종류·처음 현금·현금·보유·출발일·마지막 관측·비교 기준 — 모르면 '—', 출발 전은 '시작 전'", () => {
    const rules = accountSummaryProperties(BOOKS[0], BOOKS);
    expect(rules.map((entry) => entry.label)).toEqual(["한 줄 소개", "종류", "처음 현금", "현금(장부)", "보유", "출발일", "장부 마지막 관측", "비교 기준"]);
    expect(rules[0].block).toBe(true);
    expect(rules.slice(1).map((entry) => entry.value)).toEqual(["규칙", "100,000 달러", "200.00 달러", "7종목", "2026-10-23", "2026-10-24 05:15", "SPY 계좌"]);
    const spy = accountSummaryProperties(BOOKS[2], BOOKS);
    expect(spy.find((entry) => entry.key === "benchmark")?.value).toBe("—");
    const claude = accountSummaryProperties({ ...BOOKS[1], lastObservedAtKst: null }, BOOKS);
    expect(claude.find((entry) => entry.key === "startedOn")?.value).toBe("시작 전");
    expect(claude.find((entry) => entry.key === "lastObserved")?.value).toBe("—");
  });
});
