"use client";

import { useState } from "react";
import { MultiLineSeries, WeightHeatmap } from "@/components/charts";
import { distinctLabels } from "@/lib/chartAxis";
import { weightHistoryRows } from "@/lib/chartData";
import {
  Banner,
  Card,
  EmptyState,
  ErrorState,
  Freshness,
  Loading,
  Metric,
  Select,
  SourceBadge,
  Table,
} from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useUsdKrw } from "@/hooks/useUsdKrw";
import {
  deltaColor,
  EMPTY,
  formatCurrency,
  formatNumber, formatWithUnit } from "@/lib/format";
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

/** 선 이름표 폭 — 예전 '앞 18자 + …'와 같은 폭입니다. 구분자가 붙은 이름표는 구분자만큼 더 길 수 있습니다. */
const LINE_LABEL_WIDTH = 19;

/**
 * 📑 기관 13F 포트폴리오 분석.
 *
 * ⚠️ 13F는 분기 공시이며 **45일 지연**입니다. 지금의 포지션이 아니라 지난
 * 분기말 스냅샷이라는 점을 화면이 계속 상기시켜야 합니다.
 */
export default function InstitutionsPage() {
  const institutions = useApi<{ institutions: { key: string; name: string; cik: string; desc: string }[] }>(
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

  const selected = institutions.data?.institutions.find((entry) => entry.cik === cik);
  const history = data?.weightHistory;

  const chartData = history ? weightHistoryRows(history.dates, history.series) : [];

  // 범례·툴팁 이름표. 키 뒤의 구분자(' · 클래스', ' · CUSIP …')는 남기고 이름 쪽을 줄입니다 — 앞에서 자르면
  // 같은 이름의 두 줄이 같은 이름표가 됩니다(QA-120).
  const lineKeys = Object.keys(history?.series ?? {}).slice(0, 10);
  const lineLabels = distinctLabels(lineKeys, LINE_LABEL_WIDTH);
  const chartSeries = lineKeys.map((key, index) => ({
    key,
    name: lineLabels[index],
    color: SERIES_COLORS[index % SERIES_COLORS.length],
  }));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-bright">기관 13F 포트폴리오 분석</h1>
          <p className="mt-1 text-xs text-muted">
            SEC EDGAR 공식 공시 · 분기 공시, 공시 마감 45일 지연
          </p>
        </div>
        <Freshness collectedAt={data?.collectedAtKst} ageSeconds={data?.ageSeconds} refreshError={refreshError} />
      </header>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label="분석할 기관"
            value={cik}
            onChange={setCik}
            options={(institutions.data?.institutions ?? []).map((entry) => ({
              value: entry.cik,
              label: entry.name,
            }))}
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
        {selected?.desc && <p className="mt-3 text-xs text-muted">{selected.desc}</p>}
      </Card>

      {loading && !data && <Loading label="13F 공시를 불러오는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}

      {data && !data.available && (
        <Banner tone="warn">
          {data.error ?? data.message ?? "13F 데이터가 없습니다. 수집기의 weekly 작업을 실행하세요."}
        </Banner>
      )}

      {data?.available && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric
              label="최신 공시 기준일"
              value={data.latest?.reportDate ?? EMPTY}
              caption={`제출일 ${data.latest?.filingDate ?? EMPTY}`}
            />
            <Metric
              label="포트폴리오 총액"
              value={formatCurrency(data.latest?.totalValue ?? null)}
              // 달러 금액은 크기가 잘 안 잡힙니다. 매크로 화면이 이미 수집한
              // 같은 원/달러 값으로 환산해 함께 적습니다(환율을 모르면 생략).
              caption={usdKrw.toKrw(data.latest?.totalValue ?? null) ?? undefined}
              note={usdKrw.note}
            />
            <Metric
              label="수집된 분기"
              value={`${data.quarters.length}개`}
              caption={data.quarters.map((q) => q.reportDate).join(", ")}
            />
          </div>

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
              <MultiLineSeries data={chartData} series={chartSeries} unit="%" height={320} />
            )}
          </Card>

          <Card
            title={`보유 종목 상세 (기준일 ${data.latest?.reportDate ?? EMPTY})`} source={`${SOURCES.sec13f} · 원화 환산은 원/달러 최신값(Yahoo Finance)`}
            subtitle={`직전 분기 대비 액션은 비중 변화 ±0.05%p를 기준으로 분류합니다. ${usdKrw.note}`}
          >
            <Table
              rows={data.holdings ?? []}
              rowKey={(row, index) => `${row.cusip}-${index}`}
              columns={[
                {
                  key: "name",
                  header: "종목",
                  render: (row) => (
                    <span className="flex flex-col">
                      <span className="text-body">{row.name}</span>
                      <span className="text-[11px] text-muted">
                        CUSIP {row.cusip} · {row.class}
                      </span>
                    </span>
                  ),
                },
                {
                  key: "weight",
                  header: "비중",
                  align: "right",
                  render: (row) => formatWithUnit(row.weight, 2, "%"),
                },
                {
                  key: "weightDiff",
                  header: "비중 변화",
                  align: "right",
                  render: (row) => (
                    <span className={deltaColor(row.weightDiff)}>
                      {row.weightDiff === null ? EMPTY : `${formatNumber(row.weightDiff, 2)}%p`}
                    </span>
                  ),
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
                        <span className="text-[11px] text-muted">
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
                  render: (row) => <SourceBadge>{row.action}</SourceBadge>,
                },
              ]}
            />
          </Card>
        </>
      )}
    </div>
  );
}
