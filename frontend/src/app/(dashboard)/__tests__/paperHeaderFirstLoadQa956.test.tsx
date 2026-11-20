/**
 * 모의매매 머리 첫 적재 자리 — QA-956(작업대 P8 후속, 결정 거리 `paper-header-slot-reserve` 중 첫 적재 몫 — P6 회귀).
 *
 * 머리의 계좌 고르기 칸(PaperTabHeader 계약 — 탭 섹션이 채움)과 '이 장부의 한계 (n줄)' 서랍 단추는 개요 응답 뒤에만 생겨, 그 뒤의 '자세히'·신선도 묶음이
 * 밀렸습니다 — 넓은 화면은 단추(30px)가 줄 높이를 19.5 → 30px로 키워 묶음이 5px 위로(1440 CLS 0.0016·1280 0.0021), 1024는 둘째 줄로(0.0028),
 * 390은 계좌 칸 줄(44px)이 끼어 52px 아래로(0.0073). 개편 전(P6 전)은 0.
 *
 * 기대: 개요를 처음 읽는 동안 머리에 값 뒤 꼴의 보이지 않는 자리(낭독·포커스 없음) — 계좌 고르기를 두는 탭(개요·보유·체결·결정 로그)은 계좌 칸 자리(같은 고르기
 * 상자 꼴), 모든 탭에 한계 단추 자리. 개요가 오면(값·실패) 자리는 빠지고 칸·단추가 그 자리에 섭니다. jsdom은 배치를 재지 않아 자리의 꼴을 봅니다.
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
import type { PaperTabKey } from "@/lib/paper";

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };
const book = (code: string, kind: string, label: string) => ({
  code, kind, label, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000, cash: 500, nav: 101200, equityValue: 100700,
  exposurePct: 99.5, returnPct: -1.2, lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: STATS, benchmark: null,
});
const OVERVIEW = {
  available: true, initialized: true, startDate: "2026-10-23", limits: ["모의 매매입니다.", "체결은 다음 관측치입니다."], jobs: [], pendingBackfill: [],
  quotes: null, navSeries: { dates: [], books: {} }, books: [book("rules", "RULES", "규칙 계좌"), book("claude", "CLAUDE", "Claude 계좌1")],
};

let resolveOverview: (value: unknown) => void = () => {};

beforeEach(() => {
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.startsWith("/api/paper/overview")) return new Promise((resolve) => { resolveOverview = resolve; });
    return new Promise(() => {});
  });
});
afterEach(() => cleanup());

const settled = () => act(async () => {});
const header = () => screen.getByRole("banner");
const tokens = (element: Element | null) => (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
const reserve = (name: string) => header().querySelector(`[data-paper-header-reserve="${name}"]`);

describe("모의매매 머리 첫 적재 자리(QA-956)", () => {
  for (const tab of ["overview", "holdings", "decisions"] as PaperTabKey[]) {
    it.fails(`${tab}: 개요를 읽는 동안 계좌 칸 자리와 한계 단추 자리 — 보이지 않고 읽히지 않음, 개요가 오면 빠짐`, async () => {
      render(<PaperScreen market="US" initialTab={tab} />);
      await settled();
      const account = reserve("account");
      expect(account).toBeTruthy();
      expect(account?.getAttribute("aria-hidden")).toBe("true");
      expect(tokens(account)).toContain("invisible");
      // 같은 고르기 상자 꼴(머리 계좌 칸과 같은 '계좌' 글 + 고르기 상자) — 포커스 없음.
      expect(account?.querySelector("select")).toBeTruthy();
      expect(account?.hasAttribute("inert")).toBe(true);
      const limits = reserve("limits");
      expect(limits?.getAttribute("aria-hidden")).toBe("true");
      expect(tokens(limits)).toContain("invisible");
      expect(limits?.textContent).toMatch(/^이 장부의 한계 \(\d줄\)$/);
      // 읽히는 것은 없음.
      expect(within(header()).queryByRole("combobox")).toBeNull();
      expect(within(header()).queryByRole("button", { name: /이 장부의 한계/ })).toBeNull();

      await act(async () => resolveOverview(OVERVIEW));
      expect(reserve("account")).toBeNull();
      expect(reserve("limits")).toBeNull();
      expect(within(header()).getByRole("button", { name: "이 장부의 한계 (2줄)" })).toBeTruthy();
    });
  }

  it.fails("계좌 고르기가 없는 탭(프레임)은 한계 단추 자리만", async () => {
    render(<PaperScreen market="US" initialTab="framework" />);
    await settled();
    expect(reserve("account")).toBeNull();
    expect(reserve("limits")).toBeTruthy();
  });
});
