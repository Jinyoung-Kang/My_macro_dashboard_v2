"use client";

import { useLayoutEffect, type RefObject } from "react";

/**
 * 문서 루트(html)에 적는 CSS 변수 — 긴 화면 목차(components/patterns SectionIndex)의 가로 줄이 지금 차지한 높이(px, 아래 선 1px·가로 스크롤 막대 포함).
 * 줄이 보이지 않으면(세로 목록 폭 — display:none) 지웁니다(읽는 쪽은 기본값을 씀).
 * 읽는 곳: globals.css(스크롤 상자의 위쪽 스크롤 여백 — QA-643·QA-656).
 * Tailwind가 클래스를 찾도록 읽는 곳은 이 이름을 글자 그대로 적습니다.
 */
export const SECTION_STRIP_VAR = "--section-strip-h";

/**
 * 목차 가로 줄(`stripRef` — ul)의 높이를 재서 문서 루트의 --section-strip-h로 적습니다. 줄 높이는 글자만으로 정해지지 않습니다 — 고전 스크롤 막대를
 * 그리는 브라우저에서 칸이 넘치면 줄 안에 가로 막대(10px — globals.css ::-webkit-scrollbar)가 서서 31→41px(좁은 화면 45→55px)이 됩니다(QA-656).
 * 그래서 상수 대신 잰 값을 씁니다(offsetHeight — 테두리 상자).
 *
 * - 다시 재는 때(ResizeObserver): 줄 크기가 바뀔 때, 칸(li) 크기가 바뀔 때(글꼴 교체·개수가 와서 넘침만 바뀜), 줄을 담은 부모(목차 내비)의 크기가 바뀔 때 —
 *   가로 막대는 줄의 내용 상자 높이를 바꾸지 않으므로 막대만 서고 사라지는 변화는 줄의 테두리 상자를 담은 부모의 내용 상자로 봅니다(columnFrom 미만에서
 *   내비의 내용 = 가로 줄). 그리고 창 크기가 바뀔 때.
 * - 높이가 0이면(columnFrom 이상의 display:none) 이 훅이 적은 값을 지웁니다. 화면을 떠날 때도 지우되, 지금 값이 이 훅이 적은 값일 때만 — 다른 목차가
 *   적은 값을 지우지 않게.
 * - ResizeObserver가 없는 곳(jsdom 등)에서는 처음과 창 크기 변화 때만 잽니다.
 * - `itemsKey`(칸 id 목록 글)가 바뀌면 칸을 다시 봅니다.
 */
export function useSectionStripHeight(stripRef: RefObject<HTMLElement | null>, itemsKey: string): void {
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return undefined;
    const root = document.documentElement;
    // 이 훅이 마지막으로 적은 값(없으면 null).
    let written: string | null = null;
    const clear = () => {
      if (written !== null && root.style.getPropertyValue(SECTION_STRIP_VAR) === written) root.style.removeProperty(SECTION_STRIP_VAR);
      written = null;
    };
    const measure = () => {
      const height = strip.offsetHeight;
      if (!(height > 0)) {
        clear();
        return;
      }
      const value = `${height}px`;
      if (root.style.getPropertyValue(SECTION_STRIP_VAR) !== value) root.style.setProperty(SECTION_STRIP_VAR, value);
      written = value;
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    if (observer) {
      observer.observe(strip);
      for (const item of Array.from(strip.children)) observer.observe(item);
      if (strip.parentElement) observer.observe(strip.parentElement);
    }
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      clear();
    };
  }, [stripRef, itemsKey]);
}
