/**
 * 모의매매(한국) 표기(lib/paperKr) — 출발 상태 넷·결정 창·초기화/출발/리스크 결과·출발 작업 기록 줄.
 *
 *  - 출발 상태: 출발한 계좌가 있으면 started(출발일 설정과 상관없이), 출발일 없음 dormant, 계좌 없음 init, 네 계좌 시작 전 waiting
 *  - 결정 창은 설정 값(모르면 "—" — 22:30을 짓지 않음), 기한이 이르면 "(다음 날)"
 *  - 출발 결과 넷: STARTED·ALREADY_STARTED는 정보, START_POSTPONED·ERROR는 경고, 서버 문구 그대로 + 기록의 아는 칸(미룸·과금 호출)
 *  - 리스크 점검: 쉬면 그 사유를 경고로(미국 문구 대신)
 */
import { describe, expect, it } from "vitest";

import { heldText, stopText } from "../paper";
import {
  chargedCalls,
  jobsEmptyMessage,
  krCollectionRows,
  krDecisionExtras,
  krDecisionKindLabel,
  krDecisionRunBlocked,
  krEventsView,
  krGateRows,
  krLatestJudgedGates,
  krManualDecisionNote,
  krPricesFinalText,
  krRuleDecisionView,
  krSelectionPicks,
  krSelectionReference,
  krSelectionView,
  krStartRecords,
  krConfirmationCautions,
  krConfirmationCells,
  krConfirmationTotalText,
  krFillBadges,
  krNavProvisionalReason,
  krNavRows,
  krOrderRejectText,
  krPositionBadges,
  krPriceSourceLabel,
  krStopBasisText,
  krDecisionWindowText,
  krJobDetailText,
  krInitResultText,
  krRiskResultView,
  krStartRecordLine,
  krStartRecordParts,
  krStartResultView,
  krStartState,
  KR_REFERENCE_KEY,
  krReferenceNotes,
  latestStartRecord,
  marketJobs,
  withKrReference,
} from "../paperKr";
import type { PaperBookSummary, PaperDecisionDetail, PaperDecisionSummary, PaperJobRun, PaperPosition } from "../types";

const book = (code: string, status: PaperBookSummary["status"]): PaperBookSummary => ({
  code, kind: "BENCHMARK", label: code, status, startedOn: null, initialCash: 100_000_000, cash: 100_000_000, nav: 100_000_000,
  equityValue: 0, exposurePct: 0, returnPct: null, lastObservedAtKst: null, positions: 0, staleCount: 0, stats: null, benchmark: null,
});
const FOUR = ["kr_rules", "kr_claude", "kr_bench_k200", "kr_bench_mix"];

describe("출발 상태", () => {
  it("넷 — dormant·init·waiting·started", () => {
    expect(krStartState({ startDate: null, initialized: false, books: [], dormantReason: "출발일 없음" }))
      .toEqual({ kind: "dormant", reason: "출발일 없음" });
    expect(krStartState({ startDate: null, initialized: false, books: [] }).kind).toBe("dormant");
    expect(krStartState({ startDate: "2026-10-29", initialized: false, books: [] })).toEqual({ kind: "init", startDate: "2026-10-29" });
    expect(krStartState({ startDate: "2026-10-29", initialized: true, books: FOUR.map((c) => book(c, "NOT_STARTED")) }))
      .toEqual({ kind: "waiting", startDate: "2026-10-29" });
    expect(krStartState({ startDate: "2026-10-29", initialized: true, books: FOUR.map((c) => book(c, "ACTIVE")) }).kind).toBe("started");
    // 출발한 뒤 출발일을 비워도 한국 책은 돕니다(API.md dormantReason) — 출발 카드를 다시 보이지 않음.
    expect(krStartState({ startDate: null, initialized: true, books: [book("kr_rules", "PAUSED"), book("kr_claude", "ACTIVE")] }).kind)
      .toBe("started");
  });
});

describe("결정 창", () => {
  it("설정 값 그대로, 기한이 결정 시각 이하면 (다음 날), 모르면 —", () => {
    expect(krDecisionWindowText({ kr: { decisionTimeKst: "22:30", decisionDeadlineKst: "01:00" } })).toBe("22:30 ~ 01:00(다음 날) KST");
    expect(krDecisionWindowText({ kr: { decisionTimeKst: "21:00", decisionDeadlineKst: "23:30" } })).toBe("21:00 ~ 23:30 KST");
    expect(krDecisionWindowText({})).toBe("— ~ — KST");
    expect(krDecisionWindowText(null)).toBe("— ~ — KST");
  });
});

describe("초기화 결과", () => {
  it("만든 계좌·채운 kr.* 키 수·판, 다시 누르면 그대로", () => {
    expect(krInitResultText({
      ok: true, startDate: "2026-10-29", created: FOUR, settingsVersion: 4, settingsKeysWritten: ["kr.slippageBp", "kr.commissionBp"],
    })).toBe("만든 계좌 kr_rules, kr_claude, kr_bench_k200, kr_bench_mix · 설정 v4 — 비어 있던 kr.* 키 2개를 기본값으로 채움 · 출발일 2026-10-29");
    expect(krInitResultText({ ok: true, created: [], settingsVersion: 4, settingsKeysWritten: [] }))
      .toBe("새로 만든 계좌 없음(이미 있음) · 설정 그대로(v4)");
  });
});

describe("출발 결과", () => {
  it("넷 — 문구·색, 서버 문구와 기록의 아는 칸(미룸·과금 호출)", () => {
    expect(krStartResultView({ ok: true, outcome: "STARTED", tradingDate: "2026-10-29", message: "2026-10-29 한국 출발" }))
      .toMatchObject({ tone: "info", text: "한국 출발 — 2026-10-29 결정, 네 계좌가 다음 KR 거래일 시가에 함께 체결합니다 — 2026-10-29 한국 출발" });
    expect(krStartResultView({ ok: true, outcome: "ALREADY_STARTED", tradingDate: "2026-10-29" }))
      .toMatchObject({ tone: "info", text: "이미 출발했습니다(2026-10-29) — 아무것도 하지 않았습니다" });
    const postponed = krStartResultView({
      ok: false, outcome: "START_POSTPONED", tradingDate: "2026-10-29", message: "Claude 출발 호출 실패",
      record: { start: true, tradingDate: "2026-10-29", configuredStartDate: "2026-10-29", postponed: false, postponedTo: "2026-10-30",
        reason: "출발 계획 실패", calls: { kr_claude: { calls: 2, attempts: [], isEstimated: true } } },
    });
    expect(postponed.tone).toBe("warn");
    expect(postponed.text).toBe("출발을 다음 KR 거래일로 미뤘습니다(2026-10-29) — Claude 출발 호출 실패");
    expect(postponed.detail).toEqual([
      "세션 2026-10-29", "다음 KR 거래일 2026-10-30로 미룸", "사유 출발 계획 실패", "과금 호출 kr_claude 2회(결정 행 없음 — 사용량에 셈)",
    ]);
    expect(krStartResultView({ ok: false, outcome: "ERROR", tradingDate: null, record: { attempt: 2, error: "DB 오류" } }))
      .toMatchObject({ tone: "warn", text: "출발 오류(—) — 다음 주기에 다시 시도합니다", detail: ["시도 2번째", "오류 DB 오류"] });
    expect(krStartResultView({ ok: false, outcome: "MYSTERY" }).text).toBe("출발 결과 MYSTERY");
  });

  it("과금 호출 — 호출 수를 모르면 —, 기록이 없으면 null", () => {
    expect(chargedCalls({ kr_claude: {} })).toBe("과금 호출 kr_claude —회(결정 행 없음 — 사용량에 셈)");
    expect(chargedCalls(null)).toBeNull();
    expect(chargedCalls({})).toBeNull();
  });

  it("미뤄진 세션은 설정 출발일을 함께, 이어진 기다림은 주기 수", () => {
    expect(krStartRecordParts({ tradingDate: "2026-10-30", configuredStartDate: "2026-10-29", postponed: true, checks: 5, reason: "② 관측치 없음" }))
      .toEqual(["세션 2026-10-30", "설정 출발일 2026-10-29에서 미뤄짐", "이어진 주기 5번", "사유 ② 관측치 없음"]);
    expect(krStartRecordParts("문자열")).toEqual([]);
  });
});

describe("출발 작업 기록", () => {
  it("kr.decision 중 start:true만, 최근 순 첫 줄", () => {
    const jobs = [
      { job: "kr.risk", startedAtKst: "2026-10-29 22:41 KST", finishedAtKst: null, outcome: "OK", detail: {} },
      { job: "kr.decision", startedAtKst: "2026-10-29 22:40 KST", finishedAtKst: null, outcome: "DATA_NOT_READY", detail: { checks: 2 } },
      { job: "kr.decision", startedAtKst: "2026-10-29 22:30 KST", finishedAtKst: null, outcome: "START_WAITING",
        detail: { start: true, tradingDate: "2026-10-29", checks: 3, reason: "⑤ 069500 D 봉 없음" } },
    ];
    const record = latestStartRecord(jobs);
    expect(record?.outcome).toBe("START_WAITING");
    expect(krStartRecordLine(record!)).toBe("2026-10-29 22:30 START_WAITING · 세션 2026-10-29 · 이어진 주기 3번 · 사유 ⑤ 069500 D 봉 없음");
    expect(latestStartRecord([])).toBeNull();
    expect(latestStartRecord(null)).toBeNull();
  });
});

describe("리스크 점검", () => {
  it("쉬면 그 사유를 경고로, 돌면 미국과 같은 표시", () => {
    const outcome = { filled: 0, stopped: 0, expired: 0, splits: 0, booksProcessed: [], skippedReason: "쉼", notes: [], errors: [] };
    expect(krRiskResultView({ ok: false, market: "KR", dormantReason: "출발일 없음", outcome }).warning)
      .toBe("한국 책이 쉬고 있어 리스크 점검을 하지 않았습니다 — 출발일 없음");
    expect(krRiskResultView({ ok: true, market: "KR", dormantReason: null, outcome: { ...outcome, skippedReason: null } }))
      .toMatchObject({ tone: "info", warning: null });
  });
});

describe("작업 기록 카드(x3)", () => {
  const job = (name: string, detail: unknown = {}) => ({ job: name, startedAtKst: null, finishedAtKst: null, outcome: "OK", detail });

  it("미국 카드는 kr. 줄을 빼고, 한국 카드는 kr.만", () => {
    const jobs = [job("decision"), job("kr.risk"), job("risk"), job("kr.decision"), job("krx-like")];
    expect(marketJobs(jobs, "US").map((row) => row.job)).toEqual(["decision", "risk", "krx-like"]);
    expect(marketJobs(jobs, "KR").map((row) => row.job)).toEqual(["kr.risk", "kr.decision"]);
    expect(marketJobs(null, "US")).toEqual([]);
  });

  it("비었을 때 — 미국은 받은 줄이 모두 한국 작업이면 그렇다고", () => {
    expect(jobsEmptyMessage("US", [job("kr.risk")])).toBe("최근 10건 가운데 미국 작업이 없습니다 — 한국 작업은 한국 개요에 있습니다.");
    expect(jobsEmptyMessage("US", [])).toContain("아직 작업 기록이 없습니다");
    expect(jobsEmptyMessage("KR", [])).toContain("아직 한국 작업 기록이 없습니다");
  });

  it("한국 상세 — 기다림 줄(이어진 주기·기다림 문구), 기한 지남(미달 게이트·판정 근거), 출발 미룸(미룬 날·과금 호출), 모르는 모양은 키: 값", () => {
    expect(krJobDetailText(job("kr.decision", {
      tradingDate: "2026-10-29", checks: 4, waiting: "자료 게이트 미달: ⑤ — 기한 2026-10-30 01:00 KST까지 다음 주기에 다시 봅니다",
      gates: [{ gate: "⑤", status: "FAIL", note: "069500 D 봉 없음" }],
    }))).toBe("세션 2026-10-29 · 이어진 주기 4번 · 자료 게이트 미달: ⑤ — 기한 2026-10-30 01:00 KST까지 다음 주기에 다시 봅니다");
    expect(krJobDetailText(job("kr.decision", {
      tradingDate: "2026-10-29", pastDeadline: true, gatesBasis: "기한 전 마지막 판정 2026-10-30 00:50 KST",
      gates: [{ gate: "③", status: "FAIL", note: "창 구멍" }, { gate: "②", status: "PASS", note: null }],
    }))).toBe("기한 지남 · 세션 2026-10-29 · 미달 게이트 ③ · 판정 기한 전 마지막 판정 2026-10-30 00:50 KST");
    expect(krJobDetailText(job("kr.decision", {
      start: true, tradingDate: "2026-10-30", configuredStartDate: "2026-10-29", postponed: true, postponedTo: "2026-11-02",
      reason: "출발 계획 실패", calls: { kr_claude: { calls: 1 } },
    }))).toBe("세션 2026-10-30 · 설정 출발일 2026-10-29에서 미뤄짐 · 다음 KR 거래일 2026-11-02로 미룸 · 사유 출발 계획 실패 · "
      + "과금 호출 kr_claude 1회(결정 행 없음 — 사용량에 셈)");
    expect(krJobDetailText(job("kr.risk", { filled: 0, barDate: "2026-10-28" }))).toBe("filled: 0 · barDate: 2026-10-28");
    expect(krJobDetailText(job("kr.risk", null))).toBe("—");
  });
});

describe("한국 수집 상태 줄(x4)", () => {
  const QUOTES = { collectedAtKst: "2026-10-30 22:05 KST", ageSeconds: 60, barDate: "2026-10-30", finalClose: true, tickers: 102,
    staleTickers: ["005930"], stale: false };

  it("일곱 줄 — 정상·늦음(사유)·뒤처짐(사유)·없음, 관측치 줄에 받은 종목·이어받음", () => {
    const rows = krCollectionRows({
      quotes: { available: true, collectedAtKst: "2026-10-30 22:05 KST", session: "2026-10-30", universeDate: "2026-10-29", scope: 103,
        stale: false, staleReason: null },
      flows: { available: true, collectedAtKst: "2026-10-30 22:10 KST", session: "2026-10-30", universeDate: "2026-10-29", scope: 103,
        ok: 100, sessionMiss: 2, noRecords: 1, carried: 1, missing: 1, stale: true, staleReason: null },
      universe: { available: true, baseDate: "2026-10-28", size: 100, behind: true, behindReason: "유니버스 기준일이 이릅니다" },
      dart: { available: false, collectedAtKst: null, universe: null, krScope: null, unmapped: null, stale: null },
      news: { available: true, lastFetchKst: "2026-10-30 21:58 KST", stored7d: 387, feedsOk: 3, feedsTotal: 4,
        failedFeeds: [{ feed: "yna_market", source: "연합뉴스", reason: "HTTP 503" }], stale: false },
      calendar: { available: true, generatedAtKst: "2026-10-29 01:10 KST", macroCount: 1, unconfirmed: 5, horizonTo: "2026-12-13", stale: false },
      fsc: { available: true, stocksLatestBasDt: "2026-10-29", etfsLatestBasDt: "2026-10-28", metaCollectedAtKst: null, etfBehind: true },
    }, QUOTES);

    expect(rows.map((row) => [row.key, row.state])).toEqual([
      ["quotes", "정상"], ["flows", "늦음"], ["universe", "뒤처짐"], ["dart", "없음"], ["news", "정상"], ["calendar", "정상"], ["fsc", "뒤처짐"],
    ]);
    expect(rows[0]).toMatchObject({ basis: "세션 2026-10-30 · U 기준일 2026-10-29", collectedAt: "2026-10-30 22:05",
      scope: "범위 103종목 · 받은 102종목 · 이어받음 1 · 봉 2026-10-30", reason: null });
    expect(rows[1].scope).toBe("범위 103 · 정상 100(세션 기록 없음 2) · 기록 없음 1 · 이어받음 1 · 항목 없음 1");
    expect(rows[1].reason).toContain("2시간 5분을 넘김");
    expect(rows[2].reason).toBe("유니버스 기준일이 이릅니다");
    expect(rows[3]).toMatchObject({ collectedAt: "—", scope: "대상 —(한국 범위 —) · 고유번호 없음 —", reason: "저장본이 아직 없습니다" });
    expect(rows[4]).toMatchObject({ state: "정상", reason: "실패 피드 yna_market(HTTP 503)" });
    expect(rows[6]).toMatchObject({ basis: "주식 2026-10-29 · ETF 2026-10-28", collectedAt: "—" });
  });

  it("늦음을 모르면(달력 없음) '모름'과 서버 사유, collection이 없으면 빈 목록", () => {
    const rows = krCollectionRows({
      quotes: { available: true, collectedAtKst: null, session: null, universeDate: null, scope: null, stale: null, staleReason: "달력 없음 — 2027" },
    }, null);
    expect(rows).toEqual([expect.objectContaining({ key: "quotes", state: "모름", reason: "달력 없음 — 2027", basis: "세션 — · U 기준일 —",
      scope: "범위 —종목" })]);
    expect(krCollectionRows(null, null)).toEqual([]);
    expect(krCollectionRows(undefined, null)).toEqual([]);
  });
});

describe("노출 맞춘 참고선(K40)", () => {
  const REFERENCE = {
    label: "노출 맞춘 참고선 — 계좌 아님", basis: "…", note: "…",
    dates: ["2026-10-29", "2026-10-30", "2026-11-02", "2026-11-03"],
    values: [100_000_000, 100_100_000, null, null],
    stockWeightPct: [null, 0, null, null],
    asOfDate: "2026-10-30",
    stoppedReason: "2026-10-30 규칙 계좌 주식 비중을 모릅니다",
  };

  it("날짜로 맞춰 칸을 더하고 null은 그대로(기간으로 줄인 행에도 맞음) — 참고선이 없거나 모양이 다르면 계열 없음", () => {
    const rows = [{ date: "2026-10-30", kr_rules: 100_312_450 }, { date: "2026-11-02", kr_rules: 100_500_000 }];
    const merged = withKrReference(rows, REFERENCE);
    expect(merged.series).toEqual([{ key: KR_REFERENCE_KEY, name: "노출 맞춘 참고선(계좌 아님)" }]);
    expect(merged.rows).toEqual([
      { date: "2026-10-30", kr_rules: 100_312_450, [KR_REFERENCE_KEY]: 100_100_000 },
      { date: "2026-11-02", kr_rules: 100_500_000, [KR_REFERENCE_KEY]: null },
    ]);
    expect(rows[0]).not.toHaveProperty(KR_REFERENCE_KEY);
    expect(withKrReference(rows, null)).toEqual({ rows, series: [] });
    expect(withKrReference(rows, { ...REFERENCE, values: [1] }).series).toEqual([]);
  });

  it("곡선 아래 글 — 정의·마지막 값의 날과 그날 쓴 비중·멈춘 사유, 참고선이 없으면 null", () => {
    const notes = krReferenceNotes(REFERENCE);
    expect(notes?.[0]).toContain("069500 x% + 153130 (100−x)%");
    expect(notes?.[1]).toBe("마지막 값 2026-10-30(그날 쓴 전날 규칙 계좌 주식 비중 0.00%) — 금융위 확정 종가가 들어온 날까지라 보통 하루 늦습니다.");
    expect(notes).toContain("멈춤: 2026-10-30 규칙 계좌 주식 비중을 모릅니다");
    expect(krReferenceNotes({ ...REFERENCE, asOfDate: null, stoppedReason: null })?.[1]).toContain("아직 값이 없습니다");
    expect(krReferenceNotes(null)).toBeNull();
  });
});

describe("보유·체결(F2 — 세 배지·확정 조정·실효 비용·스탑 근거·잠정 사유)", () => {
  const position = (over: Partial<PaperPosition> = {}): PaperPosition => ({
    ticker: "005930", qty: 10, avgCost: 71_300, lastPrice: 71_500, lastPriceAtKst: "2026-11-03 21:57 KST", marketValue: 715_000,
    weightPct: 0.71, unrealizedPct: 0.28, highWatermark: 71_500, stopPrice: 65_780, stopDistancePct: 8.7, openedOn: "2026-11-03",
    holdingTradingDays: 1, holdingTradingDaysReason: null, priceStale: false, splitNote: null, cashLike: false, backfilled: false,
    corpActionHold: null, ...over,
  });

  it("보유 배지 — '기업행위 확인 필요'(사유는 title)가 맨 앞, '가격 없음'·현금성은 미국과 같은 배지, 사후 체결 배지는 없음", () => {
    const held = krPositionBadges(position({ corpActionHold: "2026-11-03 상장주식수 변동 — 확인 필요", priceStale: true,
      backfilled: true }));
    expect(held.map((badge) => badge.label)).toEqual(["기업행위 확인 필요", "가격 없음 · 지난 값"]);
    expect(held[0].title).toContain("2026-11-03 상장주식수 변동 — 확인 필요");
    expect(krPositionBadges(position({ lastPrice: null })).map((badge) => badge.label)).toEqual(["가격 없음 · 평단 평가"]);
    expect(krPositionBadges(position({ ticker: "153130", cashLike: true })).map((badge) => badge.label)).toEqual(["현금성"]);
    expect(krPositionBadges(position())).toEqual([]);
  });

  it("체결 배지 — 확정·확정 대기·미보정(서버 문구 그대로), 통합가는 '잠정' 배지, 상태를 모르면 배지 없음", () => {
    expect(krFillBadges({ confirmationState: "CONFIRMED", confirmationNote: null, priceSource: "TOSS_1M_OPEN", confirmation: {
      confirmedPrice: 71_200, priceDiff: -100, fee: 106, tax: 0, slippageCost: 356, costBp: 6.49, cashDelta: 1_000, source: "FSC",
      reconciledAtKst: "2026-11-04 22:05 KST" } }).map((badge) => [badge.label, badge.title]))
      .toEqual([["확정", "금융위 주식시세 확정가 71,200원 — 2026-11-04 22:05에 확정 조정"]]);
    expect(krFillBadges({ confirmationState: "WAITING", confirmationNote: "금융위 2026-11-02까지 냄 — 그날 값 기다림",
      priceSource: "TOSS_INTEGRATED" }).map((badge) => badge.label)).toEqual(["확정 대기", "KRX+NXT 통합가 · 잠정"]);
    expect(krFillBadges({ confirmationState: "UNCORRECTED", confirmationNote: "금융위 확정 미보정(ETF)", priceSource: "TOSS_DAILY" })
      .map((badge) => badge.label)).toEqual(["금융위 확정 미보정(ETF)"]);
    expect(krFillBadges({ confirmationState: "UNCORRECTED", confirmationNote: null, priceSource: null })[0].label).toBe("금융위 확정 못 함");
    expect(krFillBadges({ priceSource: "TOSS_1M_OPEN" })).toEqual([]);
    expect(krPriceSourceLabel("TOSS_1M_OPEN")).toBe("KRX 시가 단일가(1분봉)");
    expect(krPriceSourceLabel("NEW_SOURCE")).toBe("NEW_SOURCE");
    expect(krPriceSourceLabel(null)).toBe("—");
  });

  it("확정 칸·합계 — 차이·현금 차이는 부호, 행이 없으면 '—'(0원으로 쓰지 않음), 칸이 없는 서버면 합계 줄 없음", () => {
    expect(krConfirmationCells({ confirmation: { confirmedPrice: 71_200, priceDiff: -100, fee: 106, tax: 0, slippageCost: 356,
      costBp: 6.49, cashDelta: 1_000, source: "FSC", reconciledAtKst: null } })).toEqual({ price: "71,200원", diff: "-100원", cash: "+1,000원" });
    expect(krConfirmationCells({ confirmation: null })).toEqual({ price: "—", diff: "—", cash: "—" });
    expect(krConfirmationTotalText({ rows: 2, cashDelta: 503, unconfirmed: 1 })).toBe("확정 조정 합계 +503원 · 확정 2건 · 남음 1건");
    expect(krConfirmationTotalText({ rows: 0, cashDelta: null, unconfirmed: 3 }))
      .toBe("확정 조정 합계 —(확정 조정 행 없음) · 확정 0건 · 남음 3건");
    expect(krConfirmationTotalText(undefined)).toBeNull();
  });

  it("스탑 근거 — 감지(잠정 종가·출처·봉 날짜)·확정값으로 낮춘 최고가·재판정 근거·stopBasisNote, 스탑이 아닌 근거는 null", () => {
    const detected = { trigger: "TRAILING_STOP", stopPct: 8, highWatermark: 75_000, stopPrice: 69_000, observedPrice: 68_500,
      observedSource: "TOSS_INTEGRATED", barDate: "2026-11-05" };
    expect(krStopBasisText(detected)).toBe("감지 2026-11-05 잠정 종가 68,500원(KRX+NXT 통합가) ≤ 스탑가 69,000원(최고가 75,000원 −8.0%) · "
      + "재판정 전 — 체결 때 금융위 확정 종가로 다시 판정");
    expect(krStopBasisText({ ...detected, confirmedHighWatermark: 72_000, stopBasis: "FSC", confirmedClose: 68_700,
      stopBasisNote: "최고가는 감지 뒤 금융위 확정 조정이 다시 센 72,000원(감지 때 75,000원 — 잠정 체결가)" }))
      .toBe("감지 2026-11-05 잠정 종가 68,500원(KRX+NXT 통합가) ≤ 스탑가 69,000원(최고가 75,000원 −8.0%) · 확정값으로 낮춘 최고가 72,000원 · "
        + "재판정: 금융위 주식시세 확정 종가 68,700원 · 최고가는 감지 뒤 금융위 확정 조정이 다시 센 72,000원(감지 때 75,000원 — 잠정 체결가)");
    expect(krStopBasisText({ ...detected, stopBasis: "PROVISIONAL" })).toContain("재판정: 금융위 확정 종가 없음 — 잠정 판정대로");
    expect(krStopBasisText({ rule: "kr_rules", text: "재선정" })).toBeNull();
    expect(krStopBasisText(null)).toBeNull();
    expect(krOrderRejectText("STOP_NOT_CONFIRMED — 금융위 2026-11-05 종가 70,000원이 스탑가 69,000원 위"))
      .toEqual({ label: "스탑 취소 — 확정 종가가 뒷받침하지 않음", detail: "금융위 2026-11-05 종가 70,000원이 스탑가 69,000원 위" });
    expect(krOrderRejectText("최소 금액 미만")).toEqual({ label: null, detail: "최소 금액 미만" });
    expect(krOrderRejectText(null)).toEqual({ label: null, detail: null });
  });

  it("보유 기간·스탑 칸 — 한국은 'KR 거래일'·원 단위, 셀 수 없으면 사유를 괄호로(미국 글자는 그대로)", () => {
    expect(heldText(position({ holdingTradingDays: 3 }), "KR")).toBe("2026-11-03부터 · 3 KR 거래일");
    expect(heldText(position({ holdingTradingDays: null, holdingTradingDaysReason: "달력 없음 — 2028년" }), "KR"))
      .toBe("2026-11-03부터 · —(달력 없음 — 2028년)");
    expect(heldText(position({ holdingTradingDays: 3 }))).toBe("2026-11-03부터 · 3거래일");
    expect(heldText(position({ holdingTradingDays: null, holdingTradingDaysReason: "달력 없음" }))).toBe("2026-11-03부터 · —");
    expect(stopText(position(), "KR")).toBe("65,780 · 거리 8.7%");
  });

  const risk = (notes: unknown): PaperJobRun => ({ job: "kr.risk", startedAtKst: null, finishedAtKst: null, outcome: "OK",
    detail: { notes } });

  it("잠정 사유 — 그 계좌 리스크 점검 메모의 '순자산 {날} 잠정으로 다시 씀 — 사유'(최근 것), 다시 쓰지 않음, 없거나 모양이 틀리면 null", () => {
    const jobs = [
      risk(["kr_rules: 순자산 2026-11-03 잠정으로 다시 씀(확정 현금 30,000,000원) — 주문 12 SELL 005930(기준일 2026-11-02) 대기 — "
        + "2026-11-03 이하 봉으로 체결될 수 있음", "kr_claude: 순자산 2026-11-03 확정(금융위 종가) 100,000,000원 — …"]),
      risk(["kr_rules: 순자산 2026-11-03 잠정으로 다시 씀(확정 현금 1원) — 옛 사유"]),
      { job: "kr.decision", startedAtKst: null, finishedAtKst: null, outcome: "OK", detail: { notes: ["kr_rules: 순자산 2026-11-02 잠정으로 다시 씀 — 다른 작업"] } },
      risk(["kr_rules: 순자산 2026-11-04 줄은 다시 쓰지 않음 — 마지막으로 처리한 관측치의 세션이 2026-11-05(그 줄 2026-11-04이 아님)(확정 현금은 상태에 반영, 그 줄은 잠정 그대로)"]),
    ];
    expect(krNavProvisionalReason(jobs, "kr_rules", "2026-11-03"))
      .toBe("주문 12 SELL 005930(기준일 2026-11-02) 대기 — 2026-11-03 이하 봉으로 체결될 수 있음");
    expect(krNavProvisionalReason(jobs, "kr_rules", "2026-11-04")).toContain("줄을 다시 쓰지 않음 — 마지막으로 처리한 관측치의 세션이 2026-11-05");
    expect(krNavProvisionalReason(jobs, "kr_rules", "2026-11-02")).toBeNull();
    expect(krNavProvisionalReason(jobs, "kr_claude", "2026-11-03")).toBeNull();
    expect(krNavProvisionalReason([risk("문자열"), risk([3, null]), { ...risk([]), detail: null }], "kr_rules", "2026-11-03")).toBeNull();
    expect(krNavProvisionalReason(null, "kr_rules", "2026-11-03")).toBeNull();
  });

  it("순자산 기록 줄 — 최근 거래일부터, 확정은 사유 없음, 잠정은 사유(없으면 '—'), 원 정수", () => {
    const rows = krNavRows([
      { tradingDate: "2026-11-02", nav: 100_000_000, cash: 100_000_000, equityValue: 0, exposurePct: 0, pricesFinal: true },
      { tradingDate: "2026-11-03", nav: 100_312_450, cash: 340_000, equityValue: 99_972_450, exposurePct: 99.66, pricesFinal: false },
    ], [risk(["kr_rules: 순자산 2026-11-03 잠정으로 다시 씀(확정 현금 340,000원) — 005930 금융위 2026-11-03 종가 없음 — 마지막 평가 가격 71,500원"])],
    "kr_rules");
    expect(rows).toEqual([
      { tradingDate: "2026-11-03", nav: "100,312,450원", cash: "340,000원", exposure: "99.7%", pricesFinal: false,
        reason: "005930 금융위 2026-11-03 종가 없음 — 마지막 평가 가격 71,500원" },
      { tradingDate: "2026-11-02", nav: "100,000,000원", cash: "100,000,000원", exposure: "0.0%", pricesFinal: true, reason: null },
    ]);
    expect(krNavRows([{ tradingDate: "2026-11-03", nav: null, cash: null, equityValue: null, exposurePct: null, pricesFinal: false }], null,
      "kr_rules")[0]).toMatchObject({ nav: "—", exposure: "—", reason: "—" });
    expect(krNavRows(undefined, null, "kr_rules")).toEqual([]);
  });

  it("확정 조정 '주의' — 그 계좌 메모 가운데 '— 주의:'가 붙은 것만, 같은 글은 한 번", () => {
    const caution = "체결 7 BUY 005930 10주(2026-11-03) 확정(FSC 2026-11-03 시가): … — 주의: 잠정 체결의 비용 칸이 이 판의 요율로 다시 센 값과 다름";
    const jobs = [risk([`kr_rules: ${caution}`, "kr_rules: 체결 8 확정"]), risk([`kr_rules: ${caution}`, `kr_claude: ${caution}`])];
    expect(krConfirmationCautions(jobs, "kr_rules")).toEqual([caution]);
    expect(krConfirmationCautions(null, "kr_rules")).toEqual([]);
  });
});

describe("결정 로그(F2 — 여섯 게이트·기한 지남·출발·사건 줄·출발 기록)", () => {
  const GATES = [
    { gate: "①", status: "PASS", note: "kr_rules — 기준일 < 2026-11-03인 대기 주문 없음" },
    { gate: "③", status: "FAIL", note: "U 98/100에 2026-11-03 수급 · 20거래일 창에 U 기록이 절반 미만인 날 1(2026-10-15) — 달력이 모르는 휴장일이면 kr.calendar.extraClosures에 더함, 아니면 수집 구멍" },
    { gate: "⑤", status: "FAIL", note: "069500 2026-11-03 봉 없음(휴장 또는 지연)" },
    "모양 틀림",
    { status: "PASS" },
  ];

  it("게이트 줄 — 통과·미달 배지, ③ 창 구멍 문구에 extraClosures 표시, 모양이 틀린 항목은 건너뜀", () => {
    const rows = krGateRows(GATES);
    expect(rows.map((row) => [row.gate, row.badge.label, row.extraClosures])).toEqual([
      ["①", "통과", false], ["③", "미달", true], ["⑤", "미달", false],
    ]);
    expect(krGateRows(null)).toEqual([]);
  });

  it("규칙 계좌 기한 지남 — 기한·판정 근거·판정 시각·기다린 게이트·사유, Claude SKIPPED는 skippedReason, 일시정지 SKIPPED는 근거 없음", () => {
    const rules = krDecisionExtras({
      pastDeadline: true, deadlineKst: "2026-11-04 01:00 KST", noTradeReason: "069500 D 봉 없음(휴장 또는 지연)",
      gates: GATES, waitedFor: ["⑤ 069500 2026-11-03 봉 없음(휴장 또는 지연)"], gatesJudgedAtKst: "2026-11-04 00:50 KST",
      gatesBasis: "기한 전 마지막 판정",
    });
    expect(rules.pastDeadline).toEqual({
      deadline: "2026-11-04 01:00", basis: "기한 전 마지막 판정", judgedAt: "2026-11-04 00:50",
      waitedFor: ["⑤ 069500 2026-11-03 봉 없음(휴장 또는 지연)"], reason: "069500 D 봉 없음(휴장 또는 지연)",
    });
    expect(rules.gates).toHaveLength(3);
    expect(rules.start).toBeNull();
    expect(krDecisionExtras({ pastDeadline: true, deadlineKst: "2026-11-04 01:00 KST", skippedReason: "기한 지남" }).pastDeadline)
      .toEqual({ deadline: "2026-11-04 01:00", basis: null, judgedAt: null, waitedFor: [], reason: "기한 지남" });
    expect(krDecisionExtras({ summary: "일시정지 중" }).pastDeadline).toBeNull();
    expect(krDecisionExtras(null)).toEqual({ gates: [], pastDeadline: null, start: null });
  });

  it("출발 INITIAL — 설정 출발일·미룸·출발 호출 수(Claude), 모르면 —", () => {
    expect(krDecisionExtras({ configuredStartDate: "2026-10-29", postponed: true, startCalls: 2, gates: [] }).start)
      .toEqual({ configuredStartDate: "2026-10-29", postponed: true, startCalls: 2 });
    expect(krDecisionExtras({ postponed: false }).start).toEqual({ configuredStartDate: "—", postponed: false, startCalls: null });
  });

  it("규칙 계좌 상세 — 선정 요약·목표·후보(앞 20)·제외·보유 매도 판정·메모, kr_rules가 아니면 recognized:false", () => {
    const candidates = Array.from({ length: 23 }, (_, i) => ({ code: `0000${String(i).padStart(2, "0")}`, universeRank: i + 1, score: 0.01 }));
    const view = krRuleDecisionView("kr_rules", {
      kind: "REBALANCE", selectionDay: true, cycleDate: "2026-11-02", selectionAsOf: "2026-11-02", catchUp: true,
      selection: { maxNames: 10, weighting: "EQUAL", candidates, exclusionCounts: { "ROE ≤ 0": 4, "자료 없음(DART)": 2 },
        targets: [{ code: "005930", rankInPlan: 1, score: 0.123456, weightPct: 8 }], notChosen: [], stockWeightPct: 80, parkingWeightPct: 20 },
      holdings: [{ code: "000660", qty: 50, weightPct: 10.02, sell: true, reasons: ["20일 누적 순매도", "후보 밖"] }],
      skipped: [{ ticker: "035420", reason: "지금은 체결할 수 없음(거래정지)" }],
      notes: ["035720 매도 주문 — 지금은 체결할 수 없음(D 거래정지)"],
      input: { session: "2026-11-02", readAtKst: "2026-11-02 22:31 KST", universe: { baseDate: "2026-10-30", size: 100 },
        flowsWindow: { from: "2026-10-06", to: "2026-11-02", tradingDays: 20 }, financialSectorTable: "2026-10", suspended: [] },
    });
    expect(view.recognized).toBe(true);
    expect(view.selection.map((cell) => [cell.label, cell.value])).toEqual([
      ["재선정일", "예"], ["재선정 주기 예정일", "2026-11-02"], ["선정 기준일", "2026-11-02"], ["따라잡기", "예(놓친 재선정을 이 결정일에)"],
      ["후보 수", "23종목"], ["매수 종목 수 상한", "10종목"], ["배분", "EQUAL"], ["주식 비중", "80.00%"], ["153130 비중", "20.00%"],
    ]);
    expect(view.targets).toEqual([{ key: "0-005930", code: "005930", rank: "1", score: "0.1235", weight: "8.00%" }]);
    expect(view.candidates).toHaveLength(10);
    expect(view.candidatesMore).toBe(13);
    expect(view.exclusions.map((row) => `${row.reason} ${row.count}`)).toEqual(["ROE ≤ 0 4종목", "자료 없음(DART) 2종목"]);
    expect(view.holdings[0]).toMatchObject({ code: "000660", sell: "매도", reasons: "20일 누적 순매도 · 후보 밖", weight: "10.02%" });
    expect(view.notes).toEqual(["035720 매도 주문 — 지금은 체결할 수 없음(D 거래정지)"]);
    expect(view.input.find((cell) => cell.key === "universe")?.value).toBe("기준일 2026-10-30 · 100종목");
    expect(view.input.find((cell) => cell.key === "suspended")?.value).toBe("없음");

    const plain = krRuleDecisionView("kr_rules", { selectionDay: false, selection: { candidates: [], note: "재선정일이 아님 — 후보·점수는 참고(매수하지 않음)" } });
    expect(plain.selection.map((cell) => cell.label)).toEqual(["재선정일", "후보 수", "매수 종목 수 상한", "배분"]);
    expect(plain.selectionNote).toBe("재선정일이 아님 — 후보·점수는 참고(매수하지 않음)");
    expect(krRuleDecisionView("kr_claude", {}).recognized).toBe(false);
    // 기한 지남 행 — 선정 칸이 없으면 재선정일이었을 때만 그 사실과 안내, 아니면 선정 칸 없음.
    const missed = krRuleDecisionView("kr_rules", { pastDeadline: true, selectionDay: true, cycleDate: "2026-11-02" });
    expect(missed.selection.map((cell) => [cell.label, cell.value])).toEqual([["재선정일", "예"], ["재선정 주기 예정일", "2026-11-02"],
      ["선정 기준일", "—"], ["따라잡기", "아니오"]]);
    expect(missed.selectionNote).toContain("재선정은 다음 KR 결정일에 그날 자료로");
    expect(krRuleDecisionView("kr_rules", { pastDeadline: true, selectionDay: false }).selection).toEqual([]);
    const broken = krRuleDecisionView("kr_rules", "글");
    expect([broken.selection, broken.targets, broken.holdings, broken.notes, broken.input]).toEqual([[], [], [], [], []]);
  });

  it("사건 줄 — 시각이 창 시작보다 앞이면 '창 앞' 표시, 날짜만 주는 피드는 날짜, 패킷이 문자열이어도 읽음, 섹션이 없으면 null", () => {
    const packet = { "11b_events": {
      window: { from: "2026-11-02T22:30:00+09:00", to: "2026-11-03T22:30:00+09:00" }, timeNote: "시각 = 알 수 있는 시각",
      text: "<<사건 #1 시작>> …", items: [
        { k: 1, entity: "a", source: "연합뉴스", knownAtKst: "2026-11-03T09:10:00+09:00", matched: ["code 005930"] },
        { k: 2, entity: "b", source: "한국은행", knownAtKst: "2026-11-02T21:50:00+09:00", matched: ["keyword 기준금리", "keyword 금통위"], matchedMore: 1 },
        { k: 3, entity: "c", source: "재정경제부", publishedDate: "2026-11-03", matched: [] },
      ],
    } };
    const view = krEventsView(packet);
    expect(view?.window).toBe("2026-11-02 22:30 ~ 2026-11-03 22:30");
    expect(view?.rows.map((row) => [row.k, row.when, row.matched, row.beforeWindow])).toEqual([
      ["#1", "2026-11-03 09:10", "code 005930", false],
      ["#2", "2026-11-02 21:50", "keyword 기준금리, keyword 금통위 외 1", true],
      ["#3", "2026-11-03(날짜만)", "—", false],
    ]);
    expect(krEventsView(JSON.stringify(packet))?.rows).toHaveLength(3);
    expect(krEventsView({ "1_basis": {} })).toBeNull();
    expect(krEventsView("{깨짐")).toBeNull();
  });

  const job = (detail: unknown, outcome = "START_WAITING", name = "kr.decision") => ({
    job: name, startedAtKst: "2026-10-29 22:40 KST", finishedAtKst: null, outcome, detail,
  });

  it("출발 기록 — start:true인 kr.decision만, 미룬 날·사유·과금 호출·시도", () => {
    const rows = krStartRecords([
      job({ start: true, tradingDate: "2026-10-29", configuredStartDate: "2026-10-29", postponed: false, postponedTo: "2026-10-30",
        reason: "Claude 출발 호출 실패", calls: { kr_claude: { calls: 2 } }, attempt: 1 }, "START_POSTPONED"),
      job({ tradingDate: "2026-10-29", waiting: "자료 게이트 미달" }, "DATA_NOT_READY"),
      job({ start: true }, "STARTED", "kr.risk"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ at: "2026-10-29 22:40", outcome: "START_POSTPONED" });
    expect(rows[0].parts).toEqual(["세션 2026-10-29", "다음 KR 거래일 2026-10-30로 미룸", "사유 Claude 출발 호출 실패",
      "과금 호출 kr_claude 2회(결정 행 없음 — 사용량에 셈)", "시도 1번째"]);
    expect(krStartRecords(null)).toEqual([]);
  });

  it("마지막 게이트 판정 — rulesGates·claudeGates 각각 가장 최근 기록, 없으면 빈 목록", () => {
    const judged = krLatestJudgedGates([
      job({ tradingDate: "2026-11-03", claudeGates: { judgedAtKst: "2026-11-03 23:10 KST", gates: GATES.slice(0, 1) } }, "DATA_NOT_READY"),
      job({ tradingDate: "2026-11-03", rulesGates: { judgedAtKst: "2026-11-03 23:00 KST", gates: GATES } }, "DATA_NOT_READY"),
      job({ tradingDate: "2026-11-02", rulesGates: { judgedAtKst: "2026-11-02 23:00 KST", gates: [] } }, "DATA_NOT_READY"),
    ]);
    expect(judged.map((entry) => [entry.label, entry.session, entry.judgedAt, entry.rows.length])).toEqual([
      ["규칙 계좌 몫", "2026-11-03", "2026-11-03 23:00", 3],
      ["Claude 계좌 몫", "2026-11-03", "2026-11-03 23:10", 1],
    ]);
    expect(krLatestJudgedGates([job({ start: true })])).toEqual([]);
  });

  it("단추·이름 — 수동 결정은 운용 중 Claude만, 출발(초기 결정) 이름, 가격 칸은 잠정(토스), 문턱 문장은 받은 값 그대로", () => {
    expect(krDecisionRunBlocked({ kind: "RULES", status: "ACTIVE" })).toContain("수동 결정이 없습니다");
    expect(krDecisionRunBlocked({ kind: "CLAUDE", status: "NOT_STARTED" })).toContain("네 계좌가 함께 출발한 뒤");
    expect(krDecisionRunBlocked({ kind: "CLAUDE", status: "PAUSED" })).toContain("재개한 뒤");
    expect(krDecisionRunBlocked({ kind: "CLAUDE", status: "ACTIVE" })).toBeNull();
    expect(krDecisionRunBlocked(null)).toBe("계좌가 없습니다.");
    expect(krDecisionKindLabel("INITIAL")).toBe("출발(초기 결정)");
    expect(krDecisionKindLabel("SCHEDULED")).toBe("정기");
    expect(krPricesFinalText(false).label).toBe("잠정(토스)");
    expect(krPricesFinalText(null).label).toBe("—");
    expect(krManualDecisionNote(13, "22:30 ~ 01:00(다음 날) KST")).toContain("수동 문턱(13회 — 하루 상한 − 정기 몫 예약)");
    expect(krManualDecisionNote(null, "— ~ — KST")).toContain("수동 문턱(— — 하루 상한");
  });
});

describe("종목 선정 탭", () => {
  const row = (id: number, selectionAsOf: string | null): PaperDecisionSummary => ({
    id, book: "kr_rules", asOfTradingDate: "2026-11-02", kind: selectionAsOf ? "REBALANCE" : "SCHEDULED", status: "OK",
    decidedAtKst: null, model: null, frameworkVersion: null, settingsVersion: 4, selectionAsOf, targetExposurePct: null, summary: null,
    orderCount: 0, rejectedCount: 0, pricesFinal: false, error: null,
  });
  const detail = (response: unknown, over: Partial<PaperDecisionDetail> = {}): PaperDecisionDetail => ({
    ...row(40, "2026-11-02"), packet: null, packetHash: null, response, usage: null, noteIds: [], latencyMs: null, retryCount: 0, ...over,
  });

  it("고르기 — 선정한 가장 최근 결정(selectionAsOf)과 목록 첫 줄, 번호 없는 줄은 건너뜀", () => {
    const picks = krSelectionPicks([row(45, null), row(40, "2026-11-02"), row(30, "2026-10-30")]);
    expect([picks.selection?.id, picks.latest?.id]).toEqual([40, 45]);
    expect(krSelectionPicks([{ id: "x" } as unknown as PaperDecisionSummary, row(30, null)])).toMatchObject({ selection: null, latest: { id: 30 } });
    expect(krSelectionPicks(null)).toEqual({ selection: null, latest: null });
  });

  it("모양 틀린 응답은 recognized:false·빈 목록(지어내지 않음), 미국 계좌 결정도 읽지 않음", () => {
    expect(krSelectionView(detail({ selection: {} }))).toMatchObject({ recognized: false, members: [], targets: [], exclusions: [] });
    expect(krSelectionView(detail({ input: { members: [] } }, { book: "rules" })).recognized).toBe(false);
    expect(krSelectionView(null)).toMatchObject({ recognized: false, head: [] });
  });

  it("구성원 — 모르는 값은 '—'(0으로 채우지 않음), 금융업 표·경고·자료 없음 사유, 목표 종목", () => {
    const view = krSelectionView(detail({
      input: {
        members: [
          { rank: 1, code: "005930", name: "삼성전자", marketCap: null, flows: { foreign20: null }, dart: null, score: null, candidate: true, reasons: [] },
          {
            rank: 3, code: "105560", name: "KB금융", marketCap: 30e12, flows: {}, dart: { roePct: 9.5, debtRatioPct: null, financialSector: true },
            score: 0.001, candidate: false, reasons: [{ reason: "자료 없음", sub: "ROE 없음", detail: "" }],
          },
          {
            rank: 9, code: "999999", name: "어느 지주", flows: {}, dart: { financialSector: false }, candidate: false,
            reasons: [{ reason: "자료 없음", sub: "부채비율 없음", detail: "부채비율 없음(…) — '유동자산' 계정 없음: 금융업 코드 표 확인 필요" }],
          },
          { code: null },
        ],
      },
      selection: { targets: [{ code: "005930", rankInPlan: 1, weightPct: 70 }] },
    }));
    expect(view.recognized).toBe(true);
    expect(view.members.map((member) => member.code)).toEqual(["005930", "105560", "999999"]);
    const [first, second, third] = view.members;
    expect(first.text).toMatchObject({ marketCap: "—", foreign20: "—", roe: "—", financial: "—", score: "—", candidate: "매수 목표", reasons: "—" });
    expect(second.text).toMatchObject({ marketCap: "30.000조 원", roe: "9.5%", debtRatio: "—", financial: "금융업 표", candidate: "제외" });
    expect(third.financialCheck).toBe(true);
    expect(view.financialChecks.map((note) => note.label)).toEqual(["999999 어느 지주"]);
    expect(view.noData.map((note) => `${note.label} — ${note.detail}`)).toEqual([
      "105560 KB금융 — ROE 없음",
      "999999 어느 지주 — 부채비율 없음(…) — '유동자산' 계정 없음: 금융업 코드 표 확인 필요",
    ]);
    expect(view.targets).toEqual([{ key: "0-005930", rank: "1", code: "005930", name: "삼성전자", score: "—", weight: "70.00%" }]);
  });

  it("참고 한 줄 — 후보(이름과 함께, 10종목까지), 선정 칸 없는 결정은 그 사실과 요약, 결정이 없으면 null", () => {
    const candidates = Array.from({ length: 12 }, (_, index) => ({ code: String(100000 + index) }));
    expect(krSelectionReference(detail({
      selection: { candidates }, input: { members: [{ code: "100000", name: "가나" }] },
    }, { id: 45, asOfTradingDate: "2026-11-04" }))).toBe(
      "참고 — 매수하지 않음: 가장 최근 결정 2026-11-04(#45)의 후보 12종목(점수 순, 매일 셈 — 재선정일·출발 때만 삼) — "
        + "100000 가나, 100001, 100002, 100003, 100004, 100005, 100006, 100007, 100008, 100009 외 2",
    );
    expect(krSelectionReference(detail({ pastDeadline: true }, { id: 41, summary: "기한 지남" }))).toBe(
      "가장 최근 결정 2026-11-02(#41)은 선정 칸이 없습니다(기한 지남·일시정지 등) — 기한 지남",
    );
    expect(krSelectionReference(null)).toBeNull();
  });
});
