/**
 * 🧪 미국 Claude 계좌2(체결 시점 실험 — 계좌2 명세 §13-3, ADR 0022)의 표기. 계좌1 동작은 그대로, 계좌2만 따로.
 *
 *  - 시점 이름표: 시가·10:00…15:00 ET·종가, 사다리 칸 이름, 대체 체결 배지(그 밖의 체결은 예전 배지 그대로)
 *  - 기본 Claude 계좌(시작 카드·홈 히어로)는 계좌1 — 계좌2가 목록에 있어도, 계좌1이 운용 중이어도 계좌2를 고르지 않는다
 *  - 시작 전·결정 안내는 계좌 소개에서(kind CLAUDE면 모두 계좌1 문구였던 것), 계좌1 시작 단추 이름은 서버 이름 + " 시작"
 *  - 계좌2 출발 카드: 시작 전일 때만, 설정 claude2.enabled로 단추가 열림(꺼짐·모름은 닫힘), 창 시각·이번 주기 호출은 상태 응답 글자 그대로
 *    (다음 결정 시각이 이미 지났으면 '결정 창 열림(…부터 컷오프 …까지)', 컷오프도 지났으면 이번 창 닫힘)
 *  - 체결 시점 실험: 문턱 미달이면 '—'와 '판단 보류'(0으로 채우지 않음), 값이 있어도 판정 문장을 만들지 않음, 시가는 대리값,
 *    고른 시점(M1 — 주 판정) 두 줄(본 줄·대체 체결 따로)은 계좌2만 — 계좌1(서버 null)이면 없음
 *  - 노출 추이: 계좌2 순자산 기록이 오면 셋째 선(날짜 합집합, 없는 날은 그 선만 null), 안 오면 두 선 그대로
 *  - 결정 상세: 계좌2만 '계좌1과 같은 입력'·섹션 해시 칸, 지난 시각 거절 사유, 1분봉 기다림 메모
 */
import { describe, expect, it } from "vitest";
import {
  CLAUDE2_EXPOSURE_KEY,
  CLAUDE2_LIMITS,
  claude2BarsLine,
  claude2StartResultView,
  EXECUTION_CHOSEN_FALLBACK_LABEL,
  EXECUTION_CHOSEN_LABEL,
  EXECUTION_VERDICT_RULE,
  claude2StartView,
  claude2WindowLines,
  claudeDecisionView,
  claudeExposureChart,
  claudeStartPrompt,
  decisionBookNote,
  decisionMeta,
  decisionRunBlocked,
  executionAdvantageText,
  executionByOrder,
  executionSummaryView,
  fillBadges,
  fillRungText,
  isTimedBook,
  notStartedNote,
  orderExecutionNote,
  primaryClaudeBook,
  rejectReasonText,
  riskResultView,
  settingGroups,
  timingLabel,
  withParticle,
} from "../paper";
import type { PaperBookSummary, PaperDecisionDetail, PaperExecutionResponse, PaperStatusResponse } from "../types";

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };

function book(code: string, over: Partial<PaperBookSummary> = {}): PaperBookSummary {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000, cash: 100, nav: 100000,
    equityValue: 99900, exposurePct: 99.9, returnPct: 0, lastObservedAtKst: "2026-10-27 05:20", positions: 1, staleCount: 0,
    stats: STATS, benchmark: "bench_spy", ...over,
  };
}

const CLAUDE1 = book("claude", { kind: "CLAUDE", label: "Claude 계좌1" });
const CLAUDE2 = book("claude2", { kind: "CLAUDE", label: "Claude 계좌2", status: "NOT_STARTED", startedOn: null, positions: 0 });
const BOOKS = [book("rules", { kind: "RULES", label: "규칙 계좌" }), CLAUDE1, CLAUDE2, book("bench_spy", { benchmark: null }), book("bench_mix")];

const STATUS: Pick<PaperStatusResponse, "claude2"> = {
  claude2: {
    book: "claude2", status: "NOT_STARTED", startedOn: null, enabled: true,
    nextDecision: {
      tradingDate: "2026-10-30", atKst: "2026-10-31 07:30 KST", atEt: "2026-10-30 18:30 ET",
      cutoffKst: "2026-11-02 23:00 KST", cutoffEt: "2026-11-02 09:00 ET",
    },
    cycle: { tradingDate: "2026-10-29", calls: 1, cap: 2 },
    bars: null,
  },
};

describe("시점 이름표·사다리·배지", () => {
  it("시가·매시·종가 — 한국·계좌1 이름표는 그대로, 모르는 시점은 받은 글자", () => {
    expect(timingLabel("NEXT_OPEN")).toBe("다음 거래일 시가");
    expect(["AT_1000", "AT_1100", "AT_1200", "AT_1300", "AT_1400", "AT_1500"].map(timingLabel)).toEqual([
      "다음 거래일 10:00 ET", "다음 거래일 11:00 ET", "다음 거래일 12:00 ET",
      "다음 거래일 13:00 ET", "다음 거래일 14:00 ET", "다음 거래일 15:00 ET",
    ]);
    expect(timingLabel("NEXT_CLOSE")).toBe("다음 종가");
    expect(timingLabel("NEXT_OBSERVATION")).toBe("다음 관측치");
    expect(timingLabel("MARKET")).toBe("MARKET");
  });

  it("사다리 칸 — R1·R2·대체 셋, 칸 없는 체결(스탑)은 '—'", () => {
    expect(fillRungText("Y1M_AT")).toBe("R1 · 그 시각 1분봉 시가");
    expect(fillRungText("Y1M_NEXT")).toBe("R2 · 4분 안 첫 거래 봉 시가");
    expect(fillRungText("Y1M_LATE")).toContain("R2b");
    expect(fillRungText("QUOTES_FALLBACK")).toContain("R3");
    expect(fillRungText("QUOTES_CLOSE")).toBe("확정 종가");
    expect(fillRungText(null)).toBe("—");
  });

  it("대체 체결 배지는 fallback이 참일 때만 — 계좌1·벤치마크 체결(칸 없음)은 예전 배지 그대로", () => {
    expect(fillBadges({ backfill: false })).toEqual([]);
    expect(fillBadges({ backfill: true }).map((badge) => badge.key)).toEqual(["backfill"]);
    expect(fillBadges({ backfill: false, fallback: false, fillRung: "Y1M_AT" })).toEqual([]);
    const fallback = fillBadges({ backfill: false, fallback: true, fillRung: "QUOTES_FALLBACK" });
    expect(fallback.map((badge) => badge.label)).toEqual(["대체 체결"]);
    expect(fallback[0].title).toContain("R3 · 관측 종가(1분봉 없음)");
  });

  it("숫자로 끝나는 계좌 이름의 조사 — 끝 숫자를 읽은 소리로", () => {
    expect(withParticle("Claude 계좌1", "은")).toBe("Claude 계좌1은");
    expect(withParticle("Claude 계좌2", "은")).toBe("Claude 계좌2는");
    expect(withParticle("Claude 계좌2", "이")).toBe("Claude 계좌2가");
    expect(withParticle("Claude 계좌1", "을")).toBe("Claude 계좌1을");
    expect(withParticle("계좌 10", "을")).toBe("계좌 10을");
  });
});

describe("기본 Claude 계좌는 계좌1", () => {
  it("시각 지정 체결 계좌는 계좌2뿐, 기본 Claude 계좌는 계좌2가 앞에 있어도 계좌1(한국은 kr_claude)", () => {
    expect(BOOKS.filter((entry) => isTimedBook(entry.code)).map((entry) => entry.code)).toEqual(["claude2"]);
    expect(primaryClaudeBook([CLAUDE2, CLAUDE1])?.code).toBe("claude");
    expect(primaryClaudeBook([CLAUDE2])).toBeNull();
    expect(primaryClaudeBook([book("kr_claude", { kind: "CLAUDE" })])?.code).toBe("kr_claude");
  });

  it("계좌1 시작 카드는 계좌1이 운용 중이면 없음 — 시작 전인 계좌2로 옮겨 가지 않는다(계좌2는 따로 출발)", () => {
    expect(claudeStartPrompt({ initialized: true, startDate: "2026-10-23", books: BOOKS })).toBeNull();
    const fresh = claudeStartPrompt({
      initialized: true, startDate: "2026-10-23",
      books: [CLAUDE2, { ...CLAUDE1, status: "NOT_STARTED", startedOn: null }],
    });
    expect(fresh?.bookCode).toBe("claude");
    expect(fresh?.title).toBe("Claude 계좌1 시작");
  });

  it("시작 전·결정 안내는 계좌 소개에서 — 계좌2는 앞으로 체결 출발, 계좌1은 서버 이름의 시작 단추", () => {
    expect(notStartedNote("CLAUDE", CLAUDE2)).toContain("앞으로 체결로 출발");
    expect(notStartedNote("CLAUDE", CLAUDE2)).not.toContain("출발일 종가에 사후 체결");
    expect(notStartedNote("CLAUDE", { code: "claude", label: "Claude 계좌1" })).toContain("시작 전인 Claude 계좌1은 개요 탭의 'Claude 계좌1 시작'");
    expect(decisionBookNote("CLAUDE", "claude2")).toContain("개장 전 컷오프");
    expect(decisionBookNote("CLAUDE", "claude")).toContain("KST 07:30 이후");
    expect(decisionRunBlocked(CLAUDE2)).toContain("'계좌2 시작'");
    expect(decisionRunBlocked({ ...CLAUDE1, status: "NOT_STARTED" })).toContain("'Claude 계좌1 시작'");
  });
});

describe("계좌2 출발 카드", () => {
  it("시작 전일 때만 — 설정이 켜져 있으면 단추가 열리고, 창 시각·이번 주기 호출은 상태 응답 그대로", () => {
    const view = claude2StartView({ initialized: true, books: BOOKS }, STATUS);
    expect(view?.bookCode).toBe("claude2");
    expect(view?.title).toBe("계좌2 시작");
    expect(view?.armed).toBe(true);
    expect(view?.body).toContain("앞으로 체결");
    expect(view?.body).toContain("미리보기는 없습니다");
    expect(view?.lines).toEqual([
      { key: "nextDecision", label: "다음 결정(기준 거래일 2026-10-30)", value: "2026-10-31 07:30 KST · 2026-10-30 18:30 ET" },
      { key: "cutoff", label: "개장 전 컷오프", value: "2026-11-02 23:00 KST · 2026-11-02 09:00 ET" },
      { key: "cycle", label: "이번 결정 주기 호출(2026-10-29)", value: "1회 / 상한 2회" },
    ]);
    expect(claude2StartView({ initialized: true, books: [CLAUDE1, { ...CLAUDE2, status: "ACTIVE", startedOn: "2026-11-02" }] }, STATUS))
      .toBeNull();
    expect(claude2StartView({ initialized: false, books: BOOKS }, STATUS)).toBeNull();
    expect(claude2StartView({ initialized: true, books: [CLAUDE1] }, STATUS)).toBeNull();
  });

  it("다음 결정 시각이 지났으면 '결정 창 열림(…부터 컷오프 …까지)', 컷오프도 지났으면 이번 창 닫힘 — 지금을 모르면 받은 시각 그대로", () => {
    // 서버는 d의 계좌2 행이 아직 없으면 d의 결정 시각을 보내고 그 창은 개장 전 컷오프까지 열림(PaperQueryService.claude2Status).
    const group = {
      ...STATUS.claude2!,
      nextDecision: {
        tradingDate: "2026-10-29", atKst: "2026-10-30 07:30 KST", atEt: "2026-10-29 18:30 ET",
        cutoffKst: "2026-10-30 22:00 KST", cutoffEt: "2026-10-30 09:00 ET",
      },
    };
    const value = (now: Date | null) => claude2WindowLines(group, now)[0].value;
    expect(value(null)).toBe("2026-10-30 07:30 KST · 2026-10-29 18:30 ET");
    expect(value(new Date("2026-10-29T22:29:00Z"))).toBe("2026-10-30 07:30 KST · 2026-10-29 18:30 ET");   // 07:29 KST — 아직
    expect(value(new Date("2026-10-29T22:30:00Z"))).toBe("결정 창 열림(07:30부터 컷오프 22:00 KST까지)");   // 07:30 KST 정각
    expect(value(new Date("2026-10-30T08:43:00Z"))).toBe("결정 창 열림(07:30부터 컷오프 22:00 KST까지)");   // 17:43 KST
    expect(value(new Date("2026-10-30T13:00:00Z"))).toBe("이번 창 닫힘(컷오프 22:00 KST 지남) — 다음 결정은 다음 미국 세션 마감 뒤 창");
    // 주말을 건너는 창(금요일 세션 — 토 07:30부터 월 09:00 ET = 23:00 KST 컷오프)은 날짜까지.
    const weekend = {
      ...group,
      nextDecision: {
        tradingDate: "2026-10-30", atKst: "2026-10-31 07:30 KST", atEt: "2026-10-30 18:30 ET",
        cutoffKst: "2026-11-02 23:00 KST", cutoffEt: "2026-11-02 09:00 ET",
      },
    };
    expect(claude2WindowLines(weekend, new Date("2026-11-01T03:00:00Z"))[0].value)
      .toBe("결정 창 열림(2026-10-31 07:30부터 컷오프 2026-11-02 23:00 KST까지)");
    // 컷오프·이번 주기 호출 줄은 지금과 상관없이 받은 글자 그대로, 출발 카드도 같은 줄.
    expect(claude2WindowLines(group, new Date("2026-10-30T08:43:00Z")).slice(1)).toEqual(claude2WindowLines(group, null).slice(1));
    expect(claude2StartView({ initialized: true, books: BOOKS }, { claude2: group }, new Date("2026-10-30T08:43:00Z"))?.lines)
      .toEqual(claude2WindowLines(group, new Date("2026-10-30T08:43:00Z")));
    expect(claude2WindowLines(null, new Date("2026-10-30T08:43:00Z")).map((line) => line.value)).toEqual(["—", "—", "—"]);
  });

  it("설정이 꺼져 있으면 단추를 닫고 설정을 켜라고, 상태를 못 읽으면 모른다고 — 창 칸은 '—'", () => {
    const off = claude2StartView({ initialized: true, books: BOOKS }, { claude2: { ...STATUS.claude2!, enabled: false } });
    expect(off?.armed).toBe(false);
    expect(off?.armNote).toContain("claude2.enabled가 꺼져 있습니다");
    const unknown = claude2StartView({ initialized: true, books: BOOKS }, null);
    expect(unknown?.armed).toBeNull();
    expect(unknown?.lines.map((line) => line.value)).toEqual(["—", "—", "—"]);
  });

  it("켜져 있어도 관측치 사슬 준비 중(상태 chainReady false)이면 단추를 닫고 까닭을 — 칸이 없는 백엔드면 닫지 않음, 확인 문구에 거절 사유", () => {
    const waiting = claude2StartView({ initialized: true, books: BOOKS }, { claude2: { ...STATUS.claude2!, chainReady: false } });
    expect(waiting?.armed).toBe(true);
    expect(waiting?.ready).toBe(false);
    expect(waiting?.armNote).toContain("관측치 사슬 준비 중입니다 — 실행 감사(5분마다)가 지금 관측치의 사슬 고리를 남겨야");
    const ready = claude2StartView({ initialized: true, books: BOOKS }, { claude2: { ...STATUS.claude2!, chainReady: true } });
    expect(ready?.ready).toBe(true);
    expect(ready?.armNote).toContain("단추는 그 창 안에서, 관측치 사슬이 준비된 뒤에만 됩니다");
    expect(claude2StartView({ initialized: true, books: BOOKS }, STATUS)?.ready).toBe(true);   // 칸 없음 — 모름(서버가 거절하면 그 문구)
    // 꺼져 있으면 사슬보다 설정이 먼저(꺼진 동안은 사슬을 세지 않음).
    const off = claude2StartView({ initialized: true, books: BOOKS }, { claude2: { ...STATUS.claude2!, enabled: false, chainReady: false } });
    expect(off?.ready).toBe(false);
    expect(off?.armNote).toContain("claude2.enabled가 꺼져 있습니다");
    expect(claude2StartView({ initialized: true, books: BOOKS }, null)?.ready).toBe(false);
    expect(ready?.confirm).toContain("이거나 관측치 사슬 준비 중(켠 직후·새 관측치 직후 몇 분");
  });

  it("출발 뒤 1분봉 저장본 한 줄 — 정규장이면 받은 시각·나이·지연, 밖이면 그렇다고, 모르는 값은 '—', 시작 전·계좌2 없음은 줄 없음", () => {
    const started = { ...STATUS.claude2!, status: "ACTIVE" as const, startedOn: "2026-11-02" };
    expect(claude2BarsLine({ ...started, bars: { collectedAtKst: "2026-11-03 23:41 KST", ageSeconds: 180, lagSeconds: 912 } }))
      .toBe("Claude 계좌2 1분봉(Yahoo): 받은 시각 2026-11-03 23:41 · 3분 전 · 지연 15분 12초(SPY 마지막 봉 끝 → 받은 시각)");
    expect(claude2BarsLine({ ...started, bars: { collectedAtKst: "2026-11-03 23:41 KST", ageSeconds: 30, lagSeconds: null } }))
      .toBe("Claude 계좌2 1분봉(Yahoo): 받은 시각 2026-11-03 23:41 · 30초 전 · 지연 —(SPY 마지막 봉 끝 → 받은 시각)");
    expect(claude2BarsLine({ ...started, bars: { collectedAtKst: null, ageSeconds: null, lagSeconds: null } }))
      .toBe("Claude 계좌2 1분봉(Yahoo): 저장본 없음(받은 시각·지연 —)");
    expect(claude2BarsLine({ ...started, status: "PAUSED" as const, bars: null }, "계좌2"))
      .toBe("계좌2 1분봉(Yahoo): 정규장 밖 — 받은 시각·지연은 미국 정규장 중에만 적습니다");
    expect(claude2BarsLine(STATUS.claude2)).toBeNull();
    expect(claude2BarsLine({ ...STATUS.claude2!, status: null })).toBeNull();
    expect(claude2BarsLine(null)).toBeNull();
  });

  it("출발 결과 — 출발·이미 출발·실패(서버 문구), 사후 체결 수는 적지 않는다", () => {
    const decision = {
      id: 9, book: "claude2", asOfTradingDate: "2026-10-30", kind: "INITIAL", status: "OK", decidedAtKst: "2026-10-31 07:41",
      model: "claude-sonnet-5-5", frameworkVersion: 4, settingsVersion: 9, selectionAsOf: null, targetExposurePct: 60, summary: null,
      orderCount: 6, rejectedCount: 0, pricesFinal: true, error: null,
    };
    expect(claude2StartResultView({ ok: true, outcome: "STARTED", decision, fills: [] }).text)
      .toBe("Claude 계좌2가 출발했습니다 — 주문은 다음 세션에 고른 시점으로 체결됩니다 · 2026-10-30 초기 결정 · 주문 6건");
    expect(claude2StartResultView({ ok: true, outcome: "ALREADY_STARTED", decision, fills: [] }).text).toContain("이미 출발했습니다");
    expect(claude2StartResultView({ ok: false, message: "창 밖입니다" })).toEqual({ tone: "warn", text: "창 밖입니다" });
  });

  it("한계 문구 — 2·4번 대신의 두 줄과 슬리피지·판단 보류", () => {
    expect(CLAUDE2_LIMITS).toHaveLength(4);
    expect(CLAUDE2_LIMITS[0]).toContain("1분봉 시가");
    expect(CLAUDE2_LIMITS[1]).toContain("앞으로 체결로 출발");
    expect(CLAUDE2_LIMITS[3]).toContain("판단 보류");
  });
});

const EXECUTION: PaperExecutionResponse = {
  available: true, book: "claude2", limit: 50,
  orders: [
    {
      orderId: 71, decisionId: 9, ticker: "AAA", side: "BUY", status: "FILLED", timing: "AT_1000", asOfTradingDate: "2026-11-02",
      targetSession: "2026-11-03", targetAtKst: "2026-11-04 00:00", createdAtKst: "2026-11-03 07:41", fill: null,
      cf: { NEXT_OBSERVATION: null }, advantageBp: { NEXT_OPEN: 3.2, AT_1000: 12.345 }, lagSeconds: null, lateResolved: false,
      executionNote: "개장 직후 변동성을 피함", auditedAtKst: "2026-11-04 01:10",
    },
    {
      orderId: 72, decisionId: 9, ticker: "BBB", side: "SELL", status: "FILLED", timing: "NEXT_OPEN", asOfTradingDate: "2026-11-02",
      targetSession: "2026-11-03", targetAtKst: "2026-11-03 23:30", createdAtKst: "2026-11-03 07:41", fill: null,
      cf: {}, advantageBp: { NEXT_OPEN: null }, lagSeconds: null, lateResolved: null, executionNote: null, auditedAtKst: null,
    },
  ],
  summary: {
    baseline: "NEXT_OBSERVATION", formula: "s × (P_NEXT_OBSERVATION − P_시점) ÷ P_NEXT_OBSERVATION × 10⁴ bp", weighting: "체결 금액(gross) 가중 평균",
    interval: { level: 90, method: "결정일(기준 거래일) 묶음 부트스트랩", resamples: 2000, seed: 1 },
    minOrders: 10, minDays: 5, audited: 14,
    chosen: {
      formula: "s × (P_NEXT_OBSERVATION − P_체결) ÷ P_NEXT_OBSERVATION × 10⁴ bp", n: 11, days: 5, excludedNoBaseline: 1,
      meanBp: 6.789, lowBp: -3.25, highBp: 15, isProxy: true, excludedFallback: 2, notFilled: 1,
      fallback: { n: 2, days: 1, excludedNoBaseline: 0, meanBp: null, lowBp: null, highBp: null, isProxy: false },
    },
    timings: [
      { timing: "NEXT_OPEN", n: 4, days: 2, excludedNoBaseline: 1, excludedNoPrice: 0, meanBp: null, lowBp: null, highBp: null, isProxy: true },
      { timing: "AT_1000", n: 12, days: 6, excludedNoBaseline: 1, excludedNoPrice: 1, meanBp: 4.25, lowBp: -10.5, highBp: 18, isProxy: false },
    ],
  },
};

describe("체결 시점 실험", () => {
  it("문턱 미달이면 '—'와 판단 보류(표본 수와 문턱), 값이 있으면 평균·구간 — 판정 문장은 만들지 않음, 시가는 대리값", () => {
    const view = executionSummaryView(EXECUTION);
    expect(view?.head).toBe("감사한 주문 14건 · 평균·구간은 주문 10건·결정일 5일 이상부터");
    expect(view?.rows.map((row) => [row.timing, row.proxy, row.n, row.days, row.mean, row.interval, row.verdict, row.excluded])).toEqual([
      ["다음 거래일 시가", true, "4건", "2일", "—", "—", "판단 보류 — 표본 부족(주문 4/10건 · 결정일 2/5일)", "기준 없음 1 · 값 없음 0"],
      ["다음 거래일 10:00 ET", false, "12건", "6일", "+4.3bp", "-10.5bp ~ +18.0bp", null, "기준 없음 1 · 값 없음 1"],
    ]);
    expect(view?.method).toBe("체결 금액(gross) 가중 평균 · 90% 구간 = 결정일(기준 거래일) 묶음 부트스트랩");
    expect(executionSummaryView({ available: false, message: "없음" })).toBeNull();
  });

  it("고른 시점(M1): 본 줄은 평균·구간과 뺀 수(기준 없음·대체 체결·체결 없음), 대체 체결은 따로 — 판정에 쓰지 않음, 문턱 미달이면 '—'", () => {
    const view = executionSummaryView(EXECUTION);
    expect(view?.chosenFormula).toBe("s × (P_NEXT_OBSERVATION − P_체결) ÷ P_NEXT_OBSERVATION × 10⁴ bp");
    expect(view?.chosen?.map((row) => [row.timing, row.proxy, row.n, row.days, row.mean, row.interval, row.verdict, row.excluded])).toEqual([
      [EXECUTION_CHOSEN_LABEL, true, "11건", "5일", "+6.8bp", "-3.3bp ~ +15.0bp", null, "기준 없음 1 · 대체 체결 2(아래 줄) · 체결 없음 1"],
      [EXECUTION_CHOSEN_FALLBACK_LABEL, false, "2건", "1일", "—", "—", "판정에 쓰지 않음 — 표본 부족(주문 2/10건 · 결정일 1/5일)", "기준 없음 0"],
    ]);
    // 본 줄이 문턱 아래면 메뉴 줄과 같은 '판단 보류', 대체 체결 줄은 값이 있어도 판정에 쓰지 않는다고만.
    const summary = EXECUTION.summary!;
    const below = executionSummaryView({
      ...EXECUTION,
      summary: {
        ...summary,
        chosen: {
          ...summary.chosen!, n: 9, meanBp: null, lowBp: null, highBp: null,
          fallback: { n: 12, days: 6, excludedNoBaseline: 0, meanBp: -40, lowBp: -60, highBp: -20, isProxy: false },
        },
      },
    });
    expect(below?.chosen?.map((row) => [row.mean, row.interval, row.verdict])).toEqual([
      ["—", "—", "판단 보류 — 표본 부족(주문 9/10건 · 결정일 5/5일)"],
      ["-40.0bp", "-60.0bp ~ -20.0bp", "판정에 쓰지 않음(따로 셈)"],
    ]);
    // 계좌1 — 서버가 null을 보내면 M1 줄이 없다(고른 시점이 곧 계좌1식 기준).
    const book1 = executionSummaryView({ ...EXECUTION, book: "claude", summary: { ...summary, chosen: null } });
    expect(book1?.chosen).toBeNull();
    expect(book1?.chosenFormula).toBeNull();
    expect(book1?.rows).toHaveLength(2);
  });

  it("사전 등록 판정의 문턱은 설명 문구로만 — 명세 §14-3의 수치 그대로, 카드는 판정을 내리지 않는다고", () => {
    expect(EXECUTION_VERDICT_RULE).toContain("대체 체결을 뺀 M1 주문 30건 이상이고 평균 > +10bp이고 90% 구간 하한 > 0이면 '도움이 됐다'");
    expect(EXECUTION_VERDICT_RULE).toContain("구간 상한 < 0이면 '손해였다'");
    expect(EXECUTION_VERDICT_RULE).toContain("'차이를 확인하지 못함(판단 보류)'");
    expect(EXECUTION_VERDICT_RULE).toContain("이 카드는 판정을 내리지 않습니다");
  });

  it("주문 줄의 계좌1식 대비는 그 주문이 고른 시점의 서버 값 — 없으면 '—'", () => {
    const audit = executionByOrder(EXECUTION);
    expect(executionAdvantageText(audit.get(71))).toBe("+12.3bp");
    expect(executionAdvantageText(audit.get(72))).toBe("—");
    expect(executionAdvantageText(audit.get(99))).toBe("—");
    expect(orderExecutionNote({ thesis: "x", executionNote: "개장 직후 변동성을 피함" })).toBe("개장 직후 변동성을 피함");
    expect(orderExecutionNote({ thesis: "x" })).toBe("—");
  });
});

describe("노출 추이의 계좌2 선", () => {
  const series = [
    { tradingDate: "2026-11-02", targetExposurePct: 60, actualExposurePct: 58.2 },
    { tradingDate: "2026-11-03", targetExposurePct: 62, actualExposurePct: null },
  ];

  it("계좌2 기록이 없으면 두 선·행 그대로(예전 모양)", () => {
    const chart = claudeExposureChart(series);
    expect(chart.series.map((line) => line.key)).toEqual(["target", "actual"]);
    expect(chart.rows).toEqual([
      { date: "2026-11-02", target: 60, actual: 58.2 },
      { date: "2026-11-03", target: 62, actual: null },
    ]);
  });

  it("계좌2 순자산 기록이 오면 셋째 선 — 날짜 합집합, 없는 날은 그 선만 null(앞 값으로 잇지 않음)", () => {
    const chart = claudeExposureChart(series, [
      { tradingDate: "2026-11-03", nav: 100000, cash: 40000, equityValue: 60000, exposurePct: 60, pricesFinal: true },
      { tradingDate: "2026-11-04", nav: 100100, cash: 40000, equityValue: 60100, exposurePct: 60.04, pricesFinal: true },
    ]);
    expect(chart.series.map((line) => [line.key, line.name])).toEqual([
      ["target", "목표 노출(Claude가 정함)"], ["actual", "실제 노출(장부)"], [CLAUDE2_EXPOSURE_KEY, "계좌2 실제 노출(장부)"],
    ]);
    expect(chart.rows.map((row) => [row.date, row.target, row.actual, row[CLAUDE2_EXPOSURE_KEY]])).toEqual([
      ["2026-11-02", 60, 58.2, null],
      ["2026-11-03", 62, null, 60],
      ["2026-11-04", null, null, 60.04],
    ]);
    expect(chart.latest).toBe("2026-11-04 — 목표 — · 실제 — · 계좌2 실제 60.0%");
  });
});

describe("결정 상세·검증·리스크·설정", () => {
  const detail = (over: Partial<PaperDecisionDetail>): PaperDecisionDetail => ({
    id: 31, book: "claude2", asOfTradingDate: "2026-11-02", kind: "SCHEDULED", status: "OK", decidedAtKst: "2026-11-03 07:42",
    model: "claude-sonnet-5-5", frameworkVersion: 4, settingsVersion: 9, selectionAsOf: null, targetExposurePct: 60, summary: null,
    orderCount: 2, rejectedCount: 0, pricesFinal: true, error: null, packet: null, packetHash: null, response: null, usage: null,
    noteIds: null, latencyMs: null, retryCount: 0, ...over,
  });

  it("계좌2만 '계좌1과 같은 입력'·섹션 해시 칸 — 계좌1 결정(칸 없음)은 예전 칸 그대로", () => {
    const cells = Object.fromEntries(decisionMeta(detail({ sharedWith: 30, marketSectionsSha256: "0123456789abcdef0123" }))
      .map((cell) => [cell.key, cell.value]));
    expect(cells.sharedWith).toBe("결정 #30");
    expect(cells.marketSectionsSha256).toBe("0123456789ab…");
    expect(Object.fromEntries(decisionMeta(detail({ sharedWith: null, marketSectionsSha256: null })).map((cell) => [cell.key, cell.value])))
      .toMatchObject({ sharedWith: "— (같은 거래일 계좌1 결정 없음·섹션 다름·계좌1 행이 재시도할 API 오류)", marketSectionsSha256: "—" });
    expect(decisionMeta(detail({ book: "claude" })).map((cell) => cell.key)).not.toContain("sharedWith");
  });

  // 수정 전에는 sharedWith가 null일 때 '같은 실행의 계좌1 결정 없음·섹션 다름'만 적었지만, 서버(ClaudeBookService.persistClaude2)는 같은 거래일
  // 계좌1 행이 재시도할 API 오류(retry_count 0)여도 null을 보내고, 따로 도는 실행의 계좌1 정기 결정 행도 가리킨다(수정 전에는 it.fails).
  it("sharedWith가 null인 까닭은 서버의 세 갈래 — 같은 거래일 계좌1 결정 없음·섹션 다름·계좌1 행이 재시도할 API 오류", () => {
    const cell = decisionMeta(detail({ sharedWith: null, marketSectionsSha256: "0123456789abcdef0123" }))
      .find((entry) => entry.key === "sharedWith");
    expect(cell?.value).toContain("같은 거래일 계좌1 결정 없음");
    expect(cell?.value).toContain("섹션 다름");
    expect(cell?.value).toContain("재시도할 API 오류");
    expect(cell?.value).not.toContain("같은 실행의");
  });

  it("계좌2 결정 기록은 Claude 모양으로 읽고 주문마다 실행 메모를 싣는다", () => {
    const view = claudeDecisionView({
      book: "claude2",
      response: {
        stance: "NEUTRAL", targetEquityExposurePct: 60, summary: "분산",
        orders: [{ ticker: "AAA", side: "BUY", targetWeightPct: 8, timing: "AT_1000", thesis: "근거", labels: [], invalidation: "조건", executionNote: "개장 직후 피함" }],
        validation: [],
      },
    });
    expect(view.recognized).toBe(true);
    expect(view.orders.map((row) => [row.timing, row.executionNote])).toEqual([["다음 거래일 10:00 ET", "개장 직후 피함"]]);
  });

  it("지난 시각 거절 사유, 1분봉 기다림은 오류가 아니라 메모", () => {
    expect(rejectReasonText("LATE_FOR_TIMING").label).toBe("이미 지난 시각 (LATE_FOR_TIMING)");
    const view = riskResultView({
      ok: true,
      outcome: {
        filled: 0, stopped: 0, expired: 0, splits: 0, booksProcessed: [], skippedReason: null, notes: [], errors: [],
        waiting: ["claude2: 1분봉 저장본이 관측치보다 앞"], stillWaiting: ["claude2: 같은 관측치"],
      },
    });
    expect(view.tone).toBe("info");
    expect(view.notes).toEqual(["1분봉 기다림 — claude2: 1분봉 저장본이 관측치보다 앞", "1분봉 기다림(계속) — claude2: 같은 관측치"]);
  });

  it("설정 묶음 claude2.*에 이름표가 있다", () => {
    const groups = settingGroups({
      available: true, version: 9, body: { claude2: { enabled: false } }, defaults: {},
      keys: [{ key: "claude2.enabled", type: "boolean", min: null, max: null, affectsRules: false, description: "계좌2", market: "US" }],
    });
    expect(groups.map((group) => [group.key, group.title])).toEqual([
      ["claude2", "🧪 미국 Claude 계좌2 — 체결 시점 실험(켜기 · 결정 주기 호출 상한 · 1분봉 기다림 · 체결 기록, 규칙 계좌 영향 없음)"],
    ]);
  });
});
