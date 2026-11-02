/**
 * 매크로 자동 갱신 간격(AutoRefresh) — 고정하는 규칙
 *  - 선택지는 끄기·5초~30분·1시간·3시간(사용자 결정 2026-11-01, 5초는 실시간 시세 2단계 2026-11-03). '실시간'은 없다
 *  - 고른 간격은 이 브라우저에 기억되고, 다시 열면 첫 요청부터 그 간격이다(저장된 3600·10800이 살아남음)
 *  - 1분보다 긴 간격은 live 없이 읽고, 고른 간격마다 다시 읽는다
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import MacroPage from "../macro/page";
import { REFRESH_OPTIONS } from "@/components/AutoRefresh";
import { LIVE_SECONDS_OPTIONS } from "@/lib/livePrices";

const OVERVIEW = "/api/macro/overview";
const OVERVIEW_LIVE = "/api/macro/overview?live=true";

function calls(path: string) {
  return api.apiGetShared.mock.calls.filter(([called]) => called === path).length;
}

async function settle(ms = 1) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  window.localStorage.clear();
  api.apiGetShared.mockReset();
  // 매크로 카드만 답하고 나머지(위험·심화·환율 비교 등)는 끝나지 않는 요청.
  api.apiGetShared.mockImplementation((path: string) =>
    path.startsWith(OVERVIEW) ? Promise.resolve({ available: true, categories: [] }) : new Promise(() => {}));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("매크로 자동 갱신 간격", () => {
  it("선택지는 끄기·5초~30분 뒤에 1시간·3시간 — 모두 실시간 시세 주기(서버 목록)에 있는 값", async () => {
    render(<MacroPage />);
    await settle();
    const select = screen.getByLabelText("자동 갱신 간격") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(
      ["끄기", "5초", "10초", "30초", "1분", "5분", "10분", "30분", "1시간", "3시간"]);
    const serverIntervals = new Set(LIVE_SECONDS_OPTIONS.map((option) => option.value));
    expect(REFRESH_OPTIONS.every((option) => serverIntervals.has(option.value))).toBe(true);
  });

  it("3시간을 고르면 기억하고 live 없이 세 시간마다 다시 읽는다", async () => {
    render(<MacroPage />);
    await settle();
    expect(calls(OVERVIEW_LIVE)).toBe(1);   // 기본 1분은 live

    fireEvent.change(screen.getByLabelText("자동 갱신 간격"), { target: { value: "10800" } });
    await settle();
    expect(window.localStorage.getItem("macro.autoRefreshSeconds")).toBe("10800");
    expect(calls(OVERVIEW)).toBe(1);

    await settle(3 * 3_600_000 - 60_000);
    expect(calls(OVERVIEW)).toBe(1);
    await settle(60_000);
    expect(calls(OVERVIEW)).toBe(2);
    expect(calls(OVERVIEW_LIVE)).toBe(1);
  });

  it("저장된 1시간으로 다시 열면 첫 요청부터 live 없이 읽는다", async () => {
    window.localStorage.setItem("macro.autoRefreshSeconds", "3600");
    render(<MacroPage />);
    await settle();

    expect((screen.getByLabelText("자동 갱신 간격") as HTMLSelectElement).value).toBe("3600");
    expect(calls(OVERVIEW_LIVE)).toBe(0);
    expect(calls(OVERVIEW)).toBe(1);
    await settle(3_600_000);
    expect(calls(OVERVIEW)).toBe(2);
  });
});
