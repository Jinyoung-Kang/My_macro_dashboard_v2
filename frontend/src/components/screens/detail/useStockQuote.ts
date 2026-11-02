"use client";

import { useMemo } from "react";
import { useApi } from "@/hooks/useApi";
import { useLivePrices } from "@/hooks/useLivePrices";
import { useLiveSeconds } from "@/hooks/useLiveSeconds";
import { chartSymbol, kindText, priceDigits } from "@/lib/detail";
import { endpoints } from "@/lib/endpoints";
import { liveKey, type LiveShown, liveShown } from "@/lib/livePrices";
import type { DetailMarket, DetailQuoteResponse, LivePrice } from "@/lib/types";

/**
 * 종목 시세 한 벌 — 종목 상세 화면과 모의 매매의 종목 팝업 창이 함께 씁니다. 시세·지표·개요는 GET /api/detail/quote(5분 캐시), 가격·전일
 * 대비는 실시간 시세(ADR 0024 — 고른 주기마다 서버가 밀어 줌, 프리장·애프터장이 열려 있으면 그 가격)가 오면 그 값.
 *
 * @param enabled false면 아무것도 읽지 않습니다(닫힌 팝업 창).
 */
export function useStockQuote(market: DetailMarket, code: string, enabled = true) {
  const quoteState = useApi<DetailQuoteResponse>(enabled ? endpoints.detail.quote(market, code) : null);
  const quote = quoteState.data?.quote ?? null;
  const [liveSeconds] = useLiveSeconds();
  const liveItems = useMemo(() => [liveKey(market === "kr" ? "KR" : "US", code)], [market, code]);
  const realtime = useLivePrices(liveItems, liveSeconds, enabled && Boolean(quoteState.data?.available));
  const live: LivePrice | null = realtime.prices[liveItems[0]] ?? null;
  const shown: LiveShown | null = live ? liveShown(live) : null;
  return {
    quoteState,
    quote,
    realtime,
    live,
    shown,
    price: shown?.price ?? quote?.price ?? null,
    change: shown ? shown.change : quote?.change ?? null,
    changePct: shown ? shown.changePct : quote?.changePct ?? null,
    name: quote?.nameKo ?? quote?.name ?? code,
    symbol: chartSymbol(market, code, quote),
    digits: priceDigits(quote?.price, quote?.currency),
    // 한글 이름이 있으면(미국 주식 — 네이버 해외주식) 제목은 한글, 영문 이름은 보조 줄에.
    sub: [quote?.nameKo && quote?.name ? quote.name : null, code, quote?.exchange, kindText(quote?.kind), quote?.currency]
      .filter(Boolean).join(" · "),
  };
}
