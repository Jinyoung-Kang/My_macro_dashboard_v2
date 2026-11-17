/**
 * 미디어 질의가 맞는가(hooks/useMediaQuery). 맞는 질의만 참이고, 창 폭이 바뀌면(matchMedia change) 다시 그리며, matchMedia가 없으면 거짓이다.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useMediaQuery } from "../useMediaQuery";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NARROW = "(width < 48rem)";

/** 폭을 바꿀 수 있는 matchMedia 대역 — NARROW 질의만 폭에 따라 맞고, change 듣는 쪽을 모아 둡니다. */
function stubMedia(initialNarrow: boolean) {
  let narrow = initialNarrow;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return narrow && query === NARROW;
    },
    media: query,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  return {
    resize(next: boolean) {
      narrow = next;
      listeners.forEach((listener) => listener());
    },
    listeners,
  };
}

describe("useMediaQuery", () => {
  it("맞는 질의면 참, 다른 질의는 거짓 — 창 폭이 바뀌면 따라가고, 그만 그리면 듣기를 멈춘다", () => {
    const media = stubMedia(true);
    const { result, unmount } = renderHook(() => useMediaQuery(NARROW));
    const other = renderHook(() => useMediaQuery("(width >= 80rem)"));
    expect(result.current).toBe(true);
    expect(other.result.current).toBe(false);
    act(() => media.resize(false));
    expect(result.current).toBe(false);
    act(() => media.resize(true));
    expect(result.current).toBe(true);
    unmount();
    other.unmount();
    expect(media.listeners.size).toBe(0);
  });

  it("matchMedia가 없으면 거짓(던지지 않음)", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(() => useMediaQuery(NARROW));
    expect(result.current).toBe(false);
  });
});
