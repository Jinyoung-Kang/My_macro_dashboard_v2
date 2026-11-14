/**
 * 정보 검색(/search — ADR 0041)의 화면 규칙 — React를 모르는 순수 함수(ADR 0004).
 *
 * 계약(docs/specs/2026-11-14-info-search-contract.md)의 화면 몫만 둡니다: 주소 상태(?q= · ?e=&tab=&range=), 대상 키 모양 검사(주소로 넘어가기 전),
 * 후보를 자동으로 고르지 않는 규칙, 2년 묶음을 7일·30일·1년·2년으로 자르기, KST 날짜 묶음, 빈 화면 안내, 출처 상태 글, 거르기, 키보드,
 * 단계 3의 관심 대상(대표 키·새 글 수·상한·정기 수집 안내)과 매체 제외 목록(더할 값 다듬기), 단계 4의 공시·리서치 탭(대상 종류에 따라)·날짜만 아는 줄·
 * 연결 보강(대상 풀기의 links와 합치기·받는 중/실패 글).
 * 2년 자르기·중국어 제목·매체 제외는 수집기가 원본이고 화면은 다시 구현하지 않습니다(계약 §1). 상단 통합 검색(⌘K)의 색인은 lib/search.ts입니다.
 */
import { holderQuery, institutionHref, stockHref } from "./detail";
import { EMPTY, formatKst } from "./format";
import type { ReaderEntry } from "./info";
import type {
  SearchCandidate,
  SearchEntity,
  SearchEntityKind,
  SearchFeedItem,
  SearchFeedResponse,
  SearchFeedTab,
  SearchExcludeSeed,
  SearchLink,
  SearchLinksResponse,
  SearchRange,
  SearchSourceStatus,
  SearchWatchItem,
  SearchWatchLimits,
} from "./types";

// ------------------------------------------------------------------ 탭·기간

/**
 * 화면의 탭 — 타임라인·뉴스·공시·리서치·글·논평은 결과 경로(feed), 보유는 13F 경로, 연결은 대상 풀기의 links + 연결 보강 경로(단계 4).
 * 순서는 지시문 §4.2의 표 순서입니다.
 */
export type SearchTabKey = "timeline" | "news" | "filings" | "research" | "posts" | "holdings" | "links";

export const SEARCH_TABS: readonly { key: SearchTabKey; label: string }[] = [
  { key: "timeline", label: "타임라인" },
  { key: "news", label: "뉴스" },
  { key: "filings", label: "공시" },
  { key: "research", label: "리서치" },
  { key: "posts", label: "글·논평" },
  { key: "holdings", label: "보유" },
  { key: "links", label: "연결" },
];

export const DEFAULT_TAB: SearchTabKey = "timeline";

export const SEARCH_RANGES: readonly { key: SearchRange; label: string }[] = [
  { key: "7d", label: "7일" },
  { key: "30d", label: "30일" },
  { key: "1y", label: "1년" },
  { key: "2y", label: "2년" },
];

export const DEFAULT_RANGE: SearchRange = "30d";

const TAB_KEYS = new Set<string>(SEARCH_TABS.map((tab) => tab.key));
const RANGE_KEYS = new Set<string>(SEARCH_RANGES.map((range) => range.key));

/**
 * 이 대상·사용자에게 보이는 탭. 글·논평은 운영자만(D-1 — 회원이 부르면 403), 보유는 기업·기관만, 공시는 주제 밖 모두(기업·기관·사람),
 * 리서치는 상장 기업만(계약 §7-2·7-3·7-7 — 수집기도 상장되지 않은 기업에는 리서치 출처를 묻지 않음).
 *
 * @param listed 미국·한국 상장 종목인가(isListedEntity)
 */
export function tabsFor(kind: SearchEntityKind, owner: boolean, listed: boolean): SearchTabKey[] {
  return SEARCH_TABS.map((tab) => tab.key).filter((key) => {
    if (key === "posts") return owner;
    if (key === "holdings") return kind === "company" || kind === "institution";
    if (key === "filings") return kind !== "topic";
    if (key === "research") return kind === "company" && listed;
    return true;
  });
}

/** 주소의 탭을 이 대상·사용자에게 맞춤 — 고를 수 없는 탭이면 타임라인. */
export function tabFor(requested: SearchTabKey, kind: SearchEntityKind, owner: boolean, listed: boolean): SearchTabKey {
  return tabsFor(kind, owner, listed).includes(requested) ? requested : DEFAULT_TAB;
}

/**
 * 미국·한국 상장 종목인가 — 풀린 대상의 시장(ids.market), 풀기 전·풀지 못했으면 키 앞부분(us:·kr: — 수집기가 늘 시장을 채우는 키).
 * wd:로 열었어도 풀린 대상이 상장 종목이면 상장, 시장이 없는 wd: 기업은 상장 아님.
 */
export function isListedEntity(entityKey: string, entity: Pick<SearchEntity, "ids"> | null | undefined): boolean {
  const market = entity?.ids.market;
  return market === "us" || market === "kr" || entityKey.startsWith("us:") || entityKey.startsWith("kr:");
}

/** 결과 경로(GET /api/search/feed)의 tab 값 — 보유·연결은 그 경로를 쓰지 않아 null. */
export function feedTabOf(tab: SearchTabKey): SearchFeedTab | null {
  return tab === "holdings" || tab === "links" ? null : tab;
}

// ------------------------------------------------------------------ 대상 키

// 수집기(search.py의 _KEY_PATTERNS)·백엔드(SearchService)와 같은 문법 — 어긋나면 수집기의 400이 '응답 없음'으로 보입니다.
const KEY_PATTERNS: readonly RegExp[] = [/^us:[A-Z0-9][A-Z0-9.-]{0,14}$/, /^kr:\d{6}$/, /^cik:\d{10}$/, /^wd:Q[1-9]\d{0,11}$/];
const TOPIC_MAX = 60;
// eslint-disable-next-line no-control-regex -- 제어 글자를 막는 것이 목적
const CONTROL = /[\u0000-\u001f\u007f]/;

const codePoints = (text: string) => Array.from(text).length;

/**
 * 대상 키 모양(계약 §2) — 화면이 주소로 넘어가기 전에 봅니다(틀린 키로 400을 부르지 않게).
 * 티커는 영문 대문자·숫자·'.'·'-', 국내 6자리, CIK 10자리, Wikidata Q+숫자, 주제는 앞뒤 공백 없는 1~60자.
 */
export function isEntityKey(key: string | null | undefined): key is string {
  if (!key) return false;
  if (key.startsWith("topic:")) {
    const text = key.slice("topic:".length);
    return text.length > 0 && text === text.trim() && codePoints(text) <= TOPIC_MAX && !CONTROL.test(text);
  }
  return KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/** 검색어 → 주제 키. 공백을 하나로 줄이고, 비거나 60자를 넘으면 null. */
export function topicKey(text: string): string | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean || codePoints(clean) > TOPIC_MAX) return null;
  return `topic:${clean}`;
}

/** 키 앞부분으로 아는 종류 — wd:는 사람·기업·기관 모두라 모름(null). 대상 풀기 응답이 없을 때만 씁니다. */
export function kindOfKey(key: string): SearchEntityKind | null {
  if (key.startsWith("us:") || key.startsWith("kr:")) return "company";
  if (key.startsWith("cik:")) return "institution";
  if (key.startsWith("topic:")) return "topic";
  return null;
}

// ------------------------------------------------------------------ 주소 상태

export type SearchUrlState = {
  /** 후보 보기의 검색어(대상이 없을 때). */
  q: string | null;
  /** 연 대상의 키(모양이 맞을 때만). */
  e: string | null;
  tab: SearchTabKey;
  range: SearchRange;
  /** 주소에 대상 키가 있었지만 모양이 틀렸음 — 화면이 그렇다고 적습니다. */
  badKey: boolean;
};

const QUERY_MAX = 60;

/** 주소의 쿼리(`?e=…&tab=…` 또는 URLSearchParams) → 화면 상태. 모르는 탭·기간은 기본값. */
export function parseSearchUrl(input: URLSearchParams | string | null | undefined): SearchUrlState {
  const params = typeof input === "string" || input == null ? new URLSearchParams(input ?? "") : input;
  const rawKey = params.get("e");
  const e = isEntityKey(rawKey) ? rawKey : null;
  const rawQuery = (params.get("q") ?? "").trim();
  const q = rawQuery ? Array.from(rawQuery).slice(0, QUERY_MAX).join("").trim() : null;
  const tab = params.get("tab");
  const range = params.get("range");
  return {
    q: q || null,
    e,
    tab: tab && TAB_KEYS.has(tab) ? (tab as SearchTabKey) : DEFAULT_TAB,
    range: range && RANGE_KEYS.has(range) ? (range as SearchRange) : DEFAULT_RANGE,
    badKey: rawKey !== null && rawKey !== "" && e === null,
  };
}

/** 쿼리 값 인코딩 — ':'는 쿼리에서 그대로 써도 되어 읽기 좋게 남깁니다(us:NVDA). */
const encodeValue = (value: string) => encodeURIComponent(value).replace(/%3A/gi, ":");

/**
 * 화면 상태 → 주소. 대상이 있으면 `/search?e=…&tab=…&range=…`(북마크·새로고침이 같은 화면), 없으면 `/search?q=…`, 둘 다 없으면 `/search`.
 * 모양이 틀린 키는 넣지 않습니다.
 */
export function searchHref(state: { q?: string | null; e?: string | null; tab?: SearchTabKey; range?: SearchRange }): string {
  if (isEntityKey(state.e)) {
    return `/search?e=${encodeValue(state.e)}&tab=${state.tab ?? DEFAULT_TAB}&range=${state.range ?? DEFAULT_RANGE}`;
  }
  const q = state.q?.trim();
  return q ? `/search?q=${encodeValue(q)}` : "/search";
}

// ------------------------------------------------------------------ 후보

const sameName = (a: string, b: string) => a.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase() === b.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * 입력 그대로의 구문 검색 줄인가(맨 끝의 `topic:` 후보). 종류가 topic이어도 키가 `wd:`인 Wikidata 항목(사람·조직이 아닌 것)은 대상입니다.
 */
export function isTopicSearch(candidate: SearchCandidate): boolean {
  return candidate.source === "topic" || (candidate.key?.startsWith("topic:") ?? false);
}

/**
 * Enter로 받은 후보에서 바로 열 대상(계약 3-2) — 주제를 뺀 후보가 정확히 하나이고, 키가 있고, 이름이 입력과 같을 때만.
 * 그 밖에는 null(목록을 보이고 사용자가 고름 — 동명이인을 자동으로 고르지 않음).
 */
export function autoPick(items: readonly SearchCandidate[], query: string): SearchCandidate | null {
  const named = items.filter((item) => !isTopicSearch(item));
  if (named.length !== 1) return null;
  const only = named[0];
  return isEntityKey(only.key) && sameName(only.name, query) ? only : null;
}

/** 고른 것이 하는 일 — 대상을 열거나(open), 그 이름으로 다시 풂(resolve). */
export type SearchTarget = { open: string } | { resolve: string };

/**
 * 후보를 골랐을 때(계약 3-1) — 키가 있으면 그 대상, 없으면 그 이름으로 다시 풂. 이미 그 이름으로 푼 목록에서 다시 고르면(같은 목록이 또 나옴)
 * 그 이름을 주제로 엽니다.
 *
 * @param resolvedQuery 지금 보이는 목록을 만든 검색어(치는 동안의 후보면 null)
 */
export function candidateTarget(candidate: SearchCandidate, resolvedQuery: string | null): SearchTarget {
  if (isEntityKey(candidate.key)) return { open: candidate.key };
  if (resolvedQuery !== null && sameName(candidate.name, resolvedQuery)) {
    const topic = topicKey(candidate.name);
    if (topic) return { open: topic };
  }
  return { resolve: candidate.name };
}

/** 연결을 눌렀을 때 — 키가 있으면 그 대상, 없으면 그 이름으로 풂(계약 3-3). */
export function linkTarget(link: SearchLink): SearchTarget {
  return isEntityKey(link.key) ? { open: link.key } : { resolve: link.name };
}

// ------------------------------------------------------------------ KST 시각

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const pad = (value: number) => String(value).padStart(2, "0");

function kstShifted(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms + KST_OFFSET_MS);
}

const dateText = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

/** UTC ISO → KST 날짜(YYYY-MM-DD). 모르면 null. KST는 서머타임이 없어 +9시간으로 셉니다. */
export function kstDate(iso: string | null | undefined): string | null {
  const shifted = kstShifted(iso);
  return shifted ? dateText(shifted) : null;
}

/** UTC ISO → KST 시각(HH:mm). 모르면 null. */
export function kstTime(iso: string | null | undefined): string | null {
  const shifted = kstShifted(iso);
  return shifted ? `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}` : null;
}

/** 지금(ms)의 KST 날짜. */
export function kstToday(nowMs: number): string {
  return dateText(new Date(nowMs + KST_OFFSET_MS));
}

/**
 * 기간의 시작 날짜(KST) — 오늘에서 7일·30일·1년·2년 뺀 날(그날 00:00 KST부터 포함). 2년은 계약 §4-1(창 시작 = 오늘 − 2년)과 같은 정의이고,
 * 2월 29일에서 해를 빼면 2월 28일입니다.
 */
export function rangeStart(range: SearchRange, today: string): string {
  const [year, month, day] = today.split("-").map(Number);
  if (range === "7d" || range === "30d") {
    const days = range === "7d" ? 7 : 30;
    return dateText(new Date(Date.UTC(year, month - 1, day - days)));
  }
  const years = range === "1y" ? 1 : 2;
  const lastDay = new Date(Date.UTC(year - years, month, 0)).getUTCDate();
  return dateText(new Date(Date.UTC(year - years, month - 1, Math.min(day, lastDay))));
}

// ------------------------------------------------------------------ 기간 자르기·묶기

/** 최근부터(작성 시각 — 없으면 맨 뒤). 계약상 ISO 문자열 정렬이 시간 순서와 같습니다. 같은 시각은 받은 순서 그대로. */
export function sortFeed(items: readonly SearchFeedItem[]): SearchFeedItem[] {
  return [...items].sort((a, b) => {
    if (a.publishedAt === b.publishedAt) return 0;
    if (!a.publishedAt) return 1;
    if (!b.publishedAt) return -1;
    return a.publishedAt < b.publishedAt ? 1 : -1;
  });
}

const RANGE_ORDER: readonly SearchRange[] = ["7d", "30d", "1y", "2y"];

/** 받은 줄을 기간마다 셉니다(작성 시각의 KST 날짜가 시작 날짜 이상). */
export function countByRange(items: readonly SearchFeedItem[], today: string): Record<SearchRange, number> {
  const out = { "7d": 0, "30d": 0, "1y": 0, "2y": 0 } as Record<SearchRange, number>;
  for (const range of RANGE_ORDER) {
    const start = rangeStart(range, today);
    out[range] = items.filter((item) => {
      const date = kstDate(item.publishedAt);
      return date !== null && date >= start;
    }).length;
  }
  return out;
}

/** 서버의 오늘(window.to) — 없으면 부르는 쪽이 준 오늘(브라우저 시계의 KST 날짜), 그것도 없으면 null(날짜로 자르지 못함). */
const feedToday = (feed: SearchFeedResponse, today: string | null | undefined) => feed.window?.to ?? today ?? null;

function serverCounts(feed: SearchFeedResponse): Record<SearchRange, number> | null {
  const counts = feed.rangeCounts;
  if (!counts) return null;
  const values = RANGE_ORDER.map((range) => counts[range]);
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) return null;
  return Object.fromEntries(RANGE_ORDER.map((range, at) => [range, values[at]])) as Record<SearchRange, number>;
}

/** 기간 단추의 건수 — 서버의 rangeCounts(받은 자료 기준), 없으면 받은 줄을 직접 셈(오늘을 모르면 모두 2년 안으로 봄 — 서버가 이미 자름). */
export function rangeCountsOf(feed: SearchFeedResponse, today?: string | null): Record<SearchRange, number> {
  const server = serverCounts(feed);
  if (server) return server;
  const day = feedToday(feed, today);
  if (day) return countByRange(feed.items ?? [], day);
  const all = (feed.items ?? []).length;
  return { "7d": all, "30d": all, "1y": all, "2y": all };
}

/**
 * 2년 묶음에서 고른 기간만(다시 부르지 않음). 서버가 센 rangeCounts가 있으면 최근부터 그 수만큼 — 기간은 '오늘부터 거슬러 올라간 구간'이라
 * 최근순 목록의 앞부분이므로, 단추의 건수와 보이는 줄이 늘 같습니다. 없으면 작성 시각의 KST 날짜로 자릅니다.
 */
export function cutByRange(feed: SearchFeedResponse, range: SearchRange, today?: string | null): SearchFeedItem[] {
  const sorted = sortFeed(feed.items ?? []);
  const counts = serverCounts(feed);
  if (counts) return sorted.slice(0, counts[range]);
  const day = feedToday(feed, today);
  if (!day) return sorted;
  const start = rangeStart(range, day);
  return sorted.filter((item) => {
    const date = kstDate(item.publishedAt);
    return date !== null && date >= start;
  });
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export type FeedDateGroup = { date: string; label: string; items: SearchFeedItem[] };

/** KST 날짜별 묶음(받은 순서 유지) — 제목은 'YYYY-MM-DD (요일)'. 시각 모르는 줄은 '시각 모름' 묶음으로 맨 뒤. */
export function groupByKstDate(items: readonly SearchFeedItem[]): FeedDateGroup[] {
  const groups: FeedDateGroup[] = [];
  const byDate = new Map<string, FeedDateGroup>();
  for (const item of items) {
    const date = kstDate(item.publishedAt) ?? "";
    let group = byDate.get(date);
    if (!group) {
      const [year, month, day] = date.split("-").map(Number);
      const label = date ? `${date} (${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]})` : "시각 모름";
      group = { date, label, items: [] };
      byDate.set(date, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups.sort((a, b) => (a.date === b.date ? 0 : !a.date ? 1 : !b.date ? -1 : a.date < b.date ? 1 : -1));
}

// ------------------------------------------------------------------ 빈 화면

export type FeedEmpty = {
  /** unknown = 답한 출처가 하나도 없어 2년 안에 자료가 있는지 모름(실패·외부 조회 안 함·건너뜀뿐). */
  kind: "none2y" | "range" | "filtered" | "unknown";
  message: string;
  /** 덧붙이는 한 줄(가장 최근 자료 날짜). */
  note: string | null;
  /** 받지 못한 출처가 있다는 한 줄 — 빈 결과가 '없음'이 아니라 '받은 출처 기준'임을 알립니다. 자세한 사유는 출처 상태 줄. */
  caveat: string | null;
  /** 더 넓은 기간 단추(건수가 있는 것만). */
  wider: { range: SearchRange; label: string; count: number }[];
};

/** 출처가 답한 상태(결과가 0건이어도 '없음'을 말할 수 있음). */
const ANSWERED = new Set(["ok", "cached", "empty"]);
/** 물었어야 했는데 답을 받지 못한 상태. 건너뜀(이름이 없어 묻지 않음)·운영자 전용·다음 단계는 원래 묻지 않는 자리라 넣지 않습니다. */
const UNANSWERED = new Set(["error", "offline", "pending", "server_only"]);

/** 받지 못한 출처의 한 줄(없으면 null) — 외부 조회 안 함(데모·저장본만)·받는 중은 따로 말합니다. */
export function feedSourceCaveat(sources: readonly SearchSourceStatus[]): string | null {
  const missed = sources.filter((source) => UNANSWERED.has(source.status));
  if (missed.length === 0) return null;
  if (missed.every((source) => source.status === "offline")) return "외부 출처는 부르지 않았습니다(저장본만 찾음) — 아래 출처 상태를 보세요.";
  const names = missed.map((source) => source.label || sourceLabel(source.source)).join(" · ");
  if (missed.every((source) => source.status === "pending")) return `받는 중인 출처가 있습니다(${names}) — 몇 초 뒤 다시 읽습니다.`;
  return `받지 못한 출처가 있습니다(${names}) — 아래 출처 상태를 보세요.`;
}

/**
 * 결과가 비었을 때의 안내(계약 §5).
 * - 2년 안에 하나도 없음 → '최근 2년 안의 자료가 없습니다' (+ 2년보다 오래된 것만 있었으면 '가장 최근 자료: 날짜' — 그 줄은 보이지 않음)
 *   단, 답한 출처가 하나도 없으면(모두 실패·외부 조회 안 함·건너뜀) '없다'고 하지 않고 모른다고 합니다(지시문 §8 — 실패를 빈 목록으로 숨기지 않음).
 * - 고른 기간에 없음 → '이 기간에는 자료가 없습니다' + 더 넓은 기간 단추(그 기간의 건수와 함께)
 * - 거르기 때문에 없음 → 그렇다고(기간 안내와 섞지 않음)
 * 받지 못한 출처가 있으면 앞의 두 안내에 caveat 한 줄을 붙입니다.
 *
 * @param total 2년 안의 줄 수 · @param inRange 고른 기간의 줄 수(거르기 전) · @param shown 거른 뒤 보이는 줄 수 · @param sources 출처 상태(없으면 지금처럼)
 */
export function feedEmptyState(args: {
  total: number;
  inRange: number;
  shown: number;
  counts: Record<SearchRange, number>;
  range: SearchRange;
  olderOnlyLatest: string | null | undefined;
  sources?: readonly SearchSourceStatus[];
}): FeedEmpty | null {
  const sources = args.sources ?? [];
  const caveat = feedSourceCaveat(sources);
  if (args.total === 0) {
    const note = args.olderOnlyLatest ? `가장 최근 자료: ${args.olderOnlyLatest}` : null;
    if (sources.length > 0 && !sources.some((source) => ANSWERED.has(source.status))) {
      return {
        kind: "unknown",
        message: "받은 출처가 없어 최근 2년 안의 자료가 있는지 모릅니다",
        note,
        caveat: caveat ?? "부른 출처가 없습니다 — 아래 출처 상태에서 사유를 보세요.",
        wider: [],
      };
    }
    return { kind: "none2y", message: "최근 2년 안의 자료가 없습니다", note, caveat, wider: [] };
  }
  if (args.inRange === 0) {
    const after = RANGE_ORDER.slice(RANGE_ORDER.indexOf(args.range) + 1);
    return {
      kind: "range",
      message: "이 기간에는 자료가 없습니다",
      note: null,
      caveat,
      wider: SEARCH_RANGES.filter((range) => after.includes(range.key) && args.counts[range.key] > 0).map((range) => ({
        range: range.key,
        label: range.label,
        count: args.counts[range.key],
      })),
    };
  }
  if (args.shown === 0) return { kind: "filtered", message: "고른 거르기에 맞는 자료가 없습니다", note: null, caveat: null, wider: [] };
  return null;
}

// ------------------------------------------------------------------ 이름표

const ITEM_KIND_LABELS: Record<string, string> = {
  news: "뉴스",
  headline: "헤드라인",
  post: "글",
  opinion: "논평",
  wire: "속보",
  filing: "공시",
  research: "리서치",
};

export function itemKindLabel(kind: string): string {
  return ITEM_KIND_LABELS[kind] ?? kind;
}

const ENTITY_KIND_LABELS: Record<SearchEntityKind, string> = { company: "기업", institution: "기관", person: "사람", topic: "주제" };

export function entityKindLabel(kind: SearchEntityKind | null | undefined): string {
  return kind ? (ENTITY_KIND_LABELS[kind] ?? kind) : "대상";
}

/** 출처 키의 기본 이름 — 응답의 출처 상태 줄에 이름이 있으면 그쪽을 씁니다. */
const SOURCE_LABELS: Record<string, string> = {
  google_ko: "구글 뉴스(한국어)",
  google_en: "구글 뉴스(영어)",
  bing: "Bing 뉴스",
  yahoo: "Yahoo Finance",
  naver: "네이버 증권",
  infomax: "연합인포맥스",
  event_news: "사건 뉴스(저장본)",
  info: "수집 글",
  guru: "거장 견해",
  wire: "속보",
  feeds: "보도자료·경제지 피드",
  watch: "관심 대상 수집",
  // 단계 4(계약 §7) — 공시·리서치 탭과 연결 보강
  sec: "SEC 공시(회사별)",
  sec_fts: "SEC 전문 검색(이름)",
  dart: "DART 공시",
  yahoo_research: "투자의견 변경(Yahoo)",
  naver_research: "증권사 리포트(네이버)",
  insiders: "내부자 명단(Yahoo)",
  gleif: "법인 관계(GLEIF)",
};

export function sourceLabel(source: string, statuses: readonly SearchSourceStatus[] = []): string {
  return statuses.find((status) => status.source === source)?.label || SOURCE_LABELS[source] || source;
}

const LANG_LABELS: Record<string, string> = { ko: "한국어", en: "영어", unknown: "모름" };
const langKey = (lang: string | null | undefined) => lang || "unknown";

/** 관계 이름(계약 3-3) — 이 대상에서 본 상대의 자리. 순서도 이 표 순서. */
const RELATION_LABELS: readonly [string, string][] = [
  ["owner_of", "소유한 곳"],
  ["owned_by", "소유자"],
  ["founded_by", "창업자"],
  ["founder_of", "창업한 곳"],
  ["employer", "소속"],
  ["employee", "구성원"],
  ["ceo", "대표"],
  ["ceo_of", "대표로 있는 곳"],
  ["insider", "내부자"],
  ["ultimate_parent", "최상위 모회사"],
  ["parent", "모회사"],
  ["subsidiary", "자회사"],
  ["manager", "운용자"],
  ["managed_by", "운용하는 기관"],
];

export type LinkGroup = { relation: string; label: string; links: SearchLink[] };

/** 관계 이름 — 모르는 관계는 이름 그대로. */
export function relationLabel(relation: string): string {
  return RELATION_LABELS.find(([key]) => key === relation)?.[1] ?? relation;
}

/** 연결을 관계별로 묶음 — 계약의 순서, 모르는 관계는 뒤에 이름 그대로. */
export function linkGroups(links: readonly SearchLink[]): LinkGroup[] {
  const order = new Map(RELATION_LABELS.map(([relation], at) => [relation, at]));
  const groups = new Map<string, LinkGroup>();
  for (const link of links) {
    let group = groups.get(link.relation);
    if (!group) {
      group = { relation: link.relation, label: relationLabel(link.relation), links: [] };
      groups.set(link.relation, group);
    }
    group.links.push(link);
  }
  const rank = (relation: string) => order.get(relation) ?? RELATION_LABELS.length;
  return [...groups.values()].sort((a, b) => rank(a.relation) - rank(b.relation));
}

const LINK_SOURCE_LABELS: Record<string, string> = { wikidata: "Wikidata", "13f": "13F 기관 목록", yahoo: "Yahoo", gleif: "GLEIF" };

/** 연결 한 줄의 출처 이름 — 모르는 출처는 키 그대로. */
export function linkSourceLabel(source: string): string {
  return LINK_SOURCE_LABELS[source] ?? source;
}

/** 같은 대상인지 가리는 키 — 관계 + 대상 키(모양이 맞을 때만, 없으면 null). */
const linkKeyId = (link: SearchLink) => (isEntityKey(link.key) ? `${link.relation}|${link.key}` : null);
/** 같은 이름인지 가리는 값 — 관계 + 이름(대소문자·공백·전각 무시). */
const linkNameId = (link: SearchLink) => `${link.relation}|${link.name.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()}`;

/**
 * 대상 풀기의 links(Wikidata·13F)와 연결 보강 경로(계약 §7-5 — 내부자·GLEIF)를 합침. 앞의 것이 먼저이고, 같은 관계에서
 * - 키가 같은 두 줄은 한 줄,
 * - 한쪽에 키가 없고 이름(대소문자·공백 무시)이 같으면 한 줄(Wikidata의 키 있는 모회사와 GLEIF의 키 없는 같은 이름 모회사 등)입니다.
 * 한 줄로 둘 때 앞 줄에 없는 키·종류·설명은 뒤 줄에서 채웁니다(출처는 앞 줄 그대로).
 * 키가 다른 두 줄은 이름이 같아도 따로 두고(동명이인), 키 없는 줄과 같은 이름의 키 있는 줄이 여럿이면 어느 쪽인지 짐작하지 않습니다.
 * 이름이 다르면(한국어 라벨과 법인 이름 등) 합치지 않습니다.
 */
export function mergeLinks(first: readonly SearchLink[], second: readonly SearchLink[]): SearchLink[] {
  const out: SearchLink[] = [];
  const byKey = new Map<string, number>();
  /** 이름 → 키 없는 줄(같은 이름의 키 없는 줄은 늘 한 줄로 합쳐져 하나뿐). */
  const keyless = new Map<string, number>();
  /** 이름 → 키 있는 줄들. */
  const keyed = new Map<string, number[]>();
  for (const link of [...first, ...second]) {
    const keyId = linkKeyId(link);
    const nameId = linkNameId(link);
    let index: number | undefined;
    if (keyId !== null) {
      index = byKey.get(keyId) ?? keyless.get(nameId);
    } else {
      const named = keyed.get(nameId) ?? [];
      index = keyless.get(nameId) ?? (named.length === 1 ? named[0] : undefined);
    }
    if (index === undefined) {
      index = out.length;
      out.push(link);
    } else {
      const kept = out[index];
      out[index] = {
        ...kept,
        key: linkKeyId(kept) !== null ? kept.key : keyId !== null ? link.key : kept.key,
        kind: kept.kind ?? link.kind,
        detail: kept.detail || link.detail || null,
      };
    }
    // 합친 줄을 그 키와 (이번 줄의) 이름으로 다시 찾게 합니다 — 키로 채운 줄은 키 없는 이름 칸에서 빼고 키 있는 줄로 옮김.
    const mergedKeyId = linkKeyId(out[index]);
    if (mergedKeyId === null) {
      keyless.set(nameId, index);
    } else {
      byKey.set(mergedKeyId, index);
      if (keyless.get(nameId) === index) keyless.delete(nameId);
      const named = keyed.get(nameId) ?? [];
      if (!named.includes(index)) keyed.set(nameId, [...named, index]);
    }
  }
  return out;
}

export type LinksView = {
  /** 관계별 묶음(두 응답을 합친 것). */
  groups: LinkGroup[];
  /** 연결 보강 경로의 받는 중·실패 한 줄(글 — 색만이 아님). 받았으면 null. */
  extra: { state: "loading" | "error"; text: string } | null;
  /** 연결 보강 경로의 출처 상태 줄(받기 전·실패면 빈 목록). */
  sources: SearchSourceStatus[];
  /** 보일 연결이 없을 때의 안내 — 받는 중이면 null('없음'을 미리 말하지 않음), 받지 못한 출처가 있으면 모른다고. */
  empty: string | null;
  /** 대상을 풀지 못했거나 푸는 중이라 Wikidata·13F 연결을 모를 때, 또는 Wikidata를 받지 못했을 때(사유와 함께)의 한 줄. */
  entityNote: string | null;
};

const EXTRA_NAME = "내부자 명단·법인 관계";

/**
 * 연결 탭의 화면 상태(계약 §7-7) — 대상 풀기의 links는 바로 보이고, 연결 보강 경로(GET /api/search/links)는 받는 중·실패를 글로 적습니다.
 * 출처마다의 건너뜀(LEI 없음·미국 상장사 아님)과 실패는 출처 상태 줄(sources)이 글로 보입니다. 대상은 풀렸지만 Wikidata를 받지 못했으면
 * (대상 풀기의 errors.wikidata — 실패·외부 조회 안 함) Wikidata 관계를 모르므로 그 사유를 한 줄로 두고, 연결이 없어도 '없다'고 하지 않습니다.
 * 실패 뒤 다시 받는 동안은(앞 응답이 남아 있어도) 받는 중으로 둡니다. 받은 응답을 다시 읽는 동안은 보이던 그대로입니다.
 *
 * @param entity 풀린 대상(없으면 null) · @param entitySettled 대상 풀기 응답이 왔는지(실패 포함) · @param entityErrors 대상 풀기 응답의 errors
 * @param response 연결 보강 응답(받기 전·요청 실패면 null) · @param loading 받는 중인지 · @param error 요청 실패 글
 */
export function linksView(args: {
  entity: Pick<SearchEntity, "links"> | null;
  entitySettled: boolean;
  entityErrors: Readonly<Record<string, string>>;
  response: SearchLinksResponse | null;
  loading: boolean;
  error: string | null;
}): LinksView {
  const { entity, entitySettled, entityErrors, response, loading, error } = args;
  const answered = response?.available === true;
  const sources = answered ? (response.sources ?? []) : [];
  const groups = linkGroups(mergeLinks(entity?.links ?? [], answered ? (response.links ?? []) : []));

  let extra: LinksView["extra"] = null;
  if (!answered) {
    if (loading || (!response && !error)) extra = { state: "loading", text: `${EXTRA_NAME}를 받는 중… (외부 출처를 부르면 몇 초 걸립니다)` };
    else if (response) extra = { state: "error", text: `${EXTRA_NAME}를 받지 못했습니다 — ${response.message || "수집기에서 응답을 받지 못했습니다."}` };
    else extra = { state: "error", text: `${EXTRA_NAME}를 받지 못했습니다 — ${error}` };
  }

  // 대상 풀기 시간 초과(errors.entity)도 Wikidata 관계를 모르는 것 — 수집기 _unknown_lei(GLEIF 상태)와 같은 기준.
  const wikidataError = entity ? (entityErrors.wikidata ?? entityErrors.entity ?? null) : null;
  const entityNote = entity
    ? wikidataError
      ? `Wikidata 관계를 받지 못했습니다 — ${wikidataError}`
      : null
    : entitySettled
      ? "대상을 풀지 못해 Wikidata 관계·13F 운용자·기관 연결은 모릅니다."
      : "대상을 푸는 중… (Wikidata 관계·13F 운용자·기관)";

  let empty: string | null = null;
  if (groups.length === 0 && extra?.state !== "loading" && (entity || entitySettled)) {
    const missed = extra?.state === "error" || !entity || wikidataError !== null || sources.some((source) => UNANSWERED.has(source.status));
    empty = missed
      ? "찾은 연결이 없습니다 — 받지 못한 출처가 있어 연결이 더 있는지 모릅니다(위 안내와 아래 출처 상태를 보세요)."
      : "가진 연결이 없습니다 — Wikidata 관계, 13F 운용자·기관, 미국 상장사의 내부자 명단(Yahoo), LEI가 있는 법인의 모회사·자회사(GLEIF)에서 찾습니다.";
  }
  return { groups, extra, sources, empty, entityNote };
}

// ------------------------------------------------------------------ 출처 상태

const STATUS_TEXT: Record<string, { text: string; tone: "ok" | "warn" | "danger" | "neutral" }> = {
  ok: { text: "받음", tone: "ok" },
  cached: { text: "캐시", tone: "ok" },
  empty: { text: "결과 없음", tone: "neutral" },
  error: { text: "실패", tone: "danger" },
  skipped: { text: "건너뜀", tone: "neutral" },
  owner_only: { text: "운영자 전용", tone: "neutral" },
  offline: { text: "외부 조회 안 함(저장본만)", tone: "warn" },
  later: { text: "다음 단계", tone: "neutral" },
  pending: { text: "받는 중", tone: "neutral" },
  server_only: { text: "서버에서만", tone: "neutral" },
};

/** 거른 건수 한 줄 — 0이 아닌 것만. 모두 0이거나 모르면 null. */
export function droppedText(dropped: SearchSourceStatus["dropped"]): string | null {
  if (!dropped) return null;
  const parts = [
    dropped.old > 0 ? `2년 밖 ${dropped.old}건` : null,
    dropped.noTime > 0 ? `시각을 알 수 없음 ${dropped.noTime}건` : null,
    dropped.chinese > 0 ? `중국어 제목 ${dropped.chinese}건` : null,
    dropped.excluded > 0 ? `제외 매체 ${dropped.excluded}건` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `뺀 줄: ${parts.join(" · ")}` : null;
}

export type SourceStatusView = {
  label: string;
  status: string;
  tone: "ok" | "warn" | "danger" | "neutral";
  count: string;
  dropped: string | null;
  message: string | null;
};

/** 출처 상태 한 줄(계약 §5 — 이름 · 상태 글 · 건수 · 거른 건수). 색만으로 가르지 않게 상태는 글로 둡니다. 모르는 상태는 코드 그대로. */
export function sourceStatusView(status: SearchSourceStatus): SourceStatusView {
  const known = STATUS_TEXT[status.status];
  return {
    label: status.label || sourceLabel(status.source),
    status: known?.text ?? status.status,
    tone: known?.tone ?? "neutral",
    count: typeof status.count === "number" ? `${status.count}건` : EMPTY,
    dropped: droppedText(status.dropped),
    message: status.message || null,
  };
}

/** 받는 중인 출처(pending)가 있으면 다시 읽는 간격(ms), 없으면 0. */
export const FEED_PENDING_REFRESH_MS = 4000;

export function feedRefreshMs(feed: Pick<SearchFeedResponse, "pending"> | null | undefined): number {
  return feed?.pending === true ? FEED_PENDING_REFRESH_MS : 0;
}

// ------------------------------------------------------------------ 거르기

export type FeedFacet = { key: string; label: string; count: number };
export type FeedFacets = { kind: FeedFacet[]; source: FeedFacet[]; lang: FeedFacet[] };
/** 끈 값(그 값의 줄을 뺌). 빈 목록이면 모두 보임. */
export type FeedFilters = { kind: string[]; source: string[]; lang: string[] };

export const NO_FILTERS: FeedFilters = { kind: [], source: [], lang: [] };

function facet(items: readonly SearchFeedItem[], keyOf: (item: SearchFeedItem) => string, labelOf: (key: string) => string): FeedFacet[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1);
  // 많은 것부터, 같으면 처음 나온 순서(정렬은 안정).
  return [...counts.entries()].map(([key, count]) => ({ key, label: labelOf(key), count })).sort((a, b) => b.count - a.count);
}

/** 거르기 칸의 값과 건수(받은 자료 기준 — 고른 기간 안, 거르기 전). */
export function facetCounts(items: readonly SearchFeedItem[], statuses: readonly SearchSourceStatus[] = []): FeedFacets {
  return {
    kind: facet(items, (item) => item.kind, itemKindLabel),
    source: facet(items, (item) => item.source, (key) => sourceLabel(key, statuses)),
    lang: facet(items, (item) => langKey(item.lang), (key) => LANG_LABELS[key] ?? key),
  };
}

export function applyFilters(items: readonly SearchFeedItem[], filters: FeedFilters): SearchFeedItem[] {
  return items.filter(
    (item) => !filters.kind.includes(item.kind) && !filters.source.includes(item.source) && !filters.lang.includes(langKey(item.lang)),
  );
}

export function hasFilters(filters: FeedFilters): boolean {
  return filters.kind.length + filters.source.length + filters.lang.length > 0;
}

// ------------------------------------------------------------------ 대상 머리·바로가기·보유

/** 머리의 식별자 칸 — 있는 것만(티커·시장, 종목코드, CIK, DART 고유번호, Wikidata). */
export function identifierChips(entity: Pick<SearchEntity, "ids">): string[] {
  const { ids } = entity;
  const chips: string[] = [];
  if (ids.market === "kr" && (ids.stockCode || ids.ticker)) chips.push(`${ids.stockCode ?? ids.ticker} · 한국`);
  else if (ids.market === "us" && ids.ticker) chips.push(`${ids.ticker} · 미국`);
  else if (ids.ticker) chips.push(ids.ticker);
  if (ids.cik) chips.push(`CIK ${ids.cik}`);
  if (ids.dartCorpCode) chips.push(`DART ${ids.dartCorpCode}`);
  if (ids.wikidata) chips.push(`Wikidata ${ids.wikidata}`);
  return chips;
}

/** 다른 화면으로 가는 바로가기 — 종목이면 종목 상세, 13F 기관(cik: 키)이면 기관 상세. 차트·시세는 이 화면에 그리지 않습니다. */
export function entityShortcuts(entity: Pick<SearchEntity, "key" | "ids">): { label: string; href: string }[] {
  const { ids } = entity;
  const out: { label: string; href: string }[] = [];
  if (ids.market === "us" && ids.ticker) out.push({ label: "종목 상세", href: stockHref("us", ids.ticker) });
  else if (ids.market === "kr" && ids.stockCode) out.push({ label: "종목 상세", href: stockHref("kr", ids.stockCode) });
  if (entity.key.startsWith("cik:")) out.push({ label: "기관 상세", href: institutionHref(entity.key.slice("cik:".length)) });
  return out;
}

const HANGUL = /[가-힣]/;

/** 13F 보유 기관 검색어(GET /api/guru/holders — 공시 이름은 대문자 영문) — 영문 이름에서 법인 꼬리를 떼고, 영문 이름이 없으면 티커. */
export function holdersQuery(entity: Pick<SearchEntity, "name" | "nameEn" | "ids">): string | null {
  const english = entity.nameEn ?? (HANGUL.test(entity.name) ? null : entity.name);
  return holderQuery(english) ?? entity.ids.ticker ?? null;
}

/** 보유 자료(13F 보고 날짜들)의 2년 규칙 — 2년 안의 날짜와 가장 최근 날짜. 2년 안이 비면 화면은 '최근 2년 안의 자료가 없습니다'. */
export function holdingsWindow(reportDates: readonly string[], today: string): { recent: string[]; latest: string | null } {
  const start = rangeStart("2y", today);
  const latest = reportDates.reduce<string | null>((best, date) => (best === null || date > best ? date : best), null);
  return { recent: reportDates.filter((date) => date >= start), latest };
}

// ------------------------------------------------------------------ 키보드·링크·원문 팝업

/** ↑↓로 고른 줄 옮기기 — 끝에서 멈춤, 고른 줄이 없으면 첫 줄. 줄이 없으면 -1. */
export function nextRowIndex(current: number, key: "ArrowUp" | "ArrowDown", length: number): number {
  if (length <= 0) return -1;
  if (current < 0) return 0;
  return key === "ArrowDown" ? Math.min(current + 1, length - 1) : Math.max(current - 1, 0);
}

type ShortcutTarget = { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown } | null;

/**
 * '/'로 검색창에 갈 키인가 — 수식키(Ctrl·⌘·Alt)가 없고, 한글 조합 중이 아니고, 다른 입력칸·편집 영역·대화상자 안이 아닐 때만.
 * 상단 통합 검색의 ⌘K/Ctrl+K는 그대로 둡니다.
 */
export function isSlashShortcut(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  target: ShortcutTarget | EventTarget;
}): boolean {
  if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return false;
  const target = event.target as ShortcutTarget;
  if (!target) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return false;
  return !(typeof target.closest === "function" && target.closest('[role="dialog"]'));
}

/** 원문 주소 — http(s)만(javascript: 등은 링크로 두지 않음). */
export function httpUrl(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

type TimedItem = Pick<SearchFeedItem, "publishedAt"> & Partial<Pick<SearchFeedItem, "timeBasis">>;

/**
 * 날짜만 아는 줄인가(계약 §7-1 — DART 접수일·EDGAR 전문 검색 접수일·네이버 리포트 날짜). publishedAt은 그 날짜의 출처 달력 00:00을 UTC로 바꾼 값이라
 * KST 날짜가 출처의 날짜와 같고, 시각은 뜻이 없어 보이지 않습니다.
 */
export function isDateOnly(item: Partial<Pick<SearchFeedItem, "timeBasis">>): boolean {
  return item.timeBasis === "date";
}

/** 줄의 시각 한 줄(KST, 분까지) — 날짜만 아는 줄은 날짜만(YYYY-MM-DD), 모르면 '—'. */
export function itemTimeText(item: TimedItem): string {
  const date = kstDate(item.publishedAt);
  if (isDateOnly(item)) return date ?? EMPTY;
  const time = kstTime(item.publishedAt);
  return date && time ? `${date} ${time} KST` : EMPTY;
}

/** 목록의 시각 칸(날짜 묶음 아래) — KST 시각(HH:mm), 날짜만 아는 줄은 날짜, 모르면 '—'. */
export function rowTimeText(item: TimedItem): string {
  if (isDateOnly(item)) return kstDate(item.publishedAt) ?? EMPTY;
  return kstTime(item.publishedAt) ?? EMPTY;
}

/** 수집 글(readerId가 있는 줄 — 운영자)을 원문 팝업(ReaderDialog)에 여는 모양. 본문·요약은 id로 서버에서 읽습니다. */
export function readerOfFeedItem(item: SearchFeedItem, label: string): ReaderEntry {
  return {
    key: `search:${item.id}`,
    sourceLabel: label,
    time: itemTimeText(item),
    title: item.title,
    titleKo: null,
    url: httpUrl(item.url),
    itemId: item.readerId,
    hasBody: true,
    text: null,
    note: "운영 서버가 받아 둔 글입니다 — 본문이 없으면 원문에서 보세요.",
  };
}

// ------------------------------------------------------------------ 관심 대상(단계 3 — 계약 §6-4)

/** 등록할 키 — 풀린 대상의 대표 키(계약 §2 — 상장사 us:/kr:, 13F 기관 cik:, 그 밖 wd:, 주제 topic:), 풀지 못했으면 주소의 키. */
export function watchKeyOf(entityKey: string, entity: Pick<SearchEntity, "key"> | null | undefined): string {
  return entity && isEntityKey(entity.key) ? entity.key : entityKey;
}

/** 이 대상이 내 관심 대상인가 — 주소의 키나 풀린 대상의 대표 키와 같은 줄(wd:로 열어도 us: 대표 키로 등록한 줄을 찾음). */
export function findWatch(
  items: readonly SearchWatchItem[],
  entityKey: string,
  entity: Pick<SearchEntity, "key"> | null | undefined,
): SearchWatchItem | null {
  return items.find((item) => item.key === entityKey || (entity ? item.key === entity.key : false)) ?? null;
}

const NEW_COUNT_MAX = 999;

/** 새 글 수 꼬리표 — 1건 이상일 때만 '새 글 n'(999 넘으면 '999+'). 모르면(null) 0으로 채우지 않고 null — 화면은 그리지 않습니다. */
export function newCountText(count: number | null | undefined): string | null {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return null;
  return `새 글 ${count > NEW_COUNT_MAX ? `${NEW_COUNT_MAX}+` : Math.floor(count)}`;
}

/** 관심 대상의 새 글 수 합계(좁은 화면의 접힌 서랍 머리) — 1건 이상인 수만 더합니다. 모르는 수(null)는 0으로도 세지 않습니다. */
export function watchNewTotal(items: readonly Pick<SearchWatchItem, "newCount">[]): number {
  return items.reduce((total, item) => {
    const count = item.newCount;
    return typeof count === "number" && Number.isFinite(count) && count > 0 ? total + Math.floor(count) : total;
  }, 0);
}

const countOrEmpty = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) ? String(value) : EMPTY);

/** 상한 한 줄 — '내 목록 2 / 10 · 서버 전체 40 / 100'. 모르는 값은 '—', 상한 칸이 없으면 null. */
export function watchLimitsText(limits: SearchWatchLimits | null | undefined): string | null {
  if (!limits) return null;
  return `내 목록 ${countOrEmpty(limits.mine)} / ${countOrEmpty(limits.max)} · 서버 전체 ${countOrEmpty(limits.serverUsed)} / ${countOrEmpty(limits.serverMax)}`;
}

/**
 * 정기 수집 안내(지시문 §5 — 로컬·QA에서는 등록·조회만 되고 정기 수집은 서버에서만). 켜진 곳이면 null, 꺼졌으면 그렇다고, 모르면 모른다고.
 */
export function watchCollectingNote(collecting: boolean | null | undefined): string | null {
  if (collecting === true) return null;
  if (collecting === false) return "정기 수집은 서버에서만 돕니다 — 이 환경에서는 등록·조회만 되고 새 글은 모이지 않습니다.";
  return "정기 수집이 켜져 있는지 확인하지 못했습니다.";
}

/** 오류 응답의 상태 코드(lib/api의 ApiError — 모양으로 읽어 화면 시험의 가짜 api와도 맞음). */
function statusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) return null;
  const status = Number((error as { status: unknown }).status);
  return Number.isFinite(status) ? status : null;
}

/** 서버가 사유를 주지 않았을 때 lib/api가 만드는 글. */
const GENERIC_FAILURE = /^요청 실패 \(HTTP \d+\)$/;

/**
 * 쓰기(관심 대상 등록·해제, 제외 매체 더하기·지우기)의 실패 문구 — 상한·중복(409)·입력(400)은 서버가 준 사유를 그대로 글로 보이고,
 * 사유가 없으면 conflict(409)·일반 문구. 권한(403 — 데모 등)은 서버 사유, 없으면 '이 계정으로는 할 수 없습니다'.
 */
export function writeErrorText(error: unknown, conflict: string): string {
  if (!(error instanceof Error)) return "알 수 없는 오류";
  const status = statusOf(error);
  const generic = !error.message || GENERIC_FAILURE.test(error.message);
  if (status === 409 && generic) return conflict;
  if (status === 403 && generic) return "이 계정으로는 할 수 없습니다";
  return error.message || "알 수 없는 오류";
}

/** 새로 받기에서 받지 못한 출처의 상태(실패·외부 조회 안 함) — 받음·캐시·결과 없음·건너뜀은 받지 못한 것이 아닙니다. */
const NOT_RECEIVED = new Set(["error", "offline"]);

/**
 * '지금 새로 받기' 뒤의 한 줄 — 서버가 준 글(10분 상한 등)이 있으면 그것, 없으면 받은 시각(KST). 받지 못한 출처가 있으면
 * 그렇다고 붙입니다(어느 출처인지는 아래 출처 상태 줄).
 */
export function refreshNoteText(feed: {
  refreshNote?: string | null;
  fetchedAt?: string | null;
  sources?: readonly Pick<SearchSourceStatus, "status">[] | null;
}): string {
  const base = feed.refreshNote
    ? feed.refreshNote
    : feed.fetchedAt
      ? `새로 받았습니다 — 받은 시각 ${formatKst(feed.fetchedAt)} KST`
      : "새로 받았습니다";
  const partial = (feed.sources ?? []).some((source) => NOT_RECEIVED.has(source.status));
  return partial ? `${base} — 일부 출처는 받지 못함(아래 출처 상태)` : base;
}

// ------------------------------------------------------------------ 매체 제외 목록(단계 3 — 계약 §6-2)

export type ExcludeKind = "domain" | "name";

const EXCLUDE_KIND_LABELS: Record<string, string> = { domain: "도메인", name: "이름" };

export function excludeKindLabel(kind: string): string {
  return EXCLUDE_KIND_LABELS[kind] ?? kind;
}

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NAME_MAX = 80;
const NOTE_MAX = 200;

/**
 * 붙여 넣은 주소·호스트 → 소문자 호스트(https:// 같은 앞부분·경로·포트·끝 점·앞의 www.를 뗌 — 수집기 normalize_domain·백엔드와 같게).
 * host는 보낼 값(국제화 도메인은 ASCII — punycode), typed는 punycode로 바꾸기 전의 표기(메모에 남김).
 */
function hostOf(raw: string): { host: string; typed: string } {
  let typed = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  if (typed.startsWith("www.")) typed = typed.slice("www.".length);
  return { host: asciiHost(typed), typed };
}

/**
 * 유니코드 표기 호스트 → punycode(백엔드 IDN.toASCII와 같은 결과 — 브라우저 URL 파서가 바꿈). ASCII 호스트와, 공백·'@'·역슬래시·':'·'%'가
 * 든 값은 그대로 둡니다(아래 모양 검사가 거절 — URL 파서가 사용자 칸·퍼센트 표기를 풀어 다른 호스트가 되지 않게).
 */
function asciiHost(host: string): string {
  if (!/[\u0080-\uffff]/.test(host) || /[\s@\\:%]/.test(host)) return host;
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return host;
  }
}

function isDomain(host: string): boolean {
  if (!host || host.length > 253) return false;
  const labels = host.split(".");
  return labels.length >= 2 && labels.every((label) => DOMAIN_LABEL.test(label));
}

export type ExcludeDraft =
  | { ok: true; body: { kind: ExcludeKind; value: string; note: string | null } }
  | { ok: false; message: string };

/** 목록의 도메인 가운데 이 호스트를 이미 덮는 것(같은 값 제외, 점 경계 — news.example.com은 example.com에 걸림). 없으면 null. */
function coveringDomain(host: string, existing: readonly { kind: string; value: string }[]): string | null {
  const row = existing.find((entry) => entry.kind === "domain" && host.endsWith(`.${entry.value.toLowerCase()}`));
  return row ? row.value.toLowerCase() : null;
}

/**
 * 더할 제외 매체(운영자) — 도메인은 소문자 호스트(주소를 붙여 넣어도 호스트만, 앞의 www.는 뗌, 국제화 도메인은 punycode — 대조는 서버가 점 경계로),
 * 이름은 앞뒤 공백만 뗌(가운데 공백은 그대로 — 백엔드·수집기가 그 값으로 대소문자 무시 완전 일치 대조). 메모는 비면 null — 국제화 도메인을
 * 유니코드로 넣었으면 '입력: 그 표기'(브라우저에 punycode를 되돌리는 기능이 없어 목록이 punycode로만 보이므로). 이미 있는 값(처음 값·더한 것,
 * 같은 종류·대소문자 무시)과 목록의 도메인이 덮는 아래 주소(점 경계)는 다시 보내지 않습니다.
 * 서버가 같은 검사를 다시 합니다 — 이것은 틀린 값으로 400을 부르지 않게 하는 앞단입니다.
 */
export function excludeDraft(
  kind: ExcludeKind,
  value: string,
  note: string | null | undefined,
  existing: readonly { kind: string; value: string }[],
): ExcludeDraft {
  let clean: string;
  let typedNote: string | null = null;
  if (kind === "domain") {
    const { host, typed } = hostOf(value);
    clean = host;
    if (!isDomain(clean)) return { ok: false, message: "도메인 모양이 아닙니다 — 예: example.com" };
    // 유니코드로 넣은 국제화 도메인(punycode로 바뀜)이면 넣은 표기를 메모 대신으로.
    if (typed !== host) typedNote = `입력: ${typed}`;
  } else {
    clean = value.trim();
    if (!clean) return { ok: false, message: "매체 이름을 넣어 주세요" };
    if (Array.from(clean).length > NAME_MAX) return { ok: false, message: `매체 이름은 ${NAME_MAX}자까지입니다` };
    if (CONTROL.test(clean)) return { ok: false, message: "매체 이름에 쓸 수 없는 글자가 있습니다" };
  }
  const lowered = clean.toLowerCase();
  if (existing.some((row) => row.kind === kind && row.value.toLowerCase() === lowered)) return { ok: false, message: "이미 목록에 있습니다" };
  const covering = kind === "domain" ? coveringDomain(lowered, existing) : null;
  if (covering) return { ok: false, message: `이미 목록의 ${covering}이(가) 이 도메인을 덮습니다` };
  const memo = (note ?? "").replace(/\s+/g, " ").trim();
  if (Array.from(memo).length > NOTE_MAX) return { ok: false, message: `메모는 ${NOTE_MAX}자까지입니다` };
  // 입력한 표기를 남기는 메모는 상한 안일 때만(넘으면 남기지 않음 — 쓰지 않은 메모로 거절하지 않게).
  const fallback = typedNote && Array.from(typedNote).length <= NOTE_MAX ? typedNote : null;
  return { ok: true, body: { kind, value: clean, note: memo || fallback } };
}

export type ExcludeSeedGroup = { group: string; items: { kind: string; value: string }[] };

const OTHER_GROUP = "그 밖";

/** 처음 값을 묶음별로(받은 순서) — 묶음이 없는 값은 '그 밖'. */
export function excludeSeedGroups(seed: readonly SearchExcludeSeed[]): ExcludeSeedGroup[] {
  const groups = new Map<string, ExcludeSeedGroup>();
  for (const row of seed) {
    const name = row.group || OTHER_GROUP;
    let group = groups.get(name);
    if (!group) {
      group = { group: name, items: [] };
      groups.set(name, group);
    }
    group.items.push({ kind: row.kind, value: row.value });
  }
  return [...groups.values()];
}
