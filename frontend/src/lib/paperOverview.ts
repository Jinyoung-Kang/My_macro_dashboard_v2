/**
 * 모의매매(미국) 개요의 새 패턴(설계서 §7 — 네 계좌 행 + 기간별 순자산 차트 + 계좌 비교 표)에 쓰는 표시 규칙. 순수 함수(ADR 0004).
 *
 * 숫자·서식은 lib/paper.ts의 bookCard·statCells·sampleNote를 그대로 씁니다 — 카드에 있던 칸을 행·표로 옮길 뿐, 새 숫자를 만들지 않습니다.
 * 개요 응답에 없는 값(예: 출발 이후 변화 금액)은 계산해 넣지 않습니다.
 */
import { deltaColor, EMPTY, formatKst, formatNumber } from "./format";
import { accountProfile, benchmarkLabel, bookCard, isTimedBook, type NavSeriesLine, primaryClaudeBook, statCells } from "./paper";
import { marketMeta, type PaperMarketCode } from "./paperMarket";
import type { PaperBookSummary, PaperOverviewResponse, PaperQuotesSummary } from "./types";

// ---------------------------------------------------------------- 계좌 행(AssetRow)

/** 계좌 행이 개요에서 함께 읽는 것 — 사후 체결 대기 목록과 장부 관측치 신선도, 그 개요의 시장(기본 미국). */
export interface BookRowContext {
  pendingBackfill?: readonly string[] | null;
  quotes?: Pick<PaperQuotesSummary, "stale"> | null;
  /**
   * 그 개요의 시장. 한국("KR")이면 순자산을 원 단위 정수로 적고, 사후 체결 대기 경고를 달지 않습니다 — 한국 네 계좌는 S+1 시가에 함께
   * 출발하고 초기화를 다시 눌러 체결하지 않습니다(명세 §2·K28, API.md 개요 행 — 한국 `pendingBackfill`은 '시작 전 벤치마크'일 뿐).
   */
  market?: PaperMarketCode;
}

/** 사후 체결을 기다리는 벤치마크 행의 경고(초기화 카드가 사유와 다시 누를 단추를 보입니다). */
export const PENDING_BACKFILL_WARNING = "출발일 종가 대기 — 사후 체결 전(현금만)";

/**
 * 계좌 행 자료 — `AssetRowData`(components/patterns/AssetRow.tsx)의 부분집합이라 그대로 넘깁니다(lib는 components를 가져오지 않음,
 * lib/patternRows.ts의 AssetRowFlags와 같은 방식).
 */
export interface BookRow {
  id: string;
  name: string;
  sub: string;
  value: number | null;
  /** 서식된 값 — 한국 계좌만(원 단위 정수, 모르면 null → "—"). 미국 행에는 이 칸이 없어 자산 행이 value를 소수 둘째 자리로 찍습니다. */
  valueText?: string | null;
  unit: string;
  changePct: number | null;
  isStale: boolean;
  staleReason: string | null;
  warning: string | null;
}

/**
 * 계좌 하나 → 자산 행. 이름 · 보조(종류 · 상태 · 한 줄 소개) · 순자산(달러) · 출발 이후 수익률 칩 · 배지.
 *
 * - 순자산을 모르면 "—"(단위 없음), 수익률을 모르면 칩을 생략합니다(0.00%를 만들지 않음 — AssetRow 규칙).
 * - 이전 값 배지: 가격을 새로 받지 못한 보유가 있거나(staleCount > 0 — 지난 값으로 평가), 장부 관측치 저장본이 늦었으면
 *   (quotes.stale — 서버 판정) 시작한 계좌의 순자산은 그 늦은 관측으로 평가한 값입니다. 사유를 함께 적습니다.
 * - 경고: 벤치마크가 출발일 종가를 기다리면(pendingBackfill) 그 사실. 추정 배지는 없습니다(장부 값은 추정이 아님).
 */
export function bookAssetRow(book: PaperBookSummary, context: BookRowContext = {}): BookRow {
  const market = context.market ?? "US";
  const card = bookCard(book, [], market);
  const summary = accountProfile(book.code)?.summary ?? null;
  const staleReasons = [
    card.staleWarning,
    context.quotes?.stale === true && book.lastObservedAtKst ? `관측치 저장본이 늦음 · 마지막 관측 ${formatKst(book.lastObservedAtKst)}` : null,
  ].filter((reason): reason is string => reason !== null);
  const korea = market === "KR";
  const nav = korea ? formatNumber(book.nav, 0) : null;
  return {
    id: book.code,
    name: book.label,
    sub: [card.kind, card.status.label, summary].filter((part) => part && part !== EMPTY).join(" · "),
    value: book.nav,
    ...(korea ? { valueText: nav === EMPTY ? null : nav } : {}),
    unit: marketMeta(market).unitLabel,
    changePct: book.returnPct,
    isStale: staleReasons.length > 0,
    staleReason: staleReasons.length > 0 ? staleReasons.join(" · ") : null,
    warning: !korea && (context.pendingBackfill ?? []).includes(book.code) ? PENDING_BACKFILL_WARNING : null,
  };
}

/**
 * 계좌 숫자(순자산·출발 이후 수익률)의 기준 시각 — 계좌들의 마지막 관측 시각 중 가장 늦은 것을 "yyyy-MM-dd HH:mm"으로. 네 계좌는 같은
 * 리스크 점검에서 함께 평가돼 보통 하나입니다. 아무도 모르면 null(시각을 짐작하지 않음).
 */
export function latestObserved(books: readonly PaperBookSummary[]): string | null {
  const stamps = books.map((book) => book.lastObservedAtKst).filter((stamp): stamp is string => typeof stamp === "string" && stamp !== "");
  if (stamps.length === 0) return null;
  const latest = stamps.reduce((a, b) => (b > a ? b : a));
  const shown = formatKst(latest);
  return shown === EMPTY ? null : shown;
}

// ---------------------------------------------------------------- 계좌 비교 표(DataTable, 행 = 항목 · 열 = 계좌)

/** 비교 표 칸 하나 — 글과(있으면) 글자색 클래스. 값을 모르면 글은 "—"이고 색은 없습니다. */
export interface ComparisonCell {
  text: string;
  className: string | null;
}

/** 비교 표의 한 줄(항목 하나). `cells`는 계좌 코드 → 칸. */
export interface ComparisonRow {
  key: string;
  label: string;
  /** 상태 줄은 배지로 그립니다(글자색이 아니라 테두리·바탕이 있는 배지 클래스). */
  badge?: boolean;
  cells: Record<string, ComparisonCell>;
}

const plain = (text: string): ComparisonCell => ({ text, className: null });
const toned = (text: string, className: string | null): ComparisonCell => ({ text, className: text === EMPTY ? null : className });

/** 가격 없음 칸 — 모르면 "—", 0이면 "없음", 있으면 경고색 "N종목 — 지난 값으로 평가". */
function staleCell(book: PaperBookSummary): ComparisonCell {
  const count = book.staleCount;
  if (count === null || count === undefined || !Number.isFinite(count)) return plain(EMPTY);
  if (count <= 0) return plain("없음");
  return toned(`${formatNumber(count, 0)}종목 — 지난 값으로 평가`, "text-warn");
}

/**
 * 계좌 비교 표 — 예전 계좌 카드 네 장의 칸을 항목별 줄로 모읍니다(상태·종류·출발·처음 현금·순자산·수익률·노출·현금·보유 수·
 * 마지막 관측·가격 없음·통계 일곱 칸·비교 기준). 값은 bookCard·statCells의 표시 글 그대로("—" 포함). 표본 설명은 문장이라 표 밖
 * (`sampleNotes`)에 둡니다.
 *
 * 초과 수익률·베타의 비교 기준은 계좌마다 다를 수 있어(SPY 계좌 자신은 기준 없음) 항목 이름에 적지 않고 "비교 기준" 줄로 따로 둡니다.
 * 돈 칸은 그 개요 시장의 통화입니다(`market` — 기본 미국 달러, 한국은 원 정수).
 */
export function accountComparisonRows(books: readonly PaperBookSummary[], market: PaperMarketCode = "US"): ComparisonRow[] {
  const cards = books.map((book) => ({ book, card: bookCard(book, books, market) }));
  const row = (key: string, label: string, cell: (entry: (typeof cards)[number]) => ComparisonCell, badge = false): ComparisonRow => ({
    key,
    label,
    badge,
    cells: Object.fromEntries(cards.map((entry) => [entry.book.code, cell(entry)])),
  });
  // 항목 이름은 비교 기준 없는 통계 칸 이름(같은 순서) — 값은 계좌마다 bookCard.stats에서 같은 key로 찾습니다.
  const statRows = statCells(null, null).map((stat) =>
    row(`stat-${stat.key}`, stat.label, ({ card }) => {
      const value = card.stats.find((cell) => cell.key === stat.key)?.value ?? EMPTY;
      return plain(value);
    }),
  );
  return [
    row("status", "상태", ({ card }) => ({ text: card.status.label, className: card.status.className }), true),
    row("kind", "종류", ({ card }) => plain(card.kind)),
    row("startedOn", "출발", ({ card }) => plain(card.startedOn)),
    row("initialCash", "처음 현금", ({ card }) => plain(card.initialCash)),
    row("nav", "순자산", ({ card }) => plain(card.nav)),
    row("returnPct", "수익률(출발 이후)", ({ book, card }) => toned(card.returnPct, deltaColor(book.returnPct))),
    row("exposure", "주식 노출", ({ card }) => plain(card.exposure)),
    row("cash", "현금", ({ card }) => plain(card.cash)),
    row("positions", "보유", ({ card }) => plain(card.positions)),
    row("lastObserved", "마지막 관측", ({ card }) => plain(card.lastObserved)),
    row("stale", "가격 없음", ({ book }) => staleCell(book)),
    ...statRows,
    row("benchmark", "비교 기준", ({ book }) => plain(benchmarkLabel(book, books) ?? EMPTY)),
  ];
}

/** 계좌마다의 표본 설명(sampleNote) — 표 아래 목록. 순서는 계좌 순서. */
export function sampleNotes(books: readonly PaperBookSummary[]): { code: string; label: string; text: string }[] {
  return books.map((book) => ({ code: book.code, label: book.label, text: bookCard(book, books).sample }));
}

// ---------------------------------------------------------------- 기간별 순자산 곡선

/** 순자산 곡선의 기간 탭. `months`가 null이면 전체(저장된 순자산 기록 전부). */
export const NAV_RANGES = [
  { key: "1m", label: "1개월", months: 1 },
  { key: "3m", label: "3개월", months: 3 },
  { key: "6m", label: "6개월", months: 6 },
  { key: "1y", label: "1년", months: 12 },
  { key: "all", label: "전체", months: null },
] as const;

export type NavRangeKey = (typeof NAV_RANGES)[number]["key"];

/** "YYYY-MM-DD"에서 n개월 전 날짜(같은 날, 그 달에 없으면 그 달 마지막 날). 날짜 꼴이 아니면 null. */
export function monthsBefore(date: string, months: number): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1 - months;
  const target = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(Number(match[3]), lastDay));
  return target.toISOString().slice(0, 10);
}

/** 기간의 첫 날짜(이 날 이후 기록만 그림). 전체·기록 없음은 null. */
function rangeStart(dates: readonly string[], range: NavRangeKey): string | null {
  const spec = NAV_RANGES.find((entry) => entry.key === range);
  const last = dates[dates.length - 1];
  if (!spec || spec.months === null || !last) return null;
  return monthsBefore(last, spec.months);
}

/**
 * 고를 수 있는 기간 — 저장된 기록이 그 기간보다 길 때만(기간이 기록 전부와 같으면 "전체"와 같은 탭이 둘이 됨). "전체"는 늘 있습니다.
 * 저장 구간을 넘는 기간 탭은 그리지 않습니다(PRINCIPLES "기간 탭은 저장 구간을 넘지 않음").
 */
export function navRangeKeys(navSeries: PaperOverviewResponse["navSeries"]): NavRangeKey[] {
  const dates = Array.isArray(navSeries?.dates) ? navSeries.dates : [];
  const first = dates[0];
  return NAV_RANGES.filter((range) => {
    if (range.months === null) return true;
    const start = rangeStart(dates, range.key);
    return first !== undefined && start !== null && first < start;
  }).map((range) => range.key);
}

/**
 * 고른 기간만 남긴 순자산 기록 — 날짜와 계좌별 값 배열을 같은 자리에서 자릅니다(값은 건드리지 않음, null도 그대로).
 * 전체·모르는 기간·기록 없음은 받은 그대로 돌려줍니다.
 */
export function navSeriesWindow(
  navSeries: PaperOverviewResponse["navSeries"],
  range: NavRangeKey,
): PaperOverviewResponse["navSeries"] {
  if (!navSeries || !Array.isArray(navSeries.dates) || !navSeries.books) return navSeries;
  const start = rangeStart(navSeries.dates, range);
  if (start === null) return navSeries;
  const from = navSeries.dates.findIndex((date) => date >= start);
  if (from <= 0) return navSeries;
  const books = Object.fromEntries(
    Object.entries(navSeries.books).map(([code, values]) => [code, Array.isArray(values) ? values.slice(from) : values]),
  );
  return { dates: navSeries.dates.slice(from), books };
}

/**
 * 차트 세로선(프레임 경계) 중 고른 기간 안의 날짜만 — 범주 축이라 기간 밖 날짜의 선은 그려지지 않으므로 미리 뺍니다.
 * 경계 한 줄 글은 전체 기록 기준 그대로 둡니다(기간 밖의 경계를 '그날 기록 없음'으로 적지 않게 — 여기서 다루지 않음).
 * 기간 기록이 없으면 빈 목록.
 */
export function markersInWindow<M extends { x: string }>(
  markers: readonly M[],
  navWindow: PaperOverviewResponse["navSeries"],
): M[] {
  const dates = new Set(Array.isArray(navWindow?.dates) ? navWindow.dates : []);
  return markers.filter((marker) => dates.has(marker.x));
}

// ---------------------------------------------------------------- 🧪 같은 구간 순자산(S = 100, 계좌2 명세 §4-2의 2)

/** "S = 100 같은 구간" 보기 — 계좌2 출발일 S를 기준일로, 계좌1·계좌2·비교 기준(SPY 계좌)의 순자산을 S = 100으로 다시 잰 선. */
export interface SameWindowView {
  /** 기준일 S(계좌2 출발일 — 미국 동부 세션 날짜). */
  baseDate: string;
  rows: Record<string, string | number | null>[];
  series: NavSeriesLine[];
  /** 마지막 날 한 줄("2026-11-20 — Claude 계좌1 101.2 · Claude 계좌2 99.8 · SPY 계좌 100.5"). 줄이 없으면 null. */
  latest: string | null;
  /** 기준일에 순자산 기록이 없어 그리지 못한 계좌 이름(선 없음 — 100으로 채우지 않음). */
  missingBase: string[];
}

/**
 * 계좌2 출발일 S부터 마지막 날까지, 계좌1·계좌2·계좌2의 비교 기준(SPY 계좌)을 각자의 S 순자산으로 나눠 100에 맞춘 선(PRINCIPLES '기준일을 100으로' —
 * 서술용, 판정에 쓰지 않음). 값은 개요 순자산 곡선의 값 그대로를 나눈 것뿐이고 반올림하지 않습니다(표시는 차트 자릿수). 그날 기록이 없는 계좌는 그날만
 * null, S에 기록이 없는 계좌는 선 전체가 null입니다 — S 이전 구간은 계좌2 값이 없어(출발 전) 그리지 않습니다.
 *
 * 계좌2가 없거나 아직 출발하지 않았거나(출발일 없음) 출발일이 순자산 곡선 날짜에 없으면 null.
 */
export function sameWindowIndex(
  navSeries: PaperOverviewResponse["navSeries"],
  books: readonly PaperBookSummary[],
): SameWindowView | null {
  const book2 = books.find((book) => isTimedBook(book.code));
  if (!book2?.startedOn || !navSeries || !Array.isArray(navSeries.dates) || !navSeries.books) return null;
  const from = navSeries.dates.indexOf(book2.startedOn);
  if (from < 0) return null;
  const book1 = primaryClaudeBook(books);
  const picked = [book1, book2, books.find((book) => book.code === book2.benchmark)]
    .filter((book): book is PaperBookSummary => book !== undefined && book !== null);
  const dates = navSeries.dates.slice(from);
  const missingBase: string[] = [];
  const scaled = picked.map((book) => {
    const values = Array.isArray(navSeries.books[book.code]) ? navSeries.books[book.code] : [];
    const base = values[from];
    const usable = typeof base === "number" && Number.isFinite(base) && base > 0;
    if (!usable) missingBase.push(book.label);
    return dates.map((_, offset) => {
      const value = values[from + offset];
      return usable && typeof value === "number" && Number.isFinite(value) ? (value / base) * 100 : null;
    });
  });
  const rows = dates.map((date, index) => {
    const row: Record<string, string | number | null> = { date };
    picked.forEach((book, which) => {
      row[book.code] = scaled[which][index];
    });
    return row;
  });
  const last = rows.at(-1) ?? null;
  return {
    baseDate: book2.startedOn,
    rows,
    series: picked.map((book) => ({ key: book.code, name: book.label })),
    latest: last
      ? `${String(last.date)} — ${picked.map((book) => `${book.label} ${formatNumber(last[book.code] as number | null, 1)}`).join(" · ")}`
      : null,
    missingBase,
  };
}
