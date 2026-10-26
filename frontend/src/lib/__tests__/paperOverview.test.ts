/**
 * 모의매매(미국) 개요의 새 패턴 규칙(lib/paperOverview) — 계좌 행·계좌 비교 표·기간별 순자산 곡선.
 *
 *  - 계좌 행: 이름 · 종류 · 상태 · 소개, 순자산(달러), 출발 이후 수익률(모르면 null — 칩 생략), 이전 값·사후 체결 대기 배지
 *  - 비교 표: 예전 카드의 칸이 전부 항목 줄로(값은 bookCard 표시 글 그대로, 모르면 "—"), 비교 기준은 따로 한 줄
 *  - 기간: 저장된 기록보다 긴 기간 탭은 없고 "전체"는 늘 있다, 자를 때 날짜와 값 배열을 같은 자리에서 자른다,
 *    프레임 경계 세로선은 고른 기간 안의 날짜만
 */
import { describe, expect, it } from "vitest";

import {
  accountComparisonRows,
  bookAssetRow,
  markersInWindow,
  monthsBefore,
  NAV_RANGES,
  navRangeKeys,
  navSeriesWindow,
  PENDING_BACKFILL_WARNING,
  sampleNotes,
} from "../paperOverview";
import type { PaperBookSummary, PaperStats } from "../types";

const STATS: PaperStats = {
  cumReturnPct: 1.234, cagrPct: 12.5, volPct: 15.2, mddPct: -3.4, sharpe: 0.81, excessPct: -0.52, beta: 0.97, sampleDays: 42,
};

function book(code: string, over: Partial<PaperBookSummary> = {}): PaperBookSummary {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000,
    cash: 12.34, nav: 100123.45, equityValue: 100111.11, exposurePct: 99.99, returnPct: 0.12345,
    lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: STATS, benchmark: null, ...over,
  };
}

const BOOKS = [
  book("rules", { kind: "RULES", label: "규칙 계좌", benchmark: "bench_spy", returnPct: -1.5 }),
  book("claude", {
    kind: "CLAUDE", label: "Claude 계좌", status: "NOT_STARTED", startedOn: null, benchmark: "bench_spy",
    nav: null, cash: null, exposurePct: null, returnPct: null, positions: null, staleCount: null, stats: null, lastObservedAtKst: null,
  }),
  book("bench_spy", { label: "SPY 계좌", staleCount: 2 }),
  book("bench_mix", { label: "60/40 계좌", benchmark: "bench_spy" }),
];

describe("계좌 행(AssetRow 자료)", () => {
  it("값 있음 — 이름·종류·상태·소개, 순자산 숫자와 달러, 수익률은 칩 자료로(서버 값 그대로)", () => {
    const row = bookAssetRow(BOOKS[0]);
    expect(row).toEqual({
      id: "rules", name: "규칙 계좌", sub: "규칙 · 운용 중 · 13F 신호만 규칙대로 따르는 대조군 — 매크로 판단·재량 없음",
      value: 100123.45, unit: "달러", changePct: -1.5, isStale: false, staleReason: null, warning: null,
    });
  });

  it("값 없음 — 순자산·수익률은 null(화면은 '—'와 칩 생략, 0으로 채우지 않음), 시작 전 상태는 글로", () => {
    const row = bookAssetRow(BOOKS[1]);
    expect(row.value).toBeNull();
    expect(row.changePct).toBeNull();
    expect(row.sub.startsWith("Claude · 시작 전 · 현금만")).toBe(true);
    expect(row.isStale).toBe(false);
  });

  it("오래됨 — 가격 없는 보유가 있으면 이전 값 배지와 사유, 관측치 저장본이 늦었으면(서버 판정) 마지막 관측 시각을 사유에", () => {
    const stale = bookAssetRow(BOOKS[2]);
    expect(stale.isStale).toBe(true);
    expect(stale.staleReason).toBe("가격 없음 2종목 — 지난 값으로 평가");

    const late = bookAssetRow(BOOKS[0], { quotes: { stale: true } });
    expect(late.isStale).toBe(true);
    expect(late.staleReason).toBe("관측치 저장본이 늦음 · 마지막 관측 2026-10-24 05:15");
    // 둘 다면 사유를 이어 적고, 관측이 없는(시작 전) 계좌는 늦은 저장본과 상관없음
    expect(bookAssetRow(BOOKS[2], { quotes: { stale: true } }).staleReason).toBe(
      "가격 없음 2종목 — 지난 값으로 평가 · 관측치 저장본이 늦음 · 마지막 관측 2026-10-24 05:15",
    );
    expect(bookAssetRow(BOOKS[1], { quotes: { stale: true } }).isStale).toBe(false);
    expect(bookAssetRow(BOOKS[0], { quotes: { stale: false } }).isStale).toBe(false);
  });

  it("사후 체결 대기(추정에 가까운 상태) — 그 계좌 행에 경고, 다른 계좌는 없음", () => {
    expect(bookAssetRow(BOOKS[2], { pendingBackfill: ["bench_spy", "bench_mix"] }).warning).toBe(PENDING_BACKFILL_WARNING);
    expect(bookAssetRow(BOOKS[0], { pendingBackfill: ["bench_spy"] }).warning).toBeNull();
    expect(bookAssetRow(BOOKS[0], { pendingBackfill: null }).warning).toBeNull();
  });

  it("소개가 없는 계좌(모르는 코드)는 종류·상태만", () => {
    expect(bookAssetRow(book("x", { label: "새 계좌" })).sub).toBe("벤치마크 · 운용 중");
  });
});

describe("계좌 비교 표", () => {
  const rows = accountComparisonRows(BOOKS);
  const line = (key: string) => {
    const found = rows.find((row) => row.key === key);
    if (!found) throw new Error(`줄 없음: ${key}`);
    return found;
  };
  const texts = (key: string) => BOOKS.map((entry) => line(key).cells[entry.code].text);

  it("예전 카드의 칸이 전부 항목 줄로 — 순서대로", () => {
    expect(rows.map((row) => row.label)).toEqual([
      "상태", "종류", "출발", "처음 현금", "순자산", "수익률(출발 이후)", "주식 노출", "현금", "보유", "마지막 관측", "가격 없음",
      "누적 수익률", "연율 수익률", "변동성(연율)", "최대 낙폭", "샤프", "초과 수익률", "베타", "비교 기준",
    ]);
    expect(line("status").badge).toBe(true);
    expect(rows.filter((row) => row.badge).map((row) => row.key)).toEqual(["status"]);
  });

  it("값 있음 — bookCard 표시 글 그대로, 수익률은 부호 색", () => {
    expect(texts("nav")).toEqual(["100,123.45 달러", "—", "100,123.45 달러", "100,123.45 달러"]);
    expect(texts("returnPct")).toEqual(["-1.50%", "—", "+0.12%", "+0.12%"]);
    expect(line("returnPct").cells.rules.className).toBe("text-down");
    expect(line("returnPct").cells.bench_spy.className).toBe("text-up");
    expect(texts("stat-excessPct")).toEqual(["-0.52%p", "—", "-0.52%p", "-0.52%p"]);
    expect(texts("benchmark")).toEqual(["SPY 계좌", "SPY 계좌", "—", "SPY 계좌"]);
    expect(texts("initialCash")[0]).toBe("100,000 달러");
  });

  it("값 없음 — '—'이고 색이 없다(0.00으로 채우지 않음), 시작 전은 '시작 전'", () => {
    for (const key of ["nav", "returnPct", "exposure", "cash", "positions", "lastObserved", "stale", "stat-cumReturnPct", "stat-beta"]) {
      expect(line(key).cells.claude, key).toEqual({ text: "—", className: null });
    }
    expect(line("startedOn").cells.claude.text).toBe("시작 전");
    expect(line("status").cells.claude.text).toBe("시작 전 · 현금만");
  });

  it("가격 없음 — 0이면 '없음', 있으면 경고색 'N종목 — 지난 값으로 평가'", () => {
    expect(line("stale").cells.rules).toEqual({ text: "없음", className: null });
    expect(line("stale").cells.bench_spy).toEqual({ text: "2종목 — 지난 값으로 평가", className: "text-warn" });
  });

  it("표본 설명은 계좌마다 한 줄(표 밖 목록)", () => {
    expect(sampleNotes(BOOKS)).toEqual([
      { code: "rules", label: "규칙 계좌", text: "표본 42거래일" },
      { code: "claude", label: "Claude 계좌", text: "통계 없음 — 순자산 기록이 아직 없습니다." },
      { code: "bench_spy", label: "SPY 계좌", text: "표본 42거래일" },
      { code: "bench_mix", label: "60/40 계좌", text: "표본 42거래일" },
    ]);
  });

  it("계좌가 없으면 칸 없는 줄들", () => {
    expect(accountComparisonRows([]).every((row) => Object.keys(row.cells).length === 0)).toBe(true);
  });
});

describe("기간별 순자산 곡선", () => {
  const dates = ["2025-09-30", "2026-01-15", "2026-06-01", "2026-09-26", "2026-10-01", "2026-10-26"];
  const series = { dates, books: { rules: [1, 2, null, 4, 5, 6], bench_spy: [10, 20, 30, 40, 50, 60] } };

  it("n개월 전 — 같은 날, 그 달에 없으면 마지막 날, 해를 넘김", () => {
    expect(monthsBefore("2026-10-26", 1)).toBe("2026-09-26");
    expect(monthsBefore("2026-03-31", 1)).toBe("2026-02-28");
    expect(monthsBefore("2026-01-15", 3)).toBe("2025-10-15");
    expect(monthsBefore("2026-10-26", 12)).toBe("2025-10-26");
    expect(monthsBefore("2026/10/26", 1)).toBeNull();
  });

  it("고를 수 있는 기간 — 저장된 기록보다 긴 기간은 없고 '전체'는 늘 있다", () => {
    expect(NAV_RANGES.map((range) => range.label)).toEqual(["1개월", "3개월", "6개월", "1년", "전체"]);
    expect(navRangeKeys(series)).toEqual(["1m", "3m", "6m", "1y", "all"]);
    // 출발 직후(며칠치)는 전체 하나
    expect(navRangeKeys({ dates: ["2026-10-23", "2026-10-26"], books: {} })).toEqual(["all"]);
    // 딱 한 달치면 1개월은 전체와 같아 그리지 않음
    expect(navRangeKeys({ dates: ["2026-09-26", "2026-10-26"], books: {} })).toEqual(["all"]);
    expect(navRangeKeys({ dates: ["2026-09-25", "2026-10-26"], books: {} })).toEqual(["1m", "all"]);
    expect(navRangeKeys(null)).toEqual(["all"]);
    expect(navRangeKeys({ dates: [], books: {} })).toEqual(["all"]);
  });

  it("자르기 — 기간 첫날부터, 날짜와 계좌별 값을 같은 자리에서(null 그대로)", () => {
    expect(navSeriesWindow(series, "1m")).toEqual({
      dates: ["2026-09-26", "2026-10-01", "2026-10-26"],
      books: { rules: [4, 5, 6], bench_spy: [40, 50, 60] },
    });
    expect(navSeriesWindow(series, "6m")).toEqual({
      dates: ["2026-06-01", "2026-09-26", "2026-10-01", "2026-10-26"],
      books: { rules: [null, 4, 5, 6], bench_spy: [30, 40, 50, 60] },
    });
    expect(navSeriesWindow(series, "all")).toBe(series);
    // 기록이 기간보다 짧으면 그대로
    const short = { dates: ["2026-10-23", "2026-10-26"], books: { rules: [1, 2] } };
    expect(navSeriesWindow(short, "1y")).toBe(short);
    expect(navSeriesWindow(null, "1m")).toBeNull();
  });

  it("프레임 경계 세로선 — 고른 기간 안의 날짜만 남기고(순서 그대로), 기간 기록이 없으면 없다", () => {
    const markers = [
      { x: "2026-01-15", label: "프레임 v1" },
      { x: "2026-10-01", label: "프레임 v2" },
      { x: "2026-10-26", label: "프레임 v3" },
    ];
    expect(markersInWindow(markers, navSeriesWindow(series, "1m"))).toEqual([markers[1], markers[2]]);
    expect(markersInWindow(markers, navSeriesWindow(series, "all"))).toEqual(markers);
    expect(markersInWindow(markers, null)).toEqual([]);
    expect(markersInWindow([], series)).toEqual([]);
  });
});
