"use client";

import { ROW_TRIGGER } from "@/components/ui";
import { parseStockRoute } from "@/lib/detail";
import type { Holding } from "@/lib/types";
import { StockPickQuickView } from "./StockPickQuickView";
import { StockQuickView } from "./StockQuickView";

/**
 * 13F 보유 표의 종목 이름 단추(사용자 요청 2026-11-18) — 누르면 화면을 떠나지 않고 팝업 창으로 그 종목의 주가·정보를 엽니다.
 * 수집기가 붙인 티커(Yahoo 심볼)가 있으면 모의 매매·계좌 표와 같은 종목 팝업({@link StockQuickView}, 미국 시장)을 바로 열고, 없으면 같은 창에서
 * 공시 이름으로 찾은 후보를 사용자가 고르게 합니다({@link StockPickQuickView} — 자동으로 고르지 않음). 티커가 같은 회사의 다른 클래스일 수 있는 줄
 * (백엔드 tickerIsProxy — BRK CL A 줄의 BRK-B 등)도 후보 고르기로 엽니다 — 그 티커의 주가가 그 줄의 시세처럼 보이면 안 됩니다. 단추 이름은 공시 이름
 * 뒤에 무엇이 열리는지를 덧붙입니다(눈에 보이는 이름이 앞에 그대로 — WCAG 2.5.3). 창을 연다는 것은 대화상자 여는 단추의 aria-haspopup="dialog"가 함께 알립니다.
 */
export function HoldingQuickLink({
  holding,
}: {
  holding: Pick<Holding, "name" | "cusip" | "class" | "ticker" | "tickerNote" | "tickerIsProxy">;
}) {
  const ticker = holding.ticker?.trim();
  const proxy = Boolean(ticker && holding.tickerIsProxy);
  const target = ticker && !proxy ? parseStockRoute("us", ticker) : null;
  const trigger = (opens: string) => (
    <button type="button" className={ROW_TRIGGER}>
      {holding.name} <span className="sr-only">{opens}</span>
    </button>
  );
  if (target) return <StockQuickView market={target.market} code={target.code} trigger={trigger("시세 창 열기")} />;
  return (
    <StockPickQuickView
      name={holding.name ?? ""}
      cusip={holding.cusip}
      cls={holding.class}
      tickerNote={holding.tickerNote}
      proxyTicker={proxy ? ticker : null}
      trigger={trigger("종목 후보 창 열기")}
    />
  );
}
