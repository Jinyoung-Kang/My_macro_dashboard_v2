/**
 * 렌더 예외 화면(app/error.tsx·app/global-error.tsx·app/(dashboard)/error.tsx — QA-920)의 글과 오류 번호 읽기. React 없는 순수 모듈입니다.
 *
 * 글은 없는 주소 화면(QA-270·QA-864)과 같은 꼴 — 제목 한 줄, 낱말 사이에서만 꺾는 안내 한 줄, 돌아갈 곳은 홈 하나. 예외 메시지는 보이지 않습니다
 * (서버 컴포넌트의 예외는 운영 빌드에서 일반 문구로 바뀌어 오고, 클라이언트 예외의 원문은 사용자가 할 일을 알려 주지 않음). 서버 쪽 예외는 서버 기록과
 * 맞춰 볼 수 있게 Next가 붙인 digest만 '오류 번호'로 적습니다.
 */

/** 제목(h1). */
export const ERROR_SCREEN_TITLE = "화면을 표시하지 못했습니다";

/** 안내 한 줄. */
export const ERROR_SCREEN_TEXT = "화면을 그리는 중 문제가 생겼습니다. 다시 시도해도 같으면 홈에서 다시 찾아 주세요.";

/** 경계의 reset을 부르는 단추 글. */
export const ERROR_RETRY_LABEL = "다시 시도";

/**
 * global-error의 탭 제목 — 루트 레이아웃(metadata)을 대신하므로 스스로 둡니다. 앱 이름은 lib/nav APP_TITLE과 같은 글이고(시험이 대조), 메뉴 목록 모듈을
 * 모든 경로가 받는 전체 오류 경계 묶음에 싣지 않으려고 가져오지 않습니다.
 */
export const ERROR_DOCUMENT_TITLE = `${ERROR_SCREEN_TITLE} · 매크로 대시보드`;

/** Next가 서버 쪽 예외에 붙인 digest(서버 기록과 맞춰 볼 번호). 없거나 문자열이 아니면 null. */
export function errorDigest(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const digest = (error as { digest?: unknown }).digest;
  return typeof digest === "string" && digest.trim() ? digest.trim() : null;
}
