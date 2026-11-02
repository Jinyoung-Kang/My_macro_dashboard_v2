/**
 * 모의매매(미국) 개요의 새 패턴 규칙(lib/paperOverview) — 계좌 행·계좌 비교 표·기간별 순자산 곡선.
 *
 *  - 계좌 행: 이름 · 종류 · 상태 · 소개, 순자산(달러), 출발 이후 수익률(모르면 null — 칩 생략), 이전 값·사후 체결 대기 배지,
 *    지금 값(current)이 있으면 그 값과 값의 기준 한 줄(단계 표기·덧붙임·변화 한 줄)·추정 배지 — 옛 응답은 예전 모양 그대로
 *  - 비교 표: 예전 카드의 칸이 전부 항목 줄로(값은 bookCard 표시 글 그대로, 모르면 "—"), 비교 기준은 따로 한 줄. 지금 값이 있으면
 *    한 표 한 기준 — 맨 위 기준 줄·'오늘 변화'(장부 칸이고 지금 세션이 아니면 '최근 변화')·통계 기준 줄, 칸 값은 지금 값 또는 장부(섞지 않음)
 *  - 기간: 저장된 기록보다 긴 기간 탭은 없고 "전체"는 늘 있다, 자를 때 날짜와 값 배열을 같은 자리에서 자른다,
 *    프레임 경계 세로선은 고른 기간 안의 날짜만
 *  - S = 100 같은 구간(계좌2): 계좌2 출발일 S부터 계좌1·계좌2·SPY 계좌를 각자 S 순자산으로 나눠 100에 — S 전 구간·출발 전은 그리지 않고,
 *    S에 기록이 없는 계좌는 선 전체 null(100으로 채우지 않음), 그날 기록이 없으면 그날만 null
 *  - 오늘 추정 꼬리(장중 명세 §4): navEstimate의 계좌 값만(짓지 않음), 기간 창 뒤 한 행, 마지막 행 → 추정 점, 이름 '{계좌} · 추정 HH:MM'(현금뿐
 *    '· 장부'), 참고선·출발 전·그날 줄이 이미 있는 날·빈 창에는 없음, 히어로 곡선도 같은 규칙과 문지르기용 꼬리 정보
 */
import { describe, expect, it } from "vitest";

import {
  accountComparisonRows,
  bookAssetRow,
  bookMonogram,
  bookStale,
  heroNavChart,
  markersInWindow,
  monthsBefore,
  NAV_RANGES,
  navEstimatePoint,
  navRangeKeys,
  navSeriesWindow,
  navTailNote,
  overviewHeroModel,
  PENDING_BACKFILL_WARNING,
  sameWindowIndex,
  sampleNotes,
  withNavEstimateTail,
} from "../paperOverview";
import type { PaperBookSummary, PaperCurrentValue, PaperNavEstimate, PaperOverviewBook, PaperStats } from "../types";

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
      id: "rules", name: "규칙 계좌", avatarText: "R", sub: "규칙 · 운용 중 · 13F 신호만 규칙대로 따르는 대조군 — 매크로 판단·재량 없음",
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

  it("소개가 없는 계좌(모르는 코드)는 종류·상태만 — 아바타 약칭도 짓지 않음(null)", () => {
    expect(bookAssetRow(book("x", { label: "새 계좌" })).sub).toBe("벤치마크 · 운용 중");
    expect(bookAssetRow(book("x", { label: "새 계좌" })).avatarText).toBeNull();
    expect(BOOKS.map((entry) => bookAssetRow(entry).avatarText)).toEqual(["R", "C1", "SPY", "60"]);
  });
});

describe("계좌 행 — 지금 값(current, 장중 명세 §4-1)", () => {
  const REGULAR = { phase: "REGULAR" as const, sessionDate: "2026-10-30" };
  const live = (over: Partial<PaperCurrentValue> = {}): PaperCurrentValue => ({
    nav: 101234.56, returnPct: 1.23, exposurePct: 98.7, dayChangePct: 0.42, previousTradingDate: "2026-10-29", previousNavFinal: false,
    basis: "LIVE", stage: "LIVE", tradingDate: "2026-10-30", atKst: "2026-10-30 23:58 KST", isEstimated: true, livePriced: 1,
    positionCount: 2, pendingOrders: 1, neutral: false, note: "장중가 1/2종목 — 나머지는 장부 관측가 · 체결 대기 1건 반영 전 — 다음 장부 관측치에서 체결", ...over,
  });

  it("값은 지금 값, 값의 기준 한 줄은 단계 표기 · 덧붙임 · 변화 한 줄, 장중 추정이면 추정 배지", () => {
    const row = bookAssetRow({ ...BOOKS[0], current: live() } as PaperOverviewBook, { session: REGULAR });
    expect(row).toMatchObject({
      value: 101234.56, changePct: 1.23, isEstimated: true,
      caption: "장중 추정 23:58 · 장중가 1/2종목 · 체결 대기 1건 반영 전 · 오늘 +0.42% · 10-29 잠정 대비",
    });
  });

  it("장부 단계·현금뿐(기준 중립)은 추정 배지 없이 단계 표기, 장 밖이면 'MM-DD 변화'", () => {
    const ledger = live({ stage: "LEDGER", basis: "LEDGER", isEstimated: false, livePriced: 0, pendingOrders: 0, atKst: "2026-10-30 23:15 KST", note: null });
    expect(bookAssetRow({ ...BOOKS[0], current: ledger } as PaperOverviewBook, { session: REGULAR }))
      .toMatchObject({ isEstimated: false, caption: "장부 23:15 · 오늘 +0.42% · 10-29 잠정 대비" });
    const sunday = { phase: "CLOSED" as const, sessionDate: "2026-10-30" };
    const final = live({ stage: "FINAL", basis: "LEDGER", isEstimated: false, livePriced: 0, pendingOrders: 0, previousNavFinal: true, note: null });
    expect(bookAssetRow({ ...BOOKS[0], current: final } as PaperOverviewBook, { session: sunday }).caption)
      .toBe("10-30 확정 · 10-30 변화 +0.42% · 10-29 확정 대비");
  });

  it("이전 값 배지는 보이는 값이 장부 관측에서 나왔을 때만 — 장부 단계는 그대로(시각은 단계 표기에), 확정 줄·마감 뒤 관측의 잠정 줄·모두 장중가인 추정은 없음", () => {
    const late = { quotes: { stale: true }, session: REGULAR };
    const stale = BOOKS[2] as PaperOverviewBook; // 가격 없음 2종목(장부 staleCount)
    // 장부 단계 — 값이 그 장부 상태라 사유 그대로, 같은 관측 시각은 값의 기준 한 줄('장부 23:15')에 있어 사유에서 뺌
    const ledger = live({ stage: "LEDGER", basis: "LEDGER", isEstimated: false, livePriced: 0, pendingOrders: 0, atKst: "2026-10-30 23:15 KST", note: null });
    expect(bookAssetRow({ ...stale, current: ledger }, late))
      .toMatchObject({ isStale: true, staleReason: "가격 없음 2종목 — 지난 값으로 평가 · 관측치 저장본이 늦음" });
    // 확정 줄 — 그 거래일 마감 값이라 장부 관측과 무관: 배지 없음
    const final = live({ stage: "FINAL", basis: "LEDGER", isEstimated: false, livePriced: 0, pendingOrders: 0, note: null });
    expect(bookAssetRow({ ...stale, current: final }, late)).toMatchObject({ isStale: false, staleReason: null });
    // 마감 뒤 관측으로 쓴 잠정 줄(가격도 다 받음) — 관측치 저장본 늦음(수집 3시간 뒤부터)은 그 값과 무관: 배지 없음(옮긴 줄은 아래 QA-158)
    const closed = live({ stage: "PROVISIONAL", basis: "LEDGER", isEstimated: false, livePriced: 0, pendingOrders: 0, tradingDate: "2026-10-30",
      atKst: "2026-10-31 05:00 KST", note: null });
    const afterClose = { ...BOOKS[0], lastObservedAtKst: "2026-10-31 05:15 KST", current: closed } as PaperOverviewBook;
    expect(bookAssetRow(afterClose, late)).toMatchObject({ isStale: false, staleReason: null });
    expect(bookStale(afterClose, late, "hero").isStale).toBe(false);
    // 장중 추정 — 모든 보유를 장중가로 평가했으면 배지 없음, 장중가 없는 종목이 섞이면 그 종목 수를 앞에(관측 시각은 그대로 — 단계 표기는 장중 시각)
    expect(bookAssetRow({ ...stale, current: live({ livePriced: 2 }) }, late)).toMatchObject({ isStale: false, staleReason: null });
    expect(bookAssetRow({ ...stale, current: live({ livePriced: 1 }) }, late)).toMatchObject({
      isStale: true,
      staleReason: "장중가 없는 1종목은 장부 관측가 · 가격 없음 2종목 — 지난 값으로 평가 · 관측치 저장본이 늦음 · 마지막 관측 2026-10-24 05:15",
    });
    // 장중가 없는 종목이 있어도 장부 사유가 없으면(관측이 늦지 않고 가격도 받음) 배지 없음 — 섞임은 값의 기준 한 줄('장중가 1/2종목')이 말함
    expect(bookAssetRow({ ...BOOKS[0], current: live({ livePriced: 1 }) } as PaperOverviewBook, { session: REGULAR }).isStale).toBe(false);
  });

  it("히어로 자리의 이전 값 — 같은 규칙이고, 단계 표기가 관측 시각을 적는 자리(옛 응답 '마지막 관측 …'·장부 단계)면 사유에서 그 시각을 뺌", () => {
    const late = { quotes: { stale: true } };
    // 옛 응답: 행은 시각을 사유에(값의 기준 한 줄 없음), 히어로는 '마지막 관측 …' 단계 표기가 있어 뺌
    expect(bookStale(BOOKS[0] as PaperOverviewBook, late, "row").reason).toBe("관측치 저장본이 늦음 · 마지막 관측 2026-10-24 05:15");
    expect(bookStale(BOOKS[0] as PaperOverviewBook, late, "hero")).toEqual({ isStale: true, reason: "관측치 저장본이 늦음" });
    // 장중 추정(섞임) — 단계 표기는 장중 시각이라 관측 시각을 남김
    expect(bookStale({ ...BOOKS[0], current: live({ livePriced: 1 }) } as PaperOverviewBook, late, "hero").reason)
      .toBe("장중가 없는 1종목은 장부 관측가 · 관측치 저장본이 늦음 · 마지막 관측 2026-10-24 05:15");
    // 관측이 없는 시작 전 계좌는 이전 값이 아님
    expect(bookStale(BOOKS[1] as PaperOverviewBook, late, "hero").isStale).toBe(false);
  });

  // QA-158: 서버의 잠정 줄은 마감 값이 아닐 때가 있습니다 — 마감 뒤 관측이 오지 않으면 결정 작업이 마지막 관측 상태를 그날 잠정 줄로 옮기고
  // (PaperLedgerService.settleNav), 지난 값으로 평가한 보유가 있으면 그날 줄이 잠정이 됩니다. 수정 전에는 잠정 단계면 배지를 늘 빼서, 장중 02:08 관측을
  // 옮긴 '10-30 잠정'이 이전 값 표시 없이 보였습니다(재현 커밋에서는 it.fails).
  it("QA-158 잠정 줄이 마감 전 관측을 옮긴 것이거나 지난 값으로 평가한 보유가 있으면 이전 값 배지 — 관측 시각도 남김(잠정 표기에는 시각이 없음)", () => {
    const closed = { phase: "CLOSED" as const, sessionDate: "2026-10-30" };
    const provisional = live({ stage: "PROVISIONAL", basis: "LEDGER", isEstimated: false, livePriced: 0, pendingOrders: 0, tradingDate: "2026-10-30",
      atKst: "2026-10-31 05:00 KST", note: null });
    // 마감(10-31 05:00 KST) 전 장중 관측(02:08)을 옮긴 잠정 줄 — 관측치 저장본도 늦음
    const copied = { ...BOOKS[0], lastObservedAtKst: "2026-10-31 02:08 KST", current: provisional } as PaperOverviewBook;
    const late = { quotes: { stale: true }, session: closed };
    expect(bookAssetRow(copied, late)).toMatchObject({ isStale: true, staleReason: "관측치 저장본이 늦음 · 마지막 관측 2026-10-31 02:08" });
    expect(bookStale(copied, late, "hero")).toEqual({ isStale: true, reason: "관측치 저장본이 늦음 · 마지막 관측 2026-10-31 02:08" });
    // 마감 뒤 관측이지만 지난 값으로 평가한 보유가 든 잠정 줄(가격 없음 2종목)
    const priced = { ...BOOKS[2], lastObservedAtKst: "2026-10-31 05:15 KST", current: provisional } as PaperOverviewBook;
    expect(bookAssetRow(priced, { session: closed })).toMatchObject({ isStale: true, staleReason: "가격 없음 2종목 — 지난 값으로 평가" });
  });

  // QA-160: 관측치가 그날 줄을 쓰려면 마감 + 15분 뒤에 수집해야 합니다(서버 closeAvailable — PaperMarketData.FINAL_DELAY). 마감과 마감 + 15분 사이의
  // 관측도 줄을 쓰지 못해 결정 작업이 그 상태를 잠정 줄로 옮기는데, QA-158 수정은 마감과만 견줘 이 줄을 마감 뒤 관측의 줄로 보고 배지를 뺐습니다
  // (재현 커밋에서는 it.fails).
  it("QA-160 마감 뒤 15분 안의 관측을 옮긴 잠정 줄도 이전 값 배지 — 마감 + 15분부터의 관측으로 쓴 줄만 배지 없음", () => {
    const late = { quotes: { stale: true }, session: { phase: "CLOSED" as const, sessionDate: "2026-10-30" } };
    const provisional = live({ stage: "PROVISIONAL", basis: "LEDGER", isEstimated: false, livePriced: 0, pendingOrders: 0, tradingDate: "2026-10-30",
      atKst: "2026-10-31 05:00 KST", note: null });
    const at = (observed: string) => ({ ...BOOKS[0], lastObservedAtKst: observed, current: provisional }) as PaperOverviewBook;
    expect(bookAssetRow(at("2026-10-31 05:05 KST"), late)).toMatchObject({ isStale: true, staleReason: "관측치 저장본이 늦음 · 마지막 관측 2026-10-31 05:05" });
    expect(bookStale(at("2026-10-31 05:14 KST"), late, "hero").isStale).toBe(true);
    expect(bookStale(at("2026-10-31 05:15 KST"), late, "hero").isStale).toBe(false);
  });

  // QA-161: 한국 관측치 늦음은 달력 기준(다음 수집 예정 + 2시간 5분 — KrPaperMarket.quotesLateAt)이라 서면 실제로 수집을 놓친 것입니다. 다음 세션
  // 수집을 놓치면 지금 값이 앞 세션의 잠정·확정 줄에 머무는데, b92bf695가 순자산 줄 단계의 사유를 모두 비워 행·히어로가 늦음 표시 없이 보였습니다
  // (미국 늦음은 수집 + 3시간이라 주말·아침에 늘 서므로 미국만 빼야 함 — 재현 커밋에서는 it.fails).
  it("QA-161 한국은 잠정·확정 줄 단계에서도 관측치 늦음을 이전 값으로(관측 시각 포함) — 미국 확정 줄은 그대로 배지 없음", () => {
    const kr = { market: "KR" as const, quotes: { stale: true }, session: { phase: "CLOSED" as const, sessionDate: "2026-10-30" } };
    for (const stage of ["PROVISIONAL", "FINAL"] as const) {
      const line = live({ stage, basis: "LEDGER", isEstimated: false, livePriced: 0, pendingOrders: 0, tradingDate: "2026-10-29",
        atKst: "2026-10-29 15:30 KST", previousNavFinal: true, note: null });
      const book = { ...BOOKS[0], code: "kr_claude", lastObservedAtKst: "2026-10-29 22:31 KST", current: line } as PaperOverviewBook;
      expect(bookAssetRow(book, kr)).toMatchObject({ isStale: true, staleReason: "관측치 저장본이 늦음 · 마지막 관측 2026-10-29 22:31" });
      expect(bookStale(book, kr, "hero")).toEqual({ isStale: true, reason: "관측치 저장본이 늦음 · 마지막 관측 2026-10-29 22:31" });
      // 늦지 않았으면 배지 없음(마감 뒤 밤 관측으로 쓴 줄)
      expect(bookStale(book, { ...kr, quotes: { stale: false } }, "row").isStale).toBe(false);
    }
  });

  it("출발 전 계좌는 기준 한 줄 없음(보조 글이 '시작 전'), 한국은 원 정수와 '시가 체결 대기'", () => {
    const waiting = live({ nav: 100000, returnPct: null, stage: "LEDGER", basis: "LEDGER", isEstimated: false, neutral: true, note: "출발 전" });
    expect(bookAssetRow({ ...BOOKS[1], current: waiting } as PaperOverviewBook)).toMatchObject({ value: 100000, changePct: null, caption: null, isEstimated: false });
    const kr = bookAssetRow(
      { ...BOOKS[0], code: "kr_claude", current: live({ nav: 100_400_000.4, livePriced: 2, pendingOrders: 2 }) } as PaperOverviewBook,
      { market: "KR", session: REGULAR },
    );
    expect(kr).toMatchObject({ value: 100_400_000.4, valueText: "100,400,000", unit: "원" });
    expect(kr.caption).toBe("장중 추정 23:58 · 시가 체결 대기 2건 반영 전 · 오늘 +0.42% · 10-29 잠정 대비");
  });

  it("옛 응답(current 없음)은 예전 모양 그대로 — 추정·기준 한 줄 칸이 없다", () => {
    const row = bookAssetRow(BOOKS[0], { session: REGULAR });
    expect("caption" in row).toBe(false);
    expect("isEstimated" in row).toBe(false);
    expect(row.value).toBe(100123.45);
  });
});

describe("계좌 비교 표 — 지금 값(한 표 한 기준, 장중 명세 §4)", () => {
  const REGULAR = { phase: "REGULAR" as const, sessionDate: "2026-10-30" };
  const SUNDAY = { phase: "CLOSED" as const, sessionDate: "2026-10-30" };
  const cur = (over: Partial<PaperCurrentValue> = {}): PaperCurrentValue => ({
    nav: 101234.56, returnPct: 1.23, exposurePct: 98.7, dayChangePct: 0.42, previousTradingDate: "2026-10-29", previousNavFinal: false,
    basis: "LIVE", stage: "LIVE", tradingDate: "2026-10-30", atKst: "2026-10-30 23:58 KST", isEstimated: true, livePriced: 2,
    positionCount: 2, pendingOrders: 0, neutral: false, note: null, ...over,
  });
  const ledgerDay = { tradingDate: "2026-10-30", dayChangePct: 0.3, previousTradingDate: "2026-10-29", previousNavFinal: true };
  const withCurrent = (mixStage: PaperCurrentValue["stage"]): PaperOverviewBook[] => [
    { ...BOOKS[0], current: cur(), ledgerDay, lastNavTradingDate: "2026-10-29", lastNavFinal: true },
    { ...BOOKS[1], current: cur({ nav: 100000, returnPct: null, stage: "LEDGER", basis: "LEDGER", isEstimated: false, neutral: true, livePriced: 0 }),
      ledgerDay: null, lastNavTradingDate: null, lastNavFinal: null },
    { ...BOOKS[2], current: cur({ nav: 100600, dayChangePct: -0.1, stage: "LIVE_LAST" }), ledgerDay, lastNavTradingDate: "2026-10-29", lastNavFinal: false },
    { ...BOOKS[3], current: cur({ stage: mixStage, basis: mixStage === "LIVE" ? "LIVE" : "LEDGER", isEstimated: mixStage === "LIVE",
      atKst: "2026-10-30 23:15 KST", livePriced: 0, positionCount: 0, neutral: mixStage !== "LIVE" }), ledgerDay, lastNavTradingDate: "2026-10-29",
      lastNavFinal: true },
  ];
  const cells = (rows: ReturnType<typeof accountComparisonRows>, key: string) => {
    const found = rows.find((entry) => entry.key === key);
    if (!found) throw new Error(`줄 없음: ${key}`);
    return BOOKS.map((entry) => found.cells[entry.code]);
  };

  it("모두 장중(현금뿐은 판정에서 뺌)이면 지금 값 칸 — 맨 위 기준 줄, 수익률 다음 '오늘 변화'(기준 글), 통계 앞 '통계 기준'", () => {
    const rows = accountComparisonRows(withCurrent("LEDGER"), "US", { session: REGULAR });
    expect(rows.map((row) => row.label)).toEqual([
      "기준", "상태", "종류", "출발", "처음 현금", "순자산", "수익률(출발 이후)", "오늘 변화", "주식 노출", "현금", "보유", "마지막 관측", "가격 없음",
      "통계 기준", "누적 수익률", "연율 수익률", "변동성(연율)", "최대 낙폭", "샤프", "초과 수익률", "베타", "비교 기준",
    ]);
    expect(cells(rows, "basis").map((cell) => cell.text)).toEqual([
      "장중 추정 23:58", "출발 전", "장중 마지막 추정 23:58 · 종가 확정 전", "장부 23:15 · 현금뿐",
    ]);
    expect(rows.find((row) => row.key === "basis")?.wrap).toBe(true);
    expect(cells(rows, "nav")[0].text).toBe("101,234.56 달러");
    expect(cells(rows, "returnPct")[0]).toEqual({ text: "+1.23%", className: "text-up" });
    expect(cells(rows, "exposure")[0].text).toBe("98.7%");
    expect(cells(rows, "day")[0]).toEqual({ text: "+0.42%", className: "text-up", sub: "10-29 잠정 대비" });
    expect(cells(rows, "day")[2]).toEqual({ text: "-0.10%", className: "text-down", sub: "10-29 잠정 대비" });
    expect(cells(rows, "statsBasis").map((cell) => cell.text)).toEqual(["마감 10-29 확정", "—", "마감 10-29 잠정", "마감 10-29 확정"]);
    // 장부 칸은 그대로(현금·마지막 관측·통계)
    expect(cells(rows, "cash")[0].text).toBe("12.34 달러");
    expect(cells(rows, "stat-cumReturnPct")[0].text).toBe("+1.23%");
  });

  it("비중립 계좌 하나라도 장중이 아니면 표 전체 장부 칸 — 순자산·수익률은 BookSummary, 변화는 ledgerDay, 기준 줄은 '장부 MM-DD HH:MM'", () => {
    const books = withCurrent("LEDGER").map((entry) => (entry.code === "bench_mix" ? { ...entry, current: { ...entry.current!, neutral: false, positionCount: 2 } } : entry));
    const rows = accountComparisonRows(books, "US", { session: REGULAR });
    expect(cells(rows, "basis").map((cell) => cell.text)).toEqual(["장부 10-24 05:15", "출발 전", "장부 10-24 05:15", "장부 10-24 05:15"]);
    expect(cells(rows, "nav")[0].text).toBe("100,123.45 달러");
    expect(cells(rows, "returnPct")[0]).toEqual({ text: "-1.50%", className: "text-down" });
    expect(cells(rows, "day")[0]).toEqual({ text: "+0.30%", className: "text-up", sub: "10-29 확정 대비" });
    // 출발 전 계좌(장부 변화 없음)는 '—'
    expect(cells(rows, "day")[1]).toEqual({ text: "—", className: null });
    expect(rows.find((row) => row.key === "day")?.label).toBe("오늘 변화");
  });

  it("장 밖(휴장)이면 '최근 변화' — 칸 아래 기준 글 앞에 그 값의 날짜", () => {
    const books = withCurrent("LEDGER").map((entry) => ({
      ...entry, current: entry.current ? { ...entry.current, stage: "FINAL" as const, basis: "LEDGER" as const, isEstimated: false } : entry.current,
    }));
    const rows = accountComparisonRows(books, "US", { session: SUNDAY });
    expect(rows.find((row) => row.key === "day")?.label).toBe("최근 변화");
    expect(cells(rows, "day")[0]).toEqual({ text: "+0.30%", className: "text-up", sub: "10-30 · 10-29 확정 대비" });
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

describe("S = 100 같은 구간(계좌2)", () => {
  const books = (startedOn: string | null) => [
    book("rules", { kind: "RULES", label: "규칙 계좌" }),
    book("claude", { kind: "CLAUDE", label: "Claude 계좌1", benchmark: "bench_spy" }),
    book("claude2", { kind: "CLAUDE", label: "Claude 계좌2", startedOn, benchmark: "bench_spy" }),
    book("bench_spy", { label: "SPY 계좌" }),
    book("bench_mix", { label: "60/40 계좌" }),
  ];
  const nav = {
    dates: ["2026-10-30", "2026-11-02", "2026-11-03", "2026-11-04"],
    books: {
      rules: [100, 101, 102, 103],
      claude: [99000, 100000, 101000, 99500],
      claude2: [null, 100000, null, 100500],
      bench_spy: [100500, 101000, 101101, null],
      bench_mix: [1, 2, 3, 4],
    },
  };

  it("출발일 S부터 계좌1·계좌2·비교 기준을 S = 100으로 — 규칙·60/40은 넣지 않고, 그날 기록이 없으면 그날만 null", () => {
    const view = sameWindowIndex(nav, books("2026-11-02"));
    expect(view?.baseDate).toBe("2026-11-02");
    expect(view?.series).toEqual([
      { key: "claude", name: "Claude 계좌1" }, { key: "claude2", name: "Claude 계좌2" }, { key: "bench_spy", name: "SPY 계좌" },
    ]);
    expect(view?.rows.map((row) => row.date)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);
    expect(view?.rows[0]).toEqual({ date: "2026-11-02", claude: 100, claude2: 100, bench_spy: 100 });
    expect(view?.rows[1].claude).toBeCloseTo(101, 10);
    expect(view?.rows[1].claude2).toBeNull();
    expect(view?.rows[1].bench_spy).toBeCloseTo(100.1, 10);
    expect(view?.rows[2].claude2).toBeCloseTo(100.5, 10);
    expect(view?.rows[2].bench_spy).toBeNull();
    expect(view?.latest).toBe("2026-11-04 — Claude 계좌1 99.5 · Claude 계좌2 100.5 · SPY 계좌 —");
    expect(view?.missingBase).toEqual([]);
  });

  it("S에 기록이 없는 계좌는 선 전체 null(100으로 채우지 않음)과 그 이름", () => {
    const view = sameWindowIndex({ ...nav, books: { ...nav.books, bench_spy: [100500, null, 101101, 101000] } }, books("2026-11-02"));
    expect(view?.rows.map((row) => row.bench_spy)).toEqual([null, null, null]);
    expect(view?.missingBase).toEqual(["SPY 계좌"]);
  });

  it("계좌2가 없거나 출발 전이거나 출발일이 곡선에 없으면 null — 그리지 않음", () => {
    expect(sameWindowIndex(nav, books(null))).toBeNull();
    expect(sameWindowIndex(nav, books("2026-11-09"))).toBeNull();
    expect(sameWindowIndex(nav, BOOKS)).toBeNull();
    expect(sameWindowIndex(null, books("2026-11-02"))).toBeNull();
  });
});

describe("bookMonogram — 계좌 행 아바타 글자", () => {
  it("미국·한국 계좌 코드마다 약칭", () => {
    expect(["rules", "claude", "claude2", "bench_spy", "bench_mix"].map(bookMonogram)).toEqual(["R", "C1", "C2", "SPY", "60"]);
    expect(["kr_rules", "kr_claude", "kr_claude2", "kr_bench_k200", "kr_bench_mix"].map(bookMonogram)).toEqual(["R", "C1", "C2", "200", "60"]);
  });

  it("모르는 코드는 null — 글자를 짐작하지 않는다(객체 기본 속성 이름도)", () => {
    for (const code of ["", "unknown", "constructor", "toString", "RULES"]) {
      expect(bookMonogram(code)).toBeNull();
    }
  });
});

describe("오늘 추정 꼬리(장중 명세 §4 '순자산 곡선 꼬리')", () => {
  const REGULAR = { phase: "REGULAR" as const, sessionDate: "2026-10-30" };
  const ESTIMATE: PaperNavEstimate = {
    date: "2026-10-30", atKst: "2026-10-30 23:57 KST", isEstimated: true,
    books: {
      rules: { nav: 101_234.56, isEstimated: true }, claude: { nav: null, isEstimated: false },
      bench_spy: { nav: 100_600, isEstimated: true }, bench_mix: { nav: 100_500, isEstimated: false },
      // 계좌가 아닌 키(참고선)가 섞여 와도 꼬리를 짓지 않습니다.
      ref: { nav: 1, isEstimated: true },
    },
  };
  const live = (atKst: string | null): PaperCurrentValue => ({
    nav: 101_234.56, returnPct: 1.23, exposurePct: 98.7, dayChangePct: 0.42, previousTradingDate: "2026-10-29", previousNavFinal: false,
    basis: "LIVE", stage: "LIVE", tradingDate: "2026-10-30", atKst, isEstimated: true, livePriced: 2, positionCount: 2, pendingOrders: 0,
    neutral: false, note: null,
  });
  const books: PaperOverviewBook[] = [
    { ...BOOKS[0], current: live("2026-10-30 23:58 KST") },
    BOOKS[1],
    // 그 계좌 시각을 모르면 navEstimate 시각(장중 값 계좌들 가운데 가장 오래된 것)
    { ...BOOKS[2], current: live(null) },
    BOOKS[3],
  ];
  const NAV_WINDOW = {
    dates: ["2026-10-28", "2026-10-29"],
    books: { rules: [100_900, 101_200], bench_spy: [100_300, null], bench_mix: [100_400, 100_500] },
  };
  const CHART = {
    rows: [
      { date: "2026-10-28", rules: 100_900, bench_spy: 100_300, bench_mix: 100_400, ref: 100_000 },
      { date: "2026-10-29", rules: 101_200, bench_spy: null, bench_mix: 100_500, ref: 100_100 },
    ],
    series: [
      { key: "rules", name: "규칙 계좌" }, { key: "bench_spy", name: "SPY 계좌" }, { key: "bench_mix", name: "60/40 계좌" },
      { key: "ref", name: "참고선(계좌 아님)" },
    ],
  };

  it("계좌 하나의 점 — 시각은 그 계좌 지금 값(모르면 navEstimate), 현금뿐은 '장부', 값이 없거나 꼬리가 없는 응답이면 null", () => {
    expect(navEstimatePoint(ESTIMATE, books[0], "rules")).toEqual({ date: "2026-10-30", nav: 101_234.56, isEstimated: true, clock: "23:58", tag: "추정 23:58" });
    expect(navEstimatePoint(ESTIMATE, books[2], "bench_spy")).toMatchObject({ clock: "23:57", tag: "추정 23:57" });
    expect(navEstimatePoint(ESTIMATE, books[3], "bench_mix")).toEqual({ date: "2026-10-30", nav: 100_500, isEstimated: false, clock: null, tag: "장부" });
    expect(navEstimatePoint({ ...ESTIMATE, atKst: "" }, books[2], "bench_spy")).toMatchObject({ clock: null, tag: "추정" });
    expect(navEstimatePoint(ESTIMATE, books[1], "claude")).toBeNull();
    expect(navEstimatePoint(ESTIMATE, null, "constructor")).toBeNull();
    expect(navEstimatePoint(null, books[0], "rules")).toBeNull();
    expect(navEstimatePoint({ ...ESTIMATE, date: "오늘" }, books[0], "rules")).toBeNull();
  });

  it("비교 곡선 — 창 뒤에 한 행, 꼬리는 마지막 행 값에서 시작(없으면 외딴 점), 이름 '{계좌} · 추정 HH:MM'·'· 장부', 출발 전·참고선에는 없음", () => {
    const tailed = withNavEstimateTail(CHART, ESTIMATE, books);
    expect(tailed.tailDate).toBe("2026-10-30");
    expect(tailed.series.slice(4)).toEqual([
      { key: "rules__estimate", name: "규칙 계좌 · 추정 23:58", tailOf: "rules" },
      { key: "bench_spy__estimate", name: "SPY 계좌 · 추정 23:57", tailOf: "bench_spy" },
      { key: "bench_mix__estimate", name: "60/40 계좌 · 장부", tailOf: "bench_mix" },
    ]);
    expect(tailed.rows).toHaveLength(3);
    expect(tailed.rows[2]).toEqual({
      date: "2026-10-30", rules: null, bench_spy: null, bench_mix: null, ref: null,
      rules__estimate: 101_234.56, bench_spy__estimate: 100_600, bench_mix__estimate: 100_500,
    });
    // 꼬리 시작은 마지막 행의 그 계좌 값 — SPY 계좌는 그날 값이 없어 꼬리가 점 하나(차트가 외딴 점으로 그림)
    expect(tailed.rows[1]).toMatchObject({ rules__estimate: 101_200, bench_spy__estimate: null, bench_mix__estimate: 100_500 });
    expect(tailed.rows[0]).toMatchObject({ rules__estimate: null, bench_spy__estimate: null, bench_mix__estimate: null });
    // 받은 차트는 그대로(새 행·새 칸은 사본에만)
    expect(CHART.rows).toHaveLength(2);
    expect("rules__estimate" in CHART.rows[1]).toBe(false);
  });

  it("그날 줄이 이미 있거나(날짜 ≤ 마지막 행) 꼬리가 없는 응답·빈 창·꼬리를 줄 계좌가 없으면 그대로", () => {
    expect(withNavEstimateTail(CHART, { ...ESTIMATE, date: "2026-10-29" }, books)).toEqual({ rows: CHART.rows, series: CHART.series, tailDate: null });
    expect(withNavEstimateTail(CHART, null, books)).toEqual({ rows: CHART.rows, series: CHART.series, tailDate: null });
    expect(withNavEstimateTail({ rows: [], series: CHART.series }, ESTIMATE, books)).toEqual({ rows: [], series: CHART.series, tailDate: null });
    expect(withNavEstimateTail(CHART, { ...ESTIMATE, books: {} }, books).tailDate).toBeNull();
  });

  it("곡선 아래 설명 — 꼬리가 있을 때만", () => {
    expect(navTailNote("2026-10-30")).toMatch(/^짧은 점선 꼬리\(범례에 없음\) = 10-30 순자산 줄이 생기기 전의 지금 값/);
    // 꼬리가 없는 계좌의 선이 마지막 줄에서 끊기는 까닭
    expect(navTailNote("2026-10-30")).toContain("장중 값이 있는 계좌와 현금뿐 계좌만 그리고(그 밖의 계좌 — 보유가 있는데 지금 값이 장부·순자산 줄 단계인 계좌와 출발 전 계좌 — 는 꼬리 없음)");
    expect(navTailNote(null)).toBeNull();
  });

  it("히어로 곡선 — 같은 창의 그 계좌 한 줄 + 꼬리 점 행, 문지르기가 읽을 꼬리 정보(추정 'HH:MM'·현금뿐 '장부'), 꼬리가 없으면 예전 모양", () => {
    const tail = navEstimatePoint(ESTIMATE, books[0], "rules");
    const hero = heroNavChart(NAV_WINDOW, "rules", "규칙 계좌", "US", tail);
    expect(hero.rows).toEqual([
      { date: "2026-10-28", nav: 100_900, estimate: null },
      { date: "2026-10-29", nav: 101_200, estimate: 101_200 },
      { date: "2026-10-30", nav: null, estimate: 101_234.56 },
    ]);
    expect(hero.series).toEqual([{ key: "nav", label: "규칙 계좌" }, { key: "estimate", label: "규칙 계좌 · 추정 23:58", tailOf: "nav" }]);
    expect(hero.estimate).toEqual({ date: "2026-10-30", valueKey: "estimate", isEstimated: true, note: "23:58" });
    expect(heroNavChart(NAV_WINDOW, "bench_mix", "60/40 계좌", "US", navEstimatePoint(ESTIMATE, books[3], "bench_mix")).estimate)
      .toEqual({ date: "2026-10-30", valueKey: "estimate", isEstimated: false, note: "장부" });
    expect(heroNavChart(NAV_WINDOW, "rules", "규칙 계좌")).toEqual({
      rows: [{ date: "2026-10-28", nav: 100_900 }, { date: "2026-10-29", nav: 101_200 }],
      series: [{ key: "nav", label: "규칙 계좌" }],
      valueDigits: 2,
      estimate: null,
    });
    expect(heroNavChart(NAV_WINDOW, "rules", "규칙 계좌", "US", tail && { ...tail, date: "2026-10-29" }).estimate).toBeNull();
    expect(heroNavChart(null, "rules", "규칙 계좌", "US", tail)).toMatchObject({ rows: [], estimate: null });
  });

  it("개요 히어로 모델 — 고른 계좌의 꼬리(navEstimate의 그 계좌), 출발 전 계좌는 꼬리 없음", () => {
    const overview = { books, pendingBackfill: [], quotes: null, liveSession: REGULAR, navEstimate: ESTIMATE };
    expect(overviewHeroModel(overview, "rules", NAV_WINDOW)?.chart.estimate).toMatchObject({ date: "2026-10-30", note: "23:58" });
    expect(overviewHeroModel(overview, "claude", NAV_WINDOW)?.chart.estimate).toBeNull();
    expect(overviewHeroModel({ ...overview, navEstimate: undefined }, "rules", NAV_WINDOW)?.chart.estimate).toBeNull();
  });

  it("실시간 순자산(사용자 결정 2026-11-03)이 같은 계좌면 큰 숫자·출발 이후·변화를 그 값으로 — '실시간 추정'과 실시간 가격 수, 다른 계좌면 무시", () => {
    const overview = { books, pendingBackfill: [], quotes: null, liveSession: REGULAR, navEstimate: ESTIMATE };
    const realtime = { code: "rules", nav: 101_500.5, returnPct: 1.5, dayChangePct: 0.3, at: "2026-10-30T14:58:07Z", priced: 2, total: 3 };
    const hero = overviewHeroModel(overview, "rules", NAV_WINDOW, "US", realtime);
    expect(hero).toMatchObject({ valueText: "101,500.50", returnPct: 1.5, isEstimated: true,
      stageLabel: "실시간 추정 23:58:07 · 실시간 가격 2/3종목" });
    expect(hero?.day === null || hero?.day?.pct === 0.3).toBe(true);
    expect(overviewHeroModel(overview, "claude", NAV_WINDOW, "US", realtime)?.stageLabel ?? "").not.toMatch(/^실시간 추정/);
  });
});
