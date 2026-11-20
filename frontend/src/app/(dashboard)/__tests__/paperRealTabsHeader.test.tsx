/**
 * 실제 계좌·ISA 탭과 모의매매 머리(작업대 P6 — 실행 명세 §7-1 '실제 계좌·ISA·실제 매매는 지금은 겉모양만, 구조는 열어 둠').
 *
 *  - 실제 계좌·ISA 탭은 머리의 계좌 고르기·동작 칸이 빈다(확장 지점 — 그 탭의 동작 목록은 지금 빈 목록, 모듈은 그대로)
 *  - 머리 제목 옆에 주의 태그 '실제 계좌'가 늘 보인다(명세 §7-1 '실제 표지는 늘 보임')
 *  - 실제 매매 끄기 단추는 머리 동작·접힌 메뉴 안이 아니라 그 칸에 늘 보인다(SEC-6), 개요가 없을 때의 대체 단추('실제 계좌 탭으로(실제 매매 끄기)')도
 *    머리 동작 칸 밖 — 머리 칸은 탭 섹션이 채우는 자리라 개요가 없으면 비어 있음
 *
 * 실제 매매·실제 계좌·ISA 모듈의 시험(realTradeScreen·isaScreen·paperBrokerage)과 경계 시험 셋은 이 파일과 따로 그대로 통과합니다. 자료는 모두 지어낸
 * 예시입니다(실제 계좌 자료 아님).
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
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
const KR_OVERVIEW = {
  available: true, initialized: true, market: "KR", startDate: "2026-10-29", limits: ["모의 매매입니다."], jobs: [], pendingBackfill: [],
  navSeries: { dates: [], books: {} }, quotes: null, dormantReason: null,
  books: [{
    code: "kr_rules", kind: "RULES", label: "한국 규칙 계좌", status: "ACTIVE", startedOn: "2026-10-29", initialCash: 100_000_000, cash: 1000,
    nav: 100_000_000, equityValue: 99_999_000, exposurePct: 99.9, returnPct: 0, lastObservedAtKst: "2026-10-30 15:40", positions: 1, staleCount: 0,
    stats: STATS, benchmark: null,
  }],
};
/** 지어낸 실제 매매 상태(켜짐) — 끄기 단추가 보이는 상태. */
const REAL_STATUS = {
  available: true, market: "KR", supported: true, serverEnabled: { collector: true, backend: true, reason: null }, state: "LIVE",
  sourceBook: "kr_rules", sourceLabel: "한국 규칙 계좌", lossLimitPct: 15, baselineEquity: 1_000_000, buysPaused: false, haltReason: null,
  version: 1, limits: { maxOrderKrw: 100_000, maxOrdersPerDay: 4, maxBuyKrwPerDay: 200_000, maxEquityKrw: 300_000 },
  today: { date: "2026-11-06", skipReason: null, windows: [] }, lastPreflight: null, orders: [], events: [],
  books: [{ code: "kr_rules", label: "한국 규칙 계좌", status: "ACTIVE" }],
};

let overview: () => Promise<unknown> = () => Promise.resolve(KR_OVERVIEW);

beforeEach(() => {
  overview = () => Promise.resolve(KR_OVERVIEW);
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.startsWith("/api/paper/overview")) return overview();
    if (path.startsWith("/api/realtrade/status")) return Promise.resolve(REAL_STATUS);
    return new Promise(() => {});
  });
});

afterEach(() => cleanup());

const settled = () => act(async () => {});
/** 화면 머리(h1을 담은 header — 실제 매매 칸 같은 패널의 머리와 다름). */
const pageHeader = () => screen.getByRole("heading", { level: 1 }).closest("header") as HTMLElement;
const slot = (name: "account" | "actions") => document.querySelector(`[data-paper-header-slot="${name}"]`) as HTMLElement;
/** 요소가 눈에 늘 보이는 자리인가 — 닫힌 접기·hidden·메뉴·머리 동작 칸 안이 아님. */
function alwaysVisible(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hidden || node.getAttribute("role") === "menu" || node.hasAttribute("data-paper-header-slot")) return false;
    if (node.tagName === "DETAILS" && !(node as HTMLDetailsElement).open) return false;
  }
  return true;
}

describe("실제 계좌·ISA 탭의 머리", () => {
  for (const tab of ["real", "isa"] as const) {
    it(`${tab === "real" ? "실제 계좌" : "ISA 계좌"} 탭: 머리의 계좌 고르기·동작 칸이 비고, 제목 옆 주의 태그 '실제 계좌'`, async () => {
      window.history.replaceState(null, "", `/paper/kr/${tab}`);
      render(<PaperScreen market="KR" initialTab={tab} />);
      await settled();
      expect(screen.getByRole("tab", { name: tab === "real" ? "실제 계좌" : "ISA 계좌" }).getAttribute("aria-selected")).toBe("true");
      expect(slot("account").childElementCount).toBe(0);
      expect(slot("actions").childElementCount).toBe(0);
      expect(screen.queryByRole("combobox", { name: "계좌 고르기" })).toBeNull();
      const header = screen.getByRole("heading", { level: 1 }).closest("header") as HTMLElement;
      const tag = within(header).getByText("실제 계좌");
      expect(tag.closest(".text-warn")).not.toBeNull();
      expect(alwaysVisible(tag)).toBe(true);
    });
  }

  it("실제 매매 끄기 단추는 실제 매매 칸에 늘 보인다 — 머리 동작·메뉴·접힌 곳 안이 아님(SEC-6)", async () => {
    window.history.replaceState(null, "", "/paper/kr/real");
    render(<PaperScreen market="KR" initialTab="real" />);
    const off = await within(await screen.findByRole("region", { name: "실제 매매" })).findByRole("button", { name: "실제 매매 끄기" });
    expect(alwaysVisible(off)).toBe(true);
    expect(pageHeader().contains(off)).toBe(false);
  });

  it("개요가 없을 때 대체 단추('실제 계좌 탭으로(실제 매매 끄기)')는 머리 동작 칸 밖에 늘 보이고, 머리 칸은 빈다", async () => {
    window.history.replaceState(null, "", "/paper/kr");
    overview = () => Promise.reject(new Error("요청 실패 (HTTP 500)"));
    render(<PaperScreen market="KR" initialTab="overview" />);
    expect(await screen.findByText("요청 실패 (HTTP 500)")).toBeTruthy();
    const fallback = screen.getByRole("button", { name: "실제 계좌 탭으로(실제 매매 끄기)" });
    expect(alwaysVisible(fallback)).toBe(true);
    expect(pageHeader().contains(fallback)).toBe(false);
    expect(slot("actions").childElementCount).toBe(0);
    expect(slot("account").childElementCount).toBe(0);
  });

  it("미국 실제 계좌 탭도 머리 칸이 비고 주의 태그 — 모의 탭(개요)에는 태그가 없다", async () => {
    window.history.replaceState(null, "", "/paper/us/real");
    overview = () => Promise.resolve({ ...KR_OVERVIEW, market: "US", books: [] });
    const view = render(<PaperScreen market="US" initialTab="real" />);
    await settled();
    expect(slot("actions").childElementCount).toBe(0);
    expect(within(screen.getByRole("heading", { level: 1 }).closest("header") as HTMLElement).getByText("실제 계좌")).toBeTruthy();
    view.unmount();
    window.history.replaceState(null, "", "/paper/us");
    render(<PaperScreen market="US" initialTab="overview" />);
    await settled();
    expect(within(screen.getByRole("heading", { level: 1 }).closest("header") as HTMLElement).queryByText("실제 계좌")).toBeNull();
  });
});
