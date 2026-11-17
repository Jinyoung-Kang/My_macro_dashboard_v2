"use client";

import { useState } from "react";
import { LineSeries, SERIES_COLORS } from "@/components/charts";
import { KpiStrip } from "@/components/patterns";
import { RangeTabs, sliceByRange, type RangeValue } from "@/components/RangeTabs";
import { Callout, Panel } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { SOURCES } from "@/lib/sources";
import { spreadKpis } from "@/lib/macroScreen";
import { spreadSummary } from "@/lib/spread";
import type { MacroOverview } from "@/lib/types";

/** 묶음 머리 — 공식 확정치·스크래핑 참고 시세가 서로를 대체하지 않는다는 것을 성격 글과 함께(h3 — 패널 제목 h2 안). */
function GroupHeading({ title, note }: { title: string; note: string }) {
  return (
    <h3 className="mb-2 break-keep text-caption font-semibold text-text-2">
      {title}
      <span className="ml-1 font-normal text-text-3">{note}</span>
    </h3>
  );
}

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
  const { change, inverted, pair, subtitle } = spreadSummary(block);
  const kpis = spreadKpis(block, pair, change);

  return (
    <Panel
      title={title}
      subtitle={subtitle}
      source={`${SOURCES.fred} · ${SOURCES.tradingView}`}
      actions={<RangeTabs value={range} onChange={setRange} />}
    >
      {/*
        두 값은 서로를 대체하지 않습니다 — 공식은 "확정된 어제까지", 스크래핑은 "지금 시장". 한쪽만 보여 주면 어제 값을 지금 값으로
        읽거나 그 반대가 됩니다. 묶음마다 머리(출처·성격)와 KPI 띠를 둡니다. 두 묶음을 옆으로 놓는 것은 아주 넓은 화면(2xl)부터입니다 —
        그 아래에서는 묶음마다 띠 폭이 좁아 타일이 눌립니다.
      */}
      <div className="grid gap-4 2xl:grid-cols-2">
        <div className="min-w-0">
          <GroupHeading title="공식 확정치 · FRED" note="(일별, 하루 이상 지연)" />
          <KpiStrip label={`${pair} 공식 확정치`} items={kpis.official} keepDates />
        </div>
        <div className="min-w-0">
          <GroupHeading title="스크래핑 참고 시세 · TradingView" note="(지금, 공식 확정치 아님)" />
          {/* 이어받은 이전 금리(scraped.isStale)는 스프레드·장기·단기 셋 모두에 걸립니다 — 어느 쪽 금리인지는 응답이 말하지 않으므로 띠 밖 묶음 머리에
              한 번 적습니다(스프레드 타일의 '이전 값' 배지는 그대로 — QA-644, 예전 화면의 묶음 머리 상태 글과 같은 뜻). */}
          {kpis.scraped && block?.scraped?.isStale ? (
            <p className="mb-2 text-xs leading-4">
              <StatusText tone="warn" iconSize={12}>
                이전 값 포함(수집 실패) — 장·단기 금리 가운데 이전 금리가 섞여 세 값 모두 지금 시세가 아닐 수 있습니다
              </StatusText>
            </p>
          ) : null}
          {kpis.scraped ? (
            <KpiStrip label={`${pair} 스크래핑 참고 시세`} items={kpis.scraped} keepDates />
          ) : (
            <p className="py-2 text-sm text-text-2">스크래핑 시세를 받지 못했습니다. 공식 확정치만 표시합니다.</p>
          )}
        </div>
      </div>

      {inverted && (
        <div className="mt-4">
          <Callout tone="danger">
            현재 스프레드가 <strong>역전(음수)</strong> 상태입니다. 역사적으로 1~2년 내
            침체가 뒤따른 구간입니다.
          </Callout>
        </div>
      )}

      <div className="mt-4">
        <p className="mb-2 text-xs text-text-3">
          아래 차트는 <strong className="text-text-2">공식 확정치</strong> 시계열입니다
          (스크래핑 값은 지금 시점 한 점이라 추이로 그리지 않습니다).
        </p>
        <LineSeries
          data={points.map((point) => ({ date: point.date, value: point.value }))}
          unit="%p"
          zeroLine
          color={SERIES_COLORS.blue}
          height={280}
          grid
          ariaLabel={`${pair} 공식 확정치 추이`}
        />
      </div>
    </Panel>
  );
}
