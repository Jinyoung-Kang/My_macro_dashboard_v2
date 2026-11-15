/*
 * 대상 화면의 칸 틀 — 결과 탭(FeedPanel)과 보유·연결 탭(EntityView)이 같이 씁니다.
 *
 * 세 칸(왼쪽 13rem · 가운데 · 오른쪽 18rem)은 xl(1280) 이상만입니다. 왼쪽 메뉴(232px)가 생기는 lg(1024~1279)에서는 결과 패널 안쪽이
 * 669~924px(본문 스크롤 막대 15px 기준)라 세 칸이면 가운데가 173~428px뿐이었고, 타임라인 줄의 고정 칸(340px)이 오른쪽 속성 칸으로
 * 넘쳤습니다(QA-420). 그래서 lg는 두 칸(왼쪽 · 가운데 461~716px)이고 오른쪽 칸은 가운데 아래로 갑니다. 왼쪽 칸이 두 줄을 차지해
 * 세로 경계가 끝까지 이어지고, 둘째 줄을 1fr로 두어 왼쪽 칸이 길어도 오른쪽 칸이 가운데 바로 밑에 붙습니다.
 * xl 1280의 가운데는 429px(1440은 589px — 그대로)입니다.
 * 고른 줄의 미리 보기도 xl부터 오른쪽 칸, 그 아래는 화면 아래 시트이고(FeedPanel), 속성 칸의 안내 글(EntityParts AttributesPanel)도 이 기준으로
 * 가릅니다 — 기준 폭을 바꾸면 함께 고칩니다.
 */

/** 칸 틀 — lg 두 칸, xl 세 칸. 자식은 왼쪽(ENTITY_LEFT) · 가운데 · 오른쪽 차례입니다(바뀌는 것은 자리뿐 — 읽는 차례·Tab 차례는 그대로). */
export const ENTITY_GRID =
  "lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:grid-rows-[auto_1fr] xl:grid-cols-[13rem_minmax(0,1fr)_18rem] xl:grid-rows-none";

/** 왼쪽 칸 — lg는 가운데와 그 아래 오른쪽 칸의 두 줄을 차지합니다. */
export const ENTITY_LEFT = "lg:row-span-2 xl:row-span-1";
