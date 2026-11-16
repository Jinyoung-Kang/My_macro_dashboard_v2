"use client";

import { useSyncExternalStore } from "react";
import { WIDE_SHELL_MEDIA, isWideShell } from "@/lib/shellCommands";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(WIDE_SHELL_MEDIA);
  // 오래된 브라우저·시험 대역은 addEventListener가 없을 수 있습니다 — 그때는 폭이 바뀌어도 따라가지 않을 뿐 값은 읽힙니다.
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

/** 서버 렌더·첫 하이드레이션 값 — 좁은 화면(넓은 화면 전용 동작은 그다음 그리기에서 켜짐). */
const serverSnapshot = () => false;

/**
 * 넓은 화면(lg 이상 — 왼쪽 메뉴가 보이는 폭, lib/shellCommands WIDE_SHELL_MEDIA)인가를 그리기 값으로 — 창 폭이 바뀌면 다시 그립니다.
 * 좁은 화면과 넓은 화면 모두에 있는 셸 조작이 넓은 화면에서만 다르게 동작할 때 씁니다(알림 벨의 이름 툴팁 — 작업대 실행 명세 §0 W2: 좁은 화면은 지금 구조).
 * matchMedia가 없으면(서버·오래된 브라우저) 거짓입니다.
 */
export function useWideShell(): boolean {
  return useSyncExternalStore(subscribe, isWideShell, serverSnapshot);
}
