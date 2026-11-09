/**
 * 모의매매 화면의 '실제 계좌' 탭(토스증권, 읽기 전용 — ADR 0025, 명세 docs/specs/2026-11-05-toss-account-readonly.md §5·§6).
 *
 *  - 탭을 열 때만 읽는다 — 개요 탭만 보면 /api/brokerage를 부르지 않고, 실제 계좌 탭은 그 시장 쪽 하나(GET, 40초 한도)
 *  - 한국 화면은 원화 쪽만, 미국 화면은 달러 쪽만 — 맨 위 '모의 장부와 별개 · 조회는 읽기 전용' 배너와 다른 시장 탭 링크
 *    (자동 매매는 그 위 실제 매매 칸 — ADR 0028, 그 칸의 시험은 components/screens/realtrade/__tests__)
 *  - 꺼짐(DISABLED)은 안내만(숫자·표·다시 읽기 없음), 그 밖의 실패는 고정 문구와 다시 시도, 요청 실패도 다시 시도
 *  - 모르는 숫자는 '—'(0으로 채우지 않음), 서버 이전 값(isStale)·화면 다시 읽기 실패(refreshError)는 '이전 값'과 받은 시각
 *  - 보유가 없으면 '보유 종목 없음', 끝난 주문이 잘렸으면 '일부만 받았습니다', 분류하지 못한 항목 수
 *  - 주문·매수·매도·취소·정정 단추가 없고 쓰기 호출(apiPost·apiDelete)이 없다
 *  - 명세 2026-11-06-us-costs-backfill §6: 탭 머리의 주기 상자(실시간 시세와 같은 값)로 고른 주기마다 다시 읽음 — 끄기 또는 10초 이상(5초는 10초로),
 *    꺼짐(DISABLED)이면 주기 상자도 다시 읽기도 없음, 기준 시각은 받은 시각 초까지
 * 값은 모두 토스 스펙 예시에서 만든 합성 값입니다(실제 계좌 자료 아님).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLiveSecondsForTest } from "@/hooks/useLiveSeconds";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 객체를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  // 개요 히어로의 선 차트 — 이 시험은 그 그림을 보지 않습니다.
  LineChart: () => null,
  MultiLineSeries: () => null,
  DonutChart: () => null,
}));
vi.mock("next/navigation", () => ({ usePathname: () => null }));

import PaperScreen from "@/components/screens/paper/PaperScreen";

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };

function book(code: string, over: Record<string, unknown> = {}) {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000,
    cash: 200, nav: 100000, equityValue: 99800, exposurePct: 99.8, returnPct: 0,
    lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: STATS, benchmark: null, ...over,
  };
}

const OVERVIEW = {
  available: true, initialized: true, startDate: "2026-10-23", limits: [],
  books: [book("rules", { kind: "RULES", label: "규칙 계좌" }), book("claude", { kind: "CLAUDE", label: "Claude 계좌" })],
  jobs: [], pendingBackfill: [], navSeries: { dates: [], books: {} }, quotes: null,
};

const KR_OVERVIEW = {
  ...OVERVIEW, market: "KR", currency: "KRW", dormantReason: null, startDate: "2026-10-29",
  books: [book("kr_rules", { kind: "RULES", label: "한국 규칙 계좌", initialCash: 100_000_000, nav: 100_000_000 })],
};

/** 토스 스펙 예시(삼성전자 100주·평균 65,000원·현재 72,000원)로 만든 원화 쪽. */
const KR_SIDE = {
  currency: "KRW",
  buyingPower: 1_000_000,
  summary: {
    purchaseAmount: 6_500_000, marketValue: 7_200_000, marketValueAfterCost: 7_185_600, profitLoss: 700_000,
    profitLossAfterCost: 685_600, dailyProfitLoss: 50_000, profitLossPct: 10.7692, profitLossPctAfterCost: 10.5477,
  },
  holdings: [{
    symbol: "005930", name: "삼성전자", marketCountry: "KR", currency: "KRW", quantity: 100, lastPrice: 72_000,
    averagePurchasePrice: 65_000, purchaseAmount: 6_500_000, marketValue: 7_200_000, marketValueAfterCost: 7_185_600,
    profitLoss: 700_000, profitLossAfterCost: 685_600, profitLossPct: 10.77, profitLossPctAfterCost: 10.55,
    dailyProfitLoss: 50_000, dailyProfitLossPct: 0.7,
  }],
};

/** 미국 소수점 주식(0.123456주)으로 만든 달러 쪽. */
const US_SIDE = {
  currency: "USD",
  buyingPower: 2500.5,
  summary: {
    purchaseAmount: 17.28, marketValue: 18.55, marketValueAfterCost: 18.5, profitLoss: 1.27,
    profitLossAfterCost: 1.22, dailyProfitLoss: -0.12, profitLossPct: 7.3495, profitLossPctAfterCost: 7.0602,
  },
  holdings: [{
    symbol: "AAPL", name: "애플", marketCountry: "US", currency: "USD", quantity: 0.123456, lastPrice: 150.25,
    averagePurchasePrice: 140, purchaseAmount: 17.28, marketValue: 18.55, marketValueAfterCost: 18.5,
    profitLoss: 1.27, profitLossAfterCost: 1.22, profitLossPct: 7.35, profitLossPctAfterCost: 7.06,
    dailyProfitLoss: -0.12, dailyProfitLossPct: -0.64,
  }],
};

function order(over: Record<string, unknown> = {}) {
  return {
    symbol: "005930", name: "삼성전자", side: "BUY", orderType: "LIMIT", timeInForce: "DAY", status: "PENDING", currency: "KRW",
    price: 70_000, quantity: 10, orderAmount: null, orderedAtKst: "2026-03-29 09:30", canceledAtKst: null, filledQuantity: 0,
    averageFilledPrice: null, filledAmount: null, commission: null, tax: null, filledAtKst: null, settlementDate: null, ...over,
  };
}

function account(market: "KR" | "US", over: Record<string, unknown> = {}) {
  return {
    available: true, state: "OK", message: null, market, accountLabel: "토스증권 종합매매", accountCount: 1,
    fetchedAtKst: "2026-03-29 09:31", staleSinceKst: null, ageSeconds: 5, isStale: false, staleReason: null, upstreamCode: null,
    ...(market === "KR" ? KR_SIDE : US_SIDE),
    openOrders: market === "KR" ? [order()] : [],
    closedOrders: market === "KR"
      ? [order({ status: "FILLED", side: "SELL", filledQuantity: 10, averageFilledPrice: 70_000, filledAmount: 700_000, commission: 1400, tax: 0,
        filledAtKst: "2026-03-28 09:31", settlementDate: "2026-03-30" })]
      : [],
    closedFromDate: "2026-02-27", closedTruncated: false, unclassifiedCount: 0, ...over,
  };
}

/** 숫자 없이 실패 상태만 담은 응답(백엔드는 실패여도 200). */
function failed(market: "KR" | "US", state: string, message: string | null) {
  return {
    ...account(market), available: false, state, message, buyingPower: null, summary: null, holdings: [], openOrders: [],
    closedOrders: [], fetchedAtKst: null, ageSeconds: null, closedFromDate: null,
  };
}

let reads: Record<string, () => Promise<unknown>> = {};
const brokerageCalls = () => api.apiGetShared.mock.calls.map(([path]) => String(path)).filter((path) => path.startsWith("/api/brokerage"));

beforeEach(() => {
  window.history.replaceState(null, "", "/paper/us");
  reads = {
    "/api/paper/overview?market=KR": () => Promise.resolve(KR_OVERVIEW),
    "/api/paper/overview": () => Promise.resolve(OVERVIEW),
    "/api/brokerage/account?market=KR": () => Promise.resolve(account("KR")),
    "/api/brokerage/account?market=US": () => Promise.resolve(account("US")),
  };
  api.apiPost.mockReset();
  api.apiDelete.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
    return key ? reads[key]() : new Promise(() => {});
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const panel = () => screen.getByRole("tabpanel");
const tile = (name: string | RegExp) => within(panel()).getByRole("group", { name });
/** 타일의 값 글자(카드 숫자 24px) — 색 구분을 보려고. */
const tileValue = (name: string | RegExp): HTMLElement => {
  const value = tile(name).querySelector<HTMLElement>("span.text-2xl");
  if (value === null) {
    throw new Error(`타일 값이 없습니다: ${String(name)}`);
  }
  return value;
};

describe("읽는 때", () => {
  it("개요 탭만 보면 /api/brokerage를 부르지 않고, 실제 계좌 탭을 누르면 그 시장 쪽 하나를 GET(40초 한도)", async () => {
    render(<PaperScreen />);
    const real = await screen.findByRole("tab", { name: "실제 계좌" });
    expect(await screen.findByRole("button", { name: /규칙 계좌 상세 보기/ })).toBeTruthy();
    expect(brokerageCalls()).toEqual([]);

    fireEvent.click(real);
    expect(window.location.pathname).toBe("/paper/us/real");
    expect(await screen.findByText("실제 계좌 요약 — 달러")).toBeTruthy();
    expect(brokerageCalls()).toEqual(["/api/brokerage/account?market=US"]);
    expect(api.apiGetShared).toHaveBeenCalledWith("/api/brokerage/account?market=US", 40_000);

    // 다른 탭으로 옮기면 섹션이 떨어지고 더 읽지 않습니다.
    fireEvent.click(screen.getByRole("tab", { name: "개요" }));
    expect(screen.queryByText("실제 계좌 요약 — 달러")).toBeNull();
    expect(brokerageCalls()).toHaveLength(1);
  });
});

describe("시장 쪽 나누기", () => {
  it("한국 화면은 원화 쪽만 — 타일·표 단위가 원, 달러 쪽은 부르지 않고 미국 화면의 실제 계좌 탭으로 링크", async () => {
    window.history.replaceState(null, "", "/paper/kr/real");
    render(<PaperScreen market="KR" initialTab="real" />);

    expect(await screen.findByText("실제 계좌 요약 — 원화")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "실제 계좌" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText(/실제 계좌\(토스증권\) — 모의 장부와 별개 · 조회는 읽기 전용 — 자동 매매는 위 실제 매매 칸/)).toBeTruthy();
    expect(screen.getByText(/원화 자산만 — 달러 자산은/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "모의매매(미국)의 실제 계좌 탭" }).getAttribute("href")).toBe("/paper/us/real");

    expect(tile("평가금액").textContent).toContain("7,200,000원");
    expect(tile("평가손익").textContent).toContain("+700,000원");
    expect(tile("평가손익").textContent).toContain("손익률 +10.77%(대시보드 계산)");
    expect(tile("일간 손익").textContent).toContain("+50,000원");
    // 손익 두 타일만 색 — 이익은 빨강(text-up), 평가금액 같은 금액 타일은 본문색 그대로
    expect(tileValue("평가손익").className).toContain("text-up");
    expect(tileValue("일간 손익").className).toContain("text-up");
    expect(tileValue("평가금액").className).toContain("text-text");
    expect(tileValue("평가금액").className).not.toMatch(/text-(up|down)/);
    expect(tile("매수 가능 금액(원화)").textContent).toContain("1,000,000원");
    expect(tile("매수 가능 금액(원화)").textContent).toContain("통화별 현금 기반 — 두 화면의 금액을 더하지 마세요");
    for (const name of ["평가금액", "매입금액", "평가손익", "일간 손익", "매수 가능 금액(원화)"]) {
      expect(tile(name).textContent, name).not.toContain("달러");
    }

    const holdings = within(panel()).getByRole("table", { name: "실제 계좌 보유 종목" });
    expect(within(holdings).getByText("삼성전자")).toBeTruthy();
    expect(within(holdings).getByRole("columnheader", { name: /평가금액\(원\)/ })).toBeTruthy();
    expect(within(holdings).getByText("7,200,000")).toBeTruthy();

    // 주문 표 — 한국어 이름표(방향·호가·조건·상태).
    const open = within(panel()).getByRole("table", { name: "진행 중 주문(실제)" });
    expect(within(open).getByText("매수")).toBeTruthy();
    expect(within(open).getByText("지정가 · 당일")).toBeTruthy();
    expect(within(open).getByText("체결 대기")).toBeTruthy();
    const closed = within(panel()).getByRole("table", { name: "최근 끝난 주문(실제)" });
    expect(within(closed).getByText("체결 완료")).toBeTruthy();
    expect(within(closed).getByText("매도")).toBeTruthy();

    expect(brokerageCalls().every((path) => path === "/api/brokerage/account?market=KR")).toBe(true);
  });

  it("미국 화면은 달러 쪽만 — 소수점 수량은 6자리까지, 한국 화면의 실제 계좌 탭으로 링크", async () => {
    window.history.replaceState(null, "", "/paper/us/real");
    render(<PaperScreen initialTab="real" />);

    expect(await screen.findByText("실제 계좌 요약 — 달러")).toBeTruthy();
    expect(screen.getByText(/달러 자산만 — 원화 자산은/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "모의매매(한국)의 실제 계좌 탭" }).getAttribute("href")).toBe("/paper/kr/real");

    expect(tile("평가금액").textContent).toContain("18.55달러");
    expect(tile("일간 손익").textContent).toContain("-0.12달러");
    expect(tileValue("일간 손익").className).toContain("text-down");   // 손실은 파랑
    expect(tileValue("평가손익").className).toContain("text-up");
    expect(tile("매수 가능 금액(달러)").textContent).toContain("2,500.50달러");
    for (const name of ["평가금액", "매입금액", "평가손익", "일간 손익", "매수 가능 금액(달러)"]) {
      expect(tile(name).textContent, name).not.toMatch(/원$|원[^화]/);
    }

    const holdings = within(panel()).getByRole("table", { name: "실제 계좌 보유 종목" });
    expect(within(holdings).getByText("0.123456")).toBeTruthy();
    expect(within(holdings).getByText("150.25")).toBeTruthy();
    expect(within(holdings).getByRole("columnheader", { name: /평가금액\(달러\)/ })).toBeTruthy();
    expect(brokerageCalls().every((path) => path === "/api/brokerage/account?market=US")).toBe(true);
  });
});

describe("보유 종목 팝업", () => {
  it("보유 종목을 누르면 화면을 떠나지 않고 종목 팝업 창이 열림", async () => {
    render(<PaperScreen market="KR" initialTab="real" />);
    const holdings = await screen.findByRole("table", { name: "실제 계좌 보유 종목" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(within(holdings).getByRole("button", { name: /삼성전자/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("상태", () => {
  it("꺼짐(DISABLED)은 안내만 — 숫자 타일·표·다시 읽기 단추가 없다", async () => {
    reads["/api/brokerage/account?market=US"] = () => Promise.resolve(
      failed("US", "DISABLED", "실제 계좌 조회가 꺼져 있습니다. 운영 서버에서만 켭니다."),
    );
    render(<PaperScreen initialTab="real" />);

    expect(await screen.findByText("실제 계좌 조회가 꺼져 있습니다. 운영 서버에서만 켭니다.")).toBeTruthy();
    expect(within(panel()).queryAllByRole("group")).toEqual([]);
    expect(within(panel()).queryAllByRole("table")).toEqual([]);
    // 조회 쪽 단추가 없습니다 — 맨 위 실제 매매 칸(ADR 0028, 미국은 '준비 중'과 꺼진 단추)은 조회와 별개라 뺍니다.
    expect(within(panel()).queryAllByRole("button").filter((button) => !button.closest("[role='region'][aria-label='실제 매매']"))).toEqual([]);
    // 꺼져 있어도 '모의 장부와 별개 · 조회는 읽기 전용' 배너는 그대로입니다.
    expect(screen.getByText(/모의 장부와 별개 · 조회는 읽기 전용/)).toBeTruthy();
  });

  it("그 밖의 실패는 고정 문구(+ 토스 코드)와 다시 시도 — 누르면 다시 읽는다, 숫자는 없음", async () => {
    reads["/api/brokerage/account?market=US"] = () => Promise.resolve({
      ...failed("US", "RATE_LIMITED", "토스증권 호출 한도에 걸려 읽지 못했습니다."), upstreamCode: "rate-limit-exceeded",
    });
    render(<PaperScreen initialTab="real" />);

    expect(await screen.findByText("토스증권 호출 한도에 걸려 읽지 못했습니다.")).toBeTruthy();
    expect(screen.getByText("토스 오류 코드 rate-limit-exceeded")).toBeTruthy();
    expect(within(panel()).queryAllByRole("group")).toEqual([]);

    fireEvent.click(within(panel()).getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(brokerageCalls()).toHaveLength(2));
  });

  it("백엔드 문구가 없으면 state별 고정 문구", async () => {
    reads["/api/brokerage/account?market=KR"] = () => Promise.resolve(failed("KR", "COLLECTOR_UNREACHABLE", null));
    render(<PaperScreen market="KR" initialTab="real" />);
    expect(await screen.findByText("수집기에 닿지 못해 실제 계좌를 읽지 못했습니다.")).toBeTruthy();
  });

  it("요청 자체가 실패하면 이유와 다시 시도", async () => {
    reads["/api/brokerage/account?market=US"] = () => Promise.reject(new Error("요청 실패 (HTTP 500)"));
    render(<PaperScreen initialTab="real" />);

    expect(await screen.findByText("실제 계좌를 읽지 못했습니다 — 요청 실패 (HTTP 500)")).toBeTruthy();
    fireEvent.click(within(panel()).getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(brokerageCalls()).toHaveLength(2));
  });

  it("모르는 숫자는 '—'(0으로 채우지 않음), 보유가 없으면 '보유 종목 없음'", async () => {
    reads["/api/brokerage/account?market=KR"] = () => Promise.resolve(account("KR", {
      buyingPower: null,
      summary: {
        purchaseAmount: null, marketValue: null, marketValueAfterCost: null, profitLoss: null, profitLossAfterCost: null,
        dailyProfitLoss: null, profitLossPct: null, profitLossPctAfterCost: null,
      },
      holdings: [],
      openOrders: [order({ price: null, orderType: "MARKET", status: "NEW_STATUS" })],
    }));
    render(<PaperScreen market="KR" initialTab="real" />);

    expect(await screen.findByText("실제 계좌 요약 — 원화")).toBeTruthy();
    for (const name of ["평가금액", "매입금액", "평가손익", "일간 손익", "매수 가능 금액(원화)"]) {
      expect(within(tile(name)).getByText("값 없음"), name).toBeTruthy();
      expect(tile(name).textContent, name).not.toMatch(/\b0원|0\.00/);
    }
    expect(tile("평가손익").textContent).toContain("손익률 —(대시보드 계산)");
    expect(within(panel()).getByText("보유 종목 없음")).toBeTruthy();
    // 시장가라 가격이 없으면 '—', 모르는 상태는 원문 그대로.
    const open = within(panel()).getByRole("table", { name: "진행 중 주문(실제)" });
    expect(within(open).getByText("NEW_STATUS")).toBeTruthy();
    expect(within(open).getAllByText("값 없음").length).toBeGreaterThan(0);
  });

  it("서버가 이전 값을 보이면(isStale) '이전 값'과 받은 시각·실패 이유", async () => {
    reads["/api/brokerage/account?market=KR"] = () => Promise.resolve(account("KR", {
      isStale: true, staleReason: "RATE_LIMITED", staleSinceKst: "2026-03-29 09:40",
    }));
    render(<PaperScreen market="KR" initialTab="real" />);

    expect(await screen.findByText("이전 값")).toBeTruthy();
    expect(screen.getByText(/2026-03-29 09:31에 받은 값 — 그 뒤 새로 읽지 못함\(호출 한도\)/)).toBeTruthy();
    // 이전 값도 숫자는 그대로 보입니다(배지가 함께).
    expect(tile("평가금액").textContent).toContain("7,200,000원");
  });

  it("다시 읽기가 실패하면(refreshError) 앞서 받은 값에 '이전 값'과 받은 시각", async () => {
    render(<PaperScreen market="KR" initialTab="real" />);
    expect(await screen.findByText("실제 계좌 요약 — 원화")).toBeTruthy();
    expect(screen.queryByText("이전 값")).toBeNull();

    reads["/api/brokerage/account?market=KR"] = () => Promise.reject(new Error("요청 실패 (HTTP 502)"));
    fireEvent.click(within(panel()).getByRole("button", { name: "다시 읽기" }));

    expect(await screen.findByText("이전 값")).toBeTruthy();
    expect(screen.getByText(/2026-03-29 09:31에 받은 값 — 다시 읽기 실패/)).toBeTruthy();
    expect(tile("평가금액").textContent).toContain("7,200,000원");
  });

  it("끝난 주문이 잘렸으면 '일부만 받았습니다', 분류하지 못한 항목 수를 적는다", async () => {
    reads["/api/brokerage/account?market=KR"] = () => Promise.resolve(account("KR", { closedTruncated: true, unclassifiedCount: 2 }));
    render(<PaperScreen market="KR" initialTab="real" />);

    expect(await screen.findByText(/최근 끝난 주문은 일부만 받았습니다/)).toBeTruthy();
    expect(screen.getByText(/분류하지 못한 항목 2개/)).toBeTruthy();
  });
});

describe("읽기 전용", () => {
  it("주문·매수·매도·취소·정정 단추가 없고 쓰기 호출(apiPost·apiDelete)이 없다", async () => {
    render(<PaperScreen market="KR" initialTab="real" />);
    expect(await screen.findByText("실제 계좌 요약 — 원화")).toBeTruthy();

    const names = within(panel()).getAllByRole("button").map((button) => button.textContent ?? "");
    expect(names.some((name) => name.includes("다시 읽기"))).toBe(true);
    expect(names.filter((name) => /주문|매수|매도|취소|정정|order|buy|sell|cancel/i.test(name))).toEqual([]);
    // 표의 행은 누를 수 없습니다(계좌 행처럼 열리지 않음).
    for (const table of within(panel()).getAllByRole("table")) {
      for (const row of within(table).getAllByRole("row")) expect(row.getAttribute("tabindex"), "행").toBeNull();
    }

    fireEvent.click(within(panel()).getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(brokerageCalls()).toHaveLength(2));
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(api.apiDelete).not.toHaveBeenCalled();
  });
});

describe("새로고침 주기와 기준 시각(명세 2026-11-06-us-costs-backfill §6)", () => {
  let intervals: ReturnType<typeof vi.spyOn>;
  let clears: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.localStorage.clear();
    resetLiveSecondsForTest();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    intervals = vi.spyOn(globalThis, "setInterval");
    clears = vi.spyOn(globalThis, "clearInterval");
  });

  afterEach(() => {
    window.localStorage.clear();
    resetLiveSecondsForTest();
  });

  /**
   * 그 간격(ms)으로 걸린 타이머 가운데 실제 계좌를 다시 읽는 것의 id — 하나씩 불러 /api/brokerage를 읽는지 봅니다(같은 화면의 다른 타이머와 가림).
   * 손으로 부르면 풀린 타이머도 돌므로, 풀렸는지는 clearInterval 기록으로 따로 봅니다.
   */
  async function brokerageTimers(ms: number): Promise<unknown[]> {
    const found: unknown[] = [];
    const calls = intervals.mock.calls as unknown as [() => void, number][];
    for (const [index, [callback, delay]] of calls.entries()) {
      if (delay !== ms) continue;
      const before = brokerageCalls().length;
      await act(async () => callback());
      if (brokerageCalls().length > before) found.push(intervals.mock.results[index]?.value);
    }
    return found;
  }
  const cleared = (id: unknown) => (clears.mock.calls as unknown as [unknown][]).some(([value]) => value === id);
  /** 걸린 타이머의 간격(ms) 목록. */
  const delays = () => (intervals.mock.calls as unknown as [unknown, number][]).map(([, delay]) => delay);

  it("탭 머리에 기준 시각(초까지)과 주기 상자 — 기본은 실시간 시세와 같은 1시간, 요약의 받은 시각도 초까지", async () => {
    reads["/api/brokerage/account?market=KR"] = () => Promise.resolve(account("KR", { fetchedAtKst: "2026-03-29 09:31:05" }));
    render(<PaperScreen market="KR" initialTab="real" />);
    expect(await screen.findByText("실제 계좌 요약 — 원화")).toBeTruthy();

    expect(within(panel()).getByText(/^기준 시각/).textContent).toBe("기준 시각 2026-03-29 09:31:05 KST");
    expect(within(panel()).getByText("토스가 그 시각 가격으로 계산한 평가·손익(수집기가 토스에서 받은 시각)")).toBeTruthy();
    expect(within(panel()).getByText(/토스증권 종합매매 · 받은 시각 2026-03-29 09:31:05/)).toBeTruthy();
    const select = within(panel()).getByRole("combobox", { name: "새로고침 주기" }) as HTMLSelectElement;
    expect(select.value).toBe("3600");
    expect(within(panel()).getByText("1시간마다 다시 읽음 · 실시간 시세와 같은 주기")).toBeTruthy();
    expect(await brokerageTimers(3_600_000)).toHaveLength(1);
  });

  it("5초를 고르면 10초마다 다시 읽는다(계좌 캐시 10초) — 끄기면 다시 읽지 않고 '다시 읽기'만", async () => {
    render(<PaperScreen market="KR" initialTab="real" />);
    expect(await screen.findByText("실제 계좌 요약 — 원화")).toBeTruthy();
    const select = () => within(panel()).getByRole("combobox", { name: "새로고침 주기" }) as HTMLSelectElement;

    const hourly = await brokerageTimers(3_600_000);
    expect(hourly).toHaveLength(1);
    intervals.mockClear();
    fireEvent.change(select(), { target: { value: "5" } });
    expect(select().value).toBe("5");
    expect(within(panel()).getByText("10초마다 다시 읽음(5초는 10초로 — 계좌 캐시 10초) · 실시간 시세와 같은 주기")).toBeTruthy();
    // 앞 주기(1시간)의 타이머는 풀고, 5초가 아니라 10초로 겁니다.
    expect(cleared(hourly[0])).toBe(true);
    expect(delays()).not.toContain(5_000);
    const tenSeconds = await brokerageTimers(10_000);
    expect(tenSeconds).toHaveLength(1);
    // 다시 읽은 값도 한 경로의 GET뿐 — 쓰기 호출은 없습니다.
    expect(brokerageCalls().every((path) => path === "/api/brokerage/account?market=KR")).toBe(true);
    expect(api.apiPost).not.toHaveBeenCalled();

    intervals.mockClear();
    fireEvent.change(select(), { target: { value: "0" } });
    expect(within(panel()).getByText("끄기 — 탭을 열 때와 '다시 읽기' 때만 읽음 · 실시간 시세와 같은 주기")).toBeTruthy();
    // 끄기 — 10초 타이머를 풀고 새 타이머를 걸지 않습니다('다시 읽기'만 남음).
    expect(cleared(tenSeconds[0])).toBe(true);
    expect(await brokerageTimers(10_000)).toEqual([]);
    expect(delays().filter((delay) => typeof delay === "number" && delay >= 10_000)).toEqual([]);
    const before = brokerageCalls().length;
    fireEvent.click(within(panel()).getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(brokerageCalls()).toHaveLength(before + 1));
  });

  it("꺼짐(DISABLED)이면 주기 상자·기준 시각이 없고, 고른 주기와 상관없이 다시 읽지 않는다", async () => {
    window.localStorage.setItem("live.priceRefreshSeconds", "10");
    resetLiveSecondsForTest();
    reads["/api/brokerage/account?market=US"] = () => Promise.resolve(failed("US", "DISABLED", "실제 계좌 조회가 꺼져 있습니다."));
    render(<PaperScreen initialTab="real" />);
    expect(await screen.findByText("실제 계좌 조회가 꺼져 있습니다.")).toBeTruthy();
    await waitFor(() => expect(within(panel()).queryByRole("combobox", { name: "새로고침 주기" })).toBeNull());
    expect(within(panel()).queryByText(/^기준 시각/)).toBeNull();
    // 응답을 받기 전에는 고른 주기(10초)로 걸었다가, 꺼짐을 받은 뒤 그 타이머를 풉니다 — 새로 걸지 않습니다.
    const timers = await brokerageTimers(10_000);
    expect(timers).toHaveLength(1);
    expect(cleared(timers[0])).toBe(true);
  });

  it("실패 상태(호출 한도 등)는 기준 시각 '—' — 주기 상자는 남아 고른 주기로 다시 시도", async () => {
    reads["/api/brokerage/account?market=US"] = () => Promise.resolve(failed("US", "RATE_LIMITED", "토스증권 호출 한도에 걸려 읽지 못했습니다."));
    render(<PaperScreen initialTab="real" />);
    expect(await screen.findByText("토스증권 호출 한도에 걸려 읽지 못했습니다.")).toBeTruthy();
    expect(within(panel()).getByText(/^기준 시각/).textContent).toBe("기준 시각 —");
    expect(within(panel()).getByRole("combobox", { name: "새로고침 주기" })).toBeTruthy();
  });
});
