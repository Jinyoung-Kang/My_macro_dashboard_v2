"use client";

import { useEffect, useRef } from "react";
import { isPaletteChord } from "@/lib/shortcuts";

/**
 * 셸 단축키 — 창(window) keydown 처리기 하나로 셸 단축키를 받습니다(작업대 실행 명세 §5 '단축키', P3). 명령 팔레트(SearchCommand)가 한 번만
 * 부릅니다 — 셸 전체에 전역 처리기가 하나뿐이게.
 *
 * - 팔레트 화음(맥 ⌘K, 그 밖 Ctrl+K — 판정은 lib/shortcuts `isPaletteChord`): 브라우저의 같은 단축키(주소창 검색)보다 먼저 받아 기본 동작을
 *   막고 `onPalette`를 부릅니다. 입력칸 안에서도 받습니다. 한글 조합 중이면 받지 않습니다(조합을 끝낸 뒤 다시 누르면 엶).
 *
 * 받는 쪽 함수는 그릴 때마다 새로 만들어도 됩니다(마지막 것을 부름 — 처리기를 다시 걸지 않음).
 */
export function useShellShortcuts({ isMac, onPalette }: { isMac: boolean; onPalette: () => void }) {
  const handlers = useRef({ onPalette });
  useEffect(() => {
    handlers.current = { onPalette };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isPaletteChord(event, isMac)) {
        event.preventDefault();
        handlers.current.onPalette();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMac]);
}
