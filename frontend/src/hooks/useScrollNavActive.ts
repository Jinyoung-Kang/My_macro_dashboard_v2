"use client";

import { useLayoutEffect, type RefObject } from "react";
import { navScrollTop } from "@/lib/scrollStrip";

/**
 * 세로로 스크롤하는 메뉴(넓은 화면 왼쪽 나무 메뉴 — shell/SideNav의 nav)의 지금 칸을 메뉴 안에 보이게 합니다(QA-555).
 *
 * 메뉴만 스크롤 상자가 되고 맨 아래 접기 영역이 그 밖으로 나오면서, 낮은 창(1024x600 등)에서는 메뉴 끝 쪽의 지금 칸(더보기의 '파생·투기세력(KRX)')이
 * 처음부터 메뉴 아래에 가려진 채 열립니다. 그래서 그릴 때와 `pathname`(지금 화면)·`collapsed`(접힘 — 레일에서는 지금 칸이 탭 칸)가 바뀔 때, 메뉴 안의
 * 마지막 `[aria-current]`(가장 깊은 지금 칸)가 보이는 영역 밖이면 메뉴의 scrollTop만 옮깁니다(lib/scrollStrip navScrollTop — 여백 16px).
 * - 다 보이면 그대로 둡니다. 같은 주소로 다시 그릴 때(알림 수 등)는 움직이지 않습니다 — 사람이 굴려 둔 메뉴를 되돌리지 않게.
 * - scrollIntoView는 쓰지 않습니다 — 본문·문서의 스크롤까지 움직입니다(좁은 화면 줄의 useScrollStripActive와 같은 까닭).
 * - 좌표는 getBoundingClientRect로 셉니다(칸의 offsetTop은 위치 기준 조상 — li·relative 칸 — 에 따라 달라짐). 사각형·보이는 높이가 0이면(배치 전,
 *   메뉴가 숨은 좁은 화면 display:none, jsdom) 아무것도 하지 않습니다.
 * Tab으로 옮긴 칸은 브라우저가 스스로 스크롤 상자 안에 보이게 합니다(따로 처리하지 않음).
 */
export function useScrollNavActive(navRef: RefObject<HTMLElement | null>, pathname: string, collapsed: boolean): void {
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const marks = nav.querySelectorAll<HTMLElement>("[aria-current]");
    const current = marks[marks.length - 1];
    if (!current) return;
    const box = nav.getBoundingClientRect();
    const rect = current.getBoundingClientRect();
    if (nav.clientHeight <= 0 || rect.height <= 0) return;
    const top = rect.top - box.top - nav.clientTop + nav.scrollTop;
    const next = navScrollTop({ scrollTop: nav.scrollTop, clientHeight: nav.clientHeight }, { top, height: rect.height });
    if (next !== nav.scrollTop) nav.scrollTop = next;
  }, [navRef, pathname, collapsed]);
}
