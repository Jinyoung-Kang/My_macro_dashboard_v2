/**
 * 국면(/regime) 화면 — 국면 이력 띠·판정 근거·판정 기록·판정 성과의 뜻.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { regimeExpansion } from "@/lib/__tests__/homeFixtures";
import { endpoints } from "@/lib/endpoints";
import type { RegimeResponse } from "@/lib/types";
import RegimePage from "../regime/page";

/** 경로 → 응답(정확히 일치). 없는 경로는 끝나지 않는 요청(불러오는 중). */
let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = {};
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => cleanup());

const REGIME = endpoints.insight.regime("5");

/** 국면 응답 + 주간 재현 넷과 구간 셋(최근 순). */
function withHistory(): RegimeResponse {
  return {
    ...regimeExpansion(),
    timeline: [
      { date: "2026-10-22", code: "UNKNOWN", label: "판정 불가" },
      { date: "2026-10-29", code: "LATE", label: "후퇴 경계 (Late cycle)" },
      { date: "2026-11-05", code: "EXPANSION", label: "확장 (Expansion)" },
      { date: "2026-11-12", code: "EXPANSION", label: "확장 (Expansion)" },
    ],
    episodes: [
      { code: "EXPANSION", label: "확장 (Expansion)", start: "2026-11-05", end: "2026-11-12", weeks: 2 },
      { code: "LATE", label: "후퇴 경계 (Late cycle)", start: "2026-10-29", end: "2026-10-29", weeks: 1 },
      { code: "UNKNOWN", label: "판정 불가", start: "2026-10-22", end: "2026-10-22", weeks: 1 },
    ],
  };
}

describe("QA-635 국면 이력 띠·범례 견본이 고대비에서 남는다", () => {
  // 수정 전에는 띠의 칸과 범례 견본을 바탕색(bg-ok/70 등)으로만 그려, 고대비(forced-colors)에서 바탕색이 지워지면 띠와 견본이 통째로 사라졌습니다
  // (D1 QA '바탕색만으로 그린 모양'의 국면 몫). 띠는 이름 없는 칸 259개라 낭독기에는 아무 뜻도 전하지 못했습니다.
  it.fails("띠는 이름 있는 그림(기간·구간 수)이고 칸은 읽기에서 빠지며, 띠와 범례 견본은 고대비에서도 색 그대로", async () => {
    reads[REGIME] = withHistory();
    render(<RegimePage />);

    const band = await screen.findByRole("img", { name: /국면 이력 띠/ });
    expect(band.getAttribute("aria-label")).toBe("국면 이력 띠 — 2026-10-22 ~ 2026-11-12, 주간 판정 4번·구간 3개(최근 구간은 아래 표)");
    expect(band.className).toContain("forced-color-adjust-none");
    const cells = Array.from(band.children);
    expect(cells).toHaveLength(4);
    expect(cells.every((cell) => cell.getAttribute("aria-hidden") === "true")).toBe(true);

    const legend = screen.getByRole("list", { name: "국면 이력 띠 범례" });
    const swatches = Array.from(legend.querySelectorAll("[data-band-swatch]"));
    // 네 국면 + 판정 불가.
    expect(swatches).toHaveLength(5);
    for (const swatch of swatches) {
      expect(swatch.getAttribute("aria-hidden")).toBe("true");
      expect(swatch.className).toContain("forced-color-adjust-none");
    }
    expect(within(legend).getByText("판정 불가")).toBeTruthy();
  });
});
