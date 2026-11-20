/**
 * 보안 공지(/security, ADR 0046 — 운영자 전용, 읽기만) 응답 계약. 칸은 docs/API.md의 `/api/security/*` 세 줄 그대로입니다.
 * 모르는 값은 null입니다(0·빈 글로 채우지 않음). 시각은 ISO(UTC) 글자, 날짜는 yyyy-MM-dd.
 */

/** 판정 넷 — 해당·확인 필요·패치됨·무관(API 코드). */
export type SecurityVerdict = "affected" | "check" | "patched" | "unrelated";

/** 확인 필요 사유 코드 여덟(ADR 0046 결정 6). 모르는 코드가 와도 글자 그대로 보이게 string도 받습니다. */
export type SecurityReason =
  | "PARSE_FAILED"
  | "OUT_OF_TABLE"
  | "DISTRO_NO_PENDING"
  | "NO_INVENTORY"
  | "CONDITION_NOTE"
  | "NO_VERSION_TABLE"
  | "NAME_MATCH"
  | "VENDOR_DIFFERS";

/** 목록·한 건 응답의 버전 목록 요약 — 받은 적이 없으면 응답의 이 칸 자체가 null. */
export interface SecurityInventorySummary {
  collectedAt: string | null;
  receivedAt: string | null;
  ageSeconds: number | null;
  /** 2일 넘게 오래됨. */
  stale: boolean | null;
  hostIncluded: boolean | null;
  aptListsAt: string | null;
  /** 제대로 모으지 못한 구역 이름(failed·skipped). */
  notOkSections: string[];
}

/** 수집 상태(출처 판정 + 받아 둔 공지 수). 판정 기록이 없으면 recorded false와 null 칸. */
export interface SecurityCollection {
  task: string;
  recorded: boolean;
  /** ok·blocked·format·failed. */
  status: string | null;
  streak: number | null;
  reason: string | null;
  lastOkAt: string | null;
  lastRunAt: string | null;
  staleAfterMinutes: number | null;
  notices: number;
  details: { pending: number; ok: number; failed: number; skipped: number };
  oldestPostedOn: string | null;
  newestPostedOn: string | null;
}

export interface SecurityProductVerdict {
  aliasId: string;
  label: string;
  status: SecurityVerdict;
  reasons: string[];
}

/** 공지 목록의 한 줄. */
export interface SecurityNoticeItem {
  nttId: number;
  title: string;
  postedOn: string | null;
  /** 원문 주소(보호나라). */
  url: string | null;
  pinned: boolean;
  detailStatus: string | null;
  /** product_table·other_table·no_table·null(상세 전). */
  layout: string | null;
  verdict: SecurityVerdict;
  reasons: string[];
  conditionNote: boolean;
  products: SecurityProductVerdict[];
  rowCount: number | null;
  cveCount: number | null;
}

/** GET /api/security/notices */
export interface SecurityNoticesResponse {
  available: boolean;
  checkedAt: string;
  inventory: SecurityInventorySummary | null;
  collection: SecurityCollection | null;
  counts: { affected: number; check: number; patched: number; unrelated: number; total: number } | null;
  reasonCounts: Record<string, number> | null;
  items: SecurityNoticeItem[];
  page: number;
  size: number;
  total: number;
  pages: number;
}

/** 근거 한 줄 — 구성 요소 하나 × 공지 표 행 하나(또는 행에 매이지 않는 근거). */
export interface SecurityMatch {
  aliasId: string;
  label: string | null;
  rowIndex: number | null;
  cve: string | null;
  rowProduct: string | null;
  /** 구역(host·postgres·backend·frontend·collector·browser·caddy). */
  source: string | null;
  component: string | null;
  installedVersion: string | null;
  status: SecurityVerdict;
  reason: string | null;
  otherFamily: boolean;
}

export interface SecurityNoticeRow {
  index: number;
  cve: string | null;
  product: string | null;
  /** 칸 원문. */
  affected: string | null;
  fixed: string | null;
  aliases: { aliasId: string; label: string }[];
  status: SecurityVerdict;
  reasons: string[];
  matches: SecurityMatch[];
}

export interface SecurityNoticeDetail extends SecurityNoticeItem {
  listNo: number | null;
  firstSeenAt: string | null;
  detailFetchedAt: string | null;
  detailAttempts: number | null;
  detailError: string | null;
  /** 표의 제품명 원문. */
  noticeProducts: string[];
  /** 표 밖 ※ 문장 원문. */
  notes: string[];
  /** 판정에 쓴 ※ 문장(관용 문장 뺌). */
  conditionNotes: string[];
  bodyText: string | null;
}

/** GET /api/security/notices/{nttId} */
export interface SecurityNoticeResponse {
  available: boolean;
  checkedAt: string;
  inventory: SecurityInventorySummary | null;
  notice: SecurityNoticeDetail;
  rows: SecurityNoticeRow[];
  generalMatches: SecurityMatch[];
}

export interface SecurityInventorySection {
  name: string;
  /** ok·failed·skipped. */
  status: string;
  count: number | null;
  reason: string | null;
}

export interface SecurityComponent {
  source: string;
  /** runtime·dpkg·apk·maven·npm·pypi. */
  ecosystem: string;
  name: string;
  version: string | null;
  sourcePackage: string | null;
}

export interface SecurityPending {
  package: string;
  arch: string | null;
  installed: string | null;
  candidate: string | null;
  repos: string | null;
  security: boolean;
}

/** GET /api/security/inventory — 받은 적이 없으면 present false와 null·빈 목록. */
export interface SecurityInventoryResponse {
  available: boolean;
  checkedAt: string;
  present: boolean;
  collectedAt: string | null;
  receivedAt: string | null;
  ageSeconds: number | null;
  stale: boolean | null;
  hostIncluded: boolean | null;
  aptListsAt: string | null;
  sections: SecurityInventorySection[];
  counts: { components: number; pending: number; pendingSecurity: number } | null;
  components: SecurityComponent[];
  pending: SecurityPending[];
}
