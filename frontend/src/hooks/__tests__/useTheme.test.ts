/**
 * useTheme — 테마 전환 훅의 규칙.
 *  - 저장값이 없으면 시스템 따름, <html>에 속성을 붙이지 않는다
 *  - 저장된 명시 선택은 마운트 때 다시 붙인다(dev Strict Mode 재마운트가 data-theme를 지운 경우)
 *  - 고르면 저장하고 <html data-theme>를 바꾸며, 시스템 따름은 키·속성을 지운다
 *  - 같은 탭의 다른 전환 단추와 다른 탭의 선택도 따라간다
 *  - 저장소가 막혀 있어도 이번 화면에는 적용하고, 단추 표시도 그 선택을 유지한다
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "@/hooks/useTheme";

const html = () => document.documentElement;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  html().removeAttribute("data-theme");
  window.localStorage.clear();
});

describe("useTheme", () => {
  it("저장값이 없으면 시스템 따름이고 속성을 붙이지 않는다", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("system");
    expect(html().hasAttribute("data-theme")).toBe(false);
  });

  it("저장된 다크를 마운트 때 다시 붙인다 — 인라인 스크립트가 붙인 값을 Strict Mode 재마운트가 지운 경우", () => {
    window.localStorage.setItem("theme", "dark");
    html().removeAttribute("data-theme"); // React가 <html> 속성을 JSX 값으로 되돌린 상태
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
    expect(html().getAttribute("data-theme")).toBe("dark");
  });

  it("고르면 저장하고 <html>에 적용하며, 시스템 따름은 키와 속성을 지운다", () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setTheme("light"));
    expect(result.current.theme).toBe("light");
    expect(window.localStorage.getItem("theme")).toBe("light");
    expect(html().getAttribute("data-theme")).toBe("light");

    act(() => result.current.setTheme("system"));
    expect(result.current.theme).toBe("system");
    expect(window.localStorage.getItem("theme")).toBeNull();
    expect(html().hasAttribute("data-theme")).toBe(false);
  });

  it("같은 탭의 다른 전환 단추도 바로 같은 선택을 보인다(왼쪽 내비와 더보기 화면)", () => {
    const first = renderHook(() => useTheme());
    const second = renderHook(() => useTheme());
    act(() => first.result.current.setTheme("dark"));
    expect(second.result.current.theme).toBe("dark");
  });

  it("다른 탭에서 바꾼 선택을 따라가고 이 탭의 <html>에도 적용한다", () => {
    const { result } = renderHook(() => useTheme());
    act(() => {
      window.localStorage.setItem("theme", "dark");
      window.dispatchEvent(new StorageEvent("storage", { key: "theme", newValue: "dark" }));
    });
    expect(result.current.theme).toBe("dark");
    expect(html().getAttribute("data-theme")).toBe("dark");

    act(() => {
      window.localStorage.removeItem("theme");
      window.dispatchEvent(new StorageEvent("storage", { key: "theme", newValue: null }));
    });
    expect(result.current.theme).toBe("system");
    expect(html().hasAttribute("data-theme")).toBe(false);
  });

  it("저장소가 막혀 있어도 던지지 않고 이번 화면에 적용하며, 단추 표시도 그 선택을 유지한다", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("SecurityError"); });
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setTheme("dark"));
    expect(result.current.theme).toBe("dark");
    expect(html().getAttribute("data-theme")).toBe("dark");

    act(() => result.current.setTheme("system"));
    expect(result.current.theme).toBe("system");
    expect(html().hasAttribute("data-theme")).toBe(false);

    // 저장소가 다시 되면 저장값을 따릅니다(막혔을 때 기억한 선택이 남지 않음).
    vi.restoreAllMocks();
    act(() => result.current.setTheme("light"));
    expect(window.localStorage.getItem("theme")).toBe("light");
    expect(result.current.theme).toBe("light");
  });
});
