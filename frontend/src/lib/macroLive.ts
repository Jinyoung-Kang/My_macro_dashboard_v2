/**
 * 시장 메뉴 매크로 카드의 실시간 값(ADR 0024 2단계) — 카드마다 실시간 종목을 정해 두고, 받은 값이 있으면 카드의 가격·전일 대비·시각·출처·지연을
 * 그 값으로 바꿔 그립니다. 저장본(카드 스냅숏·AI 입력·금리차 계산)은 그대로입니다 — 표시 전용.
 *
 * 종목은 카드와 같은 상품입니다(지수는 지수, 선물은 같은 연결 선물). 지연은 출처가 밝힌 값을 배지에 그대로 적습니다 — 2026-11-03 실측
 * (TradingView global/scan update_mode·네이버 delayTime): 달러 인덱스·환율·미국채·코스피·닛케이·항셍 지수, S&P 500·나스닥 100 지수(네이버)는
 * 실시간, WTI·브렌트·금·미국 지수 선물은 10분, 상하이 종합은 15분 지연.
 */
import { EMPTY } from "./format";
import { liveShown, tradedAtText } from "./livePrices";
import type { LivePrice, MacroCategory, MacroItem } from "./types";

/** 카드 열쇠 → 실시간 종목('TV:거래소:심볼'·'NI:.지수'). 없는 카드(지수 대체·스크래핑 전용)는 저장본 그대로. */
export const MACRO_LIVE: Readonly<Record<string, string>> = {
  dxy: "TV:TVC:DXY",
  usdkrw: "TV:FX_IDC:USDKRW",
  usdjpy: "TV:FX_IDC:USDJPY",
  jpykrw: "TV:FX_IDC:JPYKRW",
  us02y: "TV:TVC:US02Y",
  us10y: "TV:TVC:US10Y",
  us30y: "TV:TVC:US30Y",
  wti: "TV:NYMEX:CL1!",
  brent: "TV:ICEEUR:BRN1!",
  gold: "TV:COMEX:GC1!",
  sp500: "NI:.INX",
  sp500_fut: "TV:CME_MINI:ES1!",
  ndx: "NI:.NDX",
  ndx_fut: "TV:CME_MINI:NQ1!",
  kospi: "TV:KRX:KOSPI",
  nikkei: "TV:TVC:NI225",
  shanghai: "TV:SSE:000001",
  hsi: "TV:TVC:HSI",
  kospi200_night_scraped: "TV:KRX:K2I1!",
  nikkei_fut_scraped: "TV:OSE:NK2251!",
  hsi_fut_scraped: "TV:HKEX:HSI1!",
};

/** 카드 하나의 실시간 종목 — 선물 조회가 실패해 지수로 대신 보이는 카드("(선물 대체)")는 선물 값을 얹지 않습니다. */
export function macroLiveItem(item: MacroItem): string | null {
  if (item.name.includes("선물 대체")) return null;
  return MACRO_LIVE[item.key] ?? null;
}

/** 화면에 있는 카드들의 실시간 종목(순서 유지, 같은 것은 하나). */
export function macroLiveItems(categories: readonly MacroCategory[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const category of categories ?? []) {
    for (const item of category.items) {
      const live = macroLiveItem(item);
      if (live) out.add(live);
    }
  }
  return [...out];
}

/** 실시간 값을 얹은 카드 — live가 있으면 그 시각(KST 'HH:mm:ss')과 그것이 거래 시각인지 받은 시각인지. */
export type MacroCardView = MacroItem & { live?: { at: string; received: boolean; session: string | null } };

/** 카드에 얹을 실시간 값의 재료 — hooks/useLivePrices 상태 가운데 이것만 읽습니다. */
export interface MacroLiveState {
  prices: Readonly<Record<string, LivePrice>>;
  /** 종목마다 받은 때(ms) */
  receivedAtByKey: Readonly<Record<string, number>>;
  /** 마지막 응답에 없던 종목 */
  missing: readonly string[];
  /** 연결이 닫혀 다시 열기를 기다리는 중(QA-183) */
  disconnected: boolean;
}

/** 카드 글의 소수 자릿수 — 저장본 priceStr('4.596' → 3, '1,345.72' → 2), 모르면 2. */
function cardDigits(priceStr: string | null | undefined): number {
  const text = (priceStr ?? "").replace(/,/g, "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return 2;
  return text.includes(".") ? text.split(".")[1].length : 0;
}

function fixed(value: number, digits: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function signed(value: number, digits: number): string {
  return `${value < 0 ? "-" : "+"}${fixed(Math.abs(value), digits)}`;
}

/** 엔/원은 100엔당 카드 — 1엔당(50 미만)으로 온 값은 100을 곱합니다(수집기 market.quote_scale과 같은 규칙). */
function scaleFor(key: string, raw: number): number {
  return key === "jpykrw" && raw < 50 ? 100 : 1;
}

/** ISO → "YYYY-MM-DD HH:mm:ss KST"(카드 lastTs 형식 — 개장 배지가 체결 시각으로 읽음). */
function kstStamp(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")} KST`;
}

/**
 * 카드 하나 → 그릴 카드(QA-184). 실시간 종목이 마지막 응답에 있었을 때만 그 값을 얹고 받은 시각은 그 종목의 것입니다. 마지막 응답에서 빠졌거나(출처
 * 실패·받지 못한 응답) 연결이 닫혀 다시 열기를 기다리는 동안은 저장본 카드 그대로 — 옛 실시간 값을 '방금 받은 실시간'으로 그리지 않고, 저장본의 이전 값
 * 표시도 살아납니다.
 */
export function macroCardView(item: MacroItem, live: MacroLiveState): MacroCardView {
  const code = macroLiveItem(item);
  if (!code || live.disconnected || live.missing.includes(code)) return item;
  return withLive(item, live.prices[code], live.receivedAtByKey[code] ?? null);
}

/**
 * 머리말의 실시간 시세 한 줄 — 사유가 없으면 null. 실시간 값을 얹은 카드가 하나도 없으면 '카드는 저장본 값', 있으면 '받지 못한 카드는 저장본 값'
 * (일부만 받은 응답 — QA-184).
 */
export function macroLiveNotice(reason: string | null, categories: readonly { items: readonly MacroCardView[] }[] | null | undefined): string | null {
  if (!reason) return null;
  const overlaid = (categories ?? []).some((category) => category.items.some((item) => item.live !== undefined));
  return `실시간 시세: ${reason} — ${overlaid ? "받지 못한 카드는" : "카드는"} 저장본 값입니다.`;
}

/**
 * 카드 + 실시간 값 → 그릴 카드. 값이 없으면 카드 그대로. 가격·전일 대비 자릿수는 카드 글을 따르고, 거래 시각을 모르는 출처(TradingView)는 받은 시각을
 * 적되 개장 배지에는 카드의 원래 시각을 둡니다(받은 시각을 체결 시각으로 읽어 휴장일을 놓치지 않게). `receivedAt`은 그 종목을 받은 때(QA-184).
 */
export function withLive(item: MacroItem, live: LivePrice | undefined, receivedAt: number | null): MacroCardView {
  if (!live || !Number.isFinite(live.price)) return item;
  const shown = liveShown(live);
  const scale = scaleFor(item.key, shown.price);
  const digits = cardDigits(item.priceStr);
  const price = shown.price * scale;
  const prevRaw = shown.session === null && live.prevClose !== null
    ? live.prevClose
    : shown.change !== null ? shown.price - shown.change : live.prevClose;
  const prev = prevRaw === null ? null : prevRaw * scale;
  const delta = shown.change !== null ? shown.change * scale : prev !== null ? price - prev : null;
  const pct = shown.changePct ?? (delta !== null && prev ? (delta / prev) * 100 : null);
  const stamp = shown.tradedAt ? kstStamp(shown.tradedAt) : null;
  const received = stamp === null;
  const at = received
    ? (receivedAt === null ? EMPTY : tradedAtText(new Date(receivedAt).toISOString()))
    : tradedAtText(shown.tradedAt);
  return {
    ...item,
    status: "ok",
    price,
    priceStr: fixed(price, digits),
    delta,
    pct,
    deltaStr: delta !== null && pct !== null ? `${signed(delta, digits)} (${signed(pct, 2)}%)` : EMPTY,
    prevValue: prev,
    prevStr: prev === null ? EMPTY : fixed(prev, digits),
    prevSource: null,
    lastTs: stamp ?? item.lastTs,
    source: `실시간 ${live.source} (${live.code})`,
    delayMinutes: live.delayMinutes ?? null,
    isReference: live.source === "TradingView",
    isStale: false,
    staleReason: null,
    live: { at, received, session: shown.session },
  };
}
