"use client";

import { useState } from "react";
import { LineSeries, SERIES_COLORS } from "@/components/charts";
import { RangeTabs, sliceByRange, type RangeValue } from "@/components/RangeTabs";
import { Banner, Card, Metric } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { SOURCES } from "@/lib/sources";
import { spreadSummary } from "@/lib/spread";
import { EMPTY, formatNumber, formatSigned } from "@/lib/format";
import type { MacroOverview } from "@/lib/types";

export function SpreadSection({
  title,
  block,
}: {
  title: string;
  block: NonNullable<MacroOverview["spreads"]>["official10y2y"];
}) {
  const [range, setRange] = useState<RangeValue>("10y");

  const allPoints = block?.points ?? [];
  const points = sliceByRange(allPoints, range);
  const scraped = block?.scraped;
  const { change, inverted, pair, subtitle } = spreadSummary(block);

  return (
    <Card
      title={title}
      subtitle={subtitle}
      source={`${SOURCES.fred} · ${SOURCES.tradingView}`}
      actions={<RangeTabs value={range} onChange={setRange} />}
    >
      {/*
        두 값은 서로를 대체하지 않습니다 — 공식은 "확정된 어제까지",
        스크래핑은 "지금 시장". 한쪽만 보여 주면 어제 값을 지금 값으로
        읽거나 그 반대가 됩니다. 나란히 두고 출처와 성격을 함께 적습니다.
        두 묶음을 옆으로 놓는 것은 아주 넓은 화면(2xl)부터입니다 — 지표 값(24px)이 '+0.347%p'로 약 137px이라, 왼쪽 내비가 있는
        1024~1440px에서 옆으로 놓은 세 칸(칸 안쪽 100~127px)을 넘어 옆 칸·묶음 테두리와 겹쳤습니다. 그 아래에서는 위아래로 놓습니다.
      */}
      <div className="grid gap-3 2xl:grid-cols-2">
        <div className="rounded-control border border-border bg-surface p-4">
          <p className="mb-2 text-xs font-semibold text-body">
            공식 확정치 · FRED
            <span className="ml-1 font-normal text-muted">(일별, 하루 이상 지연)</span>
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Metric
              label={`${pair} 스프레드`}
              value={
                block?.latest === null || block?.latest === undefined
                  ? EMPTY
                  : `${formatSigned(block.latest, 3)}%p`
              }
              delta={change}
              deltaText={change === null ? EMPTY : `${formatSigned(change, 3)}%p`}
              deltaDigits={3}
              caption={
                allPoints.length > 0
                  ? `기준일 ${allPoints[allPoints.length - 1].date}`
                  : undefined
              }
            />
            <Metric
              label="직전 확정치"
              value={
                block?.previous === null || block?.previous === undefined
                  ? EMPTY
                  : `${formatSigned(block.previous, 3)}%p`
              }
            />
          </div>
        </div>

        <div className="rounded-control border border-border bg-surface p-4">
          <p className="mb-2 text-xs font-semibold text-body">
            스크래핑 참고 시세 · TradingView
            <span className="ml-1 font-normal text-muted">(지금, 공식 확정치 아님)</span>
            {scraped?.isStale && (
              <StatusText tone="warn" iconSize={12} className="ml-1 align-top font-normal">이전 값 포함(수집 실패)</StatusText>
            )}
          </p>
          {scraped ? (
            // 세 칸은 md(768px)부터 — sm(640px)에서 세 칸이면 칸 안쪽이 130px이라 같은 값이 넘쳤습니다.
            <div className="grid gap-3 md:grid-cols-3">
              <Metric
                label={`${pair} 스프레드`}
                value={
                  scraped.spread === null
                    ? "수집 실패"
                    : `${formatSigned(scraped.spread, 3)}%p`
                }
                delta={scraped.delta}
                deltaText={
                  scraped.delta === null ? EMPTY : `${formatSigned(scraped.delta, 3)}%p`
                }
              />
              <Metric
                label={`미국채 ${block?.longId?.replace("DGS", "")}년물`}
                value={
                  scraped.longValue === null
                    ? EMPTY
                    : `${formatNumber(scraped.longValue, 3)}%`
                }
              />
              <Metric
                label={`미국채 ${block?.shortId?.replace("DGS", "")}년물`}
                value={
                  scraped.shortValue === null
                    ? EMPTY
                    : `${formatNumber(scraped.shortValue, 3)}%`
                }
              />
            </div>
          ) : (
            <p className="py-4 text-xs text-muted">
              스크래핑 시세를 받지 못했습니다. 공식 확정치만 표시합니다.
            </p>
          )}
        </div>
      </div>

      {inverted && (
        <div className="mt-4">
          <Banner tone="danger">
            현재 스프레드가 <strong>역전(음수)</strong> 상태입니다. 역사적으로 1~2년 내
            침체가 뒤따른 구간입니다.
          </Banner>
        </div>
      )}

      <div className="mt-4">
        <p className="mb-2 text-xs text-muted">
          아래 차트는 <strong className="text-body">공식 확정치</strong> 시계열입니다
          (스크래핑 값은 지금 시점 한 점이라 추이로 그리지 않습니다).
        </p>
        <LineSeries
          data={points.map((point) => ({ date: point.date, value: point.value }))}
          unit="%p"
          zeroLine
          color={SERIES_COLORS.blue}
          height={280}
        />
      </div>
    </Card>
  );
}
