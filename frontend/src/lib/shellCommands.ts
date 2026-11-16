/**
 * 셸 명령 신호 — 셸의 두 부분(배치: 왼쪽 메뉴·계정 메뉴 / 명령 팔레트·단축키)이 서로의 모듈을 가져오지 않고 주고받는 신호입니다
 * (작업대 실행 명세 §5, P3). 브라우저 창의 사용자 이벤트 하나(SHELL_COMMAND_EVENT)에 명령 이름을 실어 보냅니다 — 알림 읽음 신호
 * (lib/alerts의 ALERTS_READ_EVENT)와 같은 방식입니다.
 *
 * 명령은 모두 이 창 안의 화면 상태만 바꿉니다. 서버를 부르는 명령(쓰기)은 여기에 두지 않습니다 — 명령 팔레트·단축키에는 쓰기 동작이
 * 없습니다(ADR 0042 결정 5, 실행 명세 §9-6).
 */

/** 셸 명령을 싣는 창 이벤트 이름. */
export const SHELL_COMMAND_EVENT = "macrodash:shell-command";

/**
 * 명령 목록(닫힌 목록).
 * - toggle-nav: 넓은 화면의 왼쪽 메뉴를 아이콘 레일로 접거나 펼칩니다(보는 사람별로 기억 — 왼쪽 메뉴가 정함).
 * - open-shortcut-help: 단축키 도움말 창을 엽니다.
 */
export const SHELL_COMMANDS = ["toggle-nav", "open-shortcut-help"] as const;

export type ShellCommand = (typeof SHELL_COMMANDS)[number];

/** 왼쪽 메뉴(나무 메뉴·레일)가 보이는 폭 — Tailwind lg(64rem = 1024px)와 같습니다. */
export const WIDE_SHELL_MEDIA = "(min-width: 64rem)";

/** 알려진 명령 이름인가. */
export function isShellCommand(value: unknown): value is ShellCommand {
  return typeof value === "string" && (SHELL_COMMANDS as readonly string[]).includes(value);
}

/** 명령을 보냅니다. 듣는 쪽이 없으면 아무 일도 없습니다. */
export function sendShellCommand(command: ShellCommand): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ShellCommand>(SHELL_COMMAND_EVENT, { detail: command }));
}

/** 명령 하나를 듣습니다. 돌려준 함수를 부르면 그만 듣습니다(effect 정리용). */
export function onShellCommand(command: ShellCommand, listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handle = (event: Event) => {
    if (event instanceof CustomEvent && event.detail === command) listener();
  };
  window.addEventListener(SHELL_COMMAND_EVENT, handle);
  return () => window.removeEventListener(SHELL_COMMAND_EVENT, handle);
}

/** 넓은 화면(왼쪽 메뉴가 보이는 폭)인가. matchMedia가 없으면(서버·오래된 브라우저) 거짓입니다. */
export function isWideShell(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(WIDE_SHELL_MEDIA).matches;
}
