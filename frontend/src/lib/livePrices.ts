/**
 * 화면 실시간 시세(ADR 0024) — 모의 매매 장중 카드·보유 표·종목 상세가 함께 쓰는 주기 설정과 표시 규칙.
 *
 * 주기는 이 브라우저에 하나(localStorage)라 장중 카드·보유 표·종목 상세 어디서 바꿔도 같은 값입니다(사용자 결정 2026-11-03 — 기본 1시간, 5·10·30초를
 * 더함). 값은 서버가 고른 주기마다 밀어 주고(SSE — hooks/useLivePrices), 저장하지 않으며 장부(체결·스탑·통계·결정)는 쓰지 않습니다. 모르는 값은 "—".
 */
import { EMPTY } from "./format";
import type { LiveMarketStatus, LivePrice } from "./types";

/** 고를 수 있는 주기(초) — 서버의 목록(LivePriceService.INTERVALS)과 같습니다. 0은 끄기(화면을 열 때 한 번만 읽음). */
export const LIVE_SECONDS_OPTIONS = [
  { value: 0, label: "끄기" },
  { value: 5, label: "5초" },
  { value: 10, label: "10초" },
  { value: 30, label: "30초" },
  { value: 60, label: "1분" },
  { value: 120, label: "2분" },
  { value: 300, label: "5분" },
  { value: 600, label: "10분" },
  { value: 900, label: "15분" },
  { value: 1800, label: "30분" },
  { value: 3600, label: "1시간" },
  { value: 10800, label: "3시간" },
] as const;

/** 기본 주기 — 사용자 결정(2026-11-03). */
export const DEFAULT_LIVE_SECONDS = 3600;
export const LIVE_SECONDS_STORAGE_KEY = "live.priceRefreshSeconds";
/** 예전 장중 카드의 분 단위 설정 — 새 값이 없을 때 한 번 옮겨 읽습니다(고른 값을 잃지 않게). */
export const LEGACY_MINUTES_STORAGE_KEY = "paper.liveRefreshMinutes";

/** 선택지에 있는 값이면 그것, 아니면 기본값. */
export function normalizeLiveSeconds(value: unknown): number {
  const parsed = typeof value === "number" ? value : value === null || value === undefined || value === "" ? NaN : Number(value);
  return LIVE_SECONDS_OPTIONS.some((option) => option.value === parsed) ? parsed : DEFAULT_LIVE_SECONDS;
}

/** 저장된 주기 — 새 키, 없으면 예전 분 단위 키(× 60이 선택지에 있을 때), 둘 다 없으면 기본값. */
export function storedLiveSeconds(storage: Pick<Storage, "getItem"> | null | undefined): number {
  const current = storage?.getItem(LIVE_SECONDS_STORAGE_KEY);
  if (current !== null && current !== undefined) return normalizeLiveSeconds(current);
  const legacy = Number(storage?.getItem(LEGACY_MINUTES_STORAGE_KEY) ?? NaN);
  return Number.isFinite(legacy) ? normalizeLiveSeconds(legacy * 60) : DEFAULT_LIVE_SECONDS;
}

/** 주기 이름 — 선택지의 이름('5초'·'1시간'), 없으면 'n초'. */
export function liveSecondsText(seconds: number): string {
  return LIVE_SECONDS_OPTIONS.find((option) => option.value === seconds)?.label ?? `${seconds}초`;
}

/**
 * 장중 카드의 서버 평가(GET /api/paper/live — 계좌의 지금 값, 장중 저장본)를 다시 읽을 간격(분). 그 저장본은 60초보다 자주 새로 받지 않으므로
 * (서버 MAX_AGE_LIVE) 1분보다 짧은 주기도 1분으로 읽습니다. 끄기는 0.
 */
export function serverRefreshMinutes(seconds: number): number {
  return seconds <= 0 ? 0 : Math.max(1, Math.round(seconds / 60));
}

/** 종목 열쇠 'US:AAPL'·'KR:005930' — 서버 응답의 열쇠와 같습니다. */
export function liveKey(market: "US" | "KR", code: string): string {
  return `${market}:${code.trim().toUpperCase()}`;
}

/** 출처가 밝힌 시각(livePriceTitle의 '기준' 시각) → KST "HH:mm:ss"(모르면 "—"). */
export function tradedAtText(iso: string | null | undefined): string {
  if (!iso) return EMPTY;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return EMPTY;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(at);
}

/** 장 상태 이름 — 정규장·시간 외(프리·애프터, 국내 NXT)·장 마감. 모르면 빈 글. */
export function liveStatusText(status: LiveMarketStatus | null | undefined): string {
  switch (status) {
    case "OPEN":
      return "정규장";
    case "PRE":
      return "시간 외(장 전)";
    case "POST":
      return "시간 외(장 후)";
    case "CLOSED":
      return "장 마감";
    default:
      return "";
  }
}

/**
 * 가격 칸의 설명(title) — 출처 · 기준 시각 KST · 장 상태 · 시간 외 가격. 시각은 '거래'가 아니라 '기준'입니다: 미국·다음·시간 외는 마지막
 * 거래 시각이지만 네이버 국내 정규장은 응답한 순간이라 체결이 없던 종목도 지금 시각입니다(QA-167).
 */
export function livePriceTitle(price: LivePrice, formatPrice: (value: number) => string): string {
  const shown = liveShown(price);
  const parts = [`실시간 ${price.source}`, `기준 ${tradedAtText(shown.tradedAt)} KST`];
  const status = shown.session ?? liveStatusText(price.status);
  if (status) parts.push(status);
  if (shown.session) parts.push(`정규장 종가 ${formatPrice(price.price)}`);
  return parts.join(" · ");
}

/** 평균 단가 대비 %(가격·평단 중 하나라도 모르면 null). */
export function returnVsCost(price: number | null | undefined, avgCost: number | null | undefined): number | null {
  if (price === null || price === undefined || !avgCost) return null;
  return (price / avgCost - 1) * 100;
}

/** 화면에 보일 값 — 시간 외가 열려 있으면 그 가격·전일 대비·거래 시각과 이름, 아니면 정규장 값. */
export interface LiveShown {
  price: number;
  change: number | null;
  changePct: number | null;
  tradedAt: string | null;
  /** "프리장"·"애프터장"(국내는 "(NXT)"를 붙임), 정규장·마감이면 null */
  session: string | null;
}

/**
 * 실시간 값에서 화면에 보일 가격(사용자 요청 2026-11-03 — 프리장·애프터장 가격을 받을 수 있으면 보임). 장 상태가 PRE·POST이고 시간 외 가격이 있으면
 * 그 값을, 아니면 정규장 값을 씁니다. 장부·체결은 이 값을 쓰지 않습니다.
 */
export function liveShown(price: LivePrice): LiveShown {
  if ((price.status === "PRE" || price.status === "POST") && price.overPrice !== null && price.overPrice !== undefined) {
    const name = price.status === "PRE" ? "프리장" : "애프터장";
    return {
      price: price.overPrice,
      change: price.overChange ?? null,
      changePct: price.overChangePct ?? null,
      tradedAt: price.overTradedAt ?? price.tradedAt,
      session: price.market === "KR" ? `${name}(NXT)` : name,
    };
  }
  return { price: price.price, change: price.change, changePct: price.changePct, tradedAt: price.tradedAt, session: null };
}
