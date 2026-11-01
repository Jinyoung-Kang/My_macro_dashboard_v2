"use client";

import { useState } from "react";
import { HorizontalBars } from "@/components/charts";
import {
  Banner,
  Card,
  ErrorState,
  Freshness,
  Loading,
  Metric,
  PageHeader,
  Select,
  SourceBadge,
  Table,
} from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { deltaColor, EMPTY, formatNumber, formatWithUnit } from "@/lib/format";
import type { ScorecardResponse, StockUniverseResponse } from "@/lib/types";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";

/**
 * 종목 스코어카드 — <b>가격으로 잴 수 있는 것만</b>.
 *
 * <p>이 화면은 빠진 것을 먼저 말합니다. 재무 안정성과 성장성은 여기 없습니다 —
 * 이 프로젝트가 재무 데이터를 수집하지 않기 때문입니다. 그래서 이것은 종합
 * 점수가 아니며, 부실기업도 주가만 오르면 높은 점수를 받습니다.
 */
export default function ScorecardPage() {
  const universe = useApi<StockUniverseResponse>(endpoints.insight.stockUniverse);
  const [symbol, setSymbol] = useState("AAPL");
  const [benchmark, setBenchmark] = useState("SPY");
  const [years, setYears] = useState("1");

  const { data, loading, error, reload, refreshError } = useApi<ScorecardResponse>(
    endpoints.insight.scorecard(symbol, benchmark, years),
  );

  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      <PageHeader
        title="종목 스코어카드"
        description={<>모멘텀 · 변동성 · 낙폭 · 추세를 {data?.universeLabel ?? "대형주"} 대비 백분위로</>}
        actions={
          <Freshness
            collectedAt={data?.collectedAtKst}
            ageSeconds={data?.ageSeconds}
            stale={data?.stale}
            refreshError={refreshError}
          />
        }
      />

      {/*
        빠진 것을 결과보다 **먼저** 보여 줍니다. 점수를 본 뒤에 "사실 재무는
        안 봤습니다"를 읽으면, 이미 그 점수로 판단이 끝난 뒤입니다.
      */}
      <Banner tone="warn">
        <div className="font-semibold">이 카드는 종합 점수가 아닙니다.</div>
        <div className="mt-1">
          {data?.caveat ??
            "가격으로 잴 수 있는 것만 담은 카드입니다. 재무가 부실한 회사도 주가가 오르면 높은 점수를 받습니다."}
        </div>
        {(data?.missing?.length ?? 0) > 0 && (
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs">
            {data!.missing.map((item) => (
              <li key={item}>{item} — 수집하지 않습니다</li>
            ))}
          </ul>
        )}
      </Banner>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label="종목"
            value={symbol}
            onChange={setSymbol}
            options={(universe.data?.rows ?? []).map((row) => ({
              value: row.ticker,
              label: `${row.ticker} · ${row.name}`,
            }))}
          />
          <Select
            label="베타 기준"
            value={benchmark}
            onChange={setBenchmark}
            options={[
              { value: "SPY", label: "S&P 500 (SPY)" },
              { value: "QQQ", label: "나스닥 100 (QQQ)" },
              { value: "ACWI", label: "글로벌 주식 (ACWI)" },
            ]}
          />
          <Select
            label="측정 구간"
            value={years}
            onChange={setYears}
            options={["1", "2", "3", "5"].map((value) => ({ value, label: `최근 ${value}년` }))}
          />
        </div>
        {universe.data && !universe.data.available && (
          <Banner tone="warn">{universe.data.message}</Banner>
        )}
      </Card>

      {loading && !data && <Loading label="스코어카드를 계산하는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && <Banner tone="warn">{data.message}</Banner>}

      {data?.available && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              label="종목"
              value={data.symbol}
              caption={data.name ?? undefined}
              note={data.sector ?? undefined}
            />
            <Metric
              label="가격 지표 평균"
              value={data.priceScore === null ? EMPTY : `${formatNumber(data.priceScore, 0)}점`}
              caption={`${data.scoredCount ?? 0}개 지표의 백분위 평균`}
              note="종합 점수가 아닙니다 — 재무·성장·밸류에이션은 빠져 있습니다."
            />
            <Metric
              label={`베타 (vs ${data.benchmark})`}
              value={formatNumber(data.raw?.beta, 2)}
              caption="1.0이면 기준과 같은 폭으로 움직였다는 뜻"
            />
            <Metric
              label="비교 대상"
              value={`${data.universeSize ?? 0}종목`}
              caption={data.universeLabel}
              note="백분위는 이 집단 안에서의 위치입니다."
            />
          </div>

          {(data.metrics?.length ?? 0) > 0 && (
            <Card
              title="지표별 점수" source={SOURCES.equityPrices}
              subtitle="막대 = 백분위(0~100). 원자료를 함께 적어 점수를 검증할 수 있게 합니다."
            >
              <HorizontalBars
                data={data.metrics!
                  .filter((metric) => metric.score !== null)
                  .map((metric) => ({ name: metric.label, value: metric.score as number }))}
                unit="점"
                digits={0}
                valueName="백분위"
                neutral
                height={Math.max(220, (data.metrics?.length ?? 1) * 32)}
              />

              <div className="mt-4">
                <Table
                  rows={data.metrics!}
                  rowKey={(row) => row.label}
                  columns={[
                    {
                      key: "label",
                      header: "지표",
                      render: (row) => (
                        <span className="flex flex-col">
                          <span className="text-body">{row.label}</span>
                          <span className="text-xs text-muted">{row.how}</span>
                        </span>
                      ),
                    },
                    {
                      key: "value",
                      header: "실제 값",
                      align: "right",
                      render: (row) => (
                        <span className={deltaColor(row.value, 1)}>
                          {row.value === null ? EMPTY : `${formatNumber(row.value, 1)}${row.unit}`}
                        </span>
                      ),
                    },
                    {
                      key: "score",
                      header: "백분위",
                      align: "right",
                      render: (row) =>
                        row.score === null ? (
                          <span
                            className="text-muted"
                            // 값 자체가 없으면(표본 부족) 원인은 비교 대상 수가 아닙니다 — 두 경우를 나눠 적습니다(QA-088).
                            title={
                              row.value === null
                                ? "표본이 부족해 값을 잴 수 없어 백분위도 없습니다"
                                : "비교 대상이 10개 미만이라 백분위를 내지 않습니다"
                            }
                          >
                            {EMPTY}
                          </span>
                        ) : (
                          <span className="font-semibold">{formatNumber(row.score, 0)}점</span>
                        ),
                    },
                    {
                      key: "direction",
                      header: "방향",
                      render: (row) => <SourceBadge>{row.direction}</SourceBadge>,
                    },
                  ]}
                />
              </div>
            </Card>
          )}

          <Card title="원자료" source={SOURCES.equityPrices} subtitle="점수로 바꾸기 전의 값입니다.">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="1개월 수익률" value={formatWithUnit(data.raw?.momentum1m, 2, "%")} />
              <Metric label="6개월 수익률" value={formatWithUnit(data.raw?.momentum6m, 2, "%")} />
              <Metric label="표본" value={formatWithUnit(data.raw?.samples, 0, "일")} caption="거래일 수" />
              <Metric label="측정 구간" value={`최근 ${data.years}년`} />
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
