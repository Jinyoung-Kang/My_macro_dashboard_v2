"use client";

import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * 선 차트의 그림 너비(px) — X 중간 눈금 개수를 고르는 데 씁니다(재기 전에는 null — 첫·마지막만).
 *
 * Recharts 3.10.1의 ResponsiveContainer는 붙은 뒤(그림 다음의 수동 효과) 크기를 재 차트를 붙이고, 그다음 ResizeObserver 콜백에서야 onResize를
 * 부릅니다. 그래서 예전에는 차트가 '너비 모름'으로 한 번 붙은 뒤 onResize의 너비로 차트 부품 전체가 다시 그려지고, 그때마다 Recharts가 선 경로·라벨을
 * 두 번 더 다시 계산했습니다(매크로 첫 그리기, CPU 4배에서 약 0.35초 — ADR 0047 결정 8). 여기서는 차트 부품의 레이아웃 효과(그림 전, 차트가 붙기 전)에서
 * ResponsiveContainer 상자의 너비를 먼저 재 둡니다 — 차트는 처음부터 같은 너비·같은 눈금으로 한 번만 붙고, 뒤에 오는 onResize는 같은 값이라 다시
 * 그리지 않습니다. 상자를 못 재면(배치 전·숨은 상자·jsdom) 예전처럼 onResize를 기다립니다. 보이는 결과는 같습니다.
 *
 * @returns width(모르면 null), containerRef(ResponsiveContainer의 ref에), onResize(ResponsiveContainer의 onResize에)
 */
export function useChartWidth(): {
  width: number | null;
  containerRef: RefObject<HTMLDivElement | null>;
  onResize: (nextWidth: number) => void;
} {
  const [width, setWidth] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (width !== null || !containerRef.current) return;
    const measured = containerRef.current.getBoundingClientRect().width;
    if (measured > 0) setWidth(measured);
  }, [width]);
  // ResizeObserver의 contentRect 너비와 위에서 잰 너비는 같은 값입니다(상자에 여백·테두리 없음) — 부동소수 표기 차이만 같게 봅니다.
  const onResize = useCallback((nextWidth: number) => {
    setWidth((previous) => (previous !== null && Math.abs(previous - nextWidth) < 0.01 ? previous : nextWidth));
  }, []);
  return { width, containerRef, onResize };
}
