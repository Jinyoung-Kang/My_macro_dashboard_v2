/**
 * 정보 검색의 대상 키 검사와 주소 만들기 — 명령 팔레트(셸, lib/search.ts)도 쓰는 작은 부분만 lib/infoSearch.ts에서 떼어 둔 모듈입니다.
 * 셸은 모든 화면이 함께 싣기 때문에, 166 KB짜리 infoSearch 전체를 끌고 오지 않게 여기만 가져옵니다(ADR 0047 결정 7, 성능 개선 작업 C4).
 * infoSearch.ts가 같은 이름으로 다시 내보내므로 정보 검색 화면 쪽 가져오기는 그대로입니다.
 */
import type { SearchRange } from "./types";

/**
 * 화면의 탭 — 타임라인·뉴스·공시·리서치·글·논평은 결과 경로(feed), 보유는 13F 경로, 연결은 대상 풀기의 links + 연결 보강 경로(단계 4).
 */
export type SearchTabKey = "timeline" | "news" | "filings" | "research" | "posts" | "holdings" | "links";

export const DEFAULT_TAB: SearchTabKey = "timeline";

export const DEFAULT_RANGE: SearchRange = "30d";

// ------------------------------------------------------------------ 대상 키

// 수집기(search.py의 _KEY_PATTERNS)·백엔드(SearchService)와 같은 문법 — 어긋나면 수집기의 400이 '응답 없음'으로 보입니다.
const KEY_PATTERNS: readonly RegExp[] = [/^us:[A-Z0-9][A-Z0-9.-]{0,14}$/, /^kr:\d{6}$/, /^cik:\d{10}$/, /^wd:Q[1-9]\d{0,11}$/];
export const TOPIC_MAX = 60;
// 제어 글자를 막는 것이 목적. 이 저장소 eslint 설정에서는 no-control-regex가 꺼져 있음(그 규칙은 \u 이스케이프도 잡음) — 켜면 이 줄에 끄기 주석을 다시 둘 것.
export const CONTROL = /[\u0000-\u001f\u007f]/;

export const codePoints = (text: string) => Array.from(text).length;

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
