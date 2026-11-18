"use client";

import Link from "next/link";
import { useState } from "react";
import { MultiLineSeries, WeightHeatmap } from "@/components/charts";
import { ChangeCell, KpiStrip } from "@/components/patterns";
import { weightHistoryRows } from "@/lib/chartData";
import {
  Callout,
  Card,
  EmptyState,
  ErrorState,
  FOCUS_RING,
  Freshness,
  Loading,
  PageHeader,
  Panel,
  Select,
  SourceBadge,
  Table,
  TEXT_TARGET,
} from "@/components/ui";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CircleDashedIcon,
  MinusIcon,
  PlusIcon,
  XCircleIcon,
} from "@/components/ui/icons";
import { HoldingQuickLink } from "@/components/screens/detail/HoldingQuickLink";
import { useApi } from "@/hooks/useApi";
import { useUsdKrw } from "@/hooks/useUsdKrw";
import {
  EMPTY,
  formatCurrency,
  formatNumber, formatWeightPercent } from "@/lib/format";
import { holdingActionView, type HoldingActionKind } from "@/lib/holdings";
import { institutionHref } from "@/lib/detail";
import {
  holdingRowKeys,
  type InstitutionEntry,
  institutionItems,
  institutionTitle,
  portfolioKpis,
  PORTFOLIO_SOURCE,
  weightLines,
} from "@/lib/institutionsScreen";
import type { PortfolioResponse } from "@/lib/types";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";

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

  const { data, loading, error, reload, refreshError } = useApi<PortfolioResponse>(
    endpoints.institution.portfolio(cik, quarters, topN),
  );
  // 매크로 화면이 이미 수집하는 원/달러를 그대로 씁니다. 여기서 따로 받아 오면
  // 같은 포트폴리오가 메뉴마다 다른 원화 금액으로 보입니다.
  const usdKrw = useUsdKrw();

  const items = institutionItems(institutions.data?.institutions);
  const selected = items.find((item) => item.key === cik);
  // 고른 기관 패널 — 제목(목록 이름, 없으면 포트폴리오 응답의 이름·'CIK …')과 요약 KPI(예전 지표 칸 셋과 같은 값·글).
  const title = institutionTitle(items, cik, data);
  const kpis = portfolioKpis(data?.available ? data : null, usdKrw, PORTFOLIO_SOURCE);
  const history = data?.weightHistory;

  const chartData = history ? weightHistoryRows(history.dates, history.series) : [];

  // 범례·툴팁 이름표(구분자를 남기고 이름 쪽을 줄임 — QA-120)와 선 색(이 파일의 SERIES_COLORS 차례) — lib/institutionsScreen weightLines.
  const chartSeries = weightLines(history?.series, SERIES_COLORS);
  // 보유 표 줄 키 — 'CUSIP:클래스'(겹치면 '#n' 꼬리).
  const holdingKeys = holdingRowKeys(data?.holdings ?? []);

  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      <PageHeader
        title="기관 13F 포트폴리오 분석"
        description="SEC EDGAR 공식 공시 · 분기 공시, 공시 마감 45일 지연"
        actions={<Freshness collectedAt={data?.collectedAtKst} ageSeconds={data?.ageSeconds} refreshError={refreshError} />}
      />

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label="분석할 기관"
            value={cik}
            onChange={setCik}
            options={items.map((item) => ({ value: item.key, label: item.label }))}
          />
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
      </Card>

      {/*
        고른 기관 패널 — 제목 = 기관 이름, 부제 = 기관 목록의 설명(예전 고르기 카드 아래 글과 같은 출처), 머리 동작 = 기관 상세 링크(요청 없음).
        본문은 포트폴리오 읽기 상태 — 읽는 중·오류(다시 시도)·저장본 없음 안내, 값이 오면 요약 KPI 띠.
      */}
      <Panel
        title={title}
        subtitle={selected?.desc || undefined}
        actions={
          // 따로 선 링크라 좁은 화면(lg 미만) 누르는 자리 44px(TEXT_TARGET)와 포커스 링 — 기관 상세 '13F 포트폴리오에서 자세히'와 같은 꼴(중립 잉크·밑줄).
          <Link href={institutionHref(cik)} className={`${TEXT_TARGET} rounded-sm text-xs font-medium text-text underline-offset-2 hover:underline ${FOCUS_RING}`}>
            기관 상세 열기
          </Link>
        }
      >
        {loading && !data && <Loading label="13F 공시를 불러오는 중…" />}
        {error && <ErrorState message={error} onRetry={reload} />}
        {data && !data.available && (
          <Callout tone="warn">{data.error ?? data.message ?? "13F 데이터가 없습니다. 수집기의 weekly 작업을 실행하세요."}</Callout>
        )}
        {kpis.length > 0 && <KpiStrip label="포트폴리오 요약" items={kpis} keepDates />}
      </Panel>

      {data?.available && (
        <>

          <Card
            title="상위 종목 분기별 비중 히트맵" source={SOURCES.sec13f}
            subtitle="색이 진할수록 비중이 큽니다. 어느 칸이 진해지는지만 보면 흐름이 읽힙니다."
          >
            {/*
              선 차트로 15개 종목을 겹쳐 그리면 색이 모자라고 선이 엉켜서, 정작
              "무엇이 늘고 무엇이 줄었나"가 보이지 않았습니다. 히트맵은 같은 값을
              칸의 농도로 칠하고 숫자도 함께 적습니다(색만으로 값을 나르지 않습니다).
            */}
            {Object.keys(data.weightHistory?.series ?? {}).length === 0 ? (
              <EmptyState message="비중 이력을 그릴 분기 데이터가 부족합니다." />
            ) : (
              <WeightHeatmap
                dates={data.weightHistory?.dates ?? []}
                series={data.weightHistory?.series ?? {}}
              />
            )}
          </Card>

          <Card
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
                // 툴팁은 그 분기의 비중 순위 차례로, 글자는 선 색으로(2026-11-17 사용자 요구 — 기본은 이름 차례·본문색).
                tooltipOrder="value"
                tooltipSeriesColors
              />
            )}
          </Card>

          <Card
            title={`보유 종목 상세 (기준일 ${data.latest?.reportDate ?? EMPTY})`} source={`${SOURCES.sec13f} · 원화 환산은 원/달러 최신값(Yahoo Finance)`}
            subtitle={`직전 분기 대비 액션은 비중 변화 ±0.05%p를 기준으로 분류합니다. ${usdKrw.note}`}
          >
            <Table
              rows={data.holdings ?? []}
              rowKey={(_, index) => holdingKeys[index]}
              columns={[
                {
                  key: "name",
                  header: "종목",
                  render: (row) => (
                    <span className="flex flex-col items-start">
                      {/* 이름을 누르면 그 종목의 주가·정보 팝업 창(사용자 요청 2026-11-18 — 티커 없는 줄은 공시 이름으로 찾은 후보를 고름) */}
                      <HoldingQuickLink holding={row} />
                      <span className="text-xs text-text-3">
                        CUSIP {row.cusip} · {row.class}
                      </span>
                    </span>
                  ),
                },
                {
                  key: "weight",
                  header: "비중",
                  align: "right",
                  render: (row) => formatWeightPercent(row.weight),
                },
                {
                  key: "weightDiff",
                  header: "비중 변화",
                  align: "right",
                  // 공용 표 칸 변화(ChangeCell) — ▲▼·부호(−는 U+2212)·sr '상승/하락'과 등락색, 모르면 '—'(QA-696: 예전에는 색과 ASCII '-'만으로 방향을 나름).
                  render: (row) => <ChangeCell change={row.weightDiff} digits={2} unit="%p" />,
                },
                {
                  key: "value",
                  header: "평가액",
                  align: "right",
                  // 총액만 원화로 적으면, 종목 하나가 얼마짜리인지는 여전히
                  // 머리로 곱해야 합니다. 같은 환율로 여기도 함께 적습니다.
                  render: (row) => (
                    <span className="flex flex-col items-end">
                      <span>{formatCurrency(row.value)}</span>
                      {usdKrw.toKrw(row.value) && (
                        <span className="text-xs text-text-3">
                          {usdKrw.toKrw(row.value)}
                        </span>
                      )}
                    </span>
                  ),
                },
                {
                  key: "shares",
                  header: "보유 주식수",
                  align: "right",
                  render: (row) => formatNumber(row.shares, 0),
                },
                {
                  key: "action",
                  header: "직전 분기 대비",
                  render: (row) => <HoldingActionBadge label={row.action} />,
                },
              ]}
            />
          </Card>
        </>
      )}
    </div>
  );
}

const HOLDING_ACTION_ICON: Record<HoldingActionKind, typeof PlusIcon> = {
  new: PlusIcon,
  closed: XCircleIcon,
  added: ChevronUpIcon,
  reduced: ChevronDownIcon,
  unchanged: MinusIcon,
  none: CircleDashedIcon,
};

/**
 * 직전 분기 대비 변화 배지 — 글(신규 매수·비중 확대 …)이 뜻을 나르고, 앞의 아이콘은 장식입니다. 색은 중립 —
 * 상승·하락 색(up·down)은 값이 오르내린 방향 전용이라 매수·매도 판정에 쓰지 않습니다(명세 §7-3).
 */
function HoldingActionBadge({ label }: { label: string | null | undefined }) {
  const view = holdingActionView(label);
  const Icon = HOLDING_ACTION_ICON[view.kind];
  return (
    <SourceBadge>
      <span className="inline-flex items-center gap-1">
        <Icon size={12} className="text-text-3" />
        {view.text}
      </span>
    </SourceBadge>
  );
}
