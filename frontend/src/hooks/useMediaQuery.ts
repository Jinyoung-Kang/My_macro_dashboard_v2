"use client";

import { useCallback, useSyncExternalStore } from "react";

/** 서버 렌더·첫 하이드레이션 값 — 맞지 않음(질의가 참일 때만 바뀌는 배치는 그다음 그리기에서 켜짐). */
const serverSnapshot = () => false;

/**
 * 미디어 질의가 맞는가를 그리기 값으로 — 창 폭이 바뀌면 다시 그립니다(`useWideShell`과 같은 꼴, 질의를 받음). matchMedia가 없으면(서버·오래된 브라우저)
 * 거짓입니다. 질의가 참일 때만 배치를 바꾸는 쪽으로 씁니다 — 거짓(모름)이 기본 배치가 되게(예: 좁은 화면만 두 줄 행이면 '(width < 48rem)').
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(query);
      // 오래된 브라우저·시험 대역은 addEventListener가 없을 수 있습니다 — 그때는 폭이 바뀌어도 따라가지 않을 뿐 값은 읽힙니다.
      list.addEventListener?.("change", onChange);
      return () => list.removeEventListener?.("change", onChange);
    },
    [query],
  );
  const snapshot = useCallback(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    [query],
  );
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
