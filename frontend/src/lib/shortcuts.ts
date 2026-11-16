/**
 * 셸 단축키 — 단축키 표(도움말 창이 그리는 줄)와 키 판정을 React 없이 둡니다(ADR 0004, 작업대 실행 명세 §5 '단축키', P3).
 *
 * - 명령 팔레트 화음(맥 ⌘K, 그 밖 Ctrl+K)은 입력칸 안에서도 받습니다 — 어디서든 검색을 여는 키입니다(지금 시험이 고정).
 * - 한 글자 단축키(? · / · [)는 글을 쓰는 중이면 글자로 들어가야 하므로 끕니다: 입력칸·편집 영역·role textbox/combobox/searchbox 안,
 *   덮개(대화상자·메뉴) 안, 한글 조합 중, Ctrl·⌘·Alt와 함께, 키를 누르고 있어 반복될 때.
 * - Esc는 열린 대화상자·메뉴(Radix)가 닫습니다 — 셸이 따로 듣지 않습니다. 목록 j/k는 P4 목록 부품의 몫입니다(그때 이 표에 '목록' 줄을 더함).
 *
 * 키 대상은 DOM 요소 그대로가 아니라 쓰는 속성만 적은 구조 타입입니다(lib/infoSearch의 ShortcutTarget과 같은 방식).
 */

/** 단축키 표의 줄 이름(닫힌 목록). */
export type ShortcutId = "palette" | "help" | "filter" | "toggleNav" | "close" | "move";

export type Shortcut = {
  id: ShortcutId;
  /** 키 글 조각(조각마다 kbd 하나) — 맥과 그 밖. */
  keys: { mac: readonly string[]; other: readonly string[] };
  /** 화면 읽기 프로그램이 읽을 키 이름 — 기호 조각이 그대로 읽히기 어려울 때만(없으면 조각을 그대로 읽음). */
  spoken?: string;
  /** 하는 일. */
  action: string;
  /** 보이는 조건 — wide: 넓은 화면(왼쪽 메뉴가 보이는 폭)에서만, filter: 지금 화면에 거르기 칸이 있을 때만. */
  when?: "wide" | "filter";
};

/** 단축키 표(닫힌 목록) — 도움말 창이 이 순서로 그립니다. */
export const SHORTCUTS: readonly Shortcut[] = [
  { id: "palette", keys: { mac: ["⌘K"], other: ["Ctrl K"] }, action: "명령 팔레트(통합 검색) 열기" },
  { id: "help", keys: { mac: ["?"], other: ["?"] }, action: "단축키 도움말" },
  { id: "filter", keys: { mac: ["/"], other: ["/"] }, action: "이 화면의 거르기 칸으로", when: "filter" },
  { id: "toggleNav", keys: { mac: ["["], other: ["["] }, action: "왼쪽 메뉴 접기·펼치기", when: "wide" },
  { id: "close", keys: { mac: ["Esc"], other: ["Esc"] }, action: "열린 창·메뉴 닫기" },
  {
    id: "move",
    keys: { mac: ["↑", "↓", "Enter"], other: ["↑", "↓", "Enter"] },
    spoken: "위·아래 화살표와 Enter",
    action: "팔레트 결과 고르기·열기",
  },
];

/** 화면이 자기 거르기 입력칸 하나에 붙이는 속성 — '/'가 그 칸으로 갑니다(화면당 하나, #main 안 첫 번째). */
export const SHELL_FILTER_ATTR = "data-shell-filter";

/** 키를 받은 요소에서 쓰는 속성만 적은 구조 타입. */
export type KeyTarget = {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
} | null;

/** 판정에 쓰는 키 이벤트 속성. */
export type KeyEventLike = {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  target?: KeyTarget | EventTarget | null;
};

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const TYPING_ROLES = new Set(["textbox", "combobox", "searchbox"]);

/** 글을 쓰는 자리인가 — 입력칸·글 상자·고르기 상자·편집 영역·role textbox/combobox/searchbox. */
export function isTypingTarget(target: KeyTarget | EventTarget | null | undefined): boolean {
  const element = target as KeyTarget | undefined;
  if (!element) return false;
  if (TYPING_TAGS.has((element.tagName ?? "").toUpperCase()) || element.isContentEditable) return true;
  const role = typeof element.getAttribute === "function" ? element.getAttribute("role") : null;
  return role !== null && TYPING_ROLES.has(role.trim().toLowerCase());
}

/** 덮개(대화상자·경고 대화상자·메뉴) 안인가 — 그 안의 키는 그 덮개가 씁니다. */
export function isInOverlay(target: KeyTarget | EventTarget | null | undefined): boolean {
  const element = target as KeyTarget | undefined;
  return Boolean(
    element && typeof element.closest === "function" && element.closest('[role="dialog"],[role="alertdialog"],[role="menu"]'),
  );
}

/**
 * 명령 팔레트를 여는 화음인가. 맥은 ⌘K만(Ctrl 없이) — 맥의 Ctrl+K는 입력칸의 기본 편집 명령(줄 끝까지 지우기)이라 가로채지 않습니다.
 * 그 밖은 화면 안내(Ctrl K)대로 Ctrl+K만(⌘·Windows 키 없이). Alt·Shift가 섞이면 아닙니다. 한글 자판이면 K 자리가 "ㅏ"로 오기도 해 물리 키(code)도
 * 봅니다(자동 완성이 보내는 keydown은 key가 없을 수 있음). 한글 조합 중(isComposing·keyCode 229)이면 아닙니다 — 조합 중인 글자를 확정하지 않은 채
 * 팔레트로 포커스가 옮겨 가면 입력기 상태가 꼬입니다(조합을 끝낸 뒤 다시 누르면 엶).
 */
export function isPaletteChord(event: KeyEventLike, isMac: boolean): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  const isK = event.key === "k" || event.key === "K" || event.code === "KeyK";
  const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return modifier && !event.altKey && !event.shiftKey && isK;
}

/** 한 글자 단축키 — 도움말(?)·거르기 칸(/)·왼쪽 메뉴 접기([). */
export type SingleKeyShortcut = "help" | "filter" | "toggleNav";

/**
 * 한 글자 단축키인가. 글을 쓰는 자리·덮개 안·한글 조합 중(isComposing·keyCode 229)·Ctrl/⌘/Alt와 함께·키 반복이면 null입니다.
 * ?는 Shift와 함께 오는 글자라 Shift는 막지 않습니다. [는 물리 키(BracketLeft)로도 받습니다(Shift 없이 — Shift면 '{').
 */
export function singleKeyShortcut(event: KeyEventLike): SingleKeyShortcut | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return null;
  if (event.isComposing || event.keyCode === 229) return null;
  if (isTypingTarget(event.target) || isInOverlay(event.target)) return null;
  if (event.key === "?") return "help";
  if (event.key === "/") return "filter";
  if (event.key === "[" || (event.code === "BracketLeft" && !event.shiftKey)) return "toggleNav";
  return null;
}

/** 거르기 칸 후보에서 쓰는 속성만 적은 구조 타입. */
export type FilterField = {
  disabled?: boolean;
  getAttribute(name: string): string | null;
  closest(selector: string): unknown;
  focus(): void;
  select?: () => void;
};

/** 거르기 칸을 찾을 뿌리(보통 본문 main#main). */
export type FilterRoot = { querySelectorAll(selector: string): ArrayLike<unknown> } | null | undefined;

/**
 * 화면의 거르기 칸 — 뿌리 안의 첫 번째 [data-shell-filter] 가운데 숨지 않았고(자신·조상에 hidden·aria-hidden="true"·inert 없음) 쓸 수 있는
 * (disabled·aria-disabled="true" 아님) 칸. 없으면 null — 그때 '/'는 브라우저 기본 동작 그대로입니다. 크기 계산은 쓰지 않습니다(jsdom에서도 같게).
 */
export function findScreenFilter(root: FilterRoot): FilterField | null {
  if (!root) return null;
  const candidates = Array.from(root.querySelectorAll(`[${SHELL_FILTER_ATTR}]`)) as FilterField[];
  for (const field of candidates) {
    if (field.disabled || field.getAttribute("aria-disabled") === "true") continue;
    if (field.closest('[hidden],[aria-hidden="true"],[inert]')) continue;
    return field;
  }
  return null;
}
