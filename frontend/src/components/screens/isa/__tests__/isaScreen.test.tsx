/**
 * 모의매매(한국)의 'ISA 계좌' 탭(ADR 0029·0034).
 *
 *  - 탭은 한국만: 한국 탭 줄 '실제 계좌' 옆, 미국 탭 줄에는 없고 미국 /paper/us/isa는 개요로 엶
 *  - 칸: 배너 · 시작 전이면 시작 창(총 잔고 + 줄마다 종목·수량·매입 금액) · 요약(총 평가액·현금·매입 금액 합·평가손익·누적 수수료·세금·수수료율, 현금 음수 경고) ·
 *    다음 매매 지시(확인·건너뜀·전부 확인) · 장중 스탑 지시(확인) · 잔고(첫 열 고치기·지우기, 행 추가) · 매매 내역(되돌리기)
 *  - 확인은 체결 입력 창(수량·체결 금액·평균 단가·수수료, 실시간 가격으로 채움)을 열어 적은 값으로 POST
 *  - 쓰기는 POST /api/manual/isa/{start, balance/total, balance/commission, positions, positions/{symbol}/delete, instructions/apply, instructions/{id}/skip, trades/{id}/undo}
 *  - 실시간 평가: 받은 가격으로 평가액·손익·비중 다시 계산(못 받은 종목은 '직전 종가')
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
    notifiedMorningAt: "2026-11-09T08:00:30+09:00",
  },
  {
    id: 8, symbol: "111110", name: "합성전자", side: "BUY", quantity: 4, refPrice: 12_500, weightPct: 25.5, status: "RECORDED", recordedByUser: true,
    notifiedMorningAt: "2026-11-09T08:00:30+09:00",
  },
];

const STOP_ITEM = {
  id: 77, session: "2026-11-09", symbol: "333330", name: "합성바이오", side: "SELL", quantity: 10, timing: "MARKET", targetAt: "2026-11-09T11:32:00+09:00",
  status: "PLANNED", notifiedAt: "2026-11-09T11:30:10+09:00", autoNote: null,
};

function started(over: Record<string, unknown> = {}) {
  return {
    available: true, started: true,
    account: {
      code: "isa", label: "ISA 계좌", market: "KR", sourceBook: "kr_rules", sourceLabel: "규칙 계좌", state: "ACTIVE", startedAt: "2026-11-06T14:55:00+09:00",
    },
    summary: {
      cash: 1_200_000, marketValue: 3_900_000, totalAsset: 5_100_000, purchaseTotal: 3_940_000, profitLoss: null, profitLossPct: null,
      feesPaid: 1_234, taxesPaid: 5_678, commissionPct: 0.015, unpriced: ["333330"],
    },
    positions: [
      { symbol: "111110", name: "합성전자", quantity: 100, avgPrice: 12_000, purchaseAmount: 1_200_000, lastPrice: 12_500, marketValue: 1_250_000, profitLoss: 50_000, profitLossPct: 4.17, weightPct: 24.51, feesPaid: 500, taxesPaid: 0 },
      { symbol: "222220", name: "합성화학", quantity: 50, avgPrice: 53_000, purchaseAmount: 2_650_000, lastPrice: 53_000, marketValue: 2_650_000, profitLoss: 0, profitLossPct: 0, weightPct: 51.96, feesPaid: 0, taxesPaid: 0 },
      { symbol: "333330", name: "합성바이오", quantity: 10, avgPrice: 9_000, purchaseAmount: 90_000, lastPrice: null, marketValue: null, profitLoss: null, profitLossPct: null, weightPct: null, feesPaid: 0, taxesPaid: 0 },
    ],
    instructions: { session: "2026-11-09", status: "PLANNED", items: ITEMS, open: "2026-11-09T09:00:00+09:00", ledgerChanged: false, targetAt: null },
    recentInstructions: ITEMS.map((item) => ({ ...item, session: "2026-11-09" })),
    stopInstructions: [],
    trades: [
      {
        id: 33, at: "2026-11-09T09:05:00+09:00", side: "BUY", symbol: "111110", name: "합성전자", quantity: 4, price: 12_600, amount: 50_400, fee: 7, tax: 0,
        realizedPnl: null, realizedPct: null, priceSource: "live", taxAssumed: false, instructionId: 8, stopInstructionId: null,
      },
      {
        id: 32, at: "2026-11-09T09:01:00+09:00", side: "SELL", symbol: "222220", name: "합성화학", quantity: 2, price: 54_000, amount: 108_000, fee: 16, tax: 215,
        realizedPnl: 1_769, realizedPct: 1.67, priceSource: "close", taxAssumed: true, instructionId: 9, stopInstructionId: null,
      },
    ],
    notes: ["합성 안내 한 줄"],
    ...over,
  };
}

const NOT_STARTED = {
  available: true, started: false,
  account: { code: "isa", label: "ISA 계좌", market: "KR", sourceBook: "kr_rules", sourceLabel: "규칙 계좌", state: null, startedAt: null },
  summary: null, positions: [], instructions: null, recentInstructions: [], stopInstructions: [], trades: [], notes: [],
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
  api.apiPost.mockResolvedValue({ ok: true });
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
const postPaths = () => api.apiPost.mock.calls.map((call) => call[0]);
const lastBody = () => api.apiPost.mock.calls.at(-1)?.[1];

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

  const openStart = async () => {
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "시작" }));
    return within(dialog());
  };

  it("총 잔고·줄마다 종목·수량·매입 금액을 넣으면 POST start — 빈 줄은 빼고, 틀린 입력은 막음", async () => {
    const form = await openStart();
    const submit = form.getByRole("button", { name: "시작" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(form.getByLabelText("총 잔고(총평가금액, 원)"), { target: { value: "10,000,000" } });
    expect(submit.disabled).toBe(false);
    fireEvent.change(form.getByLabelText("1번째 줄 종목"), { target: { value: "합성전자" } });
    fireEvent.change(form.getByLabelText("1번째 줄 수량"), { target: { value: "0" } });
    expect(form.getByText(/1번째 줄:/).textContent).toContain("수량은 0보다 큰 수");
    expect(submit.disabled).toBe(true);
    fireEvent.change(form.getByLabelText("1번째 줄 수량"), { target: { value: "10" } });
    fireEvent.change(form.getByLabelText("1번째 줄 매입 금액"), { target: { value: "1,000,000" } });

    fireEvent.click(form.getByRole("button", { name: "줄 추가" }));
    fireEvent.change(form.getByLabelText("2번째 줄 종목"), { target: { value: "222220" } });
    fireEvent.change(form.getByLabelText("2번째 줄 수량"), { target: { value: "3" } });
    fireEvent.change(form.getByLabelText("2번째 줄 매입 금액"), { target: { value: "0" } });
    fireEvent.click(form.getByRole("button", { name: "줄 추가" }));

    fireEvent.click(submit);
    await waitFor(() => expect(api.apiPost).toHaveBeenCalled());
    expect(api.apiPost).toHaveBeenCalledWith("/api/manual/isa/start", {
      totalAsset: 10_000_000,
      positions: [{ symbol: "합성전자", quantity: 10, purchaseAmount: 1_000_000 }, { symbol: "222220", quantity: 3, purchaseAmount: 0 }],
    });
    expect(await screen.findByText(/시작했습니다 — 보유 2종목과 현금을 넣었습니다/)).toBeTruthy();
  });

  it("보유 없이 현금만으로도 시작 — 서버 메모는 안내에 보임", async () => {
    api.apiPost.mockResolvedValue({ ok: true, notes: ["가격을 몰라 매입 금액으로 어림한 종목이 있습니다."] });
    const form = await openStart();
    fireEvent.change(form.getByLabelText("총 잔고(총평가금액, 원)"), { target: { value: "1,000" } });
    fireEvent.click(form.getByRole("button", { name: "시작" }));
    expect(await screen.findByText(/어림한 종목이 있습니다/)).toBeTruthy();
    expect(lastBody()).toEqual({ totalAsset: 1_000, positions: [] });
  });

  it("이미 시작했으면(409 already-started) 창 안에 문구, 다시 읽는다", async () => {
    api.apiPost.mockRejectedValue(apiError(409, "already-started", "이미 시작"));
    const form = await openStart();
    fireEvent.change(form.getByLabelText("총 잔고(총평가금액, 원)"), { target: { value: "1,000" } });
    fireEvent.click(form.getByRole("button", { name: "시작" }));
    expect(await form.findByRole("alert")).toBeTruthy();
    expect(form.getByRole("alert").textContent).toContain("이미 시작한 계좌입니다");
    expect(isaReads()).toBeGreaterThan(1);
  });

  it("표가 없으면(available:false) 서버 문구 그대로, message가 없어도 notes를 보임", async () => {
    reads[ISA_PATH] = () => Promise.resolve({ available: false, message: "표가 아직 없습니다 — 합성", notes: [] });
    renderIsa();
    expect(await inRegion().findByText("표가 아직 없습니다 — 합성")).toBeTruthy();
    cleanup();
    reads[ISA_PATH] = () => Promise.resolve({ available: false, message: null, notes: ["합성 안내"] });
    renderIsa();
    expect(await inRegion().findByText("합성 안내")).toBeTruthy();
  });
});

describe("시작 뒤 — 요약·지시·잔고·매매 내역", () => {
  it("요약 — 총 평가액·현금·매입 금액 합·평가손익·누적 수수료·세금·수수료율·가격 모르는 종목·서버 안내", async () => {
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 잔고" });
    expect(inRegion().getByRole("group", { name: "총 평가액" }).textContent).toContain("5,100,000원");
    expect(inRegion().getByRole("group", { name: "현금" }).textContent).toContain("1,200,000");
    expect(inRegion().getByRole("group", { name: "매입 금액 합" }).textContent).toContain("3,940,000");
    expect(inRegion().getByRole("group", { name: "평가손익" }).textContent).toContain("—");
    expect(inRegion().getByRole("group", { name: "누적 수수료" }).textContent).toContain("1,234");
    expect(inRegion().getByRole("group", { name: "누적 세금" }).textContent).toContain("5,678");
    expect(inRegion().getByRole("group", { name: "수수료율" }).textContent).toContain("0.015");
    expect(inRegion().getByText(/가격을 몰라 평가에서 뺀 종목: 333330/)).toBeTruthy();
    expect(inRegion().getByText("합성 안내 한 줄")).toBeTruthy();
    expect(inRegion().queryByText(/현금이 음수입니다/)).toBeNull();
  });

  it("현금이 음수면 요약에 경고(막지 않음)", async () => {
    reads[ISA_PATH] = () => Promise.resolve(started({ summary: { ...started().summary, cash: -1_000, totalAsset: 3_899_000 } }));
    renderIsa();
    expect(await inRegion().findByText(/현금이 음수입니다/)).toBeTruthy();
  });

  it("평가손익은 부호·색(이익 초록·손실 빨강 — deltaColor)", async () => {
    reads[ISA_PATH] = () => Promise.resolve(started({ summary: { ...started().summary, profitLoss: -12_345, profitLossPct: -1.5, unpriced: [] } }));
    renderIsa();
    const tile = await inRegion().findByRole("group", { name: "평가손익" });
    expect(tile.textContent).toContain("-12,345");
    expect(tile.textContent).toContain("-1.50%");
  });

  it("다음 시가 매매 지시 — 줄마다 확인·건너뜀(미확인만), 안내에 '볼 수 없음'·알림, 전부 확인은 2줄 이상일 때만", async () => {
    renderIsa();
    const rows = await inRegion().findByRole("table", { name: "다음 시가 매매 지시" });
    const planned = within(rows).getAllByRole("row").find((row) => row.textContent?.includes("합성화학")) as HTMLElement;
    expect(within(planned).getByRole("button", { name: "확인 — 합성화학 222220" })).toBeTruthy();
    expect(within(planned).getByRole("button", { name: "건너뜀 — 합성화학 222220" })).toBeTruthy();
    expect(planned.textContent).toContain("미확인");
    const recorded = within(rows).getAllByRole("row").find((row) => row.textContent?.includes("합성전자")) as HTMLElement;
    expect(within(recorded).queryByRole("button", { name: /^확인/ })).toBeNull();
    expect(recorded.textContent).toContain("확인함(잔고 반영)");
    expect(inRegion().getByText(/실제 매매를 볼 수 없습니다/)).toBeTruthy();
    expect(inRegion().queryByRole("button", { name: /전부 확인/ })).toBeNull();
    expect(inRegion().queryByText("매매함 지우기")).toBeNull();
    expect(inRegion().queryByText("체결 고치기")).toBeNull();
  });

  it("지시 없음·못 만듦(사유별)·아직 없음 안내, 지시 뒤 잔고가 바뀌면 경고", async () => {
    reads[ISA_PATH] = () => Promise.resolve(started({ instructions: { session: "2026-11-09", status: "NONE", items: [] } }));
    renderIsa();
    expect(await inRegion().findByText(/이 세션은 지시 없음/)).toBeTruthy();
    cleanup();
    reads[ISA_PATH] = () => Promise.resolve(started({ instructions: { session: "2026-11-09", status: "UNAVAILABLE", items: [], reason: "timed-orders" } }));
    renderIsa();
    expect(await inRegion().findByText(/규칙 계좌가 시가 밖 시점으로 주문해/)).toBeTruthy();
    cleanup();
    reads[ISA_PATH] = () => Promise.resolve(started({ instructions: null, recentInstructions: [] }));
    renderIsa();
    expect(await inRegion().findByText(/밤 결정\(22:30\)이 끝나면 10분 안에/)).toBeTruthy();
    cleanup();
    reads[ISA_PATH] = () => Promise.resolve(started({ instructions: { ...started().instructions, ledgerChanged: true } }));
    renderIsa();
    expect(await inRegion().findByText("지시를 만든 뒤 잔고가 바뀌었습니다 — 수량을 다시 확인하세요.")).toBeTruthy();
  });

  // QA-381: 현금이 음수라 다음 세션 지시를 만들지 않았으면(응답 waiting.reason = cash-negative) 지시 카드에 그 사유를 보인다. 수정 전에는 요약 칸의 안내 목록에만
  // 있었고 음수 현금 경고는 '매수가 줄어듭니다'였다(재현 커밋에서는 it.fails).
  it("QA-381 현금이 음수라 지시를 만들지 않으면 지시 카드에 사유(세션·잔고 확인), 개장 뒤 못 만듦도 같은 사유 — 다른 대기 사유는 카드에 띄우지 않음", async () => {
    const negative = { ...started().summary, cash: -50_000, totalAsset: 3_850_000 };
    reads[ISA_PATH] = () => Promise.resolve(started({ summary: negative, waiting: { session: "2026-11-10", reason: "decision-pending" } }));
    renderIsa();
    expect(await inRegion().findByText(/현금이 음수입니다/)).toBeTruthy();
    expect(inRegion().queryByText(/매매 지시를 만들지 않았습니다/)).toBeNull();
    cleanup();
    reads[ISA_PATH] = () => Promise.resolve(started({ summary: negative, waiting: { session: "2026-11-10", reason: "cash-negative" } }));
    renderIsa();
    expect(await inRegion().findByText(/^11\/10\(화\) 매매 지시를 만들지 않았습니다 — 현금이 음수입니다/)).toBeTruthy();
    expect(inRegion().getByText(/음수인 동안 다음 매매 지시를 만들지 않습니다/)).toBeTruthy();
    cleanup();
    // 잔고를 고쳐 현금이 0 이상이 됐으면, 정기 작업의 사유가 다음 주기(최대 10분)까지 cash-negative로 남아 있어도 배너를 내린다(독립 검토).
    reads[ISA_PATH] = () => Promise.resolve(started({ waiting: { session: "2026-11-10", reason: "cash-negative" } }));
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 잔고" });
    expect(inRegion().queryByText(/매매 지시를 만들지 않았습니다 — 현금이 음수입니다/)).toBeNull();
    cleanup();
    reads[ISA_PATH] = () => Promise.resolve(started({ summary: negative, instructions: { session: "2026-11-10", status: "UNAVAILABLE", items: [], reason: "cash-negative" } }));
    renderIsa();
    expect(await inRegion().findByText(/^현금이 음수라 이 세션의 매매 지시를 만들지 않았습니다/)).toBeTruthy();
  });

  // QA-381 후속(사용자 결정 2026-11-12): 현금이 음수여도 손절 매도 지시는 만든다 — 손절 지시만 든 세션(instructions.status = PLANNED · reason = cash-negative)은
  // 지시 카드에 그 사실(나머지는 만들지 않음·개장 전에 고치면 만듦)을 보인다. 수정 전 실패: 그 글이 없어 findByText가 'Unable to find an element with the text'.
  it("QA-381 손절 매도 지시만 든 세션 — 지시 카드에 '손절 매도 지시만 만들었다'는 안내와 그 지시 줄(확인 단추), 나머지를 채운 뒤에는 안내를 내림", async () => {
    const negative = { ...started().summary, cash: -50_000, totalAsset: 3_850_000 };
    const stopOnly = { session: "2026-11-09", status: "PLANNED", items: [ITEMS[0]], open: "2026-11-09T09:00:00+09:00", reason: "cash-negative", ledgerChanged: false, targetAt: null };
    reads[ISA_PATH] = () => Promise.resolve(started({ summary: negative, instructions: stopOnly }));
    renderIsa();
    expect(await inRegion().findByText(/^현금이 음수라 이 세션은 손절 매도 지시만 만들었습니다/)).toBeTruthy();
    expect(inRegion().getByText(/나머지 매매 지시는 만들지 않았습니다/)).toBeTruthy();
    expect(within(rowOf("다음 시가 매매 지시", "합성화학 222220")).getByRole("button", { name: /확인/ })).toBeTruthy();
    expect(inRegion().queryByText(/함께 멈춥니다/)).toBeNull();
    cleanup();
    reads[ISA_PATH] = () => Promise.resolve(started({ instructions: { ...stopOnly, reason: null, items: ITEMS } }));
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 잔고" });
    expect(inRegion().queryByText(/손절 매도 지시만 만들었습니다/)).toBeNull();
  });

  // 독립 검토 F5: 손절만 든 세션이 개장한 뒤(응답 serverTime ≥ instructions.open)에는 그 세션의 나머지 지시가 만들어지지 않는다 — 배너가 '개장 전에 잔고를 고치면 …
  // 만듭니다'로 남지 않게. 수정 전 실패: 개장 뒤에도 그 글이 있어 'expected <div …> to be null'.
  it("QA-381 손절 매도 지시만 든 세션 — 개장 뒤에는 배너가 '이 세션의 나머지 지시는 만들지 않습니다'로 끝남(개장 전에는 '개장 전에 고치면 만듭니다')", async () => {
    const negative = { ...started().summary, cash: -50_000, totalAsset: 3_850_000 };
    const stopOnly = { session: "2026-11-09", status: "PLANNED", items: [ITEMS[0]], open: "2026-11-09T00:00:00Z", reason: "cash-negative", ledgerChanged: false, targetAt: null };
    reads[ISA_PATH] = () => Promise.resolve(started({ summary: negative, instructions: stopOnly, serverTime: "2026-11-08T23:30:00Z" }));
    renderIsa();
    expect(await inRegion().findByText(/개장 전에 잔고\(현금·보유\)를 고치면 다음 주기\(10분 안\)에 나머지 지시를 만듭니다/)).toBeTruthy();
    cleanup();
    reads[ISA_PATH] = () => Promise.resolve(started({ summary: negative, instructions: stopOnly, serverTime: "2026-11-09T00:05:00Z" }));
    renderIsa();
    expect(await inRegion().findByText(/^현금이 음수라 이 세션은 손절 매도 지시만 만들었습니다/)).toBeTruthy();
    expect(inRegion().queryByText(/개장 전에 잔고/)).toBeNull();
    expect(inRegion().getByText(/이 세션의 나머지 지시는 만들지 않습니다/)).toBeTruthy();
  });

  it("잔고 표 — 첫 열 고치기·지우기, 종목·수량·평균 매입가·매입 금액·현재가·평가액·평가손익·손익 %·비중·수수료·세금, 가격 모르면 —", async () => {
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 잔고" });
    expect(within(table("ISA 계좌 잔고")).getAllByRole("columnheader").map((cell) => (cell.textContent ?? "").replace(/[↑↓↕]/g, ""))).toEqual([
      "고치기", "종목", "수량(주)", "평균 매입가", "매입 금액", "현재가", "평가액", "평가손익", "손익 %", "비중", "수수료 누적", "세금 누적",
    ]);
    const row = rowOf("ISA 계좌 잔고", "합성전자 111110");
    expect(within(row).getByRole("button", { name: "고치기 — 합성전자 111110" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "지우기 — 합성전자 111110" })).toBeTruthy();
    expect(row.textContent).toContain("12,000원");
    expect(row.textContent).toContain("1,200,000원");
    expect(row.textContent).toContain("+50,000원");
    expect(rowOf("ISA 계좌 잔고", "합성바이오 333330").textContent).toContain("—");
  });

  // QA-353: 수정 전 카드 설명은 '체결가가 다르면 잔고에서 가격을 고치세요'였다(재현 커밋에서는 it.fails) — 잔고의 가격 고치기는 현금·실현 손익을 못 맞춘다.
  it("QA-353 매매 내역 카드와 지시 표 안내 — 체결 값이 다르면 매매 내역의 '고치기'로 안내하고 잔고의 가격 고치기를 권하지 않음", async () => {
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 매매 내역" });
    expect(region().textContent).not.toContain("잔고에서 가격을 고치");
    expect(inRegion().getByText(/체결 값\(수량·금액·수수료\)이 다르면 '고치기'/)).toBeTruthy();
  });

  it("매매 내역 — 시각·방향·종목·수량·가격·금액·수수료·세금(어림 표시)·실현 손익·손익률·가격 출처, 처음에는 시각 내림차순", async () => {
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 매매 내역" });
    expect(within(table("ISA 계좌 매매 내역")).getAllByRole("columnheader").map((cell) => (cell.textContent ?? "").replace(/[↑↓↕]/g, ""))).toEqual([
      "시각", "방향", "종목", "수량(주)", "가격", "금액", "수수료", "세금", "실현 손익", "손익률", "가격 출처", "고치기",
    ]);
    const sell = rowOf("ISA 계좌 매매 내역", "합성화학 222220");
    expect(sell.textContent).toContain("215원 (어림)");
    expect(sell.textContent).toContain("+1,769원");
    expect(sell.textContent).toContain("+1.67%");
    expect(sell.textContent).toContain("직전 종가");
    const buy = rowOf("ISA 계좌 매매 내역", "합성전자 111110");
    expect(buy.textContent).toContain("실시간");
    const rows = within(table("ISA 계좌 매매 내역")).getAllByRole("row").slice(1).map((row) => /합성\S+/.exec(row.textContent ?? "")?.[0]);
    expect(rows).toEqual(["합성전자", "합성화학"]);
  });

  it("칸 순서 — 요약 → 지시 → 스탑 지시 → 잔고 → 매매 내역", async () => {
    reads[ISA_PATH] = () => Promise.resolve(started({ stopInstructions: [STOP_ITEM] }));
    renderIsa();
    await inRegion().findByRole("table", { name: "장중 스탑 매도 지시" });
    const text = region().textContent ?? "";
    const order = ["총 평가액", "다음 시가 매매 지시", "장중 스탑 매도 지시", "지금 잔고가 정답", "'확인'으로 잔고에 반영한 매매"].map((word) => text.indexOf(word));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(inRegion().queryByText("장부")).toBeNull();
    expect(inRegion().queryByRole("button", { name: "행 추가" })).toBeTruthy();
  });
});

describe("잔고 종목 팝업", () => {
  it("잔고의 종목을 누르면 화면을 떠나지 않고 종목 팝업 창이 열림", async () => {
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 잔고" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(within(table("ISA 계좌 잔고")).getByRole("button", { name: "합성전자 111110" }));
    expect(dialog()).toBeTruthy();
    expect(window.location.pathname).toBe("/paper/kr/isa");
  });
});

describe("확인·건너뜀·되돌리기", () => {
  it("확인 — 창이 열리고 실시간 가격이 없으면 기준가로 채움, 금액을 적으면 평균 단가가 따라 바뀌고 POST apply(수량·금액·수수료·출처), 안내와 다시 읽기", async () => {
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "확인 — 합성화학 222220" }));
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain("체결 입력");
    const box = (name: string) => within(dialog()).getByRole("textbox", { name }) as HTMLInputElement;
    expect(box("수량(주) — 매도 합성화학 222220").value).toBe("3");
    expect(box("체결 금액(총액, 원) — 매도 합성화학 222220").value).toBe("159000");
    expect(box("평균 단가(원) — 매도 합성화학 222220").value).toBe("53000");
    fireEvent.change(box("체결 금액(총액, 원) — 매도 합성화학 222220"), { target: { value: "150,003" } });
    expect(box("평균 단가(원) — 매도 합성화학 222220").value).toBe("50001");
    fireEvent.change(box("매매 비용(수수료, 원) — 매도 합성화학 222220"), { target: { value: "25" } });
    api.apiPost.mockResolvedValue({ ok: true, count: 1, skipped: 0 });
    fireEvent.click(within(dialog()).getByRole("button", { name: "잔고에 반영" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/manual/isa/instructions/apply", {
      items: [{ instructionId: 7, quantity: 3, amount: 150_003, fee: 25, priceSource: "user" }],
    }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await inRegion().findByText(/확인 1건을 적은 값으로 잔고에 반영했습니다/)).toBeTruthy();
    await waitFor(() => expect(isaReads()).toBeGreaterThan(1));
  });

  it("확인 창 — 체결 금액을 지우면 반영 단추가 꺼지고, 서버 거절(±40% 등)은 창 안에 보임", async () => {
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "확인 — 합성화학 222220" }));
    const amount = within(dialog()).getByRole("textbox", { name: "체결 금액(총액, 원) — 매도 합성화학 222220" });
    const save = within(dialog()).getByRole("button", { name: "잔고에 반영" }) as HTMLButtonElement;
    fireEvent.change(amount, { target: { value: "" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(amount, { target: { value: "159000" } });
    api.apiPost.mockRejectedValue(apiError(400, "invalid-request", "평균 단가가 직전 종가의 ±40% 밖입니다"));
    fireEvent.click(save);
    expect((await within(dialog()).findByRole("alert")).textContent).toContain("±40%");
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });

  it("전부 확인(N) — 한 창에 줄마다, 줄을 빼면 나머지만, 팔 보유가 없어 닫힌 지시가 있으면 안내", async () => {
    const both = started({ instructions: { session: "2026-11-09", status: "PLANNED", items: ITEMS.map((item) => ({ ...item, status: "PLANNED" })) } });
    reads[ISA_PATH] = () => Promise.resolve(both);
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "전부 확인(2)" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "이 줄 빼기 — 매도 합성화학 222220" }));
    expect(within(dialog()).queryByRole("textbox", { name: "수량(주) — 매도 합성화학 222220" })).toBeNull();
    api.apiPost.mockResolvedValue({ ok: true, count: 0, skipped: 1 });
    fireEvent.click(within(dialog()).getByRole("button", { name: "잔고에 반영" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalled());
    const body = api.apiPost.mock.calls[0][1] as { items: { instructionId: number }[] };
    expect(body.items.map((entry) => entry.instructionId)).toEqual([8]);
    expect(await inRegion().findByText(/팔 보유가 없어 1건은 닫았습니다/)).toBeTruthy();
  });

  it("장중 스탑 지시도 확인 창으로 — stopInstructionId, 잔고의 현재가로 채움, 표에 매도 창·상태·메모, 닫힌 스탑에는 단추 없음", async () => {
    const stop = { id: 41, session: "2026-11-09", symbol: "111110", name: "합성전자", side: "SELL", quantity: 5, timing: "MARKET", targetAt: "2026-11-09T09:12:00+09:00", status: "PLANNED", notifiedAt: "2026-11-09T09:10:55+09:00" };
    reads[ISA_PATH] = () => Promise.resolve(started({ stopInstructions: [stop, { ...stop, id: 42, symbol: "222220", name: "합성화학", status: "SKIPPED", autoNote: "expired" }] }));
    renderIsa();
    const stops = await screen.findByRole("table", { name: "장중 스탑 매도 지시" });
    const row = within(stops).getByRole("button", { name: "확인 — 합성전자 111110" }).closest("tr") as HTMLElement;
    expect(row.textContent).toContain("미확인");
    expect(within(stops).queryByRole("button", { name: "확인 — 합성화학 222220" })).toBeNull();
    fireEvent.click(within(stops).getByRole("button", { name: "확인 — 합성전자 111110" }));
    expect((within(dialog()).getByRole("textbox", { name: "체결 금액(총액, 원) — 매도 합성전자 111110" }) as HTMLInputElement).value).not.toBe("");
    api.apiPost.mockResolvedValue({ ok: true, count: 1, skipped: 0 });
    fireEvent.click(within(dialog()).getByRole("button", { name: "잔고에 반영" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalled());
    const body = api.apiPost.mock.calls[0][1] as { items: Record<string, unknown>[] };
    expect(body.items[0].stopInstructionId).toBe(41);
    expect(body.items[0].instructionId).toBeUndefined();
  });

  // QA-382: 종가 스탑 지시(NEXT_CLOSE)는 마감이 아니라 다음 세션 지시를 만들 때 닫힌다 — 닫힌 까닭을 '마감까지'로 적지 않는다. 수정 전에는 모든 expired가
  // '마감까지 확인하지 않아 닫힘'이었다(재현 커밋에서는 it.fails).
  it("QA-382 닫힌 스탑 지시의 메모 — 종가 단일가는 '다음 지시를 만들 때까지', 장중은 '마감까지', 열린 종가 스탑은 마감 뒤에도 확인 단추", async () => {
    const closing = { id: 51, session: "2026-11-09", symbol: "111110", name: "합성전자", side: "SELL", quantity: 5, timing: "NEXT_CLOSE", targetAt: "2026-11-09T15:30:00+09:00", status: "PLANNED", notifiedAt: "2026-11-09T15:20:40+09:00" };
    reads[ISA_PATH] = () => Promise.resolve(started({
      stopInstructions: [
        closing,
        { ...closing, id: 52, symbol: "222220", name: "합성화학", status: "SKIPPED", autoNote: "expired" },
        { ...closing, id: 53, symbol: "333330", name: "합성바이오", timing: "MARKET", targetAt: "2026-11-09T11:32:00+09:00", status: "SKIPPED", autoNote: "expired" },
      ],
    }));
    renderIsa();
    const stops = await screen.findByRole("table", { name: "장중 스탑 매도 지시" });
    expect(within(stops).getByRole("button", { name: "확인 — 합성전자 111110" })).toBeTruthy();
    const rowText = (text: string) => within(stops).getAllByRole("row").find((row) => row.textContent?.includes(text))?.textContent ?? "";
    expect(rowText("합성화학")).toContain("다음 지시를 만들 때까지 확인하지 않아 닫힘");
    expect(rowText("합성바이오")).toContain("마감까지 확인하지 않아 닫힘");
    expect(inRegion().getByText(/종가 단일가 지시는 마감 뒤에도 다음 세션 지시를 만들기 전/)).toBeTruthy();
  });

  it("매매 내역 고치기 — 적어 둔 값으로 열리고 POST trades/{id}(수량·금액·수수료), 안내", async () => {
    reads[ISA_PATH] = () => Promise.resolve(started({ trades: [{ id: 9, at: "2026-11-09T09:15:00+09:00", side: "SELL", symbol: "222220", name: "합성화학", quantity: 3, price: 50_000, amount: 150_000, fee: 22, tax: 300, realizedPnl: 100, realizedPct: 1, priceSource: "live", taxAssumed: false }] }));
    renderIsa();
    fireEvent.click(await screen.findByRole("button", { name: "고치기 — 매도 합성화학 222220" }));
    expect(dialog().textContent).toContain("매매 고치기");
    const amount = within(dialog()).getByRole("textbox", { name: "체결 금액(총액, 원) — 매도 합성화학 222220" }) as HTMLInputElement;
    expect(amount.value).toBe("150000");
    fireEvent.change(amount, { target: { value: "151500" } });
    api.apiPost.mockResolvedValue({ ok: true });
    fireEvent.click(within(dialog()).getByRole("button", { name: "잔고에 반영" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/manual/isa/trades/9", { quantity: 3, amount: 151_500, fee: 22 }));
    expect(await screen.findByText(/매매를 고쳤습니다/)).toBeTruthy();
  });

  it("건너뜀 — 확인 창 뒤 POST instructions/{id}/skip, 안내", async () => {
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "건너뜀 — 합성화학 222220" }));
    expect(dialog().textContent).toContain("잔고에 쓰지 않습니다");
    fireEvent.click(within(dialog()).getByRole("button", { name: "건너뜀" }));
    await waitFor(() => expect(postPaths()).toEqual(["/api/manual/isa/instructions/7/skip"]));
    expect(await screen.findByText(/건너뜀으로 두었습니다/)).toBeTruthy();
  });

  it("되돌리기 — 확인 창 뒤 POST trades/{id}/undo, 안내", async () => {
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "되돌리기 — 합성화학 222220" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "되돌리기" }));
    await waitFor(() => expect(postPaths()).toEqual(["/api/manual/isa/trades/32/undo"]));
    expect(await screen.findByText(/확인을 되돌렸습니다/)).toBeTruthy();
  });

  it("확인이 already-recorded로 거절되면 문구를 보이고 다시 읽음, 없는 지시도 다시 읽음", async () => {
    api.apiPost.mockRejectedValue(apiError(409, "already-recorded", "이미 확인"));
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "확인 — 합성화학 222220" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "잔고에 반영" }));
    expect((await within(dialog()).findByRole("alert")).textContent).toContain("이미 확인한 지시입니다");
    await waitFor(() => expect(isaReads()).toBeGreaterThan(1));
  });
});

describe("잔고 고치기", () => {
  it("행 추가 — 종목코드·종목명·수량·가격, 합계 '매입 금액 = 수량 × 가격'을 바로 보여 주고 POST positions(originalSymbol 없음)", async () => {
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "행 추가" }));
    const form = within(dialog());
    expect(form.getByText(/매입 금액 = 수량 × 가격/).textContent).toContain("—");
    fireEvent.change(form.getByLabelText("종목코드"), { target: { value: "합성소재" } });
    fireEvent.change(form.getByLabelText("종목명"), { target: { value: "내 이름" } });
    fireEvent.change(form.getByLabelText("수량"), { target: { value: "3" } });
    fireEvent.change(form.getByLabelText("가격(평균 매입가)"), { target: { value: "1,000" } });
    expect(form.getByText(/매입 금액 = 수량 × 가격/).textContent).toContain("3,000원");
    fireEvent.click(form.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalled());
    expect(api.apiPost).toHaveBeenCalledWith("/api/manual/isa/positions", { symbol: "합성소재", name: "내 이름", quantity: 3, price: 1000 });
    expect(await screen.findByText(/잔고를 고쳤습니다/)).toBeTruthy();
  });

  it("고치기 — 평균 매입가·수량을 채우고, 코드를 바꾸면 originalSymbol을 실어 옮김, 서버 거절은 창 안에", async () => {
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "고치기 — 합성전자 111110" }));
    const form = within(dialog());
    expect((form.getByLabelText("가격(평균 매입가)") as HTMLInputElement).value).toBe("12000");
    fireEvent.change(form.getByLabelText("종목코드"), { target: { value: "999999" } });
    api.apiPost.mockRejectedValueOnce(apiError(400, "invalid-request", "이미 있는 종목으로 옮길 수 없습니다"));
    fireEvent.click(form.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalled());
    expect(api.apiPost.mock.calls[0][1]).toEqual({ originalSymbol: "111110", symbol: "999999", name: "합성전자", quantity: 100, price: 12000 });
    expect((await form.findByRole("alert")).textContent).toContain("이미 있는 종목으로 옮길 수 없습니다");
    expect(dialog()).toBeTruthy();
  });

  it("지우기 — 확인 창 뒤 POST positions/{symbol}/delete", async () => {
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "지우기 — 합성전자 111110" }));
    expect(dialog().textContent).toContain("현금은 바뀌지 않음");
    fireEvent.click(within(dialog()).getByRole("button", { name: "지우기" }));
    await waitFor(() => expect(postPaths()).toEqual(["/api/manual/isa/positions/111110/delete"]));
    expect(await screen.findByText(/잔고 행을 지웠습니다/)).toBeTruthy();
  });

  it("수수료율 고치기 — 지금 요율을 채우고 POST balance/commission", async () => {
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "수수료율 고치기" }));
    const form = within(dialog());
    const input = form.getByLabelText("수수료율(%)") as HTMLInputElement;
    expect(input.value).toBe("0.015");
    fireEvent.change(input, { target: { value: "0.1" } });
    fireEvent.click(form.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalled());
    expect(api.apiPost).toHaveBeenCalledWith("/api/manual/isa/balance/commission", { commissionPct: 0.1 });
    expect(await screen.findByText(/수수료율을 고쳤습니다/)).toBeTruthy();
  });

  it("총 잔고 다시 맞추기 — POST balance/total, 범위 밖 수수료율·빈 칸은 보내지 않음", async () => {
    renderIsa();
    fireEvent.click(await inRegion().findByRole("button", { name: "총 잔고 다시 맞추기" }));
    const form = within(dialog());
    expect((form.getByRole("button", { name: "다시 맞추기" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(form.getByLabelText("총 잔고(총평가금액, 원)"), { target: { value: "5,000,000" } });
    fireEvent.click(form.getByRole("button", { name: "다시 맞추기" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalled());
    expect(api.apiPost).toHaveBeenCalledWith("/api/manual/isa/balance/total", { totalAsset: 5_000_000 });
    expect(await screen.findByText(/현금을 다시 셌습니다/)).toBeTruthy();
  });
});

describe("표 정렬", () => {
  const headerCell = (name: string, header: string) =>
    within(table(name)).getAllByRole("columnheader").find((cell) => (cell.textContent ?? "").replace(/[↑↓↕]/g, "") === header) as HTMLElement;
  const symbolsOf = (name: string) => within(table(name)).getAllByRole("row").slice(1).map((row) => /\d{6}/.exec(row.textContent ?? "")?.[0]);

  it("매매 내역은 처음에 시각 내림차순, 머리를 누르면 그 열로 오름 → 내림", async () => {
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 매매 내역" });
    expect(headerCell("ISA 계좌 매매 내역", "시각").getAttribute("aria-sort")).toBe("descending");
    expect(symbolsOf("ISA 계좌 매매 내역")).toEqual(["111110", "222220"]);
    fireEvent.click(within(table("ISA 계좌 매매 내역")).getByRole("button", { name: "가격" }));
    expect(headerCell("ISA 계좌 매매 내역", "가격").getAttribute("aria-sort")).toBe("ascending");
    expect(symbolsOf("ISA 계좌 매매 내역")).toEqual(["111110", "222220"]);
    fireEvent.click(within(table("ISA 계좌 매매 내역")).getByRole("button", { name: "가격" }));
    expect(symbolsOf("ISA 계좌 매매 내역")).toEqual(["222220", "111110"]);
    expect(within(table("ISA 계좌 매매 내역")).queryByRole("button", { name: "되돌리기" })).toBeNull();
  });

  it("잔고 표도 숫자 열을 정렬 — 처음에는 서버 순서, 가격 모르는 종목은 맨 뒤", async () => {
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 잔고" });
    expect(symbolsOf("ISA 계좌 잔고")).toEqual(["111110", "222220", "333330"]);
    const positions = within(table("ISA 계좌 잔고"));
    fireEvent.click(positions.getByRole("button", { name: "평가액" }));
    fireEvent.click(positions.getByRole("button", { name: "평가액" }));
    expect(headerCell("ISA 계좌 잔고", "평가액").getAttribute("aria-sort")).toBe("descending");
    expect(symbolsOf("ISA 계좌 잔고")).toEqual(["222220", "111110", "333330"]);
    expect(positions.queryByRole("button", { name: "고치기" })).toBeNull();
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

describe("실시간 평가와 '확인' 가격", () => {
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
  const opened = async (): Promise<FakeEventSource> => {
    await waitFor(() => expect(FakeEventSource.instances.at(-1)?.listeners.get("prices")?.length ?? 0).toBeGreaterThan(0));
    return latest();
  };
  const send = async (source: FakeEventSource, items: Record<string, ReturnType<typeof krPrice>>) => {
    await act(async () => {
      source.emit("prices", { available: true, prices: { fetchedAt: "2026-11-09T05:31:10Z", items, missing: [], errors: {} } });
    });
  };

  it("탭 머리에 주기 상자와 기준 시각 — 보유 ∪ 지시 ∪ 스탑 지시 종목을 구독, 받기 전에는 직전 종가", async () => {
    reads[ISA_PATH] = () => Promise.resolve(started({ stopInstructions: [{ ...STOP_ITEM, symbol: "444440", name: "합성스탑" }] }));
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 잔고" });
    expect((inRegion().getByRole("combobox", { name: "실시간 시세 주기" }) as HTMLSelectElement).value).toBe("10");   // 기본 10초(2026-11-12)
    expect(inRegion().getByText(/^기준 시각/).textContent).toBe("기준 시각 —");
    const url = new URL((await opened()).url);
    expect(url.pathname).toBe("/api/live/prices/stream");
    // 확인할 지시(222220 SELL PLANNED)와 스탑 지시 종목까지 — 이미 확인한 지시(111110)는 보유에서만.
    expect(url.searchParams.get("items")).toBe("KR:111110,KR:222220,KR:333330,KR:444440");
    expect(rowOf("ISA 계좌 잔고", "합성전자 111110").textContent).toContain("12,500원직전 종가");
  });

  it("실시간 가격을 받으면 평가액·손익·비중을 다시 세고, 확인 창은 그 종목 실시간 가격으로 채운다", async () => {
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 잔고" });
    await send(await opened(), {
      "KR:111110": krPrice("111110", 13_000, "2026-11-09T05:31:05Z"),
      "KR:222220": krPrice("222220", 54_000, "2026-11-09T05:31:02Z"),
    });

    // 1,300,000 + 2,700,000 = 4,000,000, 총 잔고 = 현금 1,200,000 + 4,000,000. 가격 모르는 합성바이오가 남아 손익은 —.
    const total = inRegion().getByRole("group", { name: "총 평가액" });
    expect(total.textContent).toContain("5,200,000원");
    expect(inRegion().getByRole("group", { name: "평가손익" }).textContent).toContain("—");
    expect(inRegion().getByText(/^기준 시각/).textContent).toBe("기준 시각 2026-11-09 14:31:02 KST");
    const live = rowOf("ISA 계좌 잔고", "합성전자 111110");
    expect(live.textContent).toContain("13,000원실시간 14:31:05");
    expect(live.textContent).toContain("+100,000원");

    fireEvent.click(inRegion().getByRole("button", { name: "확인 — 합성화학 222220" }));
    expect((within(dialog()).getByRole("textbox", { name: "평균 단가(원) — 매도 합성화학 222220" }) as HTMLInputElement).value).toBe("54000");
    fireEvent.click(within(dialog()).getByRole("button", { name: "잔고에 반영" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalled());
    expect(lastBody()).toEqual({ items: [{ instructionId: 7, quantity: 3, amount: 162_000, fee: 24, priceSource: "live" }] });
  });

  it("총 잔고 다시 맞추기는 보유 종목의 화면 가격을 본문에 싣는다", async () => {
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 잔고" });
    await send(await opened(), { "KR:111110": krPrice("111110", 13_000, "2026-11-09T05:31:05Z") });
    fireEvent.click(inRegion().getByRole("button", { name: "총 잔고 다시 맞추기" }));
    const form = within(dialog());
    fireEvent.change(form.getByLabelText("총 잔고(총평가금액, 원)"), { target: { value: "1,000" } });
    fireEvent.click(form.getByRole("button", { name: "다시 맞추기" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalled());
    expect(lastBody()).toEqual({ totalAsset: 1_000, prices: { "111110": 13_000 } });
  });

  it("다음 응답에서 빠진 종목은 멈춘 값 — 직전 종가로 평가하고 확인 창은 기준가로 채움(QA-184 계약)", async () => {
    reads[ISA_PATH] = () => Promise.resolve(started({ instructions: { session: "2026-11-09", status: "PLANNED", items: [{ ...ITEMS[0], symbol: "111110", name: "합성전자" }] } }));
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 잔고" });
    await send(await opened(), { "KR:111110": krPrice("111110", 13_000, "2026-11-09T05:31:05Z") });
    await send(await opened(), { "KR:222220": krPrice("222220", 54_000, "2026-11-09T05:31:15Z") });
    expect(rowOf("ISA 계좌 잔고", "합성전자 111110").textContent).toContain("12,500원직전 종가");
    fireEvent.click(inRegion().getByRole("button", { name: "확인 — 합성전자 111110" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "잔고에 반영" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalled());
    expect(lastBody()).toEqual({ items: [{ instructionId: 7, quantity: 3, amount: 159_000, fee: 23, priceSource: "close" }] });
  });

  it("연결이 닫히면(disconnected) 받은 값을 쓰지 않고 서버 값으로", async () => {
    renderIsa();
    await inRegion().findByRole("table", { name: "ISA 계좌 잔고" });
    const stream = await opened();
    await send(stream, { "KR:111110": krPrice("111110", 13_000, "2026-11-09T05:31:05Z") });
    expect(inRegion().getByRole("group", { name: "총 평가액" }).textContent).toContain("5,150,000원");
    act(() => {
      stream.readyState = 2;
      stream.onerror?.();
    });
    expect(inRegion().getByRole("group", { name: "총 평가액" }).textContent).toContain("5,100,000원");
    expect(rowOf("ISA 계좌 잔고", "합성전자 111110").textContent).toContain("12,500원직전 종가");
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
