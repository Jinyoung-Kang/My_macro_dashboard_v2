/**
 * useChartScrub — 히어로 차트 문지르기 상태(명세 docs/specs/2026-10-31-v2-coinbase-ui.md §5).
 *  - 처음엔 null, 차트가 알린 순번을 기억하고 null이면 지운다
 *  - 기간을 바꿔 행 수가 달라지면 예전 순번을 지운다(다른 날짜를 문지르는 것처럼 보이지 않게 — 돌아와도 되살아나지 않음), 범위 밖도 null
 *  - onScrub은 같은 행 수에서는 같은 함수(차트의 알림 효과가 렌더마다 다시 돌지 않게)
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useChartScrub } from "@/hooks/useChartScrub";

afterEach(() => cleanup());

describe("useChartScrub", () => {
  it("처음엔 null, 알린 순번을 기억하고 null이면 지운다", () => {
    const { result } = renderHook(() => useChartScrub(5));
    expect(result.current.index).toBeNull();
    act(() => result.current.onScrub(3));
    expect(result.current.index).toBe(3);
    act(() => result.current.onScrub(null));
    expect(result.current.index).toBeNull();
  });

  it("행 수가 바뀌면(기간 변경) 예전 순번은 지우고 돌아와도 되살아나지 않으며, 범위 밖 순번은 null", () => {
    const { result, rerender } = renderHook(({ length }) => useChartScrub(length), { initialProps: { length: 5 } });
    act(() => result.current.onScrub(2));
    rerender({ length: 10 });
    expect(result.current.index).toBeNull();
    rerender({ length: 5 });
    expect(result.current.index).toBeNull();
    act(() => result.current.onScrub(4));
    expect(result.current.index).toBe(4);
    act(() => result.current.onScrub(7));
    expect(result.current.index).toBeNull();
  });

  it("같은 행 수에서는 onScrub이 같은 함수다", () => {
    const { result, rerender } = renderHook(({ length }) => useChartScrub(length), { initialProps: { length: 5 } });
    const first = result.current.onScrub;
    act(() => result.current.onScrub(1));
    rerender({ length: 5 });
    expect(result.current.onScrub).toBe(first);
  });
});
