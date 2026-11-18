/**
 * 교집합(/consensus)·스타일(/style)·스코어카드(/scorecard) 화면의 요청 지킴 — 작업대 개편(P5b 분석 갈래)이 화면을 다시 짜도 읽는 경로·횟수·자동 갱신 간격이
 * 그대로인지 봅니다. 개편 전 코드에서 먼저 통과시켜 두고, 개편 커밋들이 그대로 통과해야 합니다(계획 §5-4 '요청 지킴 시험').
 *
 * - 열 때: 화면마다 읽는 경로와 횟수 — 두 부품이 같은 경로를 따로 읽는 자리도 지금 값 그대로 적습니다(교집합의 원/달러 둘 — 화면과 신규 매수 패널,
 *   스타일의 기관별 성격 둘 — 성격 패널과 위험 패널의 기관 고르기). 시험의 목(apiGetShared)은 한 번 부를 때마다 셉니다 — 실제 브라우저에서는 같은
 *   경로를 동시에 읽으면 한 요청을 함께 씁니다(lib/sharedRequest).
 * - 자동 갱신: 1분 이상 간격의 타이머를 하나씩 불러 다시 읽은 경로를 봅니다(원/달러 2분만 — 나머지는 자동 갱신 없음).
 * - 조작 뒤에는 바뀐 조건의 경로만 한 번 더(나머지는 다시 읽지 않음).
 * 검사 칸 열기처럼 개편이 새로 두는 조작의 '+0' 사례는 그 조작을 두는 커밋에서 이 파일에 더합니다.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 객체를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
// jsdom에서는 차트를 재지 못해 그림은 뺍니다(요청은 차트 밖).
vi.mock("@/components/charts", () => ({
  HorizontalBars: () => null,
  HeatmapTable: () => null,
}));

import { endpoints } from "@/lib/endpoints";
import ConsensusPage from "../consensus/page";
import ScorecardPage from "../scorecard/page";
import GuruPage from "../style/page";

/** 경로 → 응답(정확히 일치). 없는 경로는 끝나지 않는 요청(불러오는 중). */
let reads: Record<string, unknown> = {};
let intervals: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  reads = {};
  signal.token = 0;
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  intervals = vi.spyOn(globalThis, "setInterval");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 부른 경로 목록(부른 차례 그대로). */
const calledPaths = () => (api.apiGetShared.mock.calls as unknown as [string][]).map(([path]) => path);
/** 경로마다 부른 횟수. */
function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const path of calledPaths()) out[path] = (out[path] ?? 0) + 1;
  return out;
}

/** 1분 이상 간격의 타이머(자동 갱신)를 하나씩 불러 다시 읽은 경로를 모읍니다 — 간격 → 그 타이머들이 읽은 경로 목록(정렬). */
async function refreshTimers(): Promise<Record<number, string[]>> {
  const out: Record<number, string[]> = {};
  const calls = intervals.mock.calls as unknown as [() => void, number][];
  for (const [callback, delay] of calls) {
    if (typeof delay !== "number" || delay < 60_000) continue;
    const before = calledPaths().length;
    await act(async () => callback());
    const added = calledPaths().slice(before);
    out[delay] = [...(out[delay] ?? []), ...added].sort();
  }
  return out;
}

const USDKRW = endpoints.macro.usdkrw;
const USDKRW_BODY = { available: true, rate: 1380.5, lastTs: "2026-11-04 20:19 KST" };

// ---------------------------------------------------------------- 교집합
const INSTITUTIONS = endpoints.institution.institutions;
const CONSENSUS = endpoints.institution.consensus({ minHolders: "2", topN: 40, ciks: "", reportDate: "" });
const NEW_BUYS = endpoints.institution.newBuys("3", "");

function consensusReads() {
  reads[INSTITUTIONS] = {
    institutions: [
      { key: "berkshire", name: "Berkshire", cik: "1", desc: "" },
      { key: "bridgewater", name: "Bridgewater", cik: "2", desc: "" },
      { key: "norges", name: "Norges", cik: "3", desc: "" },
    ],
  };
  reads[CONSENSUS] = {
    available: true, participants: ["Berkshire", "Bridgewater", "Norges"], participantCount: 3, availableDates: ["2026-06-30", "2026-03-31"],
    reportDate: null, minHolders: 2,
    rows: [{ key: "cusip:037833100", name: "APPLE INC", cusip: "037833100", holders: ["Berkshire", "Norges"], actions: ["유지", "확대"], holderCount: 2,
      totalValue: 1_000_000_000, avgWeight: 5.5, maxWeight: 9.1, buyCount: 1, sellCount: 0 }],
  };
  reads[NEW_BUYS] = {
    available: true, participants: ["Berkshire", "Bridgewater", "Norges"], participantCount: 3, availableDates: [], minHolders: 3,
    note: "13F는 분기 공시입니다.",
    rows: [{ key: "cusip:000000202", name: "SYNTHETIC NEW CO", cusip: "000000202", buyers: ["Berkshire", "Bridgewater", "Norges"], buyerCount: 3,
      totalValue: 300_000_000, avgWeight: 0.8, reportDate: "2026-06-30" }],
  };
  reads[USDKRW] = USDKRW_BODY;
}

describe("교집합 화면의 요청", () => {
  it("열 때 기관 목록·교집합·공통 신규 매수를 한 번씩, 원/달러는 두 부품이 한 번씩 — 자동 갱신은 원/달러만 2분", async () => {
    render(<ConsensusPage />);
    await waitFor(() => expect(calledPaths()).toHaveLength(5));
    expect(counts()).toEqual({ [INSTITUTIONS]: 1, [CONSENSUS]: 1, [NEW_BUYS]: 1, [USDKRW]: 2 });

    expect(await refreshTimers()).toEqual({ 120_000: [USDKRW, USDKRW] });
  });

  it("기관 하나를 빼면 남은 기관의 교집합만 한 번 더", async () => {
    consensusReads();
    render(<ConsensusPage />);
    await screen.findAllByText("APPLE INC");
    await waitFor(() => expect(calledPaths()).toHaveLength(5));

    fireEvent.click(await screen.findByRole("button", { name: "Berkshire" }));

    const next = endpoints.institution.consensus({ minHolders: "2", topN: 40, ciks: "2,3", reportDate: "" });
    await waitFor(() => expect(counts()[next]).toBe(1));
    expect(counts()).toEqual({ [INSTITUTIONS]: 1, [CONSENSUS]: 1, [NEW_BUYS]: 1, [USDKRW]: 2, [next]: 1 });
  });

  it("기준 분기를 고르면 교집합과 공통 신규 매수를 그 분기로 한 번씩 더", async () => {
    consensusReads();
    render(<ConsensusPage />);
    await screen.findByRole("option", { name: "2026-03-31" });
    await waitFor(() => expect(calledPaths()).toHaveLength(5));

    fireEvent.change(screen.getByLabelText("기준 분기"), { target: { value: "2026-03-31" } });

    const consensus = endpoints.institution.consensus({ minHolders: "2", topN: 40, ciks: "", reportDate: "2026-03-31" });
    const newBuys = endpoints.institution.newBuys("3", "2026-03-31");
    await waitFor(() => expect(counts()[newBuys]).toBe(1));
    expect(counts()).toEqual({ [INSTITUTIONS]: 1, [CONSENSUS]: 1, [NEW_BUYS]: 1, [USDKRW]: 2, [consensus]: 1, [newBuys]: 1 });
  });

  it("최소 공통 보유 기관 수는 교집합만, 신규 매수의 최소 기관 수는 공통 신규 매수만 한 번 더", async () => {
    consensusReads();
    render(<ConsensusPage />);
    await screen.findAllByText("APPLE INC");
    await waitFor(() => expect(calledPaths()).toHaveLength(5));

    fireEvent.change(screen.getByLabelText("최소 공통 보유 기관 수"), { target: { value: "3" } });
    const consensus = endpoints.institution.consensus({ minHolders: "3", topN: 40, ciks: "", reportDate: "" });
    await waitFor(() => expect(counts()[consensus]).toBe(1));

    fireEvent.change(screen.getByLabelText("최소 기관 수"), { target: { value: "4" } });
    const newBuys = endpoints.institution.newBuys("4", "");
    await waitFor(() => expect(counts()[newBuys]).toBe(1));
    expect(counts()).toEqual({ [INSTITUTIONS]: 1, [CONSENSUS]: 1, [NEW_BUYS]: 1, [USDKRW]: 2, [consensus]: 1, [newBuys]: 1 });
  });
});

describe("교집합 화면의 요청 — 검사 칸(P5b)", () => {
  it("종목 이름으로 검사 대화상자를 열어도(교집합·공통 신규 매수) 요청은 늘지 않는다 — 받은 값만 보임", async () => {
    consensusReads();
    render(<ConsensusPage />);
    await screen.findAllByText("APPLE INC");
    await screen.findAllByText("SYNTHETIC NEW CO");
    await waitFor(() => expect(calledPaths()).toHaveLength(5));

    fireEvent.click(screen.getByRole("button", { name: "APPLE INC" }));
    expect(await screen.findByRole("dialog", { name: "APPLE INC" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "SYNTHETIC NEW CO" }));
    expect(await screen.findByRole("dialog", { name: "SYNTHETIC NEW CO" })).toBeTruthy();
    await act(async () => {});

    expect(counts()).toEqual({ [INSTITUTIONS]: 1, [CONSENSUS]: 1, [NEW_BUYS]: 1, [USDKRW]: 2 });
  });
});

// ---------------------------------------------------------------- 스타일
const PROFILES = endpoints.institution.guruProfiles;
const SIMILARITY = endpoints.institution.guruSimilarity;
const RISK = endpoints.institution.guruRisk("0001067983", "SPY", "1");

function styleReads() {
  reads[PROFILES] = {
    available: true, note: "13F 저장본 기준",
    rows: [
      { cik: "0001067983", key: "berkshire", name: "버크셔 해서웨이", desc: "가치 투자", reportDate: "2026-06-30", totalValue: 2.5e11, holdingCount: 40,
        effectiveHoldings: 8.2, hhi: 0.12, top10Weight: 88.1, turnover: 3.2, quarterCount: 8 },
      { cik: "0001350694", key: "bridgewater", name: "브리지워터", desc: "매크로", reportDate: "2026-06-30", totalValue: 2.0e10, holdingCount: 700,
        effectiveHoldings: 60.5, hhi: 0.0165, top10Weight: 40.2, turnover: null, quarterCount: 1 },
    ],
  };
  reads[SIMILARITY] = {
    available: true, note: "겹침·코사인",
    institutions: [
      { cik: "0001067983", key: "berkshire", name: "버크셔 해서웨이", reportDate: "2026-06-30" },
      { cik: "0001350694", key: "bridgewater", name: "브리지워터", reportDate: "2026-06-30" },
    ],
    overlap: [[100, 12.5], [12.5, 100]],
    cosine: [[1, 0.31], [0.31, 1]],
    topPairs: [],
  };
  reads[RISK] = {
    available: true, cik: "0001067983", benchmark: "SPY", years: 1, collectedAtKst: "2026-11-04 19:40 KST", ageSeconds: 60, stale: false,
    coverage: { holdings: 30, totalHoldings: 40, weight: 78.1, totalWeight: 100, uncovered: [], uncoveredCount: 0 },
    metrics: { volatility: 14.2, var95: -1.13, var99: -1.92, es95: -1.63, es99: -2.27, maxDrawdown: 7.64, beta: 0.82, trackingError: 6.1, samples: 250,
      from: "2025-11-04", to: "2026-11-04" },
    contributions: [{ ticker: "AAPL", name: "APPLE INC", sector: "Technology", weight: 22.1, volatility: 24.0, marginal: 0.3, contribution: 4.1, share: 28.9 }],
    sectors: [{ sector: "Technology", weight: 40.2 }],
  };
  reads[USDKRW] = USDKRW_BODY;
}

describe("스타일 화면의 요청", () => {
  it("열 때 기관별 성격은 두 부품이 한 번씩, 유사도·위험(버크셔·SPY·1년)·원/달러는 한 번씩 — 자동 갱신은 원/달러만 2분, 보유 기관 검색은 찾기 전에 부르지 않음", async () => {
    render(<GuruPage />);
    await waitFor(() => expect(calledPaths()).toHaveLength(5));
    expect(counts()).toEqual({ [PROFILES]: 2, [SIMILARITY]: 1, [RISK]: 1, [USDKRW]: 1 });

    expect(await refreshTimers()).toEqual({ 120_000: [USDKRW] });
  });

  it("'새로고침'은 기관별 성격만 한 번 더(위험 패널의 기관 목록·유사도·위험은 다시 읽지 않음)", async () => {
    styleReads();
    render(<GuruPage />);
    await screen.findByRole("option", { name: "브리지워터" });
    await waitFor(() => expect(calledPaths()).toHaveLength(5));

    fireEvent.click(screen.getByRole("button", { name: /새로고침$/ }));

    await waitFor(() => expect(counts()[PROFILES]).toBe(3));
    expect(counts()).toEqual({ [PROFILES]: 3, [SIMILARITY]: 1, [RISK]: 1, [USDKRW]: 1 });
  });

  it("'다시 계산'은 같은 위험을, 기관·벤치마크·측정 구간 고르기는 바뀐 조건의 위험을 한 번씩 더 — 다른 경로는 다시 읽지 않음", async () => {
    styleReads();
    render(<GuruPage />);
    await screen.findByRole("option", { name: "브리지워터" });
    await waitFor(() => expect(calledPaths()).toHaveLength(5));

    fireEvent.click(screen.getByRole("button", { name: "다시 계산" }));
    await waitFor(() => expect(counts()[RISK]).toBe(2));

    fireEvent.change(screen.getByLabelText("기관"), { target: { value: "0001350694" } });
    const byInstitution = endpoints.institution.guruRisk("0001350694", "SPY", "1");
    await waitFor(() => expect(counts()[byInstitution]).toBe(1));

    fireEvent.change(screen.getByLabelText("벤치마크"), { target: { value: "QQQ" } });
    const byBenchmark = endpoints.institution.guruRisk("0001350694", "QQQ", "1");
    await waitFor(() => expect(counts()[byBenchmark]).toBe(1));

    fireEvent.change(screen.getByLabelText("측정 구간"), { target: { value: "2" } });
    const byYears = endpoints.institution.guruRisk("0001350694", "QQQ", "2");
    await waitFor(() => expect(counts()[byYears]).toBe(1));

    expect(counts()).toEqual({
      [PROFILES]: 2, [SIMILARITY]: 1, [RISK]: 2, [USDKRW]: 1, [byInstitution]: 1, [byBenchmark]: 1, [byYears]: 1,
    });
  });

  it("유사도 '기준'을 바꾸면 요청이 없다(받은 두 행렬 가운데 고름)", async () => {
    styleReads();
    render(<GuruPage />);
    await screen.findByRole("option", { name: "코사인 유사도" });
    await waitFor(() => expect(calledPaths()).toHaveLength(5));

    fireEvent.change(screen.getByLabelText("기준"), { target: { value: "cosine" } });
    await act(async () => {});

    expect(counts()).toEqual({ [PROFILES]: 2, [SIMILARITY]: 1, [RISK]: 1, [USDKRW]: 1 });
  });

  it("'찾기'는 적은 종목명으로 보유 기관을 한 번 읽는다", async () => {
    styleReads();
    render(<GuruPage />);
    await waitFor(() => expect(calledPaths()).toHaveLength(5));

    fireEvent.change(screen.getByPlaceholderText("NVIDIA"), { target: { value: "NVIDIA" } });
    fireEvent.click(screen.getByRole("button", { name: "찾기" }));

    const holders = endpoints.institution.guruHolders("NVIDIA");
    await waitFor(() => expect(counts()[holders]).toBe(1));
    expect(counts()).toEqual({ [PROFILES]: 2, [SIMILARITY]: 1, [RISK]: 1, [USDKRW]: 1, [holders]: 1 });
  });
});

// ---------------------------------------------------------------- 스코어카드
const UNIVERSE = endpoints.insight.stockUniverse;
const SCORECARD = endpoints.insight.scorecard("AAPL", "SPY", "1");

function scorecardReads() {
  reads[UNIVERSE] = {
    available: true, universeLabel: "S&P 500 대형주",
    rows: [
      { ticker: "AAPL", name: "Apple Inc.", sector: "Technology" },
      { ticker: "MSFT", name: "Microsoft Corp.", sector: "Technology" },
    ],
  };
  reads[SCORECARD] = {
    available: true, symbol: "AAPL", name: "Apple Inc.", sector: "Technology", benchmark: "SPY", years: 1, universeLabel: "S&P 500 대형주", universeSize: 136,
    missing: ["재무 안정성"], caveat: "가격으로 잴 수 있는 것만 담은 카드입니다.", collectedAtKst: "2026-11-04 19:40 KST", ageSeconds: 60, stale: false,
    metrics: [{ label: "12개월 모멘텀", how: "12개월 수익률", value: 12.3, unit: "%", score: 71, direction: "높을수록 좋음" }],
    priceScore: 71, scoredCount: 1, raw: { momentum1m: -0.297, momentum6m: 4.1, beta: 1.12, samples: 250 },
  };
}

describe("스코어카드 화면의 요청", () => {
  it("열 때 종목 목록과 스코어카드(AAPL·SPY·1년)를 한 번씩 — 자동 갱신 없음", async () => {
    render(<ScorecardPage />);
    await waitFor(() => expect(calledPaths()).toHaveLength(2));
    expect(counts()).toEqual({ [UNIVERSE]: 1, [SCORECARD]: 1 });

    expect(await refreshTimers()).toEqual({});
  });

  it("종목·베타 기준·측정 구간을 고르면 바뀐 조건의 스코어카드만 한 번씩 더(종목 목록은 다시 읽지 않음)", async () => {
    scorecardReads();
    render(<ScorecardPage />);
    await screen.findByRole("option", { name: "MSFT · Microsoft Corp." });
    await waitFor(() => expect(calledPaths()).toHaveLength(2));

    fireEvent.change(screen.getByLabelText("종목"), { target: { value: "MSFT" } });
    const bySymbol = endpoints.insight.scorecard("MSFT", "SPY", "1");
    await waitFor(() => expect(counts()[bySymbol]).toBe(1));

    fireEvent.change(screen.getByLabelText("베타 기준"), { target: { value: "QQQ" } });
    const byBenchmark = endpoints.insight.scorecard("MSFT", "QQQ", "1");
    await waitFor(() => expect(counts()[byBenchmark]).toBe(1));

    fireEvent.change(screen.getByLabelText("측정 구간"), { target: { value: "2" } });
    const byYears = endpoints.insight.scorecard("MSFT", "QQQ", "2");
    await waitFor(() => expect(counts()[byYears]).toBe(1));

    expect(counts()).toEqual({ [UNIVERSE]: 1, [SCORECARD]: 1, [bySymbol]: 1, [byBenchmark]: 1, [byYears]: 1 });
  });
});
