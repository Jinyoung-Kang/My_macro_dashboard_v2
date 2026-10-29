/**
 * 🧪 모의매매(한국) 결정 로그의 주간 복기(/paper/kr/decisions → '주간 복기', 2단계 명세 §9 E3·F2) — 네 상태 이야기와 한국 표기.
 *
 *  - 불러오는 중: 복기 목록 전에는 읽는 중 — 목록은 ?market=KR(미국 복기가 섞이지 않음)
 *  - 빈 상태: 한국 복기가 없다고 말하고 최근 복기 주·열리는 시각(토요일 22:30)을, 달력이 그 해를 모르면 그 사유를 적음
 *  - 오류: 목록을 못 읽으면 오류 + 다시 시도
 *  - 자료: 복기 한 건(?market=KR)의 가정 진입 표(금융위 확정 시가·토스 잠정 시가·종가 근사 배지)와 계좌 수익률 비교('잠정 줄 포함'),
 *    수동 실행은 확인 창에 수동 문턱 → POST /api/paper/reviews/run?market=KR
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
    lastObservedAtKst: "2026-11-06 21:57 KST", positions: 2, staleCount: 0, stats: null, statsReason: null, benchmark: null, ...over,
  };
}

const OVERVIEW = {
  available: true, market: "KR", currency: "KRW", dormantReason: null, initialized: true, pendingBackfill: [], startDate: "2026-10-29",
  books: [book("kr_rules", { kind: "RULES" }), book("kr_claude", { kind: "CLAUDE" }), book("kr_bench_k200"), book("kr_bench_mix")],
  navSeries: { dates: [], books: {} }, quotes: null, selection: null, gate: null, claudeExposureSeries: [], frameworkBoundaries: [],
  limits: [], jobs: [],
};

const REVIEWS = {
  available: true, market: "KR", dormantReason: null, latestWeekEnding: "2026-11-06", latestOpensAtKst: "2026-11-07 22:30 KST",
  latestWeekEndingReason: null,
  reviews: [{
    weekEnding: "2026-11-06", status: "OK", windowWeeks: 4, model: "claude-sonnet-5-5", verdictCounts: { 유지: 1, 반증: 1, 판단불가: 0 },
    proposalId: null, proposalStatus: null, createdAtKst: "2026-11-07 22:35 KST", error: null, retryCount: 0, retryable: false,
    frameworkVersion: 0,
  }],
};

const INPUT = {
  inputVersion: 1, weekEnding: "2026-11-06",
  decisions: [
    { id: 1, asOf: "2026-11-02", orders: [
      { id: 4, ticker: "000660", side: "BUY", status: "REJECTED", rejectReason: "UNFILLABLE",
        hypothetical: { basis: "가정", entryDate: "2026-11-03", entryPrice: 180_000, entrySource: "FSC", isProxy: false, returnPct: 10 } },
      { id: 5, ticker: "207940", side: "BUY", status: "REJECTED", rejectReason: "MONTHLY_CAP",
        hypothetical: { basis: "가정", entryDate: "2026-11-03", entryPrice: 1_000_000, entrySource: null, isProxy: true, returnPct: 5 } },
    ] },
    { id: 6, asOf: "2026-11-05", orders: [
      { id: 7, ticker: "035720", side: "BUY", status: "REJECTED", rejectReason: "MONTHLY_CAP",
        hypothetical: { basis: "가정", entryDate: "2026-11-06", entryPrice: 40_000, entrySource: "TOSS_1M_OPEN", isProxy: false, returnPct: 5 } },
      // 거절된 매도 — 판 뒤 변화(기준일 종가 ÷ 가정 매도가 − 1)가 음수면 피한 하락(avoided)입니다(매수 손실이 아님).
      { id: 8, ticker: "005930", side: "SELL", status: "REJECTED", rejectReason: "MIN_HOLD",
        hypothetical: { basis: "가정", entryDate: "2026-11-06", entryPrice: 72_000, entrySource: "FSC", isProxy: false, returnPct: -3,
          afterSellLabel: "avoided" } },
    ] },
    // 값이 없는 가정 진입 — 그 이유는 주문 notes의 '가정 수익률:' 줄(서버 ReviewFacts)입니다.
    { id: 9, asOf: "2026-11-06", orders: [
      { id: 10, ticker: "051910", side: "BUY", status: "REJECTED", rejectReason: "MONTHLY_CAP",
        hypothetical: { basis: "가정", entryDate: "2026-11-09", entryPrice: null, entrySource: null, isProxy: null, returnPct: null },
        notes: ["가정 수익률: 결정 다음 세션(2026-11-09)이 복기 기준일 뒤"] },
    ] },
  ],
  comparison: { from: "2026-10-30", to: "2026-11-06", note: "순자산 수익률(%) — isEstimated = 확정 종가가 아닌 줄을 씀", books: [
    { book: "kr_rules", returnPct: 0.5, isEstimated: true }, { book: "kr_claude", returnPct: 1, isEstimated: true },
    { book: "kr_bench_mix", returnPct: null, isEstimated: null, reason: "복기 기준일(2026-11-06) 순자산 없음" },
  ] },
};

const DETAIL = {
  available: true, market: "KR",
  review: {
    weekEnding: "2026-11-06", status: "OK", windowWeeks: 4, trimmedReason: null, model: "claude-sonnet-5-5", frameworkVersion: 0,
    retryCount: 0, retryable: false, createdAtKst: "2026-11-07 22:35 KST", error: null, verdictCounts: { 유지: 1, 반증: 1, 판단불가: 0 },
    verdicts: [{ decisionId: 1, asOf: "2026-11-02", kind: "SCHEDULED", status: "OK", thesisHeld: "유지", note: "체결 뒤 +10.00%" }],
    missingDecisionIds: [], recurringErrors: [], keep: [], proposal: null, input: INPUT, response: { schemaVersion: 1 }, usage: null,
  },
};

const STATUS = {
  available: true, market: "KR", currency: "KRW", dormantReason: null, jobs: [],
  apiUsage: { today: { day: "2026-11-07", calls: 1, cap: 20, scheduledReserve: 7, manualLimit: 13, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0 }, month: { month: "2026-11", days: 1, calls: 1, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0 } },
};

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않는 요청. 긴 경로부터 맞춥니다. */
let reads: Record<string, () => Promise<unknown>> = {};

beforeEach(() => {
  reads = {};
  window.history.replaceState(null, "", "/paper/kr/decisions");
  reads["/api/paper/overview?market=KR"] = () => Promise.resolve(OVERVIEW);
  reads["/api/paper/decisions?book=kr_rules"] = () => Promise.resolve({ available: true, decisions: [] });
  reads["/api/paper/status?market=KR"] = () => Promise.resolve(STATUS);
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
    return key ? reads[key]() : new Promise(() => {});
  });
});

afterEach(() => cleanup());

const requested = () => api.apiGetShared.mock.calls.map(([path]) => String(path));

async function openReviews() {
  render(<PaperPage market="KR" initialTab="decisions" />);
  fireEvent.click(await screen.findByRole("button", { name: "주간 복기" }));
}

describe("불러오는 중", () => {
  it("복기 목록 전에는 읽는 중 — 목록은 ?market=KR(미국 복기 경로를 읽지 않음)", async () => {
    await openReviews();
    expect(await screen.findByText("주간 복기를 읽는 중…")).toBeTruthy();
    expect(requested()).toContain("/api/paper/reviews?market=KR");
    expect(requested()).not.toContain("/api/paper/reviews");
  });
});

describe("빈 상태", () => {
  it("한국 복기가 없다고 말하고 최근 복기 주·열리는 시각(토요일 22:30), 한국 일정 문구", async () => {
    reads["/api/paper/reviews?market=KR"] = () => Promise.resolve({ ...REVIEWS, reviews: [] });
    await openReviews();
    expect(await screen.findByText(/아직 한국 복기가 없습니다 — 한국 Claude 계좌가 출발한 다음 토요일 22:30/)).toBeTruthy();
    expect(screen.getByText("가장 최근 복기 주 2026-11-06 · 정기 복기 2026-11-07 22:30 — 아직 복기 없음.")).toBeTruthy();
    expect(screen.getByText(/토요일 22:30 KST — 그 주 마지막 KR 거래일/)).toBeTruthy();
    expect(screen.queryByText(/토요일 09:00\(KST\) 뒤/)).toBeNull();
  });

  it("달력이 그 해를 모르면 최근 복기 주 대신 그 사유", async () => {
    reads["/api/paper/reviews?market=KR"] = () => Promise.resolve({ ...REVIEWS, reviews: [], latestWeekEnding: null,
      latestOpensAtKst: null, latestWeekEndingReason: "달력 없음 — 2027년 KRX 공휴일 목록이 없습니다" });
    await openReviews();
    expect(await screen.findByText("가장 최근 복기 주 — — 달력 없음 — 2027년 KRX 공휴일 목록이 없습니다")).toBeTruthy();
  });
});

describe("오류", () => {
  it("목록을 못 읽으면 오류 + 다시 시도(누르면 다시 읽음)", async () => {
    let calls = 0;
    reads["/api/paper/reviews?market=KR"] = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("복기 목록을 읽지 못했습니다.")) : Promise.resolve({ ...REVIEWS, reviews: [] });
    };
    await openReviews();
    expect(await screen.findByText("복기 목록을 읽지 못했습니다.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /다시 시도/ }));
    expect(await screen.findByText(/아직 한국 복기가 없습니다/)).toBeTruthy();
  });
});

describe("자료", () => {
  beforeEach(() => {
    reads["/api/paper/reviews?market=KR"] = () => Promise.resolve(REVIEWS);
    reads["/api/paper/reviews/2026-11-06?market=KR"] = () => Promise.resolve(DETAIL);
  });

  it("복기 한 건(?market=KR) — 가정 진입 표의 출처·근사 배지와 계좌 수익률 비교의 '잠정 줄 포함'", async () => {
    await openReviews();
    const entries = await screen.findByRole("region", { name: "가정 진입 (좌우 스크롤)" });
    expect(requested()).toContain("/api/paper/reviews/2026-11-06?market=KR");
    const row = (ticker: string) => within(entries).getAllByRole("row").find((tr) => tr.textContent?.includes(ticker)) as HTMLElement;
    expect(within(row("000660")).getByText("금융위 확정 시가")).toBeTruthy();
    expect(within(row("000660")).getByText("180,000원")).toBeTruthy();
    expect(within(row("000660")).getByText("지금 체결할 수 없는 종목 매수 (UNFILLABLE)")).toBeTruthy();
    expect(within(row("207940")).getByText("종가 근사")).toBeTruthy();
    expect(within(row("035720")).getByText("토스 잠정 시가")).toBeTruthy();
    const comparison = screen.getByRole("list", { name: "계좌 수익률 비교" });
    expect(within(comparison).getAllByText("잠정 줄 포함")).toHaveLength(2);
    expect(screen.getByText("계좌 수익률 비교 (2026-10-30 → 2026-11-06)")).toBeTruthy();
  });

  // 예전에는 표에 방향 칸이 없고 안내가 '샀다고 가정'이라, 거절된 매도의 −3%(피한 하락)가 매수 손실처럼 읽혔습니다.
  it("거절된 매도 줄 — 방향 '매도'와 판 뒤 변화의 뜻('피한 하락'), 안내는 '체결됐다고 가정'(매수·매도 모두)", async () => {
    await openReviews();
    const entries = await screen.findByRole("region", { name: "가정 진입 (좌우 스크롤)" });
    const row = within(entries).getAllByRole("row").find((tr) => tr.textContent?.includes("005930")) as HTMLElement;
    expect(within(row).getByText("매도")).toBeTruthy();
    expect(within(row).getByText("-3.00%")).toBeTruthy();
    expect(within(row).getByText("피한 하락")).toBeTruthy();
    const buy = within(entries).getAllByRole("row").find((tr) => tr.textContent?.includes("000660")) as HTMLElement;
    expect(within(buy).getByText("매수")).toBeTruthy();
    expect(within(buy).queryByText(/피한 하락|놓친 상승/)).toBeNull();
    expect(screen.getByText(/거절된 주문\(매수·매도\)이 결정 다음 세션 시가에 체결됐다고 가정한 값/)).toBeTruthy();
    expect(screen.queryByText(/샀다고 가정/)).toBeNull();
  });

  // 수정 전에는 서버가 보낸 값 없음의 이유(비교 줄 reason·주문 notes의 '가정 수익률:')를 버리고 '—'만 그렸습니다(it.fails).
  it.fails("값이 없으면 서버가 보낸 이유를 곁에 — 가정 진입은 주문 notes의 '가정 수익률:' 줄, 계좌 수익률 비교는 reason", async () => {
    await openReviews();
    const entries = await screen.findByRole("region", { name: "가정 진입 (좌우 스크롤)" });
    const row = within(entries).getAllByRole("row").find((tr) => tr.textContent?.includes("051910")) as HTMLElement;
    expect(within(row).getByText("결정 다음 세션(2026-11-09)이 복기 기준일 뒤")).toBeTruthy();
    // 값이 있는 줄에는 이유를 붙이지 않습니다.
    const filled = within(entries).getAllByRole("row").find((tr) => tr.textContent?.includes("000660")) as HTMLElement;
    expect(within(filled).queryByText(/복기 기준일 뒤/)).toBeNull();
    const comparison = screen.getByRole("list", { name: "계좌 수익률 비교" });
    expect(within(comparison).getByText("복기 기준일(2026-11-06) 순자산 없음")).toBeTruthy();
  });

  it("수동 실행은 확인 창에 수동 문턱 → POST /api/paper/reviews/run?market=KR", async () => {
    api.apiPost.mockResolvedValueOnce({ ok: true, market: "KR", outcome: "ALREADY_REVIEWED", review: DETAIL.review });
    await openReviews();
    fireEvent.click(await screen.findByRole("button", { name: "지금 복기 실행" }));
    expect(await screen.findByText(/수동 문턱\(13회 — 하루 상한 − 정기 몫 예약\) 미만일 때만/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "복기 실행 확인" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/paper/reviews/run?market=KR"));
  });
});
