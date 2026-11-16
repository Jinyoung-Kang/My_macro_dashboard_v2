"use client";

import Link from "next/link";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { LiveIntervalSelect } from "@/components/LiveIntervalSelect";
import { ChangeChip, EntityHeader, MasterDetail, type PropertyItem, PropertyList, ProvenanceBadge, Skeleton, SplitPane } from "@/components/patterns";
import { Banner, ErrorState, FOCUS_RING, LINK_CLASSES, Panel, TEXT_TARGET } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { useEntityCrumb } from "@/hooks/useEntityCrumb";
import { useSessionUser } from "@/hooks/useSessionUser";
import {
  consensusItems,
  currencyUnit,
  detailQuery,
  externalLinks,
  holderDetailItems,
  holderQuery,
  holdersNoMatch,
  indicatorForSymbol,
  infoSearchEntityLink,
  institutionHref,
  marketStateText,
  profileItems,
  stockEntityKey,
  stockHref,
  stockStatItems,
} from "@/lib/detail";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, formatKst, formatNumber, formatUsd, formatWeightPercent, withoutLeadingIcon } from "@/lib/format";
import { liveStatusText, tradedAtText } from "@/lib/livePrices";
import type { DetailMarket, DetailQuote, GuruHoldersResponse, MacroOverview } from "@/lib/types";
import {
  AiSummaryCard,
  type DetailLink,
  ExternalAnchor,
  ExternalLinksCard,
  LinkListPanel,
  NEWS_SOURCES,
  NewsCard,
  PriceChartPanel,
  propertyItems,
} from "./DetailParts";
import { type DetailTab, DetailTabs } from "./DetailTabs";
import { useDetailVisit } from "./useDetailVisit";
import { useStockQuote } from "./useStockQuote";

/** 13F 보유 기관 목록에 보이는 줄 수. */
const HOLDERS_SHOWN = 10;

/** 13F 보유 기관의 출처(이 대시보드 저장본). */
const HOLDERS_SOURCE = "SEC EDGAR 13F(이 대시보드 저장본)";

type StockTab = "overview" | "news" | "research" | "holders";

/**
 * 종목 상세(/s/<시장>/<코드>) — 작업대 대상 문법(P4 — 정보 검색 대상 화면과 같은 틀): 대상 머리(이름·종목 줄·현재가·전일 대비·장 상태·시세 출처·
 * 실시간 주기·정보 검색 바로가기) → 왼쪽 핵심 지표·회사 개요·애널리스트 의견 속성 · 가운데 탭(개요: 가격 차트 패널·회사 소개·AI 요약 / 뉴스 /
 * 리서치(증권사 리포트가 있을 때) / 보유 기관(미국 주식 — 13F 목록-검사)) · 오른쪽 연결(같은 심볼의 지표 상세·정보 검색)·다른 곳에서 보기·출처.
 *
 * - 미국·해외(지수 ^·환율 =X·선물 =F 포함)는 Yahoo Finance, 국내 6자리는 네이버 증권 — 수집기 실시간 조회(GET /api/detail/quote, 5분 캐시).
 * - 차트는 Yahoo 시계열(GET /api/macro/ticker — 국내는 .KS·.KQ 심볼). 값이 없으면 "—", 받지 못한 출처는 그 이유를 적습니다.
 * - 출처 링크: 머리 배지(시세 출처), '출처' 패널(시세 '출처 보기'·한국어 개요), 뉴스 제목(원문 기사), 외부 링크 묶음(Yahoo·Google Finance·Investing.com·
 *   네이버·SEC·DART).
 * - 가격·전일 대비는 실시간 시세(ADR 0024 — 고른 주기마다 서버가 밀어 줌, 기본 10초, 장중 카드·보유 표와 같은 주기)가 오면 그 값으로 바꿉니다
 *   (사용자 요청 2026-11-03 — 모의 매매에서 종목을 누르면 이 화면). 지표·개요는 위 시세 응답 그대로.
 * - 같은 Yahoo 심볼의 매크로 카드(/s/us/^GSPC → S&P 500)가 있으면 그 지표 상세로 잇습니다 — 매크로 개요 저장본(GET /api/macro/overview?live=false,
 *   지표 상세·홈과 같은 경로·응답 캐시)을 한 번 읽습니다. 매크로 카드 티커는 Yahoo 심볼이라 국내 6자리 종목에서는 읽지 않습니다.
 * - 탭은 화면 안 상태(주소 그대로)이고 숨긴 탭도 처음에 읽습니다(DetailTabs — 요청이 탭 전과 같음). 결정·사건 기록 API가 없어 타임라인 탭은 없습니다.
 */
export function StockDetailScreen({ market, code }: { market: DetailMarket; code: string }) {
  const { quoteState, quote, realtime, live, shown, price, change, changePct, name, symbol, digits, sub } = useStockQuote(market, code);
  const user = useSessionUser();
  const macro = useApi<MacroOverview>(market === "us" ? endpoints.macro.overview(false) : null);
  const holders = market === "us" && (quote?.kind ?? "").toUpperCase() === "EQUITY" ? holderQuery(quote?.name) : null;
  // 뉴스·AI 요약의 검색어는 백엔드 상한(60자) 안으로 — 시세 이름은 Yahoo의 긴 이름이라 넘으면 400(QA-448). 뉴스 카드의 정보 검색 링크도 같은 말로.
  const newsQuery = detailQuery(quote?.name) ?? undefined;
  const unit = currencyUnit(quote?.currency);
  const indicator = indicatorForSymbol(macro.data, quote ? symbol : null);
  const entityLink = infoSearchEntityLink(stockEntityKey(market, code), "정보 검색에서 보기", user);
  // 넓은 화면 빵부스러기의 마지막 칸을 코드 대신 종목 이름으로(시세를 읽은 뒤에만 — 셸이 같은 주소일 때만 씀).
  useEntityCrumb(quote ? stockHref(market, code) : null, quote ? name : null);
  // 명령 팔레트의 최근 연 대상 — 시세를 읽은 뒤에만(조회하지 않음·실패는 넣지 않음).
  useDetailVisit("ticker", quote ? stockHref(market, code) : null, quote ? name : null, quote ? sub : null);

  let placeholder;
  if (!quoteState.data) {
    placeholder = quoteState.error ? <Banner tone="danger">{quoteState.error}</Banner> : <Skeleton lines={2} label="시세를 불러오는 중" />;
  } else if (!quoteState.data.available) {
    placeholder = <p className="text-sm text-text-2">{quoteState.data.message ?? "시세를 조회하지 않습니다."}</p>;
  }

  const links: DetailLink[] = [
    ...(indicator ? [{ label: `${indicator.name} 지표 상세`, href: indicator.href }] : []),
    ...(entityLink ? [{ label: `${name} 정보 검색 대상 화면`, href: entityLink.href }] : []),
  ];

  const tabs: DetailTab<StockTab>[] = [
    {
      key: "overview",
      label: "개요",
      content: (
        <>
          <PriceChartPanel
            title={`${name} 시세`}
            symbol={symbol}
            valueDigits={digits}
            unit={unit}
            caption={quote ? `차트: Yahoo Finance ${symbol} 일별 종가` : null}
          />
          {quote ? <AboutPanel quote={quote} /> : null}
          <AiSummaryCard request={{ market, code, q: newsQuery, label: detailQuery(name) ?? undefined }} />
        </>
      ),
    },
    {
      key: "news",
      label: "뉴스",
      // 회사 이름(구글 뉴스 검색어)은 시세 응답에 있어, 시세를 읽기 전에는 부르지 않습니다 — 이름 없이 한 번, 이름과 함께 또 한 번 부르지 않게.
      content: (
        <NewsCard path={quoteState.data || quoteState.error ? endpoints.detail.news({ market, code, q: newsQuery }) : null} searchQuery={newsQuery ?? code} />
      ),
    },
    ...(quote && quote.research.length > 0 ? [{ key: "research" as const, label: "리서치", content: <ResearchPanel quote={quote} /> }] : []),
    ...(holders ? [{ key: "holders" as const, label: "보유 기관", content: <HoldersPanel query={holders} /> }] : []),
  ];

  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
      <EntityHeader
        kind="stock"
        name={name}
        description={sub}
        valueLabel="현재가"
        value={price !== null ? formatNumber(price, digits) : null}
        unit={unit}
        change={
          change !== null || changePct !== null ? (
            <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
              <ChangeChip change={change} changePct={changePct} digits={digits} pctDigits={2} />
              <span className="text-xs text-text-3">전일 대비</span>
            </span>
          ) : undefined
        }
        placeholder={placeholder}
        badges={
          quote ? (
            <>
              {live && shown ? (
                <span className="text-xs text-text-2" title={`출처 ${live.source}`}>
                  {shown.session ?? "실시간"} {tradedAtText(shown.tradedAt)} KST
                  {!shown.session && liveStatusText(live.status) ? ` · ${liveStatusText(live.status)}` : ""} · {live.source}
                </span>
              ) : marketStateText(quote.marketState) ? (
                <span className="text-xs text-text-2">{marketStateText(quote.marketState)}</span>
              ) : null}
              <ProvenanceBadge source={quote.source?.label} asOf={quote.asOf ? formatKst(quote.asOf) : null} />
              {realtime.error ? (
                <StatusText tone="warn" iconSize={12} className="text-xs">
                  {realtime.error}
                </StatusText>
              ) : null}
              {quote.error ? (
                <StatusText tone="warn" iconSize={12} className="basis-full text-xs">
                  일부 값을 받지 못했습니다 — {quote.error}
                </StatusText>
              ) : null}
            </>
          ) : undefined
        }
        actions={
          <>
            {quote ? <LiveIntervalSelect /> : null}
            {entityLink ? (
              <Link href={entityLink.href} className={`${LINK_CLASSES} text-sm`}>
                {entityLink.label}
              </Link>
            ) : null}
          </>
        }
      />
      <SplitPane
        left={
          <>
            <Panel title="핵심 지표" source={quote?.source?.label ?? undefined}>
              {/* 시세를 읽지 못했거나 받지 않았으면(store_only 등 — 이유는 대상 머리가 적음) '불러오는 중'으로 두지 않습니다(QA-190). */}
              {quote ? (
                <PropertyList items={propertyItems(stockStatItems(quote))} emptyText="핵심 지표를 받지 못했습니다." />
              ) : quoteState.error ? (
                <ErrorState message={quoteState.error} onRetry={() => void quoteState.reload()} />
              ) : quoteState.data ? (
                <p className="text-sm text-text-2">시세를 받지 않아 핵심 지표가 없습니다.</p>
              ) : (
                <Skeleton lines={4} label="핵심 지표를 불러오는 중" />
              )}
            </Panel>
            {quote ? <ProfilePanel quote={quote} /> : null}
            {quote?.consensus ? (
              <Panel title="애널리스트 의견" subtitle="증권사 의견의 평균입니다 — 이 화면의 판단이 아닙니다." source={quote.source?.label ?? undefined}>
                <PropertyList items={propertyItems(consensusItems(market, quote))} />
              </Panel>
            ) : null}
          </>
        }
        right={
          <>
            <LinkListPanel title="연결" links={links} />
            <ExternalLinksCard links={externalLinks(market, code, symbol, quote?.name)} />
            <Panel title="출처">
              <PropertyList items={sourceItems(quote, symbol, Boolean(holders))} />
            </Panel>
          </>
        }
      >
        <DetailTabs label={`${name} 내용`} tabs={tabs} />
      </SplitPane>
    </div>
  );
}

/** '출처' 패널 줄 — 시세(출처 이름·기준 시각·'출처 보기' 새 창), 한국어 개요, 차트, 뉴스, 리서치·13F(있을 때만). */
function sourceItems(quote: DetailQuote | null, symbol: string, holders: boolean): PropertyItem[] {
  const ko = quote?.profile?.koSource ?? null;
  const items: PropertyItem[] = [
    {
      label: "시세",
      value: quote?.source ? (
        <span className="inline-flex flex-wrap items-baseline justify-end gap-x-2">
          <span>{quote.source.label}</span>
          {quote.source.url ? (
            <ExternalAnchor href={quote.source.url} className={`${LINK_CLASSES} text-xs`}>
              출처 보기
            </ExternalAnchor>
          ) : null}
        </span>
      ) : null,
      note: quote?.asOf ? `기준 ${formatKst(quote.asOf)}` : null,
    },
    ...propertyItems(
      ko ? [{ label: "한국어 개요", value: ko.label, link: { href: ko.url, external: true } }] : [],
    ),
    { label: "차트", value: quote ? `Yahoo Finance ${symbol} 일별 종가` : null },
    { label: "뉴스", value: NEWS_SOURCES },
  ];
  if (quote && quote.research.length > 0) items.push({ label: "리서치", value: "네이버 증권 리서치" });
  if (holders) items.push({ label: "13F", value: HOLDERS_SOURCE });
  return items;
}

/** 회사 개요(왼쪽 속성) — 섹터·업종·나라·직원 수·홈페이지. 받은 값이 없으면 그리지 않습니다(개요 글은 가운데 '회사 소개'). */
function ProfilePanel({ quote }: { quote: DetailQuote }) {
  const items = profileItems(quote);
  const profile = quote.profile;
  if (!profile || items.length === 0) return null;
  return (
    <Panel title="회사 개요" source={profile.koSource ? `${profile.koSource.label} · ${quote.source?.label ?? "Yahoo Finance"}` : quote.source?.label ?? undefined}>
      <PropertyList items={propertyItems(items)} />
    </Panel>
  );
}

/**
 * 회사 소개(가운데 개요 탭) — 사업 설명 글. 한국어로(사용자 요청 2026-11-02): 미국은 네이버 증권 해외주식 기업 개요(출처 링크), 국내 주식은 WISEfn
 * 기업개요, 국내 ETF는 네이버 개요. 한국어가 없으면 Yahoo 영문 원문을 그렇다고 적고 보입니다. 글이 없으면 그리지 않습니다.
 * 긴 글 단계(running 15/24, 최대 72자)이고, 10줄을 넘으면 처음에는 10줄로 접고 '자세히'로 폅니다(넘는지는 그린 높이로 잼 — 넘지 않으면 단추 없이 다 보임).
 */
function AboutPanel({ quote }: { quote: DetailQuote }) {
  const profile = quote.profile;
  const summary = profile ? (profile.summaryKo ?? profile.summary) : null;
  if (!profile || !summary) return null;
  const english = !profile.summaryKo && Boolean(profile.summary);
  return (
    <Panel title="회사 소개" source={profile.koSource?.label ?? quote.source?.label ?? undefined}>
      <FoldText text={summary} />
      {english ? <p className="mt-2 text-xs text-text-3">한국어 개요가 없어 Yahoo 영문 원문을 보입니다.</p> : null}
      {profile.koSource ? (
        <p className="mt-2 text-xs">
          <ExternalAnchor href={profile.koSource.url} className={`${LINK_CLASSES} text-xs`}>
            한국어 개요 출처 — {profile.koSource.label}
          </ExternalAnchor>
        </p>
      ) : null}
    </Panel>
  );
}

/** 접는 줄 수 — 이보다 길면 처음에는 이만큼만 보이고 '자세히'로 폅니다. */
const FOLD_LINES = "line-clamp-[10]";

/**
 * 긴 글 접기 — 10줄로 그려 그린 높이가 넘치면(scrollHeight > clientHeight) '자세히' 단추를 둡니다. 넘치지 않으면 단추가 없고 글이 다 보입니다 —
 * 단추 없이 글을 자르지 않습니다. 폭이 바뀌면(ResizeObserver) 다시 잽니다. 단추는 aria-expanded와 aria-controls로 글을 가리킵니다.
 */
function FoldText({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const id = useId();
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || open) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [text, open]);
  return (
    <>
      <p id={id} ref={ref} className={`max-w-[72ch] whitespace-pre-line break-keep text-running text-text-2 wrap-anywhere ${open ? "" : FOLD_LINES}`.trim()}>
        {text}
      </p>
      {overflows || open ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
          className={`${TEXT_TARGET} mt-1 rounded-sm text-sm font-medium text-accent underline-offset-2 hover:underline ${FOCUS_RING}`}
        >
          {open ? "접기" : "자세히"}
        </button>
      ) : null}
    </>
  );
}

/** 증권사 리포트(국내 — 네이버 증권 리서치). 제목은 원문 링크. */
function ResearchPanel({ quote }: { quote: DetailQuote }) {
  return (
    <Panel title="증권사 리포트" count={`${quote.research.length}건`} source="네이버 증권 리서치">
      <ul className="-my-1 divide-y divide-border">
        {quote.research.map((item) => (
          <li key={item.url} className="py-2.5 text-sm">
            <ExternalAnchor href={item.url}>{item.title ?? "제목 없음"}</ExternalAnchor>
            <p className="mt-0.5 text-xs text-text-3">{[item.broker, item.date].filter(Boolean).join(" · ") || EMPTY}</p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

type HolderRow = GuruHoldersResponse["rows"][number];

/**
 * 13F 보유 기관(가운데 '보유 기관' 탭) — 이 대시보드가 받은 13F 기관 가운데 공시 이름이 회사 이름과 맞는 보유 줄(이름이 들어가거나 잘린 공시 이름의
 * 앞부분으로 회사 이름이 시작함, 비중 순). 이름으로 찾으므로 다른 회사가 섞일 수 있어 줄마다 공시 이름을 함께 적습니다. 목록-검사(MasterDetail):
 * 줄을 고르면 넓은 화면은 오른쪽 검사 칸, 좁은 화면은 대화상자에 그 줄의 속성(기관·공시 이름·CUSIP·비중·평가액·보고일)과 '기관 상세 열기'.
 * 한 줄도 없으면 찾은 이름과 그 한계를 적고 없다고 단정하지 않습니다(QA-436).
 */
function HoldersPanel({ query }: { query: string }) {
  const holders = useApi<GuruHoldersResponse>(endpoints.institution.guruHolders(query));
  const rows = holders.data?.rows ?? [];
  const noMatch = holdersNoMatch(query);
  return (
    <Panel title="13F 보유 기관" subtitle={`‘${query}’ 이름으로 찾은 보유 줄(잘린 공시 이름 포함) — 비중 순`} source={HOLDERS_SOURCE}>
      <MasterDetail<HolderRow>
        label="13F 보유 기관"
        items={rows.slice(0, HOLDERS_SHOWN)}
        itemKey={(row) => `${row.cik}:${row.cusip}`}
        itemLabel={(row) => withoutLeadingIcon(row.institution)}
        count={rows.length > HOLDERS_SHOWN ? () => `${rows.length}줄 가운데 비중 상위 ${HOLDERS_SHOWN}줄` : undefined}
        placeholder={
          !holders.data ? (
            holders.error ? <p className="text-sm text-danger">{holders.error}</p> : <Skeleton lines={3} label="13F 보유 기관을 불러오는 중" />
          ) : undefined
        }
        emptyText={
          <div role="status" className="flex flex-col gap-1 text-sm">
            <p className="font-medium text-text">{noMatch.title}</p>
            <p className="text-text-2">{noMatch.note}</p>
          </div>
        }
        renderItem={(row) => (
          <span className="flex items-baseline justify-between gap-3">
            <span className="min-w-0">
              {/* 기관 이름(한글)은 낱말 사이에서만 줄을 바꾸고(break-keep — '운/용'처럼 음절 사이에서 끊지 않음), 칸보다 긴 낱말만 칸 안에서
                  끊습니다(wrap-anywhere) — 정보 검색 보유 탭과 같은 처리(QA-449). */}
              <span className="block break-keep font-medium text-text wrap-anywhere">{withoutLeadingIcon(row.institution)}</span>
              {/* 공시 이름은 말줄임 없이 이 칸 안에서 줄바꿈하고 보고일은 끊기지 않는 한 덩어리로 이름 뒤에 둡니다 — 한 줄 말줄임일 때 긴 공시 이름이면
                  보고일과 이름 끝이 잘려 무엇이 걸렸는지 가를 수 없었습니다(QA-445, 정보 검색 보유 탭과 같은 처리). */}
              <span className="block text-xs text-text-3 wrap-anywhere">
                {row.name} <span className="whitespace-nowrap">· {row.reportDate}</span>
              </span>
            </span>
            <span className="shrink-0 text-right tabular-nums">
              <span className="block font-medium text-text">{formatWeightPercent(row.weight)}</span>
              <span className="block text-xs text-text-3">{formatUsd(row.value)}</span>
            </span>
          </span>
        )}
        renderDetail={(row) => (
          <div className="flex min-w-0 flex-col gap-2">
            <PropertyList items={propertyItems(holderDetailItems(row))} />
            <Link href={institutionHref(row.cik)} className={`${LINK_CLASSES} text-sm`}>
              기관 상세 열기
            </Link>
          </div>
        )}
      />
    </Panel>
  );
}
