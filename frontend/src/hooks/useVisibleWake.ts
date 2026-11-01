"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * 탭이 보일 때만 읽는 깨우기(QA-154). 돌려준 `wake()`는 탭이 보이면 곧바로 `read()`를 부르고, 숨겨져 있으면 미뤄 둔 표시만 남깁니다 — 탭이 다시
 * 보이면 미뤄 둔 것을 한 번 읽습니다. 다만 자동 갱신 주기(`refreshMs`)가 있으면 useApi가 탭 복귀 때 이미 한 번 읽으므로 부르지 않습니다(같은 요청이
 * 둘 나가지 않게). 장 밖처럼 주기가 0이면 useApi에 복귀 읽기가 없어 이 훅이 맡습니다.
 *
 * 타이머가 useApi의 `reload`를 바로 부르면 안 되는 까닭: reload는 탭이 보이는지 보지 않아 아무도 보지 않는 탭에서도 요청이 나갑니다. 장중
 * 시세(`/api/paper/live`)는 그 요청이 정규장이면 수집을 깨웁니다(시세는 화면을 볼 때만 받기로 한 결정 — ADR 0020).
 *
 * @param read      읽기(보통 useApi의 reload)
 * @param refreshMs 같은 화면의 useApi 자동 갱신 주기(ms, 0이면 없음)
 */
export function useVisibleWake(read: () => void, refreshMs: number): () => void {
  const pending = useRef(false);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible" || !pending.current) return;
      pending.current = false;
      if (refreshMs <= 0) read();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [read, refreshMs]);

  return useCallback(() => {
    if (document.visibilityState === "visible") {
      pending.current = false;
      read();
    } else {
      pending.current = true;
    }
  }, [read]);
}
