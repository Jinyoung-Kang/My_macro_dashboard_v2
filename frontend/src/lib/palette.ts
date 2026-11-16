/**
 * 명령 팔레트(통합 검색 SearchCommand를 넓힌 것 — 작업대 실행 명세 §5, P3)의 범주 가운데 lib/search 밖의 것 — React를 모르는 순수 함수(ADR 0004).
 *
 * - 최근 연 대상: 팔레트에서 고른 지표·기관·종목(종목 찾기 포함)을 이 브라우저에만(localStorage) 최신 순 8개 기억합니다. 넓은 화면에서 검색어가 빌
 *   때만 보입니다(좁은 화면은 지금 통합 검색 그대로 — 실행 명세 §0 W2).
 *   메뉴는 넣지 않습니다(메뉴는 왼쪽 메뉴·탭에 늘 있음). 저장값은 읽을 때 형식을 다시 검사합니다 — 종류 넷, 주소는 상세 화면 세 경로뿐이고
 *   lib/detail의 parse 함수로 다시 풀어 만든 주소만 씁니다. 저장소 값이 바뀌어도(다른 확장·사람이 고침) 다른 주소(javascript: 등)로 보내지 않습니다.
 *   공개 시세 대상의 이름·티커만 담깁니다(실제 계좌 자료 없음).
 * - 명령: 닫힌 목록(PALETTE_COMMANDS) — 단축키 도움말, 왼쪽 메뉴 접기·펼치기. 둘 다 넓은 화면에서만 보입니다(wideOnly — 명령 팔레트는 넓은 화면
 *   항목, 실행 명세 §0 W2). 효과는 셸 명령(lib/shellCommands) 하나뿐이라 서버를 부르는
 *   효과가 타입에 없습니다. 데이터 새로고침·결정 실행·계좌 초기화·일시정지·실제 매매 켜기·끄기·설정 저장 같은 쓰기 동작은 팔레트에 넣지 않습니다
 *   (ADR 0042 결정 5, 실행 명세 §5·§9-6 — components/shell/__tests__/paletteNoWrites.test.tsx가 지킴). 묶음 이름은 '명령'입니다('동작'은 화면 머리의
 *   쓰기 동작 영역 이름). 검색어가 맞을 때만 보입니다(빈 검색어에는 없음).
 */
import { indicatorHref, institutionHref, parseCik, parseIndicatorKey, parseStockRoute, stockHref } from "./detail";
import { assetMonogram } from "./patternRows";
import { searchKey, type SearchAvatar, type SearchEntry, type SearchGroup } from "./search";
import type { ShellCommand } from "./shellCommands";

// ------------------------------------------------------------------ 명령

/** 명령 묶음 이름. */
export const COMMAND_GROUP_LABEL = "명령";

/** 명령의 효과 — 셸 명령 하나(이 창 안의 화면 상태만 바꿈). 다른 종류(서버 호출)는 타입에 없습니다. */
export type PaletteCommandEffect = { type: "shell"; command: ShellCommand };

export type PaletteCommand = {
  id: "command:shortcut-help" | "command:toggle-nav";
  label: string;
  /** 같은 일을 하는 단축키(결과 줄 보조 글). */
  keys: string;
  /** 이름 말고도 맞추는 말 — 기호 하나('?'·'[')는 검색어가 그 기호 그대로일 때 맞습니다. */
  keywords: readonly string[];
  effect: PaletteCommandEffect;
  /** 넓은 화면(왼쪽 메뉴가 보이는 폭)에서만 보입니다 — 지금은 모든 명령(좁은 화면 팔레트는 지금 통합 검색 그대로). */
  wideOnly?: true;
};

/** 명령 목록(닫힌 목록). */
export const PALETTE_COMMANDS: readonly PaletteCommand[] = [
  {
    id: "command:shortcut-help",
    label: "단축키 도움말",
    keys: "?",
    keywords: ["단축키", "키보드", "도움말", "shortcut", "help", "?"],
    effect: { type: "shell", command: "open-shortcut-help" },
    wideOnly: true,
  },
  {
    id: "command:toggle-nav",
    label: "왼쪽 메뉴 접기·펼치기",
    keys: "[",
    keywords: ["메뉴 접기", "메뉴 펼치기", "사이드바", "레일", "["],
    effect: { type: "shell", command: "toggle-nav" },
    wideOnly: true,
  },
];

const CONSONANTS_ONLY = /^[ㄱ-ㅎ]+$/u;

/**
 * 검색어에 맞는 명령(목록 순서). 메뉴 검색과 같은 규칙 — lib/search `searchKey`로 이름·검색어를 자모로 풀어 맞추고(입력 중인 글자 포함),
 * 자음만 치면 초성으로 맞춥니다. 기호뿐인 검색어('?'·'[')는 그 기호를 검색어로 가진 명령과 맞습니다. 검색어가 비면 빈 목록, 넓은 화면이 아니면
 * wideOnly 명령을 뺍니다.
 */
export function commandMatches(query: string, { wide }: { wide: boolean }): PaletteCommand[] {
  const raw = query.trim();
  if (!raw) return [];
  const key = searchKey(raw);
  const consonantsOnly = CONSONANTS_ONLY.test(key.jamo);
  return PALETTE_COMMANDS.filter((command) => {
    if (command.wideOnly && !wide) return false;
    if (command.keywords.includes(raw)) return true;
    if (!key.jamo) return false;
    return [command.label, ...command.keywords].some((word) => {
      const target = searchKey(word);
      return (target.jamo !== "" && target.jamo.includes(key.jamo)) || (consonantsOnly && target.cho.includes(key.jamo));
    });
  });
}

/**
 * 화면 읽기용 결과 수 안내 — lib/search `resultSummary`와 같은 글에 명령 수를 더합니다(명령은 상한 없이 모두 보임).
 * 범주 상한 때문에 다 보이지 않으면 맞은 수와 보이는 수를 함께, 아직 다 읽지 못한 범주가 있으면 그 안내를 뒤에 붙입니다.
 */
export function paletteSummary(groups: readonly SearchGroup[], commandCount: number, notices: readonly string[] = []): string {
  const total = groups.reduce((sum, group) => sum + group.total, 0) + commandCount;
  const shown = groups.reduce((sum, group) => sum + group.items.length, 0) + commandCount;
  const count = shown < total ? `결과 ${total}건 중 ${shown}건 표시` : `결과 ${total}건`;
  return notices.length > 0 ? `${count} — ${notices.join(" · ")}` : count;
}

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

/**
 * 화면 읽기용 최근 연 대상 안내(입력칸 설명 — aria-describedby). 빈 검색어에 최근 연 대상이 펼쳐지면 빈 Enter가 맨 위 대상으로 가므로 목록이
 * 있다는 것과 고르는 법을 알립니다(QA-560). 결과 수 안내(role=status)는 검색어가 있을 때만이라 따로 둡니다.
 */
export function recentSummary(count: number): string {
  return `최근 연 대상 ${count}건 — ↑↓로 고르고 Enter로 갑니다`;
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
