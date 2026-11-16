/**
 * 넓은 화면 왼쪽 메뉴의 접힘(hooks/useNavCollapsed — 작업대 실행 명세 §5). 보는 사람별 편의라 이 브라우저의 저장소(키 shell.navCollapsed, "1"/"0")에 두고,
 * 저장소를 못 써도(읽기·쓰기가 던짐) 화면은 그대로 동작한다. 다른 탭에서 바꾸면(storage 이벤트) 따라간다.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NAV_COLLAPSED_STORAGE_KEY, resetNavCollapsedForTest, useNavCollapsed } from "../useNavCollapsed";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetNavCollapsedForTest();
});

describe("접힘 기억", () => {
  it("저장값이 없으면 펼침, 접고 펴면 '1'·'0'으로 저장한다", () => {
    expect(NAV_COLLAPSED_STORAGE_KEY).toBe("shell.navCollapsed");
    const { result } = renderHook(() => useNavCollapsed());
    expect(result.current[0]).toBe(false);

    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    expect(window.localStorage.getItem("shell.navCollapsed")).toBe("1");

    act(() => result.current[1]());
    expect(result.current[0]).toBe(false);
    expect(window.localStorage.getItem("shell.navCollapsed")).toBe("0");
  });

  it("저장값 '1'이면 접힌 채 시작하고, 같은 값을 보는 다른 곳(셸 뿌리·왼쪽 메뉴)도 함께 바뀐다", () => {
    window.localStorage.setItem("shell.navCollapsed", "1");
    const first = renderHook(() => useNavCollapsed());
    const second = renderHook(() => useNavCollapsed());
    expect(first.result.current[0]).toBe(true);
    act(() => first.result.current[1]());
    expect(second.result.current[0]).toBe(false);
  });

  it("모르는 저장값은 펼침으로 읽는다", () => {
    window.localStorage.setItem("shell.navCollapsed", "yes");
    const { result } = renderHook(() => useNavCollapsed());
    expect(result.current[0]).toBe(false);
  });
});

describe("저장소를 못 쓸 때", () => {
  it("읽기가 던지면 펼침으로 시작하고, 쓰기가 던져도 이 창 안에서는 접고 편다", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("막힌 저장소");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("막힌 저장소");
    });
    const { result } = renderHook(() => useNavCollapsed());
    expect(result.current[0]).toBe(false);
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    act(() => result.current[1]());
    expect(result.current[0]).toBe(false);
  });
});

describe("다른 탭", () => {
  it("storage 이벤트(같은 키)를 따라가고, 다른 키는 무시하며, 저장소를 통째로 지우면(key null) 펼침으로", () => {
    const { result } = renderHook(() => useNavCollapsed());
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "shell.navCollapsed", newValue: "1" }));
    });
    expect(result.current[0]).toBe(true);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "shell.palette.recent", newValue: "{}" }));
    });
    expect(result.current[0]).toBe(true);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: null, newValue: null }));
    });
    expect(result.current[0]).toBe(false);
  });
});
