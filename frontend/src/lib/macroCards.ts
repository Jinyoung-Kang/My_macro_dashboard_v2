/**
 * 매크로 카드의 지연·알림 표시 규칙(순수 함수, ADR 0004).
 *
 * 카드는 개장 상태와 시세 지연을 배지 하나로 합치고(`SessionBadge`), 지연이 아닌 알림만 따로 보입니다. 예전에는
 * '실시간' 배지와 '마감' 배지가 나란히 떠 서로 어긋나게 읽혔습니다.
 */
import { delayLabel } from "./format";
import type { MacroCategory, MacroItem } from "./types";

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
  return labels.size === 1 ? `시세: ${[...labels][0]}` : "시세: 종목마다 다름 — 카드 배지 참고";
}

/** 카드 알림 하나 — tone이 'warn'이면 그리는 쪽이 경고 아이콘과 낭독기용 '주의: '를 붙입니다(글에는 기호를 넣지 않음). */
export type CardNotice = { text: string; title?: string; tone?: "warn" };

/** 지연이 아닌 알림 — 이어받은 예전 값, 선물 대신 지수 값·추정치·보정 실패. */
export function cardNotices(item: MacroItem): CardNotice[] {
  const notices: CardNotice[] = [];
  if (item.isStale) {
    notices.push({ text: "이전 값", tone: "warn", title: `이번 수집 실패로 직전 값을 보입니다 — ${item.staleReason ?? "수집 실패"}` });
  }
  if (item.warning) {
    notices.push({ text: item.warning });
  }
  return notices;
}
