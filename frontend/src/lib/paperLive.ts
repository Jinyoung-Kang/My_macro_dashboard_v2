/**
 * 모의 매매 장중 평가(GET /api/paper/live) 화면 자료 — 장 상태 문구, 고른 계좌의 종목 줄, 자동 새로고침 규칙.
 *
 * 장중 평가는 **표시 전용 추정**입니다. 서버가 정규장 동안 보유 종목을 최신 1분봉으로 다시 평가한 값이고, 장부(체결·스탑·순자산 줄·
 * 통계·결정 패킷)는 이 값을 쓰지 않습니다. 시세는 화면이 볼 때만 받습니다(사용자 결정 2026-10-30) — 그래서 이 화면은 정규장에만 고른
 * 간격(실시간 시세 주기 — lib/livePrices, 기본 10초. 이 저장본은 1분보다 짧게 다시 읽지 않음)으로 다시 읽고, 서버가 새 시세를 요청했으면
 * (refreshRequested) 잠시 뒤 한 번만 더 읽습니다. 장 밖에서는 다시 읽지 않고 다음 개장 시각에 한 번 깨어납니다. 종목 줄의 가격은 그 위에 실시간
 * 시세(SSE — 고른 주기, ADR 0024)를 얹습니다. 모르는 값은 "—"(0으로 채우지 않음)이고 모든 수익률에 기준 시각을 붙입니다.
 */
import { EMPTY, formatKst, formatNumber, formatPercent } from "./format";
import { livePriceTitle, liveShown, returnVsCost, tradedAtText } from "./livePrices";
import { formatSharePriceFor, type PaperMarketCode, tickerName } from "./paperMarket";
import type { LivePrice, PaperLiveBook, PaperLivePosition, PaperLiveQuotes, PaperLiveResponse, PaperLiveSession } from "./types";

/** 서버가 새 시세를 요청한 응답 뒤 한 번 더 읽기까지 — 수집(보유 수십 종목)이 끝날 만한 시간. */
export const LIVE_FOLLOW_UP_MS = 20_000;
/** 다음 개장 뒤 이만큼 기다렸다 깨어납니다(첫 1분봉이 생긴 뒤). */
const OPEN_GRACE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** 시간별 장부 관측과 견줄 만큼 긴 간격(분) — 이 이상이면 카드가 지금 값이 대개 장부 단계라고 알립니다. */
const LONG_INTERVAL_MINUTES = 60;

/**
 * 긴 간격의 안내(미국만) — 가격은 종목마다 장중 1분봉과 장부 관측 가운데 늦은 쪽이라, 정규장에 매시 장부 관측이 돌면 장부가가 이겨 계좌의 지금 값이
 * '장부' 단계로 돌아갑니다(장중 명세 §2·§4-1). 간격이 길면 장중 추정은 이 카드가 읽은 직후에만 생깁니다. 한국은 장부 관측이 그날 밤이라 정규장에는
 * 장중가가 늘 늦은 쪽입니다(안내 없음). 짧은 간격·끄기면 null.
 */
export function liveIntervalNote(minutes: number, market: PaperMarketCode = "US"): string | null {
  if (market !== "US" || minutes < LONG_INTERVAL_MINUTES) return null;
  return "간격이 길면 그 사이 매시 장부 관측이 돌아 계좌의 지금 값이 대개 '장부' 단계입니다 — 장중 추정은 이 카드가 읽은 직후에 새로 생깁니다.";
}

/** "yyyy-MM-dd HH:mm KST" → 그 순간(ms). KST는 UTC+9(서머타임 없음). 형식이 다르면 null — 시각을 짐작하지 않습니다. */
export function parseKstStamp(text: string | null | undefined): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) KST$/.exec(text ?? "");
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  return Date.UTC(y, mo - 1, d, h - 9, mi);
}

/** 자동 새로고침 주기(ms) — 정규장이고 간격을 골랐을 때만, 그 밖은 0(다시 읽지 않음). */
export function liveRefreshMs(live: PaperLiveResponse | null | undefined, minutes: number): number {
  return live?.session?.phase === "REGULAR" && minutes > 0 ? minutes * 60_000 : 0;
}

/** 장 밖이면 다음 개장(+1분)까지 남은 ms. 정규장·모름·하루 넘게 남음이면 null(깨어나지 않음 — 화면을 다시 열면 읽음). */
export function msUntilNextOpen(session: PaperLiveSession | null | undefined, nowMs: number): number | null {
  if (!session || session.phase === "REGULAR") return null;
  const open = parseKstStamp(session.nextOpenAtKst);
  if (open === null) return null;
  const wait = open + OPEN_GRACE_MS - nowMs;
  return wait > 0 && wait <= DAY_MS ? wait : null;
}

/** 시각 "yyyy-MM-dd HH:mm KST" → "MM-DD HH:mm"(모르면 "—"). */
function shortStamp(text: string | null | undefined): string {
  const shown = formatKst(text ?? null);
  return shown === EMPTY ? EMPTY : shown.slice(5);
}

export interface LiveSessionView {
  /** 장 상태 한 단어 — 정규장·개장 전·장 마감·휴장·장 시각 모름 */
  label: string;
  /** 그 상태에서 숫자가 무엇을 기준으로 하는지 한 줄 */
  detail: string;
  /** 정규장이면 true(값이 움직이는 때) */
  live: boolean;
}

/** 장 상태 문구 — 숫자가 언제 움직이고 무엇을 기준으로 하는지. */
export function liveSessionView(session: PaperLiveSession | null | undefined, quotes: PaperLiveQuotes | null | undefined): LiveSessionView {
  const source = quotes?.source ? ` · 출처 ${quotes.source}` : "";
  const next = shortStamp(session?.nextOpenAtKst);
  switch (session?.phase) {
    case "REGULAR":
      return { label: "정규장", detail: `장중 1분봉 시세로 다시 평가 — 화면을 볼 때만 받습니다${source}`, live: true };
    case "PRE":
      return { label: "개장 전", detail: `개장 ${next} KST부터 장중 값 — 지금은 장부의 마지막 관측치 기준`, live: false };
    case "AFTER":
      return { label: "장 마감", detail: `그날 마지막 장중 시세 기준(확정 종가는 장부가 따로 반영) · 다음 개장 ${next} KST${source}`, live: false };
    case "CLOSED":
      return { label: "휴장", detail: `장부의 마지막 관측치 기준 · 다음 개장 ${next} KST`, live: false };
    default:
      return { label: "장 시각 모름", detail: "이 시장 달력이 올해 휴장일을 몰라 장 시각을 정하지 못했습니다 — 장부의 마지막 관측치 기준", live: false };
  }
}

/** 장중 시세 카드의 종목 표 — 고른 계좌의 이름과 종목 줄. */
export interface LiveHoldingsView {
  code: string;
  label: string;
  positions: LivePositionView[];
}

/**
 * 고른 계좌(개요의 계좌 행)의 종목 줄 — 그 코드가 응답에 없거나 고르지 않았으면 첫 계좌, 계좌가 없으면 null. 계좌 숫자(순자산·수익률)는 개요의
 * 지금 값이 맡아 여기서 만들지 않습니다. 실시간 시세(``'US:AAPL'`` → 가격, hooks/useLivePrices)가 있는 종목은 그 가격으로 줄을 다시 셈합니다.
 */
export function livePositionsFor(
  live: PaperLiveResponse | null | undefined,
  bookCode: string | null | undefined,
  market: PaperMarketCode = "US",
  realtime: Readonly<Record<string, LivePrice>> = {},
): LiveHoldingsView | null {
  const books = live?.books ?? [];
  const book = books.find((entry) => entry.code === bookCode) ?? books[0];
  if (!book) return null;
  return {
    code: book.code,
    label: book.label,
    positions: book.positions.map((position) => livePositionView(position, market, realtime[`${market}:${position.ticker.toUpperCase()}`])),
  };
}

export interface LivePositionView {
  ticker: string;
  qty: string;
  /** 그 계좌의 평균 단가(평단 — 장부 값, 실시간 시세와 무관). 모르면 "—". */
  avgCost: string;
  price: string;
  /** "실시간 23:58:07"·"장중 23:58"·"마지막 관측 10-30 06:15"·"—" */
  priceAt: string;
  live: boolean;
  /** 실시간 시세(SSE)로 다시 셈한 줄이면 true */
  realtime: boolean;
  /** 가격 칸 설명(실시간이면 출처·거래 시각·장 상태) — 없으면 null */
  priceTitle: string | null;
  returnPct: number | null;
  returnText: string;
  dayChangePct: number | null;
  dayText: string;
  weight: string;
}

/**
 * 종목 한 줄 — 평균 단가(평단, 사용자 요청 2026-11-03), 가격 기준(장중·마지막 관측)과 시각, 평균 단가 대비·직전 종가 대비, 비중. 실시간 시세(``realtime``)가 있으면 가격·기준 시각·평균 단가
 * 대비·직전 종가 대비를 그 값으로 다시 셈합니다(비중은 서버 평가 그대로 — 계좌 숫자는 개요의 지금 값이 맡음).
 */
export function livePositionView(position: PaperLivePosition, market: PaperMarketCode = "US", realtime?: LivePrice | null): LivePositionView {
  const at = shortStamp(position.priceAtKst);
  const live = position.priceBasis === "LIVE";
  const weight = position.weightPct === null ? EMPTY : `${formatNumber(position.weightPct, 1)}%`;
  const avgCost = formatSharePriceFor(position.avgCost, market);
  if (realtime && realtime.price > 0) {
    // 프리장·애프터장이 열려 있으면 그 가격(lib/livePrices liveShown)
    const shown = liveShown(realtime);
    const returnPct = returnVsCost(shown.price, position.avgCost);
    const dayChangePct = shown.changePct
      ?? (position.previousClose ? (shown.price / position.previousClose - 1) * 100 : null);
    return {
      ticker: position.ticker,
      qty: formatNumber(position.qty, 0),
      avgCost,
      price: formatSharePriceFor(shown.price, market),
      priceAt: `${shown.session ?? "실시간"} ${tradedAtText(shown.tradedAt)}`,
      live: true,
      realtime: true,
      priceTitle: livePriceTitle(realtime, (value) => formatSharePriceFor(value, market)),
      returnPct,
      returnText: formatPercent(returnPct),
      dayChangePct,
      dayText: formatPercent(dayChangePct),
      weight,
    };
  }
  return {
    ticker: position.ticker,
    qty: formatNumber(position.qty, 0),
    avgCost,
    price: formatSharePriceFor(position.price, market),
    priceAt: at === EMPTY || position.priceBasis === null ? EMPTY : live ? `장중 ${at}` : `마지막 관측 ${at}`,
    live,
    realtime: false,
    priceTitle: null,
    returnPct: position.returnPct,
    returnText: formatPercent(position.returnPct),
    dayChangePct: position.dayChangePct,
    dayText: formatPercent(position.dayChangePct),
    weight,
  };
}

/**
 * 장중 값의 판 — 시세 저장본의 수집 시각과 계좌마다 기준 시각(`code=basisAtKst`)을 이은 글. 판이 바뀌면 새 장중 값을 받은 것이라 카드가 개요를
 * 한 번 다시 읽습니다(개요의 지금 값이 같은 저장본을 읽음). 응답이 없거나 쓸 수 없으면 null.
 */
export function liveRevision(live: PaperLiveResponse | null | undefined): string | null {
  if (!live?.available) return null;
  const books = (live.books ?? []).map((book) => `${book.code}=${book.basisAtKst ?? ""}`).join(",");
  return `${live.quotes?.collectedAtKst ?? ""}|${books}`;
}

/** 받지 못한 종목·수집 오류 한 줄(없으면 null) — 그 종목은 마지막 관측 가격으로 평가됐다는 뜻. */
export function liveQuotesWarning(quotes: PaperLiveQuotes | null | undefined,
  names: Readonly<Record<string, string>> = {}): string | null {
  if (!quotes) return null;
  const missing = quotes.missing ?? [];
  if (missing.length === 0 && !quotes.error) return null;
  if (missing.length === 0) return `장중 시세 수집 오류 — ${quotes.error}`;
  // 한국 화면은 이름 표의 기업명(사용자 결정 2026-11-02), 모르면 코드 그대로.
  const shown = missing.slice(0, 5).map((code) => tickerName(code, names));
  const list = `${shown.join(", ")}${missing.length > 5 ? ` 외 ${missing.length - 5}` : ""}`;
  return `장중 시세를 받지 못한 종목: ${list} — 마지막 관측 가격으로 평가`;
}

/** 실시간 시세로 다시 센 계좌의 순자산(표시 전용 추정 — 개요 히어로). */
export interface RealtimeNav {
  code: string;
  nav: number;
  /** 출발 대비 %(출발 현금을 모르면 null) */
  returnPct: number | null;
  /** 앞의 마지막 순자산 줄 대비 %(그 줄을 모르면 null) */
  dayChangePct: number | null;
  /** 실시간 가격 가운데 가장 늦은 거래 시각(ISO) — 모르면 null */
  at: string | null;
  /** 실시간 가격으로 센 종목 수 / 보유 종목 수 */
  priced: number;
  total: number;
}

/**
 * 계좌의 순자산을 실시간 시세로 다시 셉니다(사용자 결정 2026-11-03 — 개요 '계좌 순자산'이 고른 주기로 움직임): 현금 + 보유 수량 × 가격(실시간 —
 * 프리장·애프터장이 열려 있으면 그 가격, 없으면 서버 장중 평가의 가격). 실시간 가격이 하나도 없거나, 현금·어느 보유의 가격도 모르면 null(지어내지
 * 않음). 장부의 확정 순자산과 별개인 표시 전용 추정입니다.
 */
export function realtimeBookNav(book: PaperLiveBook | null | undefined, market: PaperMarketCode,
  realtime: Readonly<Record<string, LivePrice>>): RealtimeNav | null {
  if (!book || book.cash === null) return null;
  let nav = book.cash;
  let priced = 0;
  let at: string | null = null;
  for (const position of book.positions) {
    const live = realtime[`${market}:${position.ticker.toUpperCase()}`];
    const shown = live && live.price > 0 ? liveShown(live) : null;
    const price = shown?.price ?? position.price;
    if (price === null || price === undefined) return null;
    nav += position.qty * price;
    if (shown) {
      priced += 1;
      if (shown.tradedAt && (at === null || shown.tradedAt > at)) at = shown.tradedAt;
    }
  }
  if (priced === 0) return null;
  return {
    code: book.code,
    nav,
    returnPct: book.initialCash ? (nav / book.initialCash - 1) * 100 : null,
    dayChangePct: book.previousNav ? (nav / book.previousNav - 1) * 100 : null,
    at,
    priced,
    total: book.positions.length,
  };
}
