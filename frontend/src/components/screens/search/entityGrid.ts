/*
 * 대상 화면의 칸 틀 — 결과 탭(FeedPanel)과 보유·연결 탭(EntityView)이 같이 씁니다.
 *
 * 세 칸(왼쪽 13rem · 가운데 · 오른쪽 18rem)은 xl(1280) 이상만입니다. 왼쪽 메뉴가 생기는 lg(1024~1279)에서는 세 칸이면 가운데가 너무 좁아
 * 타임라인 줄의 고정 칸(340px)이 오른쪽 속성 칸으로 넘쳤습니다(QA-420 — 그때 왼쪽 메뉴 232px로 결과 패널 안쪽 669~924px, 가운데 173~428px).
 * 그래서 lg는 두 칸이고 오른쪽 칸은 가운데 아래로 갑니다. 왼쪽 칸이 두 줄을 차지해 세로 경계가 끝까지 이어지고, 둘째 줄을 1fr로 두어 왼쪽 칸이
 * 길어도 오른쪽 칸이 가운데 바로 밑에 붙습니다.
 * 폭은 펼친 나무 메뉴 220px·본문 스크롤 막대 15px 기준입니다(작업대 P3 — 접으면 메뉴가 48px라 모두 172px 넓음, 셈은 SearchQaLayout.test가 고정):
 * lg 결과 패널 안쪽 681~936px, 가운데 473~728px · xl 1280 가운데 441px · 1440 601px. 타임라인 줄의 배치는 창 폭이 아니라 결과 목록의 폭
 * (@container 36rem — FeedPanel)으로 정합니다. 가운데가 576px 미만인 lg 1024~약 1126·xl 1280~약 1414는 두 칸(시각 · 제목 두 줄까지 + 종류 · 매체 줄 —
 * 1280 제목 칸 333px)이고, 그 밖(1180 629px·1279 728px·1440 601px)은 네 칸(제목 칸 236px 이상 — 1440 261px)입니다. 네 칸을 창 폭(lg)으로 가르던
 * 때는(왼쪽 메뉴 232px) 1280에서 제목 칸이 89px, 1024에서 121px였습니다.
 * 고른 줄의 미리 보기도 xl부터 오른쪽 칸, 그 아래는 화면 아래 시트이고(FeedPanel), 속성 칸의 안내 글(EntityParts AttributesPanel)도 이 기준으로
 * 가릅니다 — 기준 폭을 바꾸면 함께 고칩니다.
 * 클래스 글은 공용 패턴(components/patterns/SplitPane — ENTITY_FRAME·ENTITY_FRAME_LEFT)으로 옮겼고 여기서는 같은 이름으로 다시 내보냅니다(작업대 P4, 글자 그대로 — entityGridPin.test).
 */

/** 칸 틀 — lg 두 칸, xl 세 칸(ENTITY_GRID), 왼쪽 칸 — lg는 두 줄(ENTITY_LEFT). 자식은 왼쪽 · 가운데 · 오른쪽 차례입니다. */
export { ENTITY_FRAME as ENTITY_GRID, ENTITY_FRAME_LEFT as ENTITY_LEFT } from "@/components/patterns";
