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
  krDecisionWindowText,
  krInitResultText,
  krRiskResultView,
  krStartRecordLine,
  krStartRecordParts,
  krStartResultView,
  krStartState,
  latestStartRecord,
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
