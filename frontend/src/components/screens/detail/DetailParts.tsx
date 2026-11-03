"use client";

import { useEffect, useState, type ReactNode } from "react";
import { LineChart } from "@/components/charts";
import { ChangeChip, Hero, RangeTabs, Skeleton } from "@/components/patterns";
import { Banner, Button, Card, ErrorState } from "@/components/ui";
import { LockIcon } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useChartScrub } from "@/hooks/useChartScrub";
import { useMinuteClock } from "@/hooks/useMinuteClock";
import { useSessionUser } from "@/hooks/useSessionUser";
import { isDemo } from "@/lib/access";
import { apiPost } from "@/lib/api";
import { CHART_KEY, chartRows, DETAIL_RANGES, type DetailRange, type ExternalLink, indicatorChartRows, newsPage, newsTime, summaryLines } from "@/lib/detail";
import { endpoints } from "@/lib/endpoints";
import { formatNumber } from "@/lib/format";
import { hasLineValues, scrubModel } from "@/lib/lineChart";
import type { DetailNewsResponse, DetailStat, DetailSummaryResponse, SessionUser } from "@/lib/types";

/**
 * 검색 상세 화면(종목·지표·기관) 공용 부품 — 시세 히어로(차트·기간)·핵심 지표 표·주요 뉴스·AI 요약·외부 링크.
 * 표시 규칙은 lib/detail(순수 함수), 여기서는 그리기만 합니다(ADR 0004). 외부 출처는 새 창 링크로 적습니다.
 */

const LINK = "rounded-sm text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/**
 * 외부 링크 — 새 창, 보낸 쪽 정보 없이(noopener noreferrer). 낭독기에는 '새 창'을 함께 읽습니다.
 * 주소는 수집한 글(뉴스·리포트·홈페이지)이라 http(s)만 링크로 두고, 그 밖이면 글만 그립니다(javascript: 등을 href에 넣지 않음).
 */
export function ExternalAnchor({ href, children, className = LINK }: { href: string; children: ReactNode; className?: string }) {
  if (!/^https?:\/\//i.test(href)) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
      <span className="sr-only"> (새 창)</span>
    </a>
  );
}

/**
 * 시세 히어로 — 큰 값·전일 대비 칩·배지(meta)와 Yahoo 시계열 차트(GET /api/macro/ticker, 기간 1개월·6개월·1년·5년, 기본 1년).
 * 심볼이 없으면(스크래핑 카드 등) 차트 대신 이유 한 줄. 차트를 문지르면 큰 값이 그 날 종가로 바뀝니다(기간 첫 값 대비 변화).
 */
export function PriceHero({
  label,
  valueText,
  unit,
  change,
  changePct,
  changeDigits = 2,
  meta,
  symbol,
  noChartReason,
  valueDigits,
  placeholder,
  cardKey,
}: {
  label: string;
  valueText: string | null;
  unit?: string;
  change: number | null;
  changePct: number | null;
  changeDigits?: number;
  meta?: ReactNode;
  /** 차트 Yahoo 심볼 — 없으면 차트를 그리지 않습니다. */
  symbol: string | null;
  noChartReason?: string;
  /** 차트 값(문지른 점) 자릿수. */
  valueDigits: number;
  placeholder?: ReactNode;
  /** 지표 상세의 카드 키 — 차트 점을 카드와 같은 단위로(엔/원 100엔당, lib/detail indicatorChartRows — QA-185). 없으면 원값(종목 상세). */
  cardKey?: string;
}) {
  const [range, setRange] = useState<DetailRange>("1y");
  const series = useApi<{ available: boolean; message?: string; points: { date: string; close: number | null; value?: number | null }[] }>(
    symbol ? endpoints.macro.ticker(symbol, range) : null,
  );
  const rows = cardKey ? indicatorChartRows(cardKey, series.data?.points) : chartRows(series.data?.points);
  const lineSeries = [{ key: CHART_KEY, label }];
  const { index, onScrub } = useChartScrub(rows.length);
  const format = (value: number) => formatNumber(value, valueDigits);
  const scrubbable = hasLineValues(rows, lineSeries);
  const point = scrubbable ? scrubModel(rows, CHART_KEY, index, format) : null;

  let chart: ReactNode;
  if (!symbol) {
    chart = <p className="text-sm text-text-2">{noChartReason ?? "이 항목은 시계열 차트를 받지 않습니다."}</p>;
  } else if (!series.data) {
    chart = series.error ? <ErrorState message={series.error} onRetry={() => void series.reload()} /> : <Skeleton height={220} label="차트를 불러오는 중" />;
  } else if (!series.data.available) {
    chart = <p className="text-sm text-text-2">{series.data.message ?? "표시할 시계열이 없습니다."}</p>;
  } else {
    chart = <LineChart data={rows} series={lineSeries} variant="hero" valueFormat={format} ariaLabel={`${label} 가격 차트`} onScrub={onScrub} />;
  }

  return (
    <Hero
      label={label}
      value={valueText}
      unit={unit}
      change={
        change !== null || changePct !== null ? (
          <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
            <ChangeChip change={change} changePct={changePct} digits={changeDigits} pctDigits={2} />
            <span className="text-xs text-text-3">전일 대비</span>
          </span>
        ) : undefined
      }
      meta={meta}
      placeholder={placeholder}
      tabs={symbol ? <RangeTabs ranges={DETAIL_RANGES} value={range} onChange={setRange} label={`${label} 차트 기간`} /> : undefined}
      tabsPlacement="below"
      scrub={symbol && scrubbable ? (point ? { ...point, changeDigits: valueDigits } : null) : undefined}
    >
      {chart}
    </Hero>
  );
}

/** 핵심 지표 표 — 라벨 왼쪽·값 오른쪽 두 줄 격자(Google Finance·Yahoo Finance의 통계 표). 값이 없으면 "—". */
export function KeyStats({ rows }: { rows: readonly { label: string; value: string }[] }) {
  if (rows.length === 0) return <p className="text-sm text-text-2">핵심 지표를 받지 못했습니다.</p>;
  return (
    <dl className="grid min-w-0 gap-x-6 sm:grid-cols-2">
      {rows.map((row) => (
        <div key={row.label} className="flex min-w-0 items-baseline justify-between gap-3 border-b border-border py-2.5 text-sm">
          <dt className="shrink-0 text-text-2">{row.label}</dt>
          <dd className="min-w-0 truncate text-right font-medium tabular-nums text-text" title={row.value}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** DetailStat 목록 → 표 줄(통화 금액은 그 통화로). */
export function statRows(stats: readonly DetailStat[], text: (stat: DetailStat) => string): { label: string; value: string }[] {
  return stats.map((stat) => ({ label: stat.label, value: text(stat) }));
}

/**
 * 주요 뉴스 — 종목 뉴스(Yahoo·네이버)·연합인포맥스·구글 뉴스 검색을 합친 목록(수집기가 같은 제목을 빼고 최신순으로). 한 쪽에 5건씩(사용자 요청
 * 2026-11-02 — 이전·다음 단추와 'n / m쪽'), 경로가 바뀌면 첫 쪽으로. 제목은 원문 기사로 가는 새 창 링크, 아래 줄은 언론사·시각·받은 곳. 출처 하나가
 * 실패하면 그 사실을 한 줄로 적습니다(나머지는 그대로).
 */
export function NewsCard({ path, title = "주요 뉴스" }: { path: string | null; title?: string }) {
  const news = useApi<DetailNewsResponse>(path);
  const now = useMinuteClock();
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [path]);
  const all = news.data?.news?.items ?? [];
  const shown = newsPage(all, page);
  const items = shown.items;
  const failures = Object.entries(news.data?.news?.errors ?? {});
  let body: ReactNode;
  if (!news.data) {
    body = news.error ? <ErrorState message={news.error} onRetry={() => void news.reload()} /> : <Skeleton lines={5} label="뉴스를 불러오는 중" />;
  } else if (!news.data.available) {
    body = <p className="text-sm text-text-2">{news.data.message ?? "뉴스를 조회하지 않습니다."}</p>;
  } else if (all.length === 0) {
    body = <p className="text-sm text-text-2">{news.data.news?.error ?? "최근 뉴스를 찾지 못했습니다."}</p>;
  } else {
    body = (
      <ul className="-my-1 divide-y divide-border">
        {items.map((item) => (
          <li key={item.url} className="py-3">
            <ExternalAnchor href={item.url} className={`${LINK} text-[15px] font-medium leading-snug`}>
              {item.title}
            </ExternalAnchor>
            <p className="mt-1 text-xs text-text-3">
              {[item.publisher, now ? newsTime(item.publishedAt, now) : null, item.source].filter(Boolean).join(" · ")}
            </p>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <Card title={title} source="Yahoo Finance · 네이버 증권 · 연합인포맥스 · Google News(최근 7일 검색) — 제목을 누르면 원문 기사">
      {body}
      {shown.pages > 1 ? (
        <nav aria-label="뉴스 쪽" className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3 text-sm">
          <Button size="sm" variant="ghost" disabled={shown.page <= 1} onClick={() => setPage(shown.page - 1)}>
            이전
          </Button>
          <span className="tabular-nums text-text-2" aria-live="polite">
            {shown.page} / {shown.pages}쪽 · {all.length}건
          </span>
          <Button size="sm" variant="ghost" disabled={shown.page >= shown.pages} onClick={() => setPage(shown.page + 1)}>
            다음
          </Button>
        </nav>
      ) : null}
      {failures.length > 0 ? (
        <p className="mt-3 text-xs text-text-3">
          일부 출처를 받지 못했습니다 — {failures.map(([source, reason]) => `${source}: ${reason}`).join(" · ")}
        </p>
      ) : null}
    </Card>
  );
}

/**
 * AI 요약을 쓸 수 있는가 — 운영자·유료 등급(POST /api/detail/summary는 유료 경로, AccessPolicy). 데모 열람은 공용 한도가 AI 리포트에만 있어
 * 쓰지 못합니다(UsageService). 사용자를 모르면 아직 모름(null).
 */
function summaryAllowed(user: SessionUser | null | undefined): boolean | null {
  if (!user) return null;
  if (isDemo(user)) return false;
  return user.role === "OWNER" || user.tier === "PRO";
}

/**
 * AI 요약 — 이 화면이 보여 주는 시세·지표·뉴스만 번호를 붙여 Claude(Haiku, effort medium)에게 넘기고, 근거 번호([1])를 출처 링크로 바꿔 보입니다.
 * 누를 때만 부릅니다(하루 한도 — 같은 날 같은 대상은 서버가 저장한 요약을 돌려줌). 투자 권유가 아니라는 안내를 늘 붙입니다.
 */
export function AiSummaryCard({ request }: { request: { market?: string; code?: string; q?: string; label?: string } }) {
  const user = useSessionUser();
  const allowed = summaryAllowed(user);
  const lockedText = isDemo(user) ? "데모 열람에서는 쓰지 않습니다" : "유료 등급 기능";
  const summary = useAsyncAction(() => apiPost<DetailSummaryResponse>(endpoints.detail.summary, request), "AI 요약을 만들지 못했습니다.");
  const result = summary.result;
  const lines = result?.status ? summaryLines(result.summary) : [];
  const sources = result?.sources ?? [];
  const sourceOf = (n: number) => sources.find((source) => source.n === n);

  return (
    <Card
      title="AI 요약"
      subtitle="이 화면의 시세·지표·뉴스만 근거로 Claude가 요약합니다. 투자 권유가 아니며, 숫자는 위 표와 출처에서 확인하세요."
      actions={
        allowed === false ? (
          <span className="inline-flex items-center gap-1 text-xs text-text-3">
            <LockIcon size={14} />
            {lockedText}
          </span>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => void summary.run()} disabled={summary.busy || allowed === null}>
            {summary.busy ? "요약하는 중…" : result?.status ? "다시 불러오기" : "AI 요약 만들기"}
          </Button>
        )
      }
    >
      {summary.error ? <ErrorState message={summary.error} /> : null}
      {result && !result.status ? <Banner tone="warn">{result.error ?? "요약을 만들지 못했습니다."}</Banner> : null}
      {lines.length > 0 ? (
        <div className="flex flex-col gap-1.5 text-body-md leading-relaxed text-text">
          {lines.map((line, at) => {
            const refs = line.refs.map((n) => ({ n, source: sourceOf(n) }));
            const marks = refs.map(({ n, source }) =>
              source?.url ? (
                <ExternalAnchor key={n} href={source.url} className={`${LINK} ml-0.5 align-super text-[11px] text-text-2`}>
                  [{n}]
                </ExternalAnchor>
              ) : (
                <span key={n} className="ml-0.5 align-super text-[11px] text-text-3">
                  [{n}]
                </span>
              ),
            );
            if (line.kind === "heading") {
              return (
                <p key={at} className="mt-2 text-sm font-semibold text-text-2 first:mt-0">
                  {line.text}
                  {marks}
                </p>
              );
            }
            return (
              <p key={at} className={line.kind === "bullet" ? "relative pl-4 before:absolute before:left-1 before:content-['·']" : ""}>
                {line.text}
                {marks}
              </p>
            );
          })}
        </div>
      ) : null}
      {result?.status && sources.length > 0 ? (
        <ol aria-label="요약 근거" className="mt-4 flex flex-col gap-1 border-t border-border pt-3 text-xs text-text-3">
          {sources.map((source) => (
            <li key={source.n} className="min-w-0 truncate">
              [{source.n}] {source.url ? <ExternalAnchor href={source.url}>{source.label}</ExternalAnchor> : source.label}
            </li>
          ))}
        </ol>
      ) : null}
      {result?.status ? (
        <p className="mt-2 text-xs text-text-3">
          {[result.model, result.generatedAtKst, result.cached ? "오늘 만든 요약을 다시 보임" : null, result.quota ? `오늘 ${result.quota.used}/${result.quota.limit ?? "무제한"}건` : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
      {!result && !summary.error ? (
        <p className="text-sm text-text-2">
          {allowed === false
            ? isDemo(user)
              ? "데모 열람에서는 AI 요약을 쓰지 않습니다."
              : "유료 등급에서 쓸 수 있습니다."
            : "단추를 누르면 요약합니다(하루 한도 안에서, 같은 날 같은 대상은 다시 부르지 않음)."}
        </p>
      ) : null}
    </Card>
  );
}

/** 다른 곳에서 보기 — 외부 출처 링크 묶음. */
export function ExternalLinksCard({ links, title = "다른 곳에서 보기" }: { links: readonly ExternalLink[]; title?: string }) {
  return (
    <Card title={title}>
      <ul className="flex flex-wrap gap-2">
        {links.map((link) => (
          <li key={link.url}>
            <ExternalAnchor
              href={link.url}
              className="inline-flex min-h-9 items-center rounded-full border border-border px-3 text-sm text-text hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              {link.label}
            </ExternalAnchor>
          </li>
        ))}
      </ul>
    </Card>
  );
}
