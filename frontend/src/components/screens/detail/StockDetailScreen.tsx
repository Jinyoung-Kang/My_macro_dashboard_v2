"use client";

import Link from "next/link";
import { LiveIntervalSelect } from "@/components/LiveIntervalSelect";
import { ProvenanceBadge, Skeleton } from "@/components/patterns";
import { Banner, Card, PageHeader } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import {
  countryKo,
  currencyUnit,
  externalLinks,
  holderQuery,
  institutionHref,
  marketStateText,
  priceDigits,
  recommendationText,
  sectorKo,
  statText,
} from "@/lib/detail";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, formatKst, formatNumber, formatUsd, withoutLeadingIcon } from "@/lib/format";
import { liveStatusText, tradedAtText } from "@/lib/livePrices";
import type { DetailMarket, DetailQuote, GuruHoldersResponse } from "@/lib/types";
import { AiSummaryCard, ExternalAnchor, ExternalLinksCard, KeyStats, NewsCard, PriceHero, statRows } from "./DetailParts";
import { useStockQuote } from "./useStockQuote";

/** 13F 보유 기관 표에 보이는 줄 수. */
const HOLDERS_SHOWN = 10;

/**
 * 종목 상세(/s/<시장>/<코드>) — Google Finance·Yahoo Finance식 한 화면: 시세 히어로(차트·기간) → 핵심 지표 → AI 요약 → 주요 뉴스, 옆 칸에
 * 회사 개요·애널리스트 의견·증권사 리포트(국내)·13F 보유 기관(미국 주식)·외부 링크.
 *
 * - 미국·해외(지수 ^·환율 =X·선물 =F 포함)는 Yahoo Finance, 국내 6자리는 네이버 증권 — 수집기 실시간 조회(GET /api/detail/quote, 5분 캐시).
 * - 차트는 Yahoo 시계열(GET /api/macro/ticker — 국내는 .KS·.KQ 심볼). 값이 없으면 "—", 받지 못한 출처는 그 이유를 적습니다.
 * - 출처 링크: 히어로 배지(시세 출처), 뉴스 제목(원문 기사), 외부 링크 묶음(Yahoo·Google Finance·Investing.com·네이버·SEC·DART).
 * - 가격·전일 대비는 실시간 시세(ADR 0024 — 고른 주기마다 서버가 밀어 줌, 기본 1시간, 장중 카드·보유 표와 같은 주기)가 오면 그 값으로 바꿉니다
 *   (사용자 요청 2026-11-03 — 모의 매매에서 종목을 누르면 이 화면). 지표·개요는 위 시세 응답 그대로.
 */
export function StockDetailScreen({ market, code }: { market: DetailMarket; code: string }) {
  const { quoteState, quote, realtime, live, shown, price, change, changePct, name, symbol, digits, sub } = useStockQuote(market, code);
  const holders = market === "us" && (quote?.kind ?? "").toUpperCase() === "EQUITY" ? holderQuery(quote?.name) : null;

  let placeholder;
  if (!quoteState.data) {
    placeholder = quoteState.error ? (
      <Banner tone="danger">{quoteState.error}</Banner>
    ) : (
      <Skeleton lines={2} label="시세를 불러오는 중" />
    );
  } else if (!quoteState.data.available) {
    placeholder = <p className="text-sm text-text-2">{quoteState.data.message ?? "시세를 조회하지 않습니다."}</p>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 lg:gap-8">
      <PageHeader title={name} description={sub} />
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
          quote ? (
            <>
              {live && shown ? (
                <span className="text-xs text-text-2" title={`출처 ${live.source}`}>
                  {shown.session ?? "실시간"} {tradedAtText(shown.tradedAt)} KST
                  {!shown.session && liveStatusText(live.status) ? ` · ${liveStatusText(live.status)}` : ""} · {live.source}
                </span>
              ) : marketStateText(quote.marketState) ? <span className="text-xs text-text-2">{marketStateText(quote.marketState)}</span> : null}
              <LiveIntervalSelect />
              {realtime.error ? <span className="text-xs text-warn">{realtime.error}</span> : null}
              <ProvenanceBadge source={quote.source?.label} asOf={quote.asOf ? formatKst(quote.asOf) : null} />
              {quote.source?.url ? (
                <ExternalAnchor href={quote.source.url} className="rounded-sm text-xs text-text-2 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-focus">
                  출처 보기
                </ExternalAnchor>
              ) : null}
              {quote.error ? <span className="basis-full text-xs text-warn">일부 값을 받지 못했습니다 — {quote.error}</span> : null}
            </>
          ) : undefined
        }
      />

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:gap-8">
        <div className="flex min-w-0 flex-col gap-6 lg:gap-8">
          <Card title="핵심 지표" source={quote?.source?.label ?? undefined}>
            {quote ? <KeyStats rows={statRows(quote.stats, (stat) => statText(stat, quote.currency))} /> : <Skeleton lines={4} label="핵심 지표를 불러오는 중" />}
          </Card>
          <AiSummaryCard request={{ market, code, q: quote?.name ?? undefined, label: name }} />
          {/* 회사 이름(구글 뉴스 검색어)은 시세 응답에 있어, 시세를 읽기 전에는 부르지 않습니다 — 이름 없이 한 번, 이름과 함께 또 한 번 부르지 않게. */}
          <NewsCard path={quoteState.data || quoteState.error ? endpoints.detail.news({ market, code, q: quote?.name ?? undefined }) : null} />
        </div>
        <div className="flex min-w-0 flex-col gap-6 lg:gap-8">
          {quote ? <ProfileCard quote={quote} /> : null}
          {quote?.consensus ? <ConsensusCard market={market} quote={quote} /> : null}
          {quote && quote.research.length > 0 ? <ResearchCard quote={quote} /> : null}
          {holders ? <HoldersCard query={holders} /> : null}
          <ExternalLinksCard links={externalLinks(market, code, symbol, quote?.name)} />
        </div>
      </div>
    </div>
  );
}

/**
 * 회사 개요 — 섹터·업종·나라·직원 수·사업 설명·홈페이지. 한국어로(사용자 요청 2026-11-02): 개요·업종은 네이버 증권 해외주식 기업 개요(있으면 — 출처
 * 링크), 섹터·나라는 한국어 이름 표. 한국어 개요가 없으면 Yahoo 영문 개요를 그렇다고 적고 보입니다. 하나도 없으면 그리지 않습니다.
 */
function ProfileCard({ quote }: { quote: DetailQuote }) {
  const profile = quote.profile;
  if (!profile) return null;
  const summary = profile.summaryKo ?? profile.summary;
  const english = !profile.summaryKo && Boolean(profile.summary);
  const rows = [
    { label: "섹터", value: sectorKo(profile.sector) },
    { label: "업종", value: profile.industryKo ?? profile.industry },
    { label: "나라", value: countryKo(profile.country) },
    { label: "직원 수", value: profile.employees !== null ? `${formatNumber(profile.employees, 0)}명` : null },
  ].filter((row): row is { label: string; value: string } => Boolean(row.value));
  // 홈페이지는 http(s) 주소만 링크로(수집한 글을 그대로 href에 넣지 않음).
  const website = profile.website && /^https?:\/\//i.test(profile.website) ? profile.website : null;
  if (rows.length === 0 && !summary && !website) return null;
  return (
    <Card title="회사 개요" source={profile.koSource ? `${profile.koSource.label} · ${quote.source?.label ?? "Yahoo Finance"}` : quote.source?.label ?? undefined}>
      {rows.length > 0 ? (
        <dl className="flex flex-col">
          {rows.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-3 border-b border-border py-2 text-sm">
              <dt className="text-text-2">{row.label}</dt>
              <dd className="min-w-0 truncate text-right text-text">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {summary ? <p className="mt-3 line-clamp-[10] whitespace-pre-line text-sm leading-relaxed text-text-2">{summary}</p> : null}
      {english ? <p className="mt-1 text-xs text-text-3">한국어 개요가 없어 Yahoo 영문 원문을 보입니다.</p> : null}
      {profile.koSource ? (
        <p className="mt-2 text-xs">
          <ExternalAnchor href={profile.koSource.url}>한국어 개요 출처 — {profile.koSource.label}</ExternalAnchor>
        </p>
      ) : null}
      {website ? (
        <p className="mt-3 text-sm">
          <ExternalAnchor href={website}>회사 홈페이지</ExternalAnchor>
        </p>
      ) : null}
    </Card>
  );
}

/** 애널리스트 의견 — 평균 목표가·투자의견·의견 수(미국 Yahoo, 국내 네이버 컨센서스). */
function ConsensusCard({ market, quote }: { market: DetailMarket; quote: DetailQuote }) {
  const consensus = quote.consensus;
  if (!consensus) return null;
  const rows = [
    { label: "평균 목표가", value: consensus.targetMean !== null ? moneyPrice(consensus.targetMean, quote) : EMPTY },
    { label: "투자의견", value: recommendationText(market, consensus.recommendation) ?? EMPTY },
    { label: "의견 수", value: consensus.analysts !== null ? `${formatNumber(consensus.analysts, 0)}곳` : EMPTY },
  ];
  return (
    <Card title="애널리스트 의견" subtitle="증권사 의견의 평균입니다 — 이 화면의 판단이 아닙니다." source={quote.source?.label ?? undefined}>
      <KeyStats rows={rows} />
    </Card>
  );
}

function moneyPrice(value: number, quote: DetailQuote): string {
  const unit = currencyUnit(quote.currency);
  return `${formatNumber(value, priceDigits(value, quote.currency))}${unit ? ` ${unit}` : ""}`;
}

/** 증권사 리포트(국내 — 네이버 증권 리서치). 제목은 원문 링크. */
function ResearchCard({ quote }: { quote: DetailQuote }) {
  return (
    <Card title="증권사 리포트" source="네이버 증권 리서치">
      <ul className="-my-1 divide-y divide-border">
        {quote.research.map((item) => (
          <li key={item.url} className="py-2.5 text-sm">
            <ExternalAnchor href={item.url}>{item.title ?? "제목 없음"}</ExternalAnchor>
            <p className="mt-0.5 text-xs text-text-3">{[item.broker, item.date].filter(Boolean).join(" · ") || EMPTY}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * 13F 보유 기관 — 이 대시보드가 받은 13F 기관 가운데 공시 이름에 회사 이름이 들어간 보유 줄(비중 순). 이름으로 찾으므로 다른 회사가 섞일 수 있어
 * 공시 이름을 함께 적습니다. 기관 이름은 기관 상세로 가는 링크.
 */
function HoldersCard({ query }: { query: string }) {
  const holders = useApi<GuruHoldersResponse>(endpoints.institution.guruHolders(query));
  const rows = holders.data?.rows ?? [];
  return (
    <Card title="13F 보유 기관" subtitle={`공시 이름에 '${query}'가 들어간 보유 줄 — 비중 순`} source="SEC EDGAR 13F(이 대시보드 저장본)">
      {!holders.data ? (
        holders.error ? <p className="text-sm text-danger">{holders.error}</p> : <Skeleton lines={3} label="13F 보유 기관을 불러오는 중" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-text-2">이 대시보드가 받은 13F 기관 가운데 보유한 곳이 없습니다.</p>
      ) : (
        <ul className="-my-1 divide-y divide-border">
          {rows.slice(0, HOLDERS_SHOWN).map((row) => (
            <li key={`${row.cik}:${row.cusip}`} className="flex items-baseline justify-between gap-3 py-2.5 text-sm">
              <span className="min-w-0">
                <Link href={institutionHref(row.cik)} className="rounded-sm text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus">
                  {withoutLeadingIcon(row.institution)}
                </Link>
                <span className="block truncate text-xs text-text-3">
                  {row.name} · {row.reportDate}
                </span>
              </span>
              <span className="shrink-0 text-right tabular-nums">
                <span className="block font-medium text-text">{formatNumber(row.weight, 2)}%</span>
                <span className="block text-xs text-text-3">{formatUsd(row.value)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {rows.length > HOLDERS_SHOWN ? (
        <p className="mt-2 text-xs text-text-3">
          {rows.length}줄 가운데 비중 상위 {HOLDERS_SHOWN}줄
        </p>
      ) : null}
    </Card>
  );
}
