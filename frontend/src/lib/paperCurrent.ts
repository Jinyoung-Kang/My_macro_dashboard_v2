/**
 * 모의 매매 개요의 '지금 값'(개요 응답 계좌 줄의 `current` — 장중 명세 2026-10-31 §3·§4-1) 표시 규칙. 순수 함수(ADR 0004).
 *
 * 개요 히어로·계좌 행·계좌 상세·홈 히어로·계좌 비교 표가 같은 단계 표기와 '오늘' 이름을 쓰도록 한 곳에 둡니다. 숫자는 서버 값 그대로이고
 * (`navSeries`로 오늘 변화를 계산하지 않음), 화면은 시계를 읽지 않습니다 — '오늘'인지, 장부 표기에 날짜를 붙일지는 개요의 장 상태
 * (`liveSession`)와 값의 거래일로만 가릅니다. `current`가 없는 옛 응답(이 칸을 보내지 않는 서버·고정본)은 장부 값 그대로입니다.
 *
 * 지금 값은 **표시 전용**입니다 — `isEstimated`면 장중 1분봉으로 다시 평가한 추정이고, 통계·순자산 줄·결정에는 들어가지 않습니다.
 */
import { formatKst, formatPercent } from "./format";
import { PAPER_SOURCES } from "./paper";
import { formatMoney, type PaperMarketCode } from "./paperMarket";
import { presentText } from "./patterns";
import type {
  PaperBookStatus,
  PaperBookSummary,
  PaperCurrentStage,
  PaperCurrentValue,
  PaperLiveSessionSummary,
  PaperOverviewBook,
} from "./types";

/** "2026-10-30" → "10-30". 날짜 꼴이 아니면 null. */
export function monthDay(date: string | null | undefined): string | null {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(date ?? "");
  return match ? `${match[1]}-${match[2]}` : null;
}

/** "2026-10-30 23:58 KST"(또는 KST 꼬리 없이) → 날짜 "10-30"·시각 "23:58". 꼴이 다르면 null — 시각을 짐작하지 않습니다. */
function stampParts(stamp: string | null | undefined): { md: string; hm: string } | null {
  const match = /^\d{4}-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/.exec(stamp ?? "");
  return match ? { md: `${match[1]}-${match[2]}`, hm: match[3] } : null;
}

/** "2026-10-30 23:15 KST" → "10-30 23:15"(꼴이 다르면 null — 장부 표기·비교 표 기준 줄). */
export function stampText(stamp: string | null | undefined): string | null {
  const at = stampParts(stamp);
  return at ? `${at.md} ${at.hm}` : null;
}

/** "2026-10-30 23:58 KST" → "23:58"(꼴이 다르면 null — 곡선 꼬리 이름·히어로 꼬리 점의 기준 시각). */
export function clockText(stamp: string | null | undefined): string | null {
  return stampParts(stamp)?.hm ?? null;
}

/** 장중 1분봉이 든 단계인가(`LIVE` 정규장 장중 추정 · `LIVE_LAST` 마감 뒤 같은 날 장중 마지막 추정). */
export function isLiveStage(stage: PaperCurrentStage | null | undefined): boolean {
  return stage === "LIVE" || stage === "LIVE_LAST";
}

/**
 * 값의 거래일이 지금 세션인가 — 장 상태가 정규장·마감 뒤(같은 날)이고 세션 날짜가 그 거래일일 때만. 휴장(`CLOSED`)의 세션 날짜는 직전 거래일이고
 * 개장 전(`PRE`)은 아직 열리지 않은 오늘이라 '지금 세션'으로 보지 않습니다(일요일에 금요일 값을 '오늘'이라 적지 않게).
 */
export function inCurrentSession(tradingDate: string | null | undefined, session: PaperLiveSessionSummary | null | undefined): boolean {
  const phase = session?.phase;
  return (phase === "REGULAR" || phase === "AFTER") && typeof tradingDate === "string" && tradingDate !== "" && tradingDate === session?.sessionDate;
}

/** 단계 표기가 읽는 것 — 계좌 상태(출발 전이면 '출발 전')와 개요의 장 상태(장부 표기의 날짜를 붙일지). */
export interface StageContext {
  status?: PaperBookStatus | null;
  session?: PaperLiveSessionSummary | null;
}

/**
 * 지금 값의 단계 표기 — 히어로·계좌 행·계좌 상세·홈·비교 표가 이 함수 하나를 씁니다(장중 명세 §3·§4-1).
 *
 * - `LIVE` '장중 추정 HH:MM'(장중가로 평가한 종목 가운데 가장 오래된 봉) · `LIVE_LAST` '장중 마지막 추정 HH:MM · 종가 확정 전'
 * - `LEDGER` '장부 HH:MM' — 값의 거래일이 지금 세션일 때만 시각만, 아니면 '장부 MM-DD HH:MM'(장 밖·주말에 며칠 전 관측이 오늘 시각처럼 읽히지 않게)
 * - `PROVISIONAL`·`FINAL` 'MM-DD 잠정'·'MM-DD 확정'(그 거래일 순자산 줄) · 출발 전 계좌는 '출발 전'
 * - 시각·거래일을 모르면 그것 없이 적습니다('장중 추정'·'장부'·'잠정') — 짐작하지 않습니다.
 */
export function stageLabel(
  current: Pick<PaperCurrentValue, "stage" | "atKst" | "tradingDate">,
  context: StageContext = {},
): string {
  if (context.status === "NOT_STARTED") return "출발 전";
  const at = stampParts(current.atKst);
  switch (current.stage) {
    case "LIVE":
      return at ? `장중 추정 ${at.hm}` : "장중 추정";
    case "LIVE_LAST":
      return `${at ? `장중 마지막 추정 ${at.hm}` : "장중 마지막 추정"} · 종가 확정 전`;
    case "LEDGER":
      if (!at) return "장부";
      return inCurrentSession(current.tradingDate, context.session) ? `장부 ${at.hm}` : `장부 ${at.md} ${at.hm}`;
    case "PROVISIONAL":
    case "FINAL": {
      const word = current.stage === "FINAL" ? "확정" : "잠정";
      const md = monthDay(current.tradingDate);
      return md ? `${md} ${word}` : word;
    }
    default:
      // 모르는 단계(새 서버 값)는 받은 글 그대로 — 다른 단계로 짐작하지 않습니다.
      return String(current.stage);
  }
}

/** '오늘' 이름 — 값의 거래일이 지금 세션이면 '오늘', 아니면 'MM-DD 하루'(거래일을 모르면 '하루'). */
export function dayLabel(tradingDate: string | null | undefined, session: PaperLiveSessionSummary | null | undefined): string {
  if (inCurrentSession(tradingDate, session)) return "오늘";
  const md = monthDay(tradingDate);
  return md ? `${md} 하루` : "하루";
}

/** 하루 변화의 기준 글 — '10-29 잠정 대비'·'10-29 확정 대비', 확정 여부를 모르면 '10-29 대비', 기준 줄이 없으면 null. */
export function dayBaseText(previousTradingDate: string | null | undefined, previousNavFinal: boolean | null | undefined): string | null {
  const md = monthDay(previousTradingDate);
  if (!md) return null;
  if (previousNavFinal === true) return `${md} 확정 대비`;
  if (previousNavFinal === false) return `${md} 잠정 대비`;
  return `${md} 대비`;
}

/** 하루 변화 한 줄 — 서버의 `dayChangePct`와 그 기준(앞의 마지막 순자산 줄, 잠정 포함). */
export interface DayChange {
  pct: number | null;
  /** '오늘'·'10-30 하루'·'하루'. */
  label: string;
  /** '10-29 잠정 대비' 등(모르면 null). */
  base: string | null;
  /** '오늘 +0.42% · 10-29 잠정 대비' — 변화를 모르면 null(줄을 생략, 0.00%를 짓지 않음). */
  text: string | null;
}

/** 하루 변화의 재료 — `current`와 `ledgerDay`가 같은 칸 이름을 씁니다. */
type DaySource = {
  tradingDate: string | null;
  dayChangePct: number | null;
  previousTradingDate: string | null;
  previousNavFinal: boolean | null;
};

/** 하루 변화 한 줄을 만듭니다(값은 서버 그대로). */
export function dayChange(source: DaySource, session: PaperLiveSessionSummary | null | undefined): DayChange {
  const pct = typeof source.dayChangePct === "number" && Number.isFinite(source.dayChangePct) ? source.dayChangePct : null;
  const label = dayLabel(source.tradingDate, session);
  const base = dayBaseText(source.previousTradingDate, source.previousNavFinal);
  return { pct, label, base, text: pct === null ? null : `${label} ${formatPercent(pct)}${base ? ` · ${base}` : ""}` };
}

/**
 * 짧은 덧붙임(계좌 행·히어로) — 섞임 '장중가 n/m종목'(장중 추정인데 장중가로 평가하지 못한 보유가 있음), 체결 대기 '체결 대기 n건 반영 전'
 * (한국은 '시가 체결 대기 n건 반영 전' — 값이 체결 전 보유 기준). 서버의 긴 글(`note`)은 히어로가 따로 적습니다.
 */
export function currentNotes(
  current: Pick<PaperCurrentValue, "isEstimated" | "livePriced" | "positionCount" | "pendingOrders">,
  market: PaperMarketCode = "US",
): string[] {
  const notes: string[] = [];
  if (current.isEstimated && current.livePriced < current.positionCount) {
    notes.push(`장중가 ${current.livePriced}/${current.positionCount}종목`);
  }
  if (typeof current.pendingOrders === "number" && current.pendingOrders > 0) {
    notes.push(`${market === "KR" ? "시가 체결 대기" : "체결 대기"} ${current.pendingOrders}건 반영 전`);
  }
  return notes;
}

/** 계좌 하나의 지금 값 보기 — 히어로·행·상세가 같은 모양을 씁니다. */
export interface CurrentView {
  /** "current"면 지금 값(`current`), "ledger"면 옛 응답(장부 값 그대로). */
  from: "current" | "ledger";
  nav: number | null;
  returnPct: number | null;
  exposurePct: number | null;
  /** 단계 표기(`stageLabel`). 옛 응답이면 '마지막 관측 …'(모르면 null). */
  stageLabel: string | null;
  isEstimated: boolean;
  /** 현금뿐이거나 출발 전 — 장중 값 = 장부 값(배지 없이 단계 표기만). */
  neutral: boolean;
  /** 짧은 덧붙임(`currentNotes`). */
  notes: string[];
  /** 서버 글 전문(섞임·가격 없음·체결 대기) — 단계 표기와 같은 '출발 전'뿐이면 null. */
  note: string | null;
  /** 하루 변화(옛 응답이면 null). */
  day: DayChange | null;
  /** 값의 기준 시각(`current.atKst`, 옛 응답이면 장부 마지막 관측). */
  atKst: string | null;
}

/** 지금 값 보기가 읽는 것 — 그 개요의 시장(기본 미국)과 장 상태. */
export interface CurrentContext {
  market?: PaperMarketCode;
  session?: PaperLiveSessionSummary | null;
}

/**
 * 계좌 하나 → 지금 값 보기. `current`가 있으면 그 값(순자산이 null — 출발 전이고 장부 상태도 없음 — 이면 장부 칸 셋을 함께), 없거나 null이면
 * (옛 응답·장부를 읽은 뒤 사라진 계좌) 장부 값 그대로 — 단계 표기 자리에 '마지막 관측 …', 덧붙임·하루 변화 없음, 추정 아님.
 */
export function currentView(book: PaperOverviewBook, context: CurrentContext = {}): CurrentView {
  const current = book.current ?? null;
  if (!current) {
    const observed = presentText(book.lastObservedAtKst);
    return {
      from: "ledger",
      nav: book.nav,
      returnPct: book.returnPct,
      exposurePct: book.exposurePct,
      stageLabel: observed ? `마지막 관측 ${formatKst(observed)}` : null,
      isEstimated: false,
      neutral: false,
      notes: [],
      note: null,
      day: null,
      atKst: observed,
    };
  }
  const known = current.nav !== null;
  const note = presentText(current.note);
  return {
    from: "current",
    nav: known ? current.nav : book.nav,
    returnPct: known ? current.returnPct : book.returnPct,
    exposurePct: known ? current.exposurePct : book.exposurePct,
    stageLabel: stageLabel(current, { status: book.status, session: context.session }),
    isEstimated: current.isEstimated === true,
    neutral: current.neutral === true,
    notes: currentNotes(current, context.market),
    note: note === "출발 전" ? null : note,
    day: dayChange(current, context.session),
    atKst: presentText(current.atKst),
  };
}

/**
 * '계좌' 카드 부제의 기준 한 마디 — 지금 값이 하나도 없으면(옛 응답) null(부르는 쪽이 예전 '장부의 마지막 관측치 기준'을 씀), 있으면
 * '지금 값 기준(행마다 단계 표기)', 장중 추정인 계좌가 있으면 ' — 장중 추정은 표시 전용'을 붙입니다.
 */
export function accountsBasisText(books: readonly PaperOverviewBook[]): string | null {
  const withCurrent = books.filter((book) => book.current);
  if (withCurrent.length === 0) return null;
  const estimated = withCurrent.some((book) => book.current?.isEstimated === true);
  return `지금 값 기준(행마다 단계 표기)${estimated ? " — 장중 추정은 표시 전용" : ""}`;
}

/** 지금 값의 출처 — 장부 출처, 추정이면 장중 시세로 다시 평가했다는 말을 덧붙입니다(데이터셋 이름은 적지 않음 — 출처는 장중 시세 카드가 적음). */
export function currentSource(isEstimated: boolean, market: PaperMarketCode = "US"): string {
  const ledger = market === "KR" ? PAPER_SOURCES.krLedger : PAPER_SOURCES.ledger;
  return isEstimated ? `${ledger} · 보유를 장중 1분봉 시세로 다시 평가한 표시 전용 추정(장중 시세 카드의 출처)` : ledger;
}

/**
 * 계좌 상세의 장부 한 줄 — 위 타일(지금 값)과 아래 구성·현금·보유·체결(장부)의 기준이 다르므로 장부 값을 함께 밝힙니다.
 * '장부 마지막 관측 101,200.00 달러 (10-24 05:15) — 아래 구성·현금·보유·체결은 장부 값'(시각을 모르면 괄호 없이, 순자산을 모르면 '—').
 */
export function ledgerObservedLine(ledger: Pick<PaperBookSummary, "nav" | "lastObservedAtKst">, market: PaperMarketCode = "US"): string {
  const at = stampParts(ledger.lastObservedAtKst);
  return `장부 마지막 관측 ${formatMoney(ledger.nav, market)}${at ? ` (${at.md} ${at.hm})` : ""} — 아래 구성·현금·보유·체결은 장부 값`;
}

/** 계좌 비교 표의 기준(한 표 한 기준 — 장중 명세 §4). */
export interface ComparisonBasis {
  /** 지금 값이 있는 응답인가 — 없으면(옛 응답) 표는 지금과 같은 줄 목록. */
  hasCurrent: boolean;
  /** "live"면 순자산·수익률·노출·오늘 변화가 지금 값(장중 추정), "ledger"면 장부 칸. */
  mode: "live" | "ledger";
  /** 장부 칸으로 둔 사유 — 장중 추정인 계좌가 있는데 표를 장부로 둘 때만(그 밖은 null). */
  reason: string | null;
  /** '오늘 변화' 또는 '하루 변화'(장부 칸이고 관측 세션이 지금 세션이 아니면). */
  dayLabel: string;
}

/**
 * 한 표 한 기준 — 판정 대상은 기준 중립(현금뿐·출발 전)이 아닌 계좌(`current`가 null인 계좌는 장중이 아닌 것으로 셈). 모두 `LIVE`·`LIVE_LAST`면
 * 지금 값 칸, 하나라도 아니면 표 전체를 장부 칸으로 두고(장중 값과 장부 값을 한 표에 섞지 않음) 장중 추정인 계좌가 있으면 사유
 * '장중 추정이 아닌 계좌가 있어 표 전체를 장부 기준으로 둡니다 — {계좌}({단계 표기})'를 적습니다.
 */
export function comparisonBasis(
  books: readonly PaperOverviewBook[],
  session: PaperLiveSessionSummary | null | undefined,
): ComparisonBasis {
  const hasCurrent = books.some((book) => book.current);
  const judged = books.filter((book) => book.current?.neutral !== true);
  if (hasCurrent && judged.length > 0 && judged.every((book) => isLiveStage(book.current?.stage))) {
    return { hasCurrent, mode: "live", reason: null, dayLabel: "오늘 변화" };
  }
  const anyLive = books.some((book) => isLiveStage(book.current?.stage));
  const offenders = judged
    .filter((book) => !isLiveStage(book.current?.stage))
    .map((book) => `${book.label}(${book.current ? stageLabel(book.current, { status: book.status, session }) : "지금 값 없음"})`);
  const days = books.map((book) => book.ledgerDay).filter((day): day is NonNullable<typeof day> => day != null);
  const today = days.length > 0 && days.every((day) => dayLabel(day.tradingDate, session) === "오늘");
  return {
    hasCurrent,
    mode: "ledger",
    reason: hasCurrent && anyLive && offenders.length > 0
      ? `장중 추정이 아닌 계좌가 있어 표 전체를 장부 기준으로 둡니다 — ${offenders.join(", ")}`
      : null,
    dayLabel: today ? "오늘 변화" : "하루 변화",
  };
}
