/**
 * 실행 중인 코드의 버전(브랜치@커밋)과 그 커밋의 날짜(KST, 최종 수정일).
 *
 * 빌드 시점에 번들에 들어갑니다. NEXT_PUBLIC_ 값은 런타임에 바뀌지 않으므로 여기 적힌 값이 곧 "이 화면을 만든 코드"입니다.
 * 그릴 때 읽습니다(모듈 최상위 상수로 읽으면 테스트의 vi.stubEnv가 먹지 않음). 날짜 형식이 아니면 표시하지 않습니다.
 */
function buildInfo(): { version?: string; updated?: string } {
  const updated = process.env.NEXT_PUBLIC_APP_UPDATED;
  return {
    version: process.env.NEXT_PUBLIC_APP_VERSION || undefined,
    updated: updated && /^\d{4}-\d{2}-\d{2}$/.test(updated) ? updated : undefined,
  };
}

/**
 * 지금 화면이 "어느 코드"인지 항상 보이게 둡니다. git pull 뒤에도 화면이 그대로일 때, 코드를 못 받은 것인지 화면이 안 바뀐
 * 것인지 이 한 줄로 구분됩니다. 'make up'이 넣어 주며, 값이 없으면(직접 docker compose로 띄운 경우) 표시하지 않습니다.
 */
export function BuildInfo() {
  const build = buildInfo();
  return (
    <p className="text-xs leading-5 text-text-3">
      © 2026 My Macro Dashboard v2
      {build.version && (
        <span className="ml-1 tabular-nums" title="실행 중인 코드의 브랜치@커밋">
          · {build.version}
        </span>
      )}
      {build.updated && (
        <span className="block tabular-nums" title="실행 중인 코드의 마지막 커밋 날짜(KST)">
          최종 수정 {build.updated}
        </span>
      )}
    </p>
  );
}
