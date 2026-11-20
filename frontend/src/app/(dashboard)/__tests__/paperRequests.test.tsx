/**
 * 모의매매(/paper/us·/paper/kr) 화면의 요청 지킴 — 작업대 개편 P6(부분 재배치)이 머리·탭·목록-검사를 다시 짜도 탭마다 읽는 경로·횟수·간격과
 * 열 때 쓰기 0이 그대로인지 봅니다(계획 §4-1 P1). 개편 전 코드에서 통과시켜 두고, 개편 커밋들이 이 파일을 고치지 않고 통과해야 합니다.
 * 예외는 하나 — 프레임 제안의 기준 판 읽기가 '목록을 그릴 때'에서 '그 제안을 고를 때'로 바뀌는 것(명세 §7-1 '제안 기본 접힘'의 결과, 계획 §2-17)이고,
 * 그 사례만 그 커밋(작업대 P6 설정 갈래 — 프레임 재배치)에서 사유와 함께 고쳤습니다.
 *
 * - 열 때: 화면은 늘 개요(60초)를 읽고 한국은 종목 이름 표(600초)도 읽습니다. 탭은 처음 탭(initialTab — 주소로 바로 연 탭)으로 엽니다.
 * - 탭마다: 개요(상태 60초·장중 저장본·실행 감사 300초·계좌2 순자산 줄 60초), 보유·체결(보유·주문·체결 60초, 한국 순자산 줄·상태, 계좌2 실행 감사),
 *   결정 로그(목록 60초, 상태 — 미국 Claude 계좌1·계좌2와 한국, 한국 수동 결정 확인을 열 때 설정, 상세는 누를 때 한 번), 주간 복기(목록 60초,
 *   한국 상태, 고른 주 상세 한 번), 기관 선정(트랙레코드 300초)·종목 선정(한국 규칙 계좌 결정 300초 + 선정한 결정 상세), 프레임(판·제안·설정·
 *   메모 두 시장·두 판 비교, 대기가 아닌 제안의 기준 판은 그 제안을 고를 때), 메모(메모·설정), 설정(설정·바꾼 기록).
 * - 실시간 시세는 SSE(가짜 EventSource) — 주기 기본 10초(lib/livePrices DEFAULT_LIVE_SECONDS)로 장중 카드·보유 표의 종목을 엽니다.
 * - 간격: 걸린 채 남은 setInterval을 하나씩 불러 다시 읽은 경로를 모읍니다(1분 미만 타이머는 자동 갱신이 아니라 보지 않음 — 분 시계는 경로가 없음).
 * - 실제 계좌·ISA 탭은 이 파일 밖입니다(그 모듈의 시험·경계 시험이 지킴).
 *
 * 조작 도우미(계좌 상세 열기·결정 상세 열기·복기 주 고르기)는 개편 전 조작(행 펼침·'상세 펼치기'·'… 보기')과 개편 뒤 조작(줄 단추 — 목록-검사의
 * data-item-key·검사 칸 줄 단추 '… 자세히')을 함께 찾습니다 — 요청의 뜻(누르면 그 GET 한 번)만 봅니다.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return {
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    apiDelete: vi.fn(),
    apiGetShared: vi.fn(),
    // 실시간 시세 SSE 주소의 앞부분(같은 출처).
    apiBase: () => "",
    UnauthorizedError,
  };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 객체를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
// jsdom에서는 차트를 재지 못해 그림은 뺍니다(요청만 봄).
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  LineChart: () => null,
  MultiLineSeries: () => null,
  DonutChart: () => null,
}));

import PaperScreen from "@/components/screens/paper/PaperScreen";
import { resetLiveSecondsForTest } from "@/hooks/useLiveSeconds";
import { endpoints } from "@/lib/endpoints";

const US = endpoints.paper.market("US");
const KR = endpoints.paper.market("KR");

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };

function book(code: string, over: Record<string, unknown> = {}) {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000,
    cash: 200, nav: 100000, equityValue: 99800, exposurePct: 99.8, returnPct: 0,
    lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: STATS, benchmark: null, ...over,
  };
}

/** 미국 다섯 계좌 — 운영과 같은 꼴(계좌2 출발함). 모두 운용 중이라 시작 카드(프레임 읽기)가 없습니다. */
const US_BOOKS = [
  book("rules", { kind: "RULES", label: "규칙 계좌" }),
  book("claude", { kind: "CLAUDE", label: "Claude 계좌1" }),
  book("claude2", { kind: "CLAUDE", label: "Claude 계좌2", startedOn: "2026-10-31" }),
  book("bench_spy", { label: "SPY 계좌" }),
  book("bench_mix", { label: "60/40 계좌" }),
];

/** 한국 다섯 계좌(원 단위). */
const KR_BOOKS = [
  book("kr_rules", { kind: "RULES", label: "한국 규칙 계좌", initialCash: 100_000_000, nav: 100_000_000 }),
  book("kr_claude", { kind: "CLAUDE", label: "한국 Claude 계좌1", initialCash: 100_000_000, nav: 100_000_000 }),
  book("kr_claude2", { kind: "CLAUDE", label: "한국 Claude 계좌2", initialCash: 100_000_000, nav: 100_000_000 }),
  book("kr_bench_k200", { label: "KODEX 200 계좌", initialCash: 100_000_000, nav: 100_000_000 }),
  book("kr_bench_mix", { label: "한국 60/40 계좌", initialCash: 100_000_000, nav: 100_000_000 }),
];

function overview(books: unknown[], over: Record<string, unknown> = {}) {
  return {
    available: true, initialized: true, startDate: "2026-10-23", limits: ["모의 매매입니다."], jobs: [], pendingBackfill: [], books,
    navSeries: { dates: [], books: {} }, quotes: null, selection: null, gate: null, claudeExposureSeries: [], frameworkBoundaries: [],
    ...over,
  };
}

const SESSION = {
  phase: "REGULAR", sessionDate: "2026-10-30", openAtKst: "2026-10-30 22:30 KST", closeAtKst: "2026-10-31 05:00 KST",
  nextOpenAtKst: "2026-11-02 23:30 KST",
};

/** 장중 저장본 — 정규장, 규칙 계좌에 종목 하나(실시간 시세 SSE를 엶). */
function live(market: "US" | "KR", code: string, ticker: string) {
  return {
    available: true, market, currency: market === "KR" ? "KRW" : "USD", nowKst: "2026-10-30 23:59 KST", session: SESSION, isEstimated: true,
    quotes: { source: "시험", collectedAtKst: "2026-10-30 23:58 KST", refreshRequested: false, missing: [], error: null },
    books: [{
      code, label: code, status: "ACTIVE", initialCash: 100000, cash: 10000, nav: 100000, returnPct: 0,
      previousNav: 99000, previousTradingDate: "2026-10-29", dayChangePct: 1.01, basis: "LIVE", basisAtKst: "2026-10-30 23:58 KST",
      liveCount: 1, positionCount: 1,
      positions: [{ ticker, qty: 100, avgCost: 400, price: 420, priceAtKst: "2026-10-30 23:58 KST", priceBasis: "LIVE",
        value: 42000, weightPct: 42, returnPct: 5, previousClose: 410, dayChangePct: 2.44 }],
    }],
  };
}

function positions(bookRow: unknown, ticker: string) {
  return {
    available: true, book: bookRow, cash: 50, lockouts: [],
    positions: [{
      ticker, qty: 10, avgCost: 100, lastPrice: 101, lastPriceAtKst: "2026-10-24 05:00", marketValue: 1010,
      weightPct: 1, unrealizedPct: 1, highWatermark: 101, stopPrice: null, stopDistancePct: null,
      openedOn: "2026-10-23", holdingTradingDays: 1, priceStale: false, splitNote: null, cashLike: false,
    }],
  };
}

function decision(id: number, bookCode: string, over: Record<string, unknown> = {}) {
  return {
    id, book: bookCode, asOfTradingDate: "2026-10-23", kind: "SCHEDULED", status: "OK", decidedAtKst: "2026-10-24 09:12",
    model: null, frameworkVersion: null, settingsVersion: 1, selectionAsOf: "2026-10-23", targetExposurePct: null,
    summary: "합성 요약", orderCount: 1, rejectedCount: 0, pricesFinal: true, error: null, ...over,
  };
}

function reviewRow(weekEnding: string) {
  return {
    weekEnding, status: "OK", windowWeeks: 4, model: "claude-sonnet-5-5", verdictCounts: { 유지: 1, 반증: 0, 판단불가: 0 },
    proposalId: null, proposalStatus: null, createdAtKst: `${weekEnding} 21:05`, error: null, retryCount: 0, retryable: false, frameworkVersion: 1,
  };
}

const RENDERED = "# 투자 OS\n## 원칙\n1. 패킷의 숫자에서 출발한다.";
function version(n: number) {
  return {
    version: n, status: "USER", title: `판 ${n}`, body: { schemaVersion: 1, title: `판 ${n}`, status: "USER", principles: [], engines: [], guidance: "" },
    rendered: RENDERED, tokensEst: 1000, overBudget: false, changelog: `판 ${n} 바꾼 내용`, createdAtKst: "2026-10-25 12:00",
  };
}
const summary = (n: number) => ({ version: n, title: `판 ${n}`, changelog: `판 ${n} 바꾼 내용`, createdAtKst: "2026-10-25 12:00", sourceProposalId: null });

function proposal(id: number, status: string, baseVersion: number) {
  return {
    id, status, noteId: 12, model: "claude-sonnet-5-5", summary: `제안 ${id} 요약`, operations: [], assessment: [], beforeAfter: null, error: null,
    createdAtKst: "2026-10-25 11:00", decidedAtKst: status === "PENDING" ? null : "2026-10-26 11:00", resultVersion: null, baseVersion,
  };
}

const SETTINGS = { available: true, version: 2, body: { frameworkTokenBudget: 50000 }, defaults: {}, keys: [] };

/** 경로(정확히 일치) → 응답. 없는 경로는 끝나지 않는 요청(불러오는 중). */
let reads: Record<string, unknown> = {};
let setIntervals: ReturnType<typeof vi.spyOn>;
let clearIntervals: ReturnType<typeof vi.spyOn>;
/** 연 SSE 주소(가짜 EventSource). */
let streams: string[] = [];

class FakeEventSource {
  readyState = 1;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    streams.push(url);
  }
  addEventListener() {}
  close() {}
}

beforeEach(() => {
  reads = {};
  streams = [];
  signal.token = 0;
  window.localStorage.clear();
  resetLiveSecondsForTest();
  window.history.replaceState(null, "", "/paper/us");
  api.apiGet.mockReset();
  api.apiPost.mockReset();
  api.apiDelete.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("EventSource", FakeEventSource);
  setIntervals = vi.spyOn(globalThis, "setInterval");
  clearIntervals = vi.spyOn(globalThis, "clearInterval");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 곧바로 끝나는 응답과 그 뒤 effect를 끝까지 흘려보냅니다. */
async function settled() {
  for (let round = 0; round < 4; round += 1) await act(async () => {});
}

/** 부른 경로 목록(부른 차례 그대로). */
const calledPaths = () => (api.apiGetShared.mock.calls as unknown as [string][]).map(([path]) => path);
/** 경로마다 부른 횟수. */
function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const path of calledPaths()) out[path] = (out[path] ?? 0) + 1;
  return out;
}

/**
 * 걸린 채 남은(지우지 않은) 1분 이상 간격의 타이머를 하나씩 불러 다시 읽은 경로를 모읍니다 — 간격 → 그 간격의 타이머들이 읽은 경로 목록(정렬).
 * 1분 미만 타이머(경과 초 등)는 자동 갱신이 아니라 보지 않습니다. 분 시계(60초)는 경로가 없어 목록에 더하지 않습니다.
 */
async function refreshTimers(): Promise<Record<number, string[]>> {
  const cleared = new Set((clearIntervals.mock.calls as unknown as [unknown][]).map(([id]) => id));
  const calls = setIntervals.mock.calls as unknown as [() => void, number][];
  const results = setIntervals.mock.results as unknown as { value: unknown }[];
  const out: Record<number, string[]> = {};
  for (const [index, [callback, delay]] of calls.entries()) {
    if (typeof delay !== "number" || delay < 60_000 || cleared.has(results[index]?.value)) continue;
    const before = calledPaths().length;
    await act(async () => callback());
    const added = calledPaths().slice(before);
    if (added.length > 0) out[delay] = [...(out[delay] ?? []), ...added].sort();
  }
  return out;
}

/** 열 때 쓰기(POST·DELETE)가 없다. */
function expectNoWrites() {
  expect(api.apiPost).not.toHaveBeenCalled();
  expect(api.apiDelete).not.toHaveBeenCalled();
}

const decisionDetailPaths = () => calledPaths().filter((path) => /^\/api\/paper\/decisions\/\d+$/.test(path));

/** 계좌 상세를 엽니다 — 개편 전은 계좌 행의 펼침 단추('{계좌} 상세 보기'), 개편 뒤는 계좌 표의 줄 단추('{계좌} 자세히'). */
async function openAccount(label: string) {
  const name = new RegExp(`^${label} (상세 보기|자세히)`);
  fireEvent.click(await screen.findByRole("button", { name }));
}

/** 첫 결정의 상세를 엽니다 — 개편 전은 표 행의 '상세 펼치기', 개편 뒤는 시각순 목록의 줄 단추(목록-검사 data-item-key). */
async function openFirstDecision() {
  await waitFor(() => {
    const ready = screen.queryAllByRole("button", { name: /상세 펼치기/ }).length > 0 || document.querySelector("button[data-item-key]") !== null;
    expect(ready).toBe(true);
  });
  const expand = screen.queryAllByRole("button", { name: /상세 펼치기/ });
  fireEvent.click(expand[0] ?? document.querySelector<HTMLButtonElement>("button[data-item-key]")!);
}

/** 복기 주를 고릅니다 — 개편 전은 '{주} 보기', 개편 뒤는 시각순 목록의 그 주 줄 단추. */
async function pickReviewWeek(week: string) {
  await waitFor(() => {
    const ready = screen.queryAllByRole("button", { name: `${week} 보기` }).length > 0
      || document.querySelector(`button[data-item-key*="${week}"]`) !== null;
    expect(ready).toBe(true);
  });
  const button = screen.queryAllByRole("button", { name: `${week} 보기` })[0] ?? document.querySelector<HTMLButtonElement>(`button[data-item-key*="${week}"]`)!;
  fireEvent.click(button);
}

describe("모의매매(미국) — 탭마다 열 때 읽는 경로·횟수·간격", () => {
  const OVERVIEW = US.overview;
  const STATUS = US.status;
  const LIVE = US.live;

  beforeEach(() => {
    reads[OVERVIEW] = overview(US_BOOKS);
    reads[STATUS] = { available: true, enabled: true, jobs: [], settingsVersion: 7 };
  });

  it("개요: 개요·상태·장중 저장본·계좌2 실행 감사(1건)·계좌2 순자산 줄을 한 번씩 — 개요·상태·순자산 줄·장중 60초, 실행 감사 300초, 종목 가격은 SSE 10초", async () => {
    reads[LIVE] = live("US", "rules", "AAA");
    render(<PaperScreen initialTab="overview" market="US" />);
    await waitFor(() => expect(counts()[LIVE]).toBe(1));
    await settled();

    expect(counts()).toEqual({
      [OVERVIEW]: 1,
      [STATUS]: 1,
      [LIVE]: 1,
      [endpoints.paper.execution("claude2", 1)]: 1,
      [endpoints.paper.nav("claude2")]: 1,
    });
    expect(api.apiGet).not.toHaveBeenCalled();
    // 장중 카드의 종목(기본 계좌 = 규칙 계좌) 가격은 SSE — 기본 주기 10초.
    expect(streams).toEqual([endpoints.live.stream(["US:AAA"], 10)]);
    expectNoWrites();

    expect(await refreshTimers()).toEqual({
      60_000: [LIVE, OVERVIEW, STATUS, endpoints.paper.nav("claude2")].sort(),
      300_000: [endpoints.paper.execution("claude2", 1)],
    });
  });

  it("개요: 계좌 상세를 열면 그 계좌의 보유·최근 체결 5건·설정을 한 번씩(보유·체결 60초) — 개요는 다시 읽지 않는다", async () => {
    render(<PaperScreen initialTab="overview" market="US" />);
    await openAccount("SPY 계좌");
    await waitFor(() => expect(counts()[endpoints.paper.settings]).toBe(1));
    await settled();

    expect(counts()).toEqual({
      [OVERVIEW]: 1,
      [STATUS]: 1,
      [LIVE]: 1,
      [endpoints.paper.execution("claude2", 1)]: 1,
      [endpoints.paper.nav("claude2")]: 1,
      [endpoints.paper.positions("bench_spy")]: 1,
      [endpoints.paper.fills("bench_spy", 5)]: 1,
      [endpoints.paper.settings]: 1,
    });
    expectNoWrites();
    const timers = await refreshTimers();
    expect(timers[60_000]).toEqual(
      [OVERVIEW, STATUS, endpoints.paper.nav("claude2"), endpoints.paper.positions("bench_spy"), endpoints.paper.fills("bench_spy", 5)].sort(),
    );
  });

  it("보유·체결(기본 규칙 계좌): 보유·주문 50건·체결 50건을 한 번씩 60초마다, 보유 종목 가격은 SSE 10초", async () => {
    reads[endpoints.paper.positions("rules")] = positions(US_BOOKS[0], "BBB");
    render(<PaperScreen initialTab="holdings" market="US" />);
    await waitFor(() => expect(streams).toHaveLength(1));
    await settled();

    expect(counts()).toEqual({
      [OVERVIEW]: 1,
      [endpoints.paper.positions("rules")]: 1,
      [endpoints.paper.orders("rules", 50)]: 1,
      [endpoints.paper.fills("rules", 50)]: 1,
    });
    expect(streams).toEqual([endpoints.live.stream(["US:BBB"], 10)]);
    expectNoWrites();
    expect(await refreshTimers()).toEqual({
      60_000: [OVERVIEW, endpoints.paper.positions("rules"), endpoints.paper.orders("rules", 50), endpoints.paper.fills("rules", 50)].sort(),
    });
  });

  it("보유·체결: 계좌2를 고르면 그 계좌의 보유·주문·체결과 실행 감사(50건)를 한 번씩 60초마다", async () => {
    render(<PaperScreen initialTab="holdings" market="US" />);
    await waitFor(() => expect(counts()[endpoints.paper.positions("rules")]).toBe(1));
    fireEvent.change(screen.getByLabelText("계좌 고르기"), { target: { value: "claude2" } });
    await waitFor(() => expect(counts()[endpoints.paper.execution("claude2", 50)]).toBe(1));
    await settled();

    expect(counts()).toEqual({
      [OVERVIEW]: 1,
      [endpoints.paper.positions("rules")]: 1,
      [endpoints.paper.orders("rules", 50)]: 1,
      [endpoints.paper.fills("rules", 50)]: 1,
      [endpoints.paper.positions("claude2")]: 1,
      [endpoints.paper.orders("claude2", 50)]: 1,
      [endpoints.paper.fills("claude2", 50)]: 1,
      [endpoints.paper.execution("claude2", 50)]: 1,
    });
    expectNoWrites();
    expect((await refreshTimers())[60_000]).toEqual(
      [
        OVERVIEW,
        endpoints.paper.positions("claude2"),
        endpoints.paper.orders("claude2", 50),
        endpoints.paper.fills("claude2", 50),
        endpoints.paper.execution("claude2", 50),
      ].sort(),
    );
  });

  it("결정 로그(기본 규칙 계좌): 결정 50건 60초마다 — 상태는 읽지 않고, 상세는 누를 때 그 결정 한 건만 한 번", async () => {
    reads[endpoints.paper.decisions("rules", 50)] = { available: true, decisions: [decision(8, "rules"), decision(7, "rules")] };
    render(<PaperScreen initialTab="decisions" market="US" />);
    await waitFor(() => expect(counts()[endpoints.paper.decisions("rules", 50)]).toBe(1));
    await settled();

    expect(counts()).toEqual({ [OVERVIEW]: 1, [endpoints.paper.decisions("rules", 50)]: 1 });
    expect(decisionDetailPaths()).toEqual([]);

    await openFirstDecision();
    await waitFor(() => expect(decisionDetailPaths()).toHaveLength(1));
    await settled();
    expect(decisionDetailPaths()).toHaveLength(1);
    expect(["/api/paper/decisions/8", "/api/paper/decisions/7"]).toContain(decisionDetailPaths()[0]);
    expectNoWrites();
    // 상세는 주기 갱신하지 않습니다.
    expect(await refreshTimers()).toEqual({ 60_000: [OVERVIEW, endpoints.paper.decisions("rules", 50)].sort() });
  });

  it("결정 로그: Claude 계좌1·계좌2를 고르면 그 계좌의 결정과 상태를 60초마다", async () => {
    render(<PaperScreen initialTab="decisions" market="US" />);
    await waitFor(() => expect(counts()[endpoints.paper.decisions("rules", 50)]).toBe(1));
    fireEvent.change(screen.getByLabelText("계좌 고르기"), { target: { value: "claude" } });
    await waitFor(() => expect(counts()[STATUS]).toBe(1));
    fireEvent.change(screen.getByLabelText("계좌 고르기"), { target: { value: "claude2" } });
    await waitFor(() => expect(counts()[endpoints.paper.decisions("claude2", 50)]).toBe(1));
    await settled();

    expect(counts()).toEqual({
      [OVERVIEW]: 1,
      [endpoints.paper.decisions("rules", 50)]: 1,
      [endpoints.paper.decisions("claude", 50)]: 1,
      [endpoints.paper.decisions("claude2", 50)]: 1,
      // 계좌1·계좌2 모두 같은 상태 경로 — 바꿔도 다시 읽지 않습니다(같은 경로의 훅).
      [STATUS]: 1,
    });
    expectNoWrites();
    expect(await refreshTimers()).toEqual({ 60_000: [OVERVIEW, STATUS, endpoints.paper.decisions("claude2", 50)].sort() });
  });

  it("주간 복기: 복기 목록 60초마다 + 맨 위 주의 상세 한 번, 다른 주를 고르면 그 주의 상세 한 번 — 결정 목록은 뒤에서 그대로", async () => {
    reads[US.reviews] = { available: true, latestWeekEnding: "2026-11-15", reviews: [reviewRow("2026-11-15"), reviewRow("2026-11-08")] };
    render(<PaperScreen initialTab="decisions" market="US" />);
    await waitFor(() => expect(counts()[endpoints.paper.decisions("rules", 50)]).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "주간 복기" }));
    await waitFor(() => expect(counts()[US.review("2026-11-15")]).toBe(1));
    await settled();

    expect(counts()).toEqual({
      [OVERVIEW]: 1,
      [endpoints.paper.decisions("rules", 50)]: 1,
      [US.reviews]: 1,
      [US.review("2026-11-15")]: 1,
    });

    await pickReviewWeek("2026-11-08");
    await waitFor(() => expect(counts()[US.review("2026-11-08")]).toBe(1));
    await settled();
    expect(counts()[US.review("2026-11-15")]).toBe(1);
    expect(counts()[US.review("2026-11-08")]).toBe(1);
    expectNoWrites();
    // 복기 상세는 주기 갱신하지 않습니다(목록 행이 바뀔 때만 — lib/paper shouldReloadReviewDetail).
    expect(await refreshTimers()).toEqual({ 60_000: [OVERVIEW, endpoints.paper.decisions("rules", 50), US.reviews].sort() });
  });

  it("기관 선정: 트랙레코드를 한 번 300초마다", async () => {
    render(<PaperScreen initialTab="selection" market="US" />);
    await waitFor(() => expect(counts()[endpoints.paper.trackRecord()]).toBe(1));
    await settled();

    expect(counts()).toEqual({ [OVERVIEW]: 1, [endpoints.paper.trackRecord()]: 1 });
    expectNoWrites();
    expect(await refreshTimers()).toEqual({ 60_000: [OVERVIEW], 300_000: [endpoints.paper.trackRecord()] });
  });

  it("프레임: 판·제안·설정·메모 두 시장·두 판 비교(지금 판과 바로 앞 판)를 한 번씩 — 주기 갱신 없음", async () => {
    reads[endpoints.paper.framework] = { available: true, current: version(3), versions: [summary(3), summary(2), summary(1)] };
    reads[endpoints.paper.proposals] = { available: true, proposals: [] };
    reads[endpoints.paper.settings] = SETTINGS;
    render(<PaperScreen initialTab="framework" market="US" />);
    await waitFor(() => expect(counts()[endpoints.paper.frameworkVersion(2)]).toBe(1));
    await settled();

    expect(counts()).toEqual({
      [OVERVIEW]: 1,
      [endpoints.paper.framework]: 1,
      [endpoints.paper.proposals]: 1,
      [endpoints.paper.settings]: 1,
      [US.notes(false)]: 1,
      [KR.notes(false)]: 1,
      [endpoints.paper.frameworkVersion(3)]: 1,
      [endpoints.paper.frameworkVersion(2)]: 1,
    });
    expectNoWrites();
    expect(await refreshTimers()).toEqual({ 60_000: [OVERVIEW] });
  });

  it("프레임: 대기가 아닌 제안의 기준 판이 지금 판과 다르면 그 제안을 고를 때 한 번 — 목록을 그릴 때·대기 제안·지금 판 기준은 읽지 않음", async () => {
    // 이 파일에서 개편으로 바뀐 유일한 사례입니다 — 명세 §7-1 '제안 기본 접힘'(작업대 P6 설정 갈래, 계획 §2-17): 예전에는 목록을 그릴 때 제안마다 기준 판을
    // 읽어 이 자료로 열 때 기준 판 GET이 2회(#4 → v1, #2 → v0) 나갔고, 이제는 고르기 전에는 제안 상세를 그리지 않아 그 제안을 고를 때 한 번씩입니다.
    reads[endpoints.paper.framework] = { available: true, current: version(3), versions: [summary(3)] };
    reads[endpoints.paper.proposals] = {
      available: true,
      proposals: [proposal(5, "PENDING", 3), proposal(4, "APPROVED", 1), proposal(2, "REJECTED", 0), proposal(1, "REJECTED", 3)],
    };
    reads[endpoints.paper.settings] = SETTINGS;
    render(<PaperScreen initialTab="framework" market="US" />);
    await waitFor(() => expect(document.querySelector('button[data-item-key="4"]')).not.toBeNull());
    await settled();
    const versionReads = () => calledPaths().filter((path) => path.startsWith("/api/paper/framework/versions/")).sort();
    // 열 때는 두 판 비교의 오른쪽(지금 판 — 판이 하나여도 읽음)뿐.
    expect(versionReads()).toEqual([endpoints.paper.frameworkVersion(3)]);

    // 고를 때 — 결정된 제안의 기준 판(지금 판이 아님)을 한 번. 대기 제안(#5)·지금 판 기준(#1)은 고르더라도 읽지 않음.
    const pick = async (id: number) => {
      fireEvent.click(document.querySelector<HTMLButtonElement>(`button[data-item-key="${id}"]`)!);
      await screen.findByRole("dialog", { name: `제안 #${id}` });
      await settled();
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    };
    await pick(4);
    expect(versionReads()).toEqual([endpoints.paper.frameworkVersion(1), endpoints.paper.frameworkVersion(3)]);
    await pick(2);
    await pick(5);
    await pick(1);
    expect(versionReads()).toEqual([endpoints.paper.frameworkVersion(0), endpoints.paper.frameworkVersion(1), endpoints.paper.frameworkVersion(3)]);
    expectNoWrites();
  });

  it("메모: 미국 메모(유효한 것만)·설정을 한 번씩 — '만료한 메모도 보기'를 켜면 만료 포함 목록을 한 번", async () => {
    reads[US.notes(false)] = { available: true, notes: [] };
    reads[endpoints.paper.settings] = SETTINGS;
    render(<PaperScreen initialTab="notes" market="US" />);
    await waitFor(() => expect(counts()[US.notes(false)]).toBe(1));
    await settled();

    expect(counts()).toEqual({ [OVERVIEW]: 1, [US.notes(false)]: 1, [endpoints.paper.settings]: 1 });

    fireEvent.click(screen.getByLabelText("만료한 메모도 보기"));
    await waitFor(() => expect(counts()[US.notes(true)]).toBe(1));
    await settled();
    expect(counts()).toEqual({ [OVERVIEW]: 1, [US.notes(false)]: 1, [US.notes(true)]: 1, [endpoints.paper.settings]: 1 });
    expectNoWrites();
    expect(await refreshTimers()).toEqual({ 60_000: [OVERVIEW] });
  });

  it("설정: 설정·바꾼 기록을 한 번씩 — 주기 갱신 없음", async () => {
    render(<PaperScreen initialTab="settings" market="US" />);
    await waitFor(() => expect(counts()[endpoints.paper.settingsHistory]).toBe(1));
    await settled();

    expect(counts()).toEqual({ [OVERVIEW]: 1, [endpoints.paper.settings]: 1, [endpoints.paper.settingsHistory]: 1 });
    expectNoWrites();
    expect(await refreshTimers()).toEqual({ 60_000: [OVERVIEW] });
  });

  it("탭을 바꿔도 개요를 다시 읽지 않고, 떠난 탭의 자동 갱신은 멈춘다", async () => {
    render(<PaperScreen initialTab="overview" market="US" />);
    await waitFor(() => expect(counts()[STATUS]).toBe(1));
    fireEvent.click(screen.getByRole("tab", { name: "보유·체결" }));
    await waitFor(() => expect(counts()[endpoints.paper.positions("rules")]).toBe(1));
    fireEvent.click(screen.getByRole("tab", { name: "설정" }));
    await waitFor(() => expect(counts()[endpoints.paper.settingsHistory]).toBe(1));
    await settled();

    expect(counts()[OVERVIEW]).toBe(1);
    expect(counts()[STATUS]).toBe(1);
    expectNoWrites();
    // 지금 탭(설정)은 주기 갱신이 없고, 개요만 60초마다 — 개요 탭의 상태·보유 탭의 표는 떠날 때 멈춤.
    expect(await refreshTimers()).toEqual({ 60_000: [OVERVIEW] });
  });
});

describe("모의매매(한국) — 탭마다 열 때 읽는 경로·횟수·간격", () => {
  const OVERVIEW = KR.overview;
  const STATUS = KR.status;
  const NAMES = KR.names;
  const LIVE = KR.live;

  beforeEach(() => {
    window.history.replaceState(null, "", "/paper/kr");
    reads[OVERVIEW] = overview(KR_BOOKS, { market: "KR", currency: "KRW", dormantReason: null, startDate: "2026-10-29" });
    reads[STATUS] = { available: true, market: "KR", enabled: true, jobs: [], settingsVersion: 7, initialized: true };
    reads[NAMES] = { available: true, names: { "005930": "삼성전자" } };
  });

  it("개요: 개요·이름 표·상태·장중 저장본·계좌2 실행 감사(1건)를 한 번씩 — 이름 표 600초, 개요·상태·장중 60초, 실행 감사 300초, 종목 가격은 SSE 10초", async () => {
    reads[LIVE] = live("KR", "kr_rules", "005930");
    render(<PaperScreen initialTab="overview" market="KR" />);
    await waitFor(() => expect(counts()[LIVE]).toBe(1));
    await settled();

    expect(counts()).toEqual({
      [OVERVIEW]: 1,
      [NAMES]: 1,
      [STATUS]: 1,
      [LIVE]: 1,
      [endpoints.paper.execution("kr_claude2", 1)]: 1,
    });
    expect(streams).toEqual([endpoints.live.stream(["KR:005930"], 10)]);
    expectNoWrites();
    expect(await refreshTimers()).toEqual({
      60_000: [LIVE, OVERVIEW, STATUS].sort(),
      300_000: [endpoints.paper.execution("kr_claude2", 1)],
      600_000: [NAMES],
    });
  });

  it("개요: 계좌 상세를 열면 그 계좌의 보유·최근 체결 5건·설정을 한 번씩", async () => {
    render(<PaperScreen initialTab="overview" market="KR" />);
    await openAccount("KODEX 200 계좌");
    await waitFor(() => expect(counts()[endpoints.paper.settings]).toBe(1));
    await settled();

    expect(counts()[endpoints.paper.positions("kr_bench_k200")]).toBe(1);
    expect(counts()[endpoints.paper.fills("kr_bench_k200", 5)]).toBe(1);
    expect(counts()[endpoints.paper.settings]).toBe(1);
    expect(counts()[OVERVIEW]).toBe(1);
    expectNoWrites();
  });

  it("보유·체결(기본 규칙 계좌): 보유·주문·체결·순자산 줄·한국 상태를 한 번씩 60초마다", async () => {
    reads[endpoints.paper.positions("kr_rules")] = positions(KR_BOOKS[0], "005930");
    render(<PaperScreen initialTab="holdings" market="KR" />);
    await waitFor(() => expect(streams).toHaveLength(1));
    await settled();

    expect(counts()).toEqual({
      [OVERVIEW]: 1,
      [NAMES]: 1,
      [endpoints.paper.positions("kr_rules")]: 1,
      [endpoints.paper.orders("kr_rules", 50)]: 1,
      [endpoints.paper.fills("kr_rules", 50)]: 1,
      [endpoints.paper.nav("kr_rules")]: 1,
      [STATUS]: 1,
    });
    expect(streams).toEqual([endpoints.live.stream(["KR:005930"], 10)]);
    expectNoWrites();
    expect(await refreshTimers()).toEqual({
      60_000: [
        OVERVIEW,
        STATUS,
        endpoints.paper.positions("kr_rules"),
        endpoints.paper.orders("kr_rules", 50),
        endpoints.paper.fills("kr_rules", 50),
        endpoints.paper.nav("kr_rules"),
      ].sort(),
      600_000: [NAMES],
    });
  });

  it("결정 로그: 결정 50건·한국 상태 60초마다, Claude 계좌에서 '지금 결정 실행' 확인을 열면 설정을 한 번(쓰기 없음)", async () => {
    render(<PaperScreen initialTab="decisions" market="KR" />);
    await waitFor(() => expect(counts()[STATUS]).toBe(1));
    await settled();
    expect(counts()).toEqual({ [OVERVIEW]: 1, [NAMES]: 1, [endpoints.paper.decisions("kr_rules", 50)]: 1, [STATUS]: 1 });

    fireEvent.change(screen.getByLabelText("계좌 고르기"), { target: { value: "kr_claude" } });
    await waitFor(() => expect(counts()[endpoints.paper.decisions("kr_claude", 50)]).toBe(1));
    expect(counts()[endpoints.paper.settings]).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "지금 결정 실행" }));
    await waitFor(() => expect(counts()[endpoints.paper.settings]).toBe(1));
    await settled();

    expect(counts()).toEqual({
      [OVERVIEW]: 1,
      [NAMES]: 1,
      [endpoints.paper.decisions("kr_rules", 50)]: 1,
      [endpoints.paper.decisions("kr_claude", 50)]: 1,
      [STATUS]: 1,
      [endpoints.paper.settings]: 1,
    });
    // 확인 단계만 열었습니다 — Claude를 부르지 않음.
    expectNoWrites();
    expect(await refreshTimers()).toEqual({
      60_000: [OVERVIEW, STATUS, endpoints.paper.decisions("kr_claude", 50)].sort(),
      600_000: [NAMES],
    });
  });

  it("결정 로그: 상세는 누를 때 그 결정 한 건만 한 번", async () => {
    reads[endpoints.paper.decisions("kr_rules", 50)] = { available: true, decisions: [decision(31, "kr_rules"), decision(30, "kr_rules")] };
    render(<PaperScreen initialTab="decisions" market="KR" />);
    await waitFor(() => expect(counts()[endpoints.paper.decisions("kr_rules", 50)]).toBe(1));
    await settled();
    expect(decisionDetailPaths()).toEqual([]);

    await openFirstDecision();
    await waitFor(() => expect(decisionDetailPaths()).toHaveLength(1));
    await settled();
    expect(decisionDetailPaths()).toHaveLength(1);
    expect(["/api/paper/decisions/31", "/api/paper/decisions/30"]).toContain(decisionDetailPaths()[0]);
    expectNoWrites();
  });

  it("주간 복기: 한국 복기 목록·한국 상태 60초마다 + 맨 위 주의 상세 한 번, 다른 주를 고르면 그 주의 상세 한 번", async () => {
    reads[KR.reviews] = { available: true, latestWeekEnding: "2026-11-14", reviews: [reviewRow("2026-11-14"), reviewRow("2026-11-07")] };
    render(<PaperScreen initialTab="decisions" market="KR" />);
    await waitFor(() => expect(counts()[STATUS]).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "주간 복기" }));
    await waitFor(() => expect(counts()[KR.review("2026-11-14")]).toBe(1));
    await settled();

    expect(counts()).toEqual({
      [OVERVIEW]: 1,
      [NAMES]: 1,
      [endpoints.paper.decisions("kr_rules", 50)]: 1,
      // 결정 기록(뒤에 남은 훅)과 복기가 같은 상태 경로를 따로 읽음 — 앞 읽기가 끝난 뒤라 묶이지 않음(lib/sharedRequest는 동시에 나간 것만 묶음).
      [STATUS]: 2,
      [KR.reviews]: 1,
      [KR.review("2026-11-14")]: 1,
    });

    await pickReviewWeek("2026-11-07");
    await waitFor(() => expect(counts()[KR.review("2026-11-07")]).toBe(1));
    await settled();
    expect(counts()[KR.review("2026-11-14")]).toBe(1);
    expectNoWrites();
    expect(await refreshTimers()).toEqual({
      60_000: [OVERVIEW, STATUS, STATUS, endpoints.paper.decisions("kr_rules", 50), KR.reviews].sort(),
      600_000: [NAMES],
    });
  });

  it("종목 선정: 한국 규칙 계좌 결정 50건 300초마다 + 선정한 결정·가장 최근 결정의 상세를 한 번씩", async () => {
    reads[endpoints.paper.decisions("kr_rules", 50)] = {
      available: true,
      decisions: [
        decision(41, "kr_rules", { kind: "SCHEDULED", selectionAsOf: null }),
        decision(40, "kr_rules", { kind: "RESELECT", selectionAsOf: "2026-11-02" }),
      ],
    };
    render(<PaperScreen initialTab="selection" market="KR" />);
    await waitFor(() => expect(counts()[endpoints.paper.decisions("kr_rules", 50)]).toBe(1));
    await settled();

    expect(counts()).toEqual({
      [OVERVIEW]: 1,
      [NAMES]: 1,
      [endpoints.paper.decisions("kr_rules", 50)]: 1,
      [endpoints.paper.decision(40)]: 1,
      [endpoints.paper.decision(41)]: 1,
    });
    expectNoWrites();
    expect(await refreshTimers()).toEqual({
      60_000: [OVERVIEW],
      300_000: [endpoints.paper.decisions("kr_rules", 50)],
      600_000: [NAMES],
    });
  });

  it("프레임: 판·제안·설정·메모 두 시장·지금 판(비교)을 한 번씩(두 시장 공용 화면)", async () => {
    reads[endpoints.paper.framework] = { available: true, current: version(1), versions: [summary(1)] };
    reads[endpoints.paper.proposals] = { available: true, proposals: [] };
    reads[endpoints.paper.settings] = SETTINGS;
    render(<PaperScreen initialTab="framework" market="KR" />);
    await waitFor(() => expect(counts()[KR.notes(false)]).toBe(1));
    await settled();

    expect(counts()).toEqual({
      [OVERVIEW]: 1,
      [NAMES]: 1,
      [endpoints.paper.framework]: 1,
      [endpoints.paper.proposals]: 1,
      [endpoints.paper.settings]: 1,
      [US.notes(false)]: 1,
      [KR.notes(false)]: 1,
      // 두 판 비교의 오른쪽(지금 판) — 판이 하나여도 읽음.
      [endpoints.paper.frameworkVersion(1)]: 1,
    });
    expectNoWrites();
  });

  it("메모: 한국 메모(유효한 것만)·설정을 한 번씩", async () => {
    render(<PaperScreen initialTab="notes" market="KR" />);
    await waitFor(() => expect(counts()[KR.notes(false)]).toBe(1));
    await settled();

    expect(counts()).toEqual({ [OVERVIEW]: 1, [NAMES]: 1, [KR.notes(false)]: 1, [endpoints.paper.settings]: 1 });
    expectNoWrites();
    expect(await refreshTimers()).toEqual({ 60_000: [OVERVIEW], 600_000: [NAMES] });
  });

  it("설정: 설정·바꾼 기록을 한 번씩", async () => {
    render(<PaperScreen initialTab="settings" market="KR" />);
    await waitFor(() => expect(counts()[endpoints.paper.settingsHistory]).toBe(1));
    await settled();

    expect(counts()).toEqual({ [OVERVIEW]: 1, [NAMES]: 1, [endpoints.paper.settings]: 1, [endpoints.paper.settingsHistory]: 1 });
    expectNoWrites();
  });

  it("탭을 바꿔도 개요·이름 표를 다시 읽지 않는다", async () => {
    render(<PaperScreen initialTab="overview" market="KR" />);
    await waitFor(() => expect(counts()[STATUS]).toBe(1));
    fireEvent.click(screen.getByRole("tab", { name: "결정 로그" }));
    await waitFor(() => expect(counts()[endpoints.paper.decisions("kr_rules", 50)]).toBe(1));
    fireEvent.click(screen.getByRole("tab", { name: "메모" }));
    await waitFor(() => expect(counts()[KR.notes(false)]).toBe(1));
    await settled();

    expect(counts()[OVERVIEW]).toBe(1);
    expect(counts()[NAMES]).toBe(1);
    expectNoWrites();
    expect(await refreshTimers()).toEqual({ 60_000: [OVERVIEW], 600_000: [NAMES] });
  });
});
