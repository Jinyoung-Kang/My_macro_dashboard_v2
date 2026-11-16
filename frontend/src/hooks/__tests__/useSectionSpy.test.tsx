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

// QA-626: 띠가 뷰포트 맨 위(0px)부터라, 목차 칸을 눌러 절로 옮기면(절 닻의 scroll-margin — 가로 줄 밑 56px) 앞 절의 꼬리가 위에 붙은 가로 목차
// 줄(좁은 화면 44px·1024 30px — 1024는 상단바 48px 아래) 밑에 가려진 채 띠에 걸려, 차례가 앞인 앞 절이 지금 절로 골렸습니다. 매크로 자기 빌드에서
// '신용·변동성'을 누르면 가로 줄의 지금 칸이 '장단기 금리차'(390 — 절 위 끝 56px·가로 줄 아래 끝 45px·앞 절 꼬리 ~40px, 1024 — 104·79·~80px),
// '심화 지표'는 '신용·변동성', '비공식 시세'는 '단독 차트'였습니다(1440 세로 목록은 본문 스크롤 상자가 앞 절을 잘라 맞음). 띠는 위에 붙은 줄과
// 상단바 아래(96px)부터 봐야 합니다.
describe("QA-626 지금 절 띠는 위에 붙은 상단바·가로 목차 줄 아래에서 시작한다", () => {
  it.fails("띠의 위 끝이 뷰포트 위에서 96px 아래 — 가로 줄 밑에 가려진 앞 절 꼬리를 지금 절로 고르지 않는다", () => {
    const made = stubObserver();
    anchors(["a"]);
    renderHook(() => useSectionSpy(["a"]));
    const top = /^(-?\d+)px\b/.exec(made[0].options?.rootMargin ?? "")?.[1];
    expect(Number(top)).toBeLessThanOrEqual(-96);
  });
});
