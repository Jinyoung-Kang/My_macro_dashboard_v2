/**
 * 지금 브라우저가 애플 플랫폼(맥·아이폰·아이패드)인가 — 브라우저에서만 부릅니다(navigator를 읽음, 서버 렌더에는 없음).
 * 셸 검색 단축키(맥 ⌘K, 그 밖 Ctrl K — components/shell SearchCommand)와 같은 화면 닻 링크의 Meta 누름(맥은 ⌘+누름이 새 탭이라 브라우저에 맡기고,
 * 그 밖은 같은 탭의 기본 해시 이동이라 맡지 않음 — lib/hashLink, QA-689)이 함께 씁니다.
 */
export const isMacPlatform = (): boolean => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
