/**
 * 명령 팔레트(통합 검색 SearchCommand를 넓힌 것 — 작업대 실행 명세 §5, P3)의 범주 가운데 lib/search 밖의 것 — React를 모르는 순수 함수(ADR 0004).
 *
 * - 최근 연 대상: 팔레트에서 고른 지표·기관·종목(종목 찾기 포함)을 이 브라우저에만(localStorage) 최신 순 8개 기억합니다. 검색어가 빌 때만 보입니다.
 *   메뉴는 넣지 않습니다(메뉴는 왼쪽 메뉴·탭에 늘 있음). 저장값은 읽을 때 형식을 다시 검사합니다 — 종류 넷, 주소는 상세 화면 세 경로뿐이고
 *   lib/detail의 parse 함수로 다시 풀어 만든 주소만 씁니다. 저장소 값이 바뀌어도(다른 확장·사람이 고침) 다른 주소(javascript: 등)로 보내지 않습니다.
 *   공개 시세 대상의 이름·티커만 담깁니다(실제 계좌 자료 없음).
 */
import { indicatorHref, institutionHref, parseCik, parseIndicatorKey, parseStockRoute, stockHref } from "./detail";
import { assetMonogram } from "./patternRows";
import type { SearchAvatar, SearchEntry } from "./search";

// ------------------------------------------------------------------ 최근 연 대상

/** 최근 연 대상을 두는 localStorage 키(값 `{"v":1,"items":[…]}`). */
export const RECENT_STORAGE_KEY = "shell.palette.recent";
/** 기억하는 수 — 넘치면 오래된 것부터 밀려납니다(지우기 단추는 두지 않음). */
export const RECENT_LIMIT = 8;
/** 묶음 이름. */
export const RECENT_GROUP_LABEL = "최근 연 대상";
/** 저장 형식 판. 다르면 버립니다. */
const RECENT_VERSION = 1;
/** 글 칸 하나의 상한 — 넘으면 그 항목을 버립니다. */
const RECENT_TEXT_MAX = 200;

/** 최근 연 대상의 종류 — 상세 화면이 있는 것만(메뉴 없음). */
export type RecentKind = "indicator" | "institution" | "ticker" | "symbol";

export type RecentEntity = {
  kind: RecentKind;
  label: string;
  sub: string | null;
  /** 상세 화면 주소 — 읽을 때 다시 만든 것(/markets/i/<키>·/institutions/<CIK>·/s/<us|kr>/<코드>). */
  href: string;
  dest: string | null;
};

const RECENT_KINDS: readonly RecentKind[] = ["indicator", "institution", "ticker", "symbol"];

function isRecentKind(value: unknown): value is RecentKind {
  return typeof value === "string" && (RECENT_KINDS as readonly string[]).includes(value);
}

/** 상한 안의 글 — 비면(required) 또는 길면 undefined(그 항목을 버림). null은 required가 아니면 그대로. */
function textField(value: unknown, required: boolean): string | null | undefined {
  if (value === null || value === undefined) return required ? undefined : null;
  if (typeof value !== "string" || value.length > RECENT_TEXT_MAX) return undefined;
  if (required && value.trim() === "") return undefined;
  return value;
}

/**
 * 종류에 맞는 상세 화면 주소만 다시 만들어 돌려줍니다 — 지표 /markets/i/<키>, 기관 /institutions/<숫자 CIK>, 종목 /s/<us|kr>/<코드>.
 * 그 밖(다른 경로·쿼리·조각·javascript: 등)은 null.
 */
function canonicalHref(kind: RecentKind, href: string): string | null {
  if (kind === "indicator") {
    const match = /^\/markets\/i\/([^/?#]+)$/.exec(href);
    const key = match ? parseIndicatorKey(match[1]) : null;
    return key ? indicatorHref(key) : null;
  }
  if (kind === "institution") {
    const match = /^\/institutions\/([^/?#]+)$/.exec(href);
    const cik = match ? parseCik(match[1]) : null;
    return cik ? institutionHref(cik) : null;
  }
  const match = /^\/s\/(us|kr)\/([^/?#]+)$/.exec(href);
  const route = match ? parseStockRoute(match[1], match[2]) : null;
  return route ? stockHref(route.market, route.code) : null;
}

/** 저장값 한 항목 → 검사한 최근 대상. 형식 밖이면 null. */
export function normalizeRecent(value: unknown): RecentEntity | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  if (!isRecentKind(item.kind) || typeof item.href !== "string" || item.href.length > RECENT_TEXT_MAX) return null;
  const href = canonicalHref(item.kind, item.href);
  const label = textField(item.label, true);
  const sub = textField(item.sub, false);
  const dest = textField(item.dest, false);
  if (!href || typeof label !== "string" || sub === undefined || dest === undefined) return null;
  return { kind: item.kind, label, sub, href, dest };
}

/**
 * 저장 글 → 최근 대상 목록(최신 순, 같은 주소는 처음 것 하나, 상한까지). 비었거나 깨진 JSON·다른 판·형식 밖 항목은 버립니다(던지지 않음).
 */
export function parseRecent(raw: string | null | undefined): RecentEntity[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof data !== "object" || data === null) return [];
  const { v, items } = data as { v?: unknown; items?: unknown };
  if (v !== RECENT_VERSION || !Array.isArray(items)) return [];
  const out: RecentEntity[] = [];
  for (const item of items) {
    const entity = normalizeRecent(item);
    if (!entity || out.some((kept) => kept.href === entity.href)) continue;
    out.push(entity);
    if (out.length >= RECENT_LIMIT) break;
  }
  return out;
}

/** 맨 앞에 넣고 같은 주소의 옛 항목을 빼고 상한까지 — 형식 밖이면 목록 그대로. */
export function pushRecent(list: readonly RecentEntity[], entity: RecentEntity): RecentEntity[] {
  const checked = normalizeRecent(entity);
  if (!checked) return [...list];
  return [checked, ...list.filter((kept) => kept.href !== checked.href)].slice(0, RECENT_LIMIT);
}

/** 저장 글. */
export function serializeRecent(list: readonly RecentEntity[]): string {
  return JSON.stringify({ v: RECENT_VERSION, items: list.slice(0, RECENT_LIMIT) });
}

/** 결과 행 왼쪽 원판 — 지표는 시장, 기관은 기관 탭 아이콘, 종목은 티커 모노그램(통합 검색 결과와 같은 꼴). */
function recentAvatar(entity: RecentEntity): SearchAvatar | undefined {
  if (entity.kind === "indicator") return { tab: "markets" };
  if (entity.kind === "institution") return { tab: "institutions" };
  const code = decodeURIComponent(entity.href.split("/").pop() ?? "");
  const monogram = assetMonogram({ name: entity.label, ticker: code });
  return monogram ? { text: monogram } : undefined;
}

/** 최근 대상 → 결과 행(통합 검색 결과와 같은 모양 — id만 'recent:' 앞붙임). */
export function recentEntries(list: readonly RecentEntity[]): SearchEntry[] {
  return list.map((entity) => ({
    kind: entity.kind,
    id: `recent:${entity.href}`,
    label: entity.label,
    sub: entity.sub,
    href: entity.href,
    dest: entity.dest,
    keywords: [],
    avatar: recentAvatar(entity),
  }));
}

/** 고른 결과 → 최근 대상(지표·기관·종목·종목 찾기만, 메뉴는 null). */
export function recentFromEntry(entry: SearchEntry): RecentEntity | null {
  if (!isRecentKind(entry.kind)) return null;
  return normalizeRecent({ kind: entry.kind, label: entry.label, sub: entry.sub, href: entry.href, dest: entry.dest });
}
