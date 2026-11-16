"use client";

import Link from "next/link";
import { useEffect, useId, useState, type ReactNode } from "react";
import { LineChart } from "@/components/charts";
import { ChangeChip, EstimateBadge, Hero, type PropertyItem, RangeTabs, Skeleton } from "@/components/patterns";
import { Banner, Button, Card, ErrorState, LINK_CLASSES, PANEL_CLASSES, Panel, TEXT_TARGET } from "@/components/ui";
import { LockIcon } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useChartScrub } from "@/hooks/useChartScrub";
import { useMinuteClock } from "@/hooks/useMinuteClock";
import { useSessionUser } from "@/hooks/useSessionUser";
import { isDemo } from "@/lib/access";
import { quotaLabel } from "@/lib/aiEngines";
import { apiPost } from "@/lib/api";
import {
  CHART_KEY,
  chartRows,
  DETAIL_RANGES,
  type DetailProperty,
  type DetailRange,
  type ExternalLink,
  indicatorChartRows,
  newsPage,
  newsTime,
  summaryLines,
} from "@/lib/detail";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, formatNumber } from "@/lib/format";
import { infoSearchEntry } from "@/lib/search";
import { hasLineValues, scrubModel } from "@/lib/lineChart";
import type { DetailNewsResponse, DetailStat, DetailSummaryResponse, SessionUser } from "@/lib/types";

/**
 * 검색 상세 화면(종목·지표·기관) 공용 부품 — 가격 차트 패널(기간·문지르기 읽기 줄)·링크 목록·속성 줄 바꾸기·주요 뉴스·AI 요약·외부 링크.
 * 표시 규칙은 lib/detail(순수 함수), 여기서는 그리기만 합니다(ADR 0004). 외부 출처는 새 창 링크로 적습니다.
 * 시세 히어로(PriceHero)·핵심 지표 표(KeyStats·statRows)는 종목 팝업 창(StockQuickView — 모의·실제 계좌·ISA 표가 씀) 몫으로 남깁니다 — 상세 세 화면은
 * 작업대 대상 문법(P4 — 대상 머리·속성 목록·가격 차트 패널)으로 옮겼고, 팝업 창은 모의매매 단계(P6)에서 함께 바꿉니다.
 */

const LINK = "rounded-sm text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
/** 따로 선 링크(목록의 제목·근거 줄·카드 안 한 줄 링크) — 좁은 화면(lg 미만) 누르는 자리 44px(QA-458). 문장 안·위첨자 링크는 LINK 그대로. */
const TARGET_LINK = `${LINK} ${TEXT_TARGET}`;

/**
 * 외부 링크 — 새 창, 보낸 쪽 정보 없이(noopener noreferrer). 낭독기에는 '새 창'을 함께 읽습니다.
 * 주소는 수집한 글(뉴스·리포트·홈페이지)이라 http(s)만 링크로 두고, 그 밖이면 글만 그립니다(javascript: 등을 href에 넣지 않음).
 * 기본 모양은 따로 선 링크(좁은 화면 44px)이고, 글 안의 링크는 부르는 쪽이 모양을 넘깁니다.
 */
export function ExternalAnchor({ href, children, className = TARGET_LINK }: { href: string; children: ReactNode; className?: string }) {
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
 * 지금은 종목 팝업 창(StockQuickView)만 씁니다 — 상세 화면은 대상 머리(EntityHeader)와 PriceChartPanel(P4). 팝업 창을 바꾸는 P6까지 그대로 둡니다.
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

/** 문지르지 않을 때 읽기 줄의 안내 — 한 줄 자리를 지켜 문지르기 시작해도 차트가 위아래로 움직이지 않게 합니다. */
const SCRUB_HINT = "차트를 누르거나 가리키면 그 날 값";

/**
 * 가격 차트 패널(작업대 대상 문법 — 상세 화면 가운데 '개요' 탭, P4): 제목(이름 있는 영역) · 기간 탭(1개월·6개월·1년·5년, 기본 1년) · 읽기 줄 · 차트 · 출처 캡션.
 *
 * - 차트는 Yahoo 시계열(GET /api/macro/ticker). 심볼이 없으면(스크래핑 카드·뜻이 다른 티커) 차트 대신 이유 한 줄(`noChartReason`), 기간 탭도 없습니다.
 *   `cardKey`를 주면 점을 카드와 같은 단위로(엔/원 100엔당 — lib/detail indicatorChartRows, QA-185).
 * - 문지르기는 이 패널에 있습니다(명세 W7 — 대상 머리는 늘 지금 값). 차트를 문지르는 동안 읽기 줄에 그 날 날짜·값·기간 시작 대비 칩(모르면 생략)·추정
 *   배지를 보입니다. 읽기 줄은 눈으로 보는 줄(aria-hidden)이고, 읽어 주기는 따로 둔 조용한 알림 영역(aria-live polite)이 '날짜 값'으로 합니다(차트에
 *   초점을 두고 ←·→로 옮기는 낭독기 사용자). 문지르지 않을 때는 같은 자리에 짧은 안내를 두어 줄 높이가 바뀌지 않습니다.
 * - 겉모양은 공용 패널(PANEL_CLASSES — 머리줄과 본문을 1px 경계로 가름)과 같고, 머리에 기간 탭이 있어 제목에 영역 이름을 붙입니다(section aria-labelledby).
 */
export function PriceChartPanel({
  title,
  label = title,
  symbol,
  noChartReason,
  valueDigits,
  cardKey,
  caption,
  unit,
}: {
  /** 패널 제목·영역 이름(예 'Apple Inc. 시세'). */
  title: string;
  /** 차트 계열 이름 — 차트 이름 '{label} 가격 차트'·기간 탭 이름 '{label} 차트 기간'(기본 title). */
  label?: string;
  /** 차트 Yahoo 심볼 — 없으면 차트를 그리지 않습니다. */
  symbol: string | null;
  noChartReason?: string;
  /** 차트 값(문지른 점) 자릿수. */
  valueDigits: number;
  /** 지표 상세의 카드 키 — 차트 점을 카드와 같은 단위로. 없으면 원값(종목 상세). */
  cardKey?: string;
  /** 차트 아래 출처 글(예 '차트: Yahoo Finance ^GSPC 일별 종가'). */
  caption?: string | null;
  /** 문지른 값 옆 단위(종목의 통화) — 값이 있을 때만. */
  unit?: string | null;
}) {
  const headingId = useId();
  const [range, setRange] = useState<DetailRange>("1y");
  const series = useApi<{ available: boolean; message?: string; points: { date: string; close: number | null; value?: number | null }[] }>(
    symbol ? endpoints.macro.ticker(symbol, range) : null,
  );
  const rows = cardKey ? indicatorChartRows(cardKey, series.data?.points) : chartRows(series.data?.points);
  const lineSeries = [{ key: CHART_KEY, label }];
  const { index, onScrub } = useChartScrub(rows.length);
  const format = (value: number) => formatNumber(value, valueDigits);
  const drawn = Boolean(symbol && series.data?.available);
  const scrubbable = drawn && hasLineValues(rows, lineSeries);
  const point = scrubbable ? scrubModel(rows, CHART_KEY, index, format) : null;
  const pointMissing = point !== null && point.valueText === EMPTY;
  const pointUnit = point !== null && !pointMissing && unit ? ` ${unit}` : "";

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
    <section aria-labelledby={headingId} className={`min-w-0 ${PANEL_CLASSES}`}>
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border px-3 py-2.5 lg:px-4">
        <h2 id={headingId} className="min-w-0 break-keep text-heading-sm text-text wrap-anywhere">
          {title}
        </h2>
        {symbol ? <RangeTabs ranges={DETAIL_RANGES} value={range} onChange={setRange} label={`${label} 차트 기간`} /> : null}
      </header>
      <div className="p-3 lg:p-4">
        {scrubbable ? (
          <div aria-hidden="true" className="mb-2 flex min-h-5 flex-wrap items-baseline gap-x-1.5 gap-y-1 text-caption">
            {point !== null ? (
              <>
                <span className="tabular-nums text-text-2">{point.dateText}</span>
                <span className={`font-semibold tabular-nums ${pointMissing ? "text-text-3" : "text-text"}`}>{point.valueText}</span>
                {pointUnit ? <span className="text-xs text-text-3">{unit}</span> : null}
                {changeChipVisible(point.change, point.changePct) ? (
                  <>
                    <ChangeChip size="sm" change={point.change} changePct={point.changePct} digits={valueDigits} pctDigits={2} />
                    <span className="text-xs text-text-3">기간 시작 대비</span>
                  </>
                ) : null}
                {point.isEstimated ? <EstimateBadge estimated note={point.estimateNote} /> : null}
              </>
            ) : (
              <span className="text-xs text-text-3">{SCRUB_HINT}</span>
            )}
          </div>
        ) : null}
        <div className="min-w-0">{chart}</div>
        {caption ? <p className="mt-2 text-xs text-text-3">{caption}</p> : null}
        {scrubbable ? (
          // 조용한 알림 — 문지른 점의 '날짜 값'. 문지르지 않으면 비워 둡니다(미리 있어야 첫 점부터 읽힘).
          <div className="sr-only" aria-live="polite" aria-atomic="true">
            {point !== null ? `${point.dateText} ${point.valueText}${pointUnit}${point.isEstimated ? " 추정" : ""}` : ""}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** 변화 칩을 그릴 값이 있는가(둘 다 모르면 칩이 null을 그려 '기간 시작 대비'만 홀로 남지 않게). */
function changeChipVisible(change: number | null | undefined, changePct: number | null | undefined): boolean {
  return (change !== null && change !== undefined && Number.isFinite(change)) || (changePct !== null && changePct !== undefined && Number.isFinite(changePct));
}

/** 링크 목록 한 줄 — 바깥 주소면 새 창(ExternalAnchor — http(s)만), 아니면 이 앱 안 주소(next/link). */
export type DetailLink = { label: string; href: string; external?: boolean };

/**
 * 링크 목록 패널(상세 화면 오른쪽 '연결') — 따로 선 글 링크를 위에서 아래로. 누를 수 있는 것이라 강조 파랑(LINK_CLASSES — 좁은 화면 누르는 자리 44px,
 * 포커스 링). 링크가 없으면 패널을 그리지 않습니다.
 */
export function LinkListPanel({ title, links }: { title: string; links: readonly DetailLink[] }) {
  if (links.length === 0) return null;
  return (
    <Panel title={title}>
      <ul className="flex flex-col lg:gap-1.5">
        {links.map((link) => (
          <li key={`${link.href}:${link.label}`} className="min-w-0">
            {link.external ? (
              <ExternalAnchor href={link.href} className={`${LINK_CLASSES} break-keep text-sm wrap-anywhere`}>
                {link.label}
              </ExternalAnchor>
            ) : (
              <Link href={link.href} className={`${LINK_CLASSES} break-keep text-sm wrap-anywhere`}>
                {link.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * lib/detail의 속성 줄 → 속성 목록 줄 — `link`가 있으면 값 글을 그 링크로 그립니다(바깥이면 새 창). 값 칸 안의 링크도 따로 선 링크라 좁은 화면 44px입니다.
 */
export function propertyItems(rows: readonly DetailProperty[]): PropertyItem[] {
  return rows.map(({ link, ...row }) => {
    if (!link || row.value === null) return row;
    const className = `${LINK_CLASSES} break-keep wrap-anywhere`;
    return {
      ...row,
      value: link.external ? (
        <ExternalAnchor href={link.href} className={className}>
          {row.value}
        </ExternalAnchor>
      ) : (
        <Link href={link.href} className={className}>
          {row.value}
        </Link>
      ),
    };
  });
}

/**
 * 핵심 지표 표(종목 팝업 창 몫 — 상세 화면은 속성 목록 PropertyList, P4) — 라벨 왼쪽·값 오른쪽 두 줄 격자(Google Finance·Yahoo Finance의 통계 표). 값이 없으면 "—". 값(숫자)은 말줄임으로 자르지 않습니다 —
 * 칸이 좁으면 숫자와 단위 사이의 공백에서 먼저 줄을 바꾸고 칸보다 긴 낱말만 칸 안에서 끊습니다(QA-455 — 한 줄 말줄임이라 옆 칸에서 '23.77 USD'가
 * '23.77 …'로 잘렸음). `side`는 lg 이상에서 1/3 폭 옆 칸에 놓이는 표 — 그 폭에서 두 칸이면 값 칸이 라벨에 밀려 좁아져 lg 이상은 한 칸으로 둡니다.
 */
export function KeyStats({ rows, side = false }: { rows: readonly { label: string; value: string }[]; side?: boolean }) {
  if (rows.length === 0) return <p className="text-sm text-text-2">핵심 지표를 받지 못했습니다.</p>;
  return (
    <dl className={side ? "grid min-w-0 gap-x-6 sm:grid-cols-2 lg:grid-cols-1" : "grid min-w-0 gap-x-6 sm:grid-cols-2"}>
      {rows.map((row) => (
        <div key={row.label} className="flex min-w-0 items-baseline justify-between gap-3 border-b border-border py-2.5 text-sm">
          <dt className="shrink-0 text-text-2">{row.label}</dt>
          <dd className="min-w-0 break-keep text-right font-medium tabular-nums text-text wrap-anywhere">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** DetailStat 목록 → 표 줄(통화 금액은 그 통화로) — 종목 팝업 창 몫(상세 화면은 lib/detail stockStatItems). */
export function statRows(stats: readonly DetailStat[], text: (stat: DetailStat) => string): { label: string; value: string }[] {
  return stats.map((stat) => ({ label: stat.label, value: text(stat) }));
}

/** 주요 뉴스의 출처 묶음(뉴스 카드 머리·상세 화면 '출처' 패널이 같은 글). */
export const NEWS_SOURCES = "Yahoo Finance · 네이버 증권 · 연합인포맥스 · Google News(최근 7일 검색)";

/**
 * 주요 뉴스 — 종목 뉴스(Yahoo·네이버)·연합인포맥스·구글 뉴스 검색을 합친 목록(수집기가 같은 제목을 빼고 최신순으로). 한 쪽에 5건씩(사용자 요청
 * 2026-11-02 — 이전·다음 단추와 'n / m쪽'), 경로가 바뀌면 첫 쪽으로. 제목은 원문 기사로 가는 새 창 링크, 아래 줄은 언론사·시각·받은 곳. 출처 하나가
 * 실패하면 그 사실을 한 줄로 적습니다(나머지는 그대로). `searchQuery`를 주면 카드 머리에 같은 말로 정보 검색(/search?q=, 최근 2년 — ADR 0041)으로
 * 가는 작은 링크를 둡니다(그 화면이 보이는 사용자에게만). 경로가 null이면 부르지 않고 '불러오는 중'으로 두며, `idleText`를 주면 그 대신 그 글(부를 수 없는
 * 까닭 — 검색어로 쓸 이름을 받지 못함 등)을 적습니다.
 */
export function NewsCard({
  path,
  title = "주요 뉴스",
  searchQuery,
  idleText,
}: {
  path: string | null;
  title?: string;
  searchQuery?: string | null;
  idleText?: string;
}) {
  const user = useSessionUser();
  const infoSearch = searchQuery ? infoSearchEntry(searchQuery, user) : null;
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
    body = news.error ? (
      <ErrorState message={news.error} onRetry={() => void news.reload()} />
    ) : !path && idleText ? (
      <p className="text-sm text-text-2">{idleText}</p>
    ) : (
      <Skeleton lines={5} label="뉴스를 불러오는 중" />
    );
  } else if (!news.data.available) {
    body = <p className="text-sm text-text-2">{news.data.message ?? "뉴스를 조회하지 않습니다."}</p>;
  } else if (all.length === 0) {
    body = <p className="text-sm text-text-2">{news.data.news?.error ?? "최근 뉴스를 찾지 못했습니다."}</p>;
  } else {
    body = (
      <ul className="-my-1 divide-y divide-border">
        {items.map((item) => (
          <li key={item.url} className="py-3">
            <ExternalAnchor href={item.url} className={`${TARGET_LINK} text-[15px] font-medium leading-snug`}>
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
    <Card
      title={title}
      source={`${NEWS_SOURCES} — 제목을 누르면 원문 기사`}
      actions={
        infoSearch ? (
          <Link href={infoSearch.href} title={`${infoSearch.label} — 최근 2년의 기사·글`} className={`${TEXT_TARGET} rounded-sm text-sm font-medium text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus`}>
            정보 검색
          </Link>
        ) : undefined
      }
    >
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
 * 누를 때만 부릅니다(하루 한도 — 같은 날 같은 대상은 서버가 저장한 요약을 돌려줌). 투자 권유가 아니라는 안내를 늘 붙입니다. `request`가 null이면
 * 요약할 대상을 아직 몰라(기관 이름을 받기 전 등) 단추를 잠그고 '불러오는 중'을 적으며, `idleText`를 주면 그 대신 그 글(요약할 수 없는 까닭)을 적습니다.
 */
export function AiSummaryCard({
  request,
  idleText,
}: {
  request: { market?: string; code?: string; q?: string; label?: string } | null;
  idleText?: string;
}) {
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
          <Button size="sm" variant="secondary" onClick={() => void summary.run()} disabled={summary.busy || allowed === null || request === null}>
            {summary.busy ? "요약하는 중…" : result?.status ? "다시 불러오기" : "AI 요약 만들기"}
          </Button>
        )
      }
    >
      {summary.error ? <ErrorState message={summary.error} /> : null}
      {result && !result.status ? <Banner tone="warn">{result.error ?? "요약을 만들지 못했습니다."}</Banner> : null}
      {lines.length > 0 ? (
        // 긴 글 단계(running 15/24, 한 줄 최대 72자). 근거 번호는 위로 올리되 줄 높이를 밀지 않게(align-super 대신 상대 위치 — 번호가 있는 줄만 줄 간격이 벌어졌음).
        <div className="flex max-w-[72ch] flex-col gap-1.5 text-running text-text">
          {lines.map((line, at) => {
            const refs = line.refs.map((n) => ({ n, source: sourceOf(n) }));
            const marks = refs.map(({ n, source }) =>
              source?.url ? (
                <ExternalAnchor key={n} href={source.url} className={`${LINK} relative -top-[0.4em] ml-0.5 text-xs leading-none text-text-2`}>
                  [{n}]
                </ExternalAnchor>
              ) : (
                <span key={n} className="relative -top-[0.4em] ml-0.5 text-xs leading-none text-text-3">
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
          {/* 근거 줄은 따로 선 링크가 세로로 쌓인 목록이라(문장 안 링크가 아님) 링크가 좁은 화면(lg 미만) 누르는 자리 44px입니다(QA-458).
              번호는 늘 보이고, 이름만 줄 안에서 말줄임합니다. */}
          {sources.map((source) => (
            <li key={source.n} className="flex min-w-0 items-center gap-1">
              <span className="shrink-0">[{source.n}]</span>
              {source.url ? (
                <ExternalAnchor href={source.url} className={`${TARGET_LINK} min-w-0`}>
                  <span className="min-w-0 truncate">{source.label}</span>
                </ExternalAnchor>
              ) : (
                <span className="min-w-0 truncate">{source.label}</span>
              )}
            </li>
          ))}
        </ol>
      ) : null}
      {result?.status ? (
        <p className="mt-2 text-xs text-text-3">
          {[result.model, result.generatedAtKst, result.cached ? "오늘 만든 요약을 다시 보임" : null, result.quota ? quotaLabel(result.quota) : null]
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
            : request === null
              // 대상을 모르는 동안은 단추가 잠겨 있으니 '누르면'이라고 적지 않습니다(QA-453 검토 — 잠긴 단추를 누르라는 글만 읽힘).
              ? (idleText ?? "요약할 대상을 불러오는 중입니다.")
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
              className="inline-flex min-h-11 items-center rounded-control border border-border px-3 text-sm text-text hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:min-h-[30px] lg:px-2.5"
            >
              {link.label}
            </ExternalAnchor>
          </li>
        ))}
      </ul>
    </Card>
  );
}
