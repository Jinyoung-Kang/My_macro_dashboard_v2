/**
 * 보안 공지(/security, ADR 0046) 화면 모델 — React를 모르는 순수 함수(ADR 0004). 판정·사유는 백엔드가 계산해 코드로 내려 주고, 여기서는 그 코드를
 * 한국어 글·톤으로 바꾸고 KPI 띠·거르기·수집 상태 한 줄·버전 목록 안내를 만듭니다. 모르는 값은 null·'—'로 두고(0으로 채우지 않음), 모르는 판정을 안전한
 * 쪽(패치됨·무관)으로 읽지 않습니다 — 모르는 판정 코드는 '확인 필요'로 보입니다.
 */
import { EMPTY, formatAge, formatKst } from "./format";
import type { KpiItem } from "./kpi";
import type {
  SecurityCollection,
  SecurityInventorySummary,
  SecurityMatch,
  SecurityNoticesResponse,
  SecurityVerdict,
} from "./types";

/** 화면 한계 한 줄(ADR 0046 '결과와 남은 위험') — 늘 보입니다. */
export const SECURITY_LIMIT_NOTE =
  "보호나라는 이 스택의 일부만 다룹니다 — 여기서 해당이 없어도 다른 구성 요소(Spring·Caddy·Docker·Tailscale 등)가 안전하다는 뜻은 아닙니다.";

/** 버전 목록이 없을 때의 안내(로컬·QA, 서버에서 아직 받지 않음 — ADR 0046 결정 8). */
export const NO_INVENTORY_NOTE = "버전 목록 없음 — 서버에서 inventory.sh가 돈 뒤에 생깁니다.";

/** 공지 목록 한 쪽의 줄 수(API 기본과 같음). */
export const SECURITY_PAGE_SIZE = 20;

/** 판정 톤 — 공용 상태 글(StatusText)의 톤. 해당은 위험, 확인 필요는 주의, 패치됨은 정상, 무관은 중립. 색만이 아니라 늘 아이콘과 글을 함께 씁니다. */
export type VerdictTone = "danger" | "warn" | "ok" | "neutral";

export type VerdictView = { code: SecurityVerdict; label: string; tone: VerdictTone; description: string };

const VERDICTS: Record<SecurityVerdict, VerdictView> = {
  affected: { code: "affected", label: "해당", tone: "danger", description: "설치 버전이 공지의 영향 구간 안입니다 — 업데이트가 필요합니다." },
  check: { code: "check", label: "확인 필요", tone: "warn", description: "제품은 맞는데 판정할 수 없습니다 — 사유를 보고 직접 확인합니다." },
  patched: { code: "patched", label: "패치됨", tone: "ok", description: "같은 계열의 행이 있고 설치 버전이 해결 버전 이상입니다." },
  unrelated: { code: "unrelated", label: "무관", tone: "neutral", description: "이 스택이 쓰지 않는 제품입니다." },
};

/** 판정 차례(세기 순 — 해당 > 확인 필요 > 패치됨 > 무관). 거르기·KPI가 이 차례를 씁니다. */
export const VERDICT_ORDER: readonly SecurityVerdict[] = ["affected", "check", "patched", "unrelated"];

/** 판정 코드 → 글·톤. 모르는 코드는 안전한 쪽으로 읽지 않고 '확인 필요'(주의)로 둡니다. */
export function verdictView(code: string | null | undefined): VerdictView {
  if (code && code in VERDICTS) return VERDICTS[code as SecurityVerdict];
  return { ...VERDICTS.check, description: `알 수 없는 판정(${code ?? "없음"}) — 확인이 필요합니다.` };
}

type ReasonText = { label: string; description: string };

/** 사유 코드 여덟(ADR 0046 결정 6)의 짧은 글과 설명. */
const REASONS: Record<string, ReasonText> = {
  PARSE_FAILED: { label: "버전 칸 해석 실패", description: "공지의 영향·해결 버전 칸이나 설치 버전을 읽지 못했습니다." },
  OUT_OF_TABLE: {
    label: "같은 계열 행 없음",
    description: "공지 표에 설치 버전과 같은 계열의 행이 없거나, 설치 버전이 영향 구간 밖인데 해결 버전보다 낮습니다.",
  },
  DISTRO_NO_PENDING: {
    label: "배포판 패키지 — 보류 목록에 없음",
    description:
      "배포판 패키지는 옛 번호에 패치를 넣어 공지 번호로 견줄 수 없습니다. 서버의 apt 보안 보류 목록에 없어 패치를 받았는지 모릅니다(컨테이너 안 패키지는 보류 목록이 없어 늘 이 사유).",
  },
  NO_INVENTORY: { label: "버전 목록 없음", description: "버전 목록이 없거나 그 구역을 모으지 못했습니다." },
  CONDITION_NOTE: { label: "조건 문장 있음", description: "표 밖에 ※ 조건 문장이 있습니다 — 조건에 따라 영향이 달라질 수 있습니다." },
  NO_VERSION_TABLE: { label: "버전 표 없음", description: "버전 표가 없는 공지의 제목·본문에 이 스택의 제품 이름이 나옵니다." },
  NAME_MATCH: {
    label: "이름만 맞음",
    description: "표에는 없고 제목·본문에만 나오거나, 설치 버전을 공지의 번호와 견줄 수 없는 제품입니다.",
  },
  VENDOR_DIFFERS: {
    label: "제조사 다름",
    description: "공지 제품과 설치된 제품의 제조사가 다릅니다(예: Oracle Java SE 공지와 Temurin) — 번호가 구간 안이어도 확인이 필요합니다.",
  },
};

/** 사유 거르기 차례(API의 사유 순서). */
export const REASON_ORDER: readonly string[] = Object.keys(REASONS);

/** 사유 코드 → 짧은 한국어 글. 모르는 코드는 코드 그대로. */
export function reasonLabel(code: string): string {
  return REASONS[code]?.label ?? code;
}

/** 사유 코드 → 설명 한 문장. 모르는 코드는 null. */
export function reasonDescription(code: string): string | null {
  return REASONS[code]?.description ?? null;
}

/** 사유 목록 → 한 줄 글('버전 목록 없음 · 조건 문장 있음'). 없으면 null. */
export function reasonsText(codes: readonly string[] | null | undefined): string | null {
  if (!codes || codes.length === 0) return null;
  return codes.map(reasonLabel).join(" · ");
}

/** 판정 근거 종류 → 짧은 한국어 글(ADR 0046 덧붙임 2026-11-21). 없으면 null, 모르는 코드는 코드 그대로. */
export function basisLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return code === "CHANGELOG" ? "변경 기록에 CVE 있음" : code;
}

/** 판정 거르기의 키 — 전체는 'all'(인자 없음). */
export const ALL = "all";

export type FilterItem = { key: string; label: string; note: string | null };

/** 판정 거르기 줄 — 전체 + 판정 넷, 보조 글은 건수(검색어로 거른 뒤의 수 — counts). 건수를 모르면 보조 글 없음. */
export function verdictFilterItems(counts: SecurityNoticesResponse["counts"]): FilterItem[] {
  const count = (value: number | undefined) => (counts && typeof value === "number" ? `${value}건` : null);
  return [
    { key: ALL, label: "전체", note: count(counts?.total) },
    ...VERDICT_ORDER.map((code) => ({ key: code, label: VERDICTS[code].label, note: count(counts?.[code]) })),
  ];
}

/** 사유 거르기 줄 — 전체 + 사유 여덟, 보조 글은 건수(판정까지 거른 뒤의 수 — reasonCounts). */
export function reasonFilterItems(reasonCounts: SecurityNoticesResponse["reasonCounts"]): FilterItem[] {
  return [
    { key: ALL, label: "전체", note: null },
    ...REASON_ORDER.map((code) => {
      const value = reasonCounts?.[code];
      return { key: code, label: reasonLabel(code), note: typeof value === "number" ? `${value}건` : null };
    }),
  ];
}

/** 거르기 키 → API 인자(전체면 undefined — 인자를 뺌). */
export function filterParam(key: string): string | undefined {
  return key === ALL ? undefined : key;
}

/**
 * 알림함 링크(`/security?ntt=<번호>`)의 ntt 인자 → 공지 번호 글. 숫자(1~12자리)만 받고 그 밖은 null(그 공지를 열지 않음).
 */
export function parseNttParam(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return /^\d{1,12}$/.test(text) && !/^0+$/.test(text) ? String(Number(text)) : null;
}

/** 보안 공지 알림(SECURITY_NOTICE)의 알림함 종류. */
export const SECURITY_NOTICE_ALERT_KIND = "SECURITY_NOTICE";
/** 보안 공지 화면 주소 — '/security' 다음은 끝 또는 '?ntt=<숫자>'만. */
const INBOX_HREF = /^\/security(?:\?ntt=\d{1,12})?$/;

/**
 * 알림함 줄이 가는 주소 — 보안 공지 알림(SECURITY_NOTICE)의 payload.href가 이 앱의 보안 공지 화면이면 그 주소, 아니면 null(누를 수 없는 줄 그대로).
 * 다른 종류의 알림은 늘 null입니다(관심 대상 새 글은 lib/infoSearch searchWatchInboxHref).
 */
export function securityInboxHref(item: { kind?: string | null; payload?: unknown }): string | null {
  if (item.kind !== SECURITY_NOTICE_ALERT_KIND) return null;
  const payload = item.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const href: unknown = (payload as { href?: unknown }).href;
  if (typeof href !== "string" || !INBOX_HREF.test(href)) return null;
  return href;
}

export type InventoryState =
  | { kind: "missing"; text: string }
  | { kind: "present"; collectedAt: string; age: string; stale: boolean; notOkSections: string[]; hostIncluded: boolean | null };

/** 목록 응답의 버전 목록 요약 → 상태. 요약이 없으면 '버전 목록 없음'. */
export function inventoryState(inventory: SecurityInventorySummary | null | undefined): InventoryState {
  if (!inventory) return { kind: "missing", text: NO_INVENTORY_NOTE };
  return {
    kind: "present",
    collectedAt: formatKst(inventory.collectedAt),
    age: formatAge(inventory.ageSeconds),
    stale: inventory.stale === true,
    notOkSections: inventory.notOkSections ?? [],
    hostIncluded: inventory.hostIncluded,
  };
}

/** 버전 목록이 오래됐을 때의 경고 글. */
export function staleInventoryText(state: Extract<InventoryState, { kind: "present" }>): string {
  return `버전 목록이 2일 넘게 오래됐습니다(기준 ${state.collectedAt} — ${state.age}). 서버의 inventory.sh가 돌고 있는지 확인하세요.`;
}

const SECTION_LABELS: Record<string, string> = {
  host: "서버 호스트",
  postgres: "postgres",
  backend: "backend",
  frontend: "frontend",
  collector: "collector",
  browser: "browser",
  caddy: "caddy",
};

/** 구역 이름 → 화면 글. */
export function sectionLabel(name: string | null | undefined): string {
  if (!name) return EMPTY;
  return SECTION_LABELS[name] ?? name;
}

const SECTION_STATUS: Record<string, { label: string; tone: VerdictTone }> = {
  ok: { label: "모음", tone: "ok" },
  failed: { label: "실패", tone: "warn" },
  skipped: { label: "건너뜀", tone: "neutral" },
};

/** 구역 상태(ok·failed·skipped) → 글·톤. 모르는 값은 그 글 그대로(주의). */
export function sectionStatusView(status: string | null | undefined): { label: string; tone: VerdictTone } {
  return (status && SECTION_STATUS[status]) || { label: status ?? EMPTY, tone: "warn" };
}

/** 모으지 못한 구역 안내('모으지 못한 구역: browser · caddy — 그 구역의 제품은 확인 필요입니다'). 없으면 null. */
export function notOkSectionsText(sections: readonly string[]): string | null {
  if (sections.length === 0) return null;
  return `모으지 못한 구역: ${sections.map(sectionLabel).join(" · ")} — 그 구역의 제품은 확인 필요(버전 목록 없음)로 둡니다.`;
}

const COLLECTION_STATUS: Record<string, string> = {
  ok: "정상",
  blocked: "차단됨",
  format: "형식 바뀜",
  failed: "받지 못함",
};

export type CollectionLine = { tone: "ok" | "warn" | "neutral"; text: string };

/**
 * 수집 상태 한 줄 — 출처 판정(정상·차단됨·형식 바뀜·받지 못함 n회 연속)·마지막 성공·받아 둔 공지 수와 상세 받기 상태. 판정 기록이 없으면 '수집 기록 없음'.
 * 마지막 실행이 신선도 한도(staleAfterMinutes)보다 오래됐으면(정상이어도) 주의로 적습니다 — `now`는 응답의 checkedAt.
 */
export function collectionLine(collection: SecurityCollection | null | undefined, now?: string | null): CollectionLine | null {
  if (!collection) return null;
  const stock =
    collection.notices > 0
      ? `받아 둔 공지 ${collection.notices}건(게시 ${collection.oldestPostedOn ?? EMPTY} ~ ${collection.newestPostedOn ?? EMPTY}) · 상세 받음 ${collection.details.ok} · 대기 ${collection.details.pending} · 실패 ${collection.details.failed}`
      : "받아 둔 공지 없음";
  if (!collection.recorded || !collection.status) {
    return { tone: "neutral", text: `수집 기록 없음 — 수집기가 아직 이 출처를 돌리지 않았습니다 · ${stock}` };
  }
  const lastOk = collection.lastOkAt ? `마지막 성공 ${formatKst(collection.lastOkAt)}` : "성공 기록 없음";
  const late = lateMinutes(collection, now);
  if (collection.status === "ok") {
    const lateText = late !== null ? ` · 마지막 실행이 ${formatAge(late * 60)}입니다(한도 ${collection.staleAfterMinutes}분)` : "";
    return { tone: late !== null ? "warn" : "ok", text: `수집 정상 · ${lastOk}${lateText} · ${stock}` };
  }
  const label = COLLECTION_STATUS[collection.status] ?? collection.status;
  const streak = typeof collection.streak === "number" && collection.streak > 1 ? ` ${collection.streak}회 연속` : "";
  const reason = collection.reason ? ` — ${collection.reason}` : "";
  return { tone: "warn", text: `수집 ${label}${streak}${reason} · ${lastOk} · ${stock}` };
}

/** 마지막 실행이 한도보다 늦었으면 그 경과(분), 아니면(또는 모르면) null. */
function lateMinutes(collection: SecurityCollection, now: string | null | undefined): number | null {
  if (!now || !collection.lastRunAt || typeof collection.staleAfterMinutes !== "number") return null;
  const elapsed = (Date.parse(now) - Date.parse(collection.lastRunAt)) / 60_000;
  if (!Number.isFinite(elapsed)) return null;
  return elapsed > collection.staleAfterMinutes ? Math.round(elapsed) : null;
}

/**
 * KPI 띠 — 해당·확인 필요·패치됨(검색어로 거른 뒤·판정으로 거르기 전 건수 — counts)과 버전 목록 기준 시각. 건수를 모르면(표 없음) '—'.
 * 버전 목록이 없으면 기준 시각 칸이 '—'와 그 까닭, 오래됐으면 주의 상태 글.
 */
export function securityKpis(data: SecurityNoticesResponse | null | undefined, pending = false): KpiItem[] {
  const counts = data?.counts ?? null;
  const count = (code: SecurityVerdict): KpiItem => ({
    key: code,
    label: VERDICTS[code].label,
    value: counts ? counts[code] : null,
    format: (value) => String(Math.round(value)),
    unit: "건",
    emptyReason: data && !counts ? "표 없음" : null,
    pending,
  });
  const state = data ? inventoryState(data.inventory) : null;
  const basis: KpiItem = {
    key: "inventory",
    label: "버전 목록 기준",
    value: state?.kind === "present" ? state.collectedAt : null,
    valueKind: "label",
    note: state?.kind === "present" ? state.age : null,
    emptyReason: state?.kind === "missing" ? "버전 목록 없음" : null,
    status: state?.kind === "present" && state.stale ? { tone: "warn", text: "2일 넘게 오래됨" } : undefined,
    pending,
  };
  return [count("affected"), count("check"), count("patched"), basis];
}

/** 표 틀 종류 → 글. */
export function layoutLabel(layout: string | null | undefined): string {
  switch (layout) {
    case "product_table":
      return "제품 버전 표";
    case "other_table":
      return "다른 표(버전 표 아님)";
    case "no_table":
      return "표 없음";
    default:
      return "상세 전";
  }
}

/** 상세 받기 상태 → 글. */
export function detailStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case "ok":
      return "받음";
    case "pending":
      return "받기 대기";
    case "failed":
      return "받지 못함";
    case "skipped":
      return "건너뜀";
    default:
      return status ?? EMPTY;
  }
}

/**
 * 근거 한 줄의 설치 버전 글 — '{구성 요소} {설치 버전}({구역})'. 구성 요소가 없으면(버전 목록 없음·본문 이름 일치) null.
 * 다른 계열 행이면 '(다른 계열)'을 붙입니다.
 */
export function matchInstalledText(match: SecurityMatch): string | null {
  if (!match.component) return null;
  const version = match.installedVersion ? ` ${match.installedVersion}` : "";
  const where = match.source ? `(${sectionLabel(match.source)})` : "";
  return `${match.component}${version}${where}${match.otherFamily ? " · 다른 계열" : ""}`;
}

export type ComponentFilter = { section: string; query: string };

/** 버전 목록 구성 요소를 구역·이름으로 거릅니다(화면 안 — 요청 없음). 이름·원본 패키지·버전에 검색어가 들어 있으면 남김(대소문자 무시). */
export function filterComponents<T extends { source: string; name: string; version: string | null; sourcePackage: string | null }>(
  rows: readonly T[],
  filter: ComponentFilter,
): T[] {
  const query = filter.query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (filter.section === ALL || row.source === filter.section) &&
      (!query || [row.name, row.version, row.sourcePackage].some((text) => text?.toLowerCase().includes(query))),
  );
}

/** 원문 주소 — http(s)만 링크로 둡니다(그 밖의 모양은 null — 링크 없음). 수집기가 저장한 값이지만 javascript: 같은 주소를 화면 링크로 만들지 않습니다. */
export function safeExternalUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const text = url.trim();
  return /^https?:\/\/[^\s]+$/i.test(text) ? text : null;
}
