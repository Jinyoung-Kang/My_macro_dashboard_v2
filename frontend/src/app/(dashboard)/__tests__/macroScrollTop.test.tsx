/**
 * 매크로 화면(/macro)의 맨 위로(TOP) 단추 — 사용자 요구(2026-11-18). 공용 단추(components/ScrollTopButton — 모의 매매·정보 검색·정보 수집과 같음)를
 * 화면에 두었는지만 봅니다. 나타나는 문턱·누르면 올리는 동작·포커스는 components/__tests__/ScrollTopButton*.test.tsx가 봅니다.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import MacroPage from "../macro/page";

beforeEach(() => {
  // 자료는 오지 않아도 됩니다(단추는 자료와 상관없음) — 모든 요청을 끝나지 않게.
  api.apiGetShared.mockImplementation(() => new Promise(() => {}));
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true, writable: true });
});
afterEach(() => cleanup());

describe("매크로 화면 TOP 단추", () => {
  it("맨 위에서는 없고, 창이 400px 넘게 내려가면 오른쪽 아래 기본 층(z-40) 단추가 나타난다", () => {
    render(<MacroPage />);
    expect(screen.queryByRole("button", { name: "TOP 맨 위로" })).toBeNull();

    act(() => {
      (window as { scrollY: number }).scrollY = 900;
      window.dispatchEvent(new Event("scroll"));
    });

    const top = screen.getByRole("button", { name: "TOP 맨 위로" });
    expect(top.className).toContain("fixed");
    expect(top.className).toContain("z-40");
    // 목차(가로 줄·세로 목록) 안이 아니라 화면 끝에 따로 — 목차의 sticky 줄과 겹치지 않는 자리.
    expect(top.closest("nav")).toBeNull();
  });
});
