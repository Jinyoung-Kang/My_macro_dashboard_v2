/**
 * 🧪 모의 매매 장중 평가(GET /api/paper/live) 화면 자료 — 장 상태 문구, 계좌·종목 줄, 자동 새로고침 규칙.
 *
 * 장중 평가는 **표시 전용 추정**입니다. 서버가 정규장 동안 보유 종목을 최신 1분봉으로 다시 평가한 값이고, 장부(체결·스탑·확정 순자산·
 * 통계·결정 패킷)는 이 값을 쓰지 않습니다. 시세는 화면이 볼 때만 받습니다(사용자 결정 2026-10-30) — 그래서 이 화면은 정규장에만 고른
 * 간격(기본 30분)으로 다시 읽고, 서버가 새 시세를 요청했으면(refreshRequested) 잠시 뒤 한 번만 더 읽습니다. 장 밖에서는 다시 읽지 않고
 * 다음 개장 시각에 한 번 깨어납니다. 모르는 값은 "—"(0으로 채우지 않음)이고 모든 수익률에 기준 시각을 붙입니다.
 */
import { EMPTY, formatKst, formatNumber, formatPercent } from "./format";
import { formatMoney, formatSharePriceFor, type PaperMarketCode } from "./paperMarket";
import type { PaperLiveBook, PaperLivePosition, PaperLiveQuotes, PaperLiveResponse, PaperLiveSession } from "./types";

/** 자동 새로고침 간격(분). 0은 끄기. 시세를 받는 하한이 1분(서버 MAX_AGE_LIVE)이라 더 짧은 간격은 두지 않습니다. */
export const LIVE_REFRESH_OPTIONS = [
  { value: 0, label: "끄기" },
  { value: 1, label: "1분" },
  { value: 2, label: "2분" },
  { value: 5, label: "5분" },
  { value: 10, label: "10분" },
  { value: 15, label: "15분" },
  { value: 30, label: "30분" },
] as const;

/** 기본 간격 — 사용자 결정(2026-10-30). */
export const DEFAULT_LIVE_REFRESH_MINUTES = 30;
export const LIVE_REFRESH_STORAGE_KEY = "paper.liveRefreshMinutes";
/** 서버가 새 시세를 요청한 응답 뒤 한 번 더 읽기까지 — 수집(보유 수십 종목)이 끝날 만한 시간. */
export const LIVE_FOLLOW_UP_MS = 20_000;
/** 다음 개장 뒤 이만큼 기다렸다 깨어납니다(첫 1분봉이 생긴 뒤). */
const OPEN_GRACE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** 저장된 값이 선택지에 있으면 그것, 아니면 기본값. */
export function normalizeLiveMinutes(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return LIVE_REFRESH_OPTIONS.some((option) => option.value === parsed) ? parsed : DEFAULT_LIVE_REFRESH_MINUTES;
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

export interface LiveBookView {
  code: string;
  label: string;
  nav: string;
  returnPct: number | null;
  returnText: string;
  dayChangePct: number | null;
  dayText: string;
  /** 오늘 변화의 기준 — "10-29 확정 대비"(모르면 "—") */
  dayBase: string;
  /** 숫자의 기준 시각 — "장중 10-30 23:58" 또는 "마지막 관측 10-30 06:15"(모르면 "—") */
  basis: string;
  /** 장중 값으로 평가한 종목 수 — "장중 값 3/9종목"·"보유 없음" */
  coverage: string;
  positions: LivePositionView[];
}

/** 계좌 한 줄. 돈은 그 시장 통화(미국 달러 소수 둘째, 한국 원 정수). */
export function liveBookView(book: PaperLiveBook, market: PaperMarketCode = "US"): LiveBookView {
  const basisTime = shortStamp(book.basisAtKst);
  const basis = basisTime === EMPTY ? EMPTY : book.basis === "LIVE" ? `장중 ${basisTime}` : `마지막 관측 ${basisTime}`;
  return {
    code: book.code,
    label: book.label,
    nav: formatMoney(book.nav, market),
    returnPct: book.returnPct,
    returnText: formatPercent(book.returnPct),
    dayChangePct: book.dayChangePct,
    dayText: formatPercent(book.dayChangePct),
    dayBase: book.previousTradingDate ? `${book.previousTradingDate.slice(5)} 확정 대비` : EMPTY,
    basis,
    coverage: book.positionCount === 0 ? "보유 없음" : `장중 값 ${book.liveCount}/${book.positionCount}종목`,
    positions: book.positions.map((position) => livePositionView(position, market)),
  };
}

export interface LivePositionView {
  ticker: string;
  qty: string;
  price: string;
  /** "장중 23:58"·"마지막 관측 10-30 06:15"·"—" */
  priceAt: string;
  live: boolean;
  returnPct: number | null;
  returnText: string;
  dayChangePct: number | null;
  dayText: string;
  weight: string;
}

/** 종목 한 줄 — 가격 기준(장중·마지막 관측)과 시각, 평균 단가 대비·직전 종가 대비, 비중. */
export function livePositionView(position: PaperLivePosition, market: PaperMarketCode = "US"): LivePositionView {
  const at = shortStamp(position.priceAtKst);
  const live = position.priceBasis === "LIVE";
  return {
    ticker: position.ticker,
    qty: formatNumber(position.qty, 0),
    price: formatSharePriceFor(position.price, market),
    priceAt: at === EMPTY || position.priceBasis === null ? EMPTY : live ? `장중 ${at}` : `마지막 관측 ${at}`,
    live,
    returnPct: position.returnPct,
    returnText: formatPercent(position.returnPct),
    dayChangePct: position.dayChangePct,
    dayText: formatPercent(position.dayChangePct),
    weight: position.weightPct === null ? EMPTY : `${formatNumber(position.weightPct, 1)}%`,
  };
}

/** 받지 못한 종목·수집 오류 한 줄(없으면 null) — 그 종목은 마지막 관측 가격으로 평가됐다는 뜻. */
export function liveQuotesWarning(quotes: PaperLiveQuotes | null | undefined): string | null {
  if (!quotes) return null;
  const missing = quotes.missing ?? [];
  if (missing.length === 0 && !quotes.error) return null;
  if (missing.length === 0) return `장중 시세 수집 오류 — ${quotes.error}`;
  const names = `${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` 외 ${missing.length - 5}` : ""}`;
  return `장중 시세를 받지 못한 종목: ${names} — 마지막 관측 가격으로 평가`;
}
