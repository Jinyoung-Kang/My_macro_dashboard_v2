"use client";

import { useCallback, useSyncExternalStore } from "react";
import { DEFAULT_LIVE_SECONDS, LIVE_SECONDS_STORAGE_KEY, normalizeLiveSeconds, storedLiveSeconds } from "@/lib/livePrices";

/**
 * 실시간 시세 주기(초) — 이 브라우저에 하나(localStorage, lib/livePrices). 같은 화면의 장중 카드·보유 표·종목 상세가 같은 값을 보고, 한 곳에서
 * 바꾸면 모두 따라 바뀝니다(다른 탭은 storage 이벤트로). localStorage를 못 쓰면 이번 세션의 값만 씁니다.
 */
const listeners = new Set<() => void>();
let current: number | null = null;

function read(): number {
  if (current === null) {
    try {
      current = storedLiveSeconds(window.localStorage);
    } catch {
      current = DEFAULT_LIVE_SECONDS;
    }
  }
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== LIVE_SECONDS_STORAGE_KEY) return;
    current = normalizeLiveSeconds(event.newValue);
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** 시험이 모듈의 기억을 지웁니다. */
export function resetLiveSecondsForTest(): void {
  current = null;
}

export function useLiveSeconds(): [number, (seconds: number) => void] {
  const seconds = useSyncExternalStore(subscribe, read, () => DEFAULT_LIVE_SECONDS);
  const update = useCallback((next: number) => {
    current = normalizeLiveSeconds(next);
    try {
      window.localStorage.setItem(LIVE_SECONDS_STORAGE_KEY, String(current));
    } catch {
      // 기억만 못 할 뿐 이번 세션에서는 그대로 동작합니다
    }
    listeners.forEach((listener) => listener());
  }, []);
  return [seconds, update];
}
