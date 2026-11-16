"use client";

import { useEffect, useLayoutEffect, type RefObject } from "react";
import { navScrollTop } from "@/lib/scrollStrip";

/** 메뉴 안의 마지막 `[aria-current]`(가장 깊은 지금 칸)의 메뉴 스크롤 내용 안 위치. 배치 전·숨은 메뉴(사각형·보이는 높이 0)면 null. */
function currentItem(nav: HTMLElement): { top: number; height: number } | null {
  const marks = nav.querySelectorAll<HTMLElement>("[aria-current]");
  const current = marks[marks.length - 1];
  if (!current) return null;
  const box = nav.getBoundingClientRect();
  const rect = current.getBoundingClientRect();
  if (nav.clientHeight <= 0 || rect.height <= 0) return null;
  return { top: rect.top - box.top - nav.clientTop + nav.scrollTop, height: rect.height };
}

/** 지금 칸이 보이는 영역 밖이면 메뉴의 scrollTop만 옮깁니다(다 보이면 그대로). */
function reveal(nav: HTMLElement): void {
  const item = currentItem(nav);
  if (!item) return;
  const next = navScrollTop({ scrollTop: nav.scrollTop, clientHeight: nav.clientHeight }, item);
  if (next !== nav.scrollTop) nav.scrollTop = next;
}

/**
 * 세로로 스크롤하는 메뉴(넓은 화면 왼쪽 나무 메뉴 — shell/SideNav의 nav)의 지금 칸을 메뉴 안에 보이게 합니다(QA-555).
 *
 * 메뉴만 스크롤 상자가 되고 맨 아래 접기 영역이 그 밖으로 나오면서, 낮은 창(1024x600 등)에서는 메뉴 끝 쪽의 지금 칸(더보기의 '파생·투기세력(KRX)')이
 * 처음부터 메뉴 아래에 가려진 채 열립니다. 그래서 메뉴 안의 마지막 `[aria-current]`(가장 깊은 지금 칸)가 보이는 영역 밖이면 메뉴의 scrollTop만 옮깁니다
 * (lib/scrollStrip navScrollTop — 여백 16px). 보는 때:
 * - 그릴 때와 `pathname`(지금 화면)·`collapsed`(접힘 — 레일에서는 지금 칸이 탭 칸)·`wide`(넓은 화면인가 — useWideShell)가 바뀔 때. 좁은 폭에서는
 *   메뉴가 숨어(display:none) 아무것도 하지 않으므로, 넓은 화면이 되는 그리기에서 다시 봅니다(검토 지적 — 예전에는 좁은 폭에서 연 화면을 넓혀도 지금 칸이
 *   가려진 채 남았음).
 * - 메뉴의 보이는 높이가 바뀔 때(창 높이를 줄임 — ResizeObserver): 바뀌기 전에 지금 칸이 다 보였는데 바뀐 뒤 가려질 때만 옮깁니다.
 * - 다 보이면 그대로 둡니다. 같은 주소·같은 폭으로 다시 그릴 때(알림 수 등)는 움직이지 않고, 사람이 굴려 지금 칸을 가려 둔 메뉴는 높이가 바뀌어도
 *   되돌리지 않습니다.
 * - scrollIntoView는 쓰지 않습니다 — 본문·문서의 스크롤까지 움직입니다(좁은 화면 줄의 useScrollStripActive와 같은 까닭).
 * - 좌표는 getBoundingClientRect로 셉니다(칸의 offsetTop은 위치 기준 조상 — li·relative 칸 — 에 따라 달라짐). 사각형·보이는 높이가 0이면(배치 전,
 *   메뉴가 숨은 좁은 화면 display:none, jsdom) 아무것도 하지 않습니다.
 * Tab으로 옮긴 칸은 브라우저가 스스로 스크롤 상자 안에 보이게 합니다(따로 처리하지 않음).
 */
export function useScrollNavActive(navRef: RefObject<HTMLElement | null>, pathname: string, collapsed: boolean, wide: boolean): void {
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (nav) reveal(nav);
  }, [navRef, pathname, collapsed, wide]);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === "undefined") return;
    let lastHeight = nav.clientHeight;
    const observer = new ResizeObserver(() => {
      const height = nav.clientHeight;
      if (height === lastHeight) return;
      const before = lastHeight;
      lastHeight = height;
      const item = currentItem(nav);
      if (!item) return;
      // 바뀌기 전에 다 보였는가(숨었다 보이는 경우 — 앞 높이 0 — 는 위 그리기 쪽이 봄)
      const wasVisible = before > 0 && item.top >= nav.scrollTop && item.top + item.height <= nav.scrollTop + before;
      if (wasVisible) reveal(nav);
    });
    observer.observe(nav);
    return () => observer.disconnect();
  }, [navRef]);
}
