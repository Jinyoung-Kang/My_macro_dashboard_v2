/**
 * 통합 검색(⌘K)의 색인과 일치 규칙 — React를 모르는 순수 함수(ADR 0004, 1단계 브리프 §1.4).
 *
 * 범주 네 가지: 메뉴(lib/nav의 보이는 화면) · 지표(매크로 카드 이름·티커) · 기관(13F 기관 목록) · 종목(스코어카드 유니버스 티커).
 * 지표·기관·종목 결과는 그 상세 화면으로 갑니다(명세 2026-11-01-search-detail — 지표 /markets/i/<키>, 기관 /institutions/<CIK>,
 * 종목 /s/<시장>/<코드>). 색인 밖의 종목은 다섯째 묶음 '종목 찾기'(외부 검색 — Yahoo·네이버, `symbolGroup`)가 찾습니다.
 *
 * 일치: 대소문자·공백·기호를 무시하고, 한글은 자모로 풀어 맞춥니다 — 입력 중인 글자("맼" → "매크로")와 초성("ㅅㅈ" → "시장")도 맞습니다.
 * 순위: 정확히 같음 > 앞부분 > 중간(같은 단계면 이름이 검색어보다 앞섬, 그다음 원래 순서). 범주마다 상한이 있고 넘친 수는 `more`로 알립니다.
 */
import { visibleMenus } from "./access";
import { indicatorHref, institutionHref, kindText, stockHref } from "./detail";
import { withoutLeadingIcon } from "./format";
import { searchHref } from "./infoSearch";
import type { NavSearchItem, TabKey } from "./nav";
import { assetMonogram } from "./patternRows";
import type { DetailSymbolsResponse, MacroOverview, SessionUser, StockUniverseResponse } from "./types";

/** 'symbol'은 색인 밖 외부 검색 묶음(종목 찾기) — 색인 일치(searchGroups)가 아니라 `symbolGroup`이 만듭니다. */
export type SearchKind = "menu" | "indicator" | "institution" | "ticker" | "symbol";

/**
 * 결과 행 왼쪽 원 안에 그릴 것 — 탭 아이콘(메뉴는 그 화면의 탭, 지표는 시장, 기관은 기관) 또는 종목 모노그램(`assetMonogram` — 티커 앞 글자).
 * 장식입니다(뜻은 이름 글이 나름). 모노그램을 만들 수 없으면 원을 비웁니다.
 */
export type SearchAvatar = { tab: TabKey } | { text: string };

export type SearchEntry = {
  kind: SearchKind;
  /** 모든 범주를 통틀어 겹치지 않는 키(React key). */
  id: string;
  label: string;
  /** 보조 글 — 탭 이름·카드 범주·티커·CIK. */
  sub: string | null;
  href: string;
  /** 도착 화면 이름(메뉴는 null — 이름이 곧 화면). */
  dest: string | null;
  /** 이름 말고도 맞추는 말(티커·옛 메뉴 이름·운용자 소개). */
  keywords: readonly string[];
  /** 무료 회원에게 잠긴 유료 화면(메뉴만) — 결과에 하위 메뉴·더보기와 같은 자물쇠 아이콘을 붙입니다. */
  locked?: boolean;
  /** 결과 행 왼쪽 원(없으면 빈 원). */
  avatar?: SearchAvatar;
};

/** 범주 순서와 이름(결과 묶음의 제목). */
export const SEARCH_KINDS: readonly { kind: SearchKind; label: string }[] = [
  { kind: "menu", label: "메뉴" },
  { kind: "indicator", label: "지표" },
  { kind: "institution", label: "기관" },
  { kind: "ticker", label: "종목" },
];

/** 범주마다 보이는 결과 수 — 넘치면 "N개 더"로 알립니다(조용히 자르지 않음). */
export const SEARCH_PER_GROUP = 6;

/** 결과가 가는 화면의 이름(오른쪽 '→ 화면' 캡션). 주소는 결과마다 그 상세 화면(lib/detail). */
const DEST = {
  indicator: "지표 상세",
  institution: "기관 상세",
  ticker: "종목 상세",
} as const;

/** 외부 검색 묶음의 제목. */
export const SYMBOL_GROUP_LABEL = "종목 찾기 · Yahoo·네이버";

/**
 * 스코어카드 유니버스 티커 → 종목 상세 주소. Yahoo 형식의 국내 종목('069500.KS'·'035720.KQ')은 국내 코드(/s/kr/069500), 그 밖은 미국·해외(/s/us/…).
 */
export function tickerHref(ticker: string): string {
  const korean = /^([0-9A-Z]{6})\.(KS|KQ)$/.exec(ticker.toUpperCase());
  return korean ? stockHref("kr", korean[1]) : stockHref("us", ticker.toUpperCase());
}

// ------------------------------------------------------------------ 정규화

const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
// 겹모음·겹받침은 낱자로 풉니다 — 입력기가 "고" 다음에 "과", "갈" 다음에 "갉"을 만들기 때문에(입력 중인 앞부분이 맞게).
const JUNG = ["ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅗㅏ", "ㅗㅐ", "ㅗㅣ", "ㅛ", "ㅜ", "ㅜㅓ", "ㅜㅔ", "ㅜㅣ", "ㅠ", "ㅡ", "ㅡㅣ", "ㅣ"];
const JONG = ["", "ㄱ", "ㄲ", "ㄱㅅ", "ㄴ", "ㄴㅈ", "ㄴㅎ", "ㄷ", "ㄹ", "ㄹㄱ", "ㄹㅁ", "ㄹㅂ", "ㄹㅅ", "ㄹㅌ", "ㄹㅍ", "ㄹㅎ", "ㅁ", "ㅂ", "ㅂㅅ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
const SYLLABLE_FIRST = 0xac00;
const SYLLABLE_LAST = 0xd7a3;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const CONSONANTS_ONLY = /^[ㄱ-ㅎ]+$/u;

/** 낱자 하나를 자모 글자열로. 한글 음절은 초·중·종성, 조합형 자모(NFKC가 호환 자모 ㄱ·ㅘ를 바꾼 것)도 같은 낱자로. */
function jamoOf(ch: string): { jamo: string; cho: string } {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= SYLLABLE_FIRST && code <= SYLLABLE_LAST) {
    const offset = code - SYLLABLE_FIRST;
    const cho = CHO[Math.floor(offset / 588)];
    return { jamo: cho + JUNG[Math.floor((offset % 588) / 28)] + JONG[offset % 28], cho };
  }
  if (code >= 0x1100 && code <= 0x1112) return { jamo: CHO[code - 0x1100], cho: CHO[code - 0x1100] };
  if (code >= 0x1161 && code <= 0x1175) return { jamo: JUNG[code - 0x1161], cho: JUNG[code - 0x1161] };
  if (code >= 0x11a8 && code <= 0x11c2) return { jamo: JONG[code - 0x11a8 + 1], cho: JONG[code - 0x11a8 + 1] };
  return { jamo: ch, cho: ch };
}

/**
 * 맞추기용 열쇠 — `jamo`는 자모로 푼 글자열, `cho`는 음절마다 초성만 남긴 글자열.
 * NFKC(전각 → 반각, 분해된 한글 → 음절)·소문자로 바꾼 뒤, 글자·숫자가 아닌 것(공백·기호·이모지)은 버립니다.
 */
export function searchKey(text: string): { jamo: string; cho: string } {
  let jamo = "";
  let cho = "";
  for (const ch of text.normalize("NFKC").toLowerCase()) {
    if (!LETTER_OR_DIGIT.test(ch)) continue;
    const key = jamoOf(ch);
    jamo += key.jamo;
    cho += key.cho;
  }
  return { jamo, cho };
}

// ------------------------------------------------------------------ 색인

/** 메뉴 항목(lib/nav navSearchItems — 이미 사용자에게 보이는 것만). */
export function menuEntries(items: readonly NavSearchItem[]): SearchEntry[] {
  return items.map((item) => ({
    kind: "menu",
    id: `menu:${item.href}`,
    label: item.label,
    sub: item.section === item.label ? null : item.section,
    href: item.href,
    dest: null,
    keywords: item.keywords,
    locked: item.locked,
    avatar: { tab: item.tab },
  }));
}

/** 매크로 카드(이름·티커). 같은 키가 두 범주에 있으면 처음 것만. 저장본이 없으면(available false) 비어 있습니다. */
export function indicatorEntries(overview: MacroOverview | null | undefined): SearchEntry[] {
  if (!overview?.available) return [];
  const seen = new Set<string>();
  const out: SearchEntry[] = [];
  for (const category of overview.categories ?? []) {
    for (const item of category.items) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      out.push({
        kind: "indicator",
        id: `indicator:${item.key}`,
        label: item.name,
        // 범주 제목은 수집기가 저장한 글이라 예전 그림 문자가 붙어 옵니다(화면에서만 뗌)
        sub: item.ticker ? `${withoutLeadingIcon(category.title)} · ${item.ticker}` : withoutLeadingIcon(category.title),
        href: indicatorHref(item.key),
        dest: DEST.indicator,
        keywords: [item.ticker, item.key].filter((word): word is string => Boolean(word)),
        avatar: { tab: "markets" },
      });
    }
  }
  return out;
}

/** /api/sec13f/institutions 응답 — 기관 화면의 선택 상자와 같은 목록. */
export type InstitutionList = { institutions: { key: string; name: string; cik: string; desc?: string | null }[] };

/** 13F 기관(이름·CIK·운용자 소개 — "달리오"로 브리지워터를 찾게). */
export function institutionEntries(list: InstitutionList | null | undefined): SearchEntry[] {
  return (list?.institutions ?? []).map((entry) => ({
    kind: "institution",
    id: `institution:${entry.cik}`,
    // 이름 앞 국기는 떼고 씁니다 — 결과 목록에서 이름이 같은 자리에서 시작하게(lib/format.withoutLeadingIcon)
    label: withoutLeadingIcon(entry.name),
    sub: `13F · CIK ${entry.cik}`,
    href: institutionHref(entry.cik),
    dest: DEST.institution,
    keywords: [entry.cik, entry.key, entry.desc].filter((word): word is string => Boolean(word)),
    avatar: { tab: "institutions" },
  }));
}

/** 스코어카드 유니버스 종목(이름·티커·섹터). 저장본이 없으면(available false) 비어 있습니다. */
export function tickerEntries(universe: StockUniverseResponse | null | undefined): SearchEntry[] {
  if (!universe?.available) return [];
  return universe.rows.map((row) => {
    const monogram = assetMonogram({ name: row.name, ticker: row.ticker });
    return {
      kind: "ticker",
      id: `ticker:${row.ticker}`,
      label: row.name,
      sub: row.sector ? `${row.ticker} · ${row.sector}` : row.ticker,
      href: tickerHref(row.ticker),
      dest: DEST.ticker,
      keywords: [row.ticker],
      avatar: monogram ? { text: monogram } : undefined,
    };
  });
}

type IndexedEntry = { entry: SearchEntry; order: number; keys: { jamo: string; cho: string }[] };

/** 검색 색인 — 열쇠를 한 번만 만들어 둡니다(글자를 칠 때마다 수백 개를 다시 풀지 않게). 첫 열쇠가 이름입니다. */
export type SearchIndex = readonly IndexedEntry[];

export function buildSearchIndex(entries: readonly SearchEntry[]): SearchIndex {
  return entries.map((entry, order) => ({
    entry,
    order,
    // 빈 열쇠(기호뿐인 말)도 자리를 지킵니다 — 비어 있으면 어떤 검색어와도 맞지 않고, 첫 자리가 이름이라는 규칙이 유지됩니다.
    keys: [entry.label, ...entry.keywords].map(searchKey),
  }));
}

// ------------------------------------------------------------------ 일치·순위

/** 단계 — 0 정확히 같음, 1 앞부분, 2 중간. 맞지 않으면 null. */
function tierOf(key: string, query: string): number | null {
  if (key === query) return 0;
  if (key.startsWith(query)) return 1;
  if (key.includes(query)) return 2;
  return null;
}

/** 작을수록 앞. 단계 × 2 + (이름이 아니라 다른 말로 맞으면 1). 초성 검색은 자모 일치와 같은 단계로 셉니다. */
function scoreOf(indexed: IndexedEntry, query: { jamo: string; cho: string }, consonantsOnly: boolean): number | null {
  let best: number | null = null;
  for (const [position, key] of indexed.keys.entries()) {
    const tiers = [tierOf(key.jamo, query.jamo), consonantsOnly ? tierOf(key.cho, query.jamo) : null];
    for (const tier of tiers) {
      if (tier === null) continue;
      const score = tier * 2 + (position === 0 ? 0 : 1);
      if (best === null || score < best) best = score;
    }
  }
  return best;
}

export type SearchGroup = {
  kind: SearchKind;
  label: string;
  /** 보이는 결과(상한까지). */
  items: SearchEntry[];
  /** 맞은 전체 수. */
  total: number;
  /** 상한 때문에 보이지 않는 수 — 0보다 크면 화면이 "N개 더"를 적습니다. */
  more: number;
};

/**
 * 검색어에 맞는 결과를 범주별로(범주 순서는 SEARCH_KINDS). 맞은 것이 없는 범주는 빠집니다. 검색어가 비면(공백·기호만 포함) 빈 목록.
 */
export function searchGroups(index: SearchIndex, rawQuery: string, perGroup: number = SEARCH_PER_GROUP): SearchGroup[] {
  const query = searchKey(rawQuery);
  if (!query.jamo) return [];
  const consonantsOnly = CONSONANTS_ONLY.test(query.jamo);

  const scored: { indexed: IndexedEntry; score: number }[] = [];
  for (const indexed of index) {
    const score = scoreOf(indexed, query, consonantsOnly);
    if (score !== null) scored.push({ indexed, score });
  }
  scored.sort((a, b) => a.score - b.score || a.indexed.order - b.indexed.order);

  return SEARCH_KINDS.flatMap(({ kind, label }) => {
    const matched = scored.filter((hit) => hit.indexed.entry.kind === kind).map((hit) => hit.indexed.entry);
    if (matched.length === 0) return [];
    const items = matched.slice(0, Math.max(0, perGroup));
    return [{ kind, label, items, total: matched.length, more: matched.length - items.length }];
  });
}

/**
 * 외부 검색 묶음 — GET /api/detail/symbols 결과(수집기가 Yahoo·네이버 자동완성을 합친 것)를 종목 상세로 가는 결과로. 이미 색인 묶음에 있는 주소는
 * 뺍니다(같은 종목이 두 번 보이지 않게). 결과가 없거나 응답이 없으면 null(묶음을 그리지 않음).
 *
 * @param shown 색인 묶음들(searchGroups) — 겹침을 빼려고 봅니다
 */
export function symbolGroup(
  response: DetailSymbolsResponse | null | undefined,
  shown: readonly SearchGroup[],
  perGroup: number = SEARCH_PER_GROUP,
): SearchGroup | null {
  const taken = new Set(shown.flatMap((group) => group.items.map((entry) => entry.href)));
  const seen = new Set<string>();
  const matched: SearchEntry[] = [];
  for (const symbol of response?.available ? (response.symbols?.items ?? []) : []) {
    const href = stockHref(symbol.market, symbol.code);
    if (taken.has(href) || seen.has(href)) continue;
    seen.add(href);
    const monogram = assetMonogram({ name: symbol.name, ticker: symbol.code });
    matched.push({
      kind: "symbol",
      id: `symbol:${symbol.market}:${symbol.code}`,
      label: symbol.name,
      sub: [symbol.code, symbol.exchange, kindText(symbol.kind), symbol.source].filter(Boolean).join(" · "),
      href,
      dest: DEST.ticker,
      keywords: [symbol.code],
      avatar: monogram ? { text: monogram } : undefined,
    });
  }
  if (matched.length === 0) return null;
  const items = matched.slice(0, Math.max(0, perGroup));
  return { kind: "symbol", label: SYMBOL_GROUP_LABEL, items, total: matched.length, more: matched.length - items.length };
}

/**
 * 화면 읽기용 결과 수 안내. 범주 상한 때문에 다 보이지 않으면 맞은 수와 보이는 수를 함께 적습니다 — 보이는 수만 말하면
 * 10건이 맞아도 "6건"으로 들립니다(범주 제목의 "N개 더"는 눈으로만 보임).
 *
 * @param notices 아직 다 읽지 못한 범주의 안내(`sourceNotice` — 읽는 중·실패·저장본 없음). 있으면 뒤에 붙입니다 — 색인이 덜 찬 동안의
 *                "결과 0건"은 맞는 것이 없다는 뜻이 아닙니다.
 */
export function resultSummary(groups: readonly SearchGroup[], notices: readonly string[] = []): string {
  const total = groups.reduce((sum, group) => sum + group.total, 0);
  const shown = groups.reduce((sum, group) => sum + group.items.length, 0);
  const count = shown < total ? `결과 ${total}건 중 ${shown}건 표시` : `결과 ${total}건`;
  return notices.length > 0 ? `${count} — ${notices.join(" · ")}` : count;
}

/**
 * 맞는 결과가 없을 때 보이는 글. 아직 다 읽지 못한 범주가 있으면(`notices`) "없다"고 단정하지 않습니다 — 그 범주의 이유는
 * 결과 아래 자료 상태 목록이 적습니다.
 */
export function noResultText(query: string, notices: readonly string[] = []): string {
  return notices.length > 0
    ? `‘${query}’와 맞는 결과가 아직 없습니다 — 일부 범주를 다 읽지 못했습니다(아래 안내).`
    : `‘${query}’와 맞는 결과가 없습니다.`;
}

/** 범주 하나의 자료 상태(useApi의 loading·error·data). */
export type SourceState = { loading: boolean; error: string | null; data: object | null };

/**
 * 범주가 왜 비었는지 — 아직 읽는 중·읽기 실패·저장본 없음(available false)이면 한 줄, 자료가 있으면 null.
 * 비어 있는 범주를 조용히 빼면 "그런 종목이 없다"로 읽히므로 이유를 결과 아래에 적습니다.
 */
export function sourceNotice(label: string, state: SourceState): string | null {
  if (state.error) return `${label}: 불러오지 못했습니다 — ${state.error}`;
  if (state.loading && !state.data) return `${label}: 불러오는 중…`;
  // 기관 목록처럼 available을 보내지 않는 응답은 자료가 있는 것으로 봅니다.
  const data = state.data as { available?: unknown; message?: unknown } | null;
  if (data && data.available === false) {
    return `${label}: ${typeof data.message === "string" && data.message ? data.message : "저장본이 아직 없습니다"}`;
  }
  return null;
}

/**
 * 종목 찾기(외부 검색)의 자료 상태 — {@link sourceNotice}에 더해 200 응답 안의 출처 실패도 적습니다(QA-256). 수집기는 출처마다 실패를
 * `symbols.errors`에 남기고 받은 것만 돌려주며(검색·상세 명세 §2), 결과가 0건이고 실패한 출처가 하나라도 있으면 `symbols.error`를 채웁니다
 * (모든 출처가 실패했다는 뜻은 아님). 그때 '맞는 결과가 없습니다'로 단정하지 않게 받지 못한 출처 이름을 적습니다. 원문 오류(프록시·연결 오류
 * 문구)는 길어서 이름만 적습니다.
 */
export function symbolNotice(state: SourceState): string | null {
  const base = sourceNotice(SYMBOL_GROUP_LABEL, state);
  if (base) return base;
  const symbols = (state.data as DetailSymbolsResponse | null)?.symbols;
  const failed = Object.keys(symbols?.errors ?? {});
  if (symbols?.error) {
    return `${SYMBOL_GROUP_LABEL}: 출처를 받지 못했습니다${failed.length > 0 ? `(${failed.join("·")})` : ` — ${symbols.error}`}`;
  }
  if (failed.length > 0) return `${SYMBOL_GROUP_LABEL}: 일부 출처를 받지 못했습니다(${failed.join("·")})`;
  return null;
}

/** 정보 검색 화면(ADR 0041)의 검색어 상한 — 넘으면 앞부분만 넘깁니다. */
const INFO_SEARCH_MAX = 60;

/**
 * 통합 검색 결과 맨 아래의 '‘검색어’ 정보 검색' 행 — 같은 검색어로 정보 검색 화면(/search?q=, 대상 후보 보기)으로 갑니다. 메뉴·지표·종목 결과와
 * 따로 두는 바닥 줄이라 결과 수·'맞는 결과가 없습니다'에는 세지 않습니다. 검색어가 비었거나 그 화면이 보이지 않는 사용자면 null.
 */
export function infoSearchEntry(query: string, user: SessionUser | null | undefined): { label: string; href: string } | null {
  const trimmed = Array.from(query.trim()).slice(0, INFO_SEARCH_MAX).join("").trim();
  if (!trimmed || visibleMenus([{ href: "/search" }], user).length === 0) return null;
  return { label: `‘${trimmed}’ 정보 검색`, href: searchHref({ q: trimmed }) };
}
