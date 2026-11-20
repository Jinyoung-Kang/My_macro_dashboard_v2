/** 알림 규칙 — GET /api/alerts/rules. */
/** SECURITY_NOTICE는 보안 공지 해당 알림(ADR 0046 — 운영자, 규칙 없음, payload.href `/security?ntt=<번호>`). */
export type AlertKind = "REGIME_CHANGE" | "FOREIGN_STREAK" | "INSTITUTION_NEW" | "SEARCH_WATCH" | "SECURITY_NOTICE";

export interface AlertRule {
  id: number;
  kind: AlertKind;
  params: { target?: string; code?: string; n?: number; cik?: string };
  enabled: boolean;
  createdAt: string;
  description: string;
}

export interface AlertRulesResponse {
  available: boolean;
  message?: string;
  limit?: number;
  rules?: AlertRule[];
}

/** 알림함 한 줄. late는 발생 3일 뒤에 들어간 '지난 사건'(읽지 않은 수에 세지 않음). */
export interface InboxItem {
  id: number;
  kind: AlertKind;
  occurredOn: string;
  title: string;
  body: string;
  late: boolean;
  createdAt: string;
  read: boolean;
  /** 화면 안 주소(SEARCH_WATCH — 정보 검색 관심 대상 알림, 단계 6 · SECURITY_NOTICE — 보안 공지). 없으면 null(옛 응답에는 칸이 없음). */
  payload?: { href?: string } | null;
}

export interface InboxResponse {
  items: InboxItem[];
  unread: number;
}
