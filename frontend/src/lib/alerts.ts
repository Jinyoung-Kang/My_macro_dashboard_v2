/**
 * 🔔 알림 표기 — React를 모르는 순수 함수(ADR 0004).
 */
import type { AlertKind } from "./types";

export const ALERT_KINDS: { value: AlertKind; label: string; pro: boolean }[] = [
  { value: "REGIME_CHANGE", label: "국면 전환 (새 판정이 3일 이어질 때)", pro: false },
  { value: "FOREIGN_STREAK", label: "외국인 N일 연속 순매수", pro: true },
  { value: "INSTITUTION_NEW", label: "관심 기관 13F 신규 편입", pro: true },
];

/** 탭 제목 앞에 읽지 않은 수를 붙입니다 — "(3) 시장 국면 · 매크로 대시보드". 0이면 그대로. */
export function titleWithUnread(title: string, unread: number | null | undefined): string {
  const stripped = title.replace(/^\(\d+\+?\)\s*/, "");
  if (!unread || unread <= 0) return stripped;
  return `(${unread > 99 ? "99+" : unread}) ${stripped}`;
}

/** 상단바 알림 벨의 숫자 배지 문자열. 0이면 없음(null). */
export function unreadBadge(unread: number | null | undefined): string | null {
  if (!unread || unread <= 0) return null;
  return unread > 99 ? "99+" : String(unread);
}

/**
 * 알림을 읽음 처리했다는 신호. 알림 벨·탭 제목의 읽지 않은 수는 레이아웃이 5분마다 읽어, 알림함에서 읽어도 최대
 * 5분 그대로였습니다(QA-051). 레이아웃이 이 이벤트를 듣고 바로 다시 읽습니다.
 */
export const ALERTS_READ_EVENT = "macrodash:alerts-read";

export function notifyAlertsRead(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ALERTS_READ_EVENT));
}
