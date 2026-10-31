/**
 * 유료 등급 표시 — 잠금은 이모지 글자가 아니라 잠금 아이콘. 혼자 뜻을 나르는 자리(판정 성과 안내)는 이름 있는 그림
 * ('유료 등급 기능'), 옆의 글이 뜻을 나르는 자리(판정 기록의 '무료 등급은 최근 N건')는 장식 아이콘.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { endpoints } from "@/lib/endpoints";
import { RegimeLogSection } from "../regime/RegimeLogSection";
import { TrackRecordSection } from "../regime/TrackRecordSection";

function answer(bodies: Record<string, unknown>) {
  api.apiGetShared.mockImplementation((path: string) =>
    path in bodies ? Promise.resolve(bodies[path]) : new Promise(() => {}));
}

beforeEach(() => {
  api.apiGetShared.mockReset();
});
afterEach(() => cleanup());

const PICTOGRAPH = /\p{Extended_Pictographic}/u;

describe("유료 등급 표시", () => {
  it("판정 성과가 잠겼으면 안내 배너 + 이름 있는 잠금 그림('유료 등급 기능'), 글에는 기호가 없다", async () => {
    answer({
      [endpoints.insight.regimeTrackRecord("SPY")]: {
        available: false, locked: true, message: "판정 성과는 유료 등급 기능입니다.", asset: "SPY", assets: [], horizons: [], limits: [],
      },
    });
    render(<TrackRecordSection tone={{}} />);

    const message = await screen.findByText("판정 성과는 유료 등급 기능입니다.");
    const banner = message.closest("div")?.parentElement as HTMLElement;
    expect(banner.className).toContain("bg-accent-tint");
    expect(screen.getByRole("img", { name: "유료 등급 기능" })).toBeTruthy();
    expect(banner.textContent).not.toMatch(PICTOGRAPH);
  });

  it("판정 기록이 무료 등급이라 잘렸으면 장식 잠금 아이콘 + 안내 글", async () => {
    answer({
      [endpoints.insight.regimeLog(60)]: { available: true, count: 1, limitedTo: 30, entries: [] },
    });
    render(<RegimeLogSection tone={{}} />);

    const note = await screen.findByText("무료 등급은 최근 30건만 보입니다. 유료 등급은 기록 전체를 봅니다.");
    const line = note.parentElement as HTMLElement;
    expect(line.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("img", { name: "유료 등급 기능" })).toBeNull();
    expect(line.textContent).not.toMatch(PICTOGRAPH);
  });
});
