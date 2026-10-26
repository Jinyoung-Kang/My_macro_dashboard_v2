/**
 * 화면 테마(시스템·라이트·다크) 규칙 — React를 모르는 순수 함수(ADR 0004).
 *
 * 기본은 "시스템 따름"입니다: `<html>`에 data-theme가 없으면 globals.css가 `prefers-color-scheme`을 따릅니다.
 * 사용자가 라이트·다크를 고르면 localStorage["theme"]에 저장하고 `<html data-theme>`를 붙입니다.
 * 저장 키와 첫 페인트 전 스크립트를 여기 한 곳에 두고 루트 레이아웃과 useTheme 훅이 같이 씁니다(두 곳의 규칙이 어긋나지 않게).
 */

export type ThemeChoice = "system" | "light" | "dark";

/** 고르는 순서(테마 전환 단추의 순서). */
export const THEME_CHOICES: readonly ThemeChoice[] = ["system", "light", "dark"];

/** localStorage 키. 바꾸면 이미 저장된 선택이 사라집니다. */
export const THEME_STORAGE_KEY = "theme";

/** `<html>`에 붙이는 속성 이름 — globals.css의 `:root[data-theme="dark"]`와 짝입니다. */
export const THEME_ATTRIBUTE = "data-theme";

/** 저장값 해석 — "light"·"dark"만 명시 선택이고, 없거나 모르는 값은 시스템 따름입니다. */
export function parseTheme(raw: unknown): ThemeChoice {
  return raw === "light" || raw === "dark" ? raw : "system";
}

/** getItem·setItem·removeItem만 쓰는 저장소(테스트에서 가짜를 넘김). */
export type ThemeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** 저장된 선택. 저장소가 없거나 막혀 있으면(사생활 보호 창 등 — 접근이 예외를 던짐) 시스템 따름. */
export function readStoredTheme(storage: ThemeStorage | null | undefined): ThemeChoice {
  if (!storage) return "system";
  try {
    return parseTheme(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

/**
 * 선택을 저장하고 저장했는지 돌려줍니다. 시스템 따름은 키를 지웁니다(저장값이 없으면 시스템을 따름).
 * 저장소가 막혀 있어도 던지지 않습니다 — 부르는 쪽이 이번 화면에만 적용하고, 다음 방문은 시스템 따름으로 돌아갑니다.
 */
export function writeStoredTheme(storage: ThemeStorage | null | undefined, choice: ThemeChoice): boolean {
  if (!storage) return false;
  try {
    if (choice === "system") storage.removeItem(THEME_STORAGE_KEY);
    else storage.setItem(THEME_STORAGE_KEY, choice);
    return true;
  } catch {
    return false;
  }
}

/** setAttribute·removeAttribute만 쓰는 문서(테스트에서 가짜를 넘김). */
export type ThemeDocument = { documentElement: Pick<Element, "setAttribute" | "removeAttribute"> };

/** 선택을 `<html>`에 적용합니다. 시스템 따름은 속성을 지워 CSS 미디어 쿼리에 맡깁니다. */
export function applyTheme(doc: ThemeDocument, choice: ThemeChoice): void {
  if (choice === "system") doc.documentElement.removeAttribute(THEME_ATTRIBUTE);
  else doc.documentElement.setAttribute(THEME_ATTRIBUTE, choice);
}

/**
 * `<head>`의 인라인 스크립트 — 하이드레이션 전에, 저장된 명시 선택(light|dark)만 붙입니다(첫 페인트부터 그 테마, 깜빡임 없음).
 * React가 실행하지 않는 문자열이라 위 함수들을 쓸 수 없어 같은 규칙을 ES5로 다시 적습니다(테스트가 둘을 대조).
 * localStorage 접근이 막힌 브라우저에서는 조용히 시스템 따름으로 둡니다.
 */
export const THEME_SCRIPT =
  `(function(){try{var t=window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});` +
  `if(t==="light"||t==="dark")document.documentElement.setAttribute(${JSON.stringify(THEME_ATTRIBUTE)},t)}catch(e){}})()`;
