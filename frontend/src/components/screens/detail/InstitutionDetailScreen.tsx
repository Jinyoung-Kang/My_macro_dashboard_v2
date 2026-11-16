"use client";

import Link from "next/link";
import { useId } from "react";
import { LineChart } from "@/components/charts";
import { EntityHeader, MasterDetail, PropertyList, ProvenanceBadge, Skeleton, SplitPane } from "@/components/patterns";
import { Banner, ErrorState, FOCUS_RING, Freshness, LINK_CLASSES, PANEL_CLASSES, Panel, TEXT_TARGET } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useEntityCrumb } from "@/hooks/useEntityCrumb";
import { useSessionUser } from "@/hooks/useSessionUser";
import {
  CHART_KEY,
  detailQuery,
  holdingDetailItems,
  infoSearchEntityLink,
  institutionEntityKey,
  institutionHref,
  institutionLinks,
  institutionNames,
  institutionProperties,
  institutionValueRows,
} from "@/lib/detail";
import { endpoints } from "@/lib/endpoints";
import { formatSignedMinus, formatUsd, formatWeightPercent, withoutLeadingIcon } from "@/lib/format";
import { infoSearchEntry } from "@/lib/search";
import type { Holding, PortfolioResponse } from "@/lib/types";
import { AiSummaryCard, type DetailLink, ExternalLinksCard, LinkListPanel, NEWS_SOURCES, NewsCard, propertyItems } from "./DetailParts";
import { DetailTabs } from "./DetailTabs";

/** 13F 포트폴리오 화면과 같은 요청 값(같은 응답 캐시) — 8분기, 비중 추이 상위 30. */
const QUARTERS = 8;
const TOP_N = 30;
/** 보유 종목 목록에 보이는 줄 수 — 보유 종목 탭 하나를 다 쓰므로 응답의 상위 30을 모두(탭 전에는 옆 칸이라 15). */
const HOLDINGS_SHOWN = 30;

/** 13F 공시의 한계 — 분기마다 45일 안에 공시되어 지금 보유와 다를 수 있습니다. */
const FILING_NOTE = "분기마다 45일 안에 공시 — 지금 보유와 다를 수 있음";

/**
 * 기관 상세(/institutions/<CIK>) — 13F 기관 한 곳을 작업대 대상 문법(P4 — 정보 검색 대상 화면과 같은 틀)으로: 대상 머리(이름·CIK·13F 보고 평가액·
 * 보고 기준일·공시일·신선도·정보 검색 바로가기) → 왼쪽 속성(CIK·보고일·평가액·보유 종목 수·분기 수·수집 시각·기관 소개) · 가운데 탭(개요: 분기별
 * 평가액 추이·AI 요약 / 보유 종목: 목록-검사 / 뉴스) · 오른쪽 연결(13F 포트폴리오·정보 검색)·다른 곳에서 보기(SEC EDGAR)·출처.
 *
 * - 값은 이 대시보드의 13F 저장본(SEC EDGAR, 분기마다 45일 안에 공시 — 지금 보유와 다를 수 있음).
 * - 보유 종목은 응답의 비중 상위 30줄(지난 분기 대비 동작·비중 변화)이고, 줄을 고르면 그 줄의 속성(CUSIP·주식 수·변화)을 검사 칸(좁은 화면 대화상자)에
 *   보입니다. 13F 보유 줄에는 티커가 없고 CUSIP을 티커로 바꾸는 API가 없어 종목 상세로는 잇지 않고 정보 검색(이름)으로 잇습니다.
 *   분기 수를 바꿔 보는 표·비중 추이는 13F 포트폴리오 화면에 있습니다.
 * - 기관 이름은 포트폴리오 응답에만 있습니다 — 받기 전에는 제목만 자리표시('CIK …')로 두고, 뉴스·AI 요약은 이름을 받은 뒤에 부릅니다(QA-453).
 * - 탭은 화면 안 상태(주소 그대로)이고 숨긴 탭도 처음에 읽습니다(DetailTabs). 결정·사건 기록 API가 없어 타임라인 탭은 없습니다.
 */
export function InstitutionDetailScreen({ cik }: { cik: string }) {
  const portfolio = useApi<PortfolioResponse>(endpoints.institution.portfolio(cik, QUARTERS, TOP_N));
  const user = useSessionUser();
  const data = portfolio.data;
  // 기관 이름은 포트폴리오 응답에만 있습니다 — 받기 전에는 제목만 자리표시('CIK …')로 두고, 뉴스·AI 요약은 이름을 받은 뒤에 부릅니다(QA-453 —
  // 자리표시 이름으로 뉴스를 한 번 더 부르거나 'CIK …'를 요약하지 않게). 읽지 못했거나 이름이 없으면 두 카드에 그 까닭을 적습니다.
  const name = data?.institution?.name;
  const names = name ? institutionNames(name) : null;
  const title = names?.display || `CIK ${cik}`;
  // 뉴스·AI 요약의 검색어·이름은 백엔드 상한(60자) 안으로(QA-448).
  const query = names ? (detailQuery(names.query) ?? undefined) : undefined;
  const nameMissing = !query && Boolean(data || portfolio.error);
  const rows = institutionValueRows(data?.quarters);
  const holdings = data?.holdings ?? [];
  const total = data?.latest?.totalValue ?? null;
  const entityLink = infoSearchEntityLink(institutionEntityKey(cik), "정보 검색에서 보기", user);
  const chartHeadingId = useId();
  // 넓은 화면 빵부스러기의 마지막 칸을 'CIK …' 대신 기관 이름으로(이름을 받은 뒤에만 — 셸이 같은 주소일 때만 씀).
  useEntityCrumb(names?.display ? institutionHref(cik) : null, names?.display || null);

  let placeholder;
  if (!data) {
    placeholder = portfolio.error ? <Banner tone="danger">{portfolio.error}</Banner> : <Skeleton lines={2} label="13F 포트폴리오를 불러오는 중" />;
  } else if (!data.available) {
    placeholder = <p className="text-sm text-text-2">{data.message ?? "13F 저장본이 없습니다."}</p>;
  }

  const links: DetailLink[] = [
    { label: "13F 포트폴리오(분기·비중 추이)", href: "/institutions" },
    ...(entityLink ? [{ label: `${title} 정보 검색 대상 화면`, href: entityLink.href }] : []),
  ];
  const sources = propertyItems([
    { label: "13F", value: "SEC EDGAR 13F(이 대시보드 저장본)", note: FILING_NOTE },
    { label: "수집 시각", value: data?.collectedAtKst ?? null },
    { label: "뉴스", value: NEWS_SOURCES },
  ]);

  let chart;
  if (rows.length > 1) {
    chart = (
      <LineChart
        data={rows}
        series={[{ key: CHART_KEY, label: "13F 보고 평가액" }]}
        variant="hero"
        nonNegative
        valueFormat={(value) => formatUsd(value)}
        ariaLabel={`${title} 분기별 13F 보고 평가액`}
      />
    );
  } else if (!data) {
    chart = portfolio.error ? (
      <p className="text-sm text-text-2">13F 포트폴리오를 읽지 못해 추이를 그리지 않습니다.</p>
    ) : (
      <Skeleton height={220} label="분기별 평가액을 불러오는 중" />
    );
  } else {
    chart = <p className="text-sm text-text-2">분기가 둘 이상이어야 추이를 그립니다(지금 {rows.length}분기).</p>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
      <EntityHeader
        kind="institution"
        name={title}
        identifiers={[`CIK ${cik}`]}
        description="13F 기관"
        valueLabel="13F 보고 평가액"
        value={total !== null ? formatUsd(total) : null}
        placeholder={placeholder}
        badges={
          data?.latest ? (
            <>
              <span className="text-xs tabular-nums text-text-2">
                보고 기준일 {data.latest.reportDate} · 공시일 {data.latest.filingDate}
              </span>
              <ProvenanceBadge source="SEC EDGAR 13F" />
            </>
          ) : undefined
        }
        actions={
          <>
            {data ? <Freshness collectedAt={data.collectedAtKst} ageSeconds={data.ageSeconds} refreshError={portfolio.refreshError} /> : null}
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
          <Panel title="속성">
            <PropertyList items={propertyItems(institutionProperties(data, cik))} />
            {!data && !portfolio.error ? <Skeleton lines={4} label="기관 속성을 불러오는 중" /> : null}
          </Panel>
        }
        right={
          <>
            <LinkListPanel title="연결" links={links} />
            <ExternalLinksCard links={institutionLinks(cik)} />
            <Panel title="출처">
              <PropertyList items={sources} />
            </Panel>
          </>
        }
      >
        <DetailTabs
          label={`${title} 내용`}
          tabs={[
            {
              key: "overview",
              label: "개요",
              content: (
                <>
                  <section aria-labelledby={chartHeadingId} className={`min-w-0 ${PANEL_CLASSES}`}>
                    <header className="border-b border-border px-3 py-2.5 lg:px-4">
                      <h2 id={chartHeadingId} className="text-heading-sm text-text">
                        분기별 13F 보고 평가액
                      </h2>
                    </header>
                    <div className="p-3 lg:p-4">{chart}</div>
                  </section>
                  <AiSummaryCard
                    request={query ? { q: query, label: detailQuery(title) ?? undefined } : null}
                    idleText={nameMissing ? "기관 이름을 받지 못해 요약하지 않습니다." : undefined}
                  />
                </>
              ),
            },
            {
              key: "holdings",
              label: "보유 종목",
              content: <HoldingsPanel data={data} error={portfolio.error} onRetry={() => void portfolio.reload()} />,
            },
            {
              key: "news",
              label: "뉴스",
              content: (
                <NewsCard
                  path={query ? endpoints.detail.news({ q: query }) : null}
                  searchQuery={query}
                  idleText={nameMissing ? "기관 이름을 받지 못해 뉴스를 찾지 않습니다." : undefined}
                />
              ),
            },
          ]}
        />
      </SplitPane>
    </div>
  );
}

/** 보유 줄의 보조 글 — 클래스·동작·비중 변화(%p, −는 U+2212). 말줄임하지 않습니다(좁은 화면에서 비중 변화 값이 잘렸음 — D1 넘김 P5b). */
function holdingSubline(holding: Holding): string {
  return [holding.class, withoutLeadingIcon(holding.action), holding.weightDiff !== null ? `비중 ${formatSignedMinus(holding.weightDiff, 2).text}%p` : null]
    .filter(Boolean)
    .join(" · ");
}

/**
 * 상위 보유 종목(가운데 '보유 종목' 탭) — 목록-검사(MasterDetail): 줄 = 이름·보조 줄(클래스·동작·비중 변화)·비중·평가액, 줄을 고르면 넓은 화면은
 * 오른쪽 검사 칸(처음에 첫 줄), 좁은 화면은 대화상자에 그 줄의 속성과 '정보 검색에서 찾기'. 읽기가 실패하면 '불러오는 중'이 아니라 오류와 다시
 * 시도(QA-190 — 추적하지 않는 CIK는 백엔드 400).
 */
function HoldingsPanel({ data, error, onRetry }: { data: PortfolioResponse | null; error: string | null; onRetry: () => void }) {
  const user = useSessionUser();
  const holdings = data?.holdings ?? [];
  return (
    <Panel
      title="상위 보유 종목"
      subtitle={data?.latest ? `${data.latest.reportDate} 보고 기준 · 비중 순 · 지난 분기 대비` : undefined}
      source="SEC EDGAR 13F"
      actions={
        // 따로 선 링크라 좁은 화면(lg 미만) 누르는 자리 44px(TEXT_TARGET)와 키보드 포커스 링 — 글 높이(16px)뿐이고 링이 없었습니다(QA-531).
        <Link href="/institutions" className={`${TEXT_TARGET} rounded-sm text-xs font-medium text-text underline-offset-2 hover:underline ${FOCUS_RING}`}>
          13F 포트폴리오에서 자세히
        </Link>
      }
    >
      <MasterDetail<Holding>
        label="상위 보유 종목"
        items={holdings.slice(0, HOLDINGS_SHOWN)}
        itemKey={(holding) => `${holding.cusip}:${holding.class}`}
        itemLabel={(holding) => holding.name}
        autoSelectFirst
        count={holdings.length > HOLDINGS_SHOWN ? () => `${holdings.length}종목 가운데 비중 상위 ${HOLDINGS_SHOWN}종목` : undefined}
        placeholder={!data ? error ? <ErrorState message={error} onRetry={onRetry} /> : <Skeleton lines={5} label="보유 종목을 불러오는 중" /> : undefined}
        emptyText={<p className="text-sm text-text-2">{data?.message ?? "보유 종목이 없습니다."}</p>}
        renderItem={(holding) => (
          <span className="flex items-baseline justify-between gap-3">
            <span className="min-w-0">
              <span className="block break-keep font-medium text-text wrap-anywhere">{holding.name}</span>
              <span className="block break-keep text-xs text-text-3 wrap-anywhere">{holdingSubline(holding)}</span>
            </span>
            <span className="shrink-0 text-right tabular-nums">
              <span className="block font-medium text-text">{formatWeightPercent(holding.weight)}</span>
              <span className="block text-xs text-text-3">{formatUsd(holding.value)}</span>
            </span>
          </span>
        )}
        renderDetail={(holding) => {
          const search = infoSearchEntry(holding.name, user);
          return (
            <div className="flex min-w-0 flex-col gap-2">
              <PropertyList items={propertyItems(holdingDetailItems(holding))} />
              {search ? (
                <Link href={search.href} className={`${LINK_CLASSES} text-sm`}>
                  정보 검색에서 찾기
                </Link>
              ) : null}
            </div>
          );
        }}
      />
    </Panel>
  );
}
