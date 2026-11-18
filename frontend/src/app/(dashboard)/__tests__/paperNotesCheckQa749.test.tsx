/**
 * QA-749 — 모의 메모 탭의 '만료한 메모도 보기' 체크 상자가 좁은 화면(lg 미만)에서 44px 누름 자리가 아님(진행 기록 넘긴 항목
 * `touch-targets-lt-lg-missed-by-qa458`의 '메모 체크' 몫).
 *
 * 체크 상자를 감싼 label이 글 높이(12px 글)뿐이라 손가락으로 누르기 어렵습니다(원칙 A8). jsdom은 배치를 재지 않으므로 공용 누름 자리 감사
 * (lib/__tests__/touchTargetAudit `smallTargets` — 체크 상자는 감싼 label의 클래스까지 봄)로 따집니다. 두 시장 모두 같은 섹션입니다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { smallTargets } from "@/lib/__tests__/touchTargetAudit";

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
    "/api/paper/overview?market=KR": { ...OVERVIEW, market: "KR", currency: "KRW", dormantReason: null },
    "/api/paper/notes?includeExpired=false": { available: true, referenceDate: "2026-10-26", notes: [] },
    "/api/paper/notes?includeExpired=false&market=KR": { available: true, market: "KR", referenceDate: "2026-10-28", notes: [] },
    "/api/paper/settings": { available: true, version: 1, body: {}, defaults: {}, keys: [] },
  };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => cleanup());

describe("QA-749 메모 탭 '만료한 메모도 보기'는 좁은 화면에서 44px 누름 자리", () => {
  it.fails.each([["US"], ["KR"]] as const)("%s", async (market) => {
    if (market === "KR") window.history.replaceState(null, "", "/paper/kr/notes");
    render(<PaperPage initialTab="notes" market={market} />);
    const check = await screen.findByLabelText("만료한 메모도 보기");
    const label = check.closest("label") as HTMLElement;
    expect(label).not.toBeNull();
    expect(smallTargets(label.parentElement as HTMLElement)).toEqual([]);
  });
});
