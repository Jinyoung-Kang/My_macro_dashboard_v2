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

/** 지금 접힘 — 그리기 밖(끌기의 프레임 처리·키 처리)에서 가장 새 값을 읽을 때. 그리기 안에서는 useNavCollapsed를 씁니다. */
export function getNavCollapsed(): boolean {
  return read();
}

/** 접힘을 정해 두는 함수 — `persist: false`면 이 창에만 두고 저장소에 쓰지 않습니다(폭 손잡이를 끄는 동안 — 놓을 때 한 번 씀). */
export type SetNavCollapsed = (next: boolean, options?: { persist?: boolean }) => void;

function write(next: boolean, persist: boolean): void {
  const changed = next !== read();
  current = next;
  if (persist) {
    try {
      window.localStorage.setItem(NAV_COLLAPSED_STORAGE_KEY, next ? "1" : "0");
    } catch {
      // 기억만 못 할 뿐 이 창에서는 그대로 접고 폅니다.
    }
  }
  if (changed) listeners.forEach((listener) => listener());
}

/**
 * 넓은 화면 왼쪽 메뉴의 접힘(48px 아이콘 레일) — 작업대 실행 명세 §5, ADR 0042 결정 5. 셸 뿌리(메뉴 폭 변수)와 왼쪽 메뉴가 같은 값을 봅니다.
 * 펼친 폭은 따로 기억합니다(hooks/useNavWidth — 접었다 펴면 그 폭으로).
 * 읽기·쓰기는 모두 try/catch — 저장소를 못 써도 화면은 그려지고 이 창 안에서는 접고 펼 수 있습니다.
 *
 * @returns `[접힘, 접기·펼치기, 접힘 정하기]` — 셋째는 폭 손잡이(끌어서 접거나 펼침)가 씁니다.
 */
export function useNavCollapsed(): [boolean, () => void, SetNavCollapsed] {
  const collapsed = useSyncExternalStore(subscribe, read, serverSnapshot);
  const toggle = useCallback(() => write(!read(), true), []);
  const set = useCallback<SetNavCollapsed>((next, options) => write(next, options?.persist !== false), []);
  return [collapsed, toggle, set];
}
