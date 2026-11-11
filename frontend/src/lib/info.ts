/**
 * 정보 수집(모의매매 > 정보 수집, ADR 0035)의 응답 모양과 표시 규칙 — React를 모르는 순수 함수(ADR 0004).
 *
 * 백엔드 `GET /api/info/*`가 수집기 저장본(글·네이버 매매동향·waedge 거장)과 출처 판정을 그대로 내려 줍니다. 비공식 출처를 차단 통과 수집으로
 * 받은 참고 자료라, 없는 값은 만들지 않고 '—'로 둡니다(0과 다름). 장중 추정 순위의 금액은 출처가 주지 않아 '—'입니다.
 */
import { EMPTY, formatNumber, formatSigned } from "@/lib/format";

/** 상태 톤 — components/ui/icons의 StatusTone과 같은 네 값(lib는 화면 모듈을 가져오지 않음). */
export type InfoTone = "ok" | "warn" | "danger" | "neutral";

// ------------------------------------------------------------------ 응답 모양
export type InfoItem = {
  id: string;
  source: string;
  sourceLabel: string;
  kind: "article" | "brief" | "guru";
  /** 원문 주소(출처 링크). */
  url: string;
  title: string;
  /** 한국어 제목(waedge 해외 블로그가 붙인 것) — 없으면 null. */
  titleKo: string | null;
  author: string | null;
  /** 출처가 밝힌 작성 시각(KST). 모르면 null — 받은 시각(firstSeenAt)으로 메우지 않습니다. */
  publishedAt: string | null;
  firstSeenAt: string;
  summary: string | null;
  bodyStatus: "full" | "partial" | "none";
  fetchTier: string | null;
  /** waedge 글의 분류(예: '시장 · 국내'). */
  category: string | null;
  body?: string | null;
};

export type InfoItemsResponse = { available: boolean; items: InfoItem[]; next?: string | null };
export type InfoItemResponse = { found: boolean; item?: InfoItem };

export type InfoIncident = {
  key: string;
  task: string;
  label: string;
  kind: "blocked" | "format" | "failed" | "stale";
  kindLabel: string;
  reason: string | null;
  since: string | null;
};

export type InfoSourceRow = {
  task: string;
  key: string;
  label: string;
  category: "blog" | "waedge" | "naver" | "calendar";
  siteUrl: string;
  status: "ok" | "blocked" | "format" | "failed" | null;
  streak: number | null;
  reason: string | null;
  lastOkAt: string | null;
  lastRunAt: string | null;
  items: number;
  latestItemAt: string | null;
  incident: InfoIncident | null;
};

export type InfoSourcesResponse = {
  checkedAt: string;
  available: boolean;
  /** 판정 기록이 있는가 — 로컬 PC는 수집하지 않아(운영 서버에서만) 기록이 없습니다. */
  recorded?: boolean;
  sources: InfoSourceRow[];
  incidents: InfoIncident[];
};

export type TrendRow = {
  date: string;
  individual: number | null;
  foreign: number | null;
  institution: number | null;
  financial: number | null;
  insurance: number | null;
  trust: number | null;
  bank: number | null;
  otherFinancial: number | null;
  pension: number | null;
  otherCorp: number | null;
};

export type RankRow = {
  rank: number;
  code: string | null;
  name: string | null;
  price: number | null;
  changePct: number | null;
  netVolume: number | null;
  /** 억 원. 장중 추정 순위는 출처가 금액을 주지 않아 null. */
  netAmountEok: number | null;
};

export type RankingPart = {
  buy: RankRow[];
  sell: RankRow[];
  estimated: boolean;
  period: { from: string | null; to: string | null };
  rankedAt: string | null;
  isStale?: boolean;
};

export type NaverInvestor = "FOREIGNER" | "ORGANIZATION";
export type NaverMarket = "KOSPI" | "KOSDAQ";

export type NaverFlowsResponse = {
  available: boolean;
  collectedAtKst?: string;
  ageSeconds?: number | null;
  source?: string | null;
  fetchTier?: string | null;
  unit?: string | null;
  sourceUrls?: { trader: string; foreigner: string; organization: string } | null;
  trend?: Partial<Record<NaverMarket, { rows: TrendRow[]; isStale?: boolean }>> | null;
  rankings?: Partial<Record<NaverInvestor, Partial<Record<NaverMarket, RankingPart>>>> | null;
  failed?: string[] | null;
};

export type Guru = {
  name: string;
  stance: "강세" | "중립" | "약세" | null;
  /** 강세에서 약세를 뺀 점수(-100~+100). */
  score: number | null;
  bull: number | null;
  neutral: number | null;
  bear: number | null;
  basisArticles: number | null;
  asOf: string | null;
  summary: string | null;
};

export type GurusResponse = {
  available: boolean;
  collectedAtKst?: string;
  ageSeconds?: number | null;
  source?: string | null;
  fetchTier?: string | null;
  sourceUrl?: string | null;
  asOf?: string | null;
  counts?: { total: number | null; bull: number | null; neutral: number | null; bear: number | null } | null;
  gurus?: Guru[] | null;
};

// ------------------------------------------------------------------ 화면 탭
export type InfoTab = "blog" | "waedge" | "gurus" | "naver" | "sources";

export const INFO_TABS: readonly { key: InfoTab; label: string }[] = [
  { key: "blog", label: "해외 블로그" },
  { key: "waedge", label: "waedge 시황" },
  { key: "gurus", label: "거장" },
  { key: "naver", label: "네이버 수급" },
  { key: "sources", label: "출처 상태" },
];

/** 주소의 ?tab= 값을 탭으로 — 모르는 값이면 첫 탭. */
export function parseInfoTab(value: string | null | undefined): InfoTab {
  return INFO_TABS.some((tab) => tab.key === value) ? (value as InfoTab) : "blog";
}

// ------------------------------------------------------------------ 출처 상태·안내 띠
const STATUS_LABELS: Record<string, string> = {
  ok: "정상",
  blocked: "차단됨 — 잠시 멈춤",
  format: "형식 바뀜",
  failed: "받지 못함",
};

/** 출처 판정의 글. 판정 기록이 없으면 '기록 없음'. */
export function statusLabel(row: Pick<InfoSourceRow, "status" | "incident">): string {
  if (row.incident) return row.incident.kindLabel;
  if (!row.status) return "기록 없음";
  return STATUS_LABELS[row.status] ?? row.status;
}

/** 출처 판정의 색 — 끊김 사건이면 차단·형식 바뀜은 위험, 그 밖은 주의. 한 번 형식이 달랐던 것(아직 사건 아님)도 주의. */
export function statusTone(row: Pick<InfoSourceRow, "status" | "incident">): InfoTone {
  if (row.incident) return row.incident.kind === "blocked" || row.incident.kind === "format" ? "danger" : "warn";
  if (!row.status) return "neutral";
  return row.status === "ok" ? "ok" : "warn";
}

/** 안내 띠에 보일 사건 — 닫은 적 없는 것만(닫은 뒤 새로 생긴 사건은 다시 보임). */
export function unseenIncidents(incidents: readonly InfoIncident[], dismissed: readonly string[]): InfoIncident[] {
  const closed = new Set(dismissed);
  return incidents.filter((incident) => !closed.has(incident.key));
}

/** 안내 띠의 한 줄 — "수집 출처 2곳이 끊겼습니다: Wolf Street(차단됨 — 잠시 멈춤) · waedge 시장(형식 바뀜)". 셋을 넘으면 '외 N곳'. */
export function bannerText(incidents: readonly InfoIncident[]): string {
  const shown = incidents.slice(0, 3).map((incident) => `${incident.label}(${incident.kindLabel})`);
  const rest = incidents.length - shown.length;
  return `수집 출처 ${incidents.length}곳이 끊겼습니다: ${shown.join(" · ")}${rest > 0 ? ` 외 ${rest}곳` : ""}`;
}

/** 안내 띠를 닫은 기록(브라우저 저장소)의 키. */
export const INFO_DISMISS_KEY = "info.incidents.dismissed";

// ------------------------------------------------------------------ 글
/** 목록의 제목 두 줄 — 한국어 제목이 있으면 그것을 위에, 원문 제목을 아래에. */
export function itemTitles(item: Pick<InfoItem, "title" | "titleKo">): { primary: string; secondary: string | null } {
  if (item.titleKo && item.titleKo !== item.title) return { primary: item.titleKo, secondary: item.title };
  return { primary: item.title, secondary: null };
}

const BODY_LABELS: Record<InfoItem["bodyStatus"], string> = { full: "본문", partial: "요약만", none: "제목만" };

export function bodyLabel(status: InfoItem["bodyStatus"]): string {
  return BODY_LABELS[status] ?? status;
}

/** 글 시각 — 작성 시각, 모르면 '받은 시각' 표시를 붙여 받은 시각. */
export function itemTime(item: Pick<InfoItem, "publishedAt" | "firstSeenAt">): string {
  if (item.publishedAt) return item.publishedAt.replace(/:\d{2} KST$/, "");
  return `${item.firstSeenAt.replace(/:\d{2} KST$/, "")} 받음`;
}

// ------------------------------------------------------------------ 네이버 수급
export const TREND_COLUMNS: readonly { key: keyof Omit<TrendRow, "date">; label: string }[] = [
  { key: "individual", label: "개인" },
  { key: "foreign", label: "외국인" },
  { key: "institution", label: "기관계" },
  { key: "financial", label: "금융투자" },
  { key: "insurance", label: "보험" },
  { key: "trust", label: "투신(사모)" },
  { key: "bank", label: "은행" },
  { key: "otherFinancial", label: "기타금융" },
  { key: "pension", label: "연기금등" },
  { key: "otherCorp", label: "기타법인" },
];

export const NAVER_INVESTORS: readonly { key: NaverInvestor; label: string }[] = [
  { key: "FOREIGNER", label: "외국인" },
  { key: "ORGANIZATION", label: "기관" },
];

export const NAVER_MARKETS: readonly { key: NaverMarket; label: string }[] = [
  { key: "KOSPI", label: "코스피" },
  { key: "KOSDAQ", label: "코스닥" },
];

/** 억 원 — 부호를 붙여(순매수 +, 순매도 −). 모르면 '—'. */
export function eokText(value: number | null | undefined): string {
  return value === null || value === undefined ? EMPTY : `${formatSigned(value, 1)}억`;
}

/** 순매수 주식 수 — 부호를 붙여. 모르면 '—'. */
export function sharesText(value: number | null | undefined): string {
  return value === null || value === undefined ? EMPTY : `${formatSigned(value, 0)}주`;
}

/** 순위 표의 기준 글 — 확정이면 기간, 장중 추정이면 '장중 추정 · 순위 시각'. */
export function rankingBasis(part: RankingPart | null | undefined): string {
  if (!part) return "받은 순위 없음";
  const stale = part.isStale ? " · 이번에 받지 못해 이전 값" : "";
  if (part.estimated) {
    const at = part.rankedAt ? part.rankedAt.replace("T", " ").replace(/:\d{2}([+-]\d{2}:\d{2})$/, "") : null;
    return `장중 추정 — 금액 없음(주식 수)${at ? ` · ${at}` : ""}${stale}`;
  }
  const { from, to } = part.period;
  const period = from && to ? (from === to ? to : `${from}~${to}`) : (to ?? from ?? EMPTY);
  return `확정 · ${period}${stale}`;
}

// ------------------------------------------------------------------ 거장
/** 견해의 색 — 강세 ok, 약세 danger, 중립·모름 neutral. */
export function stanceTone(stance: Guru["stance"]): InfoTone {
  if (stance === "강세") return "ok";
  if (stance === "약세") return "danger";
  return "neutral";
}

/** 점수 글(+95·−60). 모르면 '—'. */
export function scoreText(score: number | null | undefined): string {
  return score === null || score === undefined ? EMPTY : formatSigned(score, 0);
}

/** 강세·중립·약세 나눔 한 줄("강세 95 · 중립 5 · 약세 0"). 하나라도 모르면 '—'. */
export function splitText(guru: Pick<Guru, "bull" | "neutral" | "bear">): string {
  if (guru.bull === null || guru.neutral === null || guru.bear === null) return EMPTY;
  return `강세 ${formatNumber(guru.bull, 0)} · 중립 ${formatNumber(guru.neutral, 0)} · 약세 ${formatNumber(guru.bear, 0)}`;
}
