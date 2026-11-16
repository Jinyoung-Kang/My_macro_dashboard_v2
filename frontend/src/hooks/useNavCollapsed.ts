"use client";

import { useCallback, useSyncExternalStore } from "react";

/** 저장 키 — 값 "1"(접힘)·"0"(펼침), 없으면 펼침. 이 브라우저에만 둡니다(보는 사람별 편의 — 다른 기기·서버와 나누지 않음). */
export const NAV_COLLAPSED_STORAGE_KEY = "shell.navCollapsed";

const listeners = new Set<() => void>();
/** 이 창의 기억 — 저장소를 못 쓰면(사생활 보호 창·막힌 저장소) 이것만으로 동작합니다. null이면 아직 읽지 않음. */
let current: boolean | null = null;

function read(): boolean {
  if (current === null) {
    try {
      current = window.localStorage.getItem(NAV_COLLAPSED_STORAGE_KEY) === "1";
    } catch {
      current = false;
    }
  }
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // 다른 탭에서 접고 펴면 따라갑니다(그 탭이 저장소에 쓴 값). 저장소를 통째로 지우면(key null) 기본인 펼침으로.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== NAV_COLLAPSED_STORAGE_KEY && event.key !== null) return;
    current = event.newValue === "1";
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** 서버 렌더·첫 하이드레이션 값 — 펼침(저장값은 그다음 그리기에서 읽음). */
const serverSnapshot = () => false;

/** 시험이 모듈의 기억을 지웁니다. */
export function resetNavCollapsedForTest(): void {
  current = null;
}

/**
 * 넓은 화면 왼쪽 메뉴의 접힘(48px 아이콘 레일) — 작업대 실행 명세 §5, ADR 0042 결정 5. 셸 뿌리(메뉴 폭 변수)와 왼쪽 메뉴가 같은 값을 봅니다.
 * 읽기·쓰기는 모두 try/catch — 저장소를 못 써도 화면은 그려지고 이 창 안에서는 접고 펼 수 있습니다.
 *
 * @returns `[접힘, 접기·펼치기]`
 */
export function useNavCollapsed(): [boolean, () => void] {
  const collapsed = useSyncExternalStore(subscribe, read, serverSnapshot);
  const toggle = useCallback(() => {
    current = !read();
    try {
      window.localStorage.setItem(NAV_COLLAPSED_STORAGE_KEY, current ? "1" : "0");
    } catch {
      // 기억만 못 할 뿐 이 창에서는 그대로 접고 폅니다.
    }
    listeners.forEach((listener) => listener());
  }, []);
  return [collapsed, toggle];
}
