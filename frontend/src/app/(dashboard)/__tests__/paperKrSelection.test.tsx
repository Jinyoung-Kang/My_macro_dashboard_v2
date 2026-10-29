/**
 * 🧪 모의매매(한국) 종목 선정 탭(/paper/kr/selection, 2단계 명세 §4-6·§5·§6 — 한국 규칙 계좌 재선정) — 네 상태 이야기.
 *
 *  - 불러오는 중: 결정 기록·선정 기록이 오기 전에는 읽는 중 표시
 *  - 빈 상태(출발 전): 선정 기록이 없다고 말하고 첫 선정은 출발 결정이라고 안내(상세는 읽지 않음)
 *  - 오류: 결정 기록·선정 기록(상세) 각각 오류 + 다시 시도
 *  - 자료: 선정 요약(주식·153130 비중·후보 수/상한)·매수 목표(이름)·고르지 않은 후보, '금융업 코드 표 확인 필요' 경고를 위에, 제외 표,
 *    '자료 없음' 사유, 구성원 표(정렬), 가장 최근 결정이 재선정일이 아니면 '참고 — 매수하지 않음' 후보 줄
 *  - 탭 이름은 '종목 선정'(키 selection 그대로), 미국 기관 선정(트랙레코드)을 읽지 않음
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

const OVERVIEW = {
  available: true, market: "KR", currency: "KRW", dormantReason: null, initialized: true, pendingBackfill: [],
  startDate: "2026-10-29", books: BOOKS, navSeries: { dates: [], books: {} }, quotes: null, selection: null, gate: null,
  claudeExposureSeries: [], frameworkBoundaries: [], limits: [], jobs: [],
};

function summary(id: number, over: Record<string, unknown> = {}) {
  return {
    id, book: "kr_rules", asOfTradingDate: "2026-11-02", kind: "REBALANCE", status: "OK", decidedAtKst: "2026-11-02 22:31 KST",
    model: null, frameworkVersion: null, settingsVersion: 4, selectionAsOf: "2026-11-02", targetExposurePct: 80,
    summary: "재선정(주기 2026-11-02) — 후보 2 · 매수 종목 1(주식 80.0%)", orderCount: 2, rejectedCount: 0, pricesFinal: false,
    error: null, ...over,
  };
}

const flows = (foreign20: number | null, institution20: number | null, streak: number | null) => ({
  days: 20, foreign20, institution20, foreign5: foreign20 === null ? null : Math.round(foreign20 / 4),
  institution5: institution20 === null ? null : Math.round(institution20 / 4), streak, sessionUpdatedAt: "2026-11-02T20:41:00+09:00",
});
const dart = (roePct: number | null, debtRatioPct: number | null, financialSector = false) => ({
  bsnsYear: "2025", rceptNo: "20260315000123", receiptDate: "2026-03-15", roePct, debtRatioPct, financialSector,
  hasCurrentAssetsAccount: !financialSector, capitalImpaired: false,
});

const MEMBERS = [
  {
    rank: 1, code: "005930", name: "삼성전자", marketCap: 512_345_000_000_000, listedShares: 5_969_782_550,
    flows: flows(12_340_000, 3_100_000, 6), dart: dart(9.1, 26.4), score: 0.002586, candidate: true, reasons: [],
  },
  {
    rank: 2, code: "000660", name: "SK하이닉스", marketCap: 140_120_000_000_000, listedShares: 728_002_365,
    flows: flows(1_250_000, 420_000, 4), dart: dart(18.2, 61.0), score: 0.002294, candidate: true, reasons: [],
  },
  {
    rank: 7, code: "323410", name: "카카오뱅크", marketCap: 12_400_000_000_000, listedShares: 476_970_000,
    flows: flows(800_000, 150_000, 3), dart: { ...dart(7.2, 1045.2), hasCurrentAssetsAccount: false }, score: 0.001992,
    candidate: false,
    reasons: [{
      reason: "재무 미달", sub: "부채비율 상한 초과",
      detail: "부채비율 1045.2% > 상한 200%(금융업 코드 표 밖) — '유동자산' 계정 없음: 금융업 코드 표 확인 필요",
    }],
  },
  {
    rank: 12, code: "035720", name: "카카오", marketCap: 18_600_000_000_000, listedShares: 443_000_000,
    flows: flows(-320_000, 90_000, 0), dart: null, score: null, candidate: false,
    reasons: [
      { reason: "수급 미달", sub: "수급 미달", detail: "20일 외국인 -320,000주 · 기관 +90,000주 — 둘 다 0보다 커야 함" },
      { reason: "자료 없음", sub: "DART 없음", detail: "DART 없음(DART 주요계정 저장본에 그 회사가 없음)" },
    ],
  },
];

const SELECTION_DETAIL = {
  available: true,
  decision: {
    ...summary(40),
    response: {
      summary: "재선정(주기 2026-11-02) — 후보 2 · 매수 종목 1(주식 80.0%)", book: "kr_rules", kind: "REBALANCE",
      asOfTradingDate: "2026-11-02", timing: "NEXT_OPEN", selectionDay: true, cycleDate: "2026-11-02", selectionAsOf: "2026-11-02",
      catchUp: false,
      input: {
        session: "2026-11-02", readAtKst: "2026-11-02 22:30 KST",
        universe: { baseDate: "2026-10-30", rule: "kospi-mcap-top100-common/v3", size: 100 },
        flowsWindow: { from: "2026-10-02", to: "2026-11-02", tradingDays: 20 },
        flowsStatus: { collectedAtKst: "2026-11-02 20:41 KST", session: "2026-11-02", universeDate: "2026-10-30" },
        dart: { collectedAtKst: "2026-11-01 04:10 KST", companies: 100, receiptRule: "접수일(rceptNo 앞 8자리) ≤ 기준 세션 2026-11-02만" },
        financialSectorTable: "kr-financial-sector/2026-10-28", excludedFlowRecords: { afterSession: 0, fetchedAfterRead: 2, unknownFetchedAt: 0 },
        lockedOut: [{ code: "000660", until: "2026-11-10" }], suspended: [], members: MEMBERS, outsideUniverse: [],
      },
      selection: {
        maxNames: 1, weighting: "EQUAL", candidates: [{ code: "005930", universeRank: 1, score: 0.002586 }, { code: "000660", universeRank: 2, score: 0.002294 }],
        exclusionCounts: { "수급 미달": 41, "자료 없음": 3, "재무 미달": 9 },
        targets: [{ code: "005930", rankInPlan: 1, score: 0.002586, weightPct: 80 }], notChosen: ["000660"],
        stockWeightPct: 80, parkingWeightPct: 20,
      },
      holdings: [], orders: [], skipped: [], notes: ["결정 뒤에 알 수 있던 수급 기록 2건을 뺌"], settings: {},
    },
    packet: null, packetHash: null, usage: null, noteIds: [], latencyMs: null, retryCount: 0,
  },
  orders: [],
};

const LATEST_DETAIL = {
  available: true,
  decision: {
    ...summary(45, { asOfTradingDate: "2026-11-04", kind: "SCHEDULED", status: "NO_TRADE", selectionAsOf: null, targetExposurePct: null,
      summary: "주문 없음 — 매도 신호 없음(재선정일 아님)" }),
    response: {
      summary: "주문 없음 — 매도 신호 없음(재선정일 아님)", book: "kr_rules", kind: "SCHEDULED", asOfTradingDate: "2026-11-04",
      selectionDay: false, input: { members: MEMBERS },
      selection: { maxNames: 1, weighting: "EQUAL", candidates: [{ code: "000660", universeRank: 2, score: 0.0031 }], exclusionCounts: {},
        targets: null, note: "재선정일이 아님 — 후보·점수는 참고(매수하지 않음)" },
      holdings: [], orders: [], skipped: [], notes: [], settings: {},
    },
    packet: null, packetHash: null, usage: null, noteIds: [], latencyMs: null, retryCount: 0,
  },
  orders: [],
};

let reads: Record<string, () => Promise<unknown>> = {};

beforeEach(() => {
  reads = { "/api/paper/overview?market=KR": () => Promise.resolve(OVERVIEW) };
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path === prefix || path.startsWith(`${prefix}`));
    return key ? reads[key]() : Promise.reject(new Error(`예상하지 않은 경로 ${path}`));
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderSelection = () => render(<PaperPage market="KR" initialTab="selection" />);

describe("한국 종목 선정 탭", () => {
  it("불러오는 중: 결정 기록이 오기 전에는 읽는 중 표시, 탭 이름은 '종목 선정'", async () => {
    reads["/api/paper/decisions?book=kr_rules&limit=50"] = () => new Promise(() => {});
    renderSelection();
    expect(await screen.findByText("한국 규칙 계좌 결정 기록을 읽는 중…")).toBeTruthy();
    const tab = screen.getByRole("tab", { name: "종목 선정" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("tab", { name: /기관 선정/ })).toBeNull();
    // 미국 13F 트랙레코드는 읽지 않습니다.
    expect(api.apiGetShared.mock.calls.map(([path]) => path)).not.toContainEqual(expect.stringContaining("track-record"));
  });

  it("빈 상태(출발 전): 선정 기록이 없고 첫 선정은 출발 결정 — 상세는 읽지 않음", async () => {
    reads["/api/paper/decisions?book=kr_rules&limit=50"] = () => Promise.resolve({ available: true, decisions: [] });
    renderSelection();
    expect(await screen.findByText(/아직 한국 규칙 계좌의 선정 기록이 없습니다 — 첫 선정은 출발 결정입니다/)).toBeTruthy();
    expect(api.apiGetShared.mock.calls.map(([path]) => path)).not.toContainEqual(expect.stringMatching(/^\/api\/paper\/decisions\/\d+/));
    expect(screen.queryByText(/참고 — 매수하지 않음/)).toBeNull();
  });

  it("오류: 결정 기록을 못 읽으면 오류 + 다시 시도", async () => {
    let fail = true;
    reads["/api/paper/decisions?book=kr_rules&limit=50"] = () => (fail
      ? Promise.reject(new Error("결정 기록 응답 500"))
      : Promise.resolve({ available: true, decisions: [] }));
    renderSelection();
    expect(await screen.findByText("결정 기록 응답 500")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText(/아직 한국 규칙 계좌의 선정 기록이 없습니다/)).toBeTruthy();
  });

  it("오류: 선정 기록(상세)을 못 읽으면 그 번호와 함께 오류 + 다시 시도", async () => {
    reads["/api/paper/decisions?book=kr_rules&limit=50"] = () => Promise.resolve({ available: true, decisions: [summary(40)] });
    let fail = true;
    reads["/api/paper/decisions/40"] = () => (fail ? Promise.reject(new Error("상세 응답 500")) : Promise.resolve(SELECTION_DETAIL));
    renderSelection();
    expect(await screen.findByText("선정 기록(#40)을 읽지 못했습니다 — 상세 응답 500")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByRole("region", { name: "선정 요약" })).toBeTruthy();
  });

  it("자료: 선정 요약·목표·경고·제외·자료 없음·구성원 표, 가장 최근 결정의 후보는 '참고 — 매수하지 않음'", async () => {
    reads["/api/paper/decisions?book=kr_rules&limit=50"] = () => Promise.resolve({
      available: true, decisions: [summary(45, { asOfTradingDate: "2026-11-04", kind: "SCHEDULED", selectionAsOf: null }), summary(40)],
    });
    reads["/api/paper/decisions/40"] = () => Promise.resolve(SELECTION_DETAIL);
    reads["/api/paper/decisions/45"] = () => Promise.resolve(LATEST_DETAIL);
    renderSelection();

    const summaryPart = await screen.findByRole("region", { name: "선정 요약" });
    expect(within(summaryPart).getByText("80.00%")).toBeTruthy();
    expect(within(summaryPart).getByText("20.00%")).toBeTruthy();
    expect(within(summaryPart).getByText("2종목")).toBeTruthy();
    // 머리 칸 — 결정 번호·종류(재선정일)·선정 기준일.
    expect(screen.getByText("#40")).toBeTruthy();
    expect(screen.getByText("종류").nextElementSibling?.textContent).toBe("재선정일");

    // 매수 목표에는 이름이 붙고, 고르지 않은 후보도 이름과 함께.
    const targets = screen.getByRole("region", { name: "매수 목표" });
    expect(within(targets).getByText("삼성전자")).toBeTruthy();
    expect(screen.getByText(/후보였지만 고르지 않음/).parentElement?.textContent).toContain("000660 SK하이닉스");

    // '금융업 코드 표 확인 필요' 경고는 위에 모입니다.
    const warning = screen.getByRole("list", { name: "금융업 코드 표 확인 필요" });
    expect(within(warning).getByText("323410 카카오뱅크")).toBeTruthy();

    // 제외 표·자료 없음 사유.
    expect(screen.getByText("41종목")).toBeTruthy();
    const noData = screen.getByRole("list", { name: "자료 없음 사유" });
    expect(noData.textContent).toContain("035720 카카오 — DART 없음(DART 주요계정 저장본에 그 회사가 없음)");

    // 구성원 표 — 정렬 단추가 있고 모르는 값은 "—", 매수 목표는 '매수 목표'.
    const table = screen.getByRole("table", { name: "유니버스 구성원" });
    // 판정과 그 까닭(후보·점수·사유)이 종목 바로 뒤 — 열 열넷이라 데스크톱에서도 넘쳐, 넘겨 보지 않아도 보이게.
    expect(within(table).getAllByRole("columnheader").slice(0, 5).map((th) => th.textContent?.replace(/[↕↑↓]/g, "")))
      .toEqual(["순위", "종목", "후보", "점수", "사유"]);
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(MEMBERS.length + 1);
    expect(within(rows[1]).getByText("매수 목표")).toBeTruthy();
    // 한 열은 한 단위 — 시총은 조 원(머리), 순매수는 주 정수에 부호(작은 값의 부호를 잃지 않게).
    expect(within(table).getByRole("button", { name: /시총\(조 원\)/ })).toBeTruthy();
    expect(within(rows[1]).getByText("512.35")).toBeTruthy();
    expect(within(rows[1]).getByText("+12,340,000")).toBeTruthy();
    expect(within(rows[4]).getByText("-320,000")).toBeTruthy();
    expect(within(rows[4]).getByText(/수급 미달 — 20일 외국인/)).toBeTruthy();
    fireEvent.click(within(table).getByRole("button", { name: /점수/ }));
    await waitFor(() => expect(within(within(table).getAllByRole("row")[1]).getByText("323410")).toBeTruthy());

    // 가장 최근 결정(재선정일 아님)의 후보는 참고 한 줄.
    const reference = await screen.findByText(/참고 — 매수하지 않음: 가장 최근 결정 2026-11-04\(#45\)의 후보 1종목/);
    expect(reference.textContent).toMatch(/— 000660 SK하이닉스$/);

    // 입력 — U 기준일·수급 창·DART 접수일 규칙·재진입 금지(이름).
    expect(screen.getByText(/기준일 2026-10-30 · 100종목/)).toBeTruthy();
    expect(screen.getByText(/접수일\(rceptNo 앞 8자리\) ≤ 기준 세션 2026-11-02만/)).toBeTruthy();
    expect(screen.getByText("000660 SK하이닉스(~2026-11-10)")).toBeTruthy();
    expect(screen.getByText("기준 세션 뒤 날짜 0 · 읽은 순간 뒤에 받음 2 · 받은 시각 모름 0")).toBeTruthy();
  });

  it("선정한 결정이 가장 최근 결정이면 상세를 한 번만 읽고 참고 줄이 없다", async () => {
    reads["/api/paper/decisions?book=kr_rules&limit=50"] = () => Promise.resolve({ available: true, decisions: [summary(40)] });
    reads["/api/paper/decisions/40"] = () => Promise.resolve(SELECTION_DETAIL);
    renderSelection();
    expect(await screen.findByRole("region", { name: "선정 요약" })).toBeTruthy();
    expect(screen.queryByText(/참고 — 매수하지 않음/)).toBeNull();
    const details = api.apiGetShared.mock.calls.map(([path]) => path).filter((path) => /^\/api\/paper\/decisions\/\d+/.test(path));
    expect(new Set(details)).toEqual(new Set(["/api/paper/decisions/40"]));
  });

  it("선정한 결정이 아직 없고 기한 지남 결정만 있으면 빈 안내 + 그 결정은 선정 칸이 없다고", async () => {
    reads["/api/paper/decisions?book=kr_rules&limit=50"] = () => Promise.resolve({
      available: true, decisions: [summary(41, { kind: "SCHEDULED", status: "NO_TRADE", selectionAsOf: null, summary: "결정 기한이 지나 주문 없음" })],
    });
    reads["/api/paper/decisions/41"] = () => Promise.resolve({
      available: true,
      decision: { ...summary(41, { kind: "SCHEDULED", status: "NO_TRADE", selectionAsOf: null, summary: "결정 기한이 지나 주문 없음" }),
        response: { pastDeadline: true }, packet: null },
      orders: [],
    });
    renderSelection();
    expect(await screen.findByText(/아직 한국 규칙 계좌의 선정 기록이 없습니다/)).toBeTruthy();
    expect(await screen.findByText(/#41\)은 선정 칸이 없습니다\(기한 지남·일시정지 등\) — 결정 기한이 지나 주문 없음/)).toBeTruthy();
  });
});
