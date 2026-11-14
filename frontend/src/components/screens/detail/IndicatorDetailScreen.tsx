"use client";

import Link from "next/link";
import { AssetList, EstimateBadge, ProvenanceBadge, Skeleton, StaleBadge } from "@/components/patterns";
import { Banner, Card, Freshness, PageHeader } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useKrOfficialHolidays } from "@/hooks/useKrOfficialHolidays";
import { useMinuteClock } from "@/hooks/useMinuteClock";
import {
  externalLinks,
  findIndicator,
  INDICATOR_NO_CHART,
  indicatorChartSymbol,
  indicatorHref,
  indicatorNewsQuery,
  indicatorSearchName,
  stockHref,
} from "@/lib/detail";
import { endpoints } from "@/lib/endpoints";
import { withoutLeadingIcon } from "@/lib/format";
import { HOME_REFRESH_MS, macroCardRow, MARKET_HREF } from "@/lib/home";
import type { MacroOverview } from "@/lib/types";
import { AiSummaryCard, ExternalLinksCard, NewsCard, PriceHero } from "./DetailParts";

/**
 * 지표 상세(/markets/i/<지표 id>) — 매크로 카드 하나(환율·국채·원자재·지수): 카드 값 히어로와 Yahoo 시계열 차트 → AI 요약 → 주요 뉴스(지표 이름으로
 * 구글 뉴스 검색), 옆 칸에 같은 범주 지표(누르면 그 상세)·Yahoo 시세 상세 링크·외부 링크.
 *
 * - 값은 매크로 개요 저장본(live 없이, 홈 시장 행과 같은 5분 간격)의 카드 그대로 — 출처·장 상태·지연·이전 값·추정 배지를 홈 시장 행과 같은 규칙으로.
 * - 차트는 카드 티커의 Yahoo 시계열입니다. 카드 값이 TradingView 실시간 시세면 차트(Yahoo)와 마지막 값이 조금 다를 수 있어 차트 출처를 따로 적습니다.
 *   점은 카드와 같은 단위입니다(엔/원 100엔당 — QA-185).
 */
export function IndicatorDetailScreen({ indicatorKey }: { indicatorKey: string }) {
  const overview = useApi<MacroOverview>(endpoints.macro.overview(false), HOME_REFRESH_MS.macro);
  const now = useMinuteClock();
  const krOfficial = useKrOfficialHolidays(now);
  const found = findIndicator(overview.data, indicatorKey);

  if (!overview.data) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <PageHeader title="지표" />
        {overview.error ? <Banner tone="danger">{overview.error}</Banner> : <Skeleton lines={4} label="지표를 불러오는 중" />}
      </div>
    );
  }
  if (!found) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <PageHeader title="지표를 찾지 못했습니다" />
        <p className="text-sm text-text-2">
          매크로 카드 저장본에 ‘{indicatorKey}’ 지표가 없습니다.{" "}
          <Link href={MARKET_HREF} className="text-text underline underline-offset-2">
            매크로 지표 전체 보기
          </Link>
        </p>
      </div>
    );
  }

  const { item, category } = found;
  const clock = { now, krOfficial, collectedAt: overview.data.collectedAtKst ?? null };
  const row = macroCardRow(item, clock);
  const symbol = indicatorChartSymbol(item);
  const categoryTitle = withoutLeadingIcon(category.title) || category.title;
  const query = indicatorNewsQuery(item.name);
  const related = category.items.filter((entry) => entry.key !== item.key).map((entry) => macroCardRow(entry, clock, indicatorHref(entry.key)));

  return (
    <div className="flex min-w-0 flex-col gap-6 lg:gap-8">
      <PageHeader
        title={item.name}
        description={[categoryTitle, item.ticker].filter(Boolean).join(" · ")}
        actions={
          <Freshness
            collectedAt={overview.data.collectedAtKst}
            ageSeconds={overview.data.ageSeconds}
            stale={overview.data.stale}
            refreshError={overview.refreshError}
          />
        }
      />
      <PriceHero
        label={item.name}
        valueText={row.valueText ?? null}
        change={row.change}
        changePct={row.changePct}
        changeDigits={row.changeDigits ?? 2}
        valueDigits={row.changeDigits ?? 2}
        symbol={symbol}
        cardKey={item.key}
        noChartReason={INDICATOR_NO_CHART[item.key] ?? "이 카드는 Yahoo 티커가 없어 차트를 그리지 않습니다."}
        meta={
          <>
            <ProvenanceBadge source={row.source} asOf={row.asOf} delayMin={row.delayMin} title={row.provenanceTitle} />
            <EstimateBadge estimated={row.isEstimated} />
            <StaleBadge stale={row.isStale} reason={row.staleReason} />
            {row.warning ? <span className="text-xs text-warn">{row.warning}</span> : null}
            {item.prevStr ? <span className="text-xs text-text-3">전일 {item.prevStr}</span> : null}
            {symbol ? <span className="basis-full text-xs text-text-3">차트: Yahoo Finance {symbol} 일별 종가</span> : null}
          </>
        }
      />

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:gap-8">
        <div className="flex min-w-0 flex-col gap-6 lg:gap-8">
          <AiSummaryCard request={symbol ? { market: "us", code: symbol, q: query, label: item.name } : { q: query, label: item.name }} />
          <NewsCard path={endpoints.detail.news({ q: query })} searchQuery={query} />
        </div>
        <div className="flex min-w-0 flex-col gap-6 lg:gap-8">
          {related.length > 0 ? (
            <Card title={`${categoryTitle} — 같은 범주`}>
              <AssetList rows={related} showProvenance headingLevel={3} />
            </Card>
          ) : null}
          {symbol ? (
            <Card title="Yahoo 시세 상세">
              <p className="text-sm text-text-2">
                <Link href={stockHref("us", symbol)} className="text-text underline underline-offset-2">
                  {symbol} 시세·핵심 지표 보기
                </Link>
              </p>
            </Card>
          ) : null}
          {symbol ? <ExternalLinksCard links={externalLinks("us", symbol, symbol, indicatorSearchName(item.name))} /> : null}
        </div>
      </div>
    </div>
  );
}
