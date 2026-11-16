/**
 * useSectionSpy — 긴 화면 목차의 지금 절(IntersectionObserver 대역).
 *  - 뷰포트(root null)의 위쪽 34% 띠(rootMargin '0px 0px -66% 0px')로 고르는 차례의 절 닻을 관찰한다
 *  - 걸친 절 가운데 차례가 가장 앞(하위 칸이 부모보다 앞 — lib/sectionIndex), 걸친 것이 없으면 앞 값
 *  - enabled가 거짓이거나 IntersectionObserver가 없으면 null, 언마운트·목록이 바뀌면 관찰을 끊는다
 */
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useSectionSpy } from "../useSectionSpy";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Spy = { callback: IntersectionObserverCallback; options?: IntersectionObserverInit; observed: Element[]; disconnected: boolean };

function stubObserver(): Spy[] {
  const made: Spy[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private readonly spy: Spy;
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.spy = { callback, options, observed: [], disconnected: false };
        made.push(this.spy);
      }
      observe(element: Element) {
        this.spy.observed.push(element);
      }
      unobserve() {}
      disconnect() {
        this.spy.disconnected = true;
      }
    },
  );
  return made;
}

function anchors(ids: string[]) {
  render(
    <>
      {ids.map((id) => (
        <div key={id} id={id} />
      ))}
    </>,
  );
}

function fire(spy: Spy, entries: [string, boolean][]) {
  act(() =>
    spy.callback(
      entries.map(([id, isIntersecting]) => ({ target: document.getElementById(id), isIntersecting }) as unknown as IntersectionObserverEntry),
      {} as IntersectionObserver,
    ),
  );
}

describe("useSectionSpy", () => {
  it("뷰포트 위쪽 34% 띠로 차례의 닻을 관찰하고, 걸친 것 가운데 차례가 가장 앞을 고른다 — 없으면 앞 값", () => {
    const made = stubObserver();
    anchors(["cat-a", "ind", "fx"]);
    const { result } = renderHook(() => useSectionSpy(["cat-a", "ind", "fx"]));
    expect(result.current).toBeNull();
    const [spy] = made;
    expect(spy.options).toEqual({ root: null, rootMargin: "0px 0px -66% 0px" });
    expect(spy.observed.map((element) => element.id)).toEqual(["cat-a", "ind", "fx"]);

    fire(spy, [["ind", true], ["cat-a", true]]);
    expect(result.current).toBe("cat-a");
    fire(spy, [["cat-a", false]]);
    expect(result.current).toBe("ind");
    fire(spy, [["ind", false]]);
    expect(result.current).toBe("ind");
    fire(spy, [["fx", true]]);
    expect(result.current).toBe("fx");
  });

  it("없는 닻은 건너뛰고, 같은 목록이면 새 배열로 다시 그려도 관찰을 새로 걸지 않는다 — 목록이 바뀌면 끊고 다시", () => {
    const made = stubObserver();
    anchors(["a", "b"]);
    const { rerender, unmount } = renderHook(({ ids }) => useSectionSpy(ids), { initialProps: { ids: ["a", "missing", "b"] } });
    expect(made).toHaveLength(1);
    expect(made[0].observed.map((element) => element.id)).toEqual(["a", "b"]);
    rerender({ ids: ["a", "missing", "b"] });
    expect(made).toHaveLength(1);
    rerender({ ids: ["a"] });
    expect(made[0].disconnected).toBe(true);
    expect(made).toHaveLength(2);
    unmount();
    expect(made[1].disconnected).toBe(true);
  });

  it("enabled가 거짓이면 관찰하지 않고 null, IntersectionObserver가 없으면(jsdom 기본) null", () => {
    const made = stubObserver();
    anchors(["a"]);
    const off = renderHook(() => useSectionSpy(["a"], false));
    expect(made).toHaveLength(0);
    expect(off.result.current).toBeNull();
    off.unmount();
    vi.unstubAllGlobals();
    expect(typeof globalThis.IntersectionObserver).toBe("undefined");
    const none = renderHook(() => useSectionSpy(["a"]));
    expect(none.result.current).toBeNull();
  });
});
