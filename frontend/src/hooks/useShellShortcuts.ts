"use client";

import { useEffect, useRef } from "react";
import { isWideShell, sendShellCommand } from "@/lib/shellCommands";
import { findScreenFilter, isInMenu, isPaletteChord, singleKeyShortcut } from "@/lib/shortcuts";

/**
 * 셸 단축키 — 창(window) keydown 처리기 하나로 셸 단축키를 받습니다(작업대 실행 명세 §5 '단축키', P3). 명령 팔레트(SearchCommand)가 한 번만
 * 부릅니다 — 셸 전체에 전역 처리기가 하나뿐이게. 판정은 lib/shortcuts가 합니다.
 *
 * - 팔레트 화음(맥 ⌘K, 그 밖 Ctrl+K): 브라우저의 같은 단축키(주소창 검색)보다 먼저 받아 기본 동작을 막고 `onPalette`를 부릅니다. 입력칸 안에서도
 *   받습니다. 한글 조합 중이면 받지 않습니다(조합을 끝낸 뒤 다시 누르면 엶). 열린 메뉴(계정 메뉴) 안이면 기본 동작만 막고 열지 않습니다(메뉴 위에
 *   겹쳐 열면 고른 뒤에도 메뉴가 남음 — Esc로 닫은 뒤 다시 누름).
 * - 한 글자 키(입력칸·편집 영역·덮개 안·한글 조합 중·수식키·키 반복이면 끔 — 글자로 들어감). 다른 처리기가 이미 쓴 키(defaultPrevented)는 건드리지
 *   않습니다.
 *   - `?`: `onHelp`(단축키 도움말 창).
 *   - `/`: 본문(main#main)의 거르기 칸(data-shell-filter)에 포커스하고 글을 고릅니다. 칸이 없으면 아무것도 하지 않습니다(브라우저 기본 그대로).
 *   - `[`: 넓은 화면(왼쪽 메뉴가 보이는 폭)에서만 셸 명령 `toggle-nav`를 보냅니다(왼쪽 메뉴가 받아 접고 폄). 좁은 화면이면 아무것도 하지 않습니다.
 *
 * 쓰기 동작(서버를 부르는 것)은 없습니다 — 화면 상태만 바꿉니다(명세 §9-6).
 * 받는 쪽 함수는 그릴 때마다 새로 만들어도 됩니다(마지막 것을 부름 — 처리기를 다시 걸지 않음).
 */
export function useShellShortcuts({ isMac, onPalette, onHelp }: { isMac: boolean; onPalette: () => void; onHelp: () => void }) {
  const handlers = useRef({ onPalette, onHelp });
  useEffect(() => {
    handlers.current = { onPalette, onHelp };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isPaletteChord(event, isMac)) {
        event.preventDefault();
        // 열린 메뉴 안이면 팔레트를 겹쳐 열지 않습니다 — 고른 뒤 화면을 옮겨도 메뉴가 열린 채 남습니다(lib/shortcuts isInMenu). 브라우저의
        // 같은 단축키(주소창 검색)도 막아 둡니다(메뉴가 포커스를 그대로 가짐).
        if (isInMenu(event.target)) return;
        handlers.current.onPalette();
        return;
      }
      if (event.defaultPrevented) return;
      const shortcut = singleKeyShortcut(event);
      if (shortcut === "help") {
        event.preventDefault();
        handlers.current.onHelp();
      } else if (shortcut === "filter") {
        const field = findScreenFilter(document.getElementById("main"));
        if (!field) return;
        event.preventDefault();
        field.focus();
        field.select?.();
      } else if (shortcut === "toggleNav" && isWideShell()) {
        event.preventDefault();
        sendShellCommand("toggle-nav");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMac]);
}
