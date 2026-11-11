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
  /** headline은 본문이 없는 속보 한 줄(Financial Juice — ADR 0037). */
  kind: "article" | "brief" | "guru" | "headline";
  /** 원문 주소(출처 링크). */
  url: string;
  title: string;
  /** 출처가 붙인 한국어 제목(waedge 해외 블로그) — 없으면 null. 우리가 미리 번역하지 않습니다(번역은 제목마다 단추로). */
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

export type InfoItemsResponse = Paged & { available: boolean; items: InfoItem[] };
export type InfoItemResponse = { found: boolean; item?: InfoItem };

export type InfoIncident = {
  key: string;
  task: string;
  label: string;
  kind: "blocked" | "format" | "failed" | "stale";
  kindLabel: string;
  reason: string | null;
  since: string | null;
  /** 사건의 회차(그 출처의 마지막 성공 시각, 없으면 "never") — 회복했다가 다시 끊기면 바뀝니다. 이 칸이 없는 옛 응답도 받습니다. */
  episode?: string | null;
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

// ------------------------------------------------------------------ 화면 탭(하위 메뉴 줄 — lib/nav의 info 탭과 같은 순서)
export type InfoTab = "overview" | "news" | "kr" | "global" | "filings" | "paper" | "status" | "mechanism";

export const INFO_TAB_SLUGS: readonly InfoTab[] = ["overview", "news", "kr", "global", "filings", "paper", "status", "mechanism"];

/** 주소 조각을 탭으로 — 모르는 값이면 null(404). */
export function parseInfoTab(value: string | null | undefined): InfoTab | null {
  return INFO_TAB_SLUGS.includes(value as InfoTab) ? (value as InfoTab) : null;
}

/** 한 쪽에 보이는 줄 수(사용자 요청 2026-11-11 — 5~10개씩 나눠 쪽을 옮김). 카드는 그보다 적게. */
export const PAGE_SIZE = 10;
export const CARD_PAGE_SIZE = 8;

// ------------------------------------------------------------------ 쪽 나누기
export type Paged = { page?: number; size?: number; total?: number; pages?: number };

/** 클라이언트에서 나누는 목록의 한 쪽(1부터). 쪽이 범위를 넘으면 마지막 쪽. */
export function pageSlice<T>(rows: readonly T[], page: number, size: number): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(Math.max(1, page), pages);
  return { rows: rows.slice((current - 1) * size, current * size), page: current, pages };
}

/** 쪽 단추에 보일 번호 — 처음·끝·지금 앞뒤 하나, 사이는 null(말줄임). */
export function pageNumbers(page: number, pages: number): (number | null)[] {
  const wanted = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  const sorted = [...wanted].sort((a, b) => a - b);
  const out: (number | null)[] = [];
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1] > 1) out.push(null);
    out.push(n);
  });
  return out;
}

// ------------------------------------------------------------------ 한눈 보기(catalog)
export type SourceTab = "news" | "kr" | "global" | "filings" | "paper" | "ops";
export type Access = "official" | "unofficial" | "bypass" | "internal" | "deferred";

export type CatalogSource = {
  task: string;
  key: string;
  label: string;
  tab: SourceTab;
  kind: string;
  siteUrl: string | null;
  origin: string;
  access: Access;
  screen: string | null;
  speed: string | null;
  lastStatus: string | null;
  lastRunAt: string | null;
  lastDetail: string | null;
  politeStatus: string | null;
  streak: number | null;
  lastOkAt: string | null;
  nextDueAt: string | null;
  items: number | null;
  incident: InfoIncident | null;
  tone: InfoTone;
};

export type CatalogResponse = {
  checkedAt: string;
  collectorReachable: boolean;
  tabs: { key: SourceTab; label: string; sources: number; tones: Partial<Record<InfoTone, number>> }[];
  sources: CatalogSource[];
  incidents: InfoIncident[];
};

const ACCESS_LABELS: Record<Access, string> = {
  official: "공식 API",
  unofficial: "비공식 공개 경로",
  bypass: "차단 통과 수집(서버)",
  internal: "외부 호출 없음",
  deferred: "보류",
};

export function accessLabel(access: Access): string {
  return ACCESS_LABELS[access] ?? access;
}

const SPEED_LABELS: Record<string, string> = {
  fast: "5분마다",
  slow: "1시간마다",
  weekly: "12시간마다",
  session: "장중 5분(조건부)",
  live: "화면이 볼 때",
  polite: "불규칙(출처마다 무작위)",
};

export function speedLabel(speed: string | null): string {
  return speed ? (SPEED_LABELS[speed] ?? speed) : EMPTY;
}

const RUN_LABELS: Record<string, string> = {
  ok: "정상",
  partial: "일부",
  empty: "수집 결과 없음",
  fail: "실패",
  rejected: "거부됨",
  interrupted: "중단",
  skipped: "건너뜀",
};

/** 카드의 상태 글 — 끊김 사건 → polite 판정 → 수집기 실행 기록 → 기록 없음 순. */
export function catalogStatus(source: Pick<CatalogSource, "access" | "incident" | "politeStatus" | "lastStatus">): string {
  if (source.access === "deferred") return "보류(수집하지 않음)";
  if (source.incident) return source.incident.kindLabel;
  if (source.politeStatus) return STATUS_LABELS[source.politeStatus] ?? source.politeStatus;
  if (source.lastStatus) return RUN_LABELS[source.lastStatus] ?? source.lastStatus;
  return "기록 없음";
}

/** 그 탭의 색별 수를 한 줄로("정상 12 · 주의 1 · 위험 0 · 기록 없음 2"). */
export function toneSummary(tones: Partial<Record<InfoTone, number>>): string {
  return `정상 ${tones.ok ?? 0} · 주의 ${tones.warn ?? 0} · 위험 ${tones.danger ?? 0} · 기록 없음 ${tones.neutral ?? 0}`;
}

// ------------------------------------------------------------------ 사건 뉴스 RSS
export type Headline = {
  set: "us" | "kr";
  title: string | null;
  /** 피드가 준 요약(글 페이지는 열지 않음) — 없으면 null. */
  summary?: string | null;
  link: string | null;
  source: string | null;
  feed: string | null;
  publishedAt: string | null;
  fetchedAt: string | null;
};
export type HeadlinesResponse = Paged & { available: boolean; items: Headline[] };

// ------------------------------------------------------------------ KRX 정보데이터시스템
export type KrxPart<T> = { asOf: string; rows: T[]; isStale?: boolean };
export type KrxTotal = { investor: string; buyEok: number | null; sellEok: number | null; netEok: number | null; netVolume: number | null };
export type KrxForeign = { code: string; name: string | null; close: number | null; changePct: number | null; holdShares: number | null; holdPct: number | null; limitExhaustPct: number | null };
export type KrxShortTrade = { code: string; name: string | null; shortEok: number | null; shortVolume: number | null; tradeValueWeightPct: number | null };
export type KrxShortBalance = { code: string; name: string | null; balanceEok: number | null; balanceShares: number | null; balancePct: number | null };
export type KrxRank = { rank: number; code: string; name: string; netAmountEok: number | null; netVolume: number | null; buyEok: number | null; sellEok: number | null };

export type KrxResponse = {
  available: boolean;
  collectedAtKst?: string;
  ageSeconds?: number | null;
  source?: string | null;
  fetchTier?: string | null;
  asOf?: string | null;
  sourceUrl?: string | null;
  totals?: Partial<Record<NaverMarket, KrxPart<KrxTotal>>> | null;
  foreign?: Partial<Record<NaverMarket, KrxPart<KrxForeign>>> | null;
  shortTrades?: Partial<Record<NaverMarket, KrxPart<KrxShortTrade>>> | null;
  shortBalances?: Partial<Record<NaverMarket, KrxPart<KrxShortBalance>>> | null;
  failed?: string[] | null;
  ranking: { market: NaverMarket; investor: string; tradeType: "순매수" | "순매도"; date: string | null; rows: KrxRank[] };
  markets: NaverMarket[];
  investors: string[];
};

/** KRX 부분의 기준일 글 — 이번에 받지 못해 이어받은 것이면 표시. */
export function partBasis(part: { asOf: string; isStale?: boolean } | null | undefined): string {
  if (!part) return "받은 자료 없음";
  return `기준일 ${part.asOf}${part.isStale ? " · 이번에 받지 못해 이전 값" : ""}`;
}

// ------------------------------------------------------------------ 메커니즘
export type MechanismResponse = {
  checkedAt: string;
  collector: {
    politeEnabled: boolean;
    tickSeconds: number;
    tickJitterSeconds: number;
    taskDeadlineSeconds: number | null;
    browser: { configured: boolean; reachable: boolean; pressCheckbox: boolean | null; allowedHosts: number | null };
    gap: { medianSeconds: number; lowSeconds: number; highSeconds: number; longChance: number; longLowSeconds: number; longHighSeconds: number };
    backoffMinutes: [number, number][];
    humanCheckMinutes: [number, number];
    giveUpLevel: number;
    giveUpRecheckDays: number;
    staleFactor: number;
    hosts: { host: string; tiers: string[]; dailyBudget: number }[];
    cadences: { task: string; lowMinutes: number; highMinutes: number; note: string | null }[];
    articles: Record<string, number>;
  } | null;
  hostStates: { host: string; lastGoodTier: string | null; failLevel: number; blockedUntil: string | null; blockedReason: string | null; givenUp: boolean; usedToday: number }[];
  schedule: Record<string, string>;
  alerts: { formatStreak: number; failedStreak: number; intervalMinutes: number };
  deferred: { task: string; label: string; reason: string }[];
  /** 한국어 번역의 설정과 오늘(KST) 쓴 원문 글자 수(ADR 0037). 표가 아직 없으면 usedCharsToday는 null. */
  translation?: {
    /** 1순위 엔진: gemini 또는 claude — GEMINI_API_KEY가 있으면 gemini. */
    engine: string;
    model: string;
    /** 1순위 Gemini 모델이 실패하면 한 번 불러 보는 한 등급 아래 Gemini 모델. 없으면 null. */
    geminiLowerModel?: string | null;
    /** Gemini가 실패하면 넘어가는 2순위 모델(Claude Haiku). 넘어가지 않는 설정이면 null. */
    fallbackModel?: string | null;
    /** Gemini 두 모델이 모두 한도 초과 등으로 잠시 쉬는 중(그동안은 바로 Claude로). */
    geminiResting?: boolean;
    effort: string;
    dailyChars: number;
    usedCharsToday: number | null;
    titleBatch: number;
    bodyChunkChars: number;
    bodyMaxChars: number;
  } | null;
};

const TIER_LABELS: Record<string, string> = { impersonate: "브라우저 TLS(계층 1)", browser: "실제 브라우저(계층 2)" };

export function tierLabel(tier: string | null | undefined): string {
  return tier ? (TIER_LABELS[tier] ?? tier) : EMPTY;
}

/** 분 구간을 사람 말로("3~8시간", "40~90분"). */
export function minutesRange(low: number, high: number): string {
  if (low >= 120 && high >= 120) return `${formatNumber(low / 60, low % 60 ? 1 : 0)}~${formatNumber(high / 60, high % 60 ? 1 : 0)}시간`;
  return `${formatNumber(low, 0)}~${formatNumber(high, 0)}분`;
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

/**
 * 안내 띠를 닫을 때 기억하는 키 — `키@회차`(QA-408). 키(태스크|종류)만 기억하면 회복했다가 같은 종류로 다시 끊긴 사건도 닫힌 채로 남습니다.
 * 회차가 없는 응답이면 키 그대로입니다.
 */
export function incidentDismissKey(incident: Pick<InfoIncident, "key" | "episode">): string {
  return incident.episode ? `${incident.key}@${incident.episode}` : incident.key;
}

/** 안내 띠에 보일 사건 — 닫은 적 없는 것만(닫은 뒤 새로 생긴 사건, 회복했다가 다시 끊긴 사건은 다시 보임). */
export function unseenIncidents(incidents: readonly InfoIncident[], dismissed: readonly string[]): InfoIncident[] {
  const closed = new Set(dismissed);
  return incidents.filter((incident) => !closed.has(incidentDismissKey(incident)));
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
/** 목록의 제목 두 줄 — 원문 제목을 그대로 위에, 출처가 붙인 한국어 제목이 있으면 아래에(2026-11-12 사용자 지시 — 미리 번역하지 않음). */
export function itemTitles(item: Pick<InfoItem, "title" | "titleKo">): { primary: string; secondary: string | null } {
  if (item.titleKo && item.titleKo !== item.title) return { primary: item.title, secondary: item.titleKo };
  return { primary: item.title, secondary: null };
}

/** 제목에 번역 단추를 낼 것인가 — 한글이 없는 제목이고, 출처가 붙인 한국어 제목도 없을 때. */
export function titleNeedsTranslation(title: string | null | undefined, titleKo?: string | null): boolean {
  return !!title && title !== EMPTY && !titleKo && !hasHangul(title) && /\p{L}/u.test(title);
}

/**
 * 서버가 준 KST 시각 글을 분까지로 보입니다. 'KST'는 남깁니다 — 어느 시간대인지 화면에 보이게.
 *
 * 서버(백엔드 `Kst.DISPLAY`·수집기 `kst.stamp`)는 초 없는 "2026-11-11 14:30 KST"를 내립니다 — 그대로 둡니다. 초가 붙어 온 값
 * ("2026-11-11 14:30:59 KST")만 초를 뗍니다. 초가 늘 있다고 보고 끝의 ":dd KST"를 떼면 분이 잘려 "14 KST"가 됐습니다(QA-407).
 */
export function kstMinute(stamp: string | null | undefined): string {
  return stamp ? stamp.replace(/(\d{2}:\d{2}):\d{2} KST$/, "$1 KST") : EMPTY;
}

// ------------------------------------------------------------------ 원문 팝업·번역(ADR 0037)
/** `POST /api/info/translate`의 응답. 번역할 본문이 없으면 textKo는 null. */
export type TranslateResponse = {
  ok: boolean;
  titleKo: string | null;
  textKo: string | null;
  alreadyKorean: boolean;
  cached: boolean;
  truncated: boolean;
  /** 이번에 번역한 모델(Gemini, 또는 넘어간 Claude Haiku). 저장본만으로 끝났으면 null. */
  model: string | null;
  /** 이 번역(저장본 포함)을 옮긴 모델 전부 — 제목 먼저, 본문 조각 순서. 이 칸이 없는 옛 응답도 받습니다. */
  models?: string[];
  error: string | null;
};

/**
 * 번역을 옮긴 모델 이름(QA-403) — 저장본을 다시 읽은 응답도, 조각마다 모델이 다른 글도 이름을 모두 보입니다("A · B").
 * 목록이 없으면 이번에 부른 모델, 그것도 없으면 '번역 모델'.
 */
export function translatedBy(response: Pick<TranslateResponse, "model" | "models">): string {
  const names = [...new Set((response.models ?? []).filter(Boolean))];
  if (names.length > 0) return names.join(" · ");
  return response.model ?? "번역 모델";
}

/**
 * 원문 팝업에 여는 글 하나 — 수집 글(본문은 서버에서 id로 읽음)이나 사건 뉴스(피드가 준 요약이 전부)를 같은 모양으로.
 * `itemId`가 있으면 본문·번역을 id로 묻고, 없으면 `text`(요약)를 그대로 보이고 번역도 그 글자로 묻습니다.
 */
export type ReaderEntry = {
  key: string;
  sourceLabel: string;
  time: string;
  title: string;
  titleKo: string | null;
  url: string | null;
  itemId: string | null;
  /** 서버에 본문이나 요약이 있는가(itemId일 때) — 없으면 제목뿐인 출처. */
  hasBody: boolean;
  text: string | null;
  /** 받아 둔 글이 어디까지인지 한 줄(본문 전체·요약만·제목만). */
  note: string;
};

/** 한글이 든 글인가 — 한국어 제목·요약은 번역 단추를 내지 않습니다. */
export function hasHangul(text: string | null | undefined): boolean {
  return !!text && /[가-힣]/.test(text);
}

export function readerOfItem(item: InfoItem): ReaderEntry {
  const note =
    item.bodyStatus === "full"
      ? "운영 서버가 받아 둔 본문 전체입니다(글자만)."
      : item.bodyStatus === "partial"
        ? "피드가 준 요약만 받았습니다 — 전체는 원문에서 보세요."
        : item.kind === "headline"
          ? "한 줄 속보라 본문이 없는 출처입니다."
          : "본문을 아직 받지 못했습니다 — 원문에서 보세요.";
  return {
    key: `item:${item.id}`,
    sourceLabel: item.sourceLabel,
    time: itemTime(item),
    title: item.title,
    titleKo: item.titleKo && item.titleKo !== item.title ? item.titleKo : null,
    url: item.url,
    itemId: item.id,
    hasBody: item.bodyStatus !== "none" || !!item.summary,
    text: null,
    note,
  };
}

export function readerOfHeadline(row: Headline, index: number): ReaderEntry {
  const title = row.title ?? EMPTY;
  return {
    key: `headline:${row.link ?? title}:${index}`,
    sourceLabel: row.source ?? row.feed ?? EMPTY,
    time: kstMinute(row.publishedAt),
    title,
    titleKo: null,
    url: row.link,
    itemId: null,
    hasBody: !!row.summary,
    text: row.summary ?? null,
    note: row.summary ? "피드가 준 요약입니다 — 전체는 원문에서 보세요(글 페이지는 받지 않는 출처)." : "피드가 제목만 주는 출처입니다 — 내용은 원문에서 보세요.",
  };
}

/** 한국어로 옮길 본문인가 — 글자가 있고(숫자·기호뿐이 아님) 앞부분에 한글이 없을 때. */
function bodyNeedsTranslation(text: string | null): boolean {
  return !!text && /\p{L}/u.test(text) && !hasHangul(text.slice(0, 400));
}

/**
 * 번역 단추를 낼 것인가 — 번역할 글(한국어가 아닌 본문·요약, 또는 아직 번역 전인 제목)이 있을 때만.
 * 글자가 없는 글(숫자·기호뿐, 제목 없음)에는 내지 않습니다 — 눌러도 서버가 옮길 것이 없습니다(QA-410, 제목 단추의 조건과 같게).
 */
export function canTranslate(entry: ReaderEntry, body: string | null): boolean {
  if (bodyNeedsTranslation(entry.itemId ? body : entry.text)) return true;
  return titleNeedsTranslation(entry.title, entry.titleKo);
}

/**
 * 팝업에서 번역 단추를 계속 낼 것인가(QA-409) — 번역 응답을 받은 뒤에도, 옮길 본문(한국어가 아닌 본문·요약)이 있는데 본문 번역이 아직
 * 없고 '이미 한국어'도 아니면 냅니다. 서버는 제목을 먼저 옮기고 본문을 옮기므로 본문만 실패한 응답(제목 번역 있음·본문 없음)이 올 수 있고,
 * 다시 누르면 남은 부분만 번역합니다. 응답을 받기 전에는 {@link canTranslate}와 같습니다.
 *
 * 거꾸로 제목만 실패한 응답(실패 표시 `ok: false`, 제목 번역 없음, 본문은 옮겨짐)에도 냅니다 — 서버는 제목이 실패해도 본문을 이어 옮기고,
 * 다시 누르면 저장된 본문은 그대로 두고 제목만 다시 옮깁니다. 실패 없이 제목 번역이 비어 온 응답(옮길 제목이 없다고 봄)에는 내지 않습니다.
 */
export function offersTranslate(
  entry: ReaderEntry,
  body: string | null,
  translated: (Pick<TranslateResponse, "textKo" | "alreadyKorean"> & Partial<Pick<TranslateResponse, "ok" | "titleKo">>) | null,
): boolean {
  if (!translated) return canTranslate(entry, body);
  if (translated.ok === false && !translated.titleKo && titleNeedsTranslation(entry.title, entry.titleKo)) return true;
  if (translated.textKo || translated.alreadyKorean) return false;
  return bodyNeedsTranslation(entry.itemId ? body : entry.text);
}

/**
 * 쪽이 범위를 넘었을 때 다시 물을 쪽(QA-410) — 목록이 비었는데 전체 건수가 0보다 크면 마지막 쪽, 그럴 일이 아니면 null.
 * 보고 있던 사이 글이 줄면(보존 기한·다른 조건) 글이 있는데도 '받은 글이 없습니다'만 뜨고 쪽 단추도 사라졌습니다.
 * 이미 마지막 쪽이면 null입니다(같은 쪽을 되풀이해 묻지 않음).
 */
export function rewindPage(data: { items: readonly unknown[]; total?: number | null; page?: number | null; pages?: number | null }): number | null {
  if (data.items.length > 0 || !data.total || data.total <= 0) return null;
  const last = Math.max(1, data.pages ?? 1);
  return (data.page ?? 1) > last ? last : null;
}

/**
 * 분류 카드의 색(QA-410) — 위험이 있으면 위험, 주의가 있으면 주의, **정상이 하나라도 있을 때만** 정상, 그 밖(기록이 하나도 없음)은 중립.
 * 예전에는 기록이 없는 분류도 '정상'으로 칠했습니다.
 */
export function tabTone(tones: Partial<Record<InfoTone, number>>): InfoTone {
  if ((tones.danger ?? 0) > 0) return "danger";
  if ((tones.warn ?? 0) > 0) return "warn";
  return (tones.ok ?? 0) > 0 ? "ok" : "neutral";
}

/** waedge가 한국어 제목을 붙여 주는 해외 블로그 글의 출처 키 — 서버는 이 글을 waedge가 아니라 블로그 종류로 내립니다. */
const WAEDGE_BLOGS = "waedge.blogs";

/**
 * 글 목록 보기의 출처 고르기(QA-410) — 해외 블로그 보기는 블로그 출처와 waedge 해외 블로그(그 글이 블로그 쪽에 실리는데 고르기에는 빠져 있었음),
 * waedge 보기는 나머지 waedge 출처. 그 밖의 보기는 출처를 고르지 않습니다.
 */
export function sourceChoices<T extends { kind: string; key: string }>(sources: readonly T[], view: string): T[] {
  if (view === "blog") return sources.filter((row) => row.kind === "blog" || row.key === WAEDGE_BLOGS);
  if (view === "waedge") return sources.filter((row) => row.kind === "waedge" && row.key !== WAEDGE_BLOGS);
  return [];
}

/** 검색 칸의 이름표 — 서버가 실제로 찾는 범위. 글(블로그·속보·waedge)은 제목·요약, 사건 뉴스는 제목만입니다(QA-410). */
export function searchLabel(view: string): string {
  return view === "rss-us" || view === "rss-kr" ? "검색(제목)" : "검색(제목·요약)";
}

const BODY_LABELS: Record<InfoItem["bodyStatus"], string> = { full: "본문", partial: "요약만", none: "제목만" };

export function bodyLabel(status: InfoItem["bodyStatus"]): string {
  return BODY_LABELS[status] ?? status;
}

/** 글 시각(KST 표기) — 작성 시각, 모르면 '받은 시각' 표시를 붙여 받은 시각. */
export function itemTime(item: Pick<InfoItem, "publishedAt" | "firstSeenAt">): string {
  if (item.publishedAt) return kstMinute(item.publishedAt);
  return `${kstMinute(item.firstSeenAt)} 받음`;
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
    // 네이버가 준 순위 시각은 KST(+09:00)입니다 — 그때만 'KST'를 붙이고, 다른 시간대면 원문 offset을 그대로 둡니다.
    const at = part.rankedAt
      ? part.rankedAt.replace("T", " ").replace(/:\d{2}([+-]\d{2}:\d{2})$/, (_, offset: string) => (offset === "+09:00" ? " KST" : ` ${offset}`))
      : null;
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
