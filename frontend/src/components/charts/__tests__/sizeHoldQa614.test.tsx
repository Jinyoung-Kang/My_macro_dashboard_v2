/**
 * QA-614 — 차트 폭 고정(QA-601의 charts/sizeHold ChartSizeHold)을 풀 때, 차트가 새 폭으로 다시 그려질 때까지 앞 폭 그대로 열 밖으로 그려지던 것.
 *
 * 셸 신호(lib/shellResize)가 꺼지면 useLayoutEffect의 setHeld(null)가 안쪽 상자의 px 폭과 바깥 상자의 overflow-x: clip을 한 커밋(그리기 전)에 함께
 * 걷어 냈습니다. Recharts 3.10.1 ResponsiveContainer는 새 폭을 크기 감시(ResizeObserver) 콜백에서야 알고 setSizes로 알리는데, 이 갱신은 기본
 * 우선순위라 다음 그리기 뒤에 다시 그립니다. 그 안쪽 div는 넘침이 보이므로 그동안 앞 폭의 차트가 잘리지 않고 그려졌습니다 — QA 스택(qa@266fe3f4)
 * 1024 /macro 끌기 220→320을 놓을 때 706px 차트가 606px 열 위에 약 125~160ms, /liquidity 작은 차트(열 191·앞 폭 225)는 옆 차트의 축 글자 위로
 * 33.7px을 약 85ms, 레일 펼치기는 1440 /macro +60px 약 140ms·1024 +172px 약 120ms. 신호를 켜지 않고 폭이 한 번에 바뀔 때(손잡이 End 키·움직임
 * 줄이기의 접고 펴기·창 크기)도 같은 일이 QA-601 전부터 있었습니다.
 *
 * jsdom에는 배치가 없어 두 폭을 대역으로 둡니다 — `column`(바깥 상자의 폭 = 쉬는 안쪽 상자의 폭)과 `content`(차트가 지금 그려진 폭 — 크기 감시가
 * 다시 그려야 바뀜). 안쪽 상자의 clientWidth는 고정 중이면 인라인 px, 아니면 column이고 scrollWidth는 그것과 content 가운데 큰 값입니다. 브라우저가
 * 배치 뒤·그리기 전에 보내는 크기 알림(ResizeObserver)과 프레임(requestAnimationFrame)은 시험이 직접 부릅니다. 바깥 상자가 자르는지는 고정 중의
 * 클래스(overflow-x-clip)와 인라인 overflow-x 어느 쪽이든 봅니다.
 *
 * 재현 커밋에서 다섯 시험은 모두 it.fails입니다. 첫째(놓을 때)와 다섯째(신호 없이 폭이 줄 때)가 결함을 재현하고, 둘째(맞지 않아도 1초 뒤 풂)·셋째(푸는
 * 도중 다시 켜짐)·넷째(언마운트)는 고침이 둘 장치를 봅니다 — 고침 전에는 풀 때 자르지 않아 첫 '자름' 단언에서 실패할 뿐입니다.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHART_FIT_CLIP_MAX_MS, ChartSizeHold } from "@/components/charts/sizeHold";
import { resetShellResizingForTest, setShellResizing } from "@/lib/shellResize";

/** 바깥 상자의 폭(열) — 쉬는 안쪽 상자의 폭이기도 합니다. */
let column = 706;
/** 차트가 지금 그려진 폭 — 크기 감시가 새 폭으로 다시 그려야 바뀝니다. */
let content = 706;

const frames = new Map<number, FrameRequestCallback>();
let lastFrame = 0;
const observers: FakeResizeObserver[] = [];

/** 관찰 대상만 기억하는 크기 감시 — 알림은 시험이 resize()로 보냅니다(배치 뒤·그리기 전). */
class FakeResizeObserver {
  readonly targets = new Set<Element>();
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
  notify(target: Element, width: number) {
    const entry = { target, contentRect: { width, height: 240 } } as unknown as ResizeObserverEntry;
    this.callback([entry], this as unknown as ResizeObserver);
  }
}

const isInner = (element: Element) => element.firstElementChild?.getAttribute("data-testid") === "chart";
const isOuter = (element: Element) => element.firstElementChild !== null && isInner(element.firstElementChild);
/** 안쪽 상자의 폭 — 고정 중이면 인라인 px, 아니면 열 폭(100%). */
const innerWidth = (inner: HTMLElement) => (inner.style.width ? Math.round(Number.parseFloat(inner.style.width)) : column);

function rect(width: number): DOMRect {
  return { left: 0, top: 0, x: 0, y: 0, width, height: 240, right: width, bottom: 240, toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
  column = 706;
  content = 706;
  frames.clear();
  lastFrame = 0;
  observers.length = 0;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
    lastFrame += 1;
    frames.set(lastFrame, callback);
    return lastFrame;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id: number) => {
    frames.delete(id);
  });
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return isOuter(this) ? rect(column) : original.call(this);
  });
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return isInner(this) ? innerWidth(this as HTMLElement) : 0;
  });
  vi.spyOn(Element.prototype, "scrollWidth", "get").mockImplementation(function (this: Element) {
    return isInner(this) ? Math.max(content, innerWidth(this as HTMLElement)) : 0;
  });
});

afterEach(() => {
  cleanup();
  resetShellResizingForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 바깥 상자가 가로 넘침을 자르는가 — 고정 중의 클래스든 인라인 overflow-x든. */
const clipped = (outer: HTMLElement) => outer.classList.contains("overflow-x-clip") || outer.style.overflowX === "clip";

/** 크기 감시 알림 — 그 상자를 관찰하는 감시 모두에게(배치 뒤·그리기 전). */
function resize(target: Element, width: number) {
  act(() => {
    observers.filter((observer) => observer.targets.has(target)).forEach((observer) => observer.notify(target, width));
  });
}

/** 한 프레임 — 기다리던 requestAnimationFrame 콜백을 모두 그 시각으로 부릅니다. */
function frame(time: number) {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(time));
  });
}

function renderHold() {
  const view = render(
    <ChartSizeHold>
      <div data-testid="chart" />
    </ChartSizeHold>,
  );
  const inner = screen.getByTestId("chart").parentElement as HTMLElement;
  const outer = inner.parentElement as HTMLElement;
  resize(inner, column); // 관찰을 시작하면 지금 폭을 한 번 알림
  return { ...view, inner, outer };
}

/** 끌기 — 신호가 켜지면 706px로 고정, 끄는 동안 열이 606으로 좁아짐(차트는 706에 머묾), 놓으면 안쪽 상자는 100%로. */
function holdThenRelease(inner: HTMLElement, outer: HTMLElement) {
  act(() => setShellResizing("drag", true));
  expect(inner.style.width).toBe("706px");
  expect(clipped(outer)).toBe(true);
  column = 606;
  act(() => setShellResizing("drag", false));
  expect(inner.style.width).toBe("");
}

describe("QA-614: 폭이 바뀐 직후 차트가 아직 앞 폭이면 맞을 때까지 바깥 상자가 가로 넘침을 자름", () => {
  // 재현 커밋 실패 값: AssertionError: expected false to be true — 고정을 푼 커밋에서 자르기도 함께 사라짐.
  it("끌기를 놓으면 안쪽 상자는 바로 100%로 풀고, 바깥 상자는 차트가 새 폭으로 다시 그려질 때까지 자른 뒤 쉬는 상태로 돌아감", () => {
    const { inner, outer } = renderHold();
    holdThenRelease(inner, outer);
    expect(clipped(outer)).toBe(true);
    resize(inner, 606); // 배치 뒤 크기 알림 — 차트는 아직 706
    frame(0);
    frame(16);
    expect(clipped(outer)).toBe(true);
    content = 606; // 크기 감시가 새 폭으로 다시 그림
    frame(130);
    expect(clipped(outer)).toBe(false);
    expect(outer.className).toBe("w-full min-w-0");
    expect(outer.getAttribute("style")).toBeNull();
    expect(frames.size).toBe(0);
  });

  // 장치 시험. 재현 커밋 실패 값: AssertionError: expected false to be true(풀 때 자르지 않음 — '1초 뒤 풂'에는 닿지 못함).
  it("차트가 끝내 맞지 않아도 첫 확인부터 1초 뒤에는 자르기를 풂 — 붙어 남지 않음", () => {
    const { inner, outer } = renderHold();
    holdThenRelease(inner, outer);
    expect(clipped(outer)).toBe(true);
    expect(CHART_FIT_CLIP_MAX_MS).toBe(1000);
    frame(5000);
    frame(5000 + CHART_FIT_CLIP_MAX_MS - 1);
    expect(clipped(outer)).toBe(true);
    frame(5000 + CHART_FIT_CLIP_MAX_MS);
    expect(clipped(outer)).toBe(false);
    expect(outer.getAttribute("style")).toBeNull();
    expect(frames.size).toBe(0);
  });

  // 장치 시험. 재현 커밋 실패 값: AssertionError: expected false to be true.
  it("푸는 도중 신호가 다시 켜지면 그때 폭(606px)을 다시 재어 고정하고 자르기는 고정 쪽으로 넘김 — 다시 놓으면 맞을 때까지 자름", () => {
    const { inner, outer } = renderHold();
    holdThenRelease(inner, outer);
    expect(clipped(outer)).toBe(true);
    frame(0);
    act(() => setShellResizing("motion", true));
    expect(inner.style.width).toBe("606px");
    expect(outer.className).toContain("overflow-x-clip");
    expect(outer.getAttribute("style")).toBeNull();
    expect(frames.size).toBe(0);
    column = 506;
    act(() => setShellResizing("motion", false));
    expect(inner.style.width).toBe("");
    expect(clipped(outer)).toBe(true);
    content = 506;
    frame(16);
    expect(clipped(outer)).toBe(false);
    expect(outer.getAttribute("style")).toBeNull();
  });

  // 장치 시험. 재현 커밋 실패 값: AssertionError: expected false to be true.
  it("푸는 도중 언마운트하면 프레임 확인을 멈춤", () => {
    const { inner, outer, unmount } = renderHold();
    holdThenRelease(inner, outer);
    expect(clipped(outer)).toBe(true);
    expect(frames.size).toBe(1);
    unmount();
    expect(frames.size).toBe(0);
  });

  // 재현 커밋 실패 값: AssertionError: expected false to be true — QA-601 전부터 있던 같은 일(신호 없이 폭이 한 번에 바뀜).
  it("신호 없이 폭이 한 번에 줄면(손잡이 End 키·움직임 줄이기의 접고 펴기·창 크기) 크기 알림에서 바로 자르고 맞으면 풂 — 넓어질 때는 자르지 않음", () => {
    const { inner, outer } = renderHold();
    column = 606;
    resize(inner, 606);
    expect(clipped(outer)).toBe(true);
    frame(0);
    expect(clipped(outer)).toBe(true);
    content = 606;
    frame(120);
    expect(clipped(outer)).toBe(false);
    expect(outer.getAttribute("style")).toBeNull();
    column = 806;
    resize(inner, 806);
    expect(clipped(outer)).toBe(false);
    expect(frames.size).toBe(0);
  });

  it("크기 감시의 반올림으로 차트가 열보다 1px까지 넓으면 맞은 것으로 보고 풂 — 2px이면 자른 채", () => {
    const { inner, outer } = renderHold();
    holdThenRelease(inner, outer);
    content = 608;
    frame(0);
    expect(clipped(outer)).toBe(true);
    content = 607;
    frame(16);
    expect(clipped(outer)).toBe(false);
    expect(outer.getAttribute("style")).toBeNull();
  });

  it("고정하지 않은 차트(잰 폭 0 — 숨긴 탭)는 풀 때 자르지 않고, 고정 중 같은 폭의 크기 알림(높이만 바뀜)에도 인라인 자르기를 걸지 않음", () => {
    column = 0;
    const hidden = renderHold();
    act(() => setShellResizing("drag", true));
    expect(hidden.inner.style.width).toBe("");
    act(() => setShellResizing("drag", false));
    expect(clipped(hidden.outer)).toBe(false);
    expect(frames.size).toBe(0);
    hidden.unmount();

    column = 706;
    const { inner, outer } = renderHold();
    act(() => setShellResizing("drag", true));
    resize(inner, 706);
    expect(outer.className).toContain("overflow-x-clip");
    expect(outer.getAttribute("style")).toBeNull();
    expect(frames.size).toBe(0);
  });
});
