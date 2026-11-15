/**
 * 없앤 테마 선택이 브라우저에 남긴 값 지우기 — React를 모르는 순수 모듈(ADR 0004).
 *
 * 2026-11-15까지는 화면 테마(시스템·라이트·다크)를 고르면 localStorage["theme"]에 남겼습니다. 앱이 어두운 한 벌 하나가 되며(ADR 0042 결정 2)
 * 그 값은 읽지 않고, 첫 페인트 전 인라인 스크립트(루트 레이아웃)가 try/catch 안에서 지우기만 합니다. 저장소가 막힌 브라우저(사생활 보호 창 등)에서는
 * 조용히 넘어갑니다 — 지우지 못해도 화면은 같습니다. 남은 값이 모두 지워질 만큼 지나면 이 모듈과 스크립트를 함께 지워도 됩니다.
 *
 * 밝은 한 벌을 다시 더할 때: 색은 globals.css의 CSS 변수 토큰으로만 쓰므로 토큰 블록 하나(값 후보는 실행 명세 §3-2-2)와 고르는 방법을 더하면 됩니다.
 * 그때는 이 옛 키를 다시 쓰지 말고 새 키를 써서, 지난 선택이 새 테마에 섞여 들지 않게 합니다.
 */

/** 옛 테마 선택의 localStorage 키 — 읽지 않고 지우기만 합니다. */
export const LEGACY_THEME_KEY = "theme";

/** `<head>`의 인라인 스크립트 — React가 실행하지 않는 문자열이라 ES5로 적습니다(시험이 실제로 돌려 봄). */
export const LEGACY_THEME_CLEANUP_SCRIPT = `(function(){try{window.localStorage.removeItem(${JSON.stringify(LEGACY_THEME_KEY)})}catch(e){}})()`;
