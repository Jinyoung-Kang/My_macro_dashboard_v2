"use client";

import Link from "next/link";
import { type ReactElement, useState } from "react";
import { LiveIntervalSelect } from "@/components/LiveIntervalSelect";
import { Skeleton } from "@/components/patterns";
import { Dialog } from "@/components/ui/Dialog";
import { currencyUnit, type QuickProfile, quickProfile, statText, stockHref } from "@/lib/detail";
import { formatNumber } from "@/lib/format";
import { liveStatusText, tradedAtText } from "@/lib/livePrices";
import type { DetailMarket } from "@/lib/types";
import { KeyStats, PriceHero, statRows } from "./DetailParts";
import { useStockQuote } from "./useStockQuote";

/** 팝업 창에 보일 핵심 지표 수 — 나머지는 상세 화면. */
const QUICK_STATS = 8;

/**
 * 종목 팝업 창(사용자 요청 2026-11-03 — 모의 매매 장중 카드·보유 표의 종목을 누르면 화면을 떠나지 않고). 종목 상세와 같은 시세 한 벌(useStockQuote):
 * 가격·전일 대비는 실시간 시세(고른 주기마다 서버가 밀어 줌, 프리장·애프터장 가격 포함), 차트는 Yahoo 시계열, 핵심 지표 몇 개와 '상세 화면 열기'.
 * 이름 아래에 간략한 기업 설명(업종·개요 앞부분 — 사용자 요청 2026-11-03, lib/detail quickProfile)을 둡니다. 전체 개요는 상세 화면의 '회사 개요'.
 * 열려 있을 때만 읽고 받습니다(닫으면 실시간 연결도 닫힘).
 */
export function StockQuickView({ market, code, trigger }: { market: DetailMarket; code: string; trigger: ReactElement }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen} title={code} hideTitle trigger={trigger} size="lg">
      {open && <QuickBody market={market} code={code} />}
    </Dialog>
  );
}

function QuickBody({ market, code }: { market: DetailMarket; code: string }) {
  const { quoteState, quote, realtime, live, shown, price, change, changePct, name, symbol, digits, sub } = useStockQuote(market, code);
  const brief = quickProfile(quote);
  let placeholder;
  if (!quoteState.data) {
    placeholder = quoteState.error ? <p className="text-sm text-danger">{quoteState.error}</p> : <Skeleton lines={2} label="시세를 불러오는 중" />;
  } else if (!quoteState.data.available) {
    placeholder = <p className="text-sm text-text-2">{quoteState.data.message ?? "시세를 조회하지 않습니다."}</p>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="min-w-0">
        <p className="text-title-2 text-text">{name}</p>
        {sub && <p className="text-xs text-text-2">{sub}</p>}
      </div>
      {brief ? <QuickProfileNote brief={brief} /> : null}
      <PriceHero
        label={`${name} 시세`}
        valueText={price !== null ? formatNumber(price, digits) : null}
        unit={currencyUnit(quote?.currency)}
        change={change}
        changePct={changePct}
        changeDigits={digits}
        valueDigits={digits}
        symbol={symbol}
        placeholder={placeholder}
        meta={
          <>
            {live && shown ? (
              <span className="text-xs text-text-2">
                {shown.session ?? "실시간"} {tradedAtText(shown.tradedAt)} KST
                {!shown.session && liveStatusText(live.status) ? ` · ${liveStatusText(live.status)}` : ""} · {live.source}
              </span>
            ) : null}
            <LiveIntervalSelect />
            {realtime.error ? <span className="text-xs text-warn">{realtime.error}</span> : null}
          </>
        }
      />
      {quote ? (
        <KeyStats rows={statRows(quote.stats.slice(0, QUICK_STATS), (stat) => statText(stat, quote.currency))} />
      ) : null}
      <div className="flex justify-end">
        <Link
          href={stockHref(market, code)}
          className="rounded-sm text-sm font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus"
        >
          상세 화면 열기
        </Link>
      </div>
    </div>
  );
}

/** 간략한 기업 설명 — 업종 줄·개요 앞부분·출처(한국어 개요가 없어 영문 원문이면 그렇다고 적음). 개요가 없으면 그리지 않습니다. */
function QuickProfileNote({ brief }: { brief: QuickProfile }) {
  return (
    <section aria-label="기업 설명" className="flex min-w-0 flex-col gap-1">
      {brief.industry ? <p className="text-xs text-text-2">{brief.industry}</p> : null}
      <p className="text-sm leading-relaxed text-text">{brief.text}</p>
      <p className="text-xs text-text-3">
        {brief.english ? "한국어 개요가 없어 영문 원문의 앞부분입니다 · " : ""}
        {brief.source ? `출처 ${brief.source} · ` : ""}전체 개요는 상세 화면
      </p>
    </section>
  );
}
