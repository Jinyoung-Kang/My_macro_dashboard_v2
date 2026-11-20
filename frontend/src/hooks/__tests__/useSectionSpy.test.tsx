/**
 * useSectionSpy — 긴 화면 목차의 지금 절(IntersectionObserver 대역).
 *  - 뷰포트(root null)의 위 96px 아래 ~ 위쪽 34% 띠(rootMargin '-96px 0px -66% 0px' — QA-626)로 고르는 차례의 절 닻을 관찰한다
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
  it("뷰포트 위쪽 띠(위 96px 아래 ~ 34%)로 차례의 닻을 관찰하고, 걸친 것 가운데 차례가 가장 앞을 고른다 — 없으면 앞 값", () => {
    const made = stubObserver();
    anchors(["cat-a", "ind", "fx"]);
    const { result } = renderHook(() => useSectionSpy(["cat-a", "ind", "fx"]));
    expect(result.current).toBeNull();
    const [spy] = made;
    expect(spy.options).toEqual({ root: null, rootMargin: "-96px 0px -66% 0px" });
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
  it("띠의 위 끝이 뷰포트 위에서 96px 아래 — 가로 줄 밑에 가려진 앞 절 꼬리를 지금 절로 고르지 않는다", () => {
    const made = stubObserver();
    anchors(["a"]);
    renderHook(() => useSectionSpy(["a"]));
    const top = /^(-?\d+)px\b/.exec(made[0].options?.rootMargin ?? "")?.[1];
    expect(Number(top)).toBeLessThanOrEqual(-96);
  });
});

// QA-968(작업대 P8 후속 — `section-spy-history-back`): 지금 절은 띠에 걸친 절이 없으면 앞 값을 그대로 두어, 목차로 옮긴 절에서 뒤로 가기로 화면 맨 위(첫 절이
// 띠 아래)에 돌아와도 옮긴 절이 지금 칸으로 남았습니다 — 기준 빌드(40a8b4cf, QA API GET) /macro 390×844에서 목차 '신용·변동성'을 누른 뒤 뒤로 가기:
// 주소 /macro·scrollY 0·첫 절(지표) 위 끝 509px(띠 아래 끝 287px 아래)인데 가로 줄의 지금 칸이 '#macro-risk'. 같은 자리를 처음 열면 지금 칸이 없습니다.
// 모든 절이 띠 아래면(첫 절에 닿기 전) 처음 연 화면과 같이 지금 칸이 없어야 합니다. 절 사이 빈 곳(위에 지나간 절이 있음)은 앞 값 그대로입니다.
describe("QA-968 화면 맨 위(모든 절이 띠 아래)로 돌아오면 지금 절이 없다", () => {
  /** 절 닻의 뷰포트 위 끝(px)을 정합니다 — jsdom은 배치를 계산하지 않음. */
  function placeAt(tops: Record<string, number>) {
    for (const [id, top] of Object.entries(tops)) {
      const element = document.getElementById(id) as HTMLElement;
      element.getBoundingClientRect = () => ({ top, bottom: top + 400, left: 0, right: 0, width: 0, height: 400, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    }
  }

  // 수정 전(재현 커밋에서는 it.fails)에는 옮긴 절이 남았습니다(expected 'risk' to be null).
  it.fails("옮긴 절이 띠를 떠나고 모든 절의 위 끝이 띠(창 높이의 34%) 아래면 null — 처음 연 화면과 같음", () => {
    const made = stubObserver();
    anchors(["ind", "fx", "risk"]);
    const { result } = renderHook(() => useSectionSpy(["ind", "fx", "risk"]));
    placeAt({ ind: -6000, fx: -3000, risk: 57 });
    fire(made[0], [["risk", true]]);
    expect(result.current).toBe("risk");
    // 뒤로 가기로 맨 위 — 첫 절 위 끝이 띠 아래(창 높이 768의 34% = 261px 아래).
    placeAt({ ind: 509, fx: 3846, risk: 7151 });
    fire(made[0], [["risk", false]]);
    expect(result.current).toBeNull();
  });
});
