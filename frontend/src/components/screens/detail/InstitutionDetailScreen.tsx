"use client";

import Link from "next/link";
import { LineChart } from "@/components/charts";
import { Hero, ProvenanceBadge, Skeleton } from "@/components/patterns";
import { Banner, Card, Freshness, PageHeader } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { CHART_KEY, institutionLinks, institutionNames, institutionValueRows } from "@/lib/detail";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, formatNumber, formatSignedMinus, formatUsd, withoutLeadingIcon } from "@/lib/format";
import type { PortfolioResponse } from "@/lib/types";
import { AiSummaryCard, ExternalLinksCard, NewsCard } from "./DetailParts";

/** 13F 포트폴리오 화면과 같은 요청 값(같은 응답 캐시) — 8분기, 비중 추이 상위 30. */
const QUARTERS = 8;
const TOP_N = 30;
/** 보유 종목 표에 보이는 줄 수. */
const HOLDINGS_SHOWN = 15;

/**
 * 기관 상세(/institutions/<CIK>) — 13F 기관 한 곳: 최근 분기 평가액 히어로와 분기별 평가액 추이 → 상위 보유 종목(비중·평가액·지난 분기 대비) →
 * AI 요약 → 주요 뉴스(기관 영문 이름으로 구글 뉴스 검색), 옆 칸에 기관 소개·SEC EDGAR 링크.
 *
 * - 값은 이 대시보드의 13F 저장본(SEC EDGAR, 분기마다 45일 안에 공시 — 지금 보유와 다를 수 있음).
 * - 보유 종목·분기 수를 바꿔 보는 표·비중 추이는 13F 포트폴리오 화면에 있습니다.
 */
export function InstitutionDetailScreen({ cik }: { cik: string }) {
  const portfolio = useApi<PortfolioResponse>(endpoints.institution.portfolio(cik, QUARTERS, TOP_N));
  const data = portfolio.data;
  const names = institutionNames(data?.institution?.name ?? `CIK ${cik}`);
  const rows = institutionValueRows(data?.quarters);
  const holdings = data?.holdings ?? [];

  let placeholder;
  if (!data) {
    placeholder = portfolio.error ? <Banner tone="danger">{portfolio.error}</Banner> : <Skeleton lines={2} label="13F 포트폴리오를 불러오는 중" />;
  } else if (!data.available) {
    placeholder = <p className="text-sm text-text-2">{data.message ?? "13F 저장본이 없습니다."}</p>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 lg:gap-8">
      <PageHeader
        title={names.display}
        description={`13F 기관 · CIK ${cik}`}
        actions={data ? <Freshness collectedAt={data.collectedAtKst} ageSeconds={data.ageSeconds} refreshError={portfolio.refreshError} /> : undefined}
      />
      <Hero
        label="13F 보고 평가액"
        value={data?.latest?.totalValue !== null && data?.latest?.totalValue !== undefined ? formatUsd(data.latest.totalValue) : null}
        placeholder={placeholder}
        meta={
          data?.latest ? (
            <>
              <span className="text-xs tabular-nums text-text-2">
                보고 기준일 {data.latest.reportDate} · 공시일 {data.latest.filingDate}
              </span>
              <ProvenanceBadge source="SEC EDGAR 13F" />
            </>
          ) : undefined
        }
      >
        {rows.length > 1 ? (
          <LineChart
            data={rows}
            series={[{ key: CHART_KEY, label: "13F 보고 평가액" }]}
            variant="hero"
            nonNegative
            valueFormat={(value) => formatUsd(value)}
            ariaLabel={`${names.display} 분기별 13F 보고 평가액`}
          />
        ) : null}
      </Hero>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:gap-8">
        <div className="flex min-w-0 flex-col gap-6 lg:gap-8">
          <Card
            title="상위 보유 종목"
            subtitle={data?.latest ? `${data.latest.reportDate} 보고 기준 · 비중 순 · 지난 분기 대비` : undefined}
            source="SEC EDGAR 13F"
            actions={
              <Link href="/institutions" className="rounded-sm text-xs font-medium text-text underline-offset-2 hover:underline">
                13F 포트폴리오에서 자세히
              </Link>
            }
          >
            {!data ? (
              <Skeleton lines={5} label="보유 종목을 불러오는 중" />
            ) : holdings.length === 0 ? (
              <p className="text-sm text-text-2">{data.message ?? "보유 종목이 없습니다."}</p>
            ) : (
              <ul className="-my-1 divide-y divide-border">
                {holdings.slice(0, HOLDINGS_SHOWN).map((holding) => (
                  <li key={`${holding.cusip}:${holding.class}`} className="flex items-baseline justify-between gap-3 py-2.5 text-sm">
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-text">{holding.name}</span>
                      <span className="block truncate text-xs text-text-3">
                        {[holding.class, withoutLeadingIcon(holding.action), holding.weightDiff !== null ? `비중 ${formatSignedMinus(holding.weightDiff, 2).text}%p` : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <span className="shrink-0 text-right tabular-nums">
                      <span className="block font-medium text-text">{holding.weight !== null ? `${formatNumber(holding.weight, 2)}%` : EMPTY}</span>
                      <span className="block text-xs text-text-3">{formatUsd(holding.value)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {holdings.length > HOLDINGS_SHOWN ? <p className="mt-2 text-xs text-text-3">{holdings.length}종목 가운데 비중 상위 {HOLDINGS_SHOWN}종목</p> : null}
          </Card>
          <AiSummaryCard request={{ q: names.query, label: names.display }} />
          <NewsCard path={endpoints.detail.news({ q: names.query })} />
        </div>
        <div className="flex min-w-0 flex-col gap-6 lg:gap-8">
          {data?.institution?.desc ? (
            <Card title="기관 소개">
              <p className="text-sm leading-relaxed text-text-2">{withoutLeadingIcon(data.institution.desc)}</p>
            </Card>
          ) : null}
          <ExternalLinksCard links={institutionLinks(cik)} />
        </div>
      </div>
    </div>
  );
}
