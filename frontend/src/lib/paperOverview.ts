/**
 * 모의매매(미국) 개요의 새 패턴(설계서 §7 — 네 계좌 행 + 기간별 순자산 차트 + 계좌 비교 표)에 쓰는 표시 규칙. 순수 함수(ADR 0004).
 *
 * 숫자·서식은 lib/paper.ts의 bookCard·statCells·sampleNote를 그대로 씁니다 — 카드에 있던 칸을 행·표로 옮길 뿐, 새 숫자를 만들지 않습니다.
 * 개요 응답에 없는 값(예: 출발 이후 변화 금액)은 계산해 넣지 않습니다.
 */
import { deltaColor, EMPTY, formatKst, formatNumber, formatPercent, formatWithUnit } from "./format";
import { accountProfile, benchmarkLabel, bookCard, isTimedBook, type NavSeriesLine, primaryClaudeBook, statCells } from "./paper";
import type { LineRow, LineSeriesSpec, ScrubEstimate } from "./lineChart";
import {
  clockText,
  type ComparisonBasis,
  comparisonBasis,
  type CurrentView,
  currentSource,
  currentView,
  type DayChange,
  dayBaseText,
  dayLabel,
  isLiveStage,
  monthDay,
  stageLabel,
  stampText,
} from "./paperCurrent";
import { formatMoney, marketMeta, type PaperMarketCode } from "./paperMarket";
import type {
  PaperBookSummary,
  PaperLiveSessionSummary,
  PaperNavEstimate,
  PaperOverviewBook,
  PaperOverviewResponse,
  PaperQuotesSummary,
} from "./types";

// ---------------------------------------------------------------- 계좌 행(AssetRow)

/** 계좌 행이 개요에서 함께 읽는 것 — 사후 체결 대기 목록과 장부 관측치 신선도, 그 개요의 시장(기본 미국)과 장 상태. */
export interface BookRowContext {
  pendingBackfill?: readonly string[] | null;
  quotes?: Pick<PaperQuotesSummary, "stale"> | null;
  /**
   * 그 개요의 시장. 한국("KR")이면 순자산을 원 단위 정수로 적고, 사후 체결 대기 경고를 달지 않습니다 — 한국 네 계좌는 S+1 시가에 함께
   * 출발하고 초기화를 다시 눌러 체결하지 않습니다(명세 §2·K28, API.md 개요 행 — 한국 `pendingBackfill`은 '시작 전 벤치마크'일 뿐).
   */
  market?: PaperMarketCode;
  /** 개요의 장 상태(`liveSession`) — 지금 값의 '오늘'·장부 표기 날짜를 가릅니다(lib/paperCurrent). 옛 응답이면 없음. */
  session?: PaperLiveSessionSummary | null;
}

/** 사후 체결을 기다리는 벤치마크 행의 경고(초기화 카드가 사유와 다시 누를 단추를 보입니다). */
export const PENDING_BACKFILL_WARNING = "출발일 종가 대기 — 사후 체결 전(현금만)";

/** 계좌 아바타의 약칭 — 미국·한국 책의 계좌 코드마다(계좌 이름의 머리글자·벤치마크 종목). */
const BOOK_MONOGRAMS: ReadonlyMap<string, string> = new Map([
  ["rules", "R"],
  ["claude", "C1"],
  ["claude2", "C2"],
  ["bench_spy", "SPY"],
  ["bench_mix", "60"],
  ["kr_rules", "R"],
  ["kr_claude", "C"],
  ["kr_bench_k200", "200"],
  ["kr_bench_mix", "60"],
]);

/**
 * 계좌 행 아바타의 모노그램(명세 §4 Avatar). 모르는 계좌 코드면 null — 짐작한 글자를 만들지 않고 아바타 칸을 그리지 않습니다.
 * 장식이라 뜻은 행 이름(계좌 이름)이 나릅니다.
 */
export function bookMonogram(code: string): string | null {
  return BOOK_MONOGRAMS.get(code) ?? null;
}

/**
 * 계좌 행 자료 — `AssetRowData`(components/patterns/AssetRow.tsx)의 부분집합이라 그대로 넘깁니다(lib는 components를 가져오지 않음,
 * lib/patternRows.ts의 AssetRowFlags와 같은 방식).
 */
export interface BookRow {
  id: string;
  name: string;
  /** 아바타 약칭(`bookMonogram` — 모르는 계좌면 null, 아바타 없음). 장식이라 뜻은 이름이 나릅니다. 개요·홈이 같이 씁니다. */
  avatarText: string | null;
  sub: string;
  value: number | null;
  /** 서식된 값 — 한국 계좌만(원 단위 정수, 모르면 null → "—"). 미국 행에는 이 칸이 없어 자산 행이 value를 소수 둘째 자리로 찍습니다. */
  valueText?: string | null;
  unit: string;
  changePct: number | null;
  isStale: boolean;
  staleReason: string | null;
  warning: string | null;
  /** 지금 값이 장중 추정인가 — 지금 값이 있는 응답에서만 있는 칸(옛 응답의 행은 예전 모양 그대로). */
  isEstimated?: boolean;
  /** 값의 기준 한 줄(단계 표기 · 덧붙임 · 변화 한 줄) — 지금 값이 있는 응답에서만, 출발 전 계좌는 null. */
  caption?: string | null;
}

/** 행의 값의 기준 한 줄 — 단계 표기 · 짧은 덧붙임 · 변화 한 줄. 옛 응답·출발 전 계좌(보조 글이 '시작 전'을 말함)는 null. */
function rowCaption(view: CurrentView, book: PaperBookSummary): string | null {
  if (view.from !== "current" || book.status === "NOT_STARTED") return null;
  const parts = [view.stageLabel, ...view.notes, view.day?.text ?? null].filter((part): part is string => typeof part === "string" && part !== "");
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** 이전 값 배지 — 있으면 사유를 함께(숨기는 옵션 없음). */
export interface BookStale {
  isStale: boolean;
  reason: string | null;
}

/**
 * 계좌 값의 이전 값 배지 — 보이는 값이 장부 관측에서 나왔을 때만 장부 상태의 사유(가격을 새로 받지 못한 보유 `staleCount` · 관측치 저장본이 늦음
 * `quotes.stale`)를 답니다. 시작한 계좌만(관측이 없는 시작 전 계좌는 늦은 관측으로 평가한 값이 아님).
 *
 * - 옛 응답(지금 값 없음)·지금 값의 장부 단계(`LEDGER`): 값이 그 장부 상태라 사유 그대로.
 * - 장중 추정(`LIVE`·`LIVE_LAST`): 장중가가 없어 장부 관측가로 평가한 종목이 있고 장부 사유가 있을 때만 — '장중가 없는 n종목은 장부 관측가 · …'.
 *   모든 보유를 장중가로 평가했으면 배지 없음(그 값은 늦은 관측으로 평가한 값이 아님).
 * - 순자산 줄(`PROVISIONAL`·`FINAL`): 그 거래일 마감 값이라 장부 관측과 무관 — 배지 없음(예전에는 '10-30 잠정' 옆에 그보다 이른 관측이 '이전 값'으로 붙음).
 * - 모르는 단계(새 서버 값): 장부 사유 그대로(배지를 숨기는 쪽으로 짐작하지 않음).
 *
 * `place`가 "hero"면 그 자리가 장부 관측 시각을 단계 표기로 이미 적으므로(옛 응답 '마지막 관측 …'·장부 단계 '장부 …') 사유의 '· 마지막 관측 …'을
 * 뺍니다 — 같은 시각을 한 줄에 두 번 적지 않게. 행("row")은 장부 단계일 때만(값의 기준 한 줄에 '장부 …'가 있음) 뺍니다.
 */
export function bookStale(book: PaperOverviewBook, context: BookRowContext = {}, place: "row" | "hero" = "row"): BookStale {
  const market = context.market ?? "US";
  const view = currentView(book, { market, session: context.session });
  const stage = book.current?.stage ?? null;
  const started = book.status !== "NOT_STARTED";
  const observedShown = view.from === "ledger"
    ? place === "hero" && view.stageLabel !== null
    : stage === "LEDGER" && started;
  const observed = book.lastObservedAtKst;
  const ledger = [
    bookCard(book, [], market).staleWarning,
    context.quotes?.stale === true && observed
      ? observedShown ? "관측치 저장본이 늦음" : `관측치 저장본이 늦음 · 마지막 관측 ${formatKst(observed)}`
      : null,
  ].filter((reason): reason is string => reason !== null);
  let reasons = ledger;
  if (view.from === "current" && book.current) {
    if (isLiveStage(stage)) {
      const fallback = book.current.positionCount - book.current.livePriced;
      reasons = fallback > 0 && ledger.length > 0 ? [`장중가 없는 ${fallback}종목은 장부 관측가`, ...ledger] : [];
    } else if (stage === "PROVISIONAL" || stage === "FINAL") {
      reasons = [];
    }
  }
  return { isStale: reasons.length > 0, reason: reasons.length > 0 ? reasons.join(" · ") : null };
}

/**
 * 계좌 하나 → 자산 행. (아바타 약칭) · 이름 · 보조(종류 · 상태 · 한 줄 소개) · 순자산(달러) · 출발 이후 수익률 칩 · 배지.
 * 아바타 고리 색(차트 계열 색과 같은 계좌 색)은 화면이 붙입니다(색 표는 components/screens/paper/bookColors — lib는 components를 가져오지 않음).
 *
 * - 순자산·수익률은 개요의 지금 값(`current` — lib/paperCurrent `currentView`)이고, 지금 값이 없는 옛 응답은 장부 값 그대로입니다.
 *   지금 값이면 값의 기준 한 줄(`caption` — 단계 표기 '장중 추정 23:58'·덧붙임 '장중가 1/2종목'·'체결 대기 1건 반영 전'·변화 한 줄
 *   '오늘 +0.42% · 10-29 잠정 대비'·'10-30 변화 -1.54% · 10-23 확정 대비')과, 장중 추정이면 추정 배지(`isEstimated`)를 답니다. 기준 중립(현금뿐)은 배지 없이 단계 표기만.
 * - 순자산을 모르면 "—"(단위 없음), 수익률을 모르면 칩을 생략합니다(0.00%를 만들지 않음 — AssetRow 규칙).
 * - 이전 값 배지(`bookStale`): 가격을 새로 받지 못한 보유가 있거나(staleCount > 0 — 지난 값으로 평가), 장부 관측치 저장본이 늦었으면
 *   (quotes.stale — 서버 판정) 시작한 계좌의 장부 값은 그 늦은 관측으로 평가한 값입니다. 보이는 값이 그 장부 값일 때만(옛 응답·장부 단계, 장중가 없는
 *   종목이 섞인 장중 추정) 사유와 함께 답니다 — 순자산 줄(잠정·확정)이나 모두 장중가로 평가한 추정에는 달지 않습니다.
 * - 경고: 벤치마크가 출발일 종가를 기다리면(pendingBackfill) 그 사실.
 */
export function bookAssetRow(book: PaperOverviewBook, context: BookRowContext = {}): BookRow {
  const market = context.market ?? "US";
  const card = bookCard(book, [], market);
  const view = currentView(book, { market, session: context.session });
  const summary = accountProfile(book.code)?.summary ?? null;
  const stale = bookStale(book, context, "row");
  const korea = market === "KR";
  const nav = korea ? formatNumber(view.nav, 0) : null;
  return {
    id: book.code,
    name: book.label,
    avatarText: bookMonogram(book.code),
    sub: [card.kind, card.status.label, summary].filter((part) => part && part !== EMPTY).join(" · "),
    value: view.nav,
    ...(korea ? { valueText: nav === EMPTY ? null : nav } : {}),
    unit: marketMeta(market).unitLabel,
    changePct: view.returnPct,
    isStale: stale.isStale,
    staleReason: stale.reason,
    warning: !korea && (context.pendingBackfill ?? []).includes(book.code) ? PENDING_BACKFILL_WARNING : null,
    ...(view.from === "current" ? { isEstimated: view.isEstimated, caption: rowCaption(view, book) } : {}),
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

// ---------------------------------------------------------------- 개요 히어로(고른 계좌 하나 — 포트폴리오식, 장중 명세 §4-1)

/**
 * 히어로 계좌 — 고른 계좌가 목록에 있으면 그것, 아니면(고르지 않음·목록에서 사라짐) 그 시장의 기본 Claude 계좌(홈 PaperHero와 같은 규칙 — 미국
 * claude·한국 kr_claude, lib/paper `primaryClaudeBook`), 그것도 없으면 첫 계좌. 계좌가 없으면 null.
 */
export function heroBookCode(books: readonly Pick<PaperBookSummary, "code" | "kind">[], pick: string | null | undefined): string | null {
  if (pick && books.some((book) => book.code === pick)) return pick;
  return primaryClaudeBook(books)?.code ?? books[0]?.code ?? null;
}

/** 유한한 숫자만 값 — 그 밖(null·글·NaN)은 null(선이 끊김, 짓지 않음). */
const finiteOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * 히어로 곡선 — 고른 계좌 한 줄(행 = 거래일, 키 "nav"). 값은 순자산 곡선(`navSeries`)의 그 계좌 값 그대로(기록 없는 날은 null — 선이 끊김).
 * 오늘 추정 점이 있으면 꼬리 계열(키 "estimate", `tailOf` "nav")과 그 점의 행이 하나 더 붙습니다(`heroNavChart`).
 */
export interface HeroNavChart {
  rows: LineRow[];
  series: LineSeriesSpec[];
  /** 값 자릿수 — 미국 소수 둘째, 한국 원 정수. */
  valueDigits: number;
  /** 꼬리 점을 문지르기가 읽는 법(`scrubModel`의 estimate — 날짜·꼬리 키·추정 여부·설명 'HH:MM'/'장부'). 꼬리가 없으면 null. */
  estimate: ScrubEstimate | null;
}

/** 히어로 곡선의 값 키. */
export const HERO_NAV_KEY = "nav";
/** 히어로 곡선의 오늘 추정 꼬리 키. */
export const HERO_ESTIMATE_KEY = "estimate";

/**
 * 고른 기간 창(`navSeriesWindow` 결과 — 순자산 곡선 카드와 같은 기간)에서 그 계좌 한 줄만. 창이 없으면 빈 행. 계열 이름은 계좌 이름.
 *
 * `tail`(그 계좌의 오늘 추정 점 — `navEstimatePoint`)이 있고 그 날짜가 창의 마지막 행보다 뒤면, 비교 곡선과 같은 규칙(`withNavEstimateTail`)으로
 * 마지막 행 → 그 점의 꼬리(점선)를 붙이고 문지르기가 그 점을 '추정 HH:MM'(현금뿐 계좌는 배지 없이 '장부')으로 읽게 합니다. 창에 행이 없으면 붙이지 않습니다.
 */
export function heroNavChart(
  navWindow: PaperOverviewResponse["navSeries"],
  code: string,
  label: string,
  market: PaperMarketCode = "US",
  tail: NavEstimatePoint | null = null,
): HeroNavChart {
  const dates = Array.isArray(navWindow?.dates) ? navWindow.dates : [];
  const values = navWindow?.books && Array.isArray(navWindow.books[code]) ? navWindow.books[code] : [];
  const rows = dates.map((date, index): LineRow => ({ date, [HERO_NAV_KEY]: finiteOrNull(values[index]) }));
  const series: LineSeriesSpec[] = [{ key: HERO_NAV_KEY, label }];
  const valueDigits = market === "KR" ? 0 : 2;
  const last = rows.at(-1);
  if (!tail || !last || !(tail.date > last.date)) return { rows, series, valueDigits, estimate: null };
  const withTail = rows.map((row, index): LineRow => ({ ...row, [HERO_ESTIMATE_KEY]: index === rows.length - 1 ? row[HERO_NAV_KEY] : null }));
  withTail.push({ date: tail.date, [HERO_NAV_KEY]: null, [HERO_ESTIMATE_KEY]: tail.nav });
  return {
    rows: withTail,
    series: [...series, { key: HERO_ESTIMATE_KEY, label: `${label} · ${tail.tag}`, tailOf: HERO_NAV_KEY }],
    valueDigits,
    estimate: { date: tail.date, valueKey: HERO_ESTIMATE_KEY, isEstimated: tail.isEstimated, note: tail.isEstimated ? tail.clock : tail.tag },
  };
}

/** 개요 히어로 한 장 — 고른 계좌의 지금 값(계좌 행과 같은 규칙)과 곡선. */
export interface OverviewHeroModel {
  code: string;
  /** 계좌 이름. */
  name: string;
  /** 히어로 제목 '{계좌} 순자산'. */
  label: string;
  /** 순자산 글(미국 소수 둘째·한국 원 정수). 모르면 null("—"). */
  valueText: string | null;
  unit: string;
  /** 출발 이후 수익률(계좌 행·비교 표와 같은 뜻). */
  returnPct: number | null;
  /** 변화 한 줄(서버 값 — 모르면 null). */
  day: DayChange | null;
  /** 단계 표기(옛 응답이면 '마지막 관측 …'). */
  stageLabel: string | null;
  isEstimated: boolean;
  /** 서버 글 전문(섞임·가격 없음·체결 대기) — 히어로는 긴 글, 행은 짧은 덧붙임. */
  note: string | null;
  /**
   * '지금 값 101,234.56 달러'(모르면 '지금 값 —') — 문지르는 동안 큰 숫자는 그 점의 값이라, 단계 표기·추정 배지·서버 글이 그 점이 아니라 지금 값의
   * 것임을 앞에 밝힙니다(배지는 문지르는 동안에도 보임 — Coinbase식 명세 A3).
   */
  nowText: string;
  isStale: boolean;
  staleReason: string | null;
  warning: string | null;
  source: string;
  chart: HeroNavChart;
}

/**
 * 개요 히어로 모델 — 계좌 행(`bookAssetRow`)과 같은 지금 값·경고 규칙이고, 이전 값 배지는 같은 규칙에 히어로 자리(단계 표기가 관측 시각을 이미 적음 —
 * `bookStale` "hero"), 곡선은 고른 기간 창의 그 계좌 한 줄. 그 계좌가 목록에 없으면 null.
 */
export function overviewHeroModel(
  overview: Pick<PaperOverviewResponse, "books" | "pendingBackfill" | "quotes" | "liveSession" | "navEstimate">,
  code: string,
  navWindow: PaperOverviewResponse["navSeries"],
  market: PaperMarketCode = "US",
): OverviewHeroModel | null {
  const book = (overview.books ?? []).find((entry) => entry.code === code);
  if (!book) return null;
  const session = overview.liveSession ?? null;
  const context: BookRowContext = { pendingBackfill: overview.pendingBackfill, quotes: overview.quotes ?? null, market, session };
  const row = bookAssetRow(book, context);
  const stale = bookStale(book, context, "hero");
  const view = currentView(book, { market, session });
  const digits = market === "KR" ? 0 : 2;
  const valueText = formatNumber(view.nav, digits);
  return {
    code,
    name: book.label,
    label: `${book.label} 순자산`,
    valueText: valueText === EMPTY ? null : valueText,
    unit: marketMeta(market).unitLabel,
    returnPct: view.returnPct,
    day: view.day?.text ? view.day : null,
    stageLabel: view.stageLabel,
    isEstimated: view.isEstimated,
    note: view.note ?? (view.notes.length > 0 ? view.notes.join(" · ") : null),
    nowText: `지금 값 ${valueText === EMPTY ? EMPTY : `${valueText} ${marketMeta(market).unitLabel}`}`,
    isStale: stale.isStale,
    staleReason: stale.reason,
    warning: row.warning,
    source: currentSource(view.isEstimated, market),
    chart: heroNavChart(navWindow, code, book.label, market, navEstimatePoint(overview.navEstimate, book, code)),
  };
}

// ---------------------------------------------------------------- 계좌 비교 표(DataTable, 행 = 항목 · 열 = 계좌)

/** 비교 표 칸 하나 — 글과(있으면) 글자색 클래스. 값을 모르면 글은 "—"이고 색은 없습니다. */
export interface ComparisonCell {
  text: string;
  className: string | null;
  /** 값 아래 작은 글(변화의 기준 '10-29 잠정 대비' 등) — 없으면 없음. */
  sub?: string | null;
}

/** 비교 표의 한 줄(항목 하나). `cells`는 계좌 코드 → 칸. */
export interface ComparisonRow {
  key: string;
  label: string;
  /** 상태 줄은 배지로 그립니다(글자색이 아니라 테두리·바탕이 있는 배지 클래스). */
  badge?: boolean;
  /** 긴 글이라 칸 안에서 줄을 바꿔도 되는 줄(기준 줄). */
  wrap?: boolean;
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

/** 변화 칸 — 글은 부호 % 와 방향색, 아래 작은 글은 그 값의 날짜(지금 세션이 아니면 'MM-DD')와 기준('10-29 잠정 대비'). 모르면 "—". */
function dayCell(
  source: { tradingDate: string | null; dayChangePct: number | null; previousTradingDate: string | null; previousNavFinal: boolean | null } | null | undefined,
  session: PaperLiveSessionSummary | null | undefined,
): ComparisonCell {
  if (!source) return plain(EMPTY);
  const text = formatPercent(source.dayChangePct);
  if (text === EMPTY) return plain(EMPTY);
  const date = dayLabel(source.tradingDate, session) === "오늘" ? null : monthDay(source.tradingDate);
  const sub = [date, dayBaseText(source.previousTradingDate, source.previousNavFinal)].filter(Boolean).join(" · ");
  return { text, className: deltaColor(source.dayChangePct), sub: sub || null };
}

/** 기준 줄 칸 — 지금 값 칸이면 그 계좌의 단계 표기(현금뿐이면 ' · 현금뿐'), 장부 칸이면 '장부 MM-DD HH:MM'(출발 전 '출발 전'). */
function basisCell(book: PaperOverviewBook, basis: ComparisonBasis, session: PaperLiveSessionSummary | null | undefined): ComparisonCell {
  if (book.status === "NOT_STARTED") return plain("출발 전");
  if (basis.mode === "live") {
    if (!book.current) return plain(EMPTY);
    return plain(`${stageLabel(book.current, { status: book.status, session })}${book.current.neutral ? " · 현금뿐" : ""}`);
  }
  const at = stampText(book.lastObservedAtKst);
  return plain(at ? `장부 ${at}` : EMPTY);
}

/** 통계 기준 칸 — 그 계좌 마지막 순자산 줄 '마감 10-29 확정·잠정'(확정 여부를 모르면 '마감 10-29'), 줄이 없으면 "—". */
function statsBasisCell(book: PaperOverviewBook): ComparisonCell {
  const md = monthDay(book.lastNavTradingDate);
  if (!md) return plain(EMPTY);
  const word = book.lastNavFinal === true ? " 확정" : book.lastNavFinal === false ? " 잠정" : "";
  return plain(`마감 ${md}${word}`);
}

/** 비교 표가 읽는 것 — 개요의 장 상태(지금 값의 '오늘'·단계 표기). */
export interface ComparisonContext {
  session?: PaperLiveSessionSummary | null;
}

/**
 * 계좌 비교 표 — 예전 계좌 카드 네 장의 칸을 항목별 줄로 모읍니다(상태·종류·출발·처음 현금·순자산·수익률·노출·현금·보유 수·
 * 마지막 관측·가격 없음·통계 일곱 칸·비교 기준). 값은 bookCard·statCells의 표시 글 그대로("—" 포함). 표본 설명은 문장이라 표 밖
 * (`sampleNotes`)에 둡니다.
 *
 * 초과 수익률·베타의 비교 기준은 계좌마다 다를 수 있어(SPY 계좌 자신은 기준 없음) 항목 이름에 적지 않고 "비교 기준" 줄로 따로 둡니다.
 * 돈 칸은 그 개요 시장의 통화입니다(`market` — 기본 미국 달러, 한국은 원 정수).
 *
 * 지금 값(장중 명세 §4 — 개요 계좌 줄의 `current`)이 있으면 한 표 한 기준(lib/paperCurrent `comparisonBasis`): 맨 위 '기준' 줄(계좌마다 단계 표기
 * 또는 '장부 MM-DD HH:MM'), '수익률(출발 이후)' 다음 '오늘 변화'(장부 칸이고 지금 세션이 아니면 '최근 변화' — 칸 아래 그 날짜와 기준 글), 통계
 * 일곱 칸 앞 '통계 기준'('마감 10-29 확정'). 순자산·수익률·노출·변화는 지금 값 칸이면 `current`, 장부 칸이면 BookSummary와 `ledgerDay`(navSeries로
 * 계산하지 않음). 현금·보유·처음 현금·출발·마지막 관측·가격 없음·통계·비교 기준은 장부 그대로. 지금 값이 없는 옛 응답은 예전 줄 목록 그대로입니다.
 */
export function accountComparisonRows(
  books: readonly PaperOverviewBook[],
  market: PaperMarketCode = "US",
  context: ComparisonContext = {},
): ComparisonRow[] {
  const session = context.session ?? null;
  const basis = comparisonBasis(books, session);
  const live = basis.hasCurrent && basis.mode === "live";
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
  // 지금 값 칸(모두 장중)이면 current, 아니면 장부(BookSummary) — 한 표에 두 기준을 섞지 않습니다.
  const now = (book: PaperOverviewBook) => (live ? book.current ?? null : null);
  const navRow = row("nav", "순자산", ({ book, card }) => {
    const current = now(book);
    return plain(current ? formatMoney(current.nav, market) : card.nav);
  });
  const returnRow = row("returnPct", "수익률(출발 이후)", ({ book, card }) => {
    const current = now(book);
    return current ? toned(formatPercent(current.returnPct), deltaColor(current.returnPct)) : toned(card.returnPct, deltaColor(book.returnPct));
  });
  const exposureRow = row("exposure", "주식 노출", ({ book, card }) => {
    const current = now(book);
    return plain(current ? formatWithUnit(current.exposurePct, 1, "%") : card.exposure);
  });
  const common = {
    status: row("status", "상태", ({ card }) => ({ text: card.status.label, className: card.status.className }), true),
    kind: row("kind", "종류", ({ card }) => plain(card.kind)),
    startedOn: row("startedOn", "출발", ({ card }) => plain(card.startedOn)),
    initialCash: row("initialCash", "처음 현금", ({ card }) => plain(card.initialCash)),
    cash: row("cash", "현금", ({ card }) => plain(card.cash)),
    positions: row("positions", "보유", ({ card }) => plain(card.positions)),
    lastObserved: row("lastObserved", "마지막 관측", ({ card }) => plain(card.lastObserved)),
    stale: row("stale", "가격 없음", ({ book }) => staleCell(book)),
    benchmark: row("benchmark", "비교 기준", ({ book }) => plain(benchmarkLabel(book, books) ?? EMPTY)),
  };
  if (!basis.hasCurrent) {
    return [
      common.status, common.kind, common.startedOn, common.initialCash, navRow, returnRow, exposureRow, common.cash, common.positions,
      common.lastObserved, common.stale, ...statRows, common.benchmark,
    ];
  }
  const basisRow: ComparisonRow = { ...row("basis", "기준", ({ book }) => basisCell(book, basis, session)), wrap: true };
  const dayRow = row("day", basis.dayLabel, ({ book }) => dayCell(live ? book.current : book.ledgerDay, session));
  const statsBasisRow = row("statsBasis", "통계 기준", ({ book }) => statsBasisCell(book));
  return [
    basisRow, common.status, common.kind, common.startedOn, common.initialCash, navRow, returnRow, dayRow, exposureRow, common.cash,
    common.positions, common.lastObserved, common.stale, statsBasisRow, ...statRows, common.benchmark,
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

// ---------------------------------------------------------------- 순자산 곡선의 오늘 추정 꼬리(장중 명세 §4 '순자산 곡선 꼬리', L2)

/** 비교 곡선 꼬리 계열 키의 꼬리말 — 계좌 코드 뒤에 붙입니다(계좌 코드·참고선 키와 겹치지 않게). */
export const NAV_TAIL_SUFFIX = "__estimate";

/** 계좌 하나의 오늘 추정 점 — 개요 `navEstimate`의 그 계좌 값(서버 값 그대로). */
export interface NavEstimatePoint {
  /** 점의 날짜 — 그 세션(아직 순자산 줄이 없는 날). */
  date: string;
  nav: number;
  /** 장중 추정인가 — false는 현금뿐 계좌(장부 값 = 장중 값). */
  isEstimated: boolean;
  /** 기준 시각 'HH:MM' — 그 계좌 지금 값의 시각(`current.atKst`), 모르면 `navEstimate.atKst`(장중 값 계좌들 가운데 가장 오래된 시각). 장부 값 점은 null. */
  clock: string | null;
  /** 이름 꼬리말 — '추정 23:58'·'추정'(시각 모름)·'장부'(현금뿐). */
  tag: string;
}

/**
 * 개요 `navEstimate`에서 계좌 하나의 오늘 추정 점. 꼬리가 없는 응답(옛 응답·장 밖·그날 줄이 이미 있음 — 서버가 null)이거나 그 계좌 값이 없으면
 * (장중 값도 현금뿐도 아님 — 서버 `nav:null`) null. 짓지 않습니다.
 */
export function navEstimatePoint(
  navEstimate: PaperNavEstimate | null | undefined,
  book: Pick<PaperOverviewBook, "current"> | null | undefined,
  code: string,
): NavEstimatePoint | null {
  if (!navEstimate || monthDay(navEstimate.date) === null || !navEstimate.books || !Object.hasOwn(navEstimate.books, code)) return null;
  const entry = navEstimate.books[code];
  const nav = finiteOrNull(entry?.nav);
  if (nav === null) return null;
  if (entry.isEstimated !== true) return { date: navEstimate.date, nav, isEstimated: false, clock: null, tag: "장부" };
  const own = book?.current?.isEstimated === true ? clockText(book.current.atKst) : null;
  const clock = own ?? clockText(navEstimate.atKst);
  return { date: navEstimate.date, nav, isEstimated: true, clock, tag: clock ? `추정 ${clock}` : "추정" };
}

/** 꼬리를 붙인 순자산 곡선 — `tailDate`는 꼬리 점의 날짜(꼬리가 없으면 null). */
export interface NavChartWithTail {
  rows: Record<string, string | number | null>[];
  series: NavSeriesLine[];
  tailDate: string | null;
}

/**
 * 순자산 곡선(고른 기간 창 — `navChart` 뒤, 한국은 참고선 `withKrReference` 뒤)에 오늘 추정 꼬리를 붙입니다(장중 명세 §4 '순자산 곡선 꼬리').
 *
 * - 개요에 `navEstimate`가 있고 그 날짜가 창의 마지막 행보다 뒤일 때만 — 그날 순자산 줄이 생기면 서버가 꼬리를 보내지 않고(이 함수도 날짜로 한 번 더
 *   막음), 창에 행이 하나도 없으면 붙이지 않습니다(이을 마지막 줄이 없음).
 * - 계좌 선마다(`navEstimatePoint`가 값을 주는 계좌만) 꼬리 계열 `{코드}__estimate` — 이름 '{계좌} · 추정 HH:MM'(현금뿐 '{계좌} · 장부'),
 *   `tailOf` = 계좌 코드. 꼬리는 창의 마지막 행의 그 계좌 값에서 시작해(그날 값이 없으면 외딴 점 하나) 새 행(꼬리 점의 날짜 — 다른 칸은 모두 null)의
 *   추정 값으로 갑니다. 축 범위는 부르는 쪽이 이 결과로 잽니다(`navAxis`).
 * - 계좌가 아닌 계열(한국 노출 맞춘 참고선 K40 — `books`에 없는 키)과 이미 꼬리인 계열에는 붙이지 않습니다. 값은 서버 값 그대로입니다(표시 전용 —
 *   통계·순자산 줄과 섞지 않음).
 */
export function withNavEstimateTail(
  chart: { rows: readonly Record<string, string | number | null>[]; series: readonly NavSeriesLine[] },
  navEstimate: PaperNavEstimate | null | undefined,
  books: readonly PaperOverviewBook[],
): NavChartWithTail {
  const unchanged = (): NavChartWithTail => ({ rows: chart.rows.map((row) => ({ ...row })), series: [...chart.series], tailDate: null });
  const last = chart.rows.at(-1);
  if (!navEstimate || !last || !(navEstimate.date > String(last.date))) return unchanged();
  const tails = chart.series.flatMap((line) => {
    const book = line.tailOf === undefined ? books.find((entry) => entry.code === line.key) : undefined;
    const point = book ? navEstimatePoint(navEstimate, book, line.key) : null;
    return point ? [{ line, point, key: `${line.key}${NAV_TAIL_SUFFIX}` }] : [];
  });
  if (tails.length === 0) return unchanged();
  const lastIndex = chart.rows.length - 1;
  const rows = chart.rows.map((row, index) => {
    const out: Record<string, string | number | null> = { ...row };
    for (const tail of tails) out[tail.key] = index === lastIndex ? finiteOrNull(row[tail.line.key]) : null;
    return out;
  });
  const point: Record<string, string | number | null> = { date: navEstimate.date };
  for (const line of chart.series) point[line.key] = null;
  for (const tail of tails) point[tail.key] = tail.point.nav;
  rows.push(point);
  return {
    rows,
    series: [...chart.series, ...tails.map((tail) => ({ key: tail.key, name: `${tail.line.name} · ${tail.point.tag}`, tailOf: tail.line.key }))],
    tailDate: navEstimate.date,
  };
}

/** 곡선 아래 꼬리 설명 한 줄 — 꼬리가 없으면 null. */
export function navTailNote(tailDate: string | null): string | null {
  const md = monthDay(tailDate);
  if (!md) return null;
  return `점선 꼬리 = ${md} 순자산 줄이 생기기 전의 지금 값(계좌 행과 같은 값 — 장중 추정, 현금뿐 계좌는 장부 값)입니다. 표시 전용이고 그날 줄이 생기면 사라집니다.`;
}

// ---------------------------------------------------------------- 같은 구간 순자산(S = 100, 계좌2 명세 §4-2의 2)

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
