"use client";

import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * 목록-검사 틀의 폭이 검사 칸을 옆에 둘 만한가(`minRem` 이상 — 기본 32rem) — ResizeObserver로 잽니다. 폭이 0이면(숨긴 탭 안·배치를 하지 않는 시험 대역)
 * 모른다(null)로 두고, 보이게 되어 폭이 생기면 그때 정합니다. 크기 질의(CSS)가 자리를 정하고, 이 값은 아래로 쌓인 배치에서 동작(대화상자로 엶)을 바꾸는 데 씁니다.
 *
 * 목록-검사(components/patterns/MasterDetail — 32rem)와 검사 칸 틀(components/patterns/InspectorFrame — 배치마다 32·52rem)이 함께 씁니다. 부르는 쪽의
 * 크기 질의 클래스(`@lg` = 32rem 등)와 `minRem`을 같은 값으로 둡니다.
 */
export function useSideBySide(ref: RefObject<HTMLElement | null>, enabled: boolean, minRem = 32): boolean | null {
  const [side, setSide] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return undefined;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      if (!(width > 0)) return;
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setSide(width >= minRem * rem);
    };
    measure();
    if (typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, enabled, minRem]);
  return side;
}
