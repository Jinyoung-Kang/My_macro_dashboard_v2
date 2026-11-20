/**
 * 모의매매 머리 칸의 탭별 동작 목록(작업대 P6 통합 — 실행 명세 §7-1 '동작(ActionBar)은 탭마다 다른 목록', 머리 칸 계약 components/screens/paper/PaperTabHeader.tsx).
 *
 * 세 갈래(셸·로그·설정)가 각자 자기 탭의 섹션에서 머리 칸으로 계좌 고르기·동작을 보냅니다. 합친 뒤에도 탭마다 그 탭의 것만 칸에 있고(다른 탭의 단추가 남지
 * 않음), 동작이 없는 탭·실제 계좌·ISA 탭은 칸이 비는지 탭을 차례로 바꾸며 봅니다.
 *
 *  - 개요: 계좌 고르기만(동작 없음)
 *  - 보유·체결: 계좌 고르기 + '일시정지'·'계좌 초기화'(묶음 이름 '보유·체결 동작')
 *  - 결정 로그: 계좌 고르기 + '지금 결정 실행'(묶음 이름 '결정 동작') — 한국 규칙 계좌는 수동 결정이 없어 빈 목록, 한국 Claude 계좌를 고르면 생김.
 *    '주간 복기' 보기는 계좌를 고르지 않아 두 칸이 빔('지금 복기 실행'은 그 보기 안 그대로)
 *  - 기관·종목 선정·프레임·메모·설정·실제 계좌·ISA: 두 칸 모두 빔
 *
 * 자료는 모두 지어낸 예시이고 실제 계좌 자료가 아닙니다. 읽기만 하고 쓰기 요청은 보내지 않습니다(마지막 단언).
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
import type { PaperMarketCode } from "@/lib/paperMarket";

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };
const book = (code: string, kind: string, label: string) => ({
  code, kind, label, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000, cash: 500, nav: 101200, equityValue: 100700,
  exposurePct: 99.5, returnPct: -1.2, lastObservedAtKst: "2026-10-24 05:15", positions: 0, staleCount: 0, stats: STATS, benchmark: null,
});
const BOOKS: Record<PaperMarketCode, ReturnType<typeof book>[]> = {
  US: [book("rules", "RULES", "규칙 계좌"), book("claude", "CLAUDE", "Claude 계좌1"), book("bench_spy", "BENCHMARK", "SPY 계좌")],
  KR: [book("kr_rules", "RULES", "한국 규칙 계좌"), book("kr_claude", "CLAUDE", "한국 Claude 계좌"), book("kr_bench_k200", "BENCHMARK", "KODEX 200 계좌")],
};
const overviewOf = (market: PaperMarketCode) => ({
  available: true, initialized: true, market, startDate: "2026-10-23", limits: ["모의 매매입니다."], jobs: [], pendingBackfill: [], quotes: null,
  navSeries: { dates: [], books: {} }, dormantReason: null, books: BOOKS[market],
});

beforeEach(() => {
  api.apiPost.mockReset();
  api.apiDelete.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.startsWith("/api/paper/overview")) return Promise.resolve(overviewOf(path.includes("market=KR") ? "KR" : "US"));
    // 그 밖의 읽기는 끝나지 않는 요청 — 머리 칸은 섹션이 자기 자료를 받기 전에 그려집니다(책 목록은 개요 응답).
    return new Promise(() => {});
  });
});

afterEach(() => cleanup());

const settled = () => act(async () => {});
const slot = (name: "account" | "actions") => document.querySelector(`[data-paper-header-slot="${name}"]`) as HTMLElement;
/** 동작 칸의 단추 이름 — 비면 []. */
const actionNames = () => within(slot("actions")).queryAllByRole("button").map((button) => button.textContent ?? "");
const hasAccountPicker = () => within(slot("account")).queryByRole("combobox", { name: "계좌 고르기" }) !== null;
async function openTab(name: string) {
  fireEvent.click(screen.getByRole("tab", { name }));
  await settled();
  expect(screen.getByRole("tab", { name }).getAttribute("aria-selected")).toBe("true");
}

describe("머리 칸 — 탭마다 그 탭의 계좌 고르기·동작만", () => {
  it("미국: 개요 → 보유·체결 → 결정 로그(주간 복기 보기 포함) → 기관 선정·프레임·메모·설정·실제 계좌 — 남는 단추 없음", async () => {
    window.history.replaceState(null, "", "/paper/us");
    render(<PaperScreen market="US" initialTab="overview" />);
    await settled();

    expect(hasAccountPicker()).toBe(true);
    expect(actionNames()).toEqual([]);

    await openTab("보유·체결");
    expect(hasAccountPicker()).toBe(true);
    expect(within(slot("actions")).getByRole("group", { name: "보유·체결 동작" })).toBeTruthy();
    expect(actionNames()).toEqual(["일시정지", "계좌 초기화"]);

    await openTab("결정 로그");
    expect(hasAccountPicker()).toBe(true);
    expect(within(slot("actions")).getByRole("group", { name: "결정 동작" })).toBeTruthy();
    expect(actionNames()).toEqual(["지금 결정 실행"]);

    fireEvent.click(screen.getByRole("button", { name: "주간 복기" }));
    await settled();
    expect(hasAccountPicker()).toBe(false);
    expect(actionNames()).toEqual([]);

    for (const name of ["기관 선정", "프레임", "메모", "설정", "실제 계좌"]) {
      await openTab(name);
      expect(slot("account").childElementCount).toBe(0);
      expect(slot("actions").childElementCount).toBe(0);
    }

    // 다시 보유·체결로 오면 그 탭의 동작이 다시 생김(칸은 탭과 함께 비고 채워짐)
    await openTab("보유·체결");
    expect(actionNames()).toEqual(["일시정지", "계좌 초기화"]);

    // 탭을 오가는 동안 쓰기 요청 0
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(api.apiDelete).not.toHaveBeenCalled();
  });

  it("한국: 결정 로그는 규칙 계좌(수동 결정 없음)면 동작 칸이 비고 Claude 계좌를 고르면 '지금 결정 실행', 종목 선정·ISA는 빔", async () => {
    window.history.replaceState(null, "", "/paper/kr/decisions");
    render(<PaperScreen market="KR" initialTab="decisions" />);
    await settled();

    const picker = within(slot("account")).getByRole("combobox", { name: "계좌 고르기" }) as HTMLSelectElement;
    expect(picker.value).toBe("kr_rules");
    expect(slot("actions").childElementCount).toBe(0);

    fireEvent.change(picker, { target: { value: "kr_claude" } });
    await settled();
    expect(actionNames()).toEqual(["지금 결정 실행"]);

    await openTab("보유·체결");
    expect(actionNames()).toEqual(["일시정지", "계좌 초기화"]);

    for (const name of ["종목 선정", "프레임", "메모", "설정", "실제 계좌", "ISA 계좌"]) {
      await openTab(name);
      expect(slot("account").childElementCount).toBe(0);
      expect(slot("actions").childElementCount).toBe(0);
    }

    expect(api.apiPost).not.toHaveBeenCalled();
    expect(api.apiDelete).not.toHaveBeenCalled();
  });
});
