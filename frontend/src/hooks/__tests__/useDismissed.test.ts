/**
 * useDismissed — 닫은 안내의 키를 이 브라우저 저장소에 두는 훅. 고정하는 규칙
 *  - 저장소에 있던 키를 읽고, 닫으면 합쳐서 저장한다(같은 키는 한 번)
 *  - 저장소의 값이 깨졌거나 목록이 아니면 아무것도 닫지 않은 것으로 본다
 *  - 저장소를 쓸 수 없어도(사생활 보호 창 등) 이 창 안에서는 닫힌 채로 둔다
 *  - 200개까지만 남긴다(가장 오래된 것부터 버림)
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDismissed } from "@/hooks/useDismissed";

const KEY = "test.dismissed";

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("useDismissed", () => {
  it("저장소의 키를 읽고, 닫은 키를 합쳐 저장한다(같은 키는 한 번)", () => {
    window.localStorage.setItem(KEY, JSON.stringify(["a", "b"]));
    const { result } = renderHook(() => useDismissed(KEY));
    expect(result.current[0]).toEqual(["a", "b"]);

    act(() => result.current[1](["b", "c"]));

    expect(result.current[0]).toEqual(["a", "b", "c"]);
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "[]")).toEqual(["a", "b", "c"]);
  });

  it("저장소의 값이 깨졌거나 목록이 아니면 아무것도 닫지 않은 것으로 본다", () => {
    window.localStorage.setItem(KEY, "{깨진 JSON");
    expect(renderHook(() => useDismissed(KEY)).result.current[0]).toEqual([]);

    window.localStorage.setItem(KEY, JSON.stringify({ a: 1 }));
    expect(renderHook(() => useDismissed(KEY)).result.current[0]).toEqual([]);

    window.localStorage.setItem(KEY, JSON.stringify(["a", 3, null, "b"]));
    expect(renderHook(() => useDismissed(KEY)).result.current[0]).toEqual(["a", "b"]);
  });

  it("저장소를 쓸 수 없어도 이 창 안에서는 닫힌 채로 둔다", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("막힘"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("막힘"); });
    const { result } = renderHook(() => useDismissed(KEY));
    expect(result.current[0]).toEqual([]);

    act(() => result.current[1](["a"]));

    expect(result.current[0]).toEqual(["a"]);
  });

  it("200개까지만 남긴다 — 가장 오래된 것부터 버린다", () => {
    const old = Array.from({ length: 200 }, (_, index) => `k${index}`);
    window.localStorage.setItem(KEY, JSON.stringify(old));
    const { result } = renderHook(() => useDismissed(KEY));

    act(() => result.current[1](["new-1", "new-2"]));

    expect(result.current[0]).toHaveLength(200);
    expect(result.current[0].slice(0, 1)).toEqual(["k2"]);
    expect(result.current[0].slice(-2)).toEqual(["new-1", "new-2"]);
  });
});
