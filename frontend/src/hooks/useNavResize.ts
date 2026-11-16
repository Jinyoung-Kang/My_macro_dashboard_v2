"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { flushSync } from "react-dom";
import { getNavCollapsed, useNavCollapsed } from "@/hooks/useNavCollapsed";
import { getNavWidth, useNavWidth } from "@/hooks/useNavWidth";
import { NAV_DRAG_SLOP, NAV_MOTION_MS, navDragLayout, navKeyLayout, navShownWidth, type NavLayout } from "@/lib/navWidth";

/** 끄는 동안 문서 뿌리(html)에 붙이는 표지 — globals.css가 이 동안 커서를 col-resize로, 글 고르기를 끕니다(손잡이 밖으로 나가도). */
export const NAV_RESIZING_ATTR = "data-nav-resizing";

/** 한 번의 끌기 — 잡은 포인터와 자리, 잡을 때 보이던 폭과 펼친 폭, 문턱을 넘었는지, 기다리는 프레임. */
type Drag = {
  pointerId: number;
  startX: number;
  lastX: number;
  /** 잡을 때 보이던 폭(접혔으면 레일 48) — 옮긴 거리를 여기에 더해 끈 폭을 셉니다. */
  startShown: number;
  /** 끌기 전 펼친 폭 — 끌어서 접히면 이 폭을 기억합니다(펼치면 돌아감). */
  restoreWidth: number;
  /** 문턱(NAV_DRAG_SLOP)을 넘었는가 — 넘기 전에는 폭을 바꾸지 않습니다(두 번 누르기의 손떨림). */
  moved: boolean;
  frame: number | null;
};

/** 그리기와 상관없는 이 손잡이의 기억 — 하나의 객체를 두고 칸만 바꿉니다(정리 함수가 같은 객체를 봄). */
type Live = {
  drag: Drag | null;
  /** 지금 전환을 켜 두었는가(그리기 값 motion과 같은 값 — 같은 값으로 다시 그리지 않게). */
  motion: boolean;
  /** 끌기 중 접힘이 바뀐 뒤 전환을 끄는 타이머. */
  timer: number | null;
  /** 바로 앞·지금 누름에서 끌었는가 — 끌고 바로 한 번 더 눌러 생긴 두 번 누르기를 접기로 받지 않습니다. */
  movedPrevious: boolean;
  movedCurrent: boolean;
};

export type NavSeparatorHandlers = {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  onLostPointerCapture: (event: PointerEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
};

export type NavResize = {
  /** 폭 전환(150ms)을 켤 때 — 왼쪽 메뉴 상자가 이 값으로 전환 클래스를 붙입니다. 끄는 동안(접힘이 바뀐 직후 150ms를 빼고)과 처음 그릴 때는 꺼짐. */
  motion: boolean;
  /** 손잡이를 잡고 있는가 — 손잡이 모양과 툴팁 막기에 씁니다. */
  dragging: boolean;
  /** 접기·펼치기(맨 아래 단추·[ 키·명령 팔레트·두 번 누르기·Enter) — 펼치면 기억한 폭으로, 폭은 150ms 전환(움직임 줄이기면 없음). */
  toggle: () => void;
  /** 폭 손잡이(role=separator)에 붙이는 처리기. */
  separatorProps: NavSeparatorHandlers;
};

/**
 * 넓은 화면 왼쪽 메뉴의 폭 손잡이와 접기·펼치기(작업대 실행 명세 §5 '가변 폭 왼쪽 메뉴', ADR 0042 2026-11-16 사용자 결정). 숫자와 규칙은 lib/navWidth이고,
 * 접힘·펼친 폭의 기억은 hooks/useNavCollapsed·useNavWidth입니다(셸 뿌리가 같은 값으로 --shell-nav-w를 둠).
 *
 * - **끌기**: 포인터 이벤트 + setPointerCapture(손잡이 밖으로 나가도 이 손잡이가 받음 — 그동안 다른 요소의 툴팁·메뉴가 열리지 않음). 움직임은
 *   requestAnimationFrame으로 한 프레임에 한 번만 반영합니다. 3px을 넘기 전에는 폭을 바꾸지 않고, 끄는 동안의 값은 이 창에만 두었다가 놓을 때(pointerup·
 *   pointercancel·lostpointercapture) 한 번 저장합니다. 잡은 동안 문서 뿌리에 NAV_RESIZING_ATTR(커서 col-resize·글 고르기 끔 — globals.css).
 * - **전환**: 접힘이 바뀌는 때(단추·[·두 번 누르기·Enter·끌기 중 140px 문턱을 넘음)만 폭 전환을 켭니다. 끄는 동안 폭이 포인터를 따라갈 때는 끕니다 —
 *   끌기 중 접힘이 바뀌면 150ms만 켜 두고 다시 끕니다. 화살표·Home·End의 폭 걸음도 전환 없이 바로 바뀝니다. 처음 그릴 때(저장값을 읽어 폭이 바뀜)는 꺼져
 *   있어 화면을 열 때 메뉴가 움직이지 않습니다. 켜고 끄는 값과 폭은 같은 프레임에 반영돼야 하므로(전환은 바뀐 뒤 스타일의 transition을 봄) 켜고 끄기는
 *   flushSync로 먼저 그립니다 — 셸 명령(창의 사용자 이벤트)·프레임 처리기에서 부른 상태 바꾸기는 저장소 알림과 다른 우선순위로 그려질 수 있습니다.
 * - **두 번 누르기**: 접기·펼치기. 그 두 번의 누름 가운데 하나라도 끌었으면 받지 않습니다.
 * - **키**(lib/navWidth navKeyLayout): ←·→ 16px(Shift 64px)·Home·End는 바로 저장, Enter는 접기·펼치기(접힌 동안 →·End도 폄).
 *
 * @param beforeToggle 접힘이 바뀌기 바로 앞에 부릅니다(왼쪽 메뉴가 포커스가 메뉴 안에 있었는지 적어 두고, 사라지는 칸이면 그린 뒤 접기 단추로 옮김).
 */
export function useNavResize(beforeToggle: () => void): NavResize {
  const [, , setCollapsed] = useNavCollapsed();
  const [, setWidth] = useNavWidth();
  const [motion, setMotion] = useState(false);
  const [dragging, setDragging] = useState(false);
  const live = useRef<Live>({ drag: null, motion: false, timer: null, movedPrevious: false, movedCurrent: false });
  const before = useRef(beforeToggle);
  useEffect(() => {
    before.current = beforeToggle;
  });

  /** 전환을 켜거나 끕니다. `forMs`를 주면 그 뒤 다시 끕니다(끌기 중 접힘이 바뀐 때). */
  const animate = useCallback((on: boolean, forMs?: number) => {
    const state = live.current;
    if (state.timer !== null) {
      window.clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.motion !== on) {
      state.motion = on;
      flushSync(() => setMotion(on));
    }
    if (on && forMs !== undefined) {
      state.timer = window.setTimeout(() => {
        state.timer = null;
        state.motion = false;
        setMotion(false);
      }, forMs);
    }
  }, []);

  /** 배치를 두 저장소에 — 접을 때는 접힘 먼저, 펼 때는 폭 먼저(두 저장소가 따로 알려도 사이에 옛 폭으로 펼친 그림이 끼지 않게). */
  const apply = useCallback(
    (next: NavLayout, persist: boolean) => {
      if (next.collapsed) {
        setCollapsed(true, { persist });
        setWidth(next.width, { persist });
      } else {
        setWidth(next.width, { persist });
        setCollapsed(false, { persist });
      }
    },
    [setCollapsed, setWidth],
  );

  /** 접힘이 바뀌는 배치 — 앞 처리(포커스 기억)·전환을 켜고 저장합니다. */
  const flip = useCallback(
    (next: NavLayout) => {
      before.current();
      animate(true);
      apply(next, true);
    },
    [animate, apply],
  );

  const toggle = useCallback(() => {
    flip({ collapsed: !getNavCollapsed(), width: getNavWidth() });
  }, [flip]);

  /** 끄는 동안 한 프레임 — 끈 폭으로 배치를 셉니다(저장하지 않음). 접힘이 바뀌면 그 바뀜에만 150ms 전환. */
  const frame = useCallback(
    (drag: Drag) => {
      const next = navDragLayout(drag.startShown + drag.lastX - drag.startX, drag.restoreWidth);
      if (next.collapsed !== getNavCollapsed()) animate(true, NAV_MOTION_MS);
      apply(next, false);
    },
    [animate, apply],
  );

  /** 끌기를 끝냅니다 — 기다리던 프레임을 바로 반영하고, 끌었으면 저장합니다. 같은 끌기의 pointerup 뒤 lostpointercapture는 아무것도 하지 않음. */
  const finish = useCallback(
    (pointerId: number) => {
      const state = live.current;
      const drag = state.drag;
      if (!drag || drag.pointerId !== pointerId) return;
      state.drag = null;
      if (drag.frame !== null) {
        window.cancelAnimationFrame(drag.frame);
        drag.frame = null;
        frame(drag);
      }
      if (drag.moved) apply({ collapsed: getNavCollapsed(), width: getNavWidth() }, true);
      document.documentElement.removeAttribute(NAV_RESIZING_ATTR);
      setDragging(false);
    },
    [apply, frame],
  );

  const onPointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    const state = live.current;
    if (event.button !== 0 || !event.isPrimary || state.drag) return;
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // 잡지 못해도(이미 끝난 포인터 등) 손잡이 위의 움직임은 받습니다.
    }
    const layout = { collapsed: getNavCollapsed(), width: getNavWidth() };
    state.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      lastX: event.clientX,
      startShown: navShownWidth(layout),
      restoreWidth: layout.width,
      moved: false,
      frame: null,
    };
    state.movedPrevious = state.movedCurrent;
    state.movedCurrent = false;
    document.documentElement.setAttribute(NAV_RESIZING_ATTR, "");
    setDragging(true);
  }, []);

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const state = live.current;
      const drag = state.drag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag.lastX = event.clientX;
      if (!drag.moved) {
        if (Math.abs(drag.lastX - drag.startX) < NAV_DRAG_SLOP) return;
        drag.moved = true;
        state.movedCurrent = true;
        // 폭이 포인터를 따라가는 동안은 전환 없음(앞의 접기 전환이 남아 있었으면 여기서 끝남).
        animate(false);
      }
      if (drag.frame === null) {
        drag.frame = window.requestAnimationFrame(() => {
          drag.frame = null;
          if (live.current.drag === drag) frame(drag);
        });
      }
    },
    [animate, frame],
  );

  const onPointerEnd = useCallback((event: PointerEvent<HTMLElement>) => finish(event.pointerId), [finish]);

  const onDoubleClick = useCallback(() => {
    const state = live.current;
    if (state.drag || state.movedPrevious || state.movedCurrent) return;
    toggle();
  }, [toggle]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const layout = { collapsed: getNavCollapsed(), width: getNavWidth() };
      const next = navKeyLayout(event, layout);
      if (!next) return;
      // 받는 키는 기본 동작(본문 스크롤 등)을 막습니다 — 끝에서 같은 쪽으로 눌러 바뀌지 않아도.
      event.preventDefault();
      if (live.current.drag) return;
      if (next.collapsed !== layout.collapsed) {
        flip(next);
      } else if (next.width !== layout.width) {
        animate(false);
        apply(next, true);
      }
    },
    [animate, apply, flip],
  );

  // 그리는 중에 사라지면(로그아웃 등) 잡은 표지·타이머·프레임을 치우고, 끌던 값은 저장합니다.
  useEffect(() => {
    const state = live.current;
    return () => {
      if (state.timer !== null) window.clearTimeout(state.timer);
      state.timer = null;
      const drag = state.drag;
      if (!drag) return;
      state.drag = null;
      if (drag.frame !== null) window.cancelAnimationFrame(drag.frame);
      document.documentElement.removeAttribute(NAV_RESIZING_ATTR);
      if (drag.moved) apply({ collapsed: getNavCollapsed(), width: getNavWidth() }, true);
    };
  }, [apply]);

  return {
    motion,
    dragging,
    toggle,
    separatorProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      onLostPointerCapture: onPointerEnd,
      onDoubleClick,
      onKeyDown,
    },
  };
}
