/**
 * 모의매매(한국) 실제 계좌 탭의 실제 매매 칸(ADR 0028, 명세 docs/specs/2026-11-06-real-trade-mirror.md §8).
 *
 *  - 탭 맨 위에 칸이 있고 상태를 GET /api/realtrade/status?market=KR로 읽는다(15초마다 — useApi 주기)
 *  - 끄기 단추는 켜짐·멈춤·끄는 중이면 보이고, 실제 계좌 읽기 실패·모의 개요 실패·상태 읽기 실패 때도, 첫 읽기·다시 읽기 중에도 보이며 누르면 확인 창 없이
 *    POST /api/realtrade/disable {market}을 보낸다 → '새 주문 멈춤 — 미체결 취소 중' → 꺼짐(취소 포기·결과 모름이 남았으면 그것을 안내)
 *  - 정기 작업 멈춤 배너는 응답의 서버 시각 기준이고, 기동 뒤 한 주기도 끝내지 못한 경우도 잡는다
 *  - 같은 켜기·끄기 단추가 실제 계좌 요약의 '다시 읽기' 옆에도 있다
 *  - 켜기 창: 기본 규칙 계좌, 책 상태, 예상 목록(/preview — 고른 책으로 다시 읽음), 경고·점검표, 확인 글자가 다르면 단추 꺼짐,
 *    비밀번호(type=password, autocomplete off) 필요, 친 글자를 그대로 보냄, 서버 오류 코드별 문구(비밀번호 틀림·버전 충돌)
 *  - 멈춤이면 멈춤 해제, 켜짐이면 설정 바꾸기(같은 확인)
 *  - 미국 탭은 '미국 실제 매매는 준비 중입니다'와 꺼진 단추(상태를 읽지 않음)
 * 값은 모두 합성 값입니다(실제 계좌 자료 아님).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  LineChart: () => null,
  MultiLineSeries: () => null,
  DonutChart: () => null,
}));
vi.mock("next/navigation", () => ({ usePathname: () => null }));

import PaperScreen from "@/components/screens/paper/PaperScreen";

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };

const KR_OVERVIEW = {
  available: true, initialized: true, startDate: "2026-10-29", limits: [], market: "KR", currency: "KRW", dormantReason: null,
  books: [{
    code: "kr_claude2", kind: "CLAUDE", label: "한국 Claude 계좌2", status: "ACTIVE", startedOn: "2026-10-30", initialCash: 100_000_000,
    cash: 0, nav: 100_000_000, equityValue: 100_000_000, exposurePct: 100, returnPct: 0, lastObservedAtKst: "2026-11-05 15:30",
    positions: 1, staleCount: 0, stats: STATS, benchmark: null,
  }],
  jobs: [], pendingBackfill: [], navSeries: { dates: [], books: {} }, quotes: null,
};

/** 합성 실제 계좌(원화 쪽) — 실제 계좌 요약과 '다시 읽기'가 그려질 만큼만. */
const ACCOUNT = {
  available: true, state: "OK", message: null, market: "KR", currency: "KRW", accountLabel: "토스증권 종합매매", accountCount: 1,
  fetchedAtKst: "2026-11-06 08:40", staleSinceKst: null, ageSeconds: 5, isStale: false, staleReason: null, upstreamCode: null,
  buyingPower: 500_000,
  summary: {
    purchaseAmount: 9_000_000, marketValue: 10_000_000, marketValueAfterCost: 9_980_000, profitLoss: 1_000_000,
    profitLossAfterCost: 980_000, dailyProfitLoss: 10_000, profitLossPct: 11.1, profitLossPctAfterCost: 10.9,
  },
  holdings: [], openOrders: [], closedOrders: [], closedFromDate: "2026-10-07", closedTruncated: false, unclassifiedCount: 0,
};

const BOOKS = [
  { code: "kr_rules", label: "한국 규칙 계좌", status: "ACTIVE" },
  { code: "kr_claude", label: "한국 Claude 계좌", status: "PAUSED" },
  { code: "kr_claude2", label: "한국 Claude 계좌2", status: "ACTIVE" },
];

function status(over: Record<string, unknown> = {}) {
  return {
    available: true, market: "KR", supported: true,
    serverEnabled: { collector: true, backend: true, reason: null },
    state: "LIVE", sourceBook: "kr_claude2", sourceLabel: "한국 Claude 계좌2",
    lossLimitPct: 15, baselineEquity: 10_000_000, buysPaused: false, haltReason: null, version: 3,
    limits: { maxOrderKrw: 5_000_000, maxOrdersPerDay: 40, maxBuyKrwPerDay: 20_000_000, maxEquityKrw: 30_000_000 },
    today: { date: "2026-11-06", skipReason: null, windows: [{ kind: "SYNC", start: "08:50:30", end: "08:58:30" }] },
    lastPreflight: { fetchedAt: "2026-11-06T08:50:31+09:00", equity: 9_500_000, cashBuyingPower: 500_000, holdings: [] },
    orders: [{
      session: "2026-11-06", purpose: "SYNC", symbol: "005930", name: "삼성전자", side: "BUY", quantity: 10, timeInForce: "OPG",
      sendOutcome: "ACCEPTED", brokerStatus: "FILLED", outcomeCode: null, filledQuantity: 10, averageFilledPrice: 72_000,
      filledAmount: 720_000, firstSentAt: "2026-11-06T08:50:31+09:00", createdAt: "2026-11-06T08:50:31+09:00", filledAt: "2026-11-06T09:00:01+09:00",
    }],
    events: [{ at: "2026-11-06T09:00:05+09:00", kind: "WINDOW_SUMMARY", detail: { purpose: "SYNC", accepted: 1, filled: 1, missed: 0, skipped: 0, blocked: 0 } }],
    books: BOOKS,
    ...over,
  };
}

const PREVIEW = {
  ok: true, equity: 10_000_000, turnoverPct: 42.5, warnings: ["첫 시가 맞추기는 회전율 한도 예외"],
  orders: [
    { symbol: "000660", name: "SK하이닉스", side: "SELL", quantity: 3, estAmount: 600_000 },
    { symbol: "005930", name: "삼성전자", side: "BUY", quantity: 10, estAmount: 720_000 },
  ],
  skipped: [{ symbol: "035720", name: "카카오", reason: "opposite-pending" }],
};

const STATUS_PATH = "/api/realtrade/status?market=KR";
let reads: Record<string, () => Promise<unknown>> = {};
const calls = (prefix: string) => api.apiGetShared.mock.calls.map(([path]) => String(path)).filter((path) => path.startsWith(prefix));

beforeEach(() => {
  window.history.replaceState(null, "", "/paper/kr/real");
  reads = {
    "/api/paper/overview?market=KR": () => Promise.resolve(KR_OVERVIEW),
    "/api/brokerage/account?market=KR": () => Promise.resolve(ACCOUNT),
    [STATUS_PATH]: () => Promise.resolve(status()),
    "/api/realtrade/preview": () => Promise.resolve(PREVIEW),
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

const region = () => screen.getByRole("region", { name: "실제 매매" });
const inRegion = () => within(region());
const renderKr = () => render(<PaperScreen market="KR" initialTab="real" />);

describe("자리와 읽기", () => {
  it("실제 계좌 탭 맨 위 — 실제 계좌 요약보다 앞, 상태는 /api/realtrade/status?market=KR(30초 한도 — 백엔드 최악 25초보다 길게)", async () => {
    renderKr();
    expect(await inRegion().findByText("켜짐")).toBeTruthy();
    expect(api.apiGetShared).toHaveBeenCalledWith(STATUS_PATH, 30_000);
    const summary = await screen.findByText("실제 계좌 요약 — 원화");
    // 문서 순서 — 실제 매매 칸이 조회 요약보다 먼저입니다.
    expect(region().compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 조회 배너는 자동 매매가 위 칸이라고 적습니다.
    expect(screen.getByText(/조회는 읽기 전용 — 자동 매매는 위 실제 매매 칸/)).toBeTruthy();
  });

  it("칸 내용 — 따라 하는 책·서버 스위치·운용 평가액·기준 대비 손익(부호·색)·손실 한도·오늘 창·최근 실제 주문·이벤트", async () => {
    renderKr();
    await inRegion().findByText("켜짐");
    expect(inRegion().getByText(/따라 하는 책/).textContent).toContain("Claude 계좌2");
    expect(inRegion().getByText(/서버 스위치: 수집기 켜짐 · 백엔드 켜짐/)).toBeTruthy();
    const equity = inRegion().getByRole("group", { name: "운용 평가액" });
    expect(equity.textContent).toContain("9,500,000원");
    const delta = inRegion().getByRole("group", { name: "기준 대비 손익" });
    expect(delta.textContent).toContain("-500,000원");
    expect(delta.textContent).toContain("기준 평가액 10,000,000원 대비 -5.00%(대시보드 계산)");
    expect(delta.querySelector("span.text-2xl")?.className).toContain("text-down");
    expect(inRegion().getByRole("group", { name: "손실 한도" }).textContent).toContain("멈춤선 8,500,000원 이하면 새 매수 멈춤");
    expect(inRegion().getByText("시가 맞추기 08:50:30~08:58:30")).toBeTruthy();

    const orders = inRegion().getByRole("table", { name: "최근 실제 주문" });
    expect(within(orders).getByText("삼성전자 005930")).toBeTruthy();
    expect(within(orders).getByText("체결 완료")).toBeTruthy();
    expect(within(orders).getByText("72,000원")).toBeTruthy();
    expect(within(orders).getByText("시가 단일가")).toBeTruthy();
    const events = inRegion().getByRole("table", { name: "실제 매매 이벤트" });
    expect(within(events).getByText("창 요약")).toBeTruthy();
    expect(within(events).getByText("시가 맞추기 · 접수 1 · 체결 1 · 놓침 0 · 건너뜀 0 · 막힘 0")).toBeTruthy();
  });

  it("같은 끄기 단추가 실제 계좌 요약의 '다시 읽기' 옆에도 있다", async () => {
    renderKr();
    const reload = await screen.findByRole("button", { name: "다시 읽기" });
    const actions = reload.parentElement as HTMLElement;
    expect(within(actions).getByRole("button", { name: "실제 매매 끄기" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "실제 매매 끄기" })).toHaveLength(2);
  });
});

describe("끄기는 늘 닿는다", () => {
  it("켜짐 — 누르면 확인 창 없이 POST disable {market: KR} → '새 주문 멈춤 — 미체결 취소 중' → 꺼짐", async () => {
    let state = "LIVE";
    reads[STATUS_PATH] = () => Promise.resolve(status({ state }));
    api.apiPost.mockImplementation(() => {
      state = "STOPPING";
      return Promise.resolve({ ok: true, state: "STOPPING" });
    });
    renderKr();
    fireEvent.click(await inRegion().findByRole("button", { name: "실제 매매 끄기" }));

    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/realtrade/disable", { market: "KR" }));
    expect(api.apiPost).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await inRegion().findByText("새 주문 멈춤 — 이 기능의 미체결 주문 취소 중")).toBeTruthy();
    expect(await inRegion().findByText("끄는 중")).toBeTruthy();
    // 끄는 중에도 끄기 단추는 남습니다.
    expect(inRegion().getByRole("button", { name: "실제 매매 끄기" })).toBeTruthy();

    // 다음 상태 읽기(탭이 다시 보일 때 — 15초 주기와 같은 load)에서 꺼짐이면 끝 안내와 켜기 단추, 끄기는 사라짐.
    state = "OFF";
    expect(document.visibilityState).toBe("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(await inRegion().findByText(/꺼졌습니다 — 새 주문 없음/)).toBeTruthy();
    expect(inRegion().getByText("꺼짐")).toBeTruthy();
    expect(inRegion().getByRole("button", { name: "실제 매매 켜기" })).toBeTruthy();
    expect(inRegion().queryByRole("button", { name: "실제 매매 끄기" })).toBeNull();
  });

  it("실제 계좌 읽기와 모의 개요가 모두 실패해도 실제 매매 칸과 끄기가 그려지고 눌린다", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.reject(new Error("요청 실패 (HTTP 500)"));
    reads["/api/brokerage/account?market=KR"] = () => Promise.reject(new Error("요청 실패 (HTTP 502)"));
    api.apiPost.mockResolvedValue({ ok: true });
    renderKr();

    expect(await screen.findByText("요청 실패 (HTTP 500)")).toBeTruthy();
    expect(await screen.findByText("실제 계좌를 읽지 못했습니다 — 요청 실패 (HTTP 502)")).toBeTruthy();
    // 개요가 없어 탭 줄은 없지만 실제 계좌 탭의 패널은 있습니다.
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("tabpanel", { name: "실제 계좌" })).toBeTruthy();
    const off = await inRegion().findByRole("button", { name: "실제 매매 끄기" });
    fireEvent.click(off);
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/realtrade/disable", { market: "KR" }));
  });

  it("모의 개요가 읽을 수 없음(available false)이고 조회가 꺼져 있어도 멈춤이면 끄기·멈춤 해제", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve({ available: false, message: "모의 매매 테이블이 없습니다." });
    reads["/api/brokerage/account?market=KR"] = () => Promise.resolve({ ...ACCOUNT, available: false, state: "DISABLED", message: "조회 꺼짐" });
    reads[STATUS_PATH] = () => Promise.resolve(status({ state: "HALTED", haltReason: "unknown-order" }));
    renderKr();

    expect(await inRegion().findByText("멈춤(주문 결과를 모름(unknown-order))")).toBeTruthy();
    expect(inRegion().getByRole("button", { name: "실제 매매 끄기" })).toBeTruthy();
    expect(inRegion().getByRole("button", { name: "멈춤 해제" })).toBeTruthy();
    expect(inRegion().queryByRole("button", { name: "실제 매매 켜기" })).toBeNull();
    expect(screen.getByText("모의 매매 테이블이 없습니다.")).toBeTruthy();
  });

  it("상태 읽기가 실패하면 '상태를 읽지 못했습니다'와 다시 시도 — 끄기 단추는 그래도 보이고 눌린다", async () => {
    reads[STATUS_PATH] = () => Promise.reject(new Error("백엔드가 20초 안에 응답하지 않았습니다"));
    api.apiPost.mockResolvedValue({ ok: true });
    renderKr();

    expect(await inRegion().findByText(/실제 매매 상태를 읽지 못했습니다 — 백엔드가 20초 안에 응답하지 않았습니다/)).toBeTruthy();
    fireEvent.click(inRegion().getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(calls(STATUS_PATH)).toHaveLength(2));

    fireEvent.click(inRegion().getByRole("button", { name: "실제 매매 끄기" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/realtrade/disable", { market: "KR" }));
  });

  it("끄기가 실패하면 이유와 비상 순서, 단추는 남아 다시 누를 수 있다", async () => {
    api.apiPost.mockRejectedValue(new Error("요청 실패 (HTTP 500)"));
    renderKr();
    fireEvent.click(await inRegion().findByRole("button", { name: "실제 매매 끄기" }));
    expect(await inRegion().findByText(/실제 매매를 끄지 못했습니다 — 요청 실패 \(HTTP 500\)/)).toBeTruthy();
    expect(inRegion().getByText(/POST \/api\/realtrade\/disable/)).toBeTruthy();
    expect((inRegion().getByRole("button", { name: "실제 매매 끄기" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("SEC-6: 개요 탭에서 모의 개요가 실패(500)해도 실제 계좌 탭으로 가는 단추가 있고, 누르면 실제 매매 끄기 단추가 보이고 눌린다", async () => {
    window.history.replaceState(null, "", "/paper/kr");
    reads["/api/paper/overview?market=KR"] = () => Promise.reject(new Error("요청 실패 (HTTP 500)"));
    api.apiPost.mockResolvedValue({ ok: true });
    render(<PaperScreen market="KR" initialTab="overview" />);

    expect(await screen.findByText("요청 실패 (HTTP 500)")).toBeTruthy();
    // 개요가 없어 탭 줄은 없고 실제 매매 칸도 아직 없습니다(실제 계좌 탭이 아님).
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("region", { name: "실제 매매" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "실제 계좌 탭으로(실제 매매 끄기)" }));
    expect(window.location.pathname).toBe("/paper/kr/real");
    const off = await inRegion().findByRole("button", { name: "실제 매매 끄기" });
    fireEvent.click(off);
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/realtrade/disable", { market: "KR" }));
    // 실제 계좌 탭에 왔으면 그 단추는 사라집니다(이미 그 탭).
    expect(screen.queryByRole("button", { name: "실제 계좌 탭으로(실제 매매 끄기)" })).toBeNull();
  });

  it("SEC-6: 모의 개요가 읽을 수 없음(available false)이어도 실제 계좌 탭으로 가는 단추 — 개요가 있으면 탭 줄이 그 길이라 없다", async () => {
    window.history.replaceState(null, "", "/paper/kr");
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve({ available: false, message: "모의 매매 테이블이 없습니다." });
    const view = render(<PaperScreen market="KR" initialTab="overview" />);
    expect(await screen.findByText("모의 매매 테이블이 없습니다.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "실제 계좌 탭으로(실제 매매 끄기)" }));
    expect(await inRegion().findByRole("button", { name: "실제 매매 끄기" })).toBeTruthy();
    view.unmount();

    reads["/api/paper/overview?market=KR"] = () => Promise.resolve(KR_OVERVIEW);
    render(<PaperScreen market="KR" initialTab="overview" />);
    expect(await screen.findByRole("tablist", { name: "모의 매매 화면" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "실제 계좌 탭으로(실제 매매 끄기)" })).toBeNull();
  });

  it("꺼짐을 읽었으면 끄기 대신 켜기, 서버 스위치가 꺼져 있으면 '서버에서 꺼짐'과 꺼진 켜기", async () => {
    reads[STATUS_PATH] = () => Promise.resolve(status({ state: "OFF", serverEnabled: { collector: false, backend: true, reason: "disabled" } }));
    renderKr();
    expect(await inRegion().findByText("서버에서 꺼짐")).toBeTruthy();
    expect(inRegion().queryByRole("button", { name: "실제 매매 끄기" })).toBeNull();
    expect((inRegion().getByRole("button", { name: "실제 매매 켜기" }) as HTMLButtonElement).disabled).toBe(true);
    expect(inRegion().getByText("서버 스위치가 꺼져 있어 켤 수 없습니다")).toBeTruthy();
  });
});

describe("RT2-FE-1: 상태를 모르는 동안(첫 읽기·다시 읽기)에도 끄기 단추", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  /** 가짜 시계를 ms만큼 돌리고 그동안 생긴 React 갱신을 반영합니다. */
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const offButton = () => inRegion().queryByRole("button", { name: "실제 매매 끄기" });
  const onButton = () => inRegion().queryByRole("button", { name: "실제 매매 켜기" });

  it("상태 GET이 끝나지 않는 동안 t=0·20·30·45·60초에 끄기 단추가 늘 있고 켜기는 없다", async () => {
    vi.useFakeTimers();
    reads[STATUS_PATH] = () => new Promise(() => {});
    renderKr();
    await advance(0);
    let now = 0;
    for (const at of [0, 20, 30, 45, 60]) {
      await advance((at - now) * 1000);
      now = at;
      expect(offButton(), `t=${at}초`).toBeTruthy();
      expect(onButton(), `t=${at}초`).toBeNull();
    }
    // 그사이 15초마다 다시 읽었습니다(첫 읽기 + 15·30·45·60초).
    expect(calls(STATUS_PATH).length).toBeGreaterThanOrEqual(5);
  });

  it("상태 GET이 30초 한도로 거듭 실패하면 — 다시 읽는 동안에도 '상태를 읽지 못했습니다'와 끄기 단추가 남는다", async () => {
    vi.useFakeTimers();
    // 실제 apiGetShared처럼 같은 경로의 진행 중 요청을 함께 쓰고, 넘긴 한도가 지나면 실패합니다(15초 주기가 한도보다 짧아 다시 읽기가 진행 중 요청에 붙음).
    const fallback = api.apiGetShared.getMockImplementation() as (path: string) => Promise<unknown>;
    let inFlight: Promise<unknown> | null = null;
    api.apiGetShared.mockImplementation((path: string, timeoutMs: number) => {
      if (path !== STATUS_PATH) return fallback(path);
      if (!inFlight) {
        inFlight = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`백엔드가 ${timeoutMs / 1000}초 안에 응답하지 않았습니다`)), timeoutMs);
        }).finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    });
    renderKr();
    await advance(0);
    const failed = () => inRegion().queryByText(/실제 매매 상태를 읽지 못했습니다/);

    let now = 0;
    for (const at of [0, 20, 30, 45, 60]) {
      await advance((at - now) * 1000);
      now = at;
      expect(offButton(), `t=${at}초`).toBeTruthy();
      if (at >= 30) {
        // 첫 실패(30초) 뒤에는 다시 읽는 동안에도 오류 안내가 남고 '읽는 중'으로 돌아가지 않습니다.
        expect(failed(), `t=${at}초`).toBeTruthy();
        expect(inRegion().queryByText("실제 매매 상태를 읽는 중…"), `t=${at}초`).toBeNull();
      } else {
        expect(inRegion().getByText("실제 매매 상태를 읽는 중…"), `t=${at}초`).toBeTruthy();
      }
    }
    expect(api.apiGetShared).toHaveBeenCalledWith(STATUS_PATH, 30_000);
  });
});

describe("취소가 나가지 못할 때·정기 작업이 멈췄을 때(SEC-5·RT-BE-6)", () => {
  const SERVER_OFF = { collector: false, backend: true, reason: "disabled" };
  const BLOCKED = /이 기능이 미체결을 취소할 수 없습니다 — 토스증권 앱에서 직접 취소하세요/;

  it("끄는 중인데 서버 스위치가 꺼져 있으면 '취소 중' 대신 토스 앱에서 직접 취소하라는 위험 배너", async () => {
    let state = "LIVE";
    reads[STATUS_PATH] = () => Promise.resolve(status({ state, serverEnabled: SERVER_OFF, unfinishedOrders: 2 }));
    api.apiPost.mockImplementation(() => {
      state = "STOPPING";
      return Promise.resolve({ ok: true, state: "STOPPING" });
    });
    renderKr();
    // 켜짐 + 서버 스위치 꺼짐 + 미종료 주문 — 이미 위험 배너.
    expect(await inRegion().findByText(BLOCKED)).toBeTruthy();
    fireEvent.click(inRegion().getByRole("button", { name: "실제 매매 끄기" }));
    expect(await inRegion().findByText("끄는 중")).toBeTruthy();
    expect(inRegion().getByText(BLOCKED)).toBeTruthy();
    expect(inRegion().getByText(/미체결 2건/)).toBeTruthy();
    // 이 기능이 취소한다고 단정하는 문구는 없습니다.
    expect(inRegion().queryByText("새 주문 멈춤 — 이 기능의 미체결 주문 취소 중")).toBeNull();
    expect(inRegion().getByText(/끄기를 받았습니다 — 새 주문 멈춤/)).toBeTruthy();
  });

  it("멈춤 + 서버 스위치 꺼짐이면 위험 배너, 멈춤 배너는 '미체결을 취소하고'라고 단정하지 않는다", async () => {
    reads[STATUS_PATH] = () => Promise.resolve(status({ state: "HALTED", haltReason: "unknown-order", serverEnabled: { ...SERVER_OFF, collector: true, backend: false } }));
    renderKr();
    expect(await inRegion().findByText(BLOCKED)).toBeTruthy();
    expect(inRegion().queryByText(/미체결을 취소하고/)).toBeNull();
    expect(inRegion().getByText(/이상 멈춤 — 사유 unknown-order/)).toBeTruthy();
  });

  it("서버 스위치가 켜져 있으면 위험 배너 없음, 켜짐 + 서버 스위치 꺼짐(미종료 없음) 배너도 토스 앱 직접 취소를 안내", async () => {
    reads[STATUS_PATH] = () => Promise.resolve(status({ state: "STOPPING", unfinishedOrders: 3 }));
    const view = renderKr();
    expect(await inRegion().findByText("끄는 중")).toBeTruthy();
    expect(inRegion().queryByText(BLOCKED)).toBeNull();
    view.unmount();

    reads[STATUS_PATH] = () => Promise.resolve(status({ state: "LIVE", serverEnabled: SERVER_OFF, unfinishedOrders: 0 }));
    renderKr();
    expect(await inRegion().findByText("서버에서 꺼짐")).toBeTruthy();
    expect(inRegion().queryByText(BLOCKED)).toBeNull();
    const banner = inRegion().getByText(/운영 서버의 매매 스위치가 꺼져 있어 주문이 나가지 않습니다/);
    expect(banner.textContent).toMatch(/미체결을 취소할 수 없습니다 — 미체결이 있으면 토스증권 앱에서 직접 취소하세요/);
    expect(banner.textContent).not.toMatch(/꺼짐으로 정리합니다/);
  });

  it("켜짐·멈춤·끄는 중인데 정기 작업의 마지막 주기가 3분 넘게 지났으면 '정기 작업이 멈춘 것 같습니다'와 비상 순서", async () => {
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    reads[STATUS_PATH] = () => Promise.resolve(status({ state: "LIVE", jobLastCycleAt: minutesAgo(5) }));
    const view = renderKr();
    const banner = await inRegion().findByText(/정기 작업이 멈춘 것 같습니다/);
    expect(banner.closest("div")?.textContent).toMatch(/비상 끄기 절차/);
    expect(inRegion().getByText(/수집기만 다시 만듦/)).toBeTruthy();
    view.unmount();

    for (const over of [{ state: "LIVE", jobLastCycleAt: minutesAgo(0.1) }, { state: "OFF", jobLastCycleAt: minutesAgo(5) }, { state: "LIVE", jobLastCycleAt: null }]) {
      reads[STATUS_PATH] = () => Promise.resolve(status(over));
      const again = renderKr();
      await inRegion().findByRole("group", { name: "운용 평가액" });
      expect(inRegion().queryByText(/정기 작업이 멈춘 것 같습니다/), JSON.stringify(over)).toBeNull();
      again.unmount();
    }
  });

  it("baselineTotal이 오면 기준 대비 손익은 '상한 없는 총액 − baselineTotal', 멈춤선은 총액 기준", async () => {
    reads[STATUS_PATH] = () => Promise.resolve(status({
      baselineEquity: 10_000_000, baselineTotal: 30_000_000, lossLimitPct: 15,
      lastPreflight: { fetchedAt: "2026-11-06T08:50:31+09:00", equity: 10_000_000, total: 27_000_000, cashBuyingPower: 500_000, holdings: [] },
    }));
    renderKr();
    const delta = await inRegion().findByRole("group", { name: "기준 대비 손익" });
    expect(delta.textContent).toContain("-3,000,000원");
    expect(delta.textContent).toContain("기준 총액 30,000,000원");
    expect(delta.textContent).toContain("-30.00%");
    expect(inRegion().getByRole("group", { name: "손실 한도" }).textContent).toContain("총액이 멈춤선 28,500,000원 이하면 새 매수 멈춤");
  });
});

describe("RT2-FE-2: 정기 작업 멈춤 — 기동 뒤 주기 없음·서버 시각 기준", () => {
  const T = Date.parse("2026-11-06T00:10:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const STALLED = /정기 작업이 멈춘 것 같습니다/;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("기동 뒤 한 주기도 끝내지 못하고 3분이 지났으면 '기동 뒤 끝낸 주기 없음'으로 멈춤 배너 — 1분이면 없다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    reads[STATUS_PATH] = () => Promise.resolve(status({ state: "LIVE", jobLastCycleAt: null, jobStartedAt: iso(T - 4 * 60_000), serverTime: iso(T) }));
    const view = renderKr();
    const banner = await inRegion().findByText(STALLED);
    expect(banner.textContent).toContain("기동 뒤 끝낸 주기 없음(기동 09:06)");
    expect(banner.textContent).toContain("3분 넘게 지남");
    view.unmount();

    reads[STATUS_PATH] = () => Promise.resolve(status({ state: "LIVE", jobLastCycleAt: null, jobStartedAt: iso(T - 60_000), serverTime: iso(T) }));
    renderKr();
    await inRegion().findByRole("group", { name: "운용 평가액" });
    expect(inRegion().queryByText(STALLED)).toBeNull();
  });

  it("기준은 응답의 서버 시각 — 브라우저 시계가 5분 빨라도 거짓 배너가 없고, 10분 느려도 진짜 멈춤은 띄운다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T + 5 * 60_000);
    reads[STATUS_PATH] = () => Promise.resolve(status({ state: "LIVE", jobLastCycleAt: iso(T - 10_000), serverTime: iso(T) }));
    const view = renderKr();
    await inRegion().findByRole("group", { name: "운용 평가액" });
    expect(inRegion().queryByText(STALLED)).toBeNull();
    view.unmount();

    vi.setSystemTime(T - 10 * 60_000);
    reads[STATUS_PATH] = () => Promise.resolve(status({ state: "LIVE", jobLastCycleAt: iso(T - 4 * 60_000), serverTime: iso(T) }));
    renderKr();
    const banner = await inRegion().findByText(STALLED);
    expect(banner.textContent).toContain("마지막 주기 09:06");
  });
});

describe("RT2-FE-3: 취소 포기·결과 모름이 남았을 때 '취소 중'·'정리 끝'을 단정하지 않음", () => {
  const GAVE_UP = (n: number) => `취소를 5번 보냈지만 ${n}건이 아직 살아 있습니다 — 토스증권 앱에서 직접 취소하세요`;
  const UNRESOLVED = (n: number) => `꺼졌습니다 — 결과를 모르는 주문 ${n}건은 토스증권 앱에서 확인하세요`;

  it("끄는 중(서버 스위치 켜짐)에 취소를 5번 보내고도 살아 있는 주문이 있으면 끄기 뒤 안내가 '취소 중' 대신 위험 문구(한 번만)", async () => {
    reads[STATUS_PATH] = () => Promise.resolve(status({ state: "STOPPING", unfinishedOrders: 1, cancelGaveUpOrders: 1, unresolvedOrders: 0 }));
    api.apiPost.mockResolvedValue({ ok: true, state: "STOPPING" });
    renderKr();
    fireEvent.click(await inRegion().findByRole("button", { name: "실제 매매 끄기" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/realtrade/disable", { market: "KR" }));

    const notice = await within(await inRegion().findByRole("status")).findByText(GAVE_UP(1));
    expect(notice.className).toContain("text-danger");
    expect(inRegion().getAllByText(GAVE_UP(1))).toHaveLength(1);
    expect(inRegion().queryByText(/미체결 주문 취소 중/)).toBeNull();
  });

  it("끈 뒤 꺼짐이지만 결과를 모르는 주문이 남았으면 '정리 끝' 대신 토스증권 앱에서 확인하라는 경고", async () => {
    let state = "LIVE";
    reads[STATUS_PATH] = () => Promise.resolve(status({ state, unfinishedOrders: 0, cancelGaveUpOrders: 0, unresolvedOrders: state === "OFF" ? 1 : 0 }));
    api.apiPost.mockImplementation(() => {
      state = "OFF";
      return Promise.resolve({ ok: true, state: "OFF" });
    });
    renderKr();
    fireEvent.click(await inRegion().findByRole("button", { name: "실제 매매 끄기" }));

    const notice = await inRegion().findByText(UNRESOLVED(1));
    expect(notice.className).toContain("text-warn");
    expect(notice.closest("[role=status]")).toBeTruthy();
    expect(inRegion().getAllByText(UNRESOLVED(1))).toHaveLength(1);
    expect(inRegion().queryByText(/정리 끝/)).toBeNull();
  });

  it("새로 고친 화면(이 화면에서 끄기를 보내지 않음)에서도 — 취소 포기는 위험 배너, 꺼짐 + 결과 모름은 경고 배너, 그 밖엔 없다", async () => {
    reads[STATUS_PATH] = () => Promise.resolve(status({ state: "HALTED", haltReason: "unknown-order", unfinishedOrders: 2, cancelGaveUpOrders: 2, unresolvedOrders: 0 }));
    let view = renderKr();
    const gaveUp = await inRegion().findByText(GAVE_UP(2));
    expect(gaveUp.className).toContain("text-danger");
    view.unmount();

    reads[STATUS_PATH] = () => Promise.resolve(status({ state: "OFF", unfinishedOrders: 0, cancelGaveUpOrders: 0, unresolvedOrders: 3 }));
    view = renderKr();
    const unresolved = await inRegion().findByText(UNRESOLVED(3));
    expect(unresolved.className).toContain("text-warn");
    view.unmount();

    for (const over of [
      { state: "LIVE", cancelGaveUpOrders: 0, unresolvedOrders: 2 },
      { state: "OFF", cancelGaveUpOrders: null, unresolvedOrders: null },
      { state: "OFF" },
    ]) {
      reads[STATUS_PATH] = () => Promise.resolve(status(over));
      const again = renderKr();
      await inRegion().findByRole("group", { name: "운용 평가액" });
      expect(inRegion().queryByText(/취소를 5번 보냈지만/), JSON.stringify(over)).toBeNull();
      expect(inRegion().queryByText(/결과를 모르는 주문/), JSON.stringify(over)).toBeNull();
      again.unmount();
    }
  });
});

describe("켜기 창", () => {
  const openEnable = async () => {
    reads[STATUS_PATH] = () => Promise.resolve(status({ state: "OFF", sourceBook: null, baselineEquity: null, lastPreflight: null, orders: [], events: [] }));
    renderKr();
    fireEvent.click(await inRegion().findByRole("button", { name: "실제 매매 켜기" }));
    return screen.findByRole("dialog", { name: "실제 매매 켜기" });
  };
  const submitOf = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: "켜기" }) as HTMLButtonElement;
  const fillAll = async (dialog: HTMLElement, typed = "실제 매매 켜기", password = "합성-비밀번호") => {
    await within(dialog).findByRole("table", { name: "예상 주문" });
    for (const box of within(dialog).getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.change(within(dialog).getByLabelText(/확인하려면 다음 글자를 그대로 입력하세요/), { target: { value: typed } });
    fireEvent.change(within(dialog).getByLabelText("운영자 비밀번호"), { target: { value: password } });
  };

  it("기본 규칙 계좌(책 상태 표시), 손실 한도 15, 서버 안전 상한, 경고·점검표, 예상 목록(/preview)", async () => {
    const dialog = await openEnable();
    const rules = within(dialog).getByRole("radio", { name: /규칙 계좌/ }) as HTMLInputElement;
    expect(rules.checked).toBe(true);
    expect((within(dialog).getByRole("radio", { name: /Claude 계좌2/ }) as HTMLInputElement).checked).toBe(false);
    expect(within(dialog).getByRole("radio", { name: /Claude 계좌1/ }).closest("label")?.textContent).toContain("일시정지");
    expect((within(dialog).getByLabelText("손실 한도(%)") as HTMLInputElement).value).toBe("15");
    expect(within(dialog).getByText("30,000,000원")).toBeTruthy();   // 운용 평가액 상한
    expect(within(dialog).getByText("40건")).toBeTruthy();
    expect(within(dialog).getByText("원화 자산 전부를 운용합니다 — 이 책에 없는 국내 주식은 다음 시가에 팔립니다")).toBeTruthy();
    expect(within(dialog).getByText("켠 동안 앱에서 국내 주식을 직접 사고팔지 마세요")).toBeTruthy();
    expect(within(dialog).getByText("모의와 달리 실제 돈이 움직입니다")).toBeTruthy();
    expect(within(dialog).getByText(/투자자 지시 거래소를 '통합'/)).toBeTruthy();
    expect(within(dialog).getByText(/미수·신용 거래를 껐습니다/)).toBeTruthy();

    const table = await within(dialog).findByRole("table", { name: "예상 주문" });
    expect(within(table).getByText("SK하이닉스 000660")).toBeTruthy();
    expect(within(table).getByText("매도")).toBeTruthy();
    expect(within(table).getByText("720,000원")).toBeTruthy();
    expect(within(dialog).getByText("카카오 035720 — 반대 방향 미체결 있음(opposite-pending)")).toBeTruthy();
    expect(within(dialog).getByText(/회전율 42.5%/)).toBeTruthy();
    expect(api.apiGetShared).toHaveBeenCalledWith("/api/realtrade/preview?market=KR&sourceBook=kr_rules", 40_000);

    // 다른 책을 고르면 그 책으로 다시 읽습니다.
    fireEvent.click(within(dialog).getByRole("radio", { name: /Claude 계좌2/ }));
    await waitFor(() => expect(calls("/api/realtrade/preview")).toContain("/api/realtrade/preview?market=KR&sourceBook=kr_claude2"));
  });

  it("확인 글자가 정확히 같고 점검표·비밀번호가 다 차야 켜기 단추가 열리고, 친 글자 그대로 보낸다", async () => {
    api.apiPost.mockResolvedValue({ ok: true, state: "LIVE", version: 4 });
    const dialog = await openEnable();
    expect(submitOf(dialog).disabled).toBe(true);

    await fillAll(dialog, "실제 매매 켜기 ");   // 끝 공백 — 다름
    expect(submitOf(dialog).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/확인하려면 다음 글자를 그대로 입력하세요/), { target: { value: "실제매매 켜기" } });
    expect(submitOf(dialog).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/확인하려면 다음 글자를 그대로 입력하세요/), { target: { value: "실제 매매 켜기" } });
    expect(submitOf(dialog).disabled).toBe(false);

    // 비밀번호 칸 — 가려 치고 자동 완성 끔, 비우면 다시 꺼짐.
    const password = within(dialog).getByLabelText("운영자 비밀번호") as HTMLInputElement;
    expect(password.type).toBe("password");
    expect(password.getAttribute("autocomplete")).toBe("off");
    fireEvent.change(password, { target: { value: "" } });
    expect(submitOf(dialog).disabled).toBe(true);
    fireEvent.change(password, { target: { value: "합성-비밀번호" } });

    // 점검표 하나라도 빠지면 꺼짐.
    const boxes = within(dialog).getAllByRole("checkbox");
    expect(boxes).toHaveLength(4);
    fireEvent.click(boxes[0]);
    expect(submitOf(dialog).disabled).toBe(true);
    fireEvent.click(boxes[0]);

    fireEvent.click(submitOf(dialog));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledTimes(1));
    expect(api.apiPost).toHaveBeenCalledWith("/api/realtrade/enable", {
      market: "KR", sourceBook: "kr_rules", lossLimitPct: 15, confirm: "실제 매매 켜기", password: "합성-비밀번호", version: 3,
    });
    // 결과가 나온 뒤 창이 닫히고 안내.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await inRegion().findByText(/켰습니다 — 다음 시가 맞추기/)).toBeTruthy();
  });

  it("예상 목록을 받지 못하면 켤 수 없다 — 이유와 다시 계산", async () => {
    reads["/api/realtrade/preview"] = () => Promise.resolve({ ok: false, reason: "preflight-failed", equity: null, orders: null, skipped: null, turnoverPct: null, warnings: null });
    const dialog = await openEnable();
    expect(await within(dialog).findByText(/예상 목록을 읽지 못했습니다 — preflight-failed/)).toBeTruthy();
    for (const box of within(dialog).getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.change(within(dialog).getByLabelText(/확인하려면 다음 글자를 그대로 입력하세요/), { target: { value: "실제 매매 켜기" } });
    fireEvent.change(within(dialog).getByLabelText("운영자 비밀번호"), { target: { value: "합성-비밀번호" } });
    expect(submitOf(dialog).disabled).toBe(true);
    expect(within(dialog).getByText("예상 목록을 받은 뒤에 켤 수 있습니다.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "다시 계산" }));
    await waitFor(() => expect(calls("/api/realtrade/preview")).toHaveLength(2));
  });

  it("손실 한도가 1~50 밖이면 켤 수 없다, 고친 값을 보낸다", async () => {
    api.apiPost.mockResolvedValue({ ok: true });
    const dialog = await openEnable();
    await fillAll(dialog);
    const loss = within(dialog).getByLabelText("손실 한도(%)");
    fireEvent.change(loss, { target: { value: "60" } });
    expect(submitOf(dialog).disabled).toBe(true);
    fireEvent.change(loss, { target: { value: "12.5" } });
    expect(submitOf(dialog).disabled).toBe(false);
    fireEvent.click(submitOf(dialog));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/realtrade/enable", expect.objectContaining({ lossLimitPct: 12.5 })));
  });

  it("비밀번호가 틀리면(403 password-invalid) 창 안에 문구, 비밀번호 칸을 비우고 창은 남는다", async () => {
    api.apiPost.mockRejectedValue(Object.assign(new Error("password-invalid"), { status: 403 }));
    const dialog = await openEnable();
    await fillAll(dialog);
    fireEvent.click(submitOf(dialog));
    expect(await within(dialog).findByText(/비밀번호가 틀렸습니다. 연속 5번 틀리면 30분 동안/)).toBeTruthy();
    expect((within(dialog).getByLabelText("운영자 비밀번호") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("dialog", { name: "실제 매매 켜기" })).toBeTruthy();
  });

  it("버전이 다르면(409) 충돌 문구와 함께 상태를 다시 읽는다, 잠김(password-locked)도 코드별 문구", async () => {
    api.apiPost.mockRejectedValueOnce(Object.assign(new Error("요청 실패 (HTTP 409)"), { status: 409 }));
    const dialog = await openEnable();
    await fillAll(dialog);
    const before = calls(STATUS_PATH).length;
    fireEvent.click(submitOf(dialog));
    expect(await within(dialog).findByText(/다른 곳에서 실제 매매 설정이 바뀌었습니다/)).toBeTruthy();
    await waitFor(() => expect(calls(STATUS_PATH).length).toBeGreaterThan(before));

    api.apiPost.mockRejectedValueOnce(Object.assign(new Error("password-locked"), { status: 423 }));
    fireEvent.change(within(dialog).getByLabelText("운영자 비밀번호"), { target: { value: "합성-비밀번호" } });
    fireEvent.click(submitOf(dialog));
    expect(await within(dialog).findByText(/30분 동안 켜기·바꾸기·해제가 잠겼습니다/)).toBeTruthy();
  });

  it("창이 열린 동안 다른 곳에서 설정 버전이 바뀌어도 연 때의 버전으로 보낸다(409로 알림) — 충돌을 본 뒤에는 다시 읽은 버전", async () => {
    const dialog = await openEnable();
    await fillAll(dialog);
    // 창이 열린 동안 상태 읽기(15초 주기와 같은 load)가 버전 5를 가져옵니다.
    reads[STATUS_PATH] = () => Promise.resolve(status({ state: "OFF", sourceBook: null, version: 5, orders: [], events: [] }));
    const before = calls(STATUS_PATH).length;
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(calls(STATUS_PATH).length).toBeGreaterThan(before));

    api.apiPost.mockRejectedValueOnce(Object.assign(new Error("version-conflict"), { status: 409 }));
    fireEvent.click(submitOf(dialog));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledTimes(1));
    expect(api.apiPost.mock.calls[0][1]).toMatchObject({ version: 3 });
    expect(await within(dialog).findByText(/다른 곳에서 실제 매매 설정이 바뀌었습니다/)).toBeTruthy();

    api.apiPost.mockResolvedValueOnce({ ok: true });
    fireEvent.change(within(dialog).getByLabelText("운영자 비밀번호"), { target: { value: "합성-비밀번호" } });
    fireEvent.click(submitOf(dialog));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledTimes(2));
    expect(api.apiPost.mock.calls[1][1]).toMatchObject({ version: 5, confirm: "실제 매매 켜기" });
  });
});

describe("멈춤 해제·설정 바꾸기", () => {
  it("멈춤 해제 — 사유를 보이고 확인 글자 '멈춤 해제' + 비밀번호로 POST resume", async () => {
    reads[STATUS_PATH] = () => Promise.resolve(status({ state: "HALTED", haltReason: "turnover", version: 7 }));
    api.apiPost.mockResolvedValue({ ok: true });
    renderKr();
    fireEvent.click(await inRegion().findByRole("button", { name: "멈춤 해제" }));
    const dialog = await screen.findByRole("dialog", { name: "실제 매매 멈춤 해제" });
    expect(within(dialog).getByText(/멈춘 사유: 회전율 60% 초과\(turnover\)/)).toBeTruthy();
    const submit = within(dialog).getByRole("button", { name: "멈춤 해제" }) as HTMLButtonElement;
    fireEvent.change(within(dialog).getByLabelText(/확인하려면 다음 글자를 그대로 입력하세요/), { target: { value: "실제 매매 켜기" } });
    fireEvent.change(within(dialog).getByLabelText("운영자 비밀번호"), { target: { value: "합성-비밀번호" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/확인하려면 다음 글자를 그대로 입력하세요/), { target: { value: "멈춤 해제" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/realtrade/resume", {
      market: "KR", confirm: "멈춤 해제", password: "합성-비밀번호", version: 7,
    }));
  });

  it("RT-CONTRACT-4: 멈춤 해제가 409 book-changed면 '끄고 다시 켜서' 문구, invalid-state는 서버 문구 — 버전 충돌로 읽지 않아 상태를 다시 읽지 않는다", async () => {
    reads[STATUS_PATH] = () => Promise.resolve(status({ state: "HALTED", haltReason: "book-changed", version: 7 }));
    api.apiPost
      .mockRejectedValueOnce(Object.assign(new Error("따라 하던 책이 리셋됐습니다."), { status: 409, code: "book-changed" }))
      .mockRejectedValueOnce(Object.assign(new Error("끄는 중이라 풀 수 없습니다."), { status: 409, code: "invalid-state" }));
    renderKr();
    fireEvent.click(await inRegion().findByRole("button", { name: "멈춤 해제" }));
    const dialog = await screen.findByRole("dialog", { name: "실제 매매 멈춤 해제" });
    const fill = () => {
      fireEvent.change(within(dialog).getByLabelText(/확인하려면 다음 글자를 그대로 입력하세요/), { target: { value: "멈춤 해제" } });
      fireEvent.change(within(dialog).getByLabelText("운영자 비밀번호"), { target: { value: "합성-비밀번호" } });
    };
    const submit = () => fireEvent.click(within(dialog).getByRole("button", { name: "멈춤 해제" }));
    fill();
    const before = calls(STATUS_PATH).length;
    submit();
    expect(await within(dialog).findByText(/끄고 다시 켜서 예상 목록을 확인하세요/)).toBeTruthy();
    expect(within(dialog).queryByText(/다른 곳에서 실제 매매 설정이 바뀌었습니다/)).toBeNull();
    expect(calls(STATUS_PATH)).toHaveLength(before);

    fill();
    submit();
    expect(await within(dialog).findByText("끄는 중이라 풀 수 없습니다.")).toBeTruthy();
    expect(calls(STATUS_PATH)).toHaveLength(before);
    // 충돌을 따라가지 않으므로 두 번 모두 연 때의 버전입니다.
    expect(api.apiPost.mock.calls.map(([, body]) => (body as { version: number }).version)).toEqual([7, 7]);
  });

  it("설정 바꾸기 — 지금 책·한도로 시작하고 바꾼 칸만 보낸다(바꿀 것이 없으면 단추 꺼짐)", async () => {
    api.apiPost.mockResolvedValue({ ok: true });
    renderKr();
    fireEvent.click(await inRegion().findByRole("button", { name: "설정 바꾸기" }));
    const dialog = await screen.findByRole("dialog", { name: "실제 매매 설정 바꾸기" });
    expect((within(dialog).getByRole("radio", { name: /Claude 계좌2/ }) as HTMLInputElement).checked).toBe(true);
    const submit = within(dialog).getByRole("button", { name: "바꾸기" }) as HTMLButtonElement;
    fireEvent.change(within(dialog).getByLabelText(/확인하려면 다음 글자를 그대로 입력하세요/), { target: { value: "설정 바꾸기" } });
    fireEvent.change(within(dialog).getByLabelText("운영자 비밀번호"), { target: { value: "합성-비밀번호" } });
    expect(submit.disabled).toBe(true);
    expect(within(dialog).getByText("바꿀 것이 없습니다.")).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("손실 한도(%)"), { target: { value: "20" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/realtrade/update", {
      market: "KR", lossLimitPct: 20, confirm: "설정 바꾸기", password: "합성-비밀번호", version: 3,
    }));
  });
});

describe("미국", () => {
  it("'미국 실제 매매는 준비 중입니다'와 꺼진 단추 — 실제 매매 상태를 읽지 않고 쓰기도 없다", async () => {
    window.history.replaceState(null, "", "/paper/us/real");
    reads["/api/paper/overview"] = () => Promise.resolve({ ...KR_OVERVIEW, market: "US", currency: "USD" });
    reads["/api/brokerage/account?market=US"] = () => Promise.resolve({ ...ACCOUNT, market: "US", currency: "USD" });
    render(<PaperScreen initialTab="real" />);

    expect(await inRegion().findByText(/미국 실제 매매는 준비 중입니다/)).toBeTruthy();
    const buttons = inRegion().getAllByRole("button") as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    await screen.findByText("실제 계좌 요약 — 달러");
    expect(calls("/api/realtrade")).toEqual([]);
    expect(api.apiPost).not.toHaveBeenCalled();
  });
});
