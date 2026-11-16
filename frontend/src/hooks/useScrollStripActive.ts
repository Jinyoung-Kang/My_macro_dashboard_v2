"use client";

import { useEffect, useLayoutEffect, type RefObject } from "react";
import { stripScrollLeft } from "@/lib/scrollStrip";

/** 칸이 보이게 줄의 scrollLeft만 옮깁니다 — scrollIntoView는 창(문서)의 세로 스크롤까지 움직여 쓰지 않습니다. */
function reveal(strip: HTMLElement, item: HTMLElement): void {
  const next = stripScrollLeft({ scrollLeft: strip.scrollLeft, clientWidth: strip.clientWidth }, { left: item.offsetLeft, width: item.offsetWidth });
  if (next !== strip.scrollLeft) strip.scrollLeft = next;
}

/**
 * 가로 스크롤 줄의 지금 칸·포커스한 칸을 줄 안에 보이게 합니다(QA-510 — 좁은 화면 하위 메뉴 줄과 공용 탭 줄(components/ui Tabs), P6의 모의매매 탭 줄도 씀).
 * - 그릴 때와 `currentKey`(지금 화면의 주소 — 탭 줄은 고른 탭)가 바뀔 때: 줄 안의 지금 칸(`current` — 기본 `[aria-current]`)을 보이게(그리기 전에 — 줄이 한 번 튀지 않게). 같은 주소에서 다시
 *   그릴 때(알림 수가 바뀌는 등)는 움직이지 않습니다 — 사람이 옆으로 밀어 둔 줄을 되돌리지 않게.
 *   - 줄 안에 키보드 포커스(:focus-visible)가 있으면(Tab으로 간 칸에서 Enter 뒤 뒤로·앞으로 가기 — 그 칸에 포커스가 남음) 지금 칸보다 그 칸을
 *     보이게 합니다(QA-566). 손가락·마우스로 누른 칸에 남은 포커스(:focus-visible 아님)는 지금 칸보다 앞서지 않습니다 — 누른 칸으로 간 뒤 뒤로 가기에서
 *     지금 칸이 줄 밖에 가려진 채 열리지 않게(QA-567).
 *   - 지금 칸이 없는 화면(/more·/markets/i/…·/s/…)은 줄을 처음(scrollLeft 0)으로 — 새로 연 것과 같게. 줄은 레이아웃에 남아 앞 화면 위치를 물려받습니다(QA-566).
 * - 줄 안으로 포커스가 들어올 때(Tab·화살표): 그 칸을 보이게. 줄이 없다가 생기는 것(주소가 바뀔 때)도 `currentKey`로 다시 찾습니다.
 * 줄(`listRef`)은 위치 기준(relative)이어야 합니다 — 칸의 offsetLeft가 줄 안 좌표가 되게. 칸은 줄 안의 포커스 받는 요소(링크·단추)입니다.
 *
 * 선택(`options`) — 공용 탭 줄(components/ui Tabs)이 씁니다:
 * - `current`: 지금 칸을 찾는 선택자(기본 `[aria-current]` — 하위 메뉴 줄의 링크). 탭 줄은 `[aria-selected="true"]`.
 * - `focus`: 줄 안으로 들어온 포커스 가운데 무엇을 보이게 할지. 기본 `"any"`(하위 메뉴 줄 — 지금 그대로). `"keyboard"`면 키보드 포커스(:focus-visible)만
 *   보이게 하고 손가락·마우스로 누른 칸의 포커스는 두지 않습니다 — 누르는 도중(mousedown의 포커스와 mouseup 사이)에 줄이 움직이면 손을 뗀 자리가
 *   다른 칸이 되어 누르기가 그 칸에 닿지 않을 수 있습니다. 누른 칸은 고른 뒤(`currentKey`가 바뀜) 지금 칸으로 보입니다.
 */
export function useScrollStripActive(
  listRef: RefObject<HTMLElement | null>,
  currentKey: string | null,
  { current = "[aria-current]", focus = "any" }: { current?: string; focus?: "any" | "keyboard" } = {},
): void {
  useLayoutEffect(() => {
    const strip = listRef.current;
    if (!strip) return;
    const focused = document.activeElement;
    const target =
      focused instanceof HTMLElement && focused !== strip && strip.contains(focused) && focused.matches(":focus-visible")
        ? focused // 줄 안 키보드 포커스가 우선(뒤로·앞으로 가기) — 손가락·마우스로 누른 칸에 남은 포커스는 아님(QA-567)
        : strip.querySelector<HTMLElement>(current);
    if (target) reveal(strip, target);
    else if (strip.scrollLeft !== 0) strip.scrollLeft = 0; // 지금 칸이 없는 화면은 새로 연 것과 같게
  }, [listRef, currentKey, current]);

  useEffect(() => {
    const strip = listRef.current;
    if (!strip) return;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target === strip) return;
      if (focus === "keyboard" && !target.matches(":focus-visible")) return;
      reveal(strip, target);
    };
    strip.addEventListener("focusin", onFocusIn);
    return () => strip.removeEventListener("focusin", onFocusIn);
  }, [listRef, currentKey, focus]);
}
