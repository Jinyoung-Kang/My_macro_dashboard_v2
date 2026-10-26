/**
 * 🧪 모의 매매 — 결정 로그 탭과 개요의 규칙 책 시작·신호 기관·게이트 지표(참고). 서버 값을 그대로 보이고, 지어내지 않는다.
 *
 *  - 결정 로그: 규칙 책이 기본, 목록(거래일·종류·상태·주문 수·요약), 행을 펼치면 GET /api/paper/decisions/{id} 상세
 *    (선정 순위·신호 이벤트·매수 후보·전량 매도·주문·고르지 못한 후보·게이트 참고). 두 그룹을 섞은 뒤(D27) 기록은 신호 풀 표·
 *    후보 점수·점수 기여 표·배분 방식, 섞기 전 기록은 순위표·순위 합 — 둘 다 그린다
 *  - 숫자 null은 "—"(0으로 채우지 않음), 순위표에 없는 기관은 CIK 그대로
 *  - "지금 결정 실행"은 POST /api/paper/run/decision {book} → 경과 초 → 결과 + 목록 다시 읽기, 시작 전 책은 막힘
 *  - 개요의 "규칙 책 시작"은 규칙 책이 시작 전일 때만, 확인 단계를 거쳐 POST /api/paper/run/initial-decision {book:"rules"}
 *    → 경과 초 → 결과 + 개요 다시 읽기. 서버 400 문구(수집 중)는 경고로 그대로
 *  - 개요의 신호 기관 카드는 그룹 A·그룹 B 목록과 신호 풀(그룹 배지·순위·기관 가중)
 *  - 게이트 카드는 "참고 — 구속하지 않음"
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
// 개요 탭이 먼저 그려지므로 차트도 바꿔 끼웁니다(jsdom에서는 recharts가 크기 0이라 아무것도 그리지 않음).
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  MultiLineSeries: () => null,
}));

import PaperPage from "@/components/screens/paper/PaperScreen";

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };

function book(code: string, over: Record<string, unknown> = {}) {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000,
    cash: 50.12, nav: 100050.12, equityValue: 100000, exposurePct: 99.95, returnPct: 0.05,
    lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: STATS, benchmark: null, ...over,
  };
}

const RULES_ACTIVE = book("rules", { kind: "RULES", label: "규칙 계좌", benchmark: "bench_spy" });
const RULES_NOT_STARTED = book("rules", {
  kind: "RULES", label: "규칙 계좌", status: "NOT_STARTED", startedOn: null, benchmark: "bench_spy", positions: 0,
});
const CLAUDE = book("claude", { kind: "CLAUDE", label: "Claude 계좌", status: "NOT_STARTED", startedOn: null, benchmark: "bench_spy" });

const GATE = {
  tradingDate: "2026-10-23",
  level: "L0",
  conditions: { G1: true, G2: false, G3: true, G4: true, G5: false },
  streaks: { G1: 2, G2: 0, G3: 12, G4: 9, G5: 0 },
  inputs: {
    us10y: { value: 4.62, source: "macro.collected", lastTs: "2026-10-24 05:59", isStale: false },
    brent: { value: 88.4, source: "macro.collected", lastTs: "2026-10-24 05:58", isStale: true },
    wti: { value: 84.1, source: "macro.collected", lastTs: "2026-10-24 05:58", isStale: false },
    usdjpy: { value: null, source: "macro.collected", lastTs: null, isStale: false },
  },
  note: "과거 OS가 쓴 트리거 수준 — 구속하지 않음",
};

function overview(rules: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    available: true, initialized: true, startDate: "2026-10-23", limits: [], jobs: [], pendingBackfill: [],
    books: [rules, CLAUDE, book("bench_spy", { label: "SPY 계좌" }), book("bench_mix", { label: "60/40 계좌" })],
    navSeries: { dates: [], books: {} },
    quotes: null,
    selection: {
      asOfDate: "2026-10-23",
      groupA: [
        { cik: "0001536411", name: "듀케인", rank: 1 },
        { cik: "0009999999", name: null, rank: null },
      ],
      groupB: [
        { cik: "0001536411", name: "듀케인", rank: 1 },
        { cik: "0001067983", name: "버크셔 해서웨이", rank: 2 },
      ],
      pool: [
        { cik: "0001536411", name: "듀케인", groups: ["A", "B"], weight: 0.5333 },
        { cik: "0009999999", name: null, groups: ["A"], weight: null },
        { cik: "0001067983", name: "버크셔 해서웨이", groups: ["B"], weight: 0.2 },
      ],
    },
    gate: GATE,
    ...over,
  };
}

function decision(id: number, over: Record<string, unknown> = {}) {
  return {
    id, book: "rules", asOfTradingDate: "2026-10-23", kind: "INITIAL", status: "OK", decidedAtKst: "2026-10-24 09:12",
    model: null, frameworkVersion: null, settingsVersion: 1, selectionAsOf: "2026-10-23", targetExposurePct: null,
    summary: "매수 AAPL · 남는 현금 SHY", orderCount: 2, rejectedCount: 0, pricesFinal: true, error: null, ...over,
  };
}

const LIST = {
  available: true,
  decisions: [
    // 값을 모르는 결정 — 주문 수·요약·가격이 null
    decision(8, {
      asOfTradingDate: "2026-10-26", kind: "SCHEDULED", status: "NO_TRADE", decidedAtKst: "2026-10-27 07:31",
      summary: null, orderCount: null, rejectedCount: null, pricesFinal: null,
    }),
    decision(7),
  ],
};

const DETAIL = {
  available: true,
  decision: {
    ...decision(7),
    packet: null, packetHash: null, usage: null, noteIds: null, latencyMs: 35, retryCount: 0,
    response: {
      gate: GATE,
      selection: {
        asOf: "2026-10-23",
        ciks: ["0001067983", "0001336528"],
        ranking: [
          { cik: "0001067983", name: "버크셔 해서웨이", rank: 1, metric: "CAGR", cagrPct: 14.21, excessVsSpyPct: 3.5, sharpe: 0.83, selected: true },
          { cik: "0001336528", name: "퍼싱 스퀘어", rank: 2, metric: "CAGR", cagrPct: 12.1, excessVsSpyPct: null, sharpe: null, selected: true },
        ],
      },
      signals: {
        events: [
          { cik: "0001067983", rank: 1, ticker: "AAPL", action: "ADDED", sharesChangePct: 31.5, weightPct: 4.2, previousWeightPct: 3.1 },
          { cik: "0001336528", rank: 2, ticker: "AAPL", action: "NEW", sharesChangePct: null, weightPct: 2.05, previousWeightPct: null },
          { cik: "0009999999", rank: null, ticker: "XOM", action: "CLOSED", sharesChangePct: null, weightPct: 0, previousWeightPct: 1.5 },
        ],
        candidates: [{ ticker: "AAPL", buyerCiks: ["0001067983", "0001336528"], rankSum: 3, combinedWeightPct: 6.25, events: [] }],
        closedBy: { XOM: ["0009999999"] },
      },
      orders: [],
      skipped: [{ GOOGL: "유니버스 밖" }],
      notes: ["퍼싱 스퀘어: 직전 분기 공시 없음"],
    },
  },
  orders: [
    {
      id: 31, ticker: "AAPL", side: "BUY", qty: null, targetWeightPct: 10, sellFraction: null, timing: "BACKFILL", source: "RULE",
      status: "FILLED", rejectReason: null,
      // 백엔드(RuleBookService) 근거 모양 — rule·signal·kind가 앞이고 사람이 읽을 문장 text는 넷째, buyers는 이벤트 배열
      reason: {
        rule: "R2·R4", signal: "BUY", kind: "INITIAL",
        text: "2곳 동시 매수(순위 합 3): 1위 버크셔 해서웨이(0001067983) +31.5%, 2위 퍼싱 스퀘어(0001336528) 신규",
        buyers: [
          { cik: "0001067983", name: "버크셔 해서웨이", rank: 1, ticker: "AAPL", action: "ADDED", sharesChangePct: 31.5, weightPct: 4.2, previousWeightPct: 3.1 },
          { cik: "0001336528", name: "퍼싱 스퀘어", rank: 2, ticker: "AAPL", action: "NEW", sharesChangePct: null, weightPct: 2.05, previousWeightPct: null },
        ],
        rankSum: 3, combinedWeightPct: 6.25, targetWeightPct: 10, currentWeightPct: 0, orderWeightPct: 10, selectionAsOf: "2026-10-23",
      },
      asOfTradingDate: "2026-10-22",
      createdAtKst: "2026-10-24 04:59", expiresOn: null, filledAtKst: "2026-10-24 05:00",
    },
  ],
};

/** 선정 때의 그룹 순위표 한 줄(RuleBookService가 선정 행의 ranking.groupA·groupB 상위 10을 그대로 옮김). */
function rankRow(cik: string, name: string, rank: number, selected: boolean, over: Record<string, unknown> = {}) {
  return { cik, name, rank, metric: "CAGR", metricValue: 20 - rank, cagrPct: 20 - rank, excessVsSpyPct: 5 - rank, sharpe: 1, selected, ...over };
}

/** 두 그룹을 섞은 뒤(D27)의 결정 기록 — 신호 풀·그룹 순위표·후보 점수·점수 기여·배분 방식. 모양은 RuleBookService 그대로. */
const BLEND_DETAIL = {
  available: true,
  decision: {
    ...decision(9, { asOfTradingDate: "2026-11-17", kind: "REBALANCE", selectionAsOf: "2026-11-17", summary: "매수 NVDA" }),
    packet: null, packetHash: null, usage: null, noteIds: null, latencyMs: 41, retryCount: 0,
    response: {
      gate: GATE,
      selection: {
        asOf: "2026-11-17",
        ciks: ["0001536411", "0001656456", "0001067983"],
        // 순위표라 선정되지 않은 3위도 있습니다 — 그 기관은 선정·신호 풀에 들지 않습니다.
        groupA: [
          rankRow("0001536411", "듀케인", 1, true), rankRow("0001656456", "아팔루사", 2, true), rankRow("0001040273", "서드 포인트", 3, false),
        ],
        groupB: [
          rankRow("0001536411", "듀케인", 1, true, { source: "q30" }), rankRow("0001067983", "버크셔 해서웨이", 2, true, { source: "q8" }),
        ],
        pool: [
          { cik: "0001536411", name: "듀케인", groups: ["A", "B"], rankA: 1, rankB: 1, weight: 0.5333 },
          { cik: "0001656456", name: "아팔루사", groups: ["A"], rankA: 2, rankB: null, weight: 0.1333 },
          { cik: "0001067983", name: "버크셔 해서웨이", groups: ["B"], rankA: null, rankB: 2, weight: 0.3333 },
        ],
        groupWeightA: 0.5,
        legacy: false,
        filers: [
          { cik: "0001536411", name: "듀케인", groups: ["A", "B"], rankA: 1, rankB: 1, weight: 0.5333, source: "q30" },
          { cik: "0001656456", name: "아팔루사", groups: ["A"], rankA: 2, rankB: null, weight: 0.1333, source: "q30" },
          { cik: "0001067983", name: "버크셔 해서웨이", groups: ["B"], rankA: null, rankB: 2, weight: 0.3333, source: "q8" },
        ],
      },
      signals: {
        events: [
          {
            cik: "0001536411", name: "듀케인", groups: ["A", "B"], rankA: 1, rankB: 1, ticker: "NVDA", action: "NEW",
            sharesChangePct: null, weightPct: 12.3, previousWeightPct: null,
          },
          {
            cik: "0001067983", name: "버크셔 해서웨이", groups: ["B"], rankA: null, rankB: 2, ticker: "NVDA", action: "ADDED",
            sharesChangePct: 45, weightPct: 2.5, previousWeightPct: 1.5,
          },
        ],
        candidates: [{
          ticker: "NVDA", buyerCiks: ["0001536411", "0001067983"], score: 0.61663, combinedWeightPct: 14.8,
          contributions: [
            {
              cik: "0001536411", name: "듀케인", groups: ["A", "B"], rankA: 1, rankB: 1,
              filerWeight: 0.5333, conviction: 1, points: 0.5333, action: "NEW", sharesChangePct: null, weightPct: 12.3,
            },
            {
              cik: "0001067983", name: "버크셔 해서웨이", groups: ["B"], rankA: null, rankB: 2,
              filerWeight: 0.3333, conviction: 0.25, points: 0.08333, action: "ADDED", sharesChangePct: 45, weightPct: 2.5,
            },
          ],
        }],
        closedBy: {},
      },
      orders: [],
      skipped: [],
      notes: [],
      settings: { minHolders: 2, rulesMaxNames: 10, maxWeightStockPct: 10, allocation: "CONVICTION", convictionCapPct: 10, minTargetPct: 1 },
    },
  },
  orders: [],
};

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않는 요청. 긴 경로부터 맞춥니다. */
let reads: Record<string, () => Promise<unknown>> = {};

beforeEach(() => {
  reads = {};
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
    return key ? reads[key]() : new Promise(() => {});
  });
});

afterEach(() => cleanup());

async function openDecisionsTab() {
  render(<PaperPage />);
  fireEvent.click(await screen.findByRole("tab", { name: "결정 로그" }));
}

const cellsOf = (row: HTMLElement) => within(row).getAllByRole("cell").map((td) => td.textContent);
const headersOf = (region: HTMLElement) => within(region).getAllByRole("columnheader").map((th) => th.textContent);
const rowsOf = (region: HTMLElement) =>
  within(region).getAllByRole("row").slice(1).map((tr) => within(tr).getAllByRole("cell").map((td) => td.textContent));

describe("결정 로그 탭", () => {
  beforeEach(() => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(RULES_ACTIVE));
    reads["/api/paper/decisions?book=rules"] = () => Promise.resolve(LIST);
    reads["/api/paper/decisions/7"] = () => Promise.resolve(DETAIL);
  });

  it("규칙 책이 기본이고, 목록은 서버 값 그대로 — 모르는 값은 '—'", async () => {
    await openDecisionsTab();

    expect((screen.getByLabelText("계좌 고르기") as HTMLSelectElement).value).toBe("rules");
    // 벤치마크는 결정을 내지 않아 선택지에 없습니다.
    expect(within(screen.getByLabelText("계좌 고르기")).getAllByRole("option").map((option) => option.getAttribute("value")))
      .toEqual(["rules", "claude"]);
    expect(api.apiGetShared).toHaveBeenCalledWith("/api/paper/decisions?book=rules&limit=50", 0);
    // 자리 문구는 이제 없습니다.
    expect(screen.queryByText(/탭은 다음 단계에서 엽니다/)).toBeNull();

    const initial = await screen.findByRole("row", { name: "2026-10-23 초기 결정" });
    expect(cellsOf(initial)).toEqual([
      "2026-10-23상세 펼치기", "초기 결정", "주문 냄", "2건", "매수 AAPL · 남는 현금 SHY", "확정 종가", "2026-10-24 09:12",
    ]);
    const scheduled = screen.getByRole("row", { name: "2026-10-26 정기" });
    expect(cellsOf(scheduled)).toEqual(["2026-10-26상세 펼치기", "정기", "주문 없음", "—", "—", "—", "2026-10-27 07:31"]);
  });

  it("행을 펼치면 상세 — 선정·신호 이벤트·후보·전량 매도·주문·건너뛴 후보·게이트(참고)", async () => {
    await openDecisionsTab();

    const row = await screen.findByRole("row", { name: "2026-10-23 초기 결정" });
    const toggle = within(row).getByRole("button", { name: "상세 펼치기" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);

    const detail = await screen.findByRole("region", { name: "2026-10-23 초기 결정 상세" });
    expect(api.apiGetShared).toHaveBeenCalledWith("/api/paper/decisions/7", 0);
    // 규칙 책 기록에는 Claude 책 칸(모델·프레임·노출)이 없습니다.
    expect(within(detail).getByText("선정 기준일")).toBeTruthy();
    expect(within(detail).queryByText("모델")).toBeNull();
    expect(within(detail).getByText("퍼싱 스퀘어: 직전 분기 공시 없음")).toBeTruthy();

    const selection = within(detail).getByRole("region", { name: "선정 — 2026-10-23 기준" });
    expect(within(selection).getByText(/신호 기관: 버크셔 해서웨이 · 1위, 퍼싱 스퀘어 · 2위/)).toBeTruthy();
    expect(rowsOf(selection)).toEqual([
      ["1", "버크셔 해서웨이", "선정", "+14.21%", "+3.50%p", "0.83"],
      ["2", "퍼싱 스퀘어", "선정", "+12.10%", "—", "—"],
    ]);

    expect(rowsOf(within(detail).getByRole("region", { name: "13F 신호 이벤트" }))).toEqual([
      ["버크셔 해서웨이 · 1위", "AAPL", "확대", "+31.50%", "4.20%", "3.10%"],
      ["퍼싱 스퀘어 · 2위", "AAPL", "신규 편입", "—", "2.05%", "—"],
      // 순위표에 없는 기관은 CIK 그대로(이름을 지어내지 않음)
      ["CIK 0009999999", "XOM", "전량 매도", "—", "0.00%", "1.50%"],
    ]);

    const candidates = within(detail).getByRole("region", { name: "매수 후보" });
    expect(within(candidates).getByText(/매수하는 결정입니다/)).toBeTruthy();
    expect(rowsOf(candidates)).toEqual([["AAPL", "버크셔 해서웨이 · 1위, 퍼싱 스퀘어 · 2위", "2곳", "3", "6.25%"]]);
    expect(rowsOf(within(detail).getByRole("region", { name: "전량 매도한 기관" }))).toEqual([["XOM", "CIK 0009999999", "1곳"]]);

    const orders = rowsOf(within(detail).getByRole("region", { name: "주문" }));
    expect(orders).toHaveLength(1);
    expect(orders[0].slice(0, 6)).toEqual(["AAPL", "매수", "순자산의 10.00% 매수", "체결", "사후 체결", "—"]);
    // 근거 문장을 자르지 않고 그대로 — 둘째 기관까지 보입니다.
    expect(orders[0][6]).toBe("2곳 동시 매수(순위 합 3): 1위 버크셔 해서웨이(0001067983) +31.5%, 2위 퍼싱 스퀘어(0001336528) 신규");

    // 자바 Map.Entry 모양({티커: 사유})도 사유와 함께 읽힙니다.
    expect(rowsOf(within(detail).getByRole("region", { name: "고르지 못한 후보" }))).toEqual([["GOOGL", "유니버스 밖"]]);

    const gate = within(detail).getByRole("region", { name: "게이트 (참고)" });
    expect(within(gate).getByText("참고 — 구속하지 않음")).toBeTruthy();
    expect(within(gate).getByText("L0 · 동결")).toBeTruthy();
    // 상세의 게이트는 조건만(입력 표는 개요 카드에서)
    expect(within(gate).queryByRole("region", { name: "게이트 입력" })).toBeNull();

    expect(within(detail).getByText("결정 기록 원본(JSON)")).toBeTruthy();
    expect(within(detail).queryByText("입력 패킷(JSON)")).toBeNull();

    // 다시 누르면 접습니다.
    fireEvent.click(within(row).getByRole("button", { name: "상세 접기" }));
    expect(screen.queryByRole("region", { name: "2026-10-23 초기 결정 상세" })).toBeNull();
  });

  it("두 그룹을 섞은 뒤 기록 — 신호 풀 표, 그룹 순위가 붙은 이벤트, 후보 점수, 점수 기여 표, 배분 방식", async () => {
    reads["/api/paper/decisions?book=rules"] = () => Promise.resolve({
      available: true, decisions: [decision(9, { asOfTradingDate: "2026-11-17", kind: "REBALANCE" })],
    });
    reads["/api/paper/decisions/9"] = () => Promise.resolve(BLEND_DETAIL);
    await openDecisionsTab();
    fireEvent.click(within(await screen.findByRole("row", { name: "2026-11-17 재선정일" })).getByRole("button", { name: "상세 펼치기" }));

    const detail = await screen.findByRole("region", { name: "2026-11-17 재선정일 상세" });
    const selection = within(detail).getByRole("region", { name: "선정 — 2026-11-17 기준" });
    // 선정된 줄만 이름표에(순위표 3위 서드 포인트는 없음), 그룹 A 몫은 선정 때 값
    expect(within(selection).getByText(
      "그룹 A: 듀케인 · 1위, 아팔루사 · 2위. 그룹 B: 듀케인 · 1위, 버크셔 해서웨이 · 2위. "
        + "신호 풀(A ∪ B)과 기관 가중은 선정 때 값입니다(그룹 A 몫 50.0%). 순위표는 그룹마다 선정 때의 상위 10입니다(공시일 기준 복제 수익률).",
    )).toBeTruthy();
    // 표마다 이름이 있는 스크롤 상자 — 랜드마크 목록에서 서로 구별됩니다.
    const pool = within(selection).getByRole("region", { name: "신호 풀 (좌우 스크롤)" });
    expect(headersOf(pool)).toEqual(["기관", "그룹", "그룹 A 순위", "그룹 B 순위", "기관 가중"]);
    expect(rowsOf(pool)).toEqual([
      ["듀케인", "AB", "1위", "1위", "53.3%"],
      ["아팔루사", "A", "2위", "—", "13.3%"],
      ["버크셔 해서웨이", "B", "—", "2위", "33.3%"],
    ]);
    expect(rowsOf(within(selection).getByRole("region", { name: "그룹 A 순위표" }))).toEqual([
      ["1", "듀케인", "선정", "+19.00%", "+4.00%p", "1.00"],
      ["2", "아팔루사", "선정", "+18.00%", "+3.00%p", "1.00"],
      ["3", "서드 포인트", "—", "+17.00%", "+2.00%p", "1.00"],
    ]);
    expect(rowsOf(within(selection).getByRole("region", { name: "그룹 B 순위표" })).map((row) => row.slice(0, 3))).toEqual([
      ["1", "듀케인", "선정"],
      ["2", "버크셔 해서웨이", "선정"],
    ]);
    // 섞은 뒤 기록에는 섞기 전 순위표(빈 표 안내)가 없습니다.
    expect(within(selection).queryByText("순위표가 없습니다.")).toBeNull();

    expect(rowsOf(within(detail).getByRole("region", { name: "13F 신호 이벤트" })).map((row) => row.slice(0, 3))).toEqual([
      ["듀케인 · A 1위 · B 1위", "NVDA", "신규 편입"],
      ["버크셔 해서웨이 · B 2위", "NVDA", "확대"],
    ]);

    const candidates = within(detail).getByRole("region", { name: "매수 후보" });
    expect(within(candidates).getByText(/배분: 확신도 비례\(CONVICTION\) — 목표 비중 = 종목 상한 × 점수 ÷ 최고 점수/)).toBeTruthy();
    expect(within(candidates).getAllByRole("columnheader").map((th) => th.textContent))
      .toEqual(["종목", "매수 기관(순위)", "기관 수", "점수", "합산 비중"]);
    expect(rowsOf(candidates)).toEqual([["NVDA", "듀케인 · A 1위 · B 1위, 버크셔 해서웨이 · B 2위", "2곳", "0.617", "14.80%"]]);

    const contributions = within(detail).getByRole("region", { name: "점수 기여" });
    expect(within(contributions).getByText(/확신도 = min\(그 종목의 기관 내 비중, 10%\) ÷ 10%/)).toBeTruthy();
    expect(within(contributions).getAllByRole("columnheader").map((th) => th.textContent))
      .toEqual(["종목", "기관(순위)", "그룹", "기관 가중", "확신도", "점수 기여"]);
    expect(rowsOf(contributions)).toEqual([
      ["NVDA", "듀케인 · A 1위 · B 1위", "AB", "53.3%", "100.0%", "0.533"],
      ["NVDA", "버크셔 해서웨이 · B 2위", "B", "33.3%", "25.0%", "0.083"],
    ]);
  });

  it("섞기 전 기록에는 점수 기여 표·배분 줄이 없고 순위 합 칸", async () => {
    await openDecisionsTab();
    fireEvent.click(within(await screen.findByRole("row", { name: "2026-10-23 초기 결정" })).getByRole("button", { name: "상세 펼치기" }));

    const detail = await screen.findByRole("region", { name: "2026-10-23 초기 결정 상세" });
    expect(within(detail).queryByRole("region", { name: "점수 기여" })).toBeNull();
    const candidates = within(detail).getByRole("region", { name: "매수 후보" });
    expect(within(candidates).queryByText(/^배분:/)).toBeNull();
    expect(within(candidates).getAllByRole("columnheader").map((th) => th.textContent))
      .toEqual(["종목", "매수 기관(순위)", "기관 수", "순위 합", "합산 비중"]);
  });

  it("규칙 책 모양이 아닌 기록은 표 없이 원본 JSON만", async () => {
    reads["/api/paper/decisions/7"] = () => Promise.resolve({
      ...DETAIL, decision: { ...DETAIL.decision, response: { stance: "neutral" } }, orders: [],
    });
    await openDecisionsTab();
    fireEvent.click(within(await screen.findByRole("row", { name: "2026-10-23 초기 결정" })).getByRole("button", { name: "상세 펼치기" }));

    const detail = await screen.findByRole("region", { name: "2026-10-23 초기 결정 상세" });
    expect(within(detail).queryByRole("region", { name: "13F 신호 이벤트" })).toBeNull();
    expect(within(detail).queryByRole("region", { name: "게이트 (참고)" })).toBeNull();
    expect(within(detail).getByText("이 결정은 주문을 내지 않았습니다.")).toBeTruthy();
    expect(within(detail).getByText("결정 기록 원본(JSON)")).toBeTruthy();
  });

  it("기록이 없으면 안내, 테이블이 없으면(available:false) 서버 문구 그대로", async () => {
    reads["/api/paper/decisions?book=rules"] = () => Promise.resolve({ available: true, decisions: [] });
    await openDecisionsTab();
    expect(await screen.findByText(/아직 결정 기록이 없습니다/)).toBeTruthy();

    cleanup();
    const message = "모의 매매 테이블이 아직 없습니다. 수집기가 스키마(V8)를 적용하면 생깁니다 — make up 후 다시 보세요.";
    reads["/api/paper/decisions?book=rules"] = () => Promise.resolve({ available: false, message });
    await openDecisionsTab();
    expect(await screen.findByText(message)).toBeTruthy();
  });

  it("Claude 책은 결정 안내(검증·비용), 시작 전이라 수동 결정 버튼이 막히고 시작하는 길을 적는다", async () => {
    reads["/api/paper/decisions?book=claude"] = () => Promise.resolve({ available: true, decisions: [] });
    await openDecisionsTab();

    fireEvent.change(screen.getByLabelText("계좌 고르기"), { target: { value: "claude" } });

    expect(await screen.findByText(/검증기\(하드 규칙\)가 주문마다 통과·거절을 정하고/)).toBeTruthy();
    expect(screen.queryByText(/다음 단계\(3a\)/)).toBeNull();
    expect((screen.getByRole("button", { name: "지금 결정 실행" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/시작 전인 계좌는 결정을 내지 않습니다 — 개요 탭의 'Claude 계좌 시작'/)).toBeTruthy();
    expect(api.apiGetShared).toHaveBeenCalledWith("/api/paper/decisions?book=claude&limit=50", 0);
  });

  it("지금 결정 실행 — POST /api/paper/run/decision {book} → 경과 초 → 결과와 목록 다시 읽기", async () => {
    let listReads = 0;
    reads["/api/paper/decisions?book=rules"] = () => {
      listReads += 1;
      return Promise.resolve(LIST);
    };
    let finish: (value: unknown) => void = () => {};
    api.apiPost.mockImplementation(() => new Promise((resolve) => {
      finish = resolve;
    }));

    await openDecisionsTab();
    await screen.findByRole("row", { name: "2026-10-23 초기 결정" });
    fireEvent.click(screen.getByRole("button", { name: "지금 결정 실행" }));

    const busy = await screen.findByRole("button", { name: /결정 중… \d+초/ });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/run/decision", { book: "rules" });

    finish({ ok: true, decision: decision(9, { kind: "MANUAL", status: "NO_TRADE", orderCount: 0, summary: "매도 신호 없음" }) });

    expect(await screen.findByText("2026-10-23 수동 결정 — 주문 없음 · 주문 0건 · 매도 신호 없음")).toBeTruthy();
    await waitFor(() => expect(listReads).toBeGreaterThanOrEqual(2));
    expect((screen.getByRole("button", { name: "지금 결정 실행" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("수동 결정이 실패하면 서버 문구를 경고로", async () => {
    api.apiPost.mockRejectedValue(new Error("선정이 없습니다 — 규칙 계좌를 먼저 시작하세요."));
    await openDecisionsTab();
    await screen.findByRole("row", { name: "2026-10-23 초기 결정" });
    fireEvent.click(screen.getByRole("button", { name: "지금 결정 실행" }));

    const warning = await screen.findByText("선정이 없습니다 — 규칙 계좌를 먼저 시작하세요.");
    expect(warning.closest("div")?.className).toContain("text-warn");
  });
});

describe("개요 — 규칙 책 시작", () => {
  it("시작 전이면 카드와 버튼 — 확인 단계를 거쳐 POST /api/paper/run/initial-decision {book:'rules'} → 경과 초 → 결과, 개요 다시 읽기", async () => {
    let overviewReads = 0;
    reads["/api/paper/overview"] = () => {
      overviewReads += 1;
      return Promise.resolve(overviewReads === 1 ? overview(RULES_NOT_STARTED) : overview(RULES_ACTIVE));
    };
    let finish: (value: unknown) => void = () => {};
    api.apiPost.mockImplementation(() => new Promise((resolve) => {
      finish = resolve;
    }));

    render(<PaperPage />);

    expect(await screen.findByText(/규칙 계좌는 아직 현금만 들고 있습니다/)).toBeTruthy();
    // 첫 누름은 확인 단계만 엽니다 — 아직 서버를 부르지 않습니다.
    fireEvent.click(screen.getByRole("button", { name: "규칙 계좌 시작" }));
    expect(screen.getByText(/정말 시작할까요\?/)).toBeTruthy();
    expect(api.apiPost).not.toHaveBeenCalled();

    // 취소하면 처음으로
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.queryByText(/정말 시작할까요\?/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "규칙 계좌 시작" }));
    fireEvent.click(screen.getByRole("button", { name: "시작 확인" }));

    const busy = await screen.findByRole("button", { name: /시작 중… \d+초/ });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/run/initial-decision", { book: "rules" });

    finish({ ok: true, decision: decision(7), fills: 2 });

    // 다시 읽은 개요에서 규칙 책이 운용 중이면 카드는 사라지고 결과는 남습니다.
    expect(await screen.findByText(
      "규칙 계좌를 시작했습니다 · 2026-10-23 초기 결정 · 주문 2건 · 사후 체결 2건 — 매수 AAPL · 남는 현금 SHY",
    )).toBeTruthy();
    await waitFor(() => expect(overviewReads).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "규칙 계좌 시작" })).toBeNull());
    expect(screen.getByText(/규칙 계좌를 시작했습니다/)).toBeTruthy();
  });

  it("수집 중이라 서버가 거절(400)하면 그 문구를 경고로, 버튼은 다시 누를 수 있다", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(RULES_NOT_STARTED));
    const message = "트랙레코드 수집 중 — 후보 27곳 중 20곳만 30분기 수집을 마쳤습니다. 수집이 끝난 뒤 다시 누르세요.";
    api.apiPost.mockRejectedValue(new Error(message));

    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("button", { name: "규칙 계좌 시작" }));
    fireEvent.click(screen.getByRole("button", { name: "시작 확인" }));

    const warning = await screen.findByText(message);
    expect(warning.closest("div")?.className).toContain("text-warn");
    const again = screen.getByRole("button", { name: "규칙 계좌 시작" }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
  });

  it("규칙 책이 이미 시작했으면 시작 카드가 없다", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(RULES_ACTIVE));

    render(<PaperPage />);

    expect(await screen.findByText("신호 기관")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "규칙 계좌 시작" })).toBeNull();
  });
});

describe("개요 — 신호 기관·게이트 지표(참고)", () => {
  it("두 그룹(그룹 안 순위 순)과 신호 풀(그룹 배지·순위·가중), 이름·가중을 모르면 CIK·— — 게이트는 서버 값 그대로", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(RULES_ACTIVE));

    render(<PaperPage />);

    expect(await screen.findByText(/2026-10-23 선정 — 규칙 계좌가 두 그룹을 합친 신호 풀의 13F 변화를 신호로 씁니다/)).toBeTruthy();
    const groupA = screen.getByRole("region", { name: "그룹 A — 후보 기관 트랙레코드 상위" });
    expect(within(groupA).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["1위 듀케인", "— CIK 0009999999"]);
    const groupB = screen.getByRole("region", { name: "그룹 B — 기존 13F 메뉴 최근 상위" });
    expect(within(groupB).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["1위 듀케인", "2위 버크셔 해서웨이"]);
    const pool = screen.getByRole("region", { name: "신호 풀" });
    expect(within(pool).getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["기관", "그룹", "순위", "기관 가중"]);
    expect(rowsOf(pool)).toEqual([
      ["듀케인", "AB", "A 1위 · B 1위", "53.3%"],
      ["CIK 0009999999", "A", "—", "—"],
      ["버크셔 해서웨이", "B", "B 2위", "20.0%"],
    ]);

    expect(screen.getByText("L0 · 동결")).toBeTruthy();
    expect(screen.getAllByText(/참고 — 구속하지 않음/).length).toBeGreaterThan(0);
    expect(rowsOf(screen.getByRole("region", { name: "게이트 조건" }))).toEqual([
      ["G1 10년물 < 1단계 기준", "충족", "2거래일 연속"],
      ["G2 10년물 ≤ 전면 기준", "미충족", "0거래일 연속"],
      ["G3 브렌트 ≤ 상한", "충족", "12거래일 연속"],
      ["G4 WTI ≤ 상한", "충족", "9거래일 연속"],
      ["G5 USD/JPY ≥ 기준 (참고 — 단계에 쓰지 않음)", "미충족", "0거래일 연속"],
    ]);
    // 없는 입력은 "—"(0으로 채우지 않음), 이어 쓴 값은 배지
    expect(rowsOf(screen.getByRole("region", { name: "게이트 입력" }))).toEqual([
      ["미국 10년물 금리", "4.62%", "2026-10-24 05:59"],
      ["브렌트유", "88.40 달러", "2026-10-24 05:58지난 값"],
      ["WTI", "84.10 달러", "2026-10-24 05:58"],
      ["USD/JPY", "—", "—"],
    ]);
  });

  it("게이트·선정 기록이 없으면 없다고 적는다(이 필드를 아직 보내지 않는 백엔드도 같음)", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(RULES_NOT_STARTED, { gate: undefined, selection: null }));

    render(<PaperPage />);

    expect(await screen.findByText(/아직 게이트 기록이 없습니다/)).toBeTruthy();
    expect(screen.getByText(/아직 기관 선정이 없습니다/)).toBeTruthy();
  });

  it("그룹 B가 비면 그렇다고 적고(그룹 A만 신호), 섞기 전 모양(selected만)은 그룹 A로 읽는다", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(RULES_ACTIVE, {
      selection: { asOfDate: "2026-10-23", selected: [{ cik: "0001067983", name: "버크셔 해서웨이", rank: 1 }] },
    }));

    render(<PaperPage />);

    const groupA = await screen.findByRole("region", { name: "그룹 A — 후보 기관 트랙레코드 상위" });
    expect(within(groupA).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["1위 버크셔 해서웨이"]);
    const groupB = screen.getByRole("region", { name: "그룹 B — 기존 13F 메뉴 최근 상위" });
    expect(within(groupB).getByText(/자격 있는 기관이 없습니다 — 신호는 그룹 A만 냅니다/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "신호 풀" })).toBeNull();
  });

  it("두 그룹이 모두 비면 '선정이 비어 있습니다'", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(RULES_ACTIVE, {
      selection: { asOfDate: "2026-10-23", groupA: [], groupB: [], pool: [] },
    }));

    render(<PaperPage />);

    expect(await screen.findByText(/선정이 비어 있습니다 — 자격 있는 기관이 없었습니다/)).toBeTruthy();
  });
});
