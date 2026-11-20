/**
 * 알림 표기 — React를 모르는 순수 함수(ADR 0004).
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

/** 알림함 줄의 종류 태그 글(짧게) — 알림 종류마다 하나. 모르는 종류는 '알림'. */
const KIND_TAG: Record<AlertKind, string> = {
  REGIME_CHANGE: "국면 전환",
  FOREIGN_STREAK: "연속 순매수",
  INSTITUTION_NEW: "13F 신규",
  SEARCH_WATCH: "관심 대상 새 글",
  SECURITY_NOTICE: "보안 공지",
};

export function alertKindTag(kind: AlertKind | string): string {
  return KIND_TAG[kind as AlertKind] ?? "알림";
}

/** 받은 알림의 종류(태그 차례 — 국면 전환·연속 순매수·13F 신규·관심 대상 새 글·보안 공지, 그 밖은 뒤에 받은 차례). 거르기 목록에 받은 종류만 둡니다. */
export function inboxKinds(items: readonly { kind: AlertKind }[]): AlertKind[] {
  const order = Object.keys(KIND_TAG) as AlertKind[];
  const seen = [...new Set(items.map((item) => item.kind))];
  return [...order.filter((kind) => seen.includes(kind)), ...seen.filter((kind) => !order.includes(kind))];
}
