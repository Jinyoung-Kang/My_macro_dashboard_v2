/**
 * 선 차트의 그림 너비를 차트가 붙기 전에 먼저 잼(useChartWidth — ADR 0047 결정 8).
 *  - 상자를 잴 수 있으면 첫 그림 전에(레이아웃 효과) 그 너비, 못 재면(0 — 배치 전·jsdom) null로 두고 onResize를 기다림
 *  - onResize가 같은 너비(부동소수 표기 차이 포함)를 주면 차트(자식)를 다시 그리지 않고, 다른 너비면 바꿈
 *    (값이 같아도 React가 훅을 가진 부품 함수를 한 번 더 부를 수는 있음 — 그때도 자식은 건너뜀)
 */
import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useChartWidth } from "../useChartWidth";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Chart({ width, renders }: { width: number | null; renders: number[] }) {
  renders.push(width ?? -1);
  return null;
}

function Probe({ renders, resizeRef }: { renders: number[]; resizeRef: { current: ((w: number) => void) | null } }) {
  const { width, containerRef, onResize } = useChartWidth();
  useEffect(() => {
    resizeRef.current = onResize;
  }, [onResize, resizeRef]);
  return (
    <div ref={containerRef}>
      <Chart width={width} renders={renders} />
    </div>
  );
}

describe("useChartWidth", () => {
  it("잴 수 있는 상자면 첫 그림 전에 그 너비를 쓰고, 같은 너비의 onResize로는 다시 그리지 않는다", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 341.5 } as DOMRect);
    const renders: number[] = [];
    const resizeRef: { current: ((w: number) => void) | null } = { current: null };
    render(<Probe renders={renders} resizeRef={resizeRef} />);
    expect(renders).toEqual([-1, 341.5]);
    act(() => resizeRef.current?.(341.5000001));
    expect(renders).toEqual([-1, 341.5]);
    act(() => resizeRef.current?.(300));
    expect(renders.at(-1)).toBe(300);
  });

  it("못 재는 상자(0)면 null로 두고 onResize의 너비를 쓴다", () => {
    const renders: number[] = [];
    const resizeRef: { current: ((w: number) => void) | null } = { current: null };
    render(<Probe renders={renders} resizeRef={resizeRef} />);
    expect(renders).toEqual([-1]);
    act(() => resizeRef.current?.(600));
    expect(renders.at(-1)).toBe(600);
  });
});
