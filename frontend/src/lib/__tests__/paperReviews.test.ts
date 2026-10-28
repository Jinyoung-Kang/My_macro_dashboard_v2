/**
 * 🧪 모의 매매 — 주간 복기 표기(2단계 명세 §3 D1~D6). 숫자·판정 수는 서버 값 그대로, 모르는 값은 "—"(0으로 채우지 않음).
 */
import { describe, expect, it } from "vitest";
import {
  latestReviewNote,
  proposalFocusView,
  proposalView,
  resolveReviewWeek,
  REVIEW_COST_NOTE,
  REVIEW_SCHEDULE_NOTE,
  reviewDetailView,
  reviewProposalText,
  reviewRowSignature,
  reviewRows,
  reviewRunResultView,
  reviewStatusBadge,
  reviewWindowText,
  shouldReloadReviewDetail,
  thesisHeldBadge,
  verdictCountsText,
} from "../paper";
import {
  KR_REVIEW_SCHEDULE_NOTE,
  krLatestWeekReasonText,
  krManualReviewNote,
  krReviewComparison,
  krReviewInputRows,
} from "../paperKr";
import type { PaperFrameworkProposal, PaperReviewDetail, PaperReviewSummary } from "../types";

function summary(over: Partial<PaperReviewSummary> = {}): PaperReviewSummary {
  return {
    weekEnding: "2026-10-30", status: "OK", windowWeeks: 4, model: "claude-sonnet-5-5",
    verdictCounts: { 유지: 2, 반증: 1, 판단불가: 0 }, proposalId: 12, proposalStatus: "PENDING",
    createdAtKst: "2026-10-31 09:05", error: null, retryCount: 0, retryable: false, frameworkVersion: 1, ...over,
  };
}

function detail(over: Partial<PaperReviewDetail> = {}): PaperReviewDetail {
  return {
    weekEnding: "2026-10-30", status: "OK", windowWeeks: 4, trimmedReason: null, model: "claude-sonnet-5-5",
    frameworkVersion: 1, retryCount: 0, retryable: false, createdAtKst: "2026-10-31 09:05", error: null,
    verdictCounts: { 유지: 1, 반증: 1, 판단불가: 0 },
    verdicts: [
      { decisionId: 7, asOf: "2026-10-26", kind: "SCHEDULED", status: "OK", thesisHeld: "유지", note: "체결 뒤 +10%" },
      { decisionId: 99, asOf: null, kind: null, status: null, thesisHeld: "반증", note: "무효화 충족" },
    ],
    missingDecisionIds: [8],
    recurringErrors: ["월 상한 근처 진입"], keep: ["200일선 위 종목 우선"],
    proposal: { id: 12, status: "PENDING", summary: "진입 자제 규칙", operationsCount: 1, baseVersion: 1, resultVersion: null, error: null },
    input: { weekEnding: "2026-10-30" }, response: { schemaVersion: 1 },
    usage: { inputTokens: 9000, inputTokensEst: 6100, outputTokens: 1200, estCostUsd: 0.0312, latencyMs: 41_000 },
    ...over,
  };
}

describe("주간 복기 목록", () => {
  it("상태·창·판정 수·제안을 서버 값 그대로 — 형식을 지나지 않은 행의 판정 수는 —(0 아님)", () => {
    const rows = reviewRows([
      summary(),
      summary({ weekEnding: "2026-10-23", status: "FORMAT_ERROR", verdictCounts: null, proposalId: null, proposalStatus: null,
        windowWeeks: 2, error: "응답 형식 오류 — 위반 1건" }),
      summary({ weekEnding: "2026-10-16", status: "API_ERROR", verdictCounts: null, proposalId: null, proposalStatus: null,
        retryable: true, error: "[HTTP] 500", createdAtKst: null }),
    ]);
    expect(rows.map((row) => [row.weekEnding, row.status.label, row.window, row.counts, row.proposal])).toEqual([
      ["2026-10-30", "복기 완료", "4주", "유지 2 · 반증 1 · 판단불가 0", "제안 #12 · 승인 대기"],
      ["2026-10-23", "응답 형식 오류", "2주(입력이 커서 줄임)", "—", "—"],
      ["2026-10-16", "API 오류", "4주", "—", "—"],
    ]);
    expect(rows[1].note).toBe("응답 형식 오류 — 위반 1건");
    expect(rows[2].note).toContain("한 번 더 부릅니다");
    expect(rows[2].createdAt).toBe("—");
  });

  it("배지·문구 — 모르는 상태·판정은 받은 글자 그대로, 값이 없으면 —", () => {
    expect(reviewStatusBadge("SKIPPED").label).toBe("건너뜀 · 결정 없음");
    expect(reviewStatusBadge("NEW_STATE").label).toBe("NEW_STATE");
    expect(reviewStatusBadge(null).label).toBe("—");
    expect(thesisHeldBadge("반증").className).toContain("text-warn");
    expect(thesisHeldBadge("모름").label).toBe("모름");
    expect(verdictCountsText(null)).toBe("—");
    expect(verdictCountsText({ 유지: null, 반증: 2, 판단불가: 0 })).toBe("유지 — · 반증 2 · 판단불가 0");
    expect(reviewWindowText(null)).toBe("—");
    expect(reviewProposalText(null, "PENDING")).toBe("—");
    expect(reviewProposalText(4, null)).toBe("제안 #4");
  });

  it("펼칠 주 — 고른 주가 목록에 있으면 그것, 아니면 가장 최근 주, 비면 null", () => {
    const list = [summary(), summary({ weekEnding: "2026-10-23" })];
    expect(resolveReviewWeek("2026-10-23", list)).toBe("2026-10-23");
    expect(resolveReviewWeek("2026-01-02", list)).toBe("2026-10-30");
    expect(resolveReviewWeek(null, [])).toBeNull();
  });

  it("펼친 상세를 다시 읽을지 — 같은 주의 행(상태·시각·재시도·제안)이 바뀔 때만, 주가 바뀌거나 처음 볼 때는 아님", () => {
    const failed = summary({ status: "API_ERROR", verdictCounts: null, proposalId: null, proposalStatus: null,
      retryable: true, error: "[HTTP] 500", createdAtKst: "2026-10-31 09:05" });
    const retried = summary({ retryCount: 1, createdAtKst: "2026-10-31 09:35" });
    const before = { week: "2026-10-30", signature: reviewRowSignature([failed], "2026-10-30") };
    const after = { week: "2026-10-30", signature: reviewRowSignature([retried], "2026-10-30") };
    expect(before.signature).not.toBeNull();
    expect(after.signature).not.toEqual(before.signature);
    expect(shouldReloadReviewDetail(before, after)).toBe(true);
    expect(shouldReloadReviewDetail(after, { ...after })).toBe(false);
    // 제안을 승인하면 행의 제안 상태가 바뀜
    const approved = { week: "2026-10-30", signature: reviewRowSignature([summary({ ...retried, proposalStatus: "APPROVED" })], "2026-10-30") };
    expect(shouldReloadReviewDetail(after, approved)).toBe(true);
    // 처음 보는 주·다른 주로 옮김·목록에 없는 주는 다시 읽지 않음(경로가 바뀌어 useApi가 이미 읽음)
    expect(shouldReloadReviewDetail(null, after)).toBe(false);
    expect(shouldReloadReviewDetail({ week: null, signature: null }, after)).toBe(false);
    expect(shouldReloadReviewDetail(after, { week: "2026-10-23", signature: "SKIPPED||0||" })).toBe(false);
    expect(reviewRowSignature([retried], "2026-01-02")).toBeNull();
    expect(reviewRowSignature([retried], null)).toBeNull();
  });

  it("가장 최근 주 한 줄 — 행이 없음·끝난 행(부르지 않음)·다시 부를 API 오류", () => {
    expect(latestReviewNote("2026-11-06", "2026-11-07 09:00", [summary()])).toBe(
      "가장 최근 복기 주 2026-11-06 · 정기 복기 2026-11-07 09:00 — 아직 복기 없음.");
    expect(latestReviewNote("2026-10-30", "2026-10-31 09:00", [summary()])).toContain("이미 남김(복기 완료)");
    expect(latestReviewNote("2026-10-30", null, [summary({ status: "API_ERROR", retryable: true })]))
      .toContain("한 번 더 부를 수 있습니다");
    expect(latestReviewNote(null, null, [])).toBeNull();
  });

  it("수동 실행 확인 문구는 비용과 하루 상한을 함께 적는다", () => {
    expect(REVIEW_COST_NOTE).toContain("Sonnet 5.5 호출 1회(약 $0.1), 하루 호출 상한에 포함");
  });
});

describe("주간 복기 한 건", () => {
  it("판정 표에 결정 번호·기준 거래일(서버가 붙인 값)·종류, 없는 값은 —, 판정 없는 결정·반복 오류·지킬 것·제안", () => {
    const view = reviewDetailView(detail());
    expect(view.title).toBe("2026-10-30 주 복기");
    expect(view.counts).toBe("유지 1 · 반증 1 · 판단불가 0");
    expect(view.verdicts.map((row) => [row.decision, row.asOf, row.kind, row.thesisHeld.label, row.note])).toEqual([
      ["#7", "2026-10-26", "정기", "유지", "체결 뒤 +10%"],
      ["#99", "—", "—", "반증", "무효화 충족"],
    ]);
    expect(view.missing).toBe("판정 없음: #8");
    expect(view.recurringErrors).toEqual(["월 상한 근처 진입"]);
    expect(view.keep).toEqual(["200일선 위 종목 우선"]);
    expect(view.proposal).toEqual({ id: 12, label: "제안 #12 · 승인 대기", summary: "진입 자제 규칙",
      detail: "변경 1건 · 기준 판 v1" });
    expect(view.noProposal).toBe(false);
    expect(view.usage.map((cell) => [cell.label, cell.value])).toEqual([
      ["입력 토큰", "9,000"], ["입력 어림", "6,100"], ["출력 토큰", "1,200"], ["추정 비용", "$0.03"], ["소요", "41.0초"],
    ]);
    expect(view.meta.find((cell) => cell.key === "framework")?.value).toBe("v1");
    expect(view.notices).toEqual([]);
    expect(view.input).toContain("\"weekEnding\": \"2026-10-30\"");
  });

  it("상태 안내 — 건너뜀(서버 문구 그대로)·다시 부를 API 오류·줄인 창·형식 오류는 그 주의 끝, OK인데 제안이 없으면 '제안 없음'", () => {
    const skipped = reviewDetailView(detail({ status: "SKIPPED", error: "창 안에 복기할 Claude 결정이 없어", verdicts: [],
      verdictCounts: null, proposal: null, usage: null, missingDecisionIds: [] }));
    expect(skipped.notices).toEqual(["창 안에 복기할 Claude 결정이 없어"]);
    expect(skipped.counts).toBe("—");
    expect(skipped.noProposal).toBe(false);
    expect(skipped.usage).toEqual([]);

    const retry = reviewDetailView(detail({ status: "API_ERROR", error: "[NO_KEY] 키 없음", retryable: true, proposal: null }));
    expect(retry.notices).toEqual(["오류 — [NO_KEY] 키 없음", expect.stringContaining("한 번 더 부릅니다")]);

    const trimmed = reviewDetailView(detail({ windowWeeks: 2, trimmedReason: "4주 입력 어림 31000토큰 > 25000", proposal: null }));
    expect(trimmed.notices).toEqual(["입력을 줄였습니다 — 4주 입력 어림 31000토큰 > 25000"]);
    expect(trimmed.meta.find((cell) => cell.key === "window")?.value).toBe("2주(입력이 커서 줄임)");
    expect(trimmed.noProposal).toBe(true);

    const format = reviewDetailView(detail({ status: "FORMAT_ERROR", error: "위반 2건", retryCount: 1 }));
    expect(format.notices[1]).toContain("이것으로 끝");
    expect(format.meta.find((cell) => cell.key === "retry")?.value).toBe("1회");
  });

  it("수동 실행 결과 — 이미 있던 행은 부르지 않았다고, 건너뜀·남김·실패", () => {
    const review = detail();
    expect(reviewRunResultView({ ok: true, outcome: "ALREADY_REVIEWED", review }).text)
      .toBe("2026-10-30 주 복기가 이미 있습니다(복기 완료) — Claude를 부르지 않았습니다.");
    expect(reviewRunResultView({ ok: true, outcome: "SKIPPED", review: { ...review, status: "SKIPPED" } }).text)
      .toContain("건너뜀");
    expect(reviewRunResultView({ ok: true, outcome: "REVIEWED", review })).toEqual({
      tone: "info", text: "2026-10-30 주 복기를 남겼습니다 — 복기 완료." });
    expect(reviewRunResultView({ ok: true, outcome: "REVIEWED", review: { ...review, status: "API_ERROR" } }).tone).toBe("warn");
    expect(reviewRunResultView({ ok: false, message: "테이블 없음" })).toEqual({ tone: "warn", text: "테이블 없음" });
  });
});

describe("프레임 탭의 복기 제안", () => {
  const proposal: PaperFrameworkProposal = {
    id: 12, status: "PENDING", noteId: null, model: "claude-sonnet-5-5", summary: "진입 자제 규칙", operations: [],
    assessment: [], beforeAfter: null, error: null, createdAtKst: "2026-10-31 09:05", decidedAtKst: null, resultVersion: null,
    baseVersion: 1, reviewWeekEnding: "2026-10-30",
  };

  it("찾을 제안이 목록에 있으면 강조, 없으면 그렇다고(최근 50건)", () => {
    expect(proposalFocusView([proposal], 12)).toEqual({ found: true, note: null });
    expect(proposalFocusView([proposal], 3).note).toContain("제안 #3가 최근 제안 목록(50건)에 없습니다");
    expect(proposalFocusView([proposal], null)).toEqual({ found: false, note: null });
  });

  it("복기가 낸 제안은 근거에 '주간 복기 <주>'를 적는다(메모 번호 없음)", () => {
    const view = proposalView(proposal, null);
    expect(view.meta.find((cell) => cell.key === "review")?.value).toBe("주간 복기 2026-10-30");
    expect(view.meta.find((cell) => cell.key === "noteId")).toBeUndefined();
  });
});

describe("한국 복기(F2 — 일정·가정 진입 출처·근사·잠정 배지)", () => {
  it("일정 문구 — 미국은 그대로(토요일 09:00), 한국은 토요일 22:30·잠정 종가 순자산 줄·다음 기동 첫 주기", () => {
    expect(REVIEW_SCHEDULE_NOTE.startsWith("매주 토요일 09:00(KST) 뒤 그 주 마지막 거래일(금요일, 휴장이면 목요일)의 확정 종가가 들어오면")).toBe(true);
    expect(KR_REVIEW_SCHEDULE_NOTE).toContain("토요일 22:30 KST — 그 주 마지막 KR 거래일(금요일, 휴장이면 목요일)의 잠정 종가 순자산 줄로 열리고, 놓치면 다음 기동 첫 주기");
    expect(krManualReviewNote(13)).toContain("수동 문턱(13회");
    expect(krManualReviewNote(undefined)).toContain("수동 문턱(— —");
    expect(krLatestWeekReasonText(null, "달력 없음 — 2027년")).toBe("가장 최근 복기 주 — — 달력 없음 — 2027년");
    expect(krLatestWeekReasonText("2026-11-06", "달력 없음")).toBeNull();
    expect(krLatestWeekReasonText(null, null)).toBeNull();
  });

  const INPUT = {
    decisions: [
      { id: 1, asOf: "2026-11-02", orders: [
        { id: 2, ticker: "005930", side: "BUY", status: "FILLED", fill: { date: "2026-11-03", price: 50_000 } },
        { id: 4, ticker: "000660", side: "BUY", status: "REJECTED", rejectReason: "UNFILLABLE",
          hypothetical: { basis: "가정", entryDate: "2026-11-03", entryPrice: 180_000, entrySource: "FSC", isProxy: false, returnPct: 10 } },
        { id: 5, ticker: "207940", side: "BUY", status: "REJECTED", rejectReason: "MONTHLY_CAP",
          hypothetical: { basis: "가정", entryDate: "2026-11-03", entryPrice: 1_000_000, entrySource: null, isProxy: true, returnPct: 5 } },
      ] },
      { id: 6, asOf: "2026-11-05", orders: [
        { id: 7, ticker: "035720", side: "BUY", status: "REJECTED", rejectReason: "MONTHLY_CAP",
          hypothetical: { entryDate: "2026-11-06", entryPrice: 40_000, entrySource: "TOSS_1M_OPEN", isProxy: false, returnPct: null } },
      ] },
    ],
    comparison: { from: "2026-10-30", to: "2026-11-06", note: "순자산 수익률(%)", books: [
      { book: "kr_rules", returnPct: 0.5, isEstimated: true }, { book: "kr_bench_k200", returnPct: 2, isEstimated: false },
    ] },
  };

  it("가정 진입 줄 — 거절 주문의 hypothetical만, 진입가 원·수익률, 출처 배지(금융위 확정·토스 잠정)·종가 근사, 모르는 값은 —", () => {
    const rows = krReviewInputRows(INPUT);
    expect(rows.map((row) => [row.decision, row.ticker, row.rejectReason, row.entryPrice, row.returnPct, row.badges.map((b) => b.label)]))
      .toEqual([
        ["#1 (2026-11-02)", "000660", "지금 체결할 수 없는 종목 매수 (UNFILLABLE)", "180,000원", "+10.00%", ["금융위 확정 시가"]],
        ["#1 (2026-11-02)", "207940", "월 주문 상한 (MONTHLY_CAP)", "1,000,000원", "+5.00%", ["종가 근사"]],
        ["#6 (2026-11-05)", "035720", "월 주문 상한 (MONTHLY_CAP)", "40,000원", "—", ["토스 잠정 시가"]],
      ]);
    expect(krReviewInputRows(null)).toEqual([]);
    expect(krReviewInputRows({ decisions: "글" })).toEqual([]);
    expect(krReviewInputRows({ decisions: [{ id: 1, orders: [{ hypothetical: "글" }] }] })).toEqual([]);
  });

  it("계좌 수익률 비교 — 구간·계좌별 수익률과 '잠정 줄 포함', 없으면 null", () => {
    const view = krReviewComparison(INPUT);
    expect(view?.range).toBe("2026-10-30 → 2026-11-06");
    expect(view?.rows.map((row) => [row.book, row.returnPct, row.badges.map((b) => b.label)])).toEqual([
      ["kr_rules", "+0.50%", ["잠정 줄 포함"]], ["kr_bench_k200", "+2.00%", []],
    ]);
    expect(krReviewComparison({ decisions: [] })).toBeNull();
    expect(krReviewComparison("글")).toBeNull();
  });
});
