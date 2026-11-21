/**
 * 결정 로그 '결정 기록 / 주간 복기' 세그먼트를 누르면 누른 단추가 화면에서 움직임 — QA-957(작업대 P8 후속, 결정 거리 `paper-header-slot-reserve` 중 보기 바꾸기 몫 — P6 회귀).
 *
 * '주간 복기' 보기는 계좌를 고르지 않아 머리 칸(계좌 고르기·'지금 결정 실행')이 비고, 머리가 줄어 세그먼트가 위로 올라갔습니다 — 빌드한 화면(QA 스택) 맨 위에서
 * 누르면 390 −52px(406 → 354)·1024 −38px(246 → 208), 1440은 0. 아래로 200px 내려 누르면 복기 보기(읽는 중 한 줄)가 짧아 스크롤이 맨 위로 당겨지며
 * 단추가 거꾸로 148px 아래로(206 → 354, 390). '결정 기록'으로 돌아오면 반대로 움직였습니다.
 *
 * 기대: 복기 보기에서도 머리 칸에 같은 꼴의 보이지 않는 자리(낭독·포커스 없음 — 그 보기는 계좌를 고르지 않는다는 뜻 그대로)를 두고, 보기를 바꿀 때 보기 영역이
 * 누른 때의 스크롤 위치를 지킬 높이(지금 화면 아래 끝까지) 이상이 되게 합니다. jsdom은 배치를 재지 않아 자리의 꼴과 높이 스타일을 봅니다(브라우저 잰 값은 고친 커밋).
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
vi.mock("next/navigation", () => ({ usePathname: () => null }));

import PaperScreen from "@/components/screens/paper/PaperScreen";

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };
const book = (code: string, kind: string, label: string) => ({
  code, kind, label, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000, cash: 500, nav: 101200, equityValue: 100700,
  exposurePct: 99.5, returnPct: -1.2, lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: STATS, benchmark: null,
});
const OVERVIEW = {
  available: true, initialized: true, startDate: "2026-10-23", limits: ["모의 매매입니다."], jobs: [], pendingBackfill: [], quotes: null,
  navSeries: { dates: [], books: {} }, books: [book("rules", "RULES", "규칙 계좌"), book("claude", "CLAUDE", "Claude 계좌1")],
};

beforeEach(() => {
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.startsWith("/api/paper/overview")) return Promise.resolve(OVERVIEW);
    if (path.startsWith("/api/paper/decisions?")) return Promise.resolve({ available: true, decisions: [] });
    return new Promise(() => {});
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
});

const settled = () => act(async () => {});
const slot = (name: "account" | "actions") => document.querySelector(`[data-paper-header-slot="${name}"]`) as HTMLElement;
const tokens = (element: Element | null) => (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

describe("결정 로그 보기 바꾸기 — 누른 단추가 제자리(QA-957)", () => {
  it("복기 보기에서도 머리 칸에 같은 꼴의 보이지 않는 자리 — 읽히지 않고 포커스 없음, 쓰기 없음", async () => {
    render(<PaperScreen market="US" initialTab="decisions" />);
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "주간 복기" }));
    await settled();

    // 읽히는 고르기·동작은 없음(복기는 계좌를 고르지 않음 — paperHeaderSlotsByTab 그대로).
    expect(within(slot("account")).queryByRole("combobox")).toBeNull();
    expect(within(slot("actions")).queryAllByRole("button")).toEqual([]);
    // 자리: 같은 고르기 상자·같은 동작 단추 꼴, aria-hidden + invisible + inert.
    const account = slot("account").firstElementChild;
    expect(account?.getAttribute("aria-hidden")).toBe("true");
    expect(tokens(account)).toContain("invisible");
    expect(account?.hasAttribute("inert")).toBe(true);
    expect(account?.querySelector("select")).toBeTruthy();
    const actions = slot("actions").firstElementChild;
    expect(actions?.getAttribute("aria-hidden")).toBe("true");
    expect(tokens(actions)).toContain("invisible");
    expect(actions?.hasAttribute("inert")).toBe(true);
    expect(actions?.textContent).toContain("지금 결정 실행");

    // '결정 기록'으로 돌아오면 진짜 칸.
    fireEvent.click(screen.getByRole("button", { name: "결정 기록" }));
    await settled();
    expect(within(slot("account")).getByRole("combobox", { name: "계좌 고르기" })).toBeTruthy();
    expect(within(slot("actions")).getByRole("button", { name: "지금 결정 실행" })).toBeTruthy();
    expect(api.apiPost).not.toHaveBeenCalled();
  });

  it("보기를 바꾸면 보기 영역이 누른 때의 화면 아래 끝까지 이상 — 짧은 복기 보기에 스크롤이 당겨지지 않게", async () => {
    render(<PaperScreen market="US" initialTab="decisions" />);
    await settled();
    const group = screen.getByRole("group", { name: "결정 로그 보기" });
    const area = group.closest("[data-decision-view]") as HTMLElement | null;
    expect(area).toBeTruthy();
    // 스크롤 200에서 영역 위쪽이 화면 위 100px(문서 300px)이면, 문서가 200 + 화면 높이까지 남도록 영역은 화면 높이 − 100px 이상.
    Object.defineProperty(window, "scrollY", { value: 200, configurable: true });
    vi.spyOn(area as HTMLElement, "getBoundingClientRect").mockReturnValue({ top: 100 } as DOMRect);
    fireEvent.click(screen.getByRole("button", { name: "주간 복기" }));
    await settled();
    expect((group.closest("[data-decision-view]") as HTMLElement).style.minHeight).toBe(`${window.innerHeight - 100}px`);
  });
});
