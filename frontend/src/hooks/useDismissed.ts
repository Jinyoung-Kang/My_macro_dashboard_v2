"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 닫은 안내의 키 목록 — 이 브라우저의 저장소에 둡니다(다른 기기·창과 나누지 않음). 저장소를 쓸 수 없으면(사생활 보호 창 등) 이 창 안에서만 기억합니다.
 *
 * @param storageKey 저장소 키
 * @returns `[닫은 키, 닫기(지금 보이는 키 전부)]`
 */
export function useDismissed(storageKey: string): [string[], (keys: readonly string[]) => void] {
  const [dismissed, setDismissed] = useState<string[]>([]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) setDismissed(parsed.filter((value): value is string => typeof value === "string"));
    } catch {
      // 저장소를 읽지 못하면 아무것도 닫지 않은 것으로 봅니다.
    }
  }, [storageKey]);

  const dismiss = useCallback(
    (keys: readonly string[]) => {
      setDismissed((previous) => {
        const next = [...new Set([...previous, ...keys])].slice(-200);
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // 저장하지 못해도 이 창에서는 닫힌 채로 둡니다.
        }
        return next;
      });
    },
    [storageKey],
  );

  return [dismissed, dismiss];
}
