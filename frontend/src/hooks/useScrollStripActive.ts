"use client";

import { useEffect, useLayoutEffect, type RefObject } from "react";
import { stripScrollLeft } from "@/lib/scrollStrip";

/** 칸이 보이게 줄의 scrollLeft만 옮깁니다 — scrollIntoView는 창(문서)의 세로 스크롤까지 움직여 쓰지 않습니다. */
function reveal(strip: HTMLElement, item: HTMLElement): void {
  const next = stripScrollLeft({ scrollLeft: strip.scrollLeft, clientWidth: strip.clientWidth }, { left: item.offsetLeft, width: item.offsetWidth });
  if (next !== strip.scrollLeft) strip.scrollLeft = next;
}

/**
 * 가로 스크롤 줄의 지금 칸·포커스한 칸을 줄 안에 보이게 합니다(QA-510 — 좁은 화면 하위 메뉴 줄, P6의 모의매매 탭 줄도 씀).
 * - 그릴 때와 `currentKey`(지금 화면의 주소)가 바뀔 때: 줄 안의 `[aria-current]` 칸을 보이게(그리기 전에 — 줄이 한 번 튀지 않게). 같은 주소에서 다시
 *   그릴 때(알림 수가 바뀌는 등)는 움직이지 않습니다 — 사람이 옆으로 밀어 둔 줄을 되돌리지 않게.
 * - 줄 안으로 포커스가 들어올 때(Tab·화살표): 그 칸을 보이게. 줄이 없다가 생기는 것(주소가 바뀔 때)도 `currentKey`로 다시 찾습니다.
 * 줄(`listRef`)은 위치 기준(relative)이어야 합니다 — 칸의 offsetLeft가 줄 안 좌표가 되게. 칸은 줄 안의 포커스 받는 요소(링크·단추)입니다.
 */
export function useScrollStripActive(listRef: RefObject<HTMLElement | null>, currentKey: string | null): void {
  useLayoutEffect(() => {
    const strip = listRef.current;
    const current = strip?.querySelector<HTMLElement>("[aria-current]");
    if (strip && current) reveal(strip, current);
  }, [listRef, currentKey]);

  useEffect(() => {
    const strip = listRef.current;
    if (!strip) return;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target !== strip) reveal(strip, target);
    };
    strip.addEventListener("focusin", onFocusIn);
    return () => strip.removeEventListener("focusin", onFocusIn);
  }, [listRef, currentKey]);
}
