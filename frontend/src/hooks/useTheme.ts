"use client";

import { useCallback, useLayoutEffect, useSyncExternalStore } from "react";
import { applyTheme, readStoredTheme, THEME_STORAGE_KEY, writeStoredTheme, type ThemeChoice } from "@/lib/theme";

/** 같은 탭 안의 다른 테마 전환 단추에게 알리는 이벤트(데스크톱 왼쪽 내비와 더보기 화면에 함께 있을 때). */
const THEME_CHANGE_EVENT = "macrodash:theme-change";

/** 브라우저 저장소. 서버 렌더에는 없고, 막힌 브라우저에서는 접근 자체가 예외를 던집니다. */
function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void): () => void {
  // 다른 탭에서 바꾼 선택(storage 이벤트)은 이 탭의 <html>에도 적용합니다 — 단추 표시와 실제 테마가 어긋나지 않게.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
    applyTheme(document, readStoredTheme(browserStorage()));
    onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
  };
}

/** 저장하지 못한 이번 탭의 선택(막힌 저장소) — 단추 표시가 실제 적용된 테마와 같게 남도록 기억합니다. */
let unsaved: ThemeChoice | null = null;

const snapshot = (): ThemeChoice => unsaved ?? readStoredTheme(browserStorage());
// 서버 렌더와 하이드레이션 첫 렌더는 "시스템"으로 같게 그립니다(저장값은 브라우저에만 있음 — 불일치 경고 방지).
const serverSnapshot = (): ThemeChoice => "system";

/**
 * 테마 선택(시스템·라이트·다크)과 바꾸는 함수.
 *
 * 첫 페인트의 테마는 루트 레이아웃의 인라인 스크립트(lib/theme.ts THEME_SCRIPT)가 이미 붙였습니다. 이 훅은
 * dev의 React Strict Mode 재마운트가 `<html>`의 data-theme를 JSX 값(없음)으로 되돌린 것을 레이아웃 효과에서 다시 붙입니다
 * (Next 가이드 preventing-flash-before-hydration "Re-applying attributes in development" — 운영 빌드에서는 같은 값을 다시 쓸 뿐).
 */
export function useTheme(): { theme: ThemeChoice; setTheme: (choice: ThemeChoice) => void } {
  const theme = useSyncExternalStore(subscribe, snapshot, serverSnapshot);

  useLayoutEffect(() => {
    // 명시 선택만 다시 붙입니다. "시스템"이면 아무것도 하지 않습니다(스크립트가 붙인 값을 지우지 않게).
    const stored = snapshot();
    if (stored !== "system") applyTheme(document, stored);
  }, []);

  const setTheme = useCallback((choice: ThemeChoice) => {
    unsaved = writeStoredTheme(browserStorage(), choice) ? null : choice;
    applyTheme(document, choice);
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }, []);

  return { theme, setTheme };
}
