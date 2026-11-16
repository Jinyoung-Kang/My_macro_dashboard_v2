"use client";

import Link from "next/link";
import { AssetList, EntityHeader, EstimateBadge, PropertyList, ProvenanceBadge, Skeleton, SplitPane, StaleBadge } from "@/components/patterns";
import { Banner, Freshness, PageHeader, Panel, Tag } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useEntityCrumb } from "@/hooks/useEntityCrumb";
import { useKrOfficialHolidays } from "@/hooks/useKrOfficialHolidays";
import { useMinuteClock } from "@/hooks/useMinuteClock";
import { useSessionUser } from "@/hooks/useSessionUser";
import {
  detailQuery,
  externalLinks,
  findIndicator,
  INDICATOR_NO_CHART,
  indicatorChartSymbol,
  indicatorHref,
  indicatorNewsQuery,
  indicatorSearchName,
  stockHref,
} from "@/lib/detail";
import { indicatorProperties } from "@/lib/detailEntity";
import { endpoints } from "@/lib/endpoints";
import { withoutLeadingIcon } from "@/lib/format";
import { HOME_REFRESH_MS, macroCardRow, macroCardSession, macroItemSource, MARKET_HREF } from "@/lib/home";
import { infoSearchEntry } from "@/lib/search";
import type { MacroOverview } from "@/lib/types";
import { AiSummaryCard, type DetailLink, ExternalLinksCard, LinkListPanel, NEWS_SOURCES, NewsCard, PriceChartPanel, propertyItems } from "./DetailParts";
import { DetailTabs } from "./DetailTabs";
import { useDetailVisit } from "./useDetailVisit";

/** 최근 연 대상의 보조 글 — 통합 검색 지표 결과와 같은 '범주 · 티커'(범주 앞 그림 문자는 뗌). */
function indicatorVisitSub(categoryTitle: string, ticker: string | null | undefined): string {
  const category = withoutLeadingIcon(categoryTitle) || categoryTitle;
  return ticker ? `${category} · ${ticker}` : category;
}

/** 뼈대 — 위아래 12px(lg 16px), 대상 머리 아래 칸 틀(작업대 대상 문법). */
const ROOT = "flex min-w-0 flex-col gap-3 lg:gap-4";

/**
 * 지표 상세(/markets/i/<지표 id>) — 매크로 카드 하나(환율·국채·원자재·지수)를 작업대 대상 문법(P4 — 정보 검색 대상 화면과 같은 틀)으로:
 * 대상 머리(이름·범주·티커·지금 값·전일 대비·출처·추정·이전 값 배지·신선도) → 왼쪽 속성 · 가운데 탭(개요: 가격 차트 패널·AI 요약 / 뉴스) ·
 * 오른쪽 같은 범주 지표·연결(Yahoo 시세 상세·정보 검색)·다른 곳에서 보기·출처.
 *
 * - 값은 매크로 개요 저장본(live 없이, 홈 시장 표와 같은 5분 간격)의 카드 그대로 — 출처·장 상태·지연·이전 값·추정 배지를 홈 시장 표와 같은 규칙으로.
 * - 차트는 카드 티커의 Yahoo 시계열입니다. 카드 값이 TradingView 실시간 시세면 차트(Yahoo)와 마지막 값이 조금 다를 수 있어 차트 출처를 따로 적습니다.
 *   점은 카드와 같은 단위입니다(엔/원 100엔당 — QA-185). 문지르기는 차트 패널의 읽기 줄(대상 머리는 늘 지금 값 — 명세 W7).
 * - 탭은 화면 안 상태(주소 그대로)이고 숨긴 탭도 처음에 읽습니다(DetailTabs). 결정·사건 기록을 주는 API가 없어 타임라인 탭은 두지 않습니다.
 */
export function IndicatorDetailScreen({ indicatorKey }: { indicatorKey: string }) {
  const overview = useApi<MacroOverview>(endpoints.macro.overview(false), HOME_REFRESH_MS.macro);
  const now = useMinuteClock();
  const krOfficial = useKrOfficialHolidays(now);
  const user = useSessionUser();
  const found = findIndicator(overview.data, indicatorKey);
  // 넓은 화면 빵부스러기의 마지막 칸을 키 대신 지표 이름으로(찾은 뒤에만 — 셸이 같은 주소일 때만 씀).
  const foundHref = found ? indicatorHref(found.item.key) : null;
  useEntityCrumb(foundHref, found?.item.name ?? null);
  // 명령 팔레트의 최근 연 대상 — 찾은 지표만(보조 글은 통합 검색 결과와 같은 '범주 · 티커').
  useDetailVisit("indicator", foundHref, found?.item.name ?? null, found ? indicatorVisitSub(found.category.title, found.item.ticker) : null);

  if (!overview.data) {
    return (
      <div className={ROOT}>
        <EntityHeader
          kind="indicator"
          name={indicatorKey}
          placeholder={overview.error ? <Banner tone="danger">{overview.error}</Banner> : <Skeleton lines={4} label="지표를 불러오는 중" />}
        />
      </div>
    );
  }
  if (!found) {
    return (
      <div className={ROOT}>
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
  // 뉴스·AI 요약의 검색어·이름은 백엔드 상한(60자) 안으로(QA-448).
  const query = detailQuery(indicatorNewsQuery(item.name)) ?? undefined;
  const label = detailQuery(item.name) ?? undefined;
  const related = category.items.filter((entry) => entry.key !== item.key).map((entry) => macroCardRow(entry, clock, indicatorHref(entry.key)));
  const properties = indicatorProperties(item, row, {
    category: categoryTitle,
    source: macroItemSource(item),
    session: macroCardSession(item, clock).label,
  });
  const search = query ? infoSearchEntry(query, user) : null;
  const links: DetailLink[] = [
    ...(symbol ? [{ label: `${symbol} 시세·핵심 지표 보기`, href: stockHref("us", symbol) }] : []),
    ...(search ? [{ label: search.label, href: search.href }] : []),
  ];
  const sources = propertyItems([
    { label: "카드 값", value: macroItemSource(item) },
    { label: "차트", value: symbol ? `Yahoo Finance ${symbol} 일별 종가` : null, emptyReason: symbol ? null : "차트를 그리지 않음" },
    { label: "뉴스", value: NEWS_SOURCES },
  ]);

  return (
    <div className={ROOT}>
      <EntityHeader
        kind="indicator"
        name={item.name}
        // 티커는 고정폭 식별자 태그(명세 §3-6), 보조 글은 범주만 — 티커가 없는 카드(스크래핑)는 태그가 없습니다.
        identifiers={item.ticker ? [item.ticker] : undefined}
        description={categoryTitle}
        value={row.valueText ?? null}
        change={{ change: row.change, changePct: row.changePct, digits: row.changeDigits ?? 2, pctDigits: 2, caption: "전일 대비" }}
        badges={
          <>
            <ProvenanceBadge source={row.source} asOf={row.asOf} delayMin={row.delayMin} title={row.provenanceTitle} />
            <EstimateBadge estimated={row.isEstimated} />
            <StaleBadge stale={row.isStale} reason={row.staleReason} />
            {row.warning ? <Tag tone="warn">{row.warning}</Tag> : null}
          </>
        }
        actions={
          <Freshness
            collectedAt={overview.data.collectedAtKst}
            ageSeconds={overview.data.ageSeconds}
            stale={overview.data.stale}
            refreshError={overview.refreshError}
          />
        }
      />
      <SplitPane
        left={
          <Panel title="속성">
            <PropertyList items={propertyItems(properties)} />
          </Panel>
        }
        right={
          <>
            {related.length > 0 ? (
              <Panel title={`${categoryTitle} — 같은 범주`}>
                <AssetList rows={related} showProvenance headingLevel={3} />
              </Panel>
            ) : null}
            <LinkListPanel title="연결" links={links} />
            {symbol ? <ExternalLinksCard links={externalLinks("us", symbol, symbol, indicatorSearchName(item.name))} /> : null}
            <Panel title="출처">
              <PropertyList items={sources} />
            </Panel>
          </>
        }
      >
        <DetailTabs
          label={`${item.name} 내용`}
          tabs={[
            {
              key: "overview",
              label: "개요",
              content: (
                <>
                  <PriceChartPanel
                    title={item.name}
                    symbol={symbol}
                    cardKey={item.key}
                    valueDigits={row.changeDigits ?? 2}
                    noChartReason={INDICATOR_NO_CHART[item.key] ?? "이 카드는 Yahoo 티커가 없어 차트를 그리지 않습니다."}
                    caption={symbol ? `차트: Yahoo Finance ${symbol} 일별 종가` : null}
                  />
                  <AiSummaryCard request={symbol ? { market: "us", code: symbol, q: query, label } : { q: query, label }} />
                </>
              ),
            },
            { key: "news", label: "뉴스", content: <NewsCard path={endpoints.detail.news({ q: query })} searchQuery={query} /> },
          ]}
        />
      </SplitPane>
    </div>
  );
}
