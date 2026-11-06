/**
 * 모의매매(한국)의 'ISA 계좌' 탭(ADR 0029, 명세 docs/specs/2026-11-06-isa-manual-account.md §8).
 *
 *  - 탭은 한국만: 한국 탭 줄 '실제 계좌' 옆, 미국 탭 줄에는 없고 미국 /paper/us/isa는 개요(주소도 개요로, ISA 장부를 읽지 않음)
 *  - 칸: 배너 · 시작 전이면 '시작' 창(시작 현금 + 시작 매수 붙여 넣기 — 줄마다 형식 검사, 합이 현금보다 크면 막음) ·
 *    요약(순입금(시작 현금 포함)·평가액·손익 부호와 색·현금·비용 0으로 어림·가격 모르는 종목) · 다음 시가 매매 지시(세션·종목·방향·수량·상태·알림 시각,
 *    줄마다 체결 고치기·건너뜀) · 보유 · 장부(고치기·지우기 — 지우기는 확인 창) · 행 추가
 *  - 쓰기는 POST /api/manual/isa/{start, ledger, ledger/{id}/delete, instructions/{id}/skip}, 서버 오류 코드별 문구, 개요가 실패해도 그려짐
 *  - 리뷰 결함: 처리 안 된 지난 지시(pendingInstructions — 세션 칸, 체결 고치기·건너뜀), '못 만듦' 사유별 문구, 개장 시각(open)으로 동시호가 안내·
 *    체결 고치기 기본 시각, 고치기에서 시각 원문 보존, 장부 '금액' 칸 설명, 요약 '순입금(시작 현금 포함)', 표가 없을 때 message·notes,
 *    already-recorded, 지시 뒤 장부가 바뀜 경고, 칸 순서(요약 → 지시 → 지난 지시 → 보유 → 장부)
 *  - 명세 2026-11-06-us-costs-backfill §5·§6: 장부·보유 표 정렬(머리를 누르면 오름 → 내림, aria-sort, 장부는 처음 시각 내림차순), 탭 머리의 주기 상자와
 *    기준 시각(받은 가격의 시각 중 가장 이른 것, 초까지), 실시간 가격으로 평가액·손익·비중 다시 계산(못 받은 종목은 '직전 종가')
 * 값은 모두 합성 값입니다(실제 계좌 자료 아님).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLiveSecondsForTest } from "@/hooks/useLiveSeconds";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), apiBase: () => "http://backend", UnauthorizedError };
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
    code: "kr_rules", kind: "RULES", label: "한국 규칙 계좌", status: "ACTIVE", startedOn: "2026-10-30", initialCash: 100_000_000,
    cash: 0, nav: 100_000_000, equityValue: 100_000_000, exposurePct: 100, returnPct: 0, lastObservedAtKst: "2026-11-05 15:30",
    positions: 1, staleCount: 0, stats: STATS, benchmark: null,
  }],
  jobs: [], pendingBackfill: [], navSeries: { dates: [], books: {} }, quotes: null,
};

const ITEMS = [
  {
    id: 7, symbol: "222220", name: "합성화학", side: "SELL", quantity: 3, refPrice: 53_000, weightPct: 48.2, status: "PLANNED",
    notifiedNightAt: "2026-11-06T22:41:00+09:00", notifiedMorningAt: null,
  },
  {
    id: 8, symbol: "111110", name: "합성전자", side: "BUY", quantity: 4, refPrice: 12_500, weightPct: 25.5, status: "RECORDED",
    notifiedNightAt: "2026-11-06T22:41:00+09:00", notifiedMorningAt: "2026-11-09T08:00:30+09:00",
  },
];

function started(over: Record<string, unknown> = {}) {
  return {
    available: true, started: true,
    account: {
      code: "isa", label: "ISA 계좌", market: "KR", sourceBook: "kr_rules", sourceLabel: "규칙 계좌", state: "ACTIVE",
      startedAt: "2026-11-06T14:55:00+09:00", startCash: 5_000_000,
    },
    summary: { cash: 1_200_000, marketValue: 3_900_000, equity: 5_100_000, netDeposit: 5_000_000, profitLoss: 100_000, profitLossPct: 2, unpriced: ["333330"] },
    holdings: [
      { symbol: "111110", name: "합성전자", quantity: 100, avgPrice: 12_000, lastPrice: 12_500, marketValue: 1_250_000, weightPct: 24.51 },
      { symbol: "222220", name: "합성화학", quantity: 50, avgPrice: 53_000, lastPrice: 53_000, marketValue: 2_650_000, weightPct: 51.96 },
      { symbol: "333330", name: "합성바이오", quantity: 10, avgPrice: 9_000, lastPrice: null, marketValue: null, weightPct: null },
    ],
    instructions: { session: "2026-11-09", status: "PLANNED", items: ITEMS },
    recentInstructions: ITEMS.map((item) => ({ ...item, session: "2026-11-09" })),
    ledger: [
      {
        id: 33, at: "2026-11-09T09:00:00+09:00", kind: "BUY", symbol: "111110", name: "합성전자", quantity: 4, price: 12_600, amount: null,
        fee: 0, tax: 0, source: "AUTO", instructionId: 8, note: null,
      },
      {
        id: 32, at: "2026-11-06T14:55:00+09:00", kind: "BUY", symbol: "222220", name: "합성화학", quantity: 50, price: 53_000, amount: null,
        fee: 0, tax: 0, source: "USER", instructionId: null, note: "시작 매수",
      },
      {
        id: 31, at: "2026-11-06T14:55:00+09:00", kind: "DEPOSIT", symbol: null, name: null, quantity: null, price: null, amount: 5_000_000,
        fee: 0, tax: 0, source: "USER", instructionId: null, note: null,
      },
    ],
    notes: ["합성 안내 한 줄"],
    ...over,
  };
}

const NOT_STARTED = {
  available: true, started: false,
  account: { code: "isa", label: "ISA 계좌", market: "KR", sourceBook: "kr_rules", sourceLabel: "규칙 계좌", state: "ACTIVE", startedAt: null, startCash: null },
  summary: null, holdings: [], instructions: null, recentInstructions: [], ledger: [], notes: [],
};

const ISA_PATH = "/api/manual/isa";
let reads: Record<string, () => Promise<unknown>> = {};
const isaReads = () => api.apiGetShared.mock.calls.filter(([path]) => path === ISA_PATH).length;

/** 서버 오류(lib/api ApiError 모양 — 코드는 code 칸). */
const apiError = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });

beforeEach(() => {
  window.history.replaceState(null, "", "/paper/kr/isa");
  reads = {
    "/api/paper/overview?market=KR": () => Promise.resolve(KR_OVERVIEW),
    "/api/paper/overview": () => Promise.resolve({ ...KR_OVERVIEW, market: "US", currency: "USD" }),
    [ISA_PATH]: () => Promise.resolve(started()),
  };
  api.apiPost.mockReset();
  api.apiDelete.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path === prefix || path.startsWith(`${prefix}?`));
    return key ? reads[key]() : new Promise(() => {});
  });
  api.apiPost.mockResolvedValue({ ok: true, id: 99 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const region = () => screen.getByRole("region", { name: "ISA 계좌" });
const inRegion = () => within(region());
const renderIsa = () => render(<PaperScreen market="KR" initialTab="isa" />);
const dialog = () => screen.getByRole("dialog");
const table = (name: string) => inRegion().getByRole("table", { name });
const rowOf = (name: string, text: string) =>
  within(table(name)).getAllByRole("row").find((row) => row.textContent?.includes(text)) as HTMLElement;
/** 머리 글 — 정렬 단추의 방향 화살표(눈으로 보는 보조 표시, aria-hidden)는 뺍니다. */
const headerText = (cell: HTMLElement) => (cell.textContent ?? "").replace(/[↑↓↕]/g, "");

describe("탭은 한국만", () => {
  it("한국 탭 줄 — '실제 계좌' 옆 'ISA 계좌', 누르면 /paper/kr/isa와 ISA 칸(배너)", async () => {
    window.history.replaceState(null, "", "/paper/kr");
    render(<PaperScreen market="KR" />);
    const tab = await screen.findByRole("tab", { name: "ISA 계좌" });
    const labels = screen.getAllByRole("tab").map((entry) => entry.textContent);
    expect(labels.slice(-2)).toEqual(["실제 계좌", "ISA 계좌"]);
    expect(isaReads()).toBe(0);

    fireEvent.click(tab);
    expect(window.location.pathname).toBe("/paper/kr/isa");
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(await inRegion().findByText("연결되지 않은 다른 증권사 계좌 — 이 화면과 텔레그램의 지시를 보고 직접 매매합니다(주문 기능 없음)")).toBeTruthy();
    expect(isaReads()).toBeGreaterThan(0);
  });

  it("미국 탭 줄에는 없고, 미국 /paper/us/isa는 개요로 연다 — 주소도 /paper/us, ISA 장부를 읽지 않음", async () => {
    window.history.replaceState(null, "", "/paper/us/isa");
    render(<PaperScreen initialTab="isa" />);
    const overview = await screen.findByRole("tab", { name: "개요" });
    expect(overview.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("tab", { name: "ISA 계좌" })).toBeNull();
    expect(screen.getAllByRole("tab").map((entry) => entry.textContent)).toEqual([
      "개요", "기관 선정", "보유·체결", "결정 로그", "프레임", "메모", "설정", "실제 계좌",
    ]);
    expect(window.location.pathname).toBe("/paper/us");
    expect(screen.queryByRole("region", { name: "ISA 계좌" })).toBeNull();
    expect(isaReads()).toBe(0);
  });

  it("모의 개요가 실패해도 ISA 칸은 그린다(자기 장부)", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.reject(new Error("요청 실패 (HTTP 500)"));
    renderIsa();
    expect(await inRegion().findByRole("table", { name: "다음 시가 매매 지시" })).toBeTruthy();
  });
});

describe("시작 전 — '시작' 창", () => {
  beforeEach(() => {
    reads[ISA_PATH] = () => Promise.resolve(NOT_STARTED);
  });

  it("붙여 넣은 줄을 바로 읽고 틀린 줄은 줄 번호로 막는다 — 고치면 POST start {cash, buys}(시작 시각을 비우면 싣지 않음)", async () => {
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "시작" }));
    const form = within(dialog());
    expect(dialog().textContent).toContain("ISA 계좌 시작");
    const submit = form.getByRole("button", { name: "시작" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(form.getByLabelText("시작 현금(원)"), { target: { value: "5,000,000" } });
    fireEvent.change(form.getByLabelText("시작 매수 목록"), { target: { value: "111110 100 12000\n22222 50 53000" } });
    expect(form.getByText(/^2번째 줄: 종목 코드는 여섯 자리/)).toBeTruthy();
    expect(submit.disabled).toBe(true);

    fireEvent.change(form.getByLabelText("시작 매수 목록"), { target: { value: "111110 100 12000\n222220\t50\t53,000" } });
    expect(form.getByText("읽은 시작 매수 2줄")).toBeTruthy();
    expect(form.getByText(/시작 매수 합 3,850,000원 · 남는 현금 1,150,000원/)).toBeTruthy();
    expect(submit.disabled).toBe(false);
    const before = isaReads();
    fireEvent.click(submit);

    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/manual/isa/start", {
      cash: 5_000_000,
      buys: [{ symbol: "111110", quantity: 100, price: 12_000 }, { symbol: "222220", quantity: 50, price: 53_000 }],
    }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await inRegion().findByText(/시작했습니다 — 시작 현금과 시작 매수 2줄을 장부에 적었습니다/)).toBeTruthy();
    expect(isaReads()).toBeGreaterThan(before);
  });

  it("시작 매수 합이 시작 현금보다 크면 보내지 않고, 시작 시각은 KST로 싣는다", async () => {
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "시작" }));
    const form = within(dialog());
    fireEvent.change(form.getByLabelText("시작 현금(원)"), { target: { value: "100000" } });
    fireEvent.change(form.getByLabelText("시작 매수 목록"), { target: { value: "111110 10 12500" } });
    expect(form.getByText(/시작 매수 합\(125,000원\)이 시작 현금\(100,000원\)보다 큽니다/)).toBeTruthy();
    expect((form.getByRole("button", { name: "시작" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(form.getByLabelText("시작 현금(원)"), { target: { value: "200000" } });
    fireEvent.change(form.getByLabelText("시작 시각(서울)"), { target: { value: "2026-11-06T14:55" } });
    fireEvent.click(form.getByRole("button", { name: "시작" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/manual/isa/start", {
      cash: 200_000, startedAt: "2026-11-06T14:55:00+09:00", buys: [{ symbol: "111110", quantity: 10, price: 12_500 }],
    }));
  });

  it("이미 시작했으면(409 already-started) 창 안에 문구, 장부를 다시 읽는다", async () => {
    api.apiPost.mockRejectedValue(apiError(409, "already-started", "이미 시작했습니다"));
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "시작" }));
    const form = within(dialog());
    fireEvent.change(form.getByLabelText("시작 현금(원)"), { target: { value: "5000000" } });
    const before = isaReads();
    fireEvent.click(form.getByRole("button", { name: "시작" }));
    expect((await form.findByRole("alert")).textContent).toContain("이미 시작한 계좌입니다 — 시작은 한 번만 됩니다");
    expect(isaReads()).toBeGreaterThan(before);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("표가 없으면(available:false) 서버 문구 그대로", async () => {
    reads[ISA_PATH] = () => Promise.resolve({ available: false, message: "ISA 표가 아직 없습니다(합성 문구)." });
    renderIsa();
    expect(await inRegion().findByText("ISA 표가 아직 없습니다(합성 문구).")).toBeTruthy();
    expect(inRegion().queryByRole("button", { name: "시작" })).toBeNull();
  });
});

describe("시작 뒤 — 요약·보유·지시·장부", () => {
  it("요약 — 순입금(시작 현금 포함)·평가액·손익(부호·색)·현금·비용 0으로 어림·가격 모르는 종목·서버 안내", async () => {
    renderIsa();
    const net = await inRegion().findByRole("group", { name: "순입금(시작 현금 포함)" });
    expect(net.textContent).toContain("5,000,000원");
    const equity = inRegion().getByRole("group", { name: "평가액" });
    expect(equity.textContent).toContain("5,100,000원");
    expect(equity.textContent).toContain("보유 평가 3,900,000원 + 현금 1,200,000원");
    const profit = inRegion().getByRole("group", { name: "손익" });
    expect(profit.textContent).toContain("+100,000원");
    expect(profit.textContent).toContain("순입금 대비 +2.00%");
    expect(profit.querySelector("span.text-2xl")?.className).toContain("text-up");
    expect(inRegion().getByRole("group", { name: "현금" }).textContent).toContain("1,200,000원");
    expect(inRegion().getByText(/^비용 0으로 어림/)).toBeTruthy();
    expect(inRegion().getByText(/가격을 몰라 평가에서 뺀 종목: 333330/)).toBeTruthy();
    expect(inRegion().getByText("합성 안내 한 줄")).toBeTruthy();
    expect(inRegion().getByText(/따라 하는 책: 규칙 계좌 · 운용 중 · 시작 2026-11-06 14:55/)).toBeTruthy();
  });

  it("손실이면 음수 부호와 하락 색", async () => {
    reads[ISA_PATH] = () => Promise.resolve(started({
      summary: { cash: 1_000_000, marketValue: 3_700_000, equity: 4_700_000, netDeposit: 5_000_000, profitLoss: -300_000, profitLossPct: -6, unpriced: [] },
    }));
    renderIsa();
    const profit = await inRegion().findByRole("group", { name: "손익" });
    expect(profit.textContent).toContain("-300,000원");
    expect(profit.querySelector("span.text-2xl")?.className).toContain("text-down");
    expect(inRegion().queryByText(/가격을 몰라 평가에서 뺀 종목/)).toBeNull();
  });

  it("보유 — 수량·평균 단가·마지막 가격·평가액·비중, 가격 모르면 —", async () => {
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 보유" });
    const row = rowOf("ISA 계좌 보유", "합성전자 111110");
    expect(row.textContent).toContain("12,000원");
    expect(row.textContent).toContain("12,500원");
    expect(row.textContent).toContain("1,250,000원");
    expect(row.textContent).toContain("24.51%");
    expect(rowOf("ISA 계좌 보유", "합성바이오 333330").textContent).toContain("—");
  });

  it("다음 시가 매매 지시 — 세션·상태·종목·방향·수량·알림 시각, 기록 전은 체결 고치기·건너뜀, 기록됨은 체결 고치기만", async () => {
    renderIsa();
    await inRegion().findByRole("table", { name: "다음 시가 매매 지시" });
    expect(inRegion().getByText("11/09(월) 시가 · 지시 있음")).toBeTruthy();
    const sell = rowOf("다음 시가 매매 지시", "합성화학 222220");
    expect(sell.textContent).toContain("매도");
    expect(sell.textContent).toContain("지시 — 체결 기록 전");
    expect(sell.textContent).toContain("밤 11/06 22:41");
    expect(within(sell).getByRole("button", { name: "체결 고치기 — 합성화학 222220" })).toBeTruthy();
    expect(within(sell).getByRole("button", { name: "건너뜀 — 합성화학 222220" })).toBeTruthy();
    const buy = rowOf("다음 시가 매매 지시", "합성전자 111110");
    expect(buy.textContent).toContain("매수");
    expect(buy.textContent).toContain("체결 기록됨");
    expect(buy.textContent).toContain("밤 11/06 22:41 · 아침 11/09 08:00");
    expect(within(buy).getByRole("button", { name: "체결 고치기 — 합성전자 111110" })).toBeTruthy();
    expect(within(buy).queryByRole("button", { name: /건너뜀/ })).toBeNull();
    expect(inRegion().getByText(/장전 동시호가\(08:30~09:00\)에 시장가로 내면/)).toBeTruthy();

    // 지난 지시는 접어 둡니다.
    expect(inRegion().queryByRole("table", { name: "지난 지시" })).toBeNull();
    fireEvent.click(inRegion().getByRole("button", { name: "지난 지시 보기(2)" }));
    expect(within(table("지난 지시")).getAllByText("11/09(월)")).toHaveLength(2);
  });

  it("지시 없음·못 만듦·아직 없음 안내", async () => {
    reads[ISA_PATH] = () => Promise.resolve(started({ instructions: { session: "2026-11-09", status: "NONE", items: [] } }));
    const view = renderIsa();
    expect(await inRegion().findByText(/이 세션은 지시 없음/)).toBeTruthy();
    view.unmount();
    reads[ISA_PATH] = () => Promise.resolve(started({ instructions: { session: "2026-11-09", status: "UNAVAILABLE", items: [] } }));
    const again = renderIsa();
    expect(await inRegion().findByText(/이 세션의 지시를 만들지 못했습니다/)).toBeTruthy();
    again.unmount();
    reads[ISA_PATH] = () => Promise.resolve(started({ instructions: null }));
    renderIsa();
    expect(await inRegion().findByText("아직 다음 세션의 지시가 없습니다")).toBeTruthy();
  });

  it("장부 — 종류·종목·수량·체결가·금액·기록·지시 번호·메모, 줄마다 고치기·지우기", async () => {
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 장부" });
    const auto = rowOf("ISA 계좌 장부", "자동(지시대로)");
    expect(auto.textContent).toContain("자동(지시대로)");
    expect(auto.textContent).toContain("12,600원");
    expect(auto.textContent).toContain("#8");
    const deposit = rowOf("ISA 계좌 장부", "입금");
    expect(deposit.textContent).toContain("5,000,000원");
    expect(deposit.textContent).toContain("직접 입력");
    expect(within(deposit).getByRole("button", { name: "고치기 — 입금 #31" })).toBeTruthy();
    expect(within(deposit).getByRole("button", { name: "지우기 — 입금 #31" })).toBeTruthy();
    expect(rowOf("ISA 계좌 장부", "시작 매수").textContent).toContain("합성화학 222220");
  });
});

describe("고치기", () => {
  it("건너뜀 — 확인 창 뒤 POST instructions/{id}/skip, 안내와 다시 읽기", async () => {
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "건너뜀 — 합성화학 222220" }));
    expect(dialog().textContent).toContain("매도 합성화학 222220 3주 지시를 건너뜀으로 둡니다");
    expect(api.apiPost).not.toHaveBeenCalled();
    const before = isaReads();
    fireEvent.click(within(dialog()).getByRole("button", { name: "건너뜀" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/manual/isa/instructions/7/skip"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await inRegion().findByText(/지시를 건너뜀으로 두었습니다/)).toBeTruthy();
    expect(isaReads()).toBeGreaterThan(before);
  });

  it("체결 고치기(기록 전) — 방향·종목·수량을 채운 새 행, 시각은 세션 시가, 체결가를 적어야 보냄 → POST ledger(지시 번호)", async () => {
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "체결 고치기 — 합성화학 222220" }));
    const form = within(dialog());
    expect(dialog().textContent).toContain("체결 고치기 — 매도 합성화학 222220");
    expect(dialog().textContent).toContain("기준가 53,000원(참고)");
    const symbol = form.getByLabelText("종목 코드") as HTMLInputElement;
    expect(symbol.value).toBe("222220");
    expect(symbol.readOnly).toBe(true);
    expect((form.getByLabelText("수량(주)") as HTMLInputElement).value).toBe("3");
    expect((form.getByLabelText("체결가(원)") as HTMLInputElement).value).toBe("");
    expect((form.getByLabelText("시각(서울)") as HTMLInputElement).value).toBe("2026-11-09T09:00");
    const submit = form.getByRole("button", { name: "장부에 적기" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(form.getByLabelText("체결가(원)"), { target: { value: "52,900" } });
    fireEvent.click(submit);
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/manual/isa/ledger", {
      kind: "SELL", instructionId: 7, symbol: "222220", quantity: 3, price: 52_900, fee: 0, tax: 0, at: "2026-11-09T09:00:00+09:00",
    }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await inRegion().findByText(/체결을 장부에 적었습니다/)).toBeTruthy();
  });

  it("체결 고치기(기록됨) — 그 지시로 적힌 자동 행을 고친다(같은 id·지시 번호)", async () => {
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "체결 고치기 — 합성전자 111110" }));
    const form = within(dialog());
    expect(dialog().textContent).toContain("이 지시로 적힌 장부 행 #33(자동(지시대로))을 고칩니다");
    expect((form.getByLabelText("체결가(원)") as HTMLInputElement).value).toBe("12600");
    fireEvent.change(form.getByLabelText("체결가(원)"), { target: { value: "12650" } });
    fireEvent.change(form.getByLabelText("수수료(원)"), { target: { value: "20" } });
    fireEvent.click(form.getByRole("button", { name: "장부에 적기" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/manual/isa/ledger", {
      kind: "BUY", id: 33, instructionId: 8, symbol: "111110", quantity: 4, price: 12_650, fee: 20, tax: 0,
      at: "2026-11-09T09:00:00+09:00", note: "",
    }));
  });

  it("장부 고치기 — 입금 행은 금액만, 종류는 바꾸지 않음 → POST ledger {id}", async () => {
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "고치기 — 입금 #31" }));
    const form = within(dialog());
    expect(dialog().textContent).toContain("장부 행 고치기");
    expect(form.queryByLabelText("종류")).toBeNull();
    expect(form.queryByLabelText("종목 코드")).toBeNull();
    const amount = form.getByLabelText("금액(원)") as HTMLInputElement;
    expect(amount.value).toBe("5000000");
    fireEvent.change(amount, { target: { value: "6,000,000" } });
    fireEvent.change(form.getByLabelText("메모"), { target: { value: "합성 추가 입금" } });
    fireEvent.click(form.getByRole("button", { name: "장부에 적기" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/manual/isa/ledger", {
      kind: "DEPOSIT", id: 31, amount: 6_000_000, at: "2026-11-06T14:55:00+09:00", note: "합성 추가 입금",
    }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await inRegion().findByText(/장부 행을 고쳤습니다/)).toBeTruthy();
  });

  it("지우기 — 확인 창(되돌릴 수 없음) 뒤 POST ledger/{id}/delete", async () => {
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "지우기 — 매수 합성화학 222220 #32" }));
    expect(dialog().textContent).toContain("매수 합성화학 222220 행(#32, 2026-11-06 14:55)을 지웁니다. 되돌릴 수 없고");
    fireEvent.click(within(dialog()).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.apiPost).not.toHaveBeenCalled();

    fireEvent.click(inRegion().getByRole("button", { name: "지우기 — 매수 합성화학 222220 #32" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "지우기" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/manual/isa/ledger/32/delete"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await inRegion().findByText(/장부 행을 지웠습니다/)).toBeTruthy();
  });

  it("행 추가 — 종류 다섯(매수·매도·입금·출금·조정), 고른 종류의 칸만 → POST ledger(id 없음)", async () => {
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "행 추가" }));
    const form = within(dialog());
    const kind = form.getByLabelText("종류") as HTMLSelectElement;
    expect([...kind.options].map((option) => option.value)).toEqual(["BUY", "SELL", "DEPOSIT", "WITHDRAW", "ADJUST"]);
    expect(kind.value).toBe("BUY");
    expect(form.getByLabelText("체결가(원)")).toBeTruthy();

    fireEvent.change(kind, { target: { value: "ADJUST" } });
    expect(form.queryByLabelText("체결가(원)")).toBeNull();
    expect(form.getByText(/늘면 양수, 줄면 음수/)).toBeTruthy();

    fireEvent.change(kind, { target: { value: "WITHDRAW" } });
    expect(form.queryByLabelText("종목 코드")).toBeNull();
    fireEvent.change(form.getByLabelText("금액(원)"), { target: { value: "1,000,000" } });
    fireEvent.click(form.getByRole("button", { name: "장부에 적기" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/manual/isa/ledger", { kind: "WITHDRAW", amount: 1_000_000 }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await inRegion().findByText(/장부에 행을 더했습니다/)).toBeTruthy();
  });
});

describe("서버 오류 코드별 문구", () => {
  it("ledger-invalid — 창 안에 '음수가 됩니다'와 서버 문구, 창은 그대로", async () => {
    api.apiPost.mockRejectedValue(apiError(400, "ledger-invalid", "현금이 음수가 됩니다(합성)"));
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "행 추가" }));
    const form = within(dialog());
    fireEvent.change(form.getByLabelText("종류"), { target: { value: "WITHDRAW" } });
    fireEvent.change(form.getByLabelText("금액(원)"), { target: { value: "99,000,000" } });
    fireEvent.click(form.getByRole("button", { name: "장부에 적기" }));
    // 배너는 낭독기용 '주의: '를 앞에 둡니다.
    expect((await form.findByRole("alert")).textContent).toBe(
      "주의: 이 행을 적으면 현금이나 보유 수량이 음수가 됩니다 — 수량·가격·금액을 확인하세요. (현금이 음수가 됩니다(합성))",
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("invalid-request — 서버 문구를 덧붙임", async () => {
    api.apiPost.mockRejectedValue(apiError(400, "invalid-request", "price가 비었습니다(합성)"));
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "고치기 — 입금 #31" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "장부에 적기" }));
    expect((await within(dialog()).findByRole("alert")).textContent).toBe("주의: 입력이 올바르지 않습니다 — price가 비었습니다(합성)");
  });

  it("not-found(지우기) — 확인 창을 닫고 칸에 문구, 장부를 다시 읽음", async () => {
    api.apiPost.mockRejectedValue(apiError(404, "not-found", "없음"));
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "지우기 — 입금 #31" }));
    const before = isaReads();
    fireEvent.click(within(dialog()).getByRole("button", { name: "지우기" }));
    // 확인 창이 열린 동안은 뒤 화면이 가려집니다(aria-hidden) — 닫힌 뒤 칸을 봅니다.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await inRegion().findByRole("alert")).textContent).toContain("그 행이나 지시를 찾지 못했습니다");
    expect(isaReads()).toBeGreaterThan(before);
  });

  it("not-started(건너뜀) — 먼저 시작하라는 문구", async () => {
    api.apiPost.mockRejectedValue(apiError(409, "not-started", "시작 전"));
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "건너뜀 — 합성화학 222220" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "건너뜀" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await inRegion().findByRole("alert")).textContent).toContain("아직 시작하지 않은 계좌입니다");
  });
});

describe("리뷰 결함 — 처리 안 된 지난 지시(ISA-R1·ISA-API-3)", () => {
  const PENDING = [
    {
      id: 5, session: "2026-11-06", symbol: "444440", name: "합성정지", side: "SELL", quantity: 2, refPrice: 7_000, weightPct: 0,
      status: "PLANNED", notifiedNightAt: "2026-11-05T22:41:00+09:00", notifiedMorningAt: "2026-11-06T08:00:10+09:00",
    },
  ];
  const blocked = () => started({
    instructions: { session: "2026-11-09", status: "UNAVAILABLE", items: [], open: "2026-11-09T09:00:00+09:00", reason: "record-pending", ledgerChanged: false },
    pendingInstructions: PENDING,
  });

  it("앞 세션의 PLANNED 지시를 세션 칸이 있는 표로 — 줄마다 체결 고치기·건너뜀", async () => {
    reads[ISA_PATH] = () => Promise.resolve(blocked());
    renderIsa();
    await inRegion().findByRole("table", { name: "처리 안 된 지난 지시" });
    const row = rowOf("처리 안 된 지난 지시", "합성정지 444440");
    expect(row.textContent).toContain("11/06(금)");
    expect(row.textContent).toContain("매도");
    expect(row.textContent).toContain("지시 — 체결 기록 전");
    expect(within(row).getByRole("button", { name: "체결 고치기 — 합성정지 444440" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "건너뜀 — 합성정지 444440" })).toBeTruthy();
    const headers = within(table("처리 안 된 지난 지시")).getAllByRole("columnheader").map(headerText);
    expect(headers[0]).toBe("세션");
  });

  it("건너뜀 → POST instructions/{그 지시}/skip", async () => {
    reads[ISA_PATH] = () => Promise.resolve(blocked());
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "건너뜀 — 합성정지 444440" }));
    expect(dialog().textContent).toContain("11/06(금) 시가 매도 합성정지 444440 2주 지시를 건너뜀으로 둡니다");
    fireEvent.click(within(dialog()).getByRole("button", { name: "건너뜀" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/manual/isa/instructions/5/skip"));
  });

  it("체결 고치기 → 그 지시의 세션 09:00(최신 세션의 개장 시각이 아님)으로 채운 새 행, 지시 번호를 싣는다", async () => {
    reads[ISA_PATH] = () => Promise.resolve(started({
      instructions: { session: "2026-11-09", status: "UNAVAILABLE", items: [], open: "2026-11-09T10:00:00+09:00", reason: "record-pending" },
      pendingInstructions: PENDING,
    }));
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "체결 고치기 — 합성정지 444440" }));
    const form = within(dialog());
    expect((form.getByLabelText("시각(서울)") as HTMLInputElement).value).toBe("2026-11-06T09:00");
    fireEvent.change(form.getByLabelText("체결가(원)"), { target: { value: "6,900" } });
    fireEvent.click(form.getByRole("button", { name: "장부에 적기" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/manual/isa/ledger", {
      kind: "SELL", instructionId: 5, symbol: "444440", quantity: 2, price: 6_900, fee: 0, tax: 0, at: "2026-11-06T09:00:00+09:00",
    }));
  });

  it("처리 안 된 지난 지시가 없으면 그 표가 없다", async () => {
    renderIsa();
    await inRegion().findByRole("table", { name: "다음 시가 매매 지시" });
    expect(inRegion().queryByRole("table", { name: "처리 안 된 지난 지시" })).toBeNull();
  });
});

describe("리뷰 결함 — '못 만듦' 사유별 문구(ISA-API-4)", () => {
  const unavailable = (reason: string | null) =>
    started({ instructions: { session: "2026-11-09", status: "UNAVAILABLE", items: [], reason } });

  it("record-pending — 앞 세션 지시를 처리하라", async () => {
    reads[ISA_PATH] = () => Promise.resolve(unavailable("record-pending"));
    renderIsa();
    expect(await inRegion().findByText(/앞 세션 지시를 체결 고치기·건너뜀으로 처리하세요/)).toBeTruthy();
    expect(inRegion().queryByText(/규칙 계좌의 목표를 다 받지 못한/)).toBeNull();
  });

  it("timed-orders — 규칙 계좌가 시가 밖 시점으로 주문함", async () => {
    reads[ISA_PATH] = () => Promise.resolve(unavailable("timed-orders"));
    renderIsa();
    expect(await inRegion().findByText(/규칙 계좌가 시가 밖 시점으로 주문해 ISA는 이번 세션 시가 지시를 만들지 않았습니다/)).toBeTruthy();
  });

  it("그 밖·없음 — 중립 문구(사유를 단정하지 않음)", async () => {
    reads[ISA_PATH] = () => Promise.resolve(unavailable("price-missing"));
    const view = renderIsa();
    expect(await inRegion().findByText(/이 세션의 지시를 만들지 못했습니다/)).toBeTruthy();
    expect(inRegion().queryByText(/규칙 계좌의 목표를 다 받지 못한/)).toBeNull();
    view.unmount();
    reads[ISA_PATH] = () => Promise.resolve(unavailable(null));
    renderIsa();
    expect(await inRegion().findByText(/이 세션의 지시를 만들지 못했습니다/)).toBeTruthy();
    expect(inRegion().queryByText(/규칙 계좌의 목표를 다 받지 못한/)).toBeNull();
  });
});

describe("리뷰 결함 — 개장 시각(ISA-R6)", () => {
  it("개장 10:00인 세션 — 동시호가 안내는 09:30~10:00, 체결 고치기 기본 시각은 10:00", async () => {
    reads[ISA_PATH] = () => Promise.resolve(started({
      instructions: { session: "2026-11-19", status: "PLANNED", items: ITEMS, open: "2026-11-19T10:00:00+09:00", reason: null, ledgerChanged: false },
    }));
    renderIsa();
    expect(await inRegion().findByText(/장전 동시호가\(09:30~10:00\)에 시장가로 내면/)).toBeTruthy();
    expect(inRegion().queryByText(/08:30~09:00/)).toBeNull();
    fireEvent.click(inRegion().getByRole("button", { name: "체결 고치기 — 합성화학 222220" }));
    expect((within(dialog()).getByLabelText("시각(서울)") as HTMLInputElement).value).toBe("2026-11-19T10:00");
  });
});

describe("리뷰 결함 — 고치기의 시각 원문(ISA-API-1)", () => {
  it("시작 시각을 비우고 시작한 행(초·소수초)의 수수료만 고치면 시각 원문을 그대로 보낸다", async () => {
    const original = "2026-11-06T05:55:37.123456Z";
    const base = started();
    reads[ISA_PATH] = () => Promise.resolve({
      ...base,
      ledger: (base.ledger as Array<Record<string, unknown>>).map((row) => (row.id === 33 ? row : { ...row, at: original })),
    });
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "고치기 — 매수 합성화학 222220 #32" }));
    const form = within(dialog());
    expect((form.getByLabelText("시각(서울)") as HTMLInputElement).value).toBe("2026-11-06T14:55");
    fireEvent.change(form.getByLabelText("수수료(원)"), { target: { value: "150" } });
    fireEvent.click(form.getByRole("button", { name: "장부에 적기" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/manual/isa/ledger", {
      kind: "BUY", id: 32, symbol: "222220", quantity: 50, price: 53_000, fee: 150, tax: 0, at: original, note: "시작 매수",
    }));
  });

  it("체결 고치기(기록됨)도 시각을 바꾸지 않았으면 그 행의 시각 원문", async () => {
    const original = "2026-11-09T00:00:00.000001Z";
    const base = started();
    reads[ISA_PATH] = () => Promise.resolve({
      ...base,
      ledger: (base.ledger as Array<Record<string, unknown>>).map((row) => (row.id === 33 ? { ...row, at: original } : row)),
    });
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "체결 고치기 — 합성전자 111110" }));
    fireEvent.change(within(dialog()).getByLabelText("체결가(원)"), { target: { value: "12650" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "장부에 적기" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/manual/isa/ledger", expect.objectContaining({ id: 33, at: original })));
  });
});

describe("리뷰 결함 — 장부 금액 칸(ISA-API-5)", () => {
  it("머리글은 '금액'이고 입출금·매수매도의 뜻을 적는다", async () => {
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 장부" });
    const headers = within(table("ISA 계좌 장부")).getAllByRole("columnheader").map(headerText);
    expect(headers).toContain("금액");
    expect(headers).not.toContain("입출금액");
    expect(inRegion().getByText(/금액 — 입출금은 입출금액, 매수·매도는 수량×체결가/)).toBeTruthy();
  });
});

describe("리뷰 결함 — 요약 순입금(ISA-API-6)", () => {
  it("'시작 현금'(시작 때 값) 대신 장부에서 계산한 순입금(시작 현금 포함)", async () => {
    reads[ISA_PATH] = () => Promise.resolve(started({
      summary: { cash: 2_200_000, marketValue: 3_900_000, equity: 6_100_000, netDeposit: 6_000_000, profitLoss: 100_000, profitLossPct: 1.67, unpriced: [] },
    }));
    renderIsa();
    const net = await inRegion().findByRole("group", { name: "순입금(시작 현금 포함)" });
    expect(net.textContent).toContain("6,000,000원");
    expect(inRegion().queryByRole("group", { name: "시작 현금" })).toBeNull();
  });
});

describe("리뷰 결함 — 표가 없을 때(ISA-API-7)", () => {
  it("message가 없어도 서버 안내(notes)를 보인다", async () => {
    reads[ISA_PATH] = () => Promise.resolve({
      available: false, started: false, instructions: null, ledger: [],
      notes: ["ISA 계좌 표가 아직 없습니다 — 수집기가 마이그레이션(V25)을 적용한 뒤 다시 보세요(합성)."],
    });
    renderIsa();
    expect(await inRegion().findByText("ISA 계좌 표가 아직 없습니다 — 수집기가 마이그레이션(V25)을 적용한 뒤 다시 보세요(합성).")).toBeTruthy();
  });

  it("message와 notes를 함께", async () => {
    reads[ISA_PATH] = () => Promise.resolve({ available: false, message: "합성 문구", notes: ["합성 안내"] });
    renderIsa();
    expect(await inRegion().findByText("합성 문구")).toBeTruthy();
    expect(inRegion().getByText("합성 안내")).toBeTruthy();
  });
});

describe("리뷰 결함 — 이미 적힌 지시(already-recorded)", () => {
  it("체결 고치기 새 행이 409 already-recorded면 창 안에 문구, 장부를 다시 읽는다", async () => {
    api.apiPost.mockRejectedValue(apiError(409, "already-recorded", "이미 체결이 적힌 지시입니다(합성)"));
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "체결 고치기 — 합성화학 222220" }));
    fireEvent.change(within(dialog()).getByLabelText("체결가(원)"), { target: { value: "52900" } });
    const before = isaReads();
    fireEvent.click(within(dialog()).getByRole("button", { name: "장부에 적기" }));
    expect((await within(dialog()).findByRole("alert")).textContent).toContain("이 지시에는 이미 직접 적은 체결 행이 있습니다");
    expect(isaReads()).toBeGreaterThan(before);
  });
});

describe("리뷰 결함 — 지시 뒤 장부가 바뀜(ledgerChanged)", () => {
  it("참이면 경고, 거짓·없음이면 없음", async () => {
    reads[ISA_PATH] = () => Promise.resolve(started({
      instructions: { session: "2026-11-09", status: "PLANNED", items: ITEMS, ledgerChanged: true },
    }));
    const view = renderIsa();
    expect(await inRegion().findByText(/지시를 만든 뒤 장부가 바뀌었습니다 — 수량을 다시 확인하세요/)).toBeTruthy();
    view.unmount();
    reads[ISA_PATH] = () => Promise.resolve(started());
    renderIsa();
    await inRegion().findByRole("table", { name: "다음 시가 매매 지시" });
    expect(inRegion().queryByText(/지시를 만든 뒤 장부가 바뀌었습니다/)).toBeNull();
  });
});

describe("리뷰 결함 — 칸 순서(지시를 위로)", () => {
  it("요약 → 다음 시가 매매 지시 → 처리 안 된 지난 지시 → 보유 → 장부", async () => {
    reads[ISA_PATH] = () => Promise.resolve(started({
      pendingInstructions: [{ ...ITEMS[0], id: 5, session: "2026-11-06" }],
    }));
    renderIsa();
    await inRegion().findByRole("table", { name: "다음 시가 매매 지시" });
    const tables = inRegion().getAllByRole("table").map((element) => element.querySelector("caption")?.textContent);
    expect(tables).toEqual(["다음 시가 매매 지시", "처리 안 된 지난 지시", "ISA 계좌 보유", "ISA 계좌 장부"]);
    const summary = inRegion().getByRole("group", { name: "평가액" });
    const instructions = table("다음 시가 매매 지시");
    expect(summary.compareDocumentPosition(instructions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

/** 장부 행 번호 — 줄의 '지우기' 단추 이름 끝의 #번호. */
const ledgerIds = () =>
  within(table("ISA 계좌 장부")).getAllByRole("row").slice(1)
    .map((row) => /#(\d+)$/.exec(within(row).getByRole("button", { name: /^지우기/ }).getAttribute("aria-label") ?? "")?.[1]);
/** 보유 줄의 종목 코드(행 머리). */
const holdingSymbols = () =>
  within(table("ISA 계좌 보유")).getAllByRole("row").slice(1).map((row) => /\d{6}/.exec(row.textContent ?? "")?.[0]);
/** 머리 칸(th) — 정렬 단추가 든 칸의 aria-sort를 봅니다. */
const headerCell = (name: string, header: string) =>
  within(table(name)).getAllByRole("columnheader").find((cell) => headerText(cell) === header) as HTMLElement;

describe("표 정렬(명세 2026-11-06-us-costs-backfill §5)", () => {
  it("장부는 처음에 시각 내림차순(aria-sort descending) — 머리를 누르면 그 열로 오름 → 내림, 모르는 값은 맨 뒤", async () => {
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 장부" });
    expect(headerCell("ISA 계좌 장부", "시각").getAttribute("aria-sort")).toBe("descending");
    expect(ledgerIds()).toEqual(["33", "32", "31"]);

    const ledger = within(table("ISA 계좌 장부"));
    fireEvent.click(ledger.getByRole("button", { name: "체결가" }));
    expect(headerCell("ISA 계좌 장부", "체결가").getAttribute("aria-sort")).toBe("ascending");
    expect(headerCell("ISA 계좌 장부", "시각").getAttribute("aria-sort")).toBeNull();
    // 12,600(#33) < 53,000(#32), 입금(#31)은 체결가가 없어 맨 뒤.
    expect(ledgerIds()).toEqual(["33", "32", "31"]);
    fireEvent.click(ledger.getByRole("button", { name: "체결가" }));
    expect(headerCell("ISA 계좌 장부", "체결가").getAttribute("aria-sort")).toBe("descending");
    expect(ledgerIds()).toEqual(["32", "33", "31"]);

    // 글 열(종류) — 가나다: 매수 < 입금, 내림이면 입금이 먼저(같은 값은 앞 순서 그대로).
    fireEvent.click(ledger.getByRole("button", { name: "종류" }));
    expect(ledgerIds()).toEqual(["33", "32", "31"]);
    fireEvent.click(ledger.getByRole("button", { name: "종류" }));
    expect(ledgerIds()).toEqual(["31", "33", "32"]);

    // 시각을 다시 누르면 오름(가장 이른 행부터 — 같은 시각은 서버 순서).
    fireEvent.click(ledger.getByRole("button", { name: "시각" }));
    expect(headerCell("ISA 계좌 장부", "시각").getAttribute("aria-sort")).toBe("ascending");
    expect(ledgerIds()).toEqual(["32", "31", "33"]);
    // 메모·고치기 칸은 정렬 단추가 없습니다.
    expect(ledger.queryByRole("button", { name: "메모" })).toBeNull();
    expect(ledger.queryByRole("button", { name: "고치기" })).toBeNull();
  });

  it("보유·지시 표도 숫자·글 열을 정렬 — 처음에는 서버 순서(지시는 매도 먼저)", async () => {
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 보유" });
    expect(holdingSymbols()).toEqual(["111110", "222220", "333330"]);
    const holdings = within(table("ISA 계좌 보유"));
    fireEvent.click(holdings.getByRole("button", { name: "평가액" }));
    expect(headerCell("ISA 계좌 보유", "평가액").getAttribute("aria-sort")).toBe("ascending");
    expect(holdingSymbols()).toEqual(["111110", "222220", "333330"]);
    fireEvent.click(holdings.getByRole("button", { name: "평가액" }));
    expect(headerCell("ISA 계좌 보유", "평가액").getAttribute("aria-sort")).toBe("descending");
    // 가격을 모르는 합성바이오는 방향과 무관하게 맨 뒤.
    expect(holdingSymbols()).toEqual(["222220", "111110", "333330"]);

    const instructions = within(table("다음 시가 매매 지시"));
    const symbolsOf = () => instructions.getAllByRole("row").slice(1).map((row) => /\d{6}/.exec(row.textContent ?? "")?.[0]);
    expect(symbolsOf()).toEqual(["222220", "111110"]);
    fireEvent.click(instructions.getByRole("button", { name: "수량(주)" }));
    expect(symbolsOf()).toEqual(["222220", "111110"]);
    fireEvent.click(instructions.getByRole("button", { name: "수량(주)" }));
    expect(symbolsOf()).toEqual(["111110", "222220"]);
    expect(instructions.queryByRole("button", { name: "고치기" })).toBeNull();
  });
});

/** 시험의 가짜 EventSource — 화면이 연 연결과 그 주소를 남기고, 'prices' 이벤트를 보냅니다(hooks/__tests__/useLivePrices와 같은 모양). */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  onerror: (() => void) | null = null;
  readyState = 0;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  emit(name: string, body: unknown) {
    (this.listeners.get(name) ?? []).forEach((listener) => listener({ data: JSON.stringify(body) } as MessageEvent<string>));
  }
}

/** 국내 실시간 가격 한 줄(네이버 정규장 모양 — 합성 값). */
const krPrice = (code: string, price: number, tradedAt: string) => ({
  market: "KR", code, price, prevClose: null, change: null, changePct: null, currency: "KRW", tradedAt, status: "OPEN", source: "네이버",
  overPrice: null, overChange: null, overChangePct: null, overTradedAt: null, overSession: null,
});

describe("새로고침 주기와 기준 시각·실시간 평가(명세 2026-11-06-us-costs-backfill §6)", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    window.localStorage.clear();
    resetLiveSecondsForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    resetLiveSecondsForTest();
  });

  const latest = () => FakeEventSource.instances[FakeEventSource.instances.length - 1];

  it("탭 머리에 주기 상자(실시간 시세와 같은 값)와 기준 시각 — 가격을 받기 전에는 '—'와 직전 종가 평가, 보유 가격 칸에 '직전 종가'", async () => {
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 보유" });
    const select = inRegion().getByRole("combobox", { name: "실시간 시세 주기" }) as HTMLSelectElement;
    expect(select.value).toBe("3600");
    expect(inRegion().getByText("1시간마다 받음(장이 닫혀 있으면 5분 이상 간격)")).toBeTruthy();
    expect(inRegion().getByText(/^기준 시각/).textContent).toBe("기준 시각 —");
    expect(inRegion().getByText("실시간 가격을 아직 받지 못해 서버가 준 직전 종가(밤 관측치)로 평가")).toBeTruthy();
    // 보유 종목의 실시간 가격을 고른 주기로(SSE) — 국내 종목 열쇠.
    const url = new URL(latest().url);
    expect(url.pathname).toBe("/api/live/prices/stream");
    expect(url.searchParams.get("items")).toBe("KR:111110,KR:222220,KR:333330");
    expect(url.searchParams.get("interval")).toBe("3600");
    expect(rowOf("ISA 계좌 보유", "합성전자 111110").textContent).toContain("12,500원직전 종가");
    // 요약은 서버 값 그대로.
    expect(inRegion().getByRole("group", { name: "평가액" }).textContent).toContain("5,100,000원");

    // 주기를 바꾸면 그 주기로 다시 잇습니다(다른 화면의 실시간 시세와 같은 값).
    fireEvent.change(select, { target: { value: "10" } });
    expect(new URL(latest().url).searchParams.get("interval")).toBe("10");
    expect(window.localStorage.getItem("live.priceRefreshSeconds")).toBe("10");
  });

  it("실시간 가격을 받으면 평가액·손익·비중을 다시 센다 — 못 받은 종목은 직전 종가, 기준 시각은 받은 가격의 시각 중 가장 이른 것(초까지)", async () => {
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 보유" });
    await act(async () => {
      latest().emit("prices", {
        available: true,
        prices: {
          fetchedAt: "2026-11-09T05:31:10Z",
          items: { "KR:111110": krPrice("111110", 13_000, "2026-11-09T05:31:05Z") },
          missing: ["KR:333330"],
          errors: {},
        },
      });
    });

    // 1,300,000(실시간) + 2,650,000(직전 종가) + 현금 1,200,000 = 5,150,000. 가격 모르는 보유(합성바이오)가 남아 손익은 —(서버와 같음).
    const equity = inRegion().getByRole("group", { name: "평가액" });
    expect(equity.textContent).toContain("5,150,000원");
    expect(equity.textContent).toContain("보유 평가 3,950,000원 + 현금 1,200,000원");
    const profit = inRegion().getByRole("group", { name: "손익" });
    expect(profit.textContent).not.toContain("150,000");
    expect(profit.textContent).toContain("—");
    expect(inRegion().getByText(/^기준 시각/).textContent).toBe("기준 시각 2026-11-09 14:31:05 KST");
    expect(inRegion().getByText("실시간 1종목 · 직전 종가 1종목 — 평가액·손익·비중만 다시 계산(장부·지시는 직전 종가)")).toBeTruthy();
    const live = rowOf("ISA 계좌 보유", "합성전자 111110");
    expect(live.textContent).toContain("13,000원실시간 14:31:05");
    expect(live.textContent).toContain("1,300,000원");
    expect(live.textContent).toContain("25.24%");
    const close = rowOf("ISA 계좌 보유", "합성화학 222220");
    expect(close.textContent).toContain("53,000원직전 종가");
    expect(close.textContent).toContain("51.46%");
    // 가격을 모르는 종목은 평가에서 빼고 '—'.
    expect(rowOf("ISA 계좌 보유", "합성바이오 333330").textContent).toContain("—");
    expect(inRegion().getByText(/가격을 몰라 평가에서 뺀 종목: 합성바이오 333330/)).toBeTruthy();
    // 서버 장부·지시는 그대로(직전 종가) — 지시 기준가는 서버 값.
    expect(rowOf("다음 시가 매매 지시", "합성화학 222220").textContent).toContain("53,000원");

    // 두 종목을 받으면 기준 시각은 더 이른 쪽.
    await act(async () => {
      latest().emit("prices", {
        available: true,
        prices: {
          fetchedAt: "2026-11-09T05:31:20Z",
          items: {
            "KR:111110": krPrice("111110", 13_000, "2026-11-09T05:31:15Z"),
            "KR:222220": krPrice("222220", 54_000, "2026-11-09T05:30:59Z"),
          },
          missing: [],
          errors: {},
        },
      });
    });
    expect(inRegion().getByText(/^기준 시각/).textContent).toBe("기준 시각 2026-11-09 14:30:59 KST");
    expect(inRegion().getByText(/^실시간 2종목 — /)).toBeTruthy();
    expect(inRegion().getByRole("group", { name: "평가액" }).textContent).toContain("5,200,000원");

    // 가격을 몰랐던 종목까지 받으면 손익 = 평가액 − 순입금: 1,200,000 + 1,300,000 + 2,700,000 + 95,000 − 5,000,000.
    await act(async () => {
      latest().emit("prices", {
        available: true,
        prices: {
          fetchedAt: "2026-11-09T05:31:30Z",
          items: {
            "KR:111110": krPrice("111110", 13_000, "2026-11-09T05:31:25Z"),
            "KR:222220": krPrice("222220", 54_000, "2026-11-09T05:31:26Z"),
            "KR:333330": krPrice("333330", 9_500, "2026-11-09T05:31:27Z"),
          },
          missing: [],
          errors: {},
        },
      });
    });
    const allLive = inRegion().getByRole("group", { name: "손익" });
    expect(allLive.textContent).toContain("+295,000원");
    expect(allLive.textContent).toContain("순입금 대비 +5.90%");
  });

  it("다음 응답에서 빠진(missing) 종목은 멈춘 값이라 직전 종가로 평가한다(QA-184 계약)", async () => {
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 보유" });
    await act(async () => {
      latest().emit("prices", {
        available: true,
        prices: { fetchedAt: "2026-11-09T05:31:10Z", items: { "KR:111110": krPrice("111110", 13_000, "2026-11-09T05:31:05Z") }, missing: [], errors: {} },
      });
    });
    expect(rowOf("ISA 계좌 보유", "합성전자 111110").textContent).toContain("13,000원실시간 14:31:05");
    await act(async () => {
      latest().emit("prices", {
        available: true,
        prices: { fetchedAt: "2026-11-09T05:31:20Z", items: { "KR:222220": krPrice("222220", 54_000, "2026-11-09T05:31:15Z") }, missing: [], errors: {} },
      });
    });
    // 111110은 이번 응답에 없음 — 받은 값(13,000)을 실시간으로 쓰지 않고 서버의 직전 종가(12,500).
    expect(rowOf("ISA 계좌 보유", "합성전자 111110").textContent).toContain("12,500원직전 종가");
    expect(rowOf("ISA 계좌 보유", "합성화학 222220").textContent).toContain("54,000원실시간 14:31:15");
    // 1,250,000(직전 종가) + 2,700,000(실시간) + 현금 1,200,000
    expect(inRegion().getByRole("group", { name: "평가액" }).textContent).toContain("5,150,000원");
    expect(inRegion().getByText(/^기준 시각/).textContent).toBe("기준 시각 2026-11-09 14:31:15 KST");
  });

  it("연결이 닫히면(disconnected) 받은 값을 실시간으로 쓰지 않고 서버 값(직전 종가)으로 — 실시간 0종목", async () => {
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 보유" });
    await act(async () => {
      latest().emit("prices", {
        available: true,
        prices: { fetchedAt: "2026-11-09T05:31:10Z", items: { "KR:111110": krPrice("111110", 13_000, "2026-11-09T05:31:05Z") }, missing: [], errors: {} },
      });
    });
    expect(inRegion().getByRole("group", { name: "평가액" }).textContent).toContain("5,150,000원");
    act(() => {
      const source = latest();
      source.readyState = 2;
      source.onerror?.();
    });
    expect(inRegion().getByText(/^기준 시각/).textContent).toBe("기준 시각 —");
    expect(inRegion().getByText("실시간 가격을 아직 받지 못해 서버가 준 직전 종가(밤 관측치)로 평가")).toBeTruthy();
    expect(inRegion().getByRole("group", { name: "평가액" }).textContent).toContain("5,100,000원");
    expect(rowOf("ISA 계좌 보유", "합성전자 111110").textContent).toContain("12,500원직전 종가");
  });

  it("시작 전에는 주기 상자·기준 시각이 없고 실시간 가격을 받지 않는다", async () => {
    reads[ISA_PATH] = () => Promise.resolve(NOT_STARTED);
    renderIsa();
    expect(await inRegion().findByText("ISA 계좌 — 시작 전")).toBeTruthy();
    expect(inRegion().queryByRole("combobox", { name: "실시간 시세 주기" })).toBeNull();
    expect(inRegion().queryByText(/^기준 시각/)).toBeNull();
    expect(FakeEventSource.instances).toEqual([]);
  });
});
