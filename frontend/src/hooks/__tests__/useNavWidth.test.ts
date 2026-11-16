/**
 * 넓은 화면 왼쪽 메뉴의 펼친 폭(hooks/useNavWidth — 작업대 실행 명세 §5 '가변 폭 왼쪽 메뉴'). 보는 사람별 편의라 이 브라우저의 저장소(키 shell.navWidth,
 * 정수 글)에 두고, 읽은 값은 검사해 180~320으로 자르며(손댄 값·다른 꼴은 기본 220), 저장소를 못 써도(읽기·쓰기가 던짐) 화면은 기본 폭으로 그려지고 이 창
 * 안에서는 바뀐다. 끄는 동안의 값(persist: false)은 저장소에 쓰지 않는다. 다른 탭에서 바꾸면(storage 이벤트) 따라간다.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NAV_WIDTH_STORAGE_KEY, resetNavWidthForTest, useNavWidth } from "../useNavWidth";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetNavWidthForTest();
});

describe("폭 기억", () => {
  it("저장값이 없으면 기본 220, 바꾸면 정수 글로 저장하고 같은 값을 보는 다른 곳도 함께 바뀐다", () => {
    expect(NAV_WIDTH_STORAGE_KEY).toBe("shell.navWidth");
    const first = renderHook(() => useNavWidth());
    const second = renderHook(() => useNavWidth());
    expect(first.result.current[0]).toBe(220);

    act(() => first.result.current[1](262.4));
    expect(first.result.current[0]).toBe(262);
    expect(second.result.current[0]).toBe(262);
    expect(window.localStorage.getItem("shell.navWidth")).toBe("262");
  });

  it("하한·상한 밖은 잘라서 둔다", () => {
    const { result } = renderHook(() => useNavWidth());
    act(() => result.current[1](40));
    expect(result.current[0]).toBe(180);
    act(() => result.current[1](999));
    expect(result.current[0]).toBe(320);
    expect(window.localStorage.getItem("shell.navWidth")).toBe("320");
  });

  it("저장값은 검사해서 읽는다 — '280'은 280, '1000'은 320, '50'은 180, 다른 꼴('wide'·'260px'·'-1')은 기본 220", () => {
    const cases: [string, number][] = [["280", 280], ["1000", 320], ["50", 180], ["wide", 220], ["260px", 220], ["-1", 220]];
    for (const [stored, expected] of cases) {
      window.localStorage.setItem("shell.navWidth", stored);
      resetNavWidthForTest();
      const { result, unmount } = renderHook(() => useNavWidth());
      expect(result.current[0]).toBe(expected);
      unmount();
    }
  });

  it("persist: false(끄는 동안)는 이 창에만 두고 저장소에 쓰지 않는다 — 그다음 저장하는 바꾸기가 쓴다", () => {
    window.localStorage.setItem("shell.navWidth", "240");
    const { result } = renderHook(() => useNavWidth());
    act(() => result.current[1](300, { persist: false }));
    expect(result.current[0]).toBe(300);
    expect(window.localStorage.getItem("shell.navWidth")).toBe("240");
    act(() => result.current[1](300));
    expect(window.localStorage.getItem("shell.navWidth")).toBe("300");
  });
});

describe("저장소를 못 쓸 때", () => {
  it("읽기가 던지면 기본 폭으로 시작하고, 쓰기가 던져도 이 창 안에서는 바뀐다", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("막힌 저장소");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("막힌 저장소");
    });
    const { result } = renderHook(() => useNavWidth());
    expect(result.current[0]).toBe(220);
    act(() => result.current[1](288));
    expect(result.current[0]).toBe(288);
  });
});

describe("다른 탭", () => {
  it("storage 이벤트(같은 키)를 검사해 따라가고, 다른 키는 무시하며, 저장소를 통째로 지우면(key null) 기본 폭으로", () => {
    const { result } = renderHook(() => useNavWidth());
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "shell.navWidth", newValue: "300" }));
    });
    expect(result.current[0]).toBe(300);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "shell.navWidth", newValue: "5000" }));
    });
    expect(result.current[0]).toBe(320);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "shell.navCollapsed", newValue: "1" }));
    });
    expect(result.current[0]).toBe(320);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: null, newValue: null }));
    });
    expect(result.current[0]).toBe(220);
  });
});
