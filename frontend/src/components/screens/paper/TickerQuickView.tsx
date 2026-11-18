"use client";

import type { ReactNode } from "react";
import { StockQuickView } from "@/components/screens/detail/StockQuickView";
import { ROW_TRIGGER } from "@/components/ui";
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
        // 표·목록 줄의 이름 단추와 같은 공용 조각(ROW_TRIGGER — 좁은 화면 누름 자리 높이·폭 44px, 넓은 화면 24px, 중립 잉크·밑줄·포커스 링 — QA-738).
        <button type="button" className={ROW_TRIGGER}>
          {children ?? <TickerName code={code} />}
        </button>
      }
    />
  );
}
