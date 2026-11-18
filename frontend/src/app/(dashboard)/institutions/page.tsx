"use client";

import Link from "next/link";
import { useState } from "react";
import { MultiLineSeries, WeightHeatmap } from "@/components/charts";
import { FilterList, type FilterListPendingRow, KpiStrip, Skeleton, SplitPane } from "@/components/patterns";
import { weightHistoryRows } from "@/lib/chartData";
import {
  Callout,
  EmptyState,
  ErrorState,
  FOCUS_RING,
  Freshness,
  Loading,
  PageHeader,
  Panel,
  Select,
  TEXT_TARGET,
} from "@/components/ui";
import { firstLoadPending, useApi } from "@/hooks/useApi";
import { useUsdKrw } from "@/hooks/useUsdKrw";
import { institutionHref } from "@/lib/detail";
import {
  type InstitutionEntry,
  institutionItems,
  institutionSubtitle,
  institutionTitle,
  portfolioKpis,
  portfolioKpisPending,
  PORTFOLIO_SOURCE,
  weightLines,
} from "@/lib/institutionsScreen";
import type { PortfolioResponse } from "@/lib/types";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";
import { HoldingsPanel } from "./HoldingsPanel";

/**
 * 비중 추이 선 10개의 색(순서 고정). dataviz 검증기로 라이트(#ffffff)·다크(#1a1a19) 표면 모두 통과한 값입니다 — 이웃 쌍 색약 ΔE 최소 8.2·
 * 정상 시각 17.2, 밝기 띠·채도·대비 3:1 모두 통과. 예전 값(#58A6FF…)은 색약 5.1(노랑↔초록)·다크 밝기 띠 6칸 이탈·회색 한 칸으로
 * 실패해, 칸마다 가장 가까운 통과 값으로 옮겼습니다(모든 쌍 최소 정상 ΔE 8.1은 예전과 같음 — 10개는 범례·히트맵 표가 함께 나름).
 */
const SERIES_COLORS = [
  "#4798ee", "#1da967", "#c68206", "#eb5070", "#a371f7",
  "#22a2bd", "#dd6836", "#8b8dd1", "#81a022", "#cf7787",
];

/**
 * 기관 13F 포트폴리오 분석.
 *
 * 주의: 13F는 분기 공시이며 **45일 지연**입니다. 지금의 포지션이 아니라 지난
 * 분기말 스냅샷이라는 점을 화면이 계속 상기시켜야 합니다.
 */
export default function InstitutionsPage() {
  const institutions = useApi<{ institutions: InstitutionEntry[] }>(
    endpoints.institution.institutions,
  );
  const [cik, setCik] = useState("0001067983");   // 버크셔 해서웨이
  const [quarters, setQuarters] = useState("8");
  const [topN, setTopN] = useState("30");

  const { data, loading, error, reload, refreshError, failedAt } = useApi<PortfolioResponse>(
    endpoints.institution.portfolio(cik, quarters, topN),
  );
  // 매크로 화면이 이미 수집하는 원/달러를 그대로 씁니다. 여기서 따로 받아 오면
  // 같은 포트폴리오가 메뉴마다 다른 원화 금액으로 보입니다.
  const usdKrw = useUsdKrw();

  const items = institutionItems(institutions.data?.institutions);
  // 기관 목록을 아직 못 받았거나 읽지 못했으면 목록 대신 — 실패면 오류(다시 시도는 누를 때만 읽음), 실패 뒤 다시 읽는 중이면 짧은 자리표시.
  // 처음 읽는 동안은 거르기 목록의 목록 꼴 자리(pending — 아래 PENDING_INSTITUTIONS)입니다.
  const institutionsPlaceholder =
    institutions.data === null ? (
      institutions.error ? (
        <ErrorState message={institutions.error} onRetry={institutions.reload} />
      ) : institutions.loading && !firstLoadPending(institutions) ? (
        <Skeleton lines={2} label="기관 목록을 불러오는 중" />
      ) : undefined
    ) : undefined;
  // 고른 기관 패널 — 제목(목록 이름, 없으면 포트폴리오 응답의 이름·'CIK …')과 요약 KPI(예전 지표 칸 셋과 같은 값·글).
  const title = institutionTitle(items, cik, data);
  // 부제 — 목록의 설명(없으면 포트폴리오 응답의 같은 글). 둘 다 읽는 중이면 한 줄을 비워 두어, 늦게 온 설명이 끼어들며 아래 KPI 띠를 밀지 않게 합니다.
  const subtitleText = institutionSubtitle(items, cik, data);
  const subtitle =
    subtitleText ?? (institutions.loading || loading ? <span aria-hidden="true">{"\u00a0"}</span> : undefined);
  const kpis = portfolioKpis(data?.available ? data : null, usdKrw, PORTFOLIO_SOURCE);
  // 포트폴리오를 처음 읽는 동안(값도 앞선 실패도 없음)은 값 꼴의 KPI 자리, 실패 뒤 다시 읽는 동안은 '불러오는 중' 한 줄(QA-655와 같은 규칙).
  const portfolioFirstLoad = firstLoadPending({ data, loading, failedAt });
  const history = data?.weightHistory;

  const chartData = history ? weightHistoryRows(history.dates, history.series) : [];

  // 범례·툴팁 이름표(구분자를 남기고 이름 쪽을 줄임 — QA-120)와 선 색(이 파일의 SERIES_COLORS 차례) — lib/institutionsScreen weightLines.
  const chartSeries = weightLines(history?.series, SERIES_COLORS);

  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
      <PageHeader
        title="기관 13F 포트폴리오 분석"
        description="SEC EDGAR 공식 공시 · 분기 공시, 공시 마감 45일 지연"
        actions={<Freshness collectedAt={data?.collectedAtKst} ageSeconds={data?.ageSeconds} refreshError={refreshError} />}
      />

      <SplitPane
        columns={2}
        left={
          <>
            {/*
              기관 목록 — 고르면 그 기관의 포트폴리오를 읽습니다(예전 '분석할 기관' 고르기 상자와 같은 상태·요청). 넓은 화면은 세로 목록(줄 32px),
              좁은 화면은 44px 태그가 줄을 바꾸며 늘어섭니다(접지 않음 — 조작이 첫 화면에 바로 보이게).
            */}
            <Panel title="기관" count={items.length > 0 ? `${items.length.toLocaleString("ko-KR")}곳` : undefined}>
              <FilterList
                label="분석할 기관"
                items={items.map((item) => ({ key: item.key, label: item.label }))}
                selected={[cik]}
                onToggle={setCik}
                selection="single"
                narrow="wrap"
                placeholder={institutionsPlaceholder}
                pending={firstLoadPending(institutions) ? { label: "기관 목록을 불러오는 중", rows: PENDING_INSTITUTIONS } : null}
              />
            </Panel>
            <Panel title="조회 조건">
              <div className="flex flex-wrap items-end gap-3">
                <Select
                  label="조회 분기 수"
                  value={quarters}
                  onChange={setQuarters}
                  options={["1", "2", "4", "8"].map((value) => ({
                    value,
                    label: `최근 ${value}개 분기`,
                  }))}
                />
                <Select
                  label="표시 종목 수"
                  value={topN}
                  onChange={setTopN}
                  options={["10", "20", "30", "50"].map((value) => ({
                    value,
                    label: `상위 ${value}개`,
                  }))}
                />
              </div>
            </Panel>
          </>
        }
      >
        {/*
          고른 기관 패널 — 제목 = 기관 이름, 부제 = 기관 목록의 설명, 머리 동작 = 기관 상세 링크(요청 없음).
          본문은 포트폴리오 읽기 상태 — 읽는 중·오류(다시 시도)·저장본 없음 안내, 값이 오면 요약 KPI 띠.
        */}
        <Panel
          title={title}
          subtitle={subtitle}
          actions={
            // 따로 선 링크라 좁은 화면(lg 미만) 누르는 자리 44px(TEXT_TARGET)와 포커스 링 — 기관 상세 '13F 포트폴리오에서 자세히'와 같은 꼴(중립 잉크·밑줄).
            <Link href={institutionHref(cik)} className={`${TEXT_TARGET} rounded-sm text-xs font-medium text-text underline-offset-2 hover:underline ${FOCUS_RING}`}>
              기관 상세 열기
            </Link>
          }
        >
          {loading && !data &&
            (portfolioFirstLoad ? (
              // 이름은 값이 온 뒤의 띠('포트폴리오 요약')와 다르게 — 읽는 중인 영역임을 이름이 말합니다.
              <KpiStrip label="포트폴리오 요약 불러오는 중" items={portfolioKpisPending(PORTFOLIO_SOURCE)} pendingMatchesValue keepDates />
            ) : (
              <Loading label="13F 공시를 불러오는 중…" />
            ))}
          {error && <ErrorState message={error} onRetry={reload} />}
          {data && !data.available && (
            <Callout tone="warn">{data.error ?? data.message ?? "13F 데이터가 없습니다. 수집기의 weekly 작업을 실행하세요."}</Callout>
          )}
          {kpis.length > 0 && <KpiStrip label="포트폴리오 요약" items={kpis} keepDates />}
        </Panel>

        {data?.available && (
          <>
            <Panel
              title="상위 종목 분기별 비중 히트맵" source={SOURCES.sec13f}
              // 히트맵 범례(순차 팔레트 — 어두운 단계 = 0에 가까움, 밝은 단계일수록 큼)와 같은 말로 적습니다(예전 계열 파랑 농도 때의 '진할수록'은 반대로 읽힘).
              subtitle="칸이 밝을수록 비중이 큽니다. 어느 칸이 밝아지는지만 보면 흐름이 읽힙니다."
            >
              {/*
                선 차트로 15개 종목을 겹쳐 그리면 색이 모자라고 선이 엉켜서, 정작
                "무엇이 늘고 무엇이 줄었나"가 보이지 않았습니다. 히트맵은 같은 값을
                칸 바탕의 순차 단계로 칠하고 숫자도 함께 적습니다(색만으로 값을 나르지 않습니다).
              */}
              {Object.keys(data.weightHistory?.series ?? {}).length === 0 ? (
                <EmptyState message="비중 이력을 그릴 분기 데이터가 부족합니다." />
              ) : (
                <WeightHeatmap
                  dates={data.weightHistory?.dates ?? []}
                  series={data.weightHistory?.series ?? {}}
                />
              )}
            </Panel>

            <Panel
              title="상위 종목 분기별 비중 추이 (선)" source={SOURCES.sec13f}
              subtitle="같은 값을 선으로 본 것입니다. 특정 종목의 방향을 좇을 때 씁니다."
            >
              {chartSeries.length === 0 ? (
                <EmptyState message="비중 추이를 그릴 분기 데이터가 부족합니다." />
              ) : (
                <MultiLineSeries
                  data={chartData}
                  series={chartSeries}
                  unit="%"
                  height={320}
                  // 큰 분석 차트라 가로 격자(명세 W6), 이름은 무엇을 그린 차트인지(낭독기 — 차트 래퍼의 기본 이름은 계열 이름 나열).
                  grid
                  ariaLabel={`${title} 상위 종목 분기별 비중 추이`}
                  // 툴팁은 그 분기의 비중 순위 차례로, 글자는 선 색으로(2026-11-17 사용자 요구 — 기본은 이름 차례·본문색).
                  tooltipOrder="value"
                  tooltipSeriesColors
                />
              )}
            </Panel>

            <HoldingsPanel data={data} krw={usdKrw} />
          </>
        )}
      </SplitPane>
    </div>
  );
}

/**
 * 기관 목록을 처음 읽는 동안의 자리 줄(공용 거르기 목록의 `pending` — 값이 온 뒤의 목록 꼴: 좁은 화면 44px 태그 줄바꿈, 넓은 화면 세로 목록 줄). 예전에는 글 줄
 * 자리표시(Skeleton 6줄 약 140px)라, 목록(390 약 630px·lg 약 664px)이 오면 좁은 화면에서는 아래 조회 조건·고른 기관 패널 전체가, 넓은 화면에서는 왼쪽 조회 조건이
 * 밀렸습니다(자기 빌드 CLS 390 0.436 — `25b75a15`). 좁은 화면 태그 폭(px)과 넓은 화면(왼쪽 13rem 칸) 이름 줄 수는 QA 스택 자료 12곳(목록 차례)을 자기 빌드로 잰
 * 값입니다(390 태그 폭 147~336px, lg 줄 1~3줄 — 합 664px). 목록이 바뀌면 조금 어긋날 수 있습니다 — 자리일 뿐 보이는 수·이름이 아닙니다.
 */
const PENDING_INSTITUTIONS: readonly FilterListPendingRow[] = [
  { tag: 252, lines: 2 },
  { tag: 287, lines: 2 },
  { tag: 225, lines: 2 },
  { tag: 336, lines: 3 },
  { tag: 322, lines: 2 },
  { tag: 147, lines: 1 },
  { tag: 184, lines: 2 },
  { tag: 275, lines: 2 },
  { tag: 322, lines: 3 },
  { tag: 290, lines: 2 },
  { tag: 272, lines: 3 },
  { tag: 300, lines: 2 },
];
