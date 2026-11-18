/**
 * QA-750 — 모의 메모 쓰기 폼의 라벨 모양과 입력 폭이 공용 고르기 상자(ui Select)와 다름(진행 기록 넘긴 항목 `form-label-styles-mixed`의 메모 쓰기 폼 몫).
 *
 * 공용 Select의 라벨은 13px 보조 글(text-[13px] text-text-2)이고 상자 폭은 넓은 화면(sm 이상)에서 22rem까지인데, 메모 쓰기 폼의 라벨 다섯(종류·기준일·
 * 만료일·제목·본문)은 12px 흐린 글(text-xs text-text-3)이고 한 줄 입력(종류 고르기·날짜 둘·제목)은 폭 상한이 없어, 같은 화면의 다른 폼(공용 Select를 쓰는
 * 결정 로그·설정)과 라벨 모양이 갈리고 넓은 화면의 제목 입력이 패널 폭만큼 늘어납니다. jsdom은 배치를 재지 않으므로 클래스로 봅니다.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
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

import PaperPage from "@/components/screens/paper/PaperScreen";

const OVERVIEW = {
  available: true, initialized: true, startDate: "2026-10-23", limits: [], jobs: [], pendingBackfill: [], books: [],
  navSeries: { dates: [], books: {} }, quotes: null, selection: null, gate: null,
};

/** 경로(정확히 일치) → 응답. 없는 경로는 끝나지 않는 요청. */
let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = {
    "/api/paper/overview": OVERVIEW,
    "/api/paper/notes?includeExpired=false": { available: true, referenceDate: "2026-10-26", notes: [] },
    "/api/paper/settings": { available: true, version: 1, body: {}, defaults: {}, keys: [] },
  };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => cleanup());

const tokens = (element: Element | null) => String(element?.getAttribute("class") ?? "").split(/\s+/);

describe("QA-750 메모 쓰기 폼 — 라벨은 공용 고르기 상자와 같은 13px 보조 글, 한 줄 입력은 넓은 화면 22rem까지", () => {
  it.fails("라벨 다섯은 text-[13px] text-text-2, 한 줄 입력 넷(종류·기준일·만료일·제목)은 sm:max-w-[22rem], 본문은 패널 폭", async () => {
    render(<PaperPage initialTab="notes" market="US" />);
    const form = await screen.findByRole("form", { name: "메모 쓰기" });

    const labels = ["종류", "기준일(선택)", "만료일(선택)", "제목", "본문"].map((name) => {
      const field = within(form).getByLabelText(name);
      return { name, label: field.closest("label") };
    });
    expect(labels.map(({ name, label }) => [name, tokens(label).includes("text-[13px]"), tokens(label).includes("text-text-2")]))
      .toEqual(labels.map(({ name }) => [name, true, true]));
    expect(labels.filter(({ label }) => tokens(label).includes("text-xs")).map(({ name }) => name)).toEqual([]);

    // 고르기 상자는 감싼 칸(NativeSelect wrapper)이, 날짜·제목 입력은 입력 자신이 폭을 묶습니다(공용 Select와 같은 22rem).
    const capped = (element: Element | null) => tokens(element).includes("sm:max-w-[22rem]");
    expect([
      capped(within(form).getByLabelText("종류").parentElement),
      capped(within(form).getByLabelText("기준일(선택)")),
      capped(within(form).getByLabelText("만료일(선택)")),
      capped(within(form).getByLabelText("제목")),
    ]).toEqual([true, true, true, true]);
    expect(capped(within(form).getByLabelText("본문"))).toBe(false);
  });
});
