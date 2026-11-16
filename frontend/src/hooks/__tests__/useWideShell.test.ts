/**
 * 넓은 화면인가(hooks/useWideShell — lib/shellCommands WIDE_SHELL_MEDIA, lg 64rem). 창 폭이 바뀌면(matchMedia change) 다시 그리고,
 * matchMedia가 없으면 거짓이다.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";

import { useWideShell } from "../useWideShell";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 폭을 바꿀 수 있는 matchMedia 대역 — change 듣는 쪽을 모아 둡니다. */
function stubMedia(initial: boolean) {
  let wide = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return wide && query === WIDE_SHELL_MEDIA;
    },
    media: query,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  return {
    resize(next: boolean) {
      wide = next;
      listeners.forEach((listener) => listener());
    },
    listeners,
  };
}

describe("useWideShell", () => {
  it("넓은 화면이면 참, 창 폭이 바뀌면 따라가고, 그만 그리면 듣기를 멈춘다", () => {
    const media = stubMedia(true);
    const { result, unmount } = renderHook(() => useWideShell());
    expect(result.current).toBe(true);
    act(() => media.resize(false));
    expect(result.current).toBe(false);
    act(() => media.resize(true));
    expect(result.current).toBe(true);
    unmount();
    expect(media.listeners.size).toBe(0);
  });

  it("matchMedia가 없으면 거짓(던지지 않음)", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(() => useWideShell());
    expect(result.current).toBe(false);
  });
});
