/** 알림 규칙 — GET /api/alerts/rules. */
export type AlertKind = "REGIME_CHANGE" | "FOREIGN_STREAK" | "INSTITUTION_NEW";

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
}

export interface InboxResponse {
  items: InboxItem[];
  unread: number;
}
