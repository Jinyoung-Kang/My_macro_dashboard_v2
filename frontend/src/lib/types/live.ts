/** 화면 실시간 시세(GET /api/live/prices·/stream, ADR 0024) — 저장하지 않는 외부 조회. 모르는 값은 null. */
export type LiveMarketStatus = "OPEN" | "PRE" | "POST" | "CLOSED";

export interface LivePrice {
  market: "US" | "KR";
  code: string;
  price: number;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  currency: string | null;
  /** 마지막 거래 시각(ISO UTC) */
  tradedAt: string | null;
  status: LiveMarketStatus | null;
  /** "Yahoo"·"네이버"·"다음"·"토스 1분봉" */
  source: string;
  /** 시간 외(국내 NXT·미국 프리·애프터)가 열려 있을 때 그 가격 */
  overPrice: number | null;
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
