"use client";

import { useSyncExternalStore } from "react";
import { RECENT_STORAGE_KEY, parseRecent, pushRecent, serializeRecent, type RecentEntity } from "@/lib/palette";

/**
 * 최근 연 대상(명령 팔레트의 '최근 연 대상' 묶음 — 형식은 lib/palette) — 보는 사람별 편의라 이 브라우저의 localStorage에만 둡니다.
 *
 * - 모든 읽기·쓰기는 try/catch입니다. 저장소를 못 쓰면(사생활 보호 창·막힌 사이트 자료) 이 창 안에서만 기억하고, 못 읽으면 빈 목록으로 시작합니다 —
 *   어느 쪽이든 화면은 그대로 그려집니다.
 * - 다른 탭에서 바꾸면 storage 이벤트로 따라옵니다.
 * - 서버 렌더·하이드레이션 첫 그림은 빈 목록입니다(값은 브라우저에만 있음).
 * - `rememberRecentEntity`는 팔레트가 대상을 고를 때 부르고, P4의 상세 화면도 방문을 넣을 때 같은 함수를 부릅니다.
 */

const EMPTY: readonly RecentEntity[] = [];
const listeners = new Set<() => void>();
/** 지금 목록 — 처음 읽을 때 저장소에서 채웁니다(같은 값이면 같은 배열 — useSyncExternalStore가 다시 그리지 않음). */
let current: readonly RecentEntity[] | null = null;

function readStored(): readonly RecentEntity[] {
  try {
    return parseRecent(window.localStorage.getItem(RECENT_STORAGE_KEY));
  } catch {
    return EMPTY;
  }
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  // key가 null이면 저장소 전체를 비운 것(clear()).
  if (event.key !== null && event.key !== RECENT_STORAGE_KEY) return;
  current = readStored();
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): readonly RecentEntity[] {
  if (current === null) current = readStored();
  return current;
}

const getServerSnapshot = (): readonly RecentEntity[] => EMPTY;

/** 최근 연 대상 목록(최신 순, 최대 8개). */
export function useRecentEntities(): readonly RecentEntity[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** 대상 하나를 맨 앞에 넣습니다(같은 주소의 옛 항목은 빠짐). 형식 밖이면 아무 일도 없습니다. 저장에 실패해도 이 창 안에서는 기억합니다. */
export function rememberRecentEntity(entity: RecentEntity): void {
  const next = pushRecent(getSnapshot(), entity);
  current = next;
  try {
    window.localStorage.setItem(RECENT_STORAGE_KEY, serializeRecent(next));
  } catch {
    // 저장소를 못 쓰면 이 창 안에서만 기억합니다.
  }
  notify();
}

/** 시험용 — 모듈 상태를 비워 다음 읽기가 저장소에서 다시 채우게 합니다. */
export function resetRecentEntitiesForTest(): void {
  current = null;
  notify();
}
