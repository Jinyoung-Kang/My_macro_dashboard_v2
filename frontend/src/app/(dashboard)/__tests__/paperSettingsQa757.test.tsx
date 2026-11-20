/**
 * QA-757 — 모의 설정 탭의 참·거짓 키 체크 상자 누름 자리(진행 기록 넘긴 항목 `touch-targets-lt-lg-missed-by-qa458`의 '모의 설정 체크 label 폭 35px·
 * 넓은 화면 20px'). 상자를 감싼 label(상자 13px + 간격 8px + '예' 14px)이 좁은 화면(lg 미만)에서 높이는 44px(QA-458)이지만 폭이 35px이고, 넓은 화면(lg 이상)은
 * min-h-0이라 글 줄 높이 20px — 표 안 작은 조작 24px(명세 §3-7, WCAG 2.5.8)에 못 미칩니다. jsdom은 배치를 재지 않으므로 클래스로 봅니다(touchTargetAudit와 같은
 * 방식): lg 미만 폭 44px 이상(min-w-11 등), lg 이상 높이 24px 이상(lg:min-h-6 등). 값은 합성 값입니다.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  MultiLineSeries: () => null,
}));

import PaperPage from "@/components/screens/paper/PaperScreen";

let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = {
    "/api/paper/overview": {
      available: true, initialized: true, startDate: "2026-10-23", limits: [], jobs: [], pendingBackfill: [], books: [],
      navSeries: { dates: [], books: {} }, quotes: null, selection: null, gate: null,
    },
    "/api/paper/settings/history": { available: true, history: [] },
    "/api/paper/settings": {
      available: true, version: 1, body: { parkCashInShy: true }, defaults: { parkCashInShy: true },
      keys: [{ key: "parkCashInShy", type: "boolean", min: null, max: null, affectsRules: true, description: "남는 현금을 SHY에" }],
    },
  };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => cleanup());

/** 변형 없는(모든 폭) 또는 주어진 변형 하나의 크기 유틸리티 px — min-w·w·size(폭) / min-h·h·size(높이). 간격 단위 4px, 임의 값은 px·rem. */
function sizePx(classes: string, axis: "w" | "h", variant: "" | "lg"): number {
  let best = 0;
  for (const token of classes.split(/\s+/)) {
    const [prefix, utility] = token.includes(":") ? [token.slice(0, token.lastIndexOf(":")), token.slice(token.lastIndexOf(":") + 1)] : ["", token];
    if (prefix !== variant) continue;
    const match = new RegExp(`^(?:min-${axis}|${axis}|size)-(?:(\\d+(?:\\.\\d+)?)|\\[(\\d+(?:\\.\\d+)?)(px|rem)\\])$`).exec(utility);
    if (!match) continue;
    const px = match[1] !== undefined ? Number(match[1]) * 4 : Number(match[2]) * (match[3] === "rem" ? 16 : 1);
    best = Math.max(best, px);
  }
  return best;
}

describe("QA-757 모의 설정 참·거짓 체크 상자 누름 자리", () => {
  it("감싼 label — lg 미만 폭 44px 이상, lg 이상 높이 24px 이상", async () => {
    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "설정" }));
    const checkbox = (await screen.findByLabelText("parkCashInShy")) as HTMLInputElement;
    const label = checkbox.closest("label") as HTMLLabelElement;
    expect(label).not.toBeNull();
    const classes = label.getAttribute("class") ?? "";
    expect(sizePx(classes, "h", "")).toBeGreaterThanOrEqual(44);
    expect(sizePx(classes, "w", "")).toBeGreaterThanOrEqual(44);
    // lg 이상은 변형이 높이를 정합니다(lg:min-h-0이면 글 줄 20px) — lg 변형이 없으면 변형 없는 값이 그대로 남음.
    const lgHeight = /(^|\s)lg:(min-h|h)-/.test(classes) ? sizePx(classes, "h", "lg") : sizePx(classes, "h", "");
    expect(lgHeight).toBeGreaterThanOrEqual(24);
  });
});
