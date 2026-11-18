"use client";

import { useId, type JSX } from "react";

import { LineChart } from "@/components/charts";
import { ChangeChip, EstimateBadge, InspectorSubheading, RangeTabs } from "@/components/patterns";
import { useChartScrub } from "@/hooks/useChartScrub";
import { EMPTY, formatNumber } from "@/lib/format";
import { hasLineValues, scrubModel } from "@/lib/lineChart";
import { HERO_NAV_KEY, NAV_RANGES, type NavRangeKey, type OverviewHeroModel } from "@/lib/paperOverview";

/** 문지르지 않을 때의 읽기 줄 — 상세 화면 가격 차트 패널과 같은 글. */
const SCRUB_HINT = "차트를 누르거나 가리키면 그 날 값";

/**
 * 계좌 검사 칸의 곡선 패널(작업대 P6 — W7 '히어로의 문지르기는 패널 차트에 남김'): 고른 계좌 한 줄의 순자산 곡선(`LineChart` hero — 중립 잉크 선, 격자 없음)과
 * 기간 탭(아래 '순자산 곡선' 패널의 탭과 같은 기간 상태 — 이름 '{계좌} 순자산 곡선 기간'), 문지르기 읽기 줄(그 점의 날짜·값·단위·'기간 시작 대비'
 * 변화 칩·추정 배지 또는 '· 장부' — 상세 화면 가격 차트 패널과 같은 꼴)과 조용한 알림(날짜 값 + 추정·설명).
 *
 * - 지금 값(단계 표기·추정 배지·서버 글)은 이 패널이 아니라 맨 위 KPI 띠가 적습니다 — 문지른 점의 값과 지금 값의 기준이 한 줄에 섞이지 않습니다.
 * - 오늘 추정 점이 있으면(개요 `navEstimate`) 마지막 줄 → 그 점의 점선 꼬리 — 문지르면 '추정 HH:MM'(현금뿐 계좌는 배지 없이 '장부', 장중 명세 §4).
 * - 계좌가 바뀌면 문지르기를 지웁니다(useChartScrub의 scope — 다시 마운트하지 않음). 고를 기간이 '전체' 하나뿐이면 탭을 그리지 않습니다.
 * - 그리기만 합니다 — 값·글은 lib(overviewHeroModel·scrubModel), 문지르기 상태는 hooks/useChartScrub.
 */
export function AccountCurvePanel({
  model,
  range,
  ranges,
  onRange,
}: {
  model: OverviewHeroModel;
  range: NavRangeKey;
  /** 고를 수 있는 기간(저장 구간 안). */
  ranges: readonly NavRangeKey[];
  onRange: (range: NavRangeKey) => void;
}): JSX.Element {
  const { chart } = model;
  const headingId = useId();
  const { index, onScrub } = useChartScrub(chart.rows.length, model.code);
  const format = (value: number) => formatNumber(value, chart.valueDigits);
  const scrubbable = hasLineValues(chart.rows, chart.series);
  const point = scrubbable ? scrubModel(chart.rows, HERO_NAV_KEY, index, format, { estimate: chart.estimate }) : null;
  const pointMissing = point !== null && point.valueText === EMPTY;
  const title = `${model.name} 순자산 곡선`;
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* 검사 칸 제목 바로 아래 단계(옆 칸 h4·대화상자 h3 — 작업대 P6 검토: 대화상자 h2 아래 h4로 건너뛰었음). */}
        <InspectorSubheading fallback="h4" id={headingId} className="text-sm font-semibold text-text">
          {title}
        </InspectorSubheading>
        {ranges.length > 1 ? (
          <RangeTabs ranges={NAV_RANGES} allowed={ranges} value={range} onChange={onRange} label={`${model.name} 순자산 곡선 기간`} />
        ) : null}
      </div>
      {scrubbable ? (
        // 눈으로 읽는 줄 — 낭독은 아래 알림 영역. 줄 높이를 미리 잡아 문지르기 시작에 아래가 밀리지 않게(두 줄 자리).
        <div aria-hidden="true" className="flex min-h-[2.375rem] flex-wrap items-baseline gap-x-1.5 gap-y-1 text-caption">
          {point !== null ? (
            <>
              <span className="tabular-nums text-text-2">{point.dateText}</span>
              <span className={`font-semibold tabular-nums ${pointMissing ? "text-text-3" : "text-text"}`}>{point.valueText}</span>
              {!pointMissing ? <span className="text-xs text-text-3">{model.unit}</span> : null}
              {point.change !== null || point.changePct !== null ? (
                <>
                  <ChangeChip size="sm" change={point.change} changePct={point.changePct} digits={chart.valueDigits} pctDigits={2} />
                  <span className="text-xs text-text-3">기간 시작 대비</span>
                </>
              ) : null}
              {point.isEstimated ? (
                <EstimateBadge estimated note={point.estimateNote} />
              ) : point.estimateNote ? (
                <span className="text-xs text-text-2">· {point.estimateNote}</span>
              ) : null}
            </>
          ) : (
            <span className="text-xs text-text-3">{SCRUB_HINT}</span>
          )}
        </div>
      ) : null}
      <div className="min-w-0">
        <LineChart
          data={chart.rows}
          series={chart.series}
          variant="hero"
          nonNegative
          valueFormat={format}
          ariaLabel={title}
          onScrub={onScrub}
        />
      </div>
      {scrubbable ? (
        // 조용한 알림 — 문지른 점의 '날짜 값 단위'(추정 점이면 '추정'과 그 설명 — '추정 23:58', 장부 값 꼬리 점이면 '장부'). 문지르지 않으면 비워 둡니다.
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {point !== null
            ? `${point.dateText} ${point.valueText}${pointMissing ? "" : ` ${model.unit}`}${point.isEstimated ? " 추정" : ""}${
                point.estimateNote ? ` ${point.estimateNote}` : ""
              }`
            : ""}
        </div>
      ) : null}
    </section>
  );
}
