"use client";

import type { ReactNode } from "react";
import { StockQuickView } from "@/components/screens/detail/StockQuickView";
import type { PaperMarketCode } from "@/lib/paperMarket";
import { TickerName } from "./TickerName";

/**
 * 종목 이름(국내는 기업명 — TickerName)을 누르면 화면 안 팝업 창으로 그 종목의 실시간 가격·차트·핵심 지표를 엽니다(사용자 결정 2026-11-03 — 상세
 * 화면으로 옮겨 가는 대신). 창 안에 '상세 화면 열기'가 있습니다.
 */
export function TickerQuickView({ market, code, children }: { market: PaperMarketCode; code: string; children?: ReactNode }) {
  return (
    <StockQuickView
      market={market === "KR" ? "kr" : "us"}
      code={code}
      trigger={
        <button
          type="button"
          className="rounded-sm text-left underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus"
        >
          {children ?? <TickerName code={code} />}
        </button>
      }
    />
  );
}
