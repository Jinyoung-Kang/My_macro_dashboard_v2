/**
 * QA-739 — 모의매매 탭 줄(scroll-strip-active-item-offscreen의 모의 몫, Tabs 화살표 키): 손으로 만든 탭 줄이라
 *  - 모든 탭이 Tab 정지점이고(탭 아홉 개를 Tab으로 하나씩 지나야 패널에 닿음 — ARIA tabs는 고른 탭 하나),
 *  - →·←·Home·End가 포커스를 옮기지 않으며,
 *  - 줄이 폭보다 길 때 고른 탭(주소로 연 프레임·설정·실제 계좌 등)이 줄 밖에 가려진 채 열립니다(scrollLeft 0 그대로).
 * 공용 탭 줄(components/ui Tabs — 하위 메뉴 줄 QA-510과 같은 훅)과 같게 둡니다. 주소·탭 id·aria-controls·이름·replaceState는 paperRoutes 시험이 지킵니다.
 *
 * jsdom은 배치를 계산하지 않으므로 줄과 탭의 크기를 정해 둡니다 — 줄 보이는 폭 332px(390 화면의 본문 폭에서 뺀 값과 비슷), 탭 폭 90px·줄 안 왼쪽 위치 90 × 순서.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
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

const STRIP_WIDTH = 332;
const TAB_WIDTH = 90;

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };
const book = (code: string, kind: string, label: string) => ({
  code, kind, label, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000, cash: 200, nav: 100000, equityValue: 99800,
  exposurePct: 99.8, returnPct: 0, lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: STATS, benchmark: null,
});
const OVERVIEW = {
  available: true, initialized: true, startDate: "2026-10-23", limits: [], jobs: [], pendingBackfill: [], navSeries: { dates: [], books: {} }, quotes: null,
  books: [book("rules", "RULES", "규칙 계좌"), book("claude", "CLAUDE", "Claude 계좌"), book("bench_spy", "BENCHMARK", "SPY 계좌")],
};

/** 탭이 줄에서 몇째인가 — 탭이 아니면 -1. */
function indexOf(element: Element): number {
  if (element.getAttribute("role") !== "tab" || !element.parentElement) return -1;
  return [...element.parentElement.children].indexOf(element);
}

beforeEach(() => {
  window.history.replaceState(null, "", "/paper/us/settings");
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path.startsWith("/api/paper/overview") ? Promise.resolve(OVERVIEW) : new Promise(() => {})));
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
    const index = indexOf(this);
    return index < 0 ? 0 : index * TAB_WIDTH;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return indexOf(this) < 0 ? 0 : TAB_WIDTH;
  });
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return this.getAttribute("role") === "tablist" ? STRIP_WIDTH : 0;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const strip = () => screen.getByRole("tablist", { name: "모의 매매 화면" });

describe("QA-739 — 모의매매 탭 줄을 공용 탭 줄과 같게", () => {
  it("고른 탭 하나만 Tab 정지점이고 →·Home·End가 포커스만 옮긴다(고른 탭·주소 그대로)", async () => {
    render(<PaperScreen initialTab="settings" />);
    await screen.findByRole("tablist", { name: "모의 매매 화면" });
    const tabs = within(strip()).getAllByRole("tab");
    const stops = tabs.filter((tab) => tab.tabIndex === 0).map((tab) => tab.id);
    expect(stops).toEqual(["paper-tab-settings"]);

    const settings = screen.getByRole("tab", { name: "설정" });
    act(() => settings.focus());
    fireEvent.keyDown(settings, { key: "ArrowRight" });
    expect(document.activeElement?.id).toBe("paper-tab-real");
    fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
    expect(document.activeElement?.id).toBe("paper-tab-overview");
    fireEvent.keyDown(document.activeElement as Element, { key: "End" });
    expect(document.activeElement?.id).toBe(tabs.at(-1)?.id);
    // 화살표는 포커스만 — 고른 탭과 주소는 그대로(수동 활성 — 탭마다 자료를 읽는 화면이 지나가며 부르지 않게).
    expect(settings.getAttribute("aria-selected")).toBe("true");
    expect(window.location.pathname).toBe("/paper/us/settings");
  });

  it("줄이 폭보다 길면 주소로 연 탭(설정 — 일곱째)이 줄 안에 보이게 줄을 옮겨 둔다", async () => {
    render(<PaperScreen initialTab="settings" />);
    await screen.findByRole("tablist", { name: "모의 매매 화면" });
    const settings = screen.getByRole("tab", { name: "설정" });
    const left = settings.offsetLeft;
    // 고른 탭의 오른쪽 끝(여백 16px 포함)이 줄 보이는 폭 안 — 공용 탭 줄과 같은 셈(lib/scrollStrip).
    expect(strip().scrollLeft).toBeGreaterThan(0);
    expect(left + TAB_WIDTH - strip().scrollLeft).toBeLessThanOrEqual(STRIP_WIDTH);
  });
});
