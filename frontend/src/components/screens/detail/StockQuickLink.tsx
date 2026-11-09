"use client";

import type { ReactNode } from "react";
import type { DetailMarket } from "@/lib/types";
import { StockQuickView } from "./StockQuickView";

/**
 * 표의 종목 칸을 누르면 화면을 떠나지 않고 종목 팝업 창({@link StockQuickView})을 엽니다(사용자 요청 2026-11-10 — 실제 계좌 보유 종목·ISA 계좌 잔고도 모의 매매
 * 보유 표처럼). 창이 읽는 것은 종목 코드뿐이라 계좌 자료는 나가지 않습니다.
 */
export function StockQuickLink({ market, code, children }: { market: DetailMarket; code: string; children: ReactNode }) {
  return (
    <StockQuickView
      market={market}
      code={code}
      trigger={
        <button type="button" className="rounded-sm text-left underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus">
          {children}
        </button>
      }
    />
  );
}
