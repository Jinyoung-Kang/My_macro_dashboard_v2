/**
 * 모의매매(한국) 표기(lib/paperKr) — 출발 상태 넷·결정 창·초기화/출발/리스크 결과·출발 작업 기록 줄.
 *
 *  - 출발 상태: 출발한 계좌가 있으면 started(출발일 설정과 상관없이), 출발일 없음 dormant, 계좌 없음 init, 네 계좌 시작 전 waiting
 *  - 결정 창은 설정 값(모르면 "—" — 22:30을 짓지 않음), 기한이 이르면 "(다음 날)"
 *  - 출발 결과 넷: STARTED·ALREADY_STARTED는 정보, START_POSTPONED·ERROR는 경고, 서버 문구 그대로 + 기록의 아는 칸(미룸·과금 호출)
 *  - 리스크 점검: 쉬면 그 사유를 경고로(미국 문구 대신)
 */
import { describe, expect, it } from "vitest";

import {
  chargedCalls,
  jobsEmptyMessage,
  krCollectionRows,
  krDecisionWindowText,
  krJobDetailText,
  krInitResultText,
  krRiskResultView,
  krStartRecordLine,
  krStartRecordParts,
  krStartResultView,
  krStartState,
  latestStartRecord,
  marketJobs,
} from "../paperKr";
import type { PaperBookSummary } from "../types";

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
