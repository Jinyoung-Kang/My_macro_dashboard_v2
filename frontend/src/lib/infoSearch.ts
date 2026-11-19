/**
 * 정보 검색(/search — ADR 0041)의 화면 규칙 — React를 모르는 순수 함수(ADR 0004).
 *
 * 계약(docs/specs/2026-11-14-info-search-contract.md)의 화면 몫만 둡니다: 주소 상태(?q= · ?e=&tab=&range=), 대상 키 모양 검사(주소로 넘어가기 전),
 * 후보를 자동으로 고르지 않는 규칙, 2년 묶음을 7일·30일·1년·2년으로 자르기, KST 날짜 묶음, 빈 화면 안내, 출처 상태 글, 거르기, 키보드,
 * 단계 3의 관심 대상(대표 키·새 글 수·상한·정기 수집 안내)과 매체 제외 목록(더할 값 다듬기), 단계 4의 공시·리서치 탭(대상 종류에 따라)·날짜만 아는 줄·
 * 연결 보강(대상 풀기의 links와 합치기·받는 중/실패 글), 단계 5의 받는 중(pending — Finviz) 다시 읽기 횟수와 상태 글,
 * 단계 6 묶음 1의 기간 막대(KST 하루·월요일 시작 주)·같은 사건 묶어 보기·연결 그림 배치(계약 §9-1~9-3),
 * 묶음 2의 별칭 편집 검사·알림 켬/끔 칸·알림함 줄이 가는 주소(계약 §9-4·9-5), 묶음 3의 AI 요약 안내·근거 줄 맞추기·패널을 비우는 열쇠(계약 §9-6).
 * 2년 자르기·중국어 제목·매체 제외는 수집기가 원본이고 화면은 다시 구현하지 않습니다(계약 §1). 상단 통합 검색(⌘K)의 색인은 lib/search.ts입니다.
 */
import { holderQuery, institutionHref, stockHref } from "./detail";
import { EMPTY, formatKst } from "./format";
import type { ReaderEntry } from "./info";
import type {
  SearchArticle,
  SearchArticleResponse,
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
  SearchSummaryLine,
  SearchSummaryRequest,
  SearchSummaryResponse,
  SearchWatchItem,
  SearchWatchLimits,
  SearchWatchPartialBody,
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

/**
 * 주소에 모르는 탭·기간 값(tab=bogus·range=9y 등 — 화면은 기본값으로 보임)이 있으면 그 값을 기본값으로 바꾼 주소, 바꿀 것이 없으면 null(QA-421).
 * 대상(e)이 있는 주소만 봅니다. 빠진 탭·기간은 기본값으로 읽히므로 그대로 둡니다(알림 링크 `?e=…&tab=timeline` 등). 이름은 맞지만 이 대상에서
 * 고를 수 없는 탭(주제의 공시 등)은 대상의 종류를 알아야 해서 EntityView가 바꿔 씁니다.
 */
export function canonicalSearchHref(input: URLSearchParams | string | null | undefined): string | null {
  const params = typeof input === "string" || input == null ? new URLSearchParams(input ?? "") : input;
  const state = parseSearchUrl(params);
  if (!state.e) return null;
  const tab = params.get("tab");
  const range = params.get("range");
  const unknown = (tab !== null && tab !== state.tab) || (range !== null && range !== state.range);
  return unknown ? searchHref({ e: state.e, tab: state.tab, range: state.range }) : null;
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

/** 'YYYY-MM-DD' 날짜의 요일 번호(0 = 일요일). 달력 날짜라 시간대와 상관없습니다. */
function weekdayOf(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** 'YYYY-MM-DD (요일)'. */
const dateWithWeekday = (date: string) => `${date} (${WEEKDAYS[weekdayOf(date)]})`;

export type FeedDateGroup = { date: string; label: string; items: SearchFeedItem[] };

/** KST 날짜별 묶음(받은 순서 유지) — 제목은 'YYYY-MM-DD (요일)'. 시각 모르는 줄은 '시각 모름' 묶음으로 맨 뒤. */
export function groupByKstDate(items: readonly SearchFeedItem[]): FeedDateGroup[] {
  const groups: FeedDateGroup[] = [];
  const byDate = new Map<string, FeedDateGroup>();
  for (const item of items) {
    const date = kstDate(item.publishedAt) ?? "";
    let group = byDate.get(date);
    if (!group) {
      const label = date ? dateWithWeekday(date) : "시각 모름";
      group = { date, label, items: [] };
      byDate.set(date, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups.sort((a, b) => (a.date === b.date ? 0 : !a.date ? 1 : !b.date ? -1 : a.date < b.date ? 1 : -1));
}

// ------------------------------------------------------------------ 기간 막대(단계 6 — 계약 §9-1)

/** 막대 옆에 늘 적는 한 줄(지시문 §6 — 기간 막대는 받은 자료 기준). */
export const PERIOD_BARS_NOTE = "받은 자료 기준 — 출처마다 한 번에 주는 건수에 상한이 있어 전체 보도량이 아님";

/** 막대 한 칸의 길이 — 7일·30일은 하루, 1년·2년은 주(월요일 시작, KST). */
export type PeriodUnit = "day" | "week";

export function periodUnit(range: SearchRange): PeriodUnit {
  return range === "7d" || range === "30d" ? "day" : "week";
}

/** 날짜(YYYY-MM-DD)에 날 수를 더함(음수면 뺌). */
function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return dateText(new Date(Date.UTC(year, month - 1, day + days)));
}

/** 그 KST 날짜가 든 주의 월요일(월요일 시작 — 일요일은 그 앞 월요일). */
export function kstWeekStart(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

/** 막대 한 칸 — start·end는 KST 날짜(하루 칸은 같음, 주 칸은 월요일~일요일), count는 그 안의 줄 수. */
export type PeriodBin = { start: string; end: string; count: number };

export type PeriodBarsView = {
  unit: PeriodUnit;
  /** 오래된 칸부터. 날짜를 아는 줄이 없고 오늘도 모르면 빈 목록. */
  bins: PeriodBin[];
  /** 가장 큰 칸의 건수(막대 높이의 기준 — 모두 0이면 0). */
  max: number;
  /** 막대에 없는 줄 — 시각을 모르거나 막대 범위 밖(2년 밖·이틀 이상 뒤). 0으로 채우지 않고 화면이 따로 적습니다. */
  offChart: number;
};

/**
 * 고른 기간의 건수 막대(계약 §9-1) — 7일·30일은 하루씩, 1년·2년은 주(월요일 시작)마다, 작성 시각의 KST 날짜로 셉니다. 넣는 줄은 지금 탭·거르기를
 * 거친 줄이고(묶어 보기와 상관없이 줄 수), 받은 자료 기준입니다.
 *
 * 칸은 기간 시작 날(rangeStart)부터 오늘까지 — 서버가 센 기간(rangeCounts로 자른 줄)이 이 날짜 셈과 조금 어긋나 이른 줄이 섞이면 칸을 그 날까지
 * 늘리되 많아야 7일(주 단위는 4주, 2년 창 안)이고, 내일 날짜 줄(서버가 하루 뒤까지 받아 줌)도 담습니다. 그 밖은 막대 밖(offChart)으로 셉니다.
 *
 * @param today 서버의 오늘(window.to) 또는 브라우저 시계의 KST 날짜 — 모르면 받은 줄의 가장 최근 날짜
 */
export function periodBars(items: readonly SearchFeedItem[], range: SearchRange, today: string | null | undefined): PeriodBarsView {
  const unit = periodUnit(range);
  const dates = items.map((item) => kstDate(item.publishedAt)).filter((date): date is string => date !== null);
  const end = today ?? dates.reduce<string | null>((best, date) => (best === null || date > best ? date : best), null);
  if (!end) return { unit, bins: [], max: 0, offChart: items.length };

  const start = rangeStart(range, end);
  const stretched = addDays(start, unit === "week" ? -28 : -7);
  const twoYears = rangeStart("2y", end);
  const floor = stretched > twoYears ? stretched : twoYears;
  const ceiling = addDays(end, 1);
  const onChart = dates.filter((date) => date >= floor && date <= ceiling);
  let first = start;
  let last = end;
  for (const date of onChart) {
    if (date < first) first = date;
    if (date > last) last = date;
  }
  const align = unit === "week" ? kstWeekStart : (date: string) => date;
  const step = unit === "week" ? 7 : 1;
  const bins: PeriodBin[] = [];
  const at = new Map<string, number>();
  for (let start = align(first); start <= last; start = addDays(start, step)) {
    at.set(start, bins.length);
    bins.push({ start, end: addDays(start, step - 1), count: 0 });
  }
  for (const date of onChart) bins[at.get(align(date)) as number].count += 1;
  return { unit, bins, max: bins.reduce((best, bin) => Math.max(best, bin.count), 0), offChart: items.length - onChart.length };
}

/** 칸의 이름 — 하루는 'YYYY-MM-DD (요일)', 주는 'YYYY-MM-DD ~ YYYY-MM-DD 주'. */
export function periodLabel(bin: Pick<PeriodBin, "start" | "end">, unit: PeriodUnit): string {
  return unit === "day" ? dateWithWeekday(bin.start) : `${bin.start} ~ ${bin.end} 주`;
}

/** 막대 하나의 낭독 이름(색만으로 가르지 않음) — 이름과 건수. */
export function periodAriaLabel(bin: PeriodBin, unit: PeriodUnit): string {
  return `${periodLabel(bin, unit)} ${bin.count}건`;
}

/** 막대 아래 끝 눈금 — 하루는 'MM-DD', 주는 그 주 월요일의 'YYYY-MM-DD'. */
export function periodTickLabel(bin: Pick<PeriodBin, "start">, unit: PeriodUnit): string {
  return unit === "day" ? bin.start.slice(5) : bin.start;
}

/** 막대를 눌러 좁힌 칸에 드는 줄인가 — 작성 시각의 KST 날짜가 칸 안(양 끝 포함). 시각을 모르면 아님. */
export function itemInPeriod(item: Pick<SearchFeedItem, "publishedAt">, bin: Pick<PeriodBin, "start" | "end">): boolean {
  const date = kstDate(item.publishedAt);
  return date !== null && date >= bin.start && date <= bin.end;
}

// ------------------------------------------------------------------ 같은 사건 묶어 보기(단계 6 — 계약 §9-2)

/** 목록의 한 줄 — 결과 줄(member = 펼친 묶음 안의 줄). key는 줄의 id. */
export type FeedItemEntry = { type: "item"; key: string; item: SearchFeedItem; member: boolean };

/**
 * 대표 줄 아래의 묶음 줄('같은 사건 n건 · 매체 m곳 — 펼치기'). size·publishers는 보이는 줄로 센 값이고(매체 수는 서버 값을 넘지 않음),
 * 보이는 줄이 묶음 전체이면 매체 수는 서버(규칙 원본)의 값입니다. 매체를 하나도 모르면 publishers는 null. key = 'cluster:' + 묶음 id.
 * lead는 그 위의 대표 줄, members는 나머지 보이는 줄(펼치면 그 아래에 놓이는 차례 — 최근순) — 묶음 줄을 고르면 미리 보기가 이것을 보입니다.
 */
export type FeedClusterEntry = {
  type: "cluster";
  key: string;
  clusterId: string;
  size: number;
  publishers: number | null;
  expanded: boolean;
  lead: SearchFeedItem;
  members: SearchFeedItem[];
};

export type FeedEntry = FeedItemEntry | FeedClusterEntry;

export type FeedEntryGroup = { date: string; label: string; entries: FeedEntry[] };

/** 보이는 줄 가운데 같은 사건 묶음(보이는 줄이 둘 이상인 것만) — 묶음 id → 줄(받은 순서). */
function visibleClusters(items: readonly SearchFeedItem[]): Map<string, SearchFeedItem[]> {
  const byId = new Map<string, SearchFeedItem[]>();
  for (const item of items) {
    if (!item.clusterId) continue;
    const rows = byId.get(item.clusterId) ?? [];
    rows.push(item);
    byId.set(item.clusterId, rows);
  }
  for (const [id, rows] of byId) if (rows.length < 2) byId.delete(id);
  return byId;
}

/** 묶음의 대표로 보일 줄 — 서버의 대표(id = 묶음 id)가 보이면 그 줄, 아니면 보이는 줄 가운데 가장 이른 줄(서버와 같은 정의). */
function clusterLead(clusterId: string, rows: readonly SearchFeedItem[]): SearchFeedItem {
  const lead = rows.find((row) => row.id === clusterId);
  if (lead) return lead;
  return rows.reduce((best, row) => (row.publishedAt !== null && (best.publishedAt === null || row.publishedAt < best.publishedAt) ? row : best));
}

const MSN_TAIL = /\s+on\s+msn\s*$/i;
/**
 * 도메인 꼴 이름(앞의 www.는 뗌), 두 글자 국가 도메인 앞의 2단계 이름표, 이어 붙인 키의 앞·끝에서 떼는 글자와 뗀 뒤 남아야 하는 길이(짧은 이름의
 * 서로 다른 매체 — 'AB News'·'AB Media' — 가 한 곳이 되지 않게) — publisherKey의 재료.
 */
const HOST_NAME = /^(?:www\d?\.)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})$/;
const SECOND_LEVEL = new Set(["ac", "co", "com", "edu", "go", "gov", "ne", "net", "or", "org"]);
const PUBLISHER_HEAD = "the";
const PUBLISHER_TAILS = ["media", "news"];
const PUBLISHER_KEY_MIN = 3;

/**
 * 같은 사건 묶음의 매체 수를 셀 때만 쓰는 매체 키(QA-442 — 수집기 search_rules.publisher_key와 같은 규칙, 공유 고정본
 * `collector/tests/fixtures/search/publisher_keys.json`) — 같은 매체의 다른 표기('www.example.com'·'Example', 'Synth Alpha'·'SynthAlpha',
 * 'Kalsynth Media'·'Kalsynth')를 한 곳으로 봅니다. NFKC로 맞추고 MSN 재게재 꼬리를 뗀 소문자에서, 도메인 꼴이면 앞의 'www.'와 끝의 공개
 * 접미사(마지막 이름표, 두 글자 국가 도메인이면 그 앞의 co·com·net·org 등 하나 더)를 떼고 남은 이름표를 이어 붙입니다(하위 도메인은 남김).
 * 아니면 글자·숫자 낱말을 이어 붙입니다. 그렇게 이어 붙인 키에서 앞의 'the'와 끝의 'media'·'news' 하나를 떼되 뗀 뒤 세 글자(코드 포인트)
 * 이상 남을 때만 뗍니다 — 낱말이 아니라 키에서 떼야 도메인 꼴·붙여 쓴 이름('www.kalsynthmedia.com'·'TheSynth')과 띄어 쓴 이름이 같은 키가 됨.
 * 받아들인 장단(계약 §9-7, 고정본 acceptedMerges): 앞 'the'·끝 'news'·'media'만 다른 서로 다른 매체('X.com'·'X News')도 한 곳으로 셈.
 */
export function publisherKey(name: string | null | undefined): string {
  const text = (name ?? "").normalize("NFKC").trim().replace(MSN_TAIL, "").trim().toLowerCase();
  const host = HOST_NAME.exec(text);
  let key: string;
  if (host) {
    const labels = host[1].split(".");
    const suffix = labels.pop() as string;
    if (suffix.length === 2 && labels.length > 1 && SECOND_LEVEL.has(labels[labels.length - 1])) labels.pop();
    key = labels.join("");
  } else {
    key = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean).join("");
  }
  // 뗀 뒤 남는 길이는 수집기 len()과 같게 코드 포인트로 셈.
  const leaves = (affix: string) => Array.from(key).length - affix.length >= PUBLISHER_KEY_MIN;
  if (key.startsWith(PUBLISHER_HEAD) && leaves(PUBLISHER_HEAD)) key = key.slice(PUBLISHER_HEAD.length);
  const tail = PUBLISHER_TAILS.find((word) => key.endsWith(word) && leaves(word));
  return tail ? key.slice(0, -tail.length) : key;
}

/**
 * 서로 다른 매체 수 — 수집기 _publisher_count(규칙 원본)와 같은 규칙: 매체 키(publisherKey — 같은 매체의 다른 표기는 한 곳)로 세고, 이름이 없는
 * 줄은 매체 도메인으로 세되 그 도메인을 묶음 안에서 매체 하나만 썼으면 그 매체로, 아니면 그 도메인의 키로 봅니다(다른 줄의 매체 키와 같으면
 * 한 곳). 보이는 줄이 묶음의 일부일 때만 씁니다. 하나도 모르면 null(0으로 채우지 않음).
 */
function publisherCount(rows: readonly SearchFeedItem[]): number | null {
  const names = new Set<string>();
  const namesByDomain = new Map<string, Set<string>>();
  const bareDomains = new Set<string>();
  for (const row of rows) {
    const name = publisherKey(row.publisher);
    const domain = (row.publisherDomain ?? "").trim().toLowerCase();
    if (name) {
      names.add(name);
      if (domain) namesByDomain.set(domain, (namesByDomain.get(domain) ?? new Set<string>()).add(name));
    } else if (domain) {
      bareDomains.add(domain);
    }
  }
  const counted = new Set(names);
  for (const domain of bareDomains) if (namesByDomain.get(domain)?.size !== 1) counted.add(publisherKey(domain) || domain);
  return counted.size || null;
}

/**
 * 결과 목록·묶음 미리 보기의 매체 칸 — 매체 이름, 이름이 없으면 매체 도메인(받은 그대로 — 미리 보기 '매체' 칸의 글과 같음), 둘 다 없으면
 * null('—'). 묶음의 매체 수는 이름 없는 줄을 도메인으로 세므로(publisherCount) 그 줄의 매체 칸도 '—' 대신 도메인을 보여 무엇으로 셌는지
 * 보이게 합니다(QA 스택 기록 R3-SG3-5). domain이면 화면은 이름보다 덜 눈에 띄게 둡니다.
 */
export function publisherLabel(item: Pick<SearchFeedItem, "publisher" | "publisherDomain">): { text: string; domain: boolean } | null {
  const name = (item.publisher ?? "").trim();
  if (name) return { text: name, domain: false };
  const domain = (item.publisherDomain ?? "").trim();
  return domain ? { text: domain, domain: true } : null;
}

/** 서버가 준 매체 수(양수일 때만 — 0이나 모양이 틀린 값은 모름). */
const serverPublishers = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null);

/**
 * 묶음 줄 — 건수는 보이는 줄. 매체 수는 보이는 줄이 묶음 전체면 서버(규칙 원본)의 값, 일부면 보이는 줄로 센 값이되 서버 값(묶음 전체의 매체
 * 수)을 넘지 않게 합니다(일부의 매체가 전체보다 많을 수 없음 — 이름 없는 줄의 도메인 규칙은 일부만 보면 따로 셀 수 있음).
 * @param lead 보이는 대표 줄(clusterLead), rows의 나머지가 members
 * @param server 서버 대표 줄(id = 묶음 id — 거르기로 숨었어도 거르기 전 줄에서 찾음), 모르면 null
 */
function clusterEntry(
  clusterId: string,
  rows: readonly SearchFeedItem[],
  lead: SearchFeedItem,
  server: SearchFeedItem | null,
  expanded: boolean,
): FeedClusterEntry {
  const known = serverPublishers(server?.cluster?.publishers);
  const whole = server !== null && server.cluster?.size === rows.length && rows.some((row) => row.id === server.id);
  const counted = publisherCount(rows);
  const publishers = whole && known !== null ? known : counted !== null && known !== null ? Math.min(counted, known) : counted;
  const members = rows.filter((row) => row !== lead);
  return { type: "cluster", key: `cluster:${clusterId}`, clusterId, size: rows.length, publishers, expanded, lead, members };
}

const itemEntry = (item: SearchFeedItem, member: boolean): FeedItemEntry => ({ type: "item", key: item.id, item, member });

/** 보이는 줄 가운데 묶어 보일 묶음 수(보이는 줄이 둘 이상인 묶음) — 0이면 화면은 '묶어 보기' 전환을 두지 않습니다. */
export function feedClusterCount(items: readonly SearchFeedItem[]): number {
  return visibleClusters(items).size;
}

/**
 * 목록의 KST 날짜 묶음과 줄(계약 §9-2). 묶어 보기(grouped)면 같은 사건 묶음은 대표 줄(가장 이른 줄)만 그 날짜 자리에 두고, 그 아래 묶음 줄 하나,
 * 펼친 묶음(expanded)이면 그 아래 나머지 줄(받은 순서 — 최근순)을 member로 둡니다. 끄면 지금처럼 모든 줄. 보이는 줄이 하나뿐인 묶음(나머지가
 * 기간·거르기 밖)은 그냥 줄입니다. 건수 막대·기간 건수는 이 묶기와 상관없이 줄 수입니다.
 *
 * @param options.all 거르기 전 줄(받은 줄 전부) — 서버 대표 줄(묶음 전체의 매체 수)을 대표 줄이 기간·거르기로 숨었어도 찾습니다. 없으면 보이는 줄에서만.
 */
export function feedEntryGroups(
  items: readonly SearchFeedItem[],
  options: { grouped: boolean; expanded: ReadonlySet<string>; all?: readonly SearchFeedItem[] },
): FeedEntryGroup[] {
  if (!options.grouped) {
    return groupByKstDate(items).map((group) => ({ date: group.date, label: group.label, entries: group.items.map((item) => itemEntry(item, false)) }));
  }
  const clusters = visibleClusters(items);
  const leads = new Map<string, SearchFeedItem>();
  for (const [id, rows] of clusters) leads.set(id, clusterLead(id, rows));
  const servers = new Map<string, SearchFeedItem>();
  for (const row of [...items, ...(options.all ?? [])]) if (row.clusterId && row.id === row.clusterId && clusters.has(row.id) && !servers.has(row.id)) servers.set(row.id, row);
  const isLead = (item: SearchFeedItem) => !!item.clusterId && leads.get(item.clusterId) === item;
  const top = items.filter((item) => !item.clusterId || !clusters.has(item.clusterId) || isLead(item));
  return groupByKstDate(top).map((group) => ({
    date: group.date,
    label: group.label,
    entries: group.items.flatMap((item): FeedEntry[] => {
      if (!isLead(item)) return [itemEntry(item, false)];
      const id = item.clusterId as string;
      const rows = clusters.get(id) as SearchFeedItem[];
      const open = options.expanded.has(id);
      const cluster = clusterEntry(id, rows, item, servers.get(id) ?? null, open);
      const out: FeedEntry[] = [itemEntry(item, false), cluster];
      if (open) out.push(...cluster.members.map((row) => itemEntry(row, true)));
      return out;
    }),
  }));
}

/** 묶음의 건수 글 — '같은 사건 n건 · 매체 m곳'(매체 수를 모르면 그 칸 없이). 묶음 줄과 그 미리 보기의 머리가 같이 씁니다. */
export function clusterSizeText(entry: Pick<FeedClusterEntry, "size" | "publishers">): string {
  const publishers = entry.publishers !== null ? ` · 매체 ${entry.publishers}곳` : "";
  return `같은 사건 ${entry.size}건${publishers}`;
}

/** 묶음 줄의 글 — '같은 사건 n건 · 매체 m곳 — 펼치기'(펼쳤으면 '접기', 매체 수를 모르면 그 칸 없이). */
export function clusterToggleText(entry: Pick<FeedClusterEntry, "size" | "publishers" | "expanded">): string {
  return `${clusterSizeText(entry)} — ${entry.expanded ? "접기" : "펼치기"}`;
}

/** 펼친 줄이 놓인 날짜 묶음과 다른 KST 날짜면 'MM-DD'(시각 칸에 덧붙임). 같거나 모르거나 날짜만 아는 줄(이미 날짜)이면 null. */
export function otherDateText(item: Pick<SearchFeedItem, "publishedAt" | "timeBasis">, groupDate: string): string | null {
  if (isDateOnly(item)) return null;
  const date = kstDate(item.publishedAt);
  return date && date !== groupDate ? date.slice(5) : null;
}

// ------------------------------------------------------------------ 빈 화면

export type FeedEmpty = {
  /**
   * unknown = 답한 출처가 하나도 없어 2년 안에 자료가 있는지 모름(실패·외부 조회 안 함·건너뜀뿐).
   * period = 막대로 좁힌 날·주에 맞는 줄이 없음(좁힌 뒤 거르기를 바꾼 때 등 — 단계 6 계약 §9-1).
   */
  kind: "none2y" | "range" | "filtered" | "period" | "unknown";
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

/**
 * 물었어야 했는데 답을 받지 못했는가. Finviz의 건너뜀은 받지 못한 쪽으로 셉니다 — 그 줄은 미국 상장 회사에만 있고, 건너뜀은 검색 예산 소진·
 * 한 사람 빈도 상한·대기열 가득 참(계약 §8-2·8-4 — 물어야 했는데 보내지 않음)이라 '원래 묻지 않는 자리'가 아닙니다.
 */
function isUnanswered(source: SearchSourceStatus): boolean {
  return UNANSWERED.has(source.status) || (source.status === "skipped" && source.source === "finviz");
}

/**
 * 받지 못한 출처의 한 줄(없으면 null) — 외부 조회 안 함(데모·저장본만)·받는 중은 따로 말합니다.
 * pendingStalled = 받는 중 다시 읽기를 멈춘 뒤(12번 — 계약 §8-6)라 '몇 초 뒤'라고 하지 않습니다.
 */
export function feedSourceCaveat(sources: readonly SearchSourceStatus[], options: { pendingStalled?: boolean } = {}): string | null {
  const missed = sources.filter(isUnanswered);
  if (missed.length === 0) return null;
  if (missed.every((source) => source.status === "offline")) return "외부 출처는 부르지 않았습니다(저장본만 찾음) — 아래 출처 상태를 보세요.";
  const names = missed.map((source) => source.label || sourceLabel(source.source)).join(" · ");
  if (missed.every((source) => source.status === "pending")) {
    return options.pendingStalled
      ? `받는 중인 출처가 있습니다(${names}) — 아직 받지 못했습니다('다시 확인'을 누르면 한 번 더 읽습니다).`
      : `받는 중인 출처가 있습니다(${names}) — 몇 초 뒤 다시 읽습니다.`;
  }
  return `받지 못한 출처가 있습니다(${names}) — 아래 출처 상태를 보세요.`;
}

/**
 * 결과가 비었을 때의 안내(계약 §5).
 * - 2년 안에 하나도 없음 → '최근 2년 안의 자료가 없습니다' (+ 2년보다 오래된 것만 있었으면 '가장 최근 자료: 날짜' — 그 줄은 보이지 않음)
 *   단, 답한 출처가 하나도 없으면(모두 실패·외부 조회 안 함·건너뜀) '없다'고 하지 않고 모른다고 합니다(지시문 §8 — 실패를 빈 목록으로 숨기지 않음).
 * - 고른 기간에 없음 → '이 기간에는 자료가 없습니다' + 더 넓은 기간 단추(그 기간의 건수와 함께)
 * - 거르기 때문에 없음 → 그렇다고(기간 안내와 섞지 않음)
 * - 막대로 좁힌 날·주에 없음 → 그렇다고(좁히기를 풀 단추는 화면이 둠)
 * 받지 못한 출처가 있으면 앞의 두 안내에 caveat 한 줄을 붙입니다.
 *
 * @param total 2년 안의 줄 수 · @param inRange 고른 기간의 줄 수(거르기 전) · @param shown 거른 뒤 보이는 줄 수 · @param sources 출처 상태(없으면 지금처럼)
 * @param narrowed 막대로 좁혔으면 그 날·주의 줄 수(좁히지 않았으면 주지 않음)
 * @param pendingStalled 받는 중 다시 읽기를 멈췄는가(feedPendingPhase가 stalled)
 */
export function feedEmptyState(args: {
  total: number;
  inRange: number;
  shown: number;
  narrowed?: number;
  counts: Record<SearchRange, number>;
  range: SearchRange;
  olderOnlyLatest: string | null | undefined;
  sources?: readonly SearchSourceStatus[];
  pendingStalled?: boolean;
}): FeedEmpty | null {
  const sources = args.sources ?? [];
  const caveat = feedSourceCaveat(sources, { pendingStalled: args.pendingStalled });
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
  if (args.narrowed === 0) return { kind: "period", message: "좁힌 기간(막대)에 맞는 자료가 없습니다", note: null, caveat: null, wider: [] };
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
  // 단계 5(계약 §8) — 미국 상장 종목의 Finviz 종목 화면 한 쪽(수집기가 줄 세워 받는 대로 채움)
  finviz: "Finviz 종목 뉴스",
};

export function sourceLabel(source: string, statuses: readonly SearchSourceStatus[] = []): string {
  return statuses.find((status) => status.source === source)?.label || SOURCE_LABELS[source] || source;
}

/**
 * 대상 풀기(GET /api/search/entity — 계약 §3-3)의 출처 키 → 속성 칸의 출처 이름. '푼 출처'(entity.sources)와 '대상을 푸는 데 받지 못한 출처'(errors)가
 * 함께 씁니다. 키는 수집기(search_entities·search)가 정하고, 이름은 후보 목록(CandidateList)과 같습니다 — 이 sec·dart는 공시 피드가 아니라 CIK·고유번호
 * 표라 출처 상태 줄의 'SEC 공시(회사별)'·'DART 공시'를 쓰지 않습니다. dart('저장본에 이 종목이 없음')와 dart_store('저장본을 읽지 못함')는 같은 DART
 * 고유번호 표라 둘 다 'DART'(사유 글이 둘을 가름), entity는 한 출처가 아니라 풀기 전체의 시간 상한이라 '외부 출처'(저장본 이름으로만 답함).
 * 모르는 키는 코드 이름 대신 '기타 출처'(QA-429).
 */
const ENTITY_SOURCES: Record<string, string> = {
  wikidata: "Wikidata",
  sec: "SEC",
  dart: "DART",
  "13f": "13F 기관",
  universe: "종목 유니버스",
  dart_store: "DART",
  entity: "외부 출처",
};

export function entitySourceLabel(source: string): string {
  return Object.hasOwn(ENTITY_SOURCES, source) ? ENTITY_SOURCES[source] : "기타 출처";
}

/**
 * 대상을 푸는 데 받지 못한 출처의 글 — 출처마다 '이름(사유)'(사유가 없거나 비면 이름만), 출처 사이는 쉼표, 같은 글은 한 번만. 수집기 사유에는 ' · '·' — '가
 * 들어 있어(거부 사유 '거부됨 — 호스트 HTTP 429 · 5분 동안 이 출처 호출을 멈춤') 사유를 괄호에 묶고 출처를 쉼표로 이어야 출처 사이 구분과 섞이지 않습니다.
 * 속성 칸의 '대상을 푸는 데 받지 못한 출처'(errors)와 관심 대상 등록 503 partial 안내(watchPartialText)가 함께 씁니다 — 한 화면에서 같은 실패가 같은 글로.
 */
export function entityFailuresText(failures: readonly (readonly [source: string, reason: unknown])[]): string {
  const parts = failures.map(([source, reason]) => {
    const text = typeof reason === "string" ? reason.trim() : "";
    return text ? `${entitySourceLabel(source)}(${text})` : entitySourceLabel(source);
  });
  return [...new Set(parts)].join(", ");
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
  entity: (Pick<SearchEntity, "links"> & Partial<Pick<SearchEntity, "ids" | "kind">>) | null;
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
    // Wikidata 항목을 찾지 못한 대상(주제 밖)은 Wikidata 관계·LEI를 모름 — 수집기 _no_lei('Wikidata 항목을 찾지 못해 LEI를 모름')와 같은 기준.
    const noWikidataItem = !!entity && !!entity.ids && entity.kind !== "topic" && !entity.ids.wikidata;
    const missed = extra?.state === "error" || !entity || wikidataError !== null || noWikidataItem
      || sources.some((source) => UNANSWERED.has(source.status));
    empty = missed
      ? "찾은 연결이 없습니다 — 받지 못한 출처가 있어 연결이 더 있는지 모릅니다(위 안내와 아래 출처 상태를 보세요)."
      : "가진 연결이 없습니다 — Wikidata 관계, 13F 운용자·기관, 미국 상장사의 내부자 명단(Yahoo), LEI가 있는 법인의 모회사·자회사(GLEIF)에서 찾습니다.";
  }
  return { groups, extra, sources, empty, entityNote };
}

// ------------------------------------------------------------------ 연결 그림(단계 6 — 계약 §9-3)

/** 그림에 그리는 노드 상한 — 넘으면 '목록에서 n개 더'. */
export const LINK_GRAPH_MAX = 30;

/**
 * 노드를 두는 호 — 가운데에서 오른쪽(0)과 왼쪽(π)을 중심으로 위아래 65도씩. 위·아래 끝(극)에는 두지 않습니다: 노드 이름이 옆으로 뻗으므로
 * 극에서는 이웃 이름끼리 겹칩니다(좁은 화면의 세로로 긴 타원에서 특히 — 시각 확인).
 */
const GRAPH_ARC = (65 * Math.PI) / 180;
/** 노드 사이 각도의 상한(라디안) — 노드가 적으면 호 전체에 흩지 않고 가운데(좌우 한가운데)에 모읍니다. */
const GRAPH_MAX_STEP = 0.32;
/** 관계 묶음 사이의 틈(노드 칸의 몇 배). */
const GRAPH_GAP_UNITS = 0.8;
/** 그림 위아래 여백(px) — 맨 위·맨 아래 노드의 이름이 잘리지 않게. */
const GRAPH_MARGIN_Y = 18;
/** 관계 글 상자 높이(px)와 같은 쪽 관계 글 사이의 최소 세로 간격. */
const GRAPH_TAG_HEIGHT = 16;
const GRAPH_TAG_STEP = 18;
/**
 * 관계 묶음을 통째로 한쪽 호에 둘 때 같은 쪽 이웃 노드 사이에 남아야 하는 세로 간격(px) — 이보다 좁아지면(12px 이름이 붙음) 묶음 경계가 아니라
 * 칸 수로 반씩 나누고, 그때 쪼개진 묶음은 호마다 관계 글을 둡니다. 칸 수로 나눈 뒤에도 좁으면 그림을 높입니다(QA-424).
 */
const GRAPH_ROW_GAP = 14;
/** 가운데 대상 상자 높이(px). */
const GRAPH_CENTER_HEIGHT = 28;
/** 노드 원의 반지름(그린 원 5 + 테두리 1)과 노드 이름 글 상자의 반높이(12px 글자) — 관계 글이 이것과 겹치면 옮깁니다. */
const GRAPH_DOT_RADIUS = 6;
const GRAPH_LABEL_HALF_HEIGHT = 7;
/** 관계 글을 옮길 때 남기는 틈(px) — 노드 원·이름과 1, 가운데 상자·다른 관계 글과 2(같은 쪽 글의 세로 간격 GRAPH_TAG_STEP − GRAPH_TAG_HEIGHT와 같음). */
const GRAPH_TAG_ROOM_NODE = 1;
const GRAPH_TAG_GAP = GRAPH_TAG_STEP - GRAPH_TAG_HEIGHT;
/** 겹친 관계 글을 옮겨 볼 거리의 상한(px — 처음 자리에서). */
const GRAPH_TAG_SEARCH = 240;
/** 관계 글이 들 빈자리가 없을 때 세로 반지름을 늘리는 비율(한 번에)과 횟수. */
const GRAPH_TAG_GROW = 0.15;
const GRAPH_TAG_GROW_TRIES = 6;
/**
 * 글자 크기 12px에서 어림한 글자 폭(넉넉히 — 글꼴을 싣지 않아 그리는 글꼴은 기기마다 다름) — 한글·한자·가나·전각과 말줄임표 '…'(U+2026 — 줄인
 * 글마다 붙고 그림에서 12px로 그려짐, QA-423)와 넓은 대문자(라틴 M·W·Æ, 그리스 Μ·Ψ, 키릴 М·Ф·Ъ·Ы)는 12, 더 넓은 대문자(키릴 Ж·Ш·Щ·Ю, 라틴 Œ)는
 * 13.5, 그 밖의 키릴·그리스 대문자는 9.5, 그 밖의 대문자는 9, 나머지(소문자·숫자·빈칸·문장 부호)는 7.5. 글꼴 스택에서 쓰일 글꼴들(Pretendard·
 * Segoe UI·Arial·DejaVu Sans·맑은 고딕)의 12px 폭은 라틴 대문자 평균 7.4~8.1(M·W 10~11.9, 그 밖에서 가장 넓은 O 9.5), 키릴 Ж·Ш·Щ·Ю
 * 10.4~13.1, 그 밖의 넓은 대문자 8.5~12, 그 밖의 키릴 대문자는 О·Д·Ц 9.4~9.5를 비롯해 9를 넘는 것이 많고, 소문자 평균 5.9~6.8이라, 대문자를
 * 7.5로 세면 대문자가 많은 이름(GLEIF 법인명 등)의 글이 배정 폭을 넘었습니다(QA-423 후속). 소문자는 고르게 세므로 넓은 소문자(m·w, 키릴 ж·ш·щ·ю
 * — DejaVu Sans에서 9.8~11.7)만 몰린 글은 몇 px 넘을 수 있습니다.
 */
const WIDE_CHAR = /[\u1100-\u11ff\u2026\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;
const WIDE_UPPER = /[MWÆΜΨМФЪЫ]/;
const WIDER_UPPER = /[ЖШЩЮŒ]/;
const CYRILLIC_GREEK_UPPER = /[\u0386\u0388-\u038f\u0391-\u03ab\u0400-\u042f]/;
const UPPER = /\p{Lu}/u;
function charWidth(char: string): number {
  if (WIDER_UPPER.test(char)) return 13.5;
  if (WIDE_CHAR.test(char) || WIDE_UPPER.test(char)) return 12;
  if (CYRILLIC_GREEK_UPPER.test(char)) return 9.5;
  return UPPER.test(char) ? 9 : 7.5;
}
const textWidth = (text: string) => Array.from(text).reduce((sum, char) => sum + charWidth(char), 0);
const ELLIPSIS = "…";

/** 그림의 노드 이름 — 어림한 폭(12px 글자)이 maxPx를 넘으면 잘라 '…'(전체 이름은 낭독 이름과 목록에). */
export function fitGraphLabel(name: string, maxPx: number): string {
  const chars = Array.from(name.trim());
  if (textWidth(chars.join("")) <= maxPx) return chars.join("");
  let width = charWidth(ELLIPSIS);
  let out = "";
  for (const char of chars) {
    if (width + charWidth(char) > maxPx) break;
    width += charWidth(char);
    out += char;
  }
  return `${out.trimEnd()}${ELLIPSIS}`;
}

/** 폭 maxPx 안에 드는 앞쪽 글자들. */
function fitChars(chars: readonly string[], maxPx: number): string[] {
  const out: string[] = [];
  let width = 0;
  for (const char of chars) {
    if (width + charWidth(char) > maxPx) break;
    width += charWidth(char);
    out.push(char);
  }
  return out;
}

/** 가운데를 줄일 때 뒷부분이 끝까지 들지 않으면 앞부분에 남기는 폭(배정 폭에 대한 비율). */
const GRAPH_HEAD_SHARE = 0.3;

/**
 * 가운데를 줄인 노드 이름 — 앞부분 + '…' + from번째 글자(코드 포인트, 앞뒤 공백을 뗀 이름에서)부터의 뒷부분. 뒷부분이 끝까지 들면 앞부분은 남는 폭만큼,
 * 아니면 앞부분은 폭의 30%까지이고 뒷부분 끝에도 '…'. 다 들면 이름 그대로, 앞부분이 from 앞을 다 담으면(가운데를 줄일 것이 없음) fitGraphLabel과
 * 같고, 뒷부분이 한 글자도 들지 않을 만큼 폭이 작아도 끝을 자른 글입니다. 폭(12px 글자 어림 charWidth — '…'·넓은 대문자도 12 이상, 그 밖의 대문자 9~9.5)은 maxPx('…' 하나의 폭 12 이상)를 넘지 않습니다.
 */
export function fitGraphLabelFrom(name: string, from: number, maxPx: number): string {
  return fitLabelFrom(Array.from(name.trim()), from, maxPx, maxPx * GRAPH_HEAD_SHARE).label;
}

/**
 * fitGraphLabelFrom의 본체 — 앞부분 폭의 하한(minHeadPx)을 받고, 글과 함께 그 글이 이름의 몇째 글자까지 보이는지(end — 보인 마지막 글자 다음
 * 자리, 뒷부분이 끝까지 들면 이름 길이)를 돌려줍니다. chars는 앞뒤 공백을 뗀 이름의 글자들.
 */
function fitLabelFrom(chars: readonly string[], from: number, maxPx: number, minHeadPx: number): { label: string; end: number } {
  const whole = chars.join("");
  if (textWidth(whole) <= maxPx) return { label: whole, end: chars.length };
  const cutEnd = () => {
    const label = fitGraphLabel(whole, maxPx);
    return { label, end: Array.from(label).length - 1 };
  };
  const start = Math.min(Math.max(0, Math.floor(from)), chars.length);
  const ellipsis = charWidth(ELLIPSIS);
  const tailChars = chars.slice(start);
  const tail = tailChars.join("");
  const head = fitChars(chars.slice(0, start), Math.max(minHeadPx, maxPx - ellipsis - textWidth(tail)));
  if (head.length >= start) return cutEnd();
  const shownHead = head.join("").trimEnd();
  const room = maxPx - textWidth(shownHead) - ellipsis;
  if (textWidth(tail) <= room) return { label: `${shownHead}${ELLIPSIS}${tail}`, end: chars.length };
  // 뒷부분 끝의 '…' 몫까지 빼고 남는 폭에 뒷부분이 한 글자도 들지 않으면(폭이 아주 작음) '……'가 아니라 끝을 자른 글.
  const shownTail = Array.from(fitChars(tailChars, room - ellipsis).join("").trimEnd());
  if (shownTail.length === 0) return cutEnd();
  return { label: `${shownHead}${ELLIPSIS}${shownTail.join("")}${ELLIPSIS}`, end: start + shownTail.length };
}

/**
 * 노드 글이 그 이름으로 읽힐 수 있는가 — '…'로 나눈 조각이 이름 안에 차례로 있음(첫 조각은 이름의 앞머리, 끝에 '…'가 없으면 마지막 조각은 이름의
 * 끝). 줄이지 않은 글은 이름 그대로일 때만.
 */
function labelFitsName(label: string, name: string): boolean {
  const parts = label.split(ELLIPSIS);
  if (parts.length === 1) return label === name;
  if (!name.startsWith(parts[0])) return false;
  let at = parts[0].length;
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === "") continue;
    if (index === parts.length - 1) return name.endsWith(part) && name.length - part.length >= at;
    const found = name.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  return true;
}

/** 줄인 글이 같은 이름들을 가를 때 갈리는 자리를 낱말 첫 글자로 물리는 최대 글자 수('…12'처럼 숫자·낱말을 통째로 보이게). */
const GRAPH_WORD_BACK = 6;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const DIGIT = /\p{N}/u;

/**
 * 그림의 노드 글(QA-423) — 이름마다 fitGraphLabel(끝을 자름)로 맞추되, 서로 다른 이름의 글이 같아지면(앞머리가 같은 자회사 법인명·내부자 등) 그 이름들은
 * 가운데를 줄여(fitGraphLabelFrom) 서로 갈리는 자리부터 보입니다 — 그 자리가 든 낱말·숫자의 첫 글자부터(많아야 GRAPH_WORD_BACK자 앞, 빈칸이면 그
 * 뒤 글자부터 — 낱말에 붙은 번호 'Fund2020'·'제12호'·'스팩12호'는 낱말이 길거나 이름 첫머리부터여도 그 번호의 첫 자리부터)이고, 갈리는 글자가
 * 숫자면 그 숫자의 끝까지 보이게 앞부분(보통 폭의 30%)을 첫 글자 하나로 줄이기도 합니다(좁은 그림의 네 자리 번호 'E…2020…'·'E…2021…' —
 * '…0'·'…1'로 읽히지 않게, QA-423 후속·2차 검토 지적). 그 글로 그 이름들이 하나도 갈리지 않을 때만 갈리는 자리가 든 번호의 첫 자리부터, 그래도
 * 같으면 갈리는 바로 그 글자부터. 그래도 같은
 * 글이 남은 이름들은 다음 차례에 그 이름들끼리 같은 방식으로 다시 가릅니다(둘째 차례 이후에도 번호·낱말을 통째로 — QA-423 후속). 낱말 경계에서
 * 갈리면(모든 이름이 거기서 끝나거나 빈칸·부호) 이어지는 이름은 그 뒤 첫 낱말부터('…주식회사' 뒤 ' 베트남'이면 '가상…베트남'), 거기서 끝나는 이름만 끝
 * 낱말로 물립니다('Exa…Ltd'). 갈리는 자리 뒤에 보일 가르는 낱말이 없는 이름 하나는 새 글 대신 앞 차례의 글(묶음 밖 이름들과 가른 낱말이 든 글 —
 * 그 낱말이 통째로 들지 않으면 앞부분을 첫 글자로 줄여 더 보임)을 둘 수 있어, 다시 줄이면서 앞 차례의 가르는 낱말이 빠지지 않습니다(한글 법인명
 * '가…디스…'·'가…글로…'·'가…베트남'·'가…파운…', 배정 80에서 '가…글로벌…' — QA 재확인 개선 제안·검토 지적). 그렇게 몇 차례 해도
 * 같은 글이 남으면(같은 낱말이 되풀이되는 드문 이름 — 다른 자리의 글이 우연히 같아짐) 둘째 이름부터 아무도 쓰지 않은 글이 나올 때까지 보이는 자리를
 * 뒤로 옮깁니다. 겹치지 않는 이름의 글은 그대로이고, 같은 이름(앞뒤 공백 무시)은 같은 글. 돌려주는 표는 앞뒤 공백을 뗀 이름 → 글. 전체 이름은 노드의
 * <title>·낭독 이름과 목록에 있습니다.
 * 그렇게 고른 글이 기본 글(refine: false — 갈리는 자리를 낱말 첫 글자로 물리기만 하고, 낱말 경계의 물림·지킬 글은 쓰지 않음)보다 글만으로 가를 수
 * 없는 이름(unresolvedLabels)이 많으면 기본 글을 씁니다 — 지킬 글이 여러 묶음에 걸쳐 어긋나는 드문 이름 묶음에서도 기본 글보다 나빠지지 않게(검토 지적).
 */
export function graphLabels(names: readonly string[], maxPx: number, { refine = true }: { refine?: boolean } = {}): Map<string, string> {
  const distinct = [...new Set(names.map((name) => name.trim()))];
  const refined = splitGraphLabels(distinct, maxPx, refine);
  if (!refine) return refined;
  const plain = splitGraphLabels(distinct, maxPx, false);
  if (distinct.every((name) => plain.get(name) === refined.get(name))) return refined;
  return unresolvedLabels(plain) < unresolvedLabels(refined) ? plain : refined;
}

/**
 * 글만 보고 가를 수 없는 이름의 수 — 읽힐 수 있는 이름(labelFitsName)이 하나뿐인 글부터 그 이름에 붙이고 빼기를 되풀이한 뒤 남는 이름(읽는 사람이
 * 글을 보고 이름을 짐작하는 방식). 글이 제 이름이 아닌 이름 하나로만 읽히면 모두.
 */
function unresolvedLabels(labels: ReadonlyMap<string, string>): number {
  const open = new Set(labels.keys());
  for (let progress = true; progress && open.size > 0; ) {
    progress = false;
    for (const owner of [...open]) {
      const readers = [...open].filter((name) => labelFitsName(labels.get(owner)!, name));
      if (readers.length !== 1) continue;
      if (readers[0] !== owner) return labels.size;
      open.delete(owner);
      progress = true;
    }
  }
  return open.size;
}

/** graphLabels의 본체 — refine이 거짓이면 낱말 경계의 물림·지킬 글 없이(기본 글). distinct는 앞뒤 공백을 뗀 서로 다른 이름들. */
function splitGraphLabels(distinct: readonly string[], maxPx: number, refine: boolean): Map<string, string> {
  const labels = new Map(distinct.map((name) => [name, fitGraphLabel(name, maxPx)]));
  /**
   * 지킬 글을 둔 이름 → 둔 글·그 차례의 새 글·묶음. 다음 차례에 묶음의 다른 이름 글이 바뀌어 그 이름으로도 읽히게 되면(둔 글은 묶음 모두로 읽혀 다른
   * 이름들의 글로 가려지는데, 그 글이 가르지 못하게 됨) 새 글로 되돌리고 그 이름에는 다시 두지 않음(recheck — 검토 지적).
   */
  const keepers = new Map<string, { label: string; fresh: string; members: readonly string[] }>();
  const noKeep = new Set<string>();
  const recheck = () => {
    for (const [name, kept] of keepers) {
      if (labels.get(name) !== kept.label) {
        keepers.delete(name);
      } else if (kept.members.some((other) => other !== name && labelFitsName(labels.get(other)!, name))) {
        labels.set(name, kept.fresh);
        keepers.delete(name);
        noKeep.add(name);
      }
    }
  };
  /**
   * 묶음에서 새 글 대신 지금 글을 둘 이름(keeper)의 글 후보 — 앞 차례에서 다른 이름들과 가른 글이면 그 글. 아직 끝을 자른 글이면, 묶음 밖 이름
   * 가운데 앞머리가 가장 길게 같은 이름과 갈리는 자리(그 낱말의 첫 글자로 물림 — 6자 넘게 길거나 이름 첫머리까지면 물리지 않음)부터 보이는 글이 더
   * 뒤까지 보이면 그 글 먼저('가상전자글…' 대신 '가상…글로…' — 줄인 앞머리는 그 이름과 같은 글자뿐), 그다음 끝을 자른 글. 그 자리부터의 낱말(가르는
   * 낱말)이 앞부분 몫(폭의 30%) 때문에 통째로 들지 않고 앞부분을 첫 글자 하나로 줄인 글이 그 낱말을 더 보이면, 그 글(narrow)을 함께 돌려줘 앞의 글을
   * 둘 수 있을 때 대신 둠('가상…글로…' 대신 '가…글로벌…' — 검토 지적).
   */
  const keeperLabels = (name: string, chars: readonly string[], members: readonly string[]): { label: string; narrow?: string }[] => {
    const current = labels.get(name)!;
    const cutEnd = fitGraphLabel(name, maxPx);
    if (current !== cutEnd) return [{ label: current }];
    let outside = 0;
    for (const other of distinct) {
      if (members.includes(other)) continue;
      const otherChars = Array.from(other);
      let common = 0;
      while (common < chars.length && chars[common] === otherChars[common]) common += 1;
      outside = Math.max(outside, common);
    }
    if (outside === 0 || outside >= chars.length) return [{ label: current }];
    let from = outside;
    while (from > 0 && outside - from < GRAPH_WORD_BACK && LETTER_OR_DIGIT.test(chars[from - 1])) from -= 1;
    if (from === 0 || LETTER_OR_DIGIT.test(chars[from - 1])) from = outside;
    while (from < chars.length && /\s/.test(chars[from])) from += 1;
    let wordEnd = from;
    while (wordEnd < chars.length && LETTER_OR_DIGIT.test(chars[wordEnd])) wordEnd += 1;
    const wider = fitLabelFrom(chars, from, maxPx, maxPx * GRAPH_HEAD_SHARE);
    const narrow = wider.end < wordEnd ? fitLabelFrom(chars, from, maxPx, charWidth(chars[0])) : wider;
    if (wider.end <= Array.from(cutEnd).length - 1) return [{ label: current }];
    return [{ label: wider.label, narrow: narrow.end > wider.end ? narrow.label : undefined }, { label: current }];
  };
  const clashes = () => {
    const byLabel = new Map<string, string[]>();
    for (const name of distinct) {
      const label = labels.get(name)!;
      byLabel.set(label, [...(byLabel.get(label) ?? []), name]);
    }
    return [...byLabel.values()].filter((group) => group.length > 1);
  };
  /**
   * 다음 차례에 다시 가를 작은 묶음(글은 서로 달라도 글만으로 서로 갈리지 않는 이름들 — 아래 group.forEach 뒤)과, 이미 다시 가른 작은 묶음(한 번만).
   * 같은 차례에 겹친 글 묶음에 든 이름이 있으면 그 묶음에 맡김.
   */
  let regroup: string[][] = [];
  const regrouped = new Set<string>();
  for (let round = 0; round < 8; round += 1) {
    recheck();
    const same = clashes();
    const inSame = new Set(same.flat());
    const groups = [...same, ...regroup.filter((group) => group.every((name) => !inSame.has(name)))];
    regroup = [];
    if (groups.length === 0) break;
    for (const group of groups) {
      const charsOf = group.map((name) => Array.from(name));
      const shortest = Math.min(...charsOf.map((chars) => chars.length));
      let split = 0;
      while (split < shortest && charsOf.every((chars) => chars[split] === charsOf[0][split])) split += 1;
      // 갈리는 자리에서 낱말·숫자가 이어지는 이름(하나라도 있으면 낱말 가운데에서 갈림 — 모두 거기서 끝나거나 빈칸·부호면 낱말 경계).
      const continues = charsOf.map((chars) => LETTER_OR_DIGIT.test(chars[split] ?? ""));
      const inWord = continues.some(Boolean);
      // 차례마다 먼저 갈리는 자리가 든 낱말·숫자의 첫 글자부터('…12'가 '…2'로 읽히지 않게 — 둘째 차례 이후도, QA-423 후속). 낱말 경계에서 갈리면
      // 거기서 끝나는 이름만 물림('…Ltd'처럼 끝 낱말을 보임) — 앞 낱말은 모든 이름에서 같아, 이어지는 이름까지 물리면 가르는 다음 낱말이 글에서
      // 밀려남('…주식회사' 뒤 ' 베트남' — QA 재확인 개선 제안).
      let wordBack = split;
      while (wordBack > 0 && split - wordBack < GRAPH_WORD_BACK && LETTER_OR_DIGIT.test(charsOf[0][wordBack - 1])) wordBack -= 1;
      if (wordBack > 0 && LETTER_OR_DIGIT.test(charsOf[0][wordBack - 1])) wordBack = split; // 낱말이 길면 물리지 않음
      // 갈리는 자리가 숫자 가운데(바로 앞 글자가 숫자)면 그 숫자의 첫 자리 — 낱말에 붙은 번호('Fund2020'·'제12호'·'스팩12호')는 낱말 물림이 긴
      // 낱말에서 멈추거나 이름 첫머리까지 가 쓸 수 없어, 이 자리로 물림('…2020'이 '…0'으로, '…12호'가 '…2호'로 읽히지 않게 — 2차 검토 지적).
      let digitBack = split;
      while (digitBack > 0 && DIGIT.test(charsOf[0][digitBack - 1])) digitBack -= 1;
      if (digitBack === 0) digitBack = split;
      if (inWord && digitBack < split && (wordBack === split || wordBack === 0)) wordBack = digitBack;
      const back = inWord || !refine ? wordBack : split;
      const starts = charsOf.map((chars) => (!inWord && split >= chars.length ? wordBack : back));
      // narrowHead면 앞부분을 첫 글자 하나로 줄여 뒷부분에 폭을 더 줌.
      const shown = (from: readonly number[], skipSpace: boolean, narrowHead = false) =>
        charsOf.map((chars, at) => {
          let start = from[at];
          // '…' 뒤에 빈칸을 두지 않음(이름마다 — 갈리는 글자가 빈칸인 이름).
          while (skipSpace && start < chars.length && /\s/.test(chars[start])) start += 1;
          return fitLabelFrom(chars, start, maxPx, narrowHead ? charWidth(chars[0]) : maxPx * GRAPH_HEAD_SHARE);
        });
      // 이름마다 글에 보여야 할 끝 — 갈리는 글자가 숫자면 그 자리부터 이어지는 숫자의 끝까지('…1000'이 '…100…'으로, '…2021'이 '…202…'로
      // 잘리지 않게), 글자면 그 글자까지, 아니면(빈칸·부호, 이름이 거기서 끝남) 갈리는 자리 앞까지. 낱말 경계에서 갈리면 그 뒤 첫 낱말의 첫 글자
      // (숫자면 그 숫자의 끝)까지.
      const needEnd = charsOf.map((chars) => {
        let end = split;
        if (refine && !inWord) while (end < chars.length && !LETTER_OR_DIGIT.test(chars[end])) end += 1;
        if (DIGIT.test(chars[end] ?? "")) while (end < chars.length && DIGIT.test(chars[end])) end += 1;
        else if (LETTER_OR_DIGIT.test(chars[end] ?? "")) end += 1;
        else end = split;
        return end;
      });
      // 앞부분 몫 때문에 거기까지 보이지 않는 이름(좁은 그림의 네 자리 번호 등)은 앞부분을 첫 글자 하나로 줄인 글로 — 그렇게 해서 이 묶음의 이름이
      // 모두 거기까지 보일 때만. 그리고 줄인 글이 갈리는 글자가 다른 이름과 같은 뒷부분을 보이면(뒷부분 끝의 '…'만 다른 '가…주식회사'·
      // '가…주식회사…' 등) 줄이지 않음 — 갈리는 글자가 같은 이름끼리는 같아도 다음 차례에 다시 가름.
      const fitFrom = (from: readonly number[]) => {
        const wide = shown(from, true);
        if (wide.every((fit, at) => fit.end >= needEnd[at])) return wide;
        const narrow = shown(from, true, true);
        const mixed = wide.map((fit, at) => (fit.end < needEnd[at] ? narrow[at] : fit));
        const tails = mixed.map((fit, at) => charsOf[at].slice(from[at], fit.end).join("").trim());
        const blurred = mixed.some(
          (fit, at) =>
            fit !== wide[at] &&
            tails.some((tail, other) => other !== at && tail === tails[at] && charsOf[other][split] !== charsOf[at][split]),
        );
        return !blurred && mixed.every((fit, at) => fit.end >= needEnd[at]) ? mixed : wide;
      };
      const alike = (list: readonly { label: string }[]) => new Set(list.map((fit) => fit.label)).size === 1;
      let fits = fitFrom(starts);
      // 그 글로 이 이름들이 하나도 갈리지 않으면(모두 같은 글 — 물린 몫 때문에 갈리는 글자가 글에 들지 않음 등) 갈리는 자리가 든 숫자의 첫 자리부터
      // (낱말 첫 글자 '제'부터는 좁은 그림에서 '가…제12…'처럼 번호가 다 들지 않음 — 2차 검토 지적), 그래도 같으면 갈리는 바로 그 글자부터(빈칸도
      // 그대로). 일부만 갈리면 물린 글을 두고, 같은 글이 남은 이름들은 다음 차례에 그 이름들끼리 다시 가름(차례 수에 상한이 있어 늘 끝남).
      if (alike(fits) && inWord && digitBack > back && digitBack < split) fits = fitFrom(starts.map(() => digitBack));
      if (alike(fits)) fits = shown(starts.map(() => split), false);
      // 갈리는 자리 뒤에 보일 가르는 낱말이 없는 이름(거기서 끝나거나, 이어지는 다른 이름과 달리 거기서 낱말이 끝나는데 그 낱말이 길어 통째로
      // 못 보임 — '…디스플레이 주식회사'와 '… 베트남', '가상전자글로벌반도체 주식회사'와 '…반도체파운드리…')은 하나만(끝나는 이름 먼저), 새 글 대신
      // 묶음 밖 이름들과 가르는 글(keeperLabels)을 둘 수 있음 — 다음 차례에 다시 줄이면서 앞 차례의 가르는 낱말('…디스…'·'…글로…')이 빠지고
      // '가…주식…'처럼 여러 이름과 맞는 글이 되지 않게(QA 재확인 개선 제안). 그 글로 읽힐 수 있는 이름(labelFitsName)이 새 글보다 많지 않을 때만
      // ('…Ltd'처럼 끝 낱말로 하나만 가리키는 새 글은 그대로), 아무도 쓰지 않은 글일 때만, 다른 이름들의 새 글이 그 이름으로는 읽히지 않을 때만
      // (둔 글은 묶음 모두로 읽혀 다른 이름들의 글로 가려지므로). 다른 이름들의 새 글이 묶음 밖 이름이 쓰는 글과 같으면 두지 않음 — 다음 차례에 그
      // 이름을 다시 가르면 둔 글로 돌아와, 두 묶음이 차례마다 같은 글을 주고받다 상한에 닿음(검토 지적). 기본 글(refine 거짓)에는 두지 않음.
      const keeper = !refine
        ? undefined
        : group
            .map((_, at) => at)
            .filter((at) => back === split && !continues[at] && (inWord || split >= charsOf[at].length) && !noKeep.has(group[at]))
            .sort((a, b) => Number(split < charsOf[a].length) - Number(split < charsOf[b].length) || a - b)[0];
      if (keeper !== undefined && fits.every((fit, at) => at === keeper || !labelFitsName(fit.label, group[keeper]))) {
        const taken = new Set(distinct.filter((name) => !group.includes(name)).map((name) => labels.get(name)!));
        if (fits.every((fit, at) => at === keeper || !taken.has(fit.label))) {
          fits.forEach((fit, at) => {
            if (at !== keeper) taken.add(fit.label);
          });
          const reach = (label: string) => distinct.filter((name) => labelFitsName(label, name)).length;
          const fresh = reach(fits[keeper].label);
          const fitsKeeper = (label: string) => !taken.has(label) && reach(label) <= fresh;
          const choice = keeperLabels(group[keeper], charsOf[keeper], group).find((candidate) => fitsKeeper(candidate.label));
          const kept = choice?.narrow !== undefined && fitsKeeper(choice.narrow) ? choice.narrow : choice?.label;
          if (kept !== undefined && kept !== fits[keeper].label) {
            keepers.set(group[keeper], { label: kept, fresh: fits[keeper].label, members: group });
            fits = fits.map((fit, at) => (at === keeper ? { label: kept, end: fit.end } : fit));
          }
        }
      }
      group.forEach((name, at) => labels.set(name, fits[at].label));
      // 낱말 가운데에서 갈린 묶음에서 갈리는 자리의 글자가 같은 이름들(둘 다 거기서 빈칸 — '…디스플레이 주식회사'와 '…디스플레이 주식회사 베트남'이
      // '…디스플레이로지텍'과 갈리는 자리)은 그 자리부터의 글로는 서로 갈리지 않고, 끝까지 드는지에 따라서만 글이 달라짐('가상전…주식회사'·
      // '가상…주식회사…' — 뒤의 글이 앞 이름으로도 읽힘). 낱말 경계의 물림도 받지 못했으므로, 그 이름들의 글이 서로 다르고 한 글이 다른 이름으로도
      // 읽히면 다음 차례에 그 이름들끼리 다시 가름('가상전자…베트남' — 검토 지적). 낱말 경계에서 갈린 묶음은 이미 그 물림을 받아 그대로. 지킬 글을 둔
      // 이름이 든 작은 묶음도 그대로 — 다시 가르면 그 이름들끼리만 보고 새로 줄여, 묶음 밖 이름들과 가르려고 둔 글('가…글로…')이 묶음 밖 이름으로도
      // 읽히는 글('가…베트남')로 바뀜(2차 검토 지적).
      if (refine && inWord) {
        const byChar = new Map<string, number[]>();
        charsOf.forEach((chars, at) => byChar.set(chars[split] ?? "", [...(byChar.get(chars[split] ?? "") ?? []), at]));
        for (const ats of byChar.values()) {
          const sub = ats.map((at) => group[at]);
          const key = sub.join("\n");
          if (ats.length < 2 || regrouped.has(key) || new Set(ats.map((at) => fits[at].label)).size < ats.length) continue;
          if (ats.some((at) => keepers.get(group[at])?.label === fits[at].label)) continue;
          if (!ats.some((at) => ats.some((other) => other !== at && labelFitsName(fits[at].label, group[other])))) continue;
          regroup.push(sub);
          regrouped.add(key);
        }
      }
    }
  }
  recheck();
  for (const group of clashes()) {
    for (const name of group.slice(1)) {
      const used = new Set(labels.values());
      const length = Array.from(name).length;
      for (let from = 1; from <= length; from += 1) {
        const label = fitGraphLabelFrom(name, from, maxPx);
        if (!used.has(label)) {
          labels.set(name, label);
          break;
        }
      }
    }
  }
  return labels;
}

/**
 * 그림의 크기 — 잰 폭(280~760, 재지 못했으면 360)에 맞추고 높이는 폭의 3/4(340~480). 좁은 화면은 세로로 긴 타원이 됩니다. 노드가 많아 같은 쪽
 * 이웃이 붙으면 linkGraphLayout이 이보다 높입니다(QA-424).
 */
export function linkGraphSize(measuredWidth: number): { width: number; height: number } {
  const width = measuredWidth > 0 ? Math.round(Math.min(760, Math.max(280, measuredWidth))) : 360;
  return { width, height: Math.min(480, Math.max(340, Math.round(width * 0.75))) };
}

/** 노드 포커스 고리의 바깥 반지름(px — 그린 원 r 11 + 테두리 2의 절반)과, 포커스 간 노드를 칸 안에 들일 때 칸 가장자리에 남기는 여유(px). */
const GRAPH_FOCUS_RING = 12;
const GRAPH_SCROLL_PAD = 4;

/**
 * 칸이 그림보다 좁아 그림을 가로로 넘길 때(QA-424) 키보드 포커스가 간 노드의 포커스 고리와 이름이 칸 안에 다 보이게 하는 칸의 scrollLeft — 이미 다
 * 보이면 null. 노드의 가로 범위는 그림 좌표(포커스 고리 x ± 12, 이름은 labelX에서 정렬 쪽으로 labelWidth — 재지 못했으면 어림 폭)이고, scale(그린 폭 ÷
 * 그림 폭 — 넘길 때는 1)로 칸 좌표로 바꿔 칸 가장자리에서 4px 안쪽에 들게 가장 적게 넘깁니다. 범위가 칸보다 넓으면 노드 원 쪽(이름이 시작하는 쪽)을
 * 맞추고, 결과는 0 ~ (그림 폭 × scale − 칸 폭)으로 자릅니다.
 */
export function graphFocusScrollLeft(
  node: Pick<LinkGraphNode, "x" | "labelX" | "anchor" | "label">,
  box: { scrollLeft: number; clientWidth: number },
  graph: { width: number; scale?: number; labelWidth?: number },
): number | null {
  const scale = graph.scale && graph.scale > 0 ? graph.scale : 1;
  const labelWidth = graph.labelWidth ?? textWidth(node.label);
  const start = node.anchor === "start";
  const left = (start ? node.x - GRAPH_FOCUS_RING : Math.min(node.x - GRAPH_FOCUS_RING, node.labelX - labelWidth)) * scale - GRAPH_SCROLL_PAD;
  const right = (start ? Math.max(node.x + GRAPH_FOCUS_RING, node.labelX + labelWidth) : node.x + GRAPH_FOCUS_RING) * scale + GRAPH_SCROLL_PAD;
  const { scrollLeft, clientWidth } = box;
  if (left >= scrollLeft && right <= scrollLeft + clientWidth) return null;
  const target = right - left > clientWidth ? (start ? left : right - clientWidth) : left < scrollLeft ? left : right - clientWidth;
  const next = Math.min(Math.max(0, graph.width * scale - clientWidth), Math.max(0, target));
  return Math.abs(next - scrollLeft) < 0.5 ? null : next;
}

/**
 * 그림에 그릴 연결 — 관계 묶음마다 돌아가며 하나씩 골라(한 관계 — 내부자 명단 등 — 가 자리를 다 차지하지 않게) 최대 max개. 묶음 순서와 묶음 안의
 * 순서는 그대로이고, hidden은 그리지 않은 연결 수(목록에는 모두 있음).
 */
export function graphLinks(groups: readonly LinkGroup[], max: number = LINK_GRAPH_MAX): { groups: LinkGroup[]; hidden: number } {
  const taken = groups.map(() => 0);
  const total = groups.reduce((sum, group) => sum + group.links.length, 0);
  let left = Math.min(max, total);
  while (left > 0) {
    groups.forEach((group, at) => {
      if (left > 0 && taken[at] < group.links.length) {
        taken[at] += 1;
        left -= 1;
      }
    });
  }
  const kept = groups.map((group, at) => ({ ...group, links: group.links.slice(0, taken[at]) })).filter((group) => group.links.length > 0);
  return { groups: kept, hidden: total - kept.reduce((sum, group) => sum + group.links.length, 0) };
}

export type LinkGraphNode = {
  /** 그림 안에서 노드를 가리는 값(관계 + 차례). */
  id: string;
  link: SearchLink;
  relation: string;
  /** 노드 자리(그림 좌표 — 왼쪽 위가 0,0)와 각도(라디안 — 오른쪽 위에서 시계 방향으로 늘어남). */
  x: number;
  y: number;
  angle: number;
  /** 보이는 이름(폭에 맞춰 줄임)과 그 자리·정렬 — 오른쪽 노드는 오른쪽으로, 왼쪽 노드는 왼쪽으로 뻗습니다. */
  label: string;
  labelX: number;
  labelY: number;
  anchor: "start" | "end";
  /** 낭독 이름 — '이름 · 관계'(키가 없으면 '· 이름으로 찾기'). */
  ariaLabel: string;
};

/** 관계 묶음 하나의 부채꼴(라디안 start~end — 좌우 호로 쪼개졌으면 두 조각을 덮는 범위). */
export type LinkGraphSector = { relation: string; label: string; count: number; start: number; end: number };

/**
 * 관계 글 하나 — 관계 묶음의 이어진 호마다 하나(묶음이 좌우 호로 쪼개지면 둘). x·y는 글 상자의 가운데, width는 글 폭(px), side는 그 조각의
 * 노드가 놓인 쪽.
 */
export type LinkGraphTag = { relation: string; label: string; side: "right" | "left"; x: number; y: number; width: number };

export type LinkGraphLayout = {
  width: number;
  /** 배치의 높이 — 받은 크기의 높이, 같은 쪽 이웃 노드가 GRAPH_ROW_GAP보다 붙거나 관계 글이 들 빈자리가 없으면 그만큼 더 큼(QA-424). */
  height: number;
  cx: number;
  cy: number;
  /** 노드가 놓이는 타원의 가로·세로 반지름. */
  rx: number;
  ry: number;
  nodes: LinkGraphNode[];
  sectors: LinkGraphSector[];
  /** 관계 글(이어진 호마다 하나). */
  tags: LinkGraphTag[];
  /** 가운데 대상 상자의 글(폭에 맞춰 줄임)과 폭·높이(px). */
  center: { label: string; width: number; height: number };
  /** 상한을 넘어 그리지 않은 연결 수. */
  hidden: number;
  /** 실제로 그린 세로 범위(뷰박스의 y·높이) — 노드가 적으면 빈 위아래를 잘라 그림이 낮아집니다. */
  view: { y: number; height: number };
  /**
   * 노드의 누르는 자리 반지름 — 어느 두 노드 사이든 가장 짧은 거리의 절반 이하(누르는 원끼리 겹치지 않음), 많아야 22(지름 44px). 노드가 많은
   * 좁은 화면에서는 44px보다 작아지고, 같은 일은 '목록' 보기(줄 높이 44px)가 합니다.
   */
  hitRadius: number;
};

const round1 = (value: number) => Math.round(value * 10) / 10;

/** 한 줄로 늘어선 칸(노드 1 · 틈 GRAPH_GAP_UNITS) — 그림의 오른쪽·왼쪽 호를 채우는 차례. 틈의 sector는 그 틈 뒤의 묶음. */
type GraphSlot = { kind: "node"; sector: number; link: SearchLink } | { kind: "gap"; sector: number };

/** 그림 위의 상자(px — 왼쪽·오른쪽·위·아래). */
type GraphBox = { left: number; right: number; top: number; bottom: number };

/** 두 상자 사이가 gap(px)보다 좁은가 — gap이 0이면 맞닿기만 한 것은 겹침이 아님(0.1px 반올림 뒤의 부동소수 오차는 무시). */
const boxesClash = (a: GraphBox, b: GraphBox, gap = 0) =>
  Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1e-6 - gap && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1e-6 - gap;

let graphTagOffsets: readonly (readonly [number, number])[] | null = null;

/**
 * 겹친 관계 글을 옮겨 볼 자리(처음 자리에서 옮기는 x·y) — 2px 격자, 반지름 GRAPH_TAG_SEARCH 안, 가까운 차례. 거리가 같으면 세로로 옮기는 것부터,
 * 그다음 양수 쪽(placeGraphTags가 세로는 바깥쪽·가로는 안쪽으로 뒤집어 씀). 처음 쓸 때 한 번 만듭니다.
 */
function tagOffsets(): readonly (readonly [number, number])[] {
  if (graphTagOffsets) return graphTagOffsets;
  const out: [number, number][] = [];
  for (let dx = -GRAPH_TAG_SEARCH; dx <= GRAPH_TAG_SEARCH; dx += 2) {
    for (let dy = -GRAPH_TAG_SEARCH; dy <= GRAPH_TAG_SEARCH; dy += 2) if (dx * dx + dy * dy <= GRAPH_TAG_SEARCH ** 2) out.push([dx, dy]);
  }
  out.sort((a, b) => a[0] ** 2 + a[1] ** 2 - (b[0] ** 2 + b[1] ** 2) || Math.abs(a[0]) - Math.abs(b[0]) || b[1] - a[1] || b[0] - a[0]);
  graphTagOffsets = out;
  return out;
}

/** 자리를 정할 관계 글 — 지금 자리(x·y), 처음 자리(선 위 — 옮길 때 가까움을 재는 곳), 상자의 반폭(글 폭/2 + 4), 쪽(0 오른쪽·1 왼쪽). */
type GraphTagSpot = { side: number; x: number; y: number; half: number; originX: number; originY: number };

/** 관계 글이 비킬 것 — 상자와, 관계 글을 옮길 때 그 상자와 남기는 틈(px). */
type GraphObstacle = { box: GraphBox; room: number };

/**
 * 관계 글의 마지막 자리(QA-424) — 차례대로 지금 자리가 가운데 상자·노드 원·노드 이름(fixed)과 앞서 자리 잡은 관계 글에 겹치지 않으면(맞닿기만 한
 * 것은 그대로) 두고, 겹치는 글은 처음 자리에서 가장 가까운 빈 자리로 옮깁니다 — 비킬 것마다 정한 틈(room)과 다른 관계 글과의 틈 GRAPH_TAG_GAP을
 * 남기고, 그림 폭·높이 안, 글의 가운데는 노드가 놓인 타원 안(노드 바깥으로 나가 다른 노드의 이름 곁에 붙지 않게). 2px 격자를 가까운 차례로 보며,
 * 빈 자리가 없으면 지금 자리 그대로. 자리는 0.1px로 반올림한 값으로 재고 그 값을 씁니다.
 */
function placeGraphTags(
  tags: GraphTagSpot[],
  fixed: readonly GraphObstacle[],
  geo: { width: number; height: number; cx: number; cy: number; rx: number; ry: number },
): boolean {
  const boxOf = (x: number, y: number, half: number): GraphBox => ({ left: x - half, right: x + half, top: y - GRAPH_TAG_HEIGHT / 2, bottom: y + GRAPH_TAG_HEIGHT / 2 });
  const accepted: GraphBox[] = [];
  const clear = (box: GraphBox, roomy: boolean) =>
    !fixed.some((other) => boxesClash(box, other.box, roomy ? other.room : 0)) && !accepted.some((other) => boxesClash(box, other, roomy ? GRAPH_TAG_GAP : 0));
  const moving: GraphTagSpot[] = [];
  let settled = true;
  for (const tag of tags) {
    tag.x = round1(Math.min(geo.width - tag.half - 2, Math.max(tag.half + 2, tag.x)));
    tag.y = round1(tag.y);
    const box = boxOf(tag.x, tag.y, tag.half);
    if (clear(box, false)) accepted.push(box);
    else moving.push(tag);
  }
  for (const tag of moving) {
    const outward = tag.originY < geo.cy ? -1 : 1;
    const inward = tag.side === 0 ? -1 : 1;
    let found: { x: number; y: number; box: GraphBox } | null = null;
    for (const [dx, dy] of tagOffsets()) {
      const x = round1(tag.originX + inward * dx);
      const y = round1(tag.originY + outward * dy);
      if (x < tag.half + 2 || x > geo.width - tag.half - 2 || y < GRAPH_TAG_HEIGHT || y > geo.height - GRAPH_TAG_HEIGHT) continue;
      if (((x - geo.cx) / geo.rx) ** 2 + ((y - geo.cy) / geo.ry) ** 2 > 1) continue;
      const box = boxOf(x, y, tag.half);
      if (clear(box, true)) {
        found = { x, y, box };
        break;
      }
    }
    if (found) {
      tag.x = found.x;
      tag.y = found.y;
    } else settled = false;
    accepted.push(found?.box ?? boxOf(tag.x, tag.y, tag.half));
  }
  return settled;
}

/**
 * 연결 그림의 배치(계약 §9-3) — 대상을 가운데 두고, 노드는 둘레의 오른쪽 호(위 → 아래)와 왼쪽 호(아래 → 위)에 시계 방향으로 linkGroups의 순서대로
 * 놓습니다(관계 묶음마다 이어진 부채꼴, 묶음 사이에 작은 틈). 좌우는 관계 묶음 단위로 나누되(두 쪽 중 큰 쪽이 가장 작은 묶음 경계), 그러면 한쪽
 * 호에 노드가 너무 많아 이웃 이름이 붙을 때(세로 간격 GRAPH_ROW_GAP 미만)와 관계가 하나뿐일 때만 칸 수로 반씩 나눕니다 — 그때 쪼개진 묶음은
 * 호마다 관계 글을 둡니다(다른 관계의 글 옆에 관계 글 없는 노드가 남지 않게). 각 쪽은 한가운데에 모으며, 노드가 많으면 호(위아래 65도) 안에서
 * 간격을 줄입니다. 그렇게 나눈 뒤에도 같은 쪽 이웃 노드의 세로 간격이 GRAPH_ROW_GAP에 못 미치면 세로 반지름을 늘려 그림을 높입니다(QA-424 — 글자는
 * 12px 그대로). 노드는 최대 max개(graphLinks). 노드 이름은 오른쪽 노드는 오른쪽으로, 왼쪽 노드는 왼쪽으로 뻗고 이름 자리(폭의 26%,
 * 80~130px) 안에 들게 줄입니다(graphLabels — 같은 글이 되는 이름은 가운데를 줄임). 그린 것의 세로 범위(view)를 돌려줘 노드가 적은 그림은 낮게
 * 그립니다. 관계 글은 그 조각의 가운데 노드로 가는 선 위(반지름 55~70%)에 두되 가운데 대상 상자와 겹치면 선 옆(위·아래)으로 비키고,
 * 같은 쪽 관계 글끼리는 세로로 비켜 둡니다. 그래도 가운데 상자·노드 원·노드 이름·다른 관계 글과 겹치는 글은 처음 자리에서 가장 가까운 빈 자리로
 * 옮기고(placeGraphTags), 빈 자리가 없으면 세로 반지름을 늘려 다시 놓습니다. 출처에 없는 관계는 만들지 않습니다(받은 연결만).
 */
export function linkGraphLayout(
  groups: readonly LinkGroup[],
  size: { width: number; height: number },
  options: { max?: number; centerName?: string } = {},
): LinkGraphLayout {
  const { groups: kept, hidden } = graphLinks(groups, options.max ?? LINK_GRAPH_MAX);
  const { width } = size;
  const cx = width / 2;
  const labelSpace = Math.min(130, Math.max(80, Math.round(width * 0.26)));
  const rx = Math.max(40, cx - labelSpace);
  // 맨 위·맨 아래 노드(호의 끝 65도)가 여백 안에 들게 — 극(90도)에는 노드를 두지 않아 타원이 그림보다 커도 됩니다. 노드가 많아 같은 쪽 이웃이
  // 붙으면 아래에서 세로 반지름을 늘리고 그림을 높입니다(QA-424).
  const baseRy = Math.max(40, (size.height / 2 - GRAPH_MARGIN_Y) / Math.sin(GRAPH_ARC));
  const centerLabel = fitGraphLabel(options.centerName ?? "", Math.min(160, rx * 1.2));
  const center = { label: centerLabel, width: Math.round(Math.min(176, Math.max(64, textWidth(centerLabel) + 20))), height: GRAPH_CENTER_HEIGHT };

  // 칸을 한 줄로 — 묶음 사이에만 틈.
  const slots: GraphSlot[] = [];
  kept.forEach((group, sector) => {
    if (sector > 0) slots.push({ kind: "gap", sector });
    for (const link of group.links) slots.push({ kind: "node", sector, link });
  });
  const unitOf = (slot: GraphSlot) => (slot.kind === "node" ? 1 : GRAPH_GAP_UNITS);
  const stepFor = (units: number) => Math.min(GRAPH_MAX_STEP, (2 * GRAPH_ARC) / Math.max(1, units));
  // 한쪽 호에 units 칸을 둘 때 같은 쪽 이웃 노드의 가장 좁은 세로 간격 — 호의 양 끝(사인이 가장 완만한 곳)의 두 칸 사이.
  const rowGap = (units: number) => {
    if (units < 2) return Infinity;
    const end = (units / 2 - 0.5) * stepFor(units);
    return baseRy * (Math.sin(end) - Math.sin(end - stepFor(units)));
  };
  // 묶음 경계에서 나누기 — 두 쪽 가운데 큰 쪽이 가장 작은 경계(k = 오른쪽에 두는 마지막 묶음).
  let boundary = -1;
  let boundaryUnits = Infinity;
  for (let k = 0; k < kept.length - 1; k += 1) {
    let right = 0;
    let left = 0;
    kept.forEach((group, sector) => {
      if (sector <= k) right += group.links.length + (sector > 0 ? GRAPH_GAP_UNITS : 0);
      else left += group.links.length + (sector > k + 1 ? GRAPH_GAP_UNITS : 0);
    });
    if (Math.max(right, left) < boundaryUnits) {
      boundaryUnits = Math.max(right, left);
      boundary = k;
    }
  }
  const sides: GraphSlot[][] = [[], []];
  if (boundary >= 0 && rowGap(boundaryUnits) >= GRAPH_ROW_GAP) {
    for (const slot of slots) sides[slot.sector <= boundary ? 0 : 1].push(slot);
  } else {
    // 칸 수로 반씩 — 칸의 가운데가 전체의 절반 앞이면 오른쪽, 아니면 왼쪽(나뉘는 자리의 틈은 버림).
    const totalUnits = slots.reduce((sum, slot) => sum + unitOf(slot), 0);
    let walked = 0;
    for (const slot of slots) {
      const middle = walked + unitOf(slot) / 2;
      walked += unitOf(slot);
      sides[middle <= totalUnits / 2 ? 0 : 1].push(slot);
    }
  }
  for (const side of sides) {
    while (side[0]?.kind === "gap") side.shift();
    while (side.at(-1)?.kind === "gap") side.pop();
  }
  const sideUnits = sides.map((side) => side.reduce((sum, slot) => sum + unitOf(slot), 0));
  const step = stepFor(Math.max(...sideUnits));
  // 노드 글 — 앞머리가 같아 같은 글이 되는 서로 다른 이름은 가운데를 줄여 가름(QA-423).
  const labels = graphLabels(kept.flatMap((group) => group.links.map((entry) => entry.name)), labelSpace - 14);

  // 노드 각도 — 오른쪽은 0, 왼쪽은 π를 한가운데로, 각 쪽에서 각도가 늘어나는 쪽(오른쪽은 아래, 왼쪽은 위)으로 차례로.
  const placed: { slot: Extract<GraphSlot, { kind: "node" }>; side: number; angle: number }[] = [];
  sides.forEach((side, at) => {
    let offset = (at === 0 ? 0 : Math.PI) - (sideUnits[at] * step) / 2;
    for (const slot of side) {
      if (slot.kind === "node") placed.push({ slot, side: at, angle: offset + step / 2 });
      offset += unitOf(slot) * step;
    }
  });
  // 같은 쪽 이웃 노드의 세로 간격(호의 끝에서 가장 좁음 — 칸 수로 나눈 뒤 관계 묶음 사이의 틈까지 실제 각도로 잼)이 GRAPH_ROW_GAP에 못 미치면
  // 세로 반지름을 늘리고 그만큼 그림을 높입니다(QA-424 — 글자 12px은 줄이지 않음, 좁은 화면의 그림이 길어짐). 이미 GRAPH_ROW_GAP 이상이면 그대로이고,
  // 늘릴 때만 0.1을 더해 자리를 0.1px로 반올림한 뒤에도 간격이 GRAPH_ROW_GAP 밑으로 내려가지 않게.
  let narrowest = Infinity;
  for (let at = 1; at < placed.length; at += 1) {
    if (placed[at].side === placed[at - 1].side) narrowest = Math.min(narrowest, Math.abs(Math.sin(placed[at].angle) - Math.sin(placed[at - 1].angle)));
  }
  const rowRy = baseRy * narrowest < GRAPH_ROW_GAP ? (GRAPH_ROW_GAP + 0.1) / narrowest : baseRy;
  const reach = Math.max(0, ...placed.map(({ angle }) => Math.abs(Math.sin(angle))));
  const halfStep = step / 2;

  /** 세로 반지름 ry로 노드·관계 글을 놓음 — settled는 관계 글이 모두 겹치지 않는 자리를 찾았는가. */
  const arrange = (ry: number) => {
    const height = ry > baseRy ? Math.max(size.height, Math.ceil(2 * (ry * reach + GRAPH_MARGIN_Y))) : size.height;
    const cy = height / 2;

    const nodes: LinkGraphNode[] = [];
    const nodeSector: number[] = [];
    const nodeSide: number[] = [];
    for (const { slot, side, angle } of placed) {
      const cos = Math.cos(angle);
      const x = round1(cx + rx * cos);
      const y = round1(cy + ry * Math.sin(angle));
      const anchor: LinkGraphNode["anchor"] = cos >= 0 ? "start" : "end";
      const relation = kept[slot.sector].relation;
      nodes.push({
        id: `${relation}:${nodes.filter((node) => node.relation === relation).length}`,
        link: slot.link,
        relation,
        x,
        y,
        angle,
        label: labels.get(slot.link.name.trim()) ?? fitGraphLabel(slot.link.name, labelSpace - 14),
        labelX: round1(anchor === "start" ? x + 10 : x - 10),
        labelY: round1(y + 4),
        anchor,
        ariaLabel: `${slot.link.name} · ${relationLabel(relation)}${isEntityKey(slot.link.key) ? "" : " · 이름으로 찾기"}`,
      });
      nodeSector.push(slot.sector);
      nodeSide.push(side);
    }

    // 관계 글 — 이어진 호(묶음 × 쪽)마다 하나, 그 조각의 가운데 노드로 가는 선 위. 가운데 상자와 겹치면 선 옆으로, 같은 쪽끼리는 세로로 비킴.
    const pieces: { sector: number; side: number }[] = [];
    nodes.forEach((_, at) => {
      if (!pieces.some((piece) => piece.sector === nodeSector[at] && piece.side === nodeSide[at])) pieces.push({ sector: nodeSector[at], side: nodeSide[at] });
    });
    const tags = pieces.map(({ sector, side }) => {
      const members = nodes.filter((_, at) => nodeSector[at] === sector && nodeSide[at] === side);
      const pivot = members[Math.floor((members.length - 1) / 2)];
      const labelWidth = Math.ceil(textWidth(kept[sector].label));
      const half = labelWidth / 2 + 4;
      const cos = Math.cos(pivot.angle);
      const sin = Math.sin(pivot.angle);
      const clearY = center.height / 2 + GRAPH_TAG_HEIGHT / 2 + 4;
      let onLine = false;
      let x = cx;
      let y = cy;
      for (let t = 0.55; t <= 0.7 + 1e-9 && !onLine; t += 0.05) {
        x = cx + rx * t * cos;
        y = cy + ry * t * sin;
        onLine = Math.abs(x - cx) >= center.width / 2 + half + 4 || Math.abs(y - cy) >= clearY;
      }
      if (!onLine) {
        // 선이 거의 가로라 바깥으로 밀면 노드에 닿음 — 선 옆(위·아래)으로 올려 가운데 상자를 비킴.
        x = cx + rx * 0.6 * cos;
        y = cy + (sin > 0 ? 1 : -1) * Math.max(clearY, Math.abs(ry * 0.6 * sin));
      }
      return { sector, side, x, y, half, labelWidth, originX: x, originY: y };
    });
    for (const side of [0, 1]) {
      const column = tags.filter((tag) => tag.side === side).sort((a, b) => a.y - b.y);
      for (let at = 1; at < column.length; at += 1) column[at].y = Math.max(column[at].y, column[at - 1].y + GRAPH_TAG_STEP);
      const overflow = (column.at(-1)?.y ?? 0) - (height - GRAPH_TAG_HEIGHT);
      if (overflow > 0) for (const tag of column) tag.y = Math.max(GRAPH_TAG_HEIGHT, tag.y - overflow);
    }
    // 그래도 관계 글이 가운데 상자·노드 원·노드 이름·다른 관계 글(다른 쪽 글 포함)과 겹치면(좁은 화면에서 관계가 여러 종일 때 — 같은 쪽 비킴이 가운데
    // 상자 쪽으로 밀거나 극 가까이에서 좌우 글이 모임) 그 글만 처음 자리(선 위)에서 가장 가까운 빈 자리로 옮깁니다(QA-424). 겹치지 않는 글은 그대로입니다.
    const fixed: GraphObstacle[] = [
      {
        box: { left: cx - center.width / 2, right: cx + center.width / 2, top: cy - center.height / 2, bottom: cy + center.height / 2 },
        room: GRAPH_TAG_GAP,
      },
      ...nodes.flatMap((node): GraphObstacle[] => {
        const labelWidth = textWidth(node.label);
        const labelLeft = node.anchor === "start" ? node.labelX : node.labelX - labelWidth;
        return [
          {
            box: { left: node.x - GRAPH_DOT_RADIUS, right: node.x + GRAPH_DOT_RADIUS, top: node.y - GRAPH_DOT_RADIUS, bottom: node.y + GRAPH_DOT_RADIUS },
            room: GRAPH_TAG_ROOM_NODE,
          },
          {
            box: { left: labelLeft, right: labelLeft + labelWidth, top: node.y - GRAPH_LABEL_HALF_HEIGHT, bottom: node.y + GRAPH_LABEL_HALF_HEIGHT },
            room: GRAPH_TAG_ROOM_NODE,
          },
        ];
      }),
    ];
    const settled = placeGraphTags(tags, fixed, { width, height, cx, cy, rx, ry });
    const graphTags: LinkGraphTag[] = tags.map((tag) => ({
      relation: kept[tag.sector].relation,
      label: kept[tag.sector].label,
      side: tag.side === 0 ? "right" : "left",
      x: tag.x,
      y: tag.y,
      width: tag.labelWidth,
    }));
    return { ry, height, cy, nodes, nodeSector, tags: graphTags, settled };
  };
  // 관계 글이 모두 들 빈자리가 없으면(좁은 화면에 관계가 아주 여러 종이고 글이 긴 때 — 노드 사이 안쪽은 가로 폭이 정해져 있음) 세로 반지름을
  // GRAPH_TAG_GROW씩 늘려 다시 놓습니다(안쪽의 줄 수가 늘어남 — 글자는 그대로, 그림이 길어짐). 많아야 GRAPH_TAG_GROW_TRIES번.
  let arranged = arrange(rowRy);
  for (let tries = 1; !arranged.settled && tries <= GRAPH_TAG_GROW_TRIES; tries += 1) arranged = arrange(rowRy * (1 + GRAPH_TAG_GROW * tries));
  const { ry, height, cy, nodes, nodeSector, tags: graphTags } = arranged;

  const sectors: LinkGraphSector[] = kept.map((group, sector) => {
    const angles = nodes.filter((_, at) => nodeSector[at] === sector).map((node) => node.angle);
    return { relation: group.relation, label: group.label, count: group.links.length, start: Math.min(...angles) - halfStep, end: Math.max(...angles) + halfStep };
  });

  // 누르는 원끼리 겹치지 않게 — 어느 두 노드 사이든 가장 짧은 거리의 절반 이하(내림), 많아야 22.
  let closest = Infinity;
  for (let a = 0; a < nodes.length; a += 1) {
    for (let b = a + 1; b < nodes.length; b += 1) closest = Math.min(closest, Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y));
  }
  const hitRadius = Math.floor(Math.min(22, closest / 2));
  const ys = [cy - center.height / 2, cy + center.height / 2, ...nodes.map((node) => node.y), ...graphTags.map((tag) => tag.y)];
  const top = Math.max(0, Math.floor(Math.min(...ys) - GRAPH_MARGIN_Y));
  const bottom = Math.min(height, Math.ceil(Math.max(...ys) + GRAPH_MARGIN_Y));
  return { width, height, cx, cy, rx, ry, nodes, sectors, tags: graphTags, center, hidden, view: { y: top, height: bottom - top }, hitRadius };
}

// ------------------------------------------------------------------ 출처 상태

/** 받는 중 상태 글(계약 §8-4의 서버 사유와 같은 말) — 다시 읽기를 멈춘 뒤에는 '받는 중'만. */
const PENDING_TEXT = "받는 중 — 몇 초 뒤 채움";
const PENDING_STALLED_TEXT = "받는 중";

const STATUS_TEXT: Record<string, { text: string; tone: "ok" | "warn" | "danger" | "neutral" }> = {
  ok: { text: "받음", tone: "ok" },
  cached: { text: "캐시", tone: "ok" },
  empty: { text: "결과 없음", tone: "neutral" },
  error: { text: "실패", tone: "danger" },
  skipped: { text: "건너뜀", tone: "neutral" },
  owner_only: { text: "운영자 전용", tone: "neutral" },
  offline: { text: "외부 조회 안 함(저장본만)", tone: "warn" },
  later: { text: "다음 단계", tone: "neutral" },
  pending: { text: PENDING_TEXT, tone: "neutral" },
  server_only: { text: "운영 서버에서만", tone: "neutral" },
};

/**
 * 상태 글과 같은 말이라 겹쳐 적지 않는 서버 사유 — 받는 중(계약 §8-4의 "받는 중 — 몇 초 뒤 채움"), 서버에서만("Finviz는 운영 서버에서만").
 * 그 밖의 사유(예산 소진·차단·형식 바뀜·한 사람 빈도 상한)는 서버가 준 말 그대로 둡니다.
 */
function redundantMessage(status: SearchSourceStatus): boolean {
  const message = status.message?.trim() ?? "";
  if (status.status === "pending") return message === PENDING_TEXT;
  if (status.status === "server_only") return message.endsWith("운영 서버에서만");
  return false;
}

/**
 * 거른 건수 한 줄 — 0이 아닌 것만. 모두 0이거나 모르면 null.
 * 같은 글이라 다른 줄과 합친 수(duplicate — QA-437)는 결과에 다른 줄로 남아 있으므로 '뺀 줄' 목록과 섞지 않고 앞에 따로 적습니다
 * (건수가 '0건'이어도 그 출처가 받은 것이 없다는 뜻이 아니게).
 */
export function droppedText(dropped: SearchSourceStatus["dropped"]): string | null {
  if (!dropped) return null;
  const parts = [
    dropped.old > 0 ? `2년 밖 ${dropped.old}건` : null,
    dropped.noTime > 0 ? `시각을 알 수 없음 ${dropped.noTime}건` : null,
    dropped.chinese > 0 ? `중국어 제목 ${dropped.chinese}건` : null,
    dropped.excluded > 0 ? `제외 매체 ${dropped.excluded}건` : null,
  ].filter((part): part is string => part !== null);
  const duplicate = typeof dropped.duplicate === "number" && dropped.duplicate > 0 ? `같은 글이라 다른 줄과 합침 ${dropped.duplicate}건` : null;
  const removed = parts.length > 0 ? `뺀 줄: ${parts.join(" · ")}` : null;
  const text = [duplicate, removed].filter((part): part is string => part !== null).join(" · ");
  return text || null;
}

export type SourceStatusView = {
  label: string;
  status: string;
  tone: "ok" | "warn" | "danger" | "neutral";
  count: string;
  dropped: string | null;
  message: string | null;
};

/**
 * 출처 상태 한 줄(계약 §5 — 이름 · 상태 글 · 건수 · 거른 건수). 색만으로 가르지 않게 상태는 글로 둡니다. 모르는 상태는 코드 그대로.
 * pendingStalled = 받는 중 다시 읽기를 멈춘 뒤(계약 §8-6) — 받는 중 글에서 '몇 초 뒤 채움'을 뗍니다.
 */
export function sourceStatusView(status: SearchSourceStatus, options: { pendingStalled?: boolean } = {}): SourceStatusView {
  const known = STATUS_TEXT[status.status];
  const text = status.status === "pending" && options.pendingStalled ? PENDING_STALLED_TEXT : known?.text;
  return {
    label: status.label || sourceLabel(status.source),
    status: text ?? status.status,
    tone: known?.tone ?? "neutral",
    count: typeof status.count === "number" ? `${status.count}건` : EMPTY,
    dropped: droppedText(status.dropped),
    message: status.message && !redundantMessage(status) ? status.message : null,
  };
}

// ------------------------------------------------------------------ 받는 중 다시 읽기(단계 5 — 계약 §8-6)

/** 받는 중(pending)인 결과를 다시 읽는 간격 — 5초. 앞 요청이 끝난 뒤부터 잽니다(겹치지 않음). */
export const FEED_PENDING_REFRESH_MS = 5000;
/** 다시 읽는 횟수 상한 — 12번(1분). 그 뒤에는 '받는 중' 그대로 두고 '다시 확인' 단추. */
export const FEED_PENDING_MAX_POLLS = 12;

/** none = 받는 중인 출처 없음, polling = 몇 초 뒤 다시 읽음, stalled = 상한만큼 다시 읽고 멈춤('다시 확인'). */
export type FeedPendingPhase = "none" | "polling" | "stalled";

/** @param polls 지금 보이는 응답(처음 읽기·새로 받기·'다시 확인') 뒤로 다시 읽은 횟수 */
export function feedPendingPhase(feed: Pick<SearchFeedResponse, "pending"> | null | undefined, polls: number): FeedPendingPhase {
  if (feed?.pending !== true) return "none";
  return polls < FEED_PENDING_MAX_POLLS ? "polling" : "stalled";
}

/** 받는 중 안내 한 줄(목록 위) — 받는 중인 출처 이름과 함께. 받는 중이 아니면 null. */
export function feedPendingText(phase: FeedPendingPhase, sources: readonly SearchSourceStatus[]): string | null {
  if (phase === "none") return null;
  const names = sources
    .filter((source) => source.status === "pending")
    .map((source) => source.label || sourceLabel(source.source))
    .join(" · ");
  const suffix = names ? `(${names})` : "";
  return phase === "polling"
    ? `받는 중인 출처가 있어 몇 초 뒤 다시 읽습니다${suffix}.`
    : `받는 중 — 1분 동안 다시 읽었지만 아직 받지 못했습니다${suffix}.`;
}

// ------------------------------------------------------------------ 탭 줄

/**
 * 가로로 넘치는 탭 줄(좁은 화면)에서 고른 탭이 다 보이게 옮길 가로 거리(px) — 왼쪽으로 잘렸으면 음수, 오른쪽으로 잘렸으면 양수, 다 보이면 0.
 * scrollIntoView의 inline:'nearest'와 같은 규칙이고(탭이 줄보다 넓으면 왼쪽 가장자리를 맞춤), 세로(화면 전체)는 건드리지 않습니다.
 */
export function revealScrollDelta(container: { left: number; right: number }, item: { left: number; right: number }): number {
  if (item.left < container.left) return item.left - container.left;
  if (item.right > container.right) return Math.min(item.right - container.right, item.left - container.left);
  return 0;
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

/** 보유 탭의 13F 검색어와 무엇으로 찾는지 — 영문 이름(name)인지, 영문 이름이 없어 쓴 티커(ticker)인지(화면의 머리·0건 안내가 다름, QA-436). */
export type HoldersQuery = { text: string; by: "name" | "ticker" };

/**
 * 대상 이름이 수집기가 이름을 얻지 못해 채운 대체값인가 — 수집기(search_entities finish)는 한글·영문 이름이 하나도 없으면 name을 키의 티커(us:)·
 * 종목코드(kr:)·QID(wd:)로 채웁니다(SEC 표에 없는 티커, 출처 일시 실패, DART 저장본 읽기 실패 때). 이 값은 영문 이름이 아닙니다(QA-436 후속).
 */
function isFallbackName(entity: Pick<SearchEntity, "key" | "name" | "ids">): boolean {
  const name = entity.name.trim().toUpperCase();
  const keyCode = entity.key.slice(entity.key.indexOf(":") + 1);
  return [entity.ids.ticker, entity.ids.stockCode, keyCode, entity.key].some((code) => code != null && code.trim().toUpperCase() === name);
}

/**
 * 13F 보유 기관 검색어(GET /api/guru/holders — 공시 이름은 대문자 영문, 제출자가 잘라 적은 긴 이름은 백엔드가 앞부분으로 함께 찾음 — QA-436) — 영문 이름에서
 * 법인 꼬리를 떼고, 영문 이름이 없으면 티커(13F 공시 이름에는 티커가 적히지 않아 찾기 어려움 — 화면이 그렇게 적음). 영문 이름이 없을 때 한글이 없는 name을
 * 영문 이름으로 쓰되, 이름을 얻지 못해 키의 티커·종목코드로 채운 name은 영문 이름이 아니라 티커로 찾습니다(QA-436 후속).
 */
export function holdersQuery(entity: Pick<SearchEntity, "key" | "name" | "nameEn" | "ids">): HoldersQuery | null {
  const english = entity.nameEn ?? (HANGUL.test(entity.name) || isFallbackName(entity) ? null : entity.name);
  const name = holderQuery(english);
  if (name) return { text: name, by: "name" };
  return entity.ids.ticker ? { text: entity.ids.ticker, by: "ticker" } : null;
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

/** 원문 주소 — http(s)만(javascript: 등은 링크로 두지 않음). */
export function httpUrl(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

type TimedItem = Pick<SearchFeedItem, "publishedAt"> & Partial<Pick<SearchFeedItem, "timeBasis">>;

/**
 * 날짜만 아는 줄인가(계약 §7-1 — DART 접수일·EDGAR 전문 검색 접수일·네이버 리포트 날짜·거장 견해 기준일(KST)). publishedAt은 그 날짜의 출처 달력 00:00을 UTC로 바꾼 값이라
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

// ------------------------------------------------------------------ 본문 보기(ADR 0043, 계약 §10)

/**
 * 미리 보기의 '본문 보기'가 하는 일 — 수집 글(readerId)은 받아 둔 원문 팝업(stored), 꼬리표(bodyRef)가 있으면 운영 서버가 그 글 한 건을 받는 팝업
 * (fetch), 받지 않는 매체면 단추 없이 그 까닭(none + note), 그 밖은 아무것도 없음. 운영자가 아니면(회원·데모) 늘 none — 그 경로들이 운영자 전용입니다.
 */
export type ArticleAction = { mode: "stored" } | { mode: "fetch"; ref: string } | { mode: "none"; note: string | null };

const BODY_REF = /^[0-9a-f]{32}$/;

export function articleActionOf(item: Pick<SearchFeedItem, "readerId" | "bodyRef" | "bodyNote">, owner: boolean): ArticleAction {
  if (!owner) return { mode: "none", note: null };
  if (item.readerId) return { mode: "stored" };
  if (item.bodyRef && BODY_REF.test(item.bodyRef)) return { mode: "fetch", ref: item.bodyRef };
  const note = item.bodyNote?.trim();
  return { mode: "none", note: note ? note : null };
}

/**
 * 미리 보기 아래 안내 한 줄 — 본문 보기가 무엇을 하는지(운영자), 회원·본문 보기가 없는 줄은 지금 글 그대로. 받지 않는 매체(note 있음)는 단추 자리의
 * '본문 보기 없음: 까닭' 한 줄로 충분해 null(같은 뜻의 두 줄이 겹치지 않게).
 */
export function articlePreviewNote(action: ArticleAction): string | null {
  if (action.mode === "fetch") return "본문 보기는 누를 때 운영 서버가 이 글 한 건을 받아 본문만 추려 보입니다 — 저장하지 않습니다.";
  if (action.mode === "stored") return "본문 보기는 운영 서버가 받아 둔 글을 엽니다.";
  if (action.note) return null;
  return "기사 본문은 받지 않습니다 — 제목·매체·시각·요약만입니다.";
}

/**
 * 본문 팝업의 상태 줄(화면 읽기 프로그램) — 단계마다 한 줄: 받는 중·멈춤·받음(문단 수)·실패(사유). 팝업은 이 줄을 단계와 상관없이 늘 붙여 두고
 * 글만 갈아 넣습니다(새로 붙은 live region은 읽히지 않음).
 */
export function articleAnnouncement(phase: "loading" | "stalled" | "done" | "error", reason: string, paragraphs: number): string {
  if (phase === "loading") return "운영 서버가 글을 받는 중입니다";
  if (phase === "stalled") return "아직 받는 중입니다 — 잠시 뒤 다시 확인하세요";
  if (phase === "done") return `본문을 받았습니다(문단 ${paragraphs}개)`;
  return `받지 못했습니다: ${reason}`;
}

/** '다시 시도'를 잠근 시간 — 1분 이상이면 분(올림 — 배너의 '약 n분 뒤'와 같은 단위), 아니면 초. */
export function articleWaitText(seconds: number): string {
  return seconds >= 60 ? `약 ${Math.ceil(seconds / 60)}분` : `약 ${seconds}초`;
}

/**
 * 본문 팝업의 사실 줄 — 매체(글의 사이트 이름, 없으면 결과 줄의 매체) · 글쓴이 · 글에 적힌 날짜 · 받은 시각(KST, 받아 둔 것이면 그렇게) · 구글 경유.
 * 모르는 값은 줄째 뺍니다(지어내지 않음 — '—'도 두지 않음). 출처 링크는 따로 그립니다.
 */
export function articleFacts(article: SearchArticle, item: Pick<SearchFeedItem, "publisher" | "publisherDomain">): [string, string][] {
  const rows: [string, string][] = [];
  const site = article.siteName?.trim() || item.publisher?.trim() || item.publisherDomain?.trim() || null;
  if (site) rows.push(["매체", site]);
  if (article.author?.trim()) rows.push(["글쓴이", article.author.trim()]);
  if (article.publishedDate && /^\d{4}-\d{2}-\d{2}$/.test(article.publishedDate)) rows.push(["글에 적힌 날짜", article.publishedDate]);
  if (article.fetchedAt) {
    const at = formatKst(article.fetchedAt);
    if (at !== EMPTY) rows.push(["받은 시각", `${at} KST${article.cached ? " (받아 둔 것 — 서버 메모리 24시간)" : ""}`]);
  }
  if (article.viaGoogle) rows.push(["찾은 길", "구글 경유 주소를 풀어 찾은 원문 주소"]);
  return rows;
}

/** 본문 팝업의 표지 글 — 잘림·짧음·유료 표시. 아이콘과 함께 그립니다(색만으로 전하지 않음). */
export function articleFlags(article: Pick<SearchArticle, "truncated" | "short" | "paywalled" | "totalChars">): string[] {
  const out: string[] = [];
  if (article.truncated) out.push(`글이 길어 앞 40,000자만 보입니다(전체 ${article.totalChars.toLocaleString("ko-KR")}자).`);
  if (article.short) out.push("추린 글이 짧습니다 — 유료·로그인 글이거나 본문이 그림·영상일 수 있습니다.");
  if (article.paywalled) out.push("유료 글 표시가 있어 공개된 앞부분만일 수 있습니다.");
  return out;
}

/** 사유 코드 → 화면 글. 서버 글(호스트가 든 한 줄)이 있으면 그것을 먼저, 없으면 코드의 기본 글, 모르는 코드는 일반 글. */
const ARTICLE_REASONS: Record<string, string> = {
  server_only: "본문 보기는 운영 서버에서만 됩니다 — 이 PC·QA에서는 원문 열기로 보세요.",
  offline: "외부를 부르지 않는 읽기 방식이라 받아 둔 본문만 봅니다 — 원문 열기로 보세요.",
  user_limit: "한 시간에 새로 받을 수 있는 10건을 다 썼습니다 — 잠시 뒤 다시 누르세요.",
  unknown_ref: "이 결과를 찾지 못했습니다 — 결과를 다시 불러 주세요.",
  refused_host: "이 매체의 글은 받지 않습니다.",
  relay_unresolved: "구글 경유 주소를 원문 주소로 풀지 못했습니다 — 원문 열기는 브라우저가 옮겨 줍니다.",
  unsafe_address: "내부·특수 주소로 풀리는 곳이라 받지 않습니다.",
  bad_redirect: "허용하지 않는 곳으로 옮겨지거나 3번을 넘게 옮겨져 받지 않았습니다.",
  blocked: "매체가 요청을 거부했습니다(봇 확인·로그인 등).",
  budget: "오늘 본문 받기 예산을 다 썼습니다 — 내일(KST) 다시.",
  queue_full: "다른 글을 받는 중이라 대기열이 가득 찼습니다 — 잠시 뒤 다시.",
  timeout: "매체의 응답이 늦어 끊었습니다.",
  transport: "매체에 연결하지 못했습니다.",
  too_large: "페이지가 3MB를 넘어 받지 않았습니다.",
  not_html: "HTML 글이 아닙니다(PDF 등) — 원문 열기로 보세요.",
  http_error: "매체가 오류로 답했습니다.",
  no_body: "본문을 찾지 못했습니다 — 유료·로그인 글이거나 스크립트로 그리는 화면일 수 있습니다.",
  not_cached: "받아 둔 본문이 없습니다.",
};

export function articleReasonText(response: Pick<SearchArticleResponse, "reason" | "message"> & { available?: boolean }): string {
  const message = response.message?.trim();
  if (message) return message;
  if (response.available === false) return "수집기에서 응답을 받지 못했습니다.";
  const reason = response.reason ?? "";
  return Object.hasOwn(ARTICLE_REASONS, reason) ? ARTICLE_REASONS[reason] : "본문을 받지 못했습니다.";
}

/** 본문 팝업의 글이 한국어가 아닌가 — 번역 단추를 둘지(언어를 모르면 글자로 다시 봄: 한글 30% 미만). */
export function articleNeedsTranslation(article: Pick<SearchArticle, "lang" | "paragraphs">): boolean {
  if (article.lang === "ko") return false;
  const text = article.paragraphs.join(" ");
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters === 0) return false;
  const hangul = text.match(/[가-힣]/g)?.length ?? 0;
  return hangul * 10 < letters * 3;
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

// ------------------------------------------------------------------ 별칭 편집·알림(단계 6 묶음 2 — 계약 §9-4·9-5)

/** 관심 대상 한 줄의 별칭 상한 — 개수와 하나의 글자 수(서버 PATCH 검사와 같음). */
export const WATCH_ALIAS_MAX = 12;
export const WATCH_ALIAS_CHARS = 60;

/**
 * 짧은 별칭 안내(계약 §4 규칙 5·§6-3) — 4글자 미만 별칭은 자유 검색어에도 받아 둔 글 대조에도 쓰지 않고, 이름은 길이와 상관없이 씁니다.
 * 판마다 긴 별칭부터 4개까지 묻습니다.
 */
export const ALIAS_SHORT_NOTE =
  "4글자 미만 별칭은 뉴스 검색어와 받아 둔 글 대조에 쓰지 않습니다(대상 이름은 길이와 상관없이 씀). 검색은 언어 판마다 긴 별칭부터 4개까지 묻습니다.";

/**
 * 관심 대상 별칭을 어떻게 합쳐 쓰는지(계약 §9-4) — 결과 경로는 대상 풀기의 별칭에 이 목록을 더해 씀(수집기 with_aliases — 합집합)이라 표에 있는 별칭은
 * 여기서 빼도 쓰이고, 정기 수집은 대표 키마다 모든 사용자의 목록을 합칩니다. 빼면 검색에서 빠지는 것처럼 보이지 않게 편집 칸에 늘 적습니다.
 */
export const ALIAS_MERGE_NOTE =
  "결과 검색은 대상 이름과 속성 표의 '별칭'(대상을 풀 때 나온 것)에 이 목록을 더해 씁니다 — 표에 있는 별칭은 여기서 빼도 결과 검색에 쓰입니다. 정기 수집은 이 대상을 등록한 모든 사용자의 목록을 합쳐 씁니다.";

/** 제어 글자(C0·DEL·C1). */
const ALIAS_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** 안내 글에 넣을 때 공백으로 바꿀 제어 글자. */
const ALIAS_CONTROL_ALL = /[\u0000-\u001f\u007f-\u009f]/g;
const ALIAS_SHOWN_CHARS = 20;

/** 별칭 다듬기 — 앞뒤 공백을 떼고 가운데 이어진 공백을 하나로. */
const cleanAlias = (raw: string) => raw.replace(/\s+/g, " ").trim();
/** 중복을 가르는 키 — 대소문자 무시(서버와 같음). */
const aliasKey = (alias: string) => alias.toLowerCase();

/** 안내 글에 넣는 별칭 — 제어 글자는 공백으로, 20자 넘으면 자름. */
function shownAlias(alias: string): string {
  const visible = alias.replace(ALIAS_CONTROL_ALL, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(visible);
  return chars.length > ALIAS_SHOWN_CHARS ? `${chars.slice(0, ALIAS_SHOWN_CHARS).join("")}…` : visible;
}

/** 다듬은 별칭 하나의 모양 사유(맞으면 null) — 비었나·60자·제어 글자. */
function aliasShapeError(alias: string): "empty" | "long" | "control" | null {
  if (!alias) return "empty";
  if (codePoints(alias) > WATCH_ALIAS_CHARS) return "long";
  if (ALIAS_CONTROL.test(alias)) return "control";
  return null;
}

export type AliasDraft = { ok: true; alias: string } | { ok: false; message: string };

/**
 * 편집 중인 목록에 더할 별칭 하나 — 다듬고 서버와 같은 검사(1~60자, 제어 글자 없음, 대소문자 무시 중복 없음, 12개 안).
 * 서버가 같은 검사를 다시 합니다 — 이것은 틀린 값으로 400을 부르지 않게 하는 앞단입니다.
 */
export function aliasDraft(raw: string, existing: readonly string[]): AliasDraft {
  const alias = cleanAlias(raw);
  const shape = aliasShapeError(alias);
  if (shape === "empty") return { ok: false, message: "별칭을 넣어 주세요" };
  if (shape === "long") return { ok: false, message: `별칭은 ${WATCH_ALIAS_CHARS}자까지입니다` };
  if (shape === "control") return { ok: false, message: "별칭에 쓸 수 없는 글자가 있습니다" };
  const key = aliasKey(alias);
  if (existing.some((other) => aliasKey(cleanAlias(other)) === key)) return { ok: false, message: "이미 있는 별칭입니다(대소문자 무시)" };
  if (existing.length >= WATCH_ALIAS_MAX) return { ok: false, message: `별칭은 ${WATCH_ALIAS_MAX}개까지입니다` };
  return { ok: true, alias };
}

export type AliasesForSave = { ok: true; aliases: string[] } | { ok: false; message: string };

/**
 * 저장할 별칭 목록(PATCH {aliases}) — 하나씩 다듬어 검사하고, 대소문자 무시 중복은 앞의 것 하나만 남깁니다(서버와 같음). 1~12개.
 * 서버에 이미 있던 값이 규칙에 어긋나면(등록 때 받은 긴 별칭 등) 그 별칭을 짚어 막습니다 — 보내면 서버가 400으로 거절합니다.
 */
export function aliasesForSave(aliases: readonly string[]): AliasesForSave {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of aliases) {
    const alias = cleanAlias(raw);
    const shape = aliasShapeError(alias);
    if (shape === "empty") return { ok: false, message: "빈 별칭이 있습니다 — 빼고 저장하세요" };
    if (shape === "long") return { ok: false, message: `별칭 '${shownAlias(alias)}'이(가) ${WATCH_ALIAS_CHARS}자를 넘습니다 — 빼고 저장하세요` };
    if (shape === "control") return { ok: false, message: `별칭 '${shownAlias(alias)}'에 쓸 수 없는 글자가 있습니다 — 빼고 저장하세요` };
    const key = aliasKey(alias);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  if (out.length === 0) return { ok: false, message: "별칭은 하나 이상이어야 합니다" };
  if (out.length > WATCH_ALIAS_MAX) return { ok: false, message: `별칭은 ${WATCH_ALIAS_MAX}개까지입니다` };
  return { ok: true, aliases: out };
}

/** 두 별칭 목록이 순서·글자까지 같은가 — 바뀐 것이 없으면 저장 요청을 보내지 않습니다. */
export function sameAliases(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((alias, index) => alias === b[index]);
}

/** 관심 대상 줄의 별칭(그 사용자의 검색어) — 문자열 배열일 때만. 칸이 없거나 모양이 틀리면 null(모름 — 빈 목록으로 채우지 않음). */
export function watchAliasesOf(item: Pick<SearchWatchItem, "aliases"> | null | undefined): string[] | null {
  const value: unknown = item?.aliases;
  if (!Array.isArray(value)) return null;
  return value.filter((alias): alias is string => typeof alias === "string");
}

/** 관심 대상 줄의 알림 켬·끔 — true·false일 때만. 칸이 없으면 null(끔으로 채우지 않음 — 화면은 단추를 그리지 않음). */
export function watchNotifyOf(item: Pick<SearchWatchItem, "notify"> | null | undefined): boolean | null {
  const value: unknown = item?.notify;
  return typeof value === "boolean" ? value : null;
}

/**
 * 알림 단추의 이름 — 상태와 상관없이 같습니다(aria-pressed 단추의 이름이 상태에 따라 바뀌면 '알림 끔, 누르지 않음'처럼 들려 지금 상태인지
 * 누르면 할 일인지 모호함 — WAI-ARIA APG). 상태는 aria-pressed와 보이는 글(notifyStateText)이 나릅니다.
 */
export const NOTIFY_LABEL = "알림";

/** 알림 단추에 보이는 상태 글(색·아이콘만이 아님) — 낭독은 aria-pressed가 하므로 이 글은 이름에 넣지 않습니다. */
export function notifyStateText(on: boolean): string {
  return on ? "켬" : "끔";
}

/** 관심 대상 새 글 알림의 알림함 종류(계약 §9-5). */
export const SEARCH_WATCH_ALERT_KIND = "SEARCH_WATCH";
const INBOX_HREF_MAX = 2048;
/** 정보 검색 화면 주소 — '/search' 다음은 끝·'?'·'#'만(다른 경로·'/search/..'·'/searchx'가 아님), 공백·역슬래시·제어 글자 없음. */
const INBOX_HREF = /^\/search(?:[?#][^\s\\\u0000-\u001f\u007f]*)?$/;

/**
 * 알림함 줄이 가는 주소 — 관심 대상 새 글 알림(SEARCH_WATCH)의 payload.href가 이 앱의 정보 검색 화면이면 그 주소, 아니면 null(누를 수 없는 줄 그대로).
 * 다른 종류의 알림은 늘 null입니다. 서버가 만든 값이지만 바깥 주소·다른 화면으로 보내지 않게 '/search'로 시작하는 안쪽 경로만 받습니다.
 */
export function searchWatchInboxHref(item: { kind?: string | null; payload?: unknown }): string | null {
  if (item.kind !== SEARCH_WATCH_ALERT_KIND) return null;
  const payload = item.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const href: unknown = (payload as { href?: unknown }).href;
  if (typeof href !== "string" || href.length > INBOX_HREF_MAX || !INBOX_HREF.test(href)) return null;
  return href;
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
 * 관심 대상 등록이 덜 풀린 대상이라 저장되지 않았으면(503 partial) 받지 못한 출처를 이름으로 적은 글(watchPartialText).
 */
export function writeErrorText(error: unknown, conflict: string): string {
  if (!(error instanceof Error)) return "알 수 없는 오류";
  const status = statusOf(error);
  const generic = !error.message || GENERIC_FAILURE.test(error.message);
  if (status === 409 && generic) return conflict;
  if (status === 403 && generic) return "이 계정으로는 할 수 없습니다";
  const partial = status === 503 ? watchPartialText((error as { body?: unknown }).body) : null;
  if (partial) return partial;
  return error.message || "알 수 없는 오류";
}

/** DART 고유번호 저장본을 읽지 못한 출처 키(수집기 search_entities.DART_STORE·백엔드 SearchWatchService.DART_STORE) — 저장본이 없으면 1분 뒤에도 같습니다. */
export const WATCH_PARTIAL_DART_STORE = "dart_store";

/**
 * 관심 대상 등록 503 partial의 다시 해 볼 때(백엔드 SearchWatchService.RETRY_LATER와 같은 글 — infoSearchWatchPartialParity 시험이 대조) — 시점을
 * 약속하지 않습니다. 시간 초과 같은 일시 실패는
 * 수집기가 60초만 캐시해 1분쯤 뒤 새로 풀지만, 거부(429·403)를 받은 출처는 수집기가 몇 분 동안 호출을 멈추고(사유 '… · 5분 동안 이 출처 호출을 멈춤'),
 * 설정 문제(SEC_USER_AGENT)는 고칠 때까지 같습니다.
 */
export const WATCH_PARTIAL_RETRY_LATER =
  "사유가 풀린 뒤 다시 등록하세요(시간 초과 같은 일시 실패는 1분쯤 뒤, 수집기가 호출을 멈춘 출처는 멈춘 시간이 지난 뒤, 설정 문제는 고친 뒤).";
/** DART 고유번호 저장본(dart_store)이 섞였을 때(백엔드 SearchWatchService.RETRY_DART_STORE와 같은 글 — 같은 시험이 대조) — 저장본이 없으면 1분 뒤에도 같습니다. */
export const WATCH_PARTIAL_RETRY_DART_STORE =
  "DART 고유번호 저장본을 다시 읽을 수 있을 때까지는 다시 등록해도 같습니다(저장본은 수집기의 DART 재무 수집이 받아 둠).";

/**
 * 관심 대상 등록의 503 partial 본문(POST /api/search/watch — 계약 §6-4) → 받지 못한 출처를 적은 글. 출처 글은 속성 칸의 '대상을 푸는 데 받지 못한
 * 출처'와 같은 함수(entityFailuresText — 사유는 이름 뒤 괄호, 출처는 쉼표로 이음: 'DART(DART 고유번호 저장본을 읽지 못함)')로 만듭니다. 다시 해 볼 때는
 * DART 고유번호 저장본(dart_store)이 섞이면 저장본을 다시 읽을 때까지 같다고 하고, 아니면 시점을 약속하지 않는 WATCH_PARTIAL_RETRY_LATER.
 * partial이 아니거나 failed에 읽을 줄이 없으면 null(서버 사유를 그대로 씀). 사유가 없는 줄은 이름만.
 */
export function watchPartialText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const { reason, failed } = body as Partial<Record<keyof SearchWatchPartialBody, unknown>>;
  if (reason !== "partial" || !Array.isArray(failed)) return null;
  const failures: [string, unknown][] = [];
  let store = false;
  for (const entry of failed as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { source, message } = entry as Partial<Record<keyof SearchWatchPartialBody["failed"][number], unknown>>;
    const key = typeof source === "string" ? source.trim() : "";
    if (!key) continue;
    if (key === WATCH_PARTIAL_DART_STORE) store = true;
    failures.push([key, message]);
  }
  if (failures.length === 0) return null;
  const retry = store ? WATCH_PARTIAL_RETRY_DART_STORE : WATCH_PARTIAL_RETRY_LATER;
  return `대상 정보를 다 받지 못해 등록하지 않았습니다. 받지 못한 출처: ${entityFailuresText(failures)}. ${retry}`;
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
  sources?: readonly Pick<SearchSourceStatus, "status" | "source">[] | null;
}): string {
  const base = feed.refreshNote
    ? feed.refreshNote
    : feed.fetchedAt
      ? `새로 받았습니다 — 받은 시각 ${formatKst(feed.fetchedAt)} KST`
      : "새로 받았습니다";
  // Finviz의 건너뜀(예산·한 사람 빈도 상한·대기열)도 받지 못한 것 — isUnanswered와 같은 기준(받는 중은 따로 말함).
  const partial = (feed.sources ?? []).some((source) => NOT_RECEIVED.has(source.status)
    || (source.status === "skipped" && source.source === "finviz"));
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

// ------------------------------------------------------------------ AI 요약(단계 6 묶음 3 — 계약 §9-6, 운영자 전용)

/** 결과 머리의 단추 이름(읽는 중에도 같음 — 상태는 옆의 글과 aria-disabled가 나름). */
export const SUMMARY_LABEL = "요약";

const SUMMARY_FAILED = "요약하지 못했습니다";

/** 앞서 다른 기간·탭에서 누른(또는 닫은) 요약이 아직 끝나지 않아 단추가 잠긴 동안의 상태 글 — 서버가 요약을 한 번에 하나만 만듦(겹치면 429). */
export const SUMMARY_WAITING_TEXT = "AI 요약은 한 번에 하나만 만듭니다 — 앞서 누른 요약이 끝나면 누를 수 있습니다.";

/**
 * 요약 패널 머리의 안내(계약 §9-6) — n은 서버가 읽은 줄 수(basedOn). 모르면 건수 없이 둡니다(0으로 채우지 않음).
 * 요약은 받아 둔 줄의 제목·매체·날짜·출처 요약만 보고 만든 것이라 원문을 확인해야 한다고 늘 적습니다.
 */
export function summaryNoteText(basedOn: number | null | undefined): string {
  const known = typeof basedOn === "number" && Number.isFinite(basedOn) && basedOn >= 0;
  return known
    ? `AI 요약 — 받은 자료 ${Math.floor(basedOn)}건의 제목·요약만 보고 만든 것, 원문 확인 필요`
    : "AI 요약 — 받은 자료의 제목·요약만 보고 만든 것, 원문 확인 필요";
}

/**
 * 서버가 준 요약 줄 — 글이 있는 줄만(앞뒤 공백을 뗌), 근거는 빈 글이 아닌 글 id만(겹친 것은 처음 것 하나, 받은 순서). 모양이 틀린 칸은 버립니다.
 * 글은 화면이 글로만 그립니다(링크·태그로 바꾸지 않음 — 모델이 낸 글이라).
 */
export function summaryLinesOf(response: { summary?: unknown } | null | undefined): SearchSummaryLine[] {
  const raw = response?.summary;
  if (!Array.isArray(raw)) return [];
  const lines: SearchSummaryLine[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { text, refs } = entry as { text?: unknown; refs?: unknown };
    if (typeof text !== "string" || !text.trim()) continue;
    const ids = Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === "string" && ref.length > 0) : [];
    lines.push({ text: text.trim(), refs: [...new Set(ids)] });
  }
  return lines;
}

/** 요약 줄의 근거 하나 — 받은 자료에 있는 줄(제목)과 지금 목록에서 갈 수 있는지(기간·거르기·막대 좁히기 안 — 접힌 같은 사건 묶음 포함). */
export type SummaryRef = { id: string; title: string | null; reachable: boolean };

/**
 * 근거를 지금 화면의 묶음과 맞춥니다. 받은 자료(items — 받은 2년 묶음)에 있는 줄은 받은 순서로 제목과 함께, 없는 근거는 건수(missing)만
 * (서버가 읽은 저장본과 화면의 묶음이 다를 수 있음 — 새로 받기 뒤 등). reachable = 지금 목록에서 그 줄로 갈 수 있는 id들.
 */
export function summaryRefs(
  refs: readonly string[],
  items: readonly SearchFeedItem[],
  reachable: ReadonlySet<string>,
): { refs: SummaryRef[]; missing: number } {
  const byId = new Map(items.map((item) => [item.id, item]));
  const out: SummaryRef[] = [];
  let missing = 0;
  for (const id of refs) {
    const item = byId.get(id);
    if (!item) missing += 1;
    else out.push({ id, title: item.title || null, reachable: reachable.has(id) });
  }
  return { refs: out, missing };
}

/** 모델·만든 시각(KST) 한 줄 — 모르는 칸은 빼고, 둘 다 모르면 null. */
export function summaryMetaText(response: Pick<SearchSummaryResponse, "model" | "generatedAt">): string | null {
  const model = typeof response.model === "string" ? response.model.trim() : "";
  const parts = [model ? `모델 ${model}` : null, response.generatedAt ? `만든 시각 ${formatKst(response.generatedAt)} KST` : null];
  const shown = parts.filter((part): part is string => part !== null);
  return shown.length > 0 ? shown.join(" · ") : null;
}

/**
 * 받아 둔 결과가 없는 출처 이름 사이 — 쉼표. 출처 이름에 '·'가 든 것이 있어('보도자료·경제지 피드') '·'로 이으면 출처 경계가 사라져 서버 안내의
 * '출처 N곳'과 보이는 이름 수가 어긋납니다(관심 대상 등록 안내 watchPartialText와 같은 까닭으로 같은 구분).
 */
const OFFLINE_SOURCE_GLUE = ", ";

/**
 * 요약에 들지 않은 출처의 한 줄(없으면 null) — 서버는 받아 둔 결과(수집기 출처 캐시 — 성공 15분·실패 60초)만 읽어 요약하므로, 캐시에 없는 바깥
 * 출처와 막 실패한 출처는 요약에 없습니다(화면 목록에는 보일 수 있음). 캐시가 지난 뒤에는 받은 지 15분이 지난 것·받지 못한 것·아직 부르지 않은
 * 것을 가를 수 없어 사유를 하나로 단정하지 않습니다(QA-427). 실패를 '없음'으로 보이지 않게 이름을 적습니다(출처는 쉼표로 이음 — OFFLINE_SOURCE_GLUE).
 */
export function summaryOfflineText(response: Partial<Pick<SearchSummaryResponse, "offlineSources">>): string | null {
  const names = offlineSourceNames(response);
  return names.length
    ? `요약에 들지 않은 출처: ${names.join(OFFLINE_SOURCE_GLUE)} — 서버에 받아 둔 결과가 없음(받은 지 15분이 지났거나, 받지 못했거나, 아직 부르지 않음). 새로 받기에 성공한 뒤 다시 요약하면 들어갑니다.`
    : null;
}

/** 받은 요약에 줄이 없을 때의 글 — 서버가 읽은 줄이 0건이면 그렇다고, 그 밖에는 받지 못했다고. */
export function summaryEmptyText(response: Pick<SearchSummaryResponse, "basedOn">): string {
  return response.basedOn === 0 ? "고른 기간에 받아 둔 자료가 없어 요약하지 않았습니다." : "요약 줄을 받지 못했습니다.";
}

/** 받아 둔 결과가 서버에 없는 출처의 이름(offlineSources — 키면 출처 상태 줄과 같은 이름으로, 빈 글은 뺌). */
function offlineSourceNames(response: Partial<Pick<SearchSummaryResponse, "offlineSources">>): string[] {
  return (response.offlineSources ?? []).filter((name) => typeof name === "string" && name.trim()).map((name) => sourceLabel(name.trim()));
}

/**
 * 수집기·엔진에 닿지 못한 응답(available:false — 엔진 키 없음·수집기·받아 둔 결과 없음·엔진 실패)의 글. 서버 사유가 없으면 기본 글.
 * 서버 사유(message)는 본문만 담으므로 '요약하지 못했습니다'는 여기서 한 번만 붙입니다(QA-428). 받아 둔 결과가 없는 출처(stale의
 * offlineSources)가 있으면 그 이름을 '요약에 들지 않은 출처'와 같은 이름으로 덧붙입니다 — 서버 사유는 곳 수만 말하므로(사유 글은 서버 것 그대로 —
 * 하나로 단정하지 않음, QA-427).
 */
export function summaryUnavailableText(
  response: Partial<Pick<SearchSummaryResponse, "available" | "message" | "offlineSources">>,
): string {
  const message = typeof response.message === "string" ? response.message.trim() : "";
  const base = message ? `${SUMMARY_FAILED} — ${message}` : `${SUMMARY_FAILED}.`;
  const names = offlineSourceNames(response);
  if (!names.length) return base;
  return `${base}${/[.!?]$/.test(base) ? "" : "."} 받아 둔 결과가 없는 출처: ${names.join(OFFLINE_SOURCE_GLUE)}.`;
}

/**
 * 요청 실패의 글 — 서버 사유 그대로, 권한(403)은 사유가 없으면 '이 계정으로는 할 수 없습니다'(writeErrorText와 같은 규칙). 429(하루 글자 상한·
 * 다른 요약을 만드는 중)의 사유도 본문만이라 앞머리는 여기서 한 번만(QA-428).
 */
export function summaryErrorText(error: unknown): string {
  const reason = writeErrorText(error, "");
  return reason ? `${SUMMARY_FAILED} — ${reason}` : `${SUMMARY_FAILED}.`;
}

/** 패널을 비우는 열쇠 — (대상, 탭, 기간) 가운데 하나라도 바뀌면 다른 열쇠(화면은 그때 패널을 비우고 늦은 응답을 버림). */
export function summaryRequestKey(request: SearchSummaryRequest): string {
  return JSON.stringify([request.e, request.tab, request.range]);
}
