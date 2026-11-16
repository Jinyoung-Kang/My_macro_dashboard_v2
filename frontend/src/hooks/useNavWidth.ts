"use client";

import { useCallback, useSyncExternalStore } from "react";
import { NAV_WIDTH_DEFAULT, clampNavWidth, parseNavWidth } from "@/lib/navWidth";

/** 저장 키 — 펼친 폭(px, 정수 글). 이 브라우저에만 둡니다(보는 사람별 편의 — 다른 기기·서버와 나누지 않음). 접힘은 따로(shell.navCollapsed). */
export const NAV_WIDTH_STORAGE_KEY = "shell.navWidth";

const listeners = new Set<() => void>();
/** 이 창의 기억 — 저장소를 못 쓰면(사생활 보호 창·막힌 저장소) 이것만으로 동작합니다. null이면 아직 읽지 않음. */
let current: number | null = null;

function read(): number {
  if (current === null) {
    try {
      current = parseNavWidth(window.localStorage.getItem(NAV_WIDTH_STORAGE_KEY));
    } catch {
      current = NAV_WIDTH_DEFAULT;
    }
  }
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // 다른 탭에서 폭을 바꾸면 따라갑니다(그 탭이 저장소에 쓴 값 — 검사해서). 저장소를 통째로 지우면(key null) 기본 폭으로.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== NAV_WIDTH_STORAGE_KEY && event.key !== null) return;
    current = parseNavWidth(event.newValue);
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** 서버 렌더·첫 하이드레이션 값 — 기본 폭(저장값은 그다음 그리기에서 읽음). */
const serverSnapshot = () => NAV_WIDTH_DEFAULT;

/** 시험이 모듈의 기억을 지웁니다. */
export function resetNavWidthForTest(): void {
  current = null;
}

/** 지금 펼친 폭 — 그리기 밖(끌기의 프레임 처리·키 처리)에서 가장 새 값을 읽을 때. 그리기 안에서는 useNavWidth를 씁니다. */
export function getNavWidth(): number {
  return read();
}

/** 폭을 바꾸는 함수 — `persist: false`면 이 창에만 두고 저장소에 쓰지 않습니다(끄는 동안 — 놓을 때 한 번 씀). */
export type SetNavWidth = (next: number, options?: { persist?: boolean }) => void;

/**
 * 넓은 화면 왼쪽 메뉴의 펼친 폭(200~320px, 기본 220 — lib/navWidth, 작업대 실행 명세 §5 '가변 폭 왼쪽 메뉴'). 셸 뿌리(메뉴 폭 변수)와 왼쪽 메뉴의
 * 폭 손잡이가 같은 값을 봅니다. 접힘(hooks/useNavCollapsed)과 따로 두어 접었다 펴면 이 폭으로 돌아갑니다.
 * 읽은 값은 검사해 하한·상한으로 자르고(parseNavWidth), 읽기·쓰기는 모두 try/catch — 저장소를 못 써도 화면은 기본 폭으로 그려지고 이 창 안에서는
 * 폭을 바꿀 수 있습니다.
 *
 * @returns `[펼친 폭, 폭 바꾸기]`
 */
export function useNavWidth(): [number, SetNavWidth] {
  const width = useSyncExternalStore(subscribe, read, serverSnapshot);
  const setWidth = useCallback<SetNavWidth>((next, options) => {
    const value = clampNavWidth(next);
    const changed = value !== read();
    current = value;
    if (options?.persist !== false) {
      try {
        window.localStorage.setItem(NAV_WIDTH_STORAGE_KEY, String(value));
      } catch {
        // 기억만 못 할 뿐 이 창에서는 그대로 바뀝니다.
      }
    }
    if (changed) listeners.forEach((listener) => listener());
  }, []);
  return [width, setWidth];
}
