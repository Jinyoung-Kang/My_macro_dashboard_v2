"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { stockHref } from "@/lib/detail";
import type { PaperMarketCode } from "@/lib/paperMarket";
import { TickerName } from "./TickerName";

/**
 * 종목 이름(국내는 기업명 — TickerName)을 누르면 그 종목 상세(/s/<시장>/<코드>)로 갑니다(사용자 요청 2026-11-03 — 장중 카드·보유 표).
 * 상세 화면도 같은 실시간 주기로 가격이 움직입니다.
 */
export function TickerLink({ market, code, children }: { market: PaperMarketCode; code: string; children?: ReactNode }) {
  return (
    <Link
      href={stockHref(market === "KR" ? "kr" : "us", code)}
      className="rounded-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus"
    >
      {children ?? <TickerName code={code} />}
    </Link>
  );
}
