/**
 * 매크로 카드의 지연·알림 표시 규칙(순수 함수, ADR 0004).
 *
 * 지표 줄마다의 개장 상태와 시세 지연은 출처 배지 하나에 합칩니다(lib/marketRows macroCardSession — 지표 표의 기준 칸). 예전에는
 * '실시간' 배지와 '마감' 배지가 나란히 떠 서로 어긋나게 읽혔습니다.
 */
import { delayLabel } from "./format";
import type { MacroCategory } from "./types";

/**
 * 카테고리 부제 — 카드들의 시세 지연을 한 줄로. 모두 같으면 그 지연, 다르면 '종목마다 다름'.
 * 수집 실패·이어받은 값은 지금 시세의 지연이 아니라 뺍니다. 예전 저장본(delayMinutes 없음)은 수집기가 적은 요약을 씁니다.
 */
export function categoryDelay(category: MacroCategory): string | undefined {
  const live = category.items.filter((item) => item.status !== "fail" && !item.isStale);
  if (live.some((item) => item.delayMinutes === undefined)) {
    return category.note ? `데이터 지연: ${category.note}` : undefined;
  }
  const labels = new Set(live.map((item) => delayLabel(item.delayMinutes) ?? "지연 모름"));
  if (labels.size === 0) return undefined;
  // 좁은 화면(md 미만)의 /macro 지표 표에는 기준 칸이 없고 그 내용이 이름 단추의 미리보기에 있습니다(2026-11-17 결정 9).
  return labels.size === 1 ? `시세: ${[...labels][0]}` : "시세: 종목마다 다름 — 기준 칸(좁은 화면은 미리보기) 참고";
}

