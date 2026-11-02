/** 화면 실시간 시세(GET /api/live/prices·/stream, ADR 0024) — 저장하지 않는 외부 조회. 모르는 값은 null. */
export type LiveMarketStatus = "OPEN" | "PRE" | "POST" | "CLOSED";

export interface LivePrice {
  /** US(Yahoo 심볼)·KR(6자리)·TV(트레이딩뷰 '거래소:심볼')·NI(네이버 해외 지수 '.INX') — 시장 메뉴 카드는 TV·NI */
  market: "US" | "KR" | "TV" | "NI";
  code: string;
  price: number;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  currency: string | null;
  /** 마지막 거래 시각(ISO UTC) */
  tradedAt: string | null;
  status: LiveMarketStatus | null;
  /** "Yahoo"·"네이버"·"다음"·"토스 1분봉"·"TradingView" */
  source: string;
  /** 출처가 밝힌 시세 지연(분, 0 = 실시간) — 모르면 null(예전 응답에는 없음) */
  delayMinutes?: number | null;
  /** 시간 외(국내 NXT 장 전·장 후, 미국 프리·애프터)가 열려 있을 때 그 가격·전일 대비·거래 시각·구분(PRE_MARKET·AFTER_MARKET) */
  overPrice: number | null;
  overChange: number | null;
  overChangePct: number | null;
  overTradedAt: string | null;
  overSession: string | null;
}

export interface LivePricesPayload {
  fetchedAt: string;
  /** 'US:AAPL' → 종목 */
  items: Record<string, LivePrice>;
  missing: string[];
  errors: Record<string, string>;
}

export interface LivePricesResponse {
  available: boolean;
  message?: string;
  prices?: LivePricesPayload;
}
