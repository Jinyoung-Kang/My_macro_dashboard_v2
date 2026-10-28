/**
 * 🧪 모의매매(한국) 결정 로그 탭(/paper/kr/decisions, 2단계 명세 §4-6·§4-9·§4-16 F2) — 네 상태 이야기와 한국 상세.
 *
 *  - 불러오는 중: 결정 기록·작업 기록이 오기 전에는 읽는 중 표시
 *  - 빈 상태(출발 전): 결정 기록이 비었다고 말하고 출발 단추(개요)를 안내, 규칙 계좌에는 수동 결정 단추가 없음, 출발 기록도 없음
 *  - 오류: 결정 기록·작업 기록을 못 읽으면 오류 + 다시 시도
 *  - 자료: 규칙 계좌 기한 지남 행(기한·판정 근거·판정 시각·기다린 게이트·③ 창 구멍 링크), 출발 INITIAL(설정 출발일·미룸), Claude 기한 지남
 *    SKIPPED, Claude 출발(출발 호출 수·검증 UNFILLABLE 이름표·사건 줄 '창 앞'), 출발 기록(과금 호출)·마지막 게이트 판정, 수동 결정은
 *    kr_claude에만 있고 확인 창에 수동 문턱·결정 창 → POST /api/paper/run/decision?market=KR
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 객체를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  MultiLineSeries: () => null,
  DonutChart: () => null,
}));

import PaperPage from "@/components/screens/paper/PaperScreen";

function book(code: string, over: Record<string, unknown> = {}) {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-30", initialCash: 100_000_000,
    cash: 340_000, nav: 100_312_450, equityValue: 99_972_450, exposurePct: 99.66, returnPct: 0.31,
    lastObservedAtKst: "2026-11-03 21:57 KST", positions: 2, staleCount: 0, stats: null, statsReason: null,
    benchmark: "kr_bench_k200", ...over,
  };
}

const BOOKS = [
  book("kr_rules", { kind: "RULES", label: "한국 규칙 계좌" }),
  book("kr_claude", { kind: "CLAUDE", label: "한국 Claude 계좌" }),
  book("kr_bench_k200", { label: "KODEX 200 계좌", benchmark: null }),
  book("kr_bench_mix", { label: "한국 60/40 계좌" }),
];
const NOT_STARTED = BOOKS.map((entry) => ({ ...entry, status: "NOT_STARTED", startedOn: null }));

const overview = (books: unknown[]) => ({
  available: true, market: "KR", currency: "KRW", dormantReason: null, initialized: true, pendingBackfill: [],
  startDate: "2026-10-29", books, navSeries: { dates: [], books: {} }, quotes: null, selection: null, gate: null,
  claudeExposureSeries: [], frameworkBoundaries: [], limits: [], jobs: [],
});

function decision(id: number, over: Record<string, unknown> = {}) {
  return {
    id, book: "kr_rules", asOfTradingDate: "2026-11-03", kind: "SCHEDULED", status: "NO_TRADE", decidedAtKst: "2026-11-04 01:05 KST",
    model: null, frameworkVersion: null, settingsVersion: 4, selectionAsOf: null, targetExposurePct: null,
    summary: "결정 기한이 지나 2026-11-03 세션은 결정하지 않습니다(NO_TRADE)", orderCount: 0, rejectedCount: 0, pricesFinal: false,
    error: null, ...over,
  };
}

const GATES = [
  { gate: "①", status: "PASS", note: "kr_rules — 기준일 < 2026-11-03인 대기 주문 없음(앞 결정의 주문이 정리됨)" },
  { gate: "③", status: "FAIL", note: "U 97/100에 2026-11-03 수급 · 20거래일 창에 U 기록이 절반 미만인 날 1(2026-10-15) — 달력이 모르는 휴장일이면 kr.calendar.extraClosures에 더함, 아니면 수집 구멍(창이 덜 찬 종목은 '자료 부족')" },
  { gate: "⑤", status: "FAIL", note: "069500 2026-11-03 봉 없음(휴장 또는 지연)" },
];

const RULES_PAST = decision(41);
const RULES_PAST_DETAIL = {
  available: true,
  decision: {
    ...RULES_PAST,
    response: {
      summary: RULES_PAST.summary, book: "kr_rules", kind: "SCHEDULED", asOfTradingDate: "2026-11-03",
      noTradeReason: "069500 D 봉 없음(휴장 또는 지연)", pastDeadline: true, deadlineKst: "2026-11-04 01:00 KST", gates: GATES,
      waitedFor: ["③ U 97/100에 2026-11-03 수급", "⑤ 069500 2026-11-03 봉 없음(휴장 또는 지연)"],
      gatesJudgedAtKst: "2026-11-04 00:50 KST", gatesBasis: "기한 전 마지막 판정(작업 기록 rulesGates)", selectionDay: false,
      cycleDate: null, orders: [], settings: {},
    },
    packet: null, packetHash: null, usage: null, noteIds: [], latencyMs: null, retryCount: 0,
  },
  orders: [],
};

const RULES_START = decision(40, {
  asOfTradingDate: "2026-10-30", kind: "INITIAL", status: "OK", orderCount: 2, summary: "출발 — 12종목 + 153130",
  selectionAsOf: "2026-10-30", targetExposurePct: 80,
});
const RULES_START_DETAIL = {
  available: true,
  decision: {
    ...RULES_START,
    response: {
      summary: "출발 — 12종목 + 153130", book: "kr_rules", kind: "INITIAL", asOfTradingDate: "2026-10-30", timing: "NEXT_OPEN",
      selectionDay: true, cycleDate: "2026-11-02", selectionAsOf: "2026-10-30", catchUp: false,
      configuredStartDate: "2026-10-29", postponed: true, gates: GATES.slice(0, 1),
      selection: { maxNames: 12, weighting: "EQUAL", candidates: [{ code: "005930", universeRank: 1, score: 0.0123 }],
        exclusionCounts: { "ROE ≤ 0": 3 }, targets: [{ code: "005930", rankInPlan: 1, score: 0.0123, weightPct: 6.67 }],
        notChosen: [], stockWeightPct: 80, parkingWeightPct: 20 },
      holdings: [], orders: [], skipped: [], notes: ["035720 매도 주문 — 지금은 체결할 수 없음(D 거래정지)"], settings: {},
    },
    packet: null, packetHash: null, usage: null, noteIds: [], latencyMs: 1200, retryCount: 0,
  },
  orders: [{
    id: 7, ticker: "005930", side: "BUY", qty: null, targetWeightPct: 6.67, sellFraction: null, timing: "NEXT_OPEN", source: "RULE",
    status: "FILLED", rejectReason: null, reason: { text: "점수 0.0123(순위 1) — 20일 외국인·기관 둘 다 순매수" },
    asOfTradingDate: "2026-10-30", createdAtKst: "2026-10-30 22:31 KST", expiresOn: "2026-11-04", filledAtKst: "2026-11-02 21:57 KST",
  }],
};

const CLAUDE_SKIPPED = decision(51, {
  book: "kr_claude", status: "SKIPPED", summary: "결정 기한이 지나 Claude를 부르지 않음",
});
const CLAUDE_SKIPPED_DETAIL = {
  available: true,
  decision: {
    ...CLAUDE_SKIPPED,
    response: {
      summary: "결정 기한이 지나 Claude를 부르지 않음", book: "kr_claude", kind: "SCHEDULED", asOfTradingDate: "2026-11-03",
      skipped: "결정 기한(2026-11-04 01:00 KST)이 지나 부르지 않음", skippedReason: "069500 D 봉 없음(휴장 또는 지연)",
      pastDeadline: true, deadlineKst: "2026-11-04 01:00 KST", gates: GATES, waitedFor: ["⑤ 069500 2026-11-03 봉 없음(휴장 또는 지연)"],
      gatesJudgedAtKst: "2026-11-04 00:55 KST", gatesBasis: "기한 전 마지막 판정(작업 기록 claudeGates)",
    },
    packet: null, packetHash: null, usage: null, noteIds: [], latencyMs: null, retryCount: 0,
  },
  orders: [],
};

const CLAUDE_START = decision(50, {
  book: "kr_claude", asOfTradingDate: "2026-10-30", kind: "INITIAL", status: "OK", orderCount: 1, rejectedCount: 1,
  model: "claude-sonnet-5-5", targetExposurePct: 60, summary: "출발 — 반도체 일부",
});
const CLAUDE_START_DETAIL = {
  available: true,
  decision: {
    ...CLAUDE_START,
    response: {
      stance: "NEUTRAL", targetEquityExposurePct: 60, summary: "출발 — 반도체 일부", exposureRationale: "수급 개선",
      orders: [{ ticker: "005930", side: "BUY", targetWeightPct: 10, sellFraction: null, timing: "NEXT_OPEN", thesis: "외국인 순매수",
        labels: ["사실"], invalidation: "순매도 전환" },
      { ticker: "035420", side: "BUY", targetWeightPct: 5, sellFraction: null, timing: "NEXT_OPEN", thesis: "반등", labels: [], invalidation: "—" }],
      validation: [
        { ticker: "005930", side: "BUY", targetWeightPct: 10, sellFraction: null, timing: "NEXT_OPEN", accepted: true, rejectReason: null, detail: null },
        { ticker: "035420", side: "BUY", targetWeightPct: 5, sellFraction: null, timing: "NEXT_OPEN", accepted: false, rejectReason: "UNFILLABLE",
          detail: "035420 2026-10-30 거래정지" },
      ],
      configuredStartDate: "2026-10-29", postponed: true, startCalls: 2, gates: GATES.slice(0, 1),
    },
    packet: { "11b_events": {
      window: { from: "2026-10-29T22:30:00+09:00", to: "2026-10-30T22:30:00+09:00" }, timeNote: "시각 = 알 수 있는 시각(KST)",
      text: "<<사건 #1 시작>> [연합뉴스 · 2026-10-29 21:50] 금통위 … <<사건 #1 끝>>",
      items: [{ k: 1, entity: "e1", source: "연합뉴스", knownAtKst: "2026-10-29T21:50:00+09:00", matched: ["keyword 금통위"] }],
    } },
    packetHash: "abcdef0123456789", usage: { model: "claude-sonnet-5-5", inputTokens: 9000, outputTokens: 800 }, noteIds: [],
    latencyMs: 30000, retryCount: 0,
  },
  orders: [],
};

const STATUS = {
  available: true, market: "KR", currency: "KRW", dormantReason: null,
  apiUsage: { today: { day: "2026-11-03", calls: 3, cap: 20, scheduledReserve: 7, manualLimit: 13, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0 }, month: { month: "2026-11", days: 1, calls: 3, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0 } },
  jobs: [
    { job: "kr.decision", startedAtKst: "2026-11-03 23:00 KST", finishedAtKst: "2026-11-03 23:00 KST", outcome: "DATA_NOT_READY",
      detail: { tradingDate: "2026-11-03", waiting: "자료 게이트 미달: ⑤", rulesGates: { judgedAtKst: "2026-11-03 23:00 KST", gates: GATES } } },
    { job: "kr.decision", startedAtKst: "2026-10-29 22:40 KST", finishedAtKst: "2026-10-29 22:41 KST", outcome: "START_POSTPONED",
      detail: { start: true, tradingDate: "2026-10-29", configuredStartDate: "2026-10-29", postponed: false, postponedTo: "2026-10-30",
        reason: "Claude 출발 호출 형식 오류", calls: { kr_claude: { calls: 2, attempts: 2, isEstimated: false } }, attempt: 1 } },
  ],
};

const SETTINGS = { available: true, version: 4, body: { kr: { decisionTimeKst: "22:30", decisionDeadlineKst: "01:00" } } };

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않는 요청. 긴 경로부터 맞춥니다. */
let reads: Record<string, () => Promise<unknown>> = {};

beforeEach(() => {
  reads = {};
  window.history.replaceState(null, "", "/paper/kr/decisions");
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
    return key ? reads[key]() : new Promise(() => {});
  });
});

afterEach(() => cleanup());

const requested = () => api.apiGetShared.mock.calls.map(([path]) => String(path));

async function expand(name: string): Promise<HTMLElement> {
  const row = await screen.findByRole("row", { name });
  fireEvent.click(within(row).getByRole("button", { name: "상세 펼치기" }));
  return screen.findByRole("region", { name: `${name} 상세` });
}

describe("불러오는 중", () => {
  it("결정 기록·작업 기록이 오기 전에는 읽는 중 — 규칙 계좌 기록과 상태(?market=KR)를 읽는다", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve(overview(BOOKS));
    render(<PaperPage market="KR" initialTab="decisions" />);
    expect(await screen.findByText("결정 기록을 읽는 중…")).toBeTruthy();
    expect(screen.getByText("작업 기록을 읽는 중…")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "결정 로그" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(requested()).toContain("/api/paper/decisions?book=kr_rules&limit=50"));
    expect(requested()).toContain("/api/paper/status?market=KR");
    // 결정 기록 · 주간 복기 보기 — 한국 복기는 ?market=KR 경로(paperKrReviews.test).
    expect(screen.getByRole("group", { name: "결정 로그 보기" })).toBeTruthy();
  });
});

describe("빈 상태(출발 전)", () => {
  it("결정 기록이 비었다고 말하고 출발 단추를 안내 — 규칙 계좌에는 수동 결정 단추가 없고, 출발 기록도 없다", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve(overview(NOT_STARTED));
    reads["/api/paper/decisions?book=kr_rules"] = () => Promise.resolve({ available: true, decisions: [] });
    reads["/api/paper/status?market=KR"] = () => Promise.resolve({ ...STATUS, jobs: [] });
    render(<PaperPage market="KR" initialTab="decisions" />);

    expect(await screen.findByText(/아직 결정 기록이 없습니다 — 한국 네 계좌가 출발하면\(개요의 '출발 지금 실행'/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "지금 결정 실행" })).toBeNull();
    expect(screen.getByText(/동결된 대조군이라 수동 결정 단추는 없습니다/)).toBeTruthy();
    expect(await screen.findByText(/출발 기록이 없습니다/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("계좌 고르기"), { target: { value: "kr_claude" } });
    const run = await screen.findByRole("button", { name: "지금 결정 실행" });
    expect(run.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/시작 전인 한국 계좌는 결정을 내지 않습니다 — 네 계좌가 함께 출발한 뒤/)).toBeTruthy();
  });
});

const DORMANT = {
  available: true, market: "KR", currency: "KRW",
  dormantReason: "한국 책 출발일(dashboard.paper.kr.start-date — .env PAPER_KR_START_DATE)이 비어 있어 한국 초기화·출발을 하지 않습니다",
  initialized: false, pendingBackfill: [], startDate: null, books: [], navSeries: { dates: [], books: {} }, quotes: null,
  selection: null, gate: null, claudeExposureSeries: [], frameworkBoundaries: [], limits: [], jobs: [],
};

describe("쉬는 한국(계좌 없음)", () => {
  it("결정 탭은 한국 초기화 안내 — 결정 기록을 읽지 않는다", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve(DORMANT);
    render(<PaperPage market="KR" initialTab="decisions" />);
    expect(await screen.findByText(/결정을 내는 한국 계좌가 아직 없습니다 — 출발일이 정해지면 개요 탭의 '한국 초기화'로/)).toBeTruthy();
    expect(requested().some((path) => path.startsWith("/api/paper/decisions"))).toBe(false);
  });
});

describe("오류", () => {
  it("결정 기록·작업 기록을 못 읽으면 오류 + 다시 시도(누르면 다시 읽음)", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve(overview(BOOKS));
    let calls = 0;
    reads["/api/paper/decisions?book=kr_rules"] = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("결정 기록을 읽지 못했습니다.")) : Promise.resolve({ available: true, decisions: [RULES_PAST] });
    };
    reads["/api/paper/status?market=KR"] = () => Promise.reject(new Error("상태를 읽지 못했습니다."));
    render(<PaperPage market="KR" initialTab="decisions" />);

    expect(await screen.findByText("결정 기록을 읽지 못했습니다.")).toBeTruthy();
    expect(await screen.findByText("상태를 읽지 못했습니다.")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /다시 시도/ })[0]);
    expect(await screen.findByRole("row", { name: "2026-11-03 정기" })).toBeTruthy();
  });
});

describe("자료", () => {
  beforeEach(() => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve(overview(BOOKS));
    reads["/api/paper/decisions?book=kr_rules"] = () => Promise.resolve({ available: true, decisions: [RULES_PAST, RULES_START] });
    reads["/api/paper/decisions?book=kr_claude"] = () => Promise.resolve({ available: true, decisions: [CLAUDE_SKIPPED, CLAUDE_START] });
    reads["/api/paper/decisions/41"] = () => Promise.resolve(RULES_PAST_DETAIL);
    reads["/api/paper/decisions/40"] = () => Promise.resolve(RULES_START_DETAIL);
    reads["/api/paper/decisions/51"] = () => Promise.resolve(CLAUDE_SKIPPED_DETAIL);
    reads["/api/paper/decisions/50"] = () => Promise.resolve(CLAUDE_START_DETAIL);
    reads["/api/paper/status?market=KR"] = () => Promise.resolve(STATUS);
    reads["/api/paper/settings"] = () => Promise.resolve(SETTINGS);
  });

  it("목록 — 종류 '출발(초기 결정)', 가격 칸 '잠정(토스)'", async () => {
    render(<PaperPage market="KR" initialTab="decisions" />);
    const start = await screen.findByRole("row", { name: "2026-10-30 출발(초기 결정)" });
    expect(within(start).getByText("잠정(토스)")).toBeTruthy();
  });

  it("규칙 계좌 기한 지남 행 — 기한·판정 근거·판정 시각·기다린 게이트, 게이트 표와 ③ 창 구멍의 설정 탭 링크", async () => {
    render(<PaperPage market="KR" initialTab="decisions" />);
    const detail = await expand("2026-11-03 정기");
    const past = within(detail).getByRole("region", { name: "기한 지남" });
    expect(within(past).getByText("기한 전 마지막 판정(작업 기록 rulesGates)")).toBeTruthy();
    expect(within(past).getByText("2026-11-04 00:50")).toBeTruthy();
    expect(within(past).getByText("⑤ 069500 2026-11-03 봉 없음(휴장 또는 지연)")).toBeTruthy();
    expect(within(past).getByText("사유 — 069500 D 봉 없음(휴장 또는 지연)")).toBeTruthy();
    const gates = within(detail).getByRole("region", { name: "자료 게이트 (좌우 스크롤)" });
    expect(within(gates).getAllByText("미달")).toHaveLength(2);
    expect(within(gates).getByRole("link", { name: "설정 탭에서 kr.calendar.extraClosures 보기" }).getAttribute("href")).toBe("/paper/kr/settings");
    // 미국 13F 신호 표는 한국 기록에 없다.
    expect(within(detail).queryByText("13F 신호 이벤트")).toBeNull();
  });

  it("출발 INITIAL — 설정 출발일·미룸, 선정 요약·목표, 메모 '지금은 체결할 수 없음' 그대로, 주문 표", async () => {
    render(<PaperPage market="KR" initialTab="decisions" />);
    const detail = await expand("2026-10-30 출발(초기 결정)");
    const start = within(detail).getByRole("region", { name: "출발" });
    expect(within(start).getByText("2026-10-29")).toBeTruthy();
    expect(within(start).getByText("예(설정 출발일보다 늦게 출발)")).toBeTruthy();
    const selection = within(detail).getByRole("region", { name: "선정" });
    expect(within(selection).getByText("80.00%")).toBeTruthy();
    expect(within(detail).getByText("035720 매도 주문 — 지금은 체결할 수 없음(D 거래정지)")).toBeTruthy();
    expect(within(detail).getByText("점수 0.0123(순위 1) — 20일 외국인·기관 둘 다 순매수")).toBeTruthy();
  });

  it("Claude 기한 지남 SKIPPED — 부르지 않음 사유·기한 지남 칸, Claude 출발 — 출발 호출 수·UNFILLABLE 이름표·사건 줄 '창 앞'", async () => {
    render(<PaperPage market="KR" initialTab="decisions" />);
    fireEvent.change(await screen.findByLabelText("계좌 고르기"), { target: { value: "kr_claude" } });

    const skipped = await expand("2026-11-03 정기");
    expect(within(skipped).getByText(/Claude를 부르지 않음 — 결정 기한/)).toBeTruthy();
    expect(within(within(skipped).getByRole("region", { name: "기한 지남" })).getByText("기한 전 마지막 판정(작업 기록 claudeGates)")).toBeTruthy();
    fireEvent.click(within(await screen.findByRole("row", { name: "2026-11-03 정기" })).getByRole("button", { name: "상세 접기" }));

    const start = await expand("2026-10-30 출발(초기 결정)");
    expect(within(within(start).getByRole("region", { name: "출발" })).getByText("2회")).toBeTruthy();
    expect(within(start).getByText("지금 체결할 수 없는 종목 매수 (UNFILLABLE)")).toBeTruthy();
    const events = within(start).getByRole("region", { name: "사건 줄(패킷 11b_events)" });
    expect(within(events).getByText("창 앞 시각 — 결정 순간 뒤(창 안)에 받은 제목")).toBeTruthy();
  });

  it("출발·게이트 기록 — 출발 미룸의 과금 호출·시도, 규칙 계좌 몫 마지막 게이트 판정", async () => {
    render(<PaperPage market="KR" initialTab="decisions" />);
    const records = await screen.findByRole("list", { name: "출발 기록" });
    expect(records.textContent).toContain("2026-10-29 22:40 START_POSTPONED");
    expect(records.textContent).toContain("과금 호출 kr_claude 2회(결정 행 없음 — 사용량에 셈)");
    expect(records.textContent).toContain("시도 1번째");
    expect(screen.getByRole("heading", { name: "규칙 계좌 몫 마지막 게이트 판정 — 세션 2026-11-03 · 2026-11-03 23:00" })).toBeTruthy();
  });

  it("수동 결정은 kr_claude에만 — 확인 창에 수동 문턱·결정 창, 확인하면 POST /api/paper/run/decision?market=KR", async () => {
    api.apiPost.mockResolvedValue({ ok: true, market: "KR", decision: CLAUDE_SKIPPED });
    render(<PaperPage market="KR" initialTab="decisions" />);
    await screen.findByRole("row", { name: "2026-11-03 정기" });
    expect(screen.queryByRole("button", { name: "지금 결정 실행" })).toBeNull();

    fireEvent.change(screen.getByLabelText("계좌 고르기"), { target: { value: "kr_claude" } });
    fireEvent.click(await screen.findByRole("button", { name: "지금 결정 실행" }));
    expect(await screen.findByText(/수동 문턱\(13회 — 하루 상한 − 정기 몫 예약\) 미만일 때만, 결정 창\(22:30 ~ 01:00\(다음 날\) KST\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "결정 실행 확인" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/paper/run/decision?market=KR", { book: "kr_claude" }));
  });
});
