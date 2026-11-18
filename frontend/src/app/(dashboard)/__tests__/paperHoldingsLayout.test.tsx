/**
 * 모의매매 보유·체결 탭 재배치(작업대 P6 — 실행 명세 §7-1 '보유: 목록-검사, 일시정지·계좌 초기화는 머리 동작, 체결은 조밀 표와 필터').
 *
 *  - 머리: 계좌 고르기(머리 칸)와 동작('보유·체결 동작' — '일시정지'/'재개'는 확인 없이 그대로, '계좌 초기화'는 위험 의도·aria-haspopup=dialog).
 *    확인 창은 예전 그대로(계좌 코드 입력 — 쓰기 지킴 시험이 경로·본문을 봄), 취소하면 머리의 단추로 포커스
 *  - 계좌 패널: 결과 알림 영역(role=status)이 맨 위, 상태 배지 + KPI 띠('{계좌} 요약' — 순자산·수익률·현금·노출·출발), '읽는 법' 접기에 예전 설명 글
 *  - 보유 표: 맨 앞 아이콘 줄 단추('{종목} 보유 자세히')가 검사 칸(좁은 틀 — 위쪽 대화상자)을 열고, 속성(수량·평단·…·표지)과 '결정 로그에서 보기'
 *    (결정을 내는 계좌만 — 결정 로그 탭으로 바꾸며 이 계좌를 미리 고름). 검사 칸 열기는 새 요청 없음
 *  - 주문·체결: 받은 줄 거르기(주문 상태·체결 방향 — 하나 고름, 줄 수), 표 머리 개수, 긴 설명은 '읽는 법' 접기(글 그대로)
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), apiBase: () => "", UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  LineChart: () => null,
  MultiLineSeries: () => null,
  DonutChart: () => null,
}));

import PaperScreen from "@/components/screens/paper/PaperScreen";
import { endpoints } from "@/lib/endpoints";

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };
const book = (code: string, kind: string, label: string, over: Record<string, unknown> = {}) => ({
  code, kind, label, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000, cash: 500, nav: 101200, equityValue: 100700,
  exposurePct: 99.5, returnPct: -1.2, lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: STATS, benchmark: null, ...over,
});
const BOOKS = [book("rules", "RULES", "규칙 계좌"), book("bench_spy", "BENCHMARK", "SPY 계좌")];
const OVERVIEW = {
  available: true, initialized: true, startDate: "2026-10-23", limits: [], jobs: [], pendingBackfill: [], quotes: null,
  navSeries: { dates: [], books: {} }, books: BOOKS,
};
const POSITION = {
  ticker: "NVDA", qty: 10, avgCost: 200, lastPrice: 202, lastPriceAtKst: "2026-10-24 05:15", marketValue: 2020, weightPct: 2, unrealizedPct: 1,
  highWatermark: 205, stopPrice: 188.6, stopDistancePct: 6.6, openedOn: "2026-10-23", holdingTradingDays: 15, priceStale: false,
  splitNote: null, cashLike: false, backfilled: false,
};
const order = (id: number, status: string, side = "BUY") => ({
  id, ticker: "NVDA", side, qty: 10, targetWeightPct: null, sellFraction: null, timing: "NEXT_OBSERVATION", source: "RULES", status,
  rejectReason: null, reason: null, asOfTradingDate: "2026-10-23", createdAtKst: `2026-10-24 05:0${id}`, expiresOn: null, filledAtKst: null,
});
const fill = (id: number, side: string) => ({
  id, orderId: id, ticker: "NVDA", side, qty: 10, price: 202.4101, rawPrice: 202.31, slippageBp: 5, gross: 2024.1,
  observedAtKst: `2026-10-24 05:0${id}`, observationDate: "2026-10-23", priceSource: "equity_close", backfill: false,
});

const calls = () => (api.apiGetShared.mock.calls as unknown as [string][]).map(([path]) => path);
const settled = () => act(async () => {});

beforeEach(() => {
  window.history.replaceState(null, "", "/paper/us/holdings");
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path === endpoints.paper.market("US").overview) return Promise.resolve(OVERVIEW);
    if (path.includes("/positions")) {
      const owner = BOOKS.find((entry) => path.includes(`/books/${entry.code}/`)) ?? BOOKS[0];
      return Promise.resolve({ available: true, book: owner, cash: 500, lockouts: [], positions: [POSITION] });
    }
    if (path.includes("/orders")) return Promise.resolve({ available: true, orders: [order(1, "PENDING"), order(2, "FILLED"), order(3, "EXPIRED")] });
    if (path.includes("/fills")) return Promise.resolve({ available: true, fills: [fill(1, "BUY"), fill(2, "SELL")] });
    return new Promise(() => {});
  });
});

afterEach(() => cleanup());

describe("보유·체결 — 머리 칸", () => {
  it("계좌 고르기와 동작이 머리 칸에 — 일시정지(기본)·계좌 초기화(위험·대화상자), 확인 창을 취소하면 머리 단추로 포커스·쓰기 없음", async () => {
    render(<PaperScreen initialTab="holdings" />);
    await settled();
    const picker = screen.getByRole("combobox", { name: "계좌 고르기" });
    expect(picker.closest('[data-paper-header-slot="account"]')).not.toBeNull();
    const group = screen.getByRole("group", { name: "보유·체결 동작" });
    expect(group.closest('[data-paper-header-slot="actions"]')).not.toBeNull();
    const pause = within(group).getByRole("button", { name: "일시정지" });
    expect(pause.getAttribute("aria-haspopup")).toBeNull();
    const reset = within(group).getByRole("button", { name: "계좌 초기화" });
    expect(reset.getAttribute("aria-haspopup")).toBe("dialog");
    expect(reset.className).toContain("bg-danger");

    reset.focus();
    fireEvent.click(reset);
    const dialog = screen.getByRole("dialog", { name: "규칙 계좌 초기화" });
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "계좌 초기화" })));
    expect(api.apiPost).not.toHaveBeenCalled();
  });

  it("계좌 패널: 맨 위 알림 영역, 상태 배지·KPI 띠(음수는 '−'), 일시정지 설명은 늘 보임(머리 단추가 가리킴), 초기화 설명은 '읽는 법' 접기", async () => {
    render(<PaperScreen initialTab="holdings" />);
    await settled();
    const strip = screen.getByRole("region", { name: "규칙 계좌 요약" });
    expect(within(strip).getByRole("group", { name: "순자산" }).textContent).toContain("101,200.00");
    expect(within(strip).getByRole("group", { name: "수익률(출발 이후)" }).textContent).toContain("−1.20%");
    expect(within(strip).getByRole("group", { name: "주식 노출" }).textContent).toContain("현금성(SHY) 포함");
    expect(within(strip).getByRole("group", { name: "출발" }).textContent).toContain("2026-10-23");
    const panel = strip.closest("section[aria-labelledby]")?.parentElement?.closest("section") ?? document.body;
    const status = within(panel as HTMLElement).getAllByRole("status")[0];
    expect(status.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 일시정지 설명은 접지 않은 글이고, 머리 '일시정지'가 그 글을 설명(aria-describedby)으로 가리킴(확인 없이 바로 도는 동작 — 작업대 P6 검토).
    const note = screen.getByText("일시정지하면 대기 주문을 취소하고 새 체결·스탑을 멈춥니다. 평가(순자산 기록)는 계속합니다.");
    expect(note.closest("details")).toBeNull();
    const pause = within(screen.getByRole("group", { name: "보유·체결 동작" })).getByRole("button", { name: "일시정지" });
    expect(pause.getAttribute("aria-describedby")).toBe(note.id);
    const guide = screen.getAllByText("읽는 법", { exact: false, selector: "summary" }).find((entry) => entry.textContent?.includes("계좌 초기화"));
    if (!guide) throw new Error("읽는 법 없음");
    expect(guide.closest("details")?.textContent).toContain("계좌 초기화는 이 계좌의 체결·주문·보유·재진입 금지·순자산 기록을 모두 지웁니다.");
  });
});

describe("보유 표 — 검사 칸", () => {
  it("아이콘 줄 단추가 대화상자(좁은 틀)로 그 보유의 속성을 열고, '결정 로그에서 보기'는 결정 로그 탭에서 이 계좌 — 새 요청 없음", async () => {
    render(<PaperScreen initialTab="holdings" />);
    await settled();
    const before = calls().length;
    const trigger = screen.getByRole("button", { name: "NVDA 보유 자세히" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "NVDA 보유" });
    const value = (label: string) => within(dialog).getByText(label, { selector: "dt" }).parentElement?.querySelector("dd")?.textContent;
    expect(value("평단")).toBe("200.0000 달러");
    expect(value("평가 손익(평단 대비)")).toBe("+1.00%");
    expect(value("스탑 가격 · 거리")).toBe("188.6000 · 거리 6.6%");
    expect(value("보유 기간")).toBe("2026-10-23부터 · 15거래일");
    expect(within(dialog).getByText(/진입 논거·무효화 조건과 그 확인/)).toBeTruthy();
    await settled();
    expect(calls().slice(before)).toEqual([]);

    fireEvent.click(within(dialog).getByRole("button", { name: "결정 로그에서 보기" }));
    expect(screen.getByRole("tab", { name: "결정 로그" }).getAttribute("aria-selected")).toBe("true");
    expect((screen.getByLabelText("계좌 고르기") as HTMLSelectElement).value).toBe("rules");
  });

  it("결정을 내지 않는 벤치마크 계좌의 검사 칸에는 '결정 로그에서 보기'가 없다", async () => {
    render(<PaperScreen initialTab="holdings" />);
    await settled();
    fireEvent.change(screen.getByRole("combobox", { name: "계좌 고르기" }), { target: { value: "bench_spy" } });
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "NVDA 보유 자세히" }));
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "결정 로그에서 보기" })).toBeNull();
  });
});

describe("주문·체결 — 받은 줄 거르기·개수", () => {
  it("주문 상태(전체·대기·체결·그 밖)와 체결 방향(전체·매수·매도)을 고르면 그 줄만 — 새 요청 없음, 머리 개수가 따라감", async () => {
    render(<PaperScreen initialTab="holdings" />);
    await settled();
    const orders = screen.getByRole("table", { name: "주문" });
    expect(within(orders).getAllByRole("row")).toHaveLength(4);
    const statusGroup = screen.getByRole("radiogroup", { name: "주문 상태" });
    expect(within(statusGroup).getAllByRole("radio").map((radio) => radio.textContent)).toEqual([
      "전체3", "대기1", "체결1", "그 밖(제안·만료·취소·거절)1",
    ]);
    const before = calls().length;
    fireEvent.click(within(statusGroup).getByRole("radio", { name: /^대기/ }));
    expect(within(screen.getByRole("table", { name: "주문" })).getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("1건")).toBeTruthy();

    const sideGroup = screen.getByRole("radiogroup", { name: "체결 방향" });
    fireEvent.click(within(sideGroup).getByRole("radio", { name: /^매도/ }));
    const fills = screen.getByRole("table", { name: "체결" });
    expect(within(fills).getAllByRole("row")).toHaveLength(2);
    expect(within(fills).getByText("매도")).toBeTruthy();
    await settled();
    expect(calls().slice(before)).toEqual([]);
  });
});
