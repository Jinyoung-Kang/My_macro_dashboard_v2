/*
 * 대상 화면의 칸 틀 — 정보 검색 대상 화면(search/entityGrid.ts)에서 옮긴 클래스 두 개. 정보 검색은 같은 이름(ENTITY_GRID·ENTITY_LEFT)으로 다시 내보내 씁니다
 * (겉모습 고정 — components/screens/search/__tests__/entityGridPin.test.ts). 칸 폭과 기준 폭의 셈은 entityGrid.ts 머리 주석에 있습니다.
 */

/** 칸 틀 — lg 두 칸, xl 세 칸. 자식은 왼쪽(ENTITY_FRAME_LEFT) · 가운데 · 오른쪽 차례입니다(바뀌는 것은 자리뿐 — 읽는 차례·Tab 차례는 그대로). */
export const ENTITY_FRAME =
  "lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:grid-rows-[auto_1fr] xl:grid-cols-[13rem_minmax(0,1fr)_18rem] xl:grid-rows-none";

/** 왼쪽 칸 — lg는 가운데와 그 아래 오른쪽 칸의 두 줄을 차지합니다. */
export const ENTITY_FRAME_LEFT = "lg:row-span-2 xl:row-span-1";
