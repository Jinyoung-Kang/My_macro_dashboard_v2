/**
 * 🧪 모의매매(한국) 보유·체결 탭(/paper/kr/holdings, 2단계 명세 §4-16 F2) — 네 상태 이야기와 한국 표기.
 *
 *  - 불러오는 중: 보유·주문·체결·순자산 기록이 오기 전에는 표마다 읽는 중 표시(숫자를 짓지 않음)
 *  - 빈 상태(시작 전): 네 계좌가 시작 전이면 보유·체결·순자산 기록이 비었다고 말하고, 시작 단추 대신 '네 계좌가 함께 출발' 안내 —
 *    확정 조정 합계는 '—(확정 조정 행 없음)'(0원으로 쓰지 않음)
 *  - 오류: 표마다 오류 + 다시 시도(누르면 그 표만 다시 읽음)
 *  - 자료: 원 단위 정수 칸, 세 배지('기업행위 확인 필요'·'가격 없음'·'금융위 확정 미보정(ETF)'), 확정 행의 확정가·차이·현금 차이,
 *    실효 비용 bp, 확정 조정 합계, 스탑 근거(확정값으로 낮춘 최고가·stopBasisNote), 잠정 사유(작업 기록 메모), 확정 조정 '주의',
 *    리셋 확인 창의 한국 문구(사후 체결 없음 — 한 계좌만이면 다시 출발하지 않음)
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
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-11-02", initialCash: 100_000_000,
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

const overview = (books: unknown[]) => ({
  available: true, market: "KR", currency: "KRW", dormantReason: null, initialized: true, pendingBackfill: [],
  startDate: "2026-11-02", books, navSeries: { dates: [], books: {} }, quotes: null, selection: null, gate: null,
  claudeExposureSeries: [], frameworkBoundaries: [], limits: [], jobs: [],
});

const NOT_STARTED = BOOKS.map((entry) => ({ ...entry, status: "NOT_STARTED", startedOn: null, cash: 100_000_000,
  nav: 100_000_000, equityValue: 0, exposurePct: 0, returnPct: null, positions: 0 }));

function position(ticker: string, over: Record<string, unknown> = {}) {
  return {
    ticker, qty: 10, avgCost: 71_300, lastPrice: 71_500, lastPriceAtKst: "2026-11-03 21:57 KST", marketValue: 715_000,
    weightPct: 0.71, unrealizedPct: 0.28, highWatermark: 71_500, stopPrice: 65_780, stopDistancePct: 8.7, openedOn: "2026-11-03",
    holdingTradingDays: 1, holdingTradingDaysReason: null, priceStale: false, splitNote: null, cashLike: false, backfilled: false,
    corpActionHold: null, ...over,
  };
}

const POSITIONS = {
  available: true, book: BOOKS[0],
  positions: [
    position("005930"),
    position("000660", { qty: 5, avgCost: 200_000, lastPrice: 201_000, marketValue: 1_005_000,
      corpActionHold: "2026-11-03 상장주식수 변동(분할·병합 추정) — 확인 필요" }),
    position("035420", { lastPrice: 180_000, priceStale: true, lastPriceAtKst: "2026-11-02 21:57 KST" }),
  ],
  lockouts: [{ ticker: "035720", untilTradingDate: "2026-11-10", reason: "트레일링 스탑 체결 2026-11-03" }],
  cash: 340_000,
};

const STOP_ORDER = {
  id: 31, ticker: "035420", side: "SELL", qty: null, targetWeightPct: null, sellFraction: null, timing: "NEXT_OPEN", source: "STOP",
  status: "CANCELLED", rejectReason: "STOP_NOT_CONFIRMED — 금융위 2026-11-03 종가 70,000원이 스탑가 69,000원 위",
  reason: { trigger: "TRAILING_STOP", stopPct: 8, highWatermark: 75_000, stopPrice: 69_000, observedPrice: 68_500,
    observedSource: "TOSS_INTEGRATED", barDate: "2026-11-03", confirmedHighWatermark: 72_000, stopBasis: "FSC", confirmedClose: 70_000,
    stopBasisNote: "최고가는 감지 뒤 금융위 확정 조정이 다시 센 72,000원(감지 때 75,000원 — 잠정 체결가)" },
  asOfTradingDate: "2026-11-03", createdAtKst: "2026-11-03 22:01 KST", expiresOn: "2026-11-06", filledAtKst: null,
};

const ORDERS = { available: true, orders: [STOP_ORDER] };

const FILLS = {
  available: true,
  confirmationTotal: { rows: 1, cashDelta: 1_000, unconfirmed: 1 },
  fills: [
    {
      id: 12, orderId: 7, ticker: "005930", side: "BUY", qty: 10, price: 71_300, rawPrice: 71_300, slippageBp: 5, gross: 713_000,
      observedAtKst: "2026-11-03 21:57 KST", observationDate: "2026-11-03", priceSource: "TOSS_1M_OPEN", backfill: false,
      fee: 106, tax: 0, slippageCost: 356, costBp: 6.48,
      confirmation: { confirmedPrice: 71_200, priceDiff: -100, fee: 105, tax: 0, slippageCost: 356, costBp: 6.49, cashDelta: 1_000,
        source: "FSC", reconciledAtKst: "2026-11-04 22:05 KST" },
      confirmationState: "CONFIRMED", confirmationNote: null,
    },
    {
      id: 13, orderId: 8, ticker: "153130", side: "BUY", qty: 100, price: 108_000, rawPrice: 108_000, slippageBp: 5, gross: 10_800_000,
      observedAtKst: "2026-11-03 21:57 KST", observationDate: "2026-11-03", priceSource: "TOSS_DAILY", backfill: false,
      fee: 1_620, tax: 0, slippageCost: 5_400, costBp: 6.5, confirmation: null,
      confirmationState: "UNCORRECTED", confirmationNote: "금융위 확정 미보정(ETF)",
    },
  ],
};

const NAV = {
  available: true, book: BOOKS[0],
  series: [
    { tradingDate: "2026-11-02", nav: 100_000_000, cash: 100_000_000, equityValue: 0, exposurePct: 0, pricesFinal: true },
    { tradingDate: "2026-11-03", nav: 100_312_450, cash: 340_000, equityValue: 99_972_450, exposurePct: 99.66, pricesFinal: false },
  ],
};

const CAUTION = "체결 12 BUY 005930 10주(2026-11-03) 확정(FSC 2026-11-03 시가): … — 주의: 잠정 체결의 비용 칸이 이 판의 요율로 다시 센 값과 다름";
const STATUS = {
  available: true, market: "KR", currency: "KRW", dormantReason: null,
  jobs: [{
    job: "kr.risk", startedAtKst: "2026-11-04 22:05 KST", finishedAtKst: "2026-11-04 22:05 KST", outcome: "OK",
    detail: { notes: [
      "kr_rules: 순자산 2026-11-03 잠정으로 다시 씀(확정 현금 340,000원) — 주문 31 SELL 035420(기준일 2026-11-02) 대기 — 2026-11-03 이하 봉으로 체결될 수 있음",
      `kr_rules: ${CAUTION}`,
    ] },
  }],
};

const EMPTY_LISTS = {
  "/api/paper/books/kr_rules/positions": { available: true, book: NOT_STARTED[0], positions: [], lockouts: [], cash: 100_000_000 },
  "/api/paper/books/kr_rules/orders": { available: true, orders: [] },
  "/api/paper/books/kr_rules/fills": { available: true, confirmationTotal: { rows: 0, cashDelta: null, unconfirmed: 0 }, fills: [] },
  "/api/paper/books/kr_rules/nav": { available: true, book: NOT_STARTED[0], series: [] },
  "/api/paper/status?market=KR": { ...STATUS, jobs: [] },
};

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않는 요청. 긴 경로부터 맞춥니다. */
let reads: Record<string, () => Promise<unknown>> = {};

beforeEach(() => {
  reads = {};
  window.history.replaceState(null, "", "/paper/kr/holdings");
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
    return key ? reads[key]() : new Promise(() => {});
  });
});

afterEach(() => cleanup());

const requested = () => api.apiGetShared.mock.calls.map(([path]) => String(path));

/** 카드 하나(제목 h2로 찾음). */
function card(title: string | RegExp): HTMLElement {
  const heading = screen.getByRole("heading", { name: title });
  const section = heading.closest("section");
  if (!section) throw new Error(`카드 없음: ${String(title)}`);
  return section as HTMLElement;
}

function rowOf(table: HTMLElement, text: string): HTMLElement {
  const row = within(table).getAllByRole("row").find((tr) => tr.textContent?.includes(text));
  if (!row) throw new Error(`줄 없음: ${text}`);
  return row;
}

describe("불러오는 중", () => {
  it("보유·주문·체결·순자산 기록이 오기 전에는 표마다 읽는 중 — 한국 계좌 코드 경로와 상태(?market=KR)를 읽는다", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve(overview(BOOKS));
    render(<PaperPage market="KR" initialTab="holdings" />);

    expect(await screen.findByText("보유를 읽는 중…")).toBeTruthy();
    expect(screen.getByText("주문을 읽는 중…")).toBeTruthy();
    expect(screen.getByText("체결을 읽는 중…")).toBeTruthy();
    expect(screen.getByText("순자산 기록을 읽는 중…")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "보유·체결" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(requested()).toContain("/api/paper/books/kr_rules/nav"));
    expect(requested()).toContain("/api/paper/books/kr_rules/positions");
    expect(requested()).toContain("/api/paper/books/kr_rules/fills?limit=50");
    expect(requested()).toContain("/api/paper/status?market=KR");
  });
});

describe("빈 상태(시작 전)", () => {
  it("보유·체결·순자산 기록이 비었다고 말하고, 시작 단추 대신 네 계좌 함께 출발 안내 — 합계는 '—(확정 조정 행 없음)'", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve(overview(NOT_STARTED));
    for (const [path, body] of Object.entries(EMPTY_LISTS)) reads[path] = () => Promise.resolve(body);
    render(<PaperPage market="KR" initialTab="holdings" />);

    expect(await screen.findByText("보유가 없습니다 — 현금만 들고 있습니다.")).toBeTruthy();
    expect(screen.getByText(/한국 계좌는 출발 결정 다음 KR 거래일 시가에 처음 체결합니다/)).toBeTruthy();
    expect(await screen.findByText(/순자산 기록이 없습니다 — 출발일 줄/)).toBeTruthy();
    expect(screen.getByText("확정 조정 합계 —(확정 조정 행 없음) · 확정 0건 · 남음 0건")).toBeTruthy();
    expect(screen.getByText(/시작 전인 한국 계좌는 따로 시작하지 않습니다/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "일시정지" })).toBeNull();
    expect(screen.getByText("현금 100,000,000원")).toBeTruthy();
    // 미국 표기가 섞이지 않음
    expect(screen.queryByText(/달러/)).toBeNull();
    expect(screen.queryByText(/사후 체결합니다/)).toBeNull();
  });
});

const DORMANT = {
  available: true, market: "KR", currency: "KRW",
  dormantReason: "한국 책 출발일(dashboard.paper.kr.start-date — .env PAPER_KR_START_DATE)이 비어 있어 한국 초기화·출발을 하지 않습니다",
  initialized: false, pendingBackfill: [], startDate: null, books: [], navSeries: { dates: [], books: {} }, quotes: null,
  selection: null, gate: null, claudeExposureSeries: [], frameworkBoundaries: [], limits: [], jobs: [],
};

describe("쉬는 한국(계좌 없음)", () => {
  it("쉬는 사유는 맨 위 경고, 탭에는 한국 초기화 안내 — 계좌 코드 경로를 읽지 않는다", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve(DORMANT);
    render(<PaperPage market="KR" initialTab="holdings" />);
    expect(await screen.findByText(/아직 한국 계좌가 없습니다 — 출발일이 정해지면 개요 탭의 '한국 초기화'로 네 계좌가 생깁니다/)).toBeTruthy();
    expect(screen.getByText(/한국 책이 쉬고 있습니다/)).toBeTruthy();
    expect(requested().some((path) => path.startsWith("/api/paper/books/"))).toBe(false);
  });
});

describe("오류", () => {
  it("표마다 오류 + 다시 시도 — 누르면 그 표만 다시 읽는다", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve(overview(BOOKS));
    let positionCalls = 0;
    reads["/api/paper/books/kr_rules/positions"] = () => {
      positionCalls += 1;
      return positionCalls === 1 ? Promise.reject(new Error("보유를 읽지 못했습니다.")) : Promise.resolve(POSITIONS);
    };
    reads["/api/paper/books/kr_rules/fills"] = () => Promise.reject(new Error("체결을 읽지 못했습니다."));
    reads["/api/paper/books/kr_rules/nav"] = () => Promise.reject(new Error("순자산 기록을 읽지 못했습니다."));
    reads["/api/paper/books/kr_rules/orders"] = () => Promise.resolve(ORDERS);
    reads["/api/paper/status?market=KR"] = () => Promise.reject(new Error("상태를 읽지 못했습니다."));
    render(<PaperPage market="KR" initialTab="holdings" />);

    expect(await screen.findByText("보유를 읽지 못했습니다.")).toBeTruthy();
    expect(await screen.findByText("체결을 읽지 못했습니다.")).toBeTruthy();
    expect(await screen.findByText("순자산 기록을 읽지 못했습니다.")).toBeTruthy();
    expect(await screen.findByText(/작업 기록을 읽지 못해 잠정 사유를 고르지 못했습니다/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /다시 시도/ }).length).toBeGreaterThanOrEqual(3);

    fireEvent.click(within(card("보유")).getByRole("button", { name: /다시 시도/ }));
    expect(await screen.findByText("005930")).toBeTruthy();
    expect(positionCalls).toBe(2);
    expect(screen.getByText("체결을 읽지 못했습니다.")).toBeTruthy();
  });
});

describe("자료", () => {
  beforeEach(() => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve(overview(BOOKS));
    reads["/api/paper/books/kr_rules/positions"] = () => Promise.resolve(POSITIONS);
    reads["/api/paper/books/kr_rules/orders"] = () => Promise.resolve(ORDERS);
    reads["/api/paper/books/kr_rules/fills"] = () => Promise.resolve(FILLS);
    reads["/api/paper/books/kr_rules/nav"] = () => Promise.resolve(NAV);
    reads["/api/paper/status?market=KR"] = () => Promise.resolve(STATUS);
  });

  it("보유 표 — 원 단위 정수 칸, '기업행위 확인 필요'(사유는 title)·'가격 없음' 배지, 재진입 금지는 KR 거래일", async () => {
    render(<PaperPage market="KR" initialTab="holdings" />);
    const table = await screen.findByRole("table", { name: "보유" });
    const headers = within(table).getAllByRole("columnheader").map((th) => th.textContent);
    expect(headers).toContain("평단(원)");
    expect(headers).toContain("평가액(원)↕");
    const held = rowOf(table, "000660");
    expect(within(held).getByText("기업행위 확인 필요").getAttribute("title")).toContain("2026-11-03 상장주식수 변동(분할·병합 추정) — 확인 필요");
    expect(within(held).getByText("200,000")).toBeTruthy();
    expect(within(held).getByText("1,005,000")).toBeTruthy();
    expect(within(rowOf(table, "035420")).getByText("가격 없음 · 지난 값")).toBeTruthy();
    expect(within(rowOf(table, "005930")).getByText("2026-11-03부터 · 1 KR 거래일")).toBeTruthy();
    expect(screen.getByText("현금 340,000원")).toBeTruthy();
    expect(within(screen.getByRole("table", { name: "재진입 금지" })).getByText("이 날까지(KR 거래일)")).toBeTruthy();
  });

  // 수정 전에는 기업행위 보류로 묶인 평가(금융위 확정 종가 — 시각은 장부가 묶은 때)도 '{시각} 관측(토스증권 잠정)'이라 적었습니다(it.fails).
  it.fails("보유 가격 툴팁 — 보통 보유는 관측 시각(토스증권 잠정), 기업행위 보류 보유는 묶인 평가(금융위 확정 종가, 없으면 마지막 평가 가격)", async () => {
    render(<PaperPage market="KR" initialTab="holdings" />);
    const table = await screen.findByRole("table", { name: "보유" });
    // 가격 칸(최고가 칸도 71,500이라 첫째 — 가격 칸이 앞)
    expect(within(rowOf(table, "005930")).getAllByText("71,500")[0].getAttribute("title")).toBe("2026-11-03 21:57 관측(토스증권 잠정)");
    const held = within(rowOf(table, "000660")).getByText("201,000").getAttribute("title") ?? "";
    expect(held).toContain("묶인 평가");
    expect(held).toContain("금융위 확정 종가");
    expect(held).not.toContain("토스증권 잠정");
    expect(held).not.toContain("관측");
  });

  it("체결 표 — 잠정 체결가·출처·비용 칸·실효 bp, 확정 행의 확정가·차이·현금 차이, 미보정(ETF) 배지, 합계와 '주의'", async () => {
    render(<PaperPage market="KR" initialTab="holdings" />);
    const table = await screen.findByRole("table", { name: "체결" });
    const confirmed = rowOf(table, "005930");
    expect(within(confirmed).getByText("확정")).toBeTruthy();
    expect(within(confirmed).getByText("71,300")).toBeTruthy();
    expect(within(confirmed).getByText("KRX 시가 단일가(1분봉)")).toBeTruthy();
    expect(within(confirmed).getByText("6.48bp")).toBeTruthy();
    expect(within(confirmed).getByText("71,200원")).toBeTruthy();
    expect(within(confirmed).getByText("차이 -100원")).toBeTruthy();
    expect(within(confirmed).getByText("106 · 0 · 356")).toBeTruthy();
    expect(within(confirmed).getByText("+1,000원")).toBeTruthy();
    const etf = rowOf(table, "153130");
    expect(within(etf).getByText("금융위 확정 미보정(ETF)")).toBeTruthy();
    expect(within(etf).getByText("KRX 일봉 시가")).toBeTruthy();
    expect(within(etf).getAllByText("—").length).toBe(2);
    expect(screen.getByText("확정 조정 합계 +1,000원 · 확정 1건 · 남음 1건")).toBeTruthy();
    expect(screen.getByText("확정 조정 주의")).toBeTruthy();
    expect(screen.getByText(CAUTION)).toBeTruthy();
  });

  // 예전에는 비용 칸이 잠정 체결의 값만(머리에 '잠정' 없이) 보여, 확정 행에서 장부가 실제로 센 확정 비용과 섞여 읽혔습니다.
  it("체결 표 — 비용·실효 비용 칸 머리는 '잠정', 확정 행은 확정가로 다시 센 비용·실효 비용을 '확정'으로 함께", async () => {
    render(<PaperPage market="KR" initialTab="holdings" />);
    const table = await screen.findByRole("table", { name: "체결" });
    const headers = within(table).getAllByRole("columnheader").map((th) => th.textContent);
    expect(headers).toContain("잠정 수수료·세금·슬리피지(원)");
    expect(headers).toContain("잠정 실효 비용");
    const confirmed = rowOf(table, "005930");
    expect(within(confirmed).getByText("106 · 0 · 356")).toBeTruthy();
    expect(within(confirmed).getByText("확정 105 · 0 · 356")).toBeTruthy();
    expect(within(confirmed).getByText("6.48bp")).toBeTruthy();
    expect(within(confirmed).getByText("확정 6.49bp")).toBeTruthy();
    expect(within(rowOf(table, "153130")).queryByText(/^확정 /)).toBeNull();
  });

  it("주문 표 — 스탑 근거(감지·확정값으로 낮춘 최고가·재판정·stopBasisNote), 재판정 취소 이름표", async () => {
    render(<PaperPage market="KR" initialTab="holdings" />);
    const table = await screen.findByRole("table", { name: "주문" });
    const stop = rowOf(table, "035420");
    expect(within(stop).getByText("다음 거래일 시가")).toBeTruthy();
    expect(within(stop).getByText("스탑 취소 — 확정 종가가 뒷받침하지 않음")).toBeTruthy();
    expect(within(stop).getByText(/확정값으로 낮춘 최고가 72,000원 · 재판정: 금융위 주식시세 확정 종가 70,000원/)).toBeTruthy();
    expect(within(stop).getByText(/감지 2026-11-03 잠정 종가 68,500원\(KRX\+NXT 통합가\)/)).toBeTruthy();
  });

  it("순자산 기록 — 최근 거래일부터, 잠정 줄은 작업 기록의 사유, 확정 줄은 '확정(금융위 종가)'", async () => {
    render(<PaperPage market="KR" initialTab="holdings" />);
    const table = await screen.findByRole("table", { name: "순자산 기록" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0].textContent).toContain("2026-11-03");
    expect(within(rows[0]).getByText("잠정")).toBeTruthy();
    expect(within(rows[0]).getByText(/주문 31 SELL 035420\(기준일 2026-11-02\) 대기 — 2026-11-03 이하 봉으로 체결될 수 있음/)).toBeTruthy();
    expect(within(rows[0]).getByText("100,312,450원")).toBeTruthy();
    expect(within(rows[1]).getByText("확정(금융위 종가)")).toBeTruthy();
  });

  it("계좌 초기화 확인 창 — 한국 문구(사후 체결 없음, 한 계좌만이면 다시 출발하지 않음, 넷 모두면 다음 KR 거래일 창)", async () => {
    render(<PaperPage market="KR" initialTab="holdings" />);
    fireEvent.click(await screen.findByRole("button", { name: "계좌 초기화" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/한국 계좌에는 사후 체결이 없습니다 — 이 계좌만 지우면/)).toBeTruthy();
    expect(within(dialog).getByText(/네 계좌를 모두 지우면 다음 KR 거래일 결정 창에서/)).toBeTruthy();
    expect(within(dialog).queryByText(/출발일 종가로 다시 사후 체결/)).toBeNull();
  });
});
