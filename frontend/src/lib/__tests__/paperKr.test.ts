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
import type { PaperBookSummary, PaperJobRun, PaperPosition } from "../types";

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
