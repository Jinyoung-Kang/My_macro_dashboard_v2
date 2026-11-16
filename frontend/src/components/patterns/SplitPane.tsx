import type { JSX, ReactNode } from "react";

// 칸 틀 클래스(ENTITY_FRAME·ENTITY_FRAME_LEFT)는 정보 검색 대상 화면과 함께 쓰므로 순수 모듈 components/ui/classes.ts에 있습니다 — 정보 검색이
// 이 배럴을 거치지 않고 가져가게(겉모습 고정 — components/screens/search/__tests__/entityGridPin.test.ts).
import { ENTITY_FRAME, ENTITY_FRAME_LEFT } from "@/components/ui/classes";

/** 칸 하나 — 안의 패널을 위에서 아래로 12px(lg 16px) 사이로 쌓습니다(명세 §3-7 패널 사이 8~12px — 칸 틀의 칸 사이와 같은 값). */
const COLUMN = "flex min-w-0 flex-col gap-3 lg:gap-4";

/**
 * 칸 틀(작업대 실행 명세 §6 SplitPane, P4 — 상세 화면 셋): 왼쪽 속성 · 가운데 탭 · 오른쪽 연결·출처.
 *
 * - 넓은 화면은 정보 검색 대상 화면과 같은 틀입니다(ENTITY_FRAME — 바꾸면 정보 검색 겉모습이 바뀌므로 entityGridPin.test가 막음): xl(1280) 이상 세 칸
 *   (13rem · 나머지 · 18rem), lg(1024~1279)는 두 칸이고 오른쪽 칸이 가운데 아래로 갑니다(왼쪽 칸이 두 줄을 차지). lg 미만은 한 칸으로 위에서 아래로
 *   왼쪽 → 가운데 → 오른쪽입니다.
 * - 읽는 차례·Tab 차례는 늘 왼쪽 → 가운데 → 오른쪽이고 자리만 바뀝니다. 새 랜드마크를 만들지 않습니다 — 칸 안 패널 제목(h2)이 구조입니다.
 * - 칸 사이와 칸 안 패널 사이는 12px(lg 16px).
 */
export function SplitPane({ left, children, right }: { left: ReactNode; children: ReactNode; right: ReactNode }): JSX.Element {
  return (
    <div className={`${COLUMN} ${ENTITY_FRAME}`}>
      <div className={`${COLUMN} ${ENTITY_FRAME_LEFT}`}>{left}</div>
      <div className={COLUMN}>{children}</div>
      <div className={COLUMN}>{right}</div>
    </div>
  );
}
