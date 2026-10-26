"use client";

import type { JSX } from "react";
import {
  Line,
  LineChart as RechartsLineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { EstimateBadge, StaleBadge } from "@/components/patterns/badges";
import { formatNumber } from "@/lib/format";
import {
  hasLineValues,
  isolatedPointIndexes,
  lineChartLabel,
  lineSeriesColors,
  lineTooltipModel,
  lineXTicks,
  lineYAxis,
  normalizeLineRows,
  type LineRow,
  type LineSeriesSpec,
  type LineTooltipModel,
} from "@/lib/lineChart";

// 기본 계열 색은 charts/index.tsx의 SERIES_COLORS 하나만 씁니다(검증한 조합을 두 곳에 적지 않음). index가 이 파일을 다시 내보내므로
// 서로 가져오는 고리가 생깁니다 — 그래서 SERIES_COLORS는 모듈을 읽을 때가 아니라 그릴 때만 읽습니다(최상위에서 읽으면 초기화 전 접근).
import { SERIES_COLORS } from "./index";

/*
 * 차트 틀의 색 — 디자인 토큰 CSS 변수(라이트·다크가 :root에서 함께 바뀜). Recharts 기본 hex(축 #666·커서 #ccc·글자 #808080)는
 * 테마를 모르므로 축·커서·기준선·글자마다 덮습니다. 글자 text-3, 축선 border, 기준선·커서 text-3(격자가 없으니 기준선이 유일한 가로선).
 */
const AXIS_TEXT = "var(--text-3)";
const AXIS_LINE = "var(--border)";
const GUIDE = "var(--text-3)";
const TICK_FONT = 11;

/** 축 끝 날짜 — 첫 날짜는 왼쪽 끝에 붙여(start), 마지막은 오른쪽 끝에 붙여(end) 그립니다. 가운데 정렬이면 SVG 밖으로 잘립니다. */
function EdgeDateTick({
  x,
  y,
  payload,
  first,
  last,
}: {
  x?: number | string;
  y?: number | string;
  payload?: { value?: string | number };
  first: string;
  last: string;
}) {
  const value = String(payload?.value ?? "");
  const anchor = first === last ? "middle" : value === first ? "start" : value === last ? "end" : "middle";
  return (
    <text x={Number(x) || 0} y={Number(y) || 0} dy="0.71em" textAnchor={anchor} fill={AXIS_TEXT} fontSize={TICK_FONT}>
      {value}
    </text>
  );
}

/**
 * 툴팁 상자 — 날짜, 계열마다 짧은 색 선 · 이름 · 값(모르면 "—"), 출처 줄.
 * 바탕은 불투명한 표면(surface)으로 선을 가리고, 테두리는 text-3 1px(그림자 없이 떠 있는 상자임을 보임). 글자에는 계열 색을 입히지 않습니다.
 */
export function LineChartTooltip({ model }: { model: LineTooltipModel | null }) {
  if (!model) {
    return null;
  }
  return (
    <div
      style={{
        backgroundColor: "var(--surface)",
        border: "1px solid var(--text-3)",
        borderRadius: 8,
        fontSize: 12,
        padding: "8px 10px",
        color: "var(--text)",
      }}
    >
      <div style={{ color: "var(--text-2)", fontWeight: 600, marginBottom: 4 }}>{model.date}</div>
      {model.items.map((item) => (
        <div key={item.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span aria-hidden style={{ display: "inline-block", width: 12, height: 2, borderRadius: 1, backgroundColor: item.color }} />
          <span style={{ color: "var(--text-2)" }}>{item.label}</span>
          <strong style={{ marginLeft: "auto", paddingLeft: 12, color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{item.text}</strong>
        </div>
      ))}
      {model.sourceLine ? <div style={{ marginTop: 4, color: AXIS_TEXT }}>{model.sourceLine}</div> : null}
    </div>
  );
}

/**
 * 선 차트 — 격자 없음, Y축은 끝값 두 개(데이터 범위), X축은 첫·마지막 날짜, 0 기준선은 뜻이 있을 때만, 이중 축 없음.
 *
 * - Y 범위·눈금·0선·색·툴팁 글은 `lib/lineChart.ts`가 정합니다(여기서는 그리기만 — ADR 0004).
 * - 모르는 값(null·"N/A")에서 선을 끊습니다(connectNulls=false). 앞뒤가 모두 모름인 외딴 값은 점으로 찍어 사라지지 않게 합니다.
 * - 색은 계열의 `color`, 없으면 SERIES_COLORS 순서대로(되풀이하지 않음 — 모자라면 오류, `lineSeriesColors`).
 * - 계열이 둘 이상이면 글자 범례를 위에 둡니다(색 선은 보조, 이름이 본 뜻).
 * - 자릿수가 다른 계열을 한 축에 겹치지 않습니다 — 두 번째 축은 없습니다. 그런 계열은 패널(차트)을 나눕니다(PRINCIPLES).
 * - 추정·이전 값 플래그가 있으면 배지가 그림 위에 반드시 보입니다(숨기는 옵션 없음).
 *
 * `estimated`·`stale`·`staleReason`·`ariaLabel`은 설계서 §1.5 계약에 더한 선택 props입니다.
 */
export function LineChart({
  data,
  series,
  height = 240,
  valueFormat = (value: number) => formatNumber(value, 2),
  includeZero = false,
  nonNegative = false,
  source,
  estimated,
  stale,
  staleReason,
  ariaLabel,
}: {
  data: readonly LineRow[];
  series: readonly LineSeriesSpec[];
  height?: number;
  valueFormat?: (value: number) => string;
  /** 0이 뜻을 갖는 계열(스프레드·순포지션)만 — 범위에 0을 넣고, 0이 범위 안쪽이면 기준선을 긋습니다. */
  includeZero?: boolean;
  /** 음수가 될 수 없는 양(역레포·잔고) — 축을 0 아래로 내리지 않습니다. */
  nonNegative?: boolean;
  /** 툴팁 맨 아래 "출처 · …" 줄. */
  source?: string | null;
  estimated?: boolean;
  stale?: boolean;
  staleReason?: string | null;
  /** 화면 낭독기용 이름. 없으면 "선 차트: 계열 · 첫 날짜 ~ 마지막 날짜". */
  ariaLabel?: string;
}): JSX.Element {
  const colors = lineSeriesColors(series, Object.values(SERIES_COLORS));
  const badges =
    estimated || stale ? (
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <EstimateBadge estimated={estimated} />
        <StaleBadge stale={stale} reason={staleReason} />
      </div>
    ) : null;

  const yAxis = hasLineValues(data, series) ? lineYAxis(data, series, { includeZero, nonNegative }) : null;
  if (!yAxis) {
    return (
      <div>
        {badges}
        <div className="py-10 text-center text-sm text-text-3">표시할 시계열이 없습니다.</div>
      </div>
    );
  }

  const rows = normalizeLineRows(data, series);
  const xTicks = lineXTicks(rows);
  const first = xTicks[0] ?? "";
  const last = xTicks[xTicks.length - 1] ?? "";
  const tooltipFor = (row: LineRow | undefined) =>
    row ? lineTooltipModel(row, series, colors, valueFormat, source) : null;

  return (
    <figure className="m-0">
      {badges}
      {series.length >= 2 ? (
        <ul aria-label="범례" className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-2">
          {series.map((entry, index) => (
            <li key={entry.key} className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block h-0.5 w-3 rounded-sm" style={{ backgroundColor: colors[index] }} />
              {entry.label}
            </li>
          ))}
        </ul>
      ) : null}
      <ResponsiveContainer width="100%" height={height}>
        {/*
          이름은 Tab으로 닿는 SVG 자체에 붙입니다 — Recharts 접근성 층이 SVG에 role="application"·tabindex=0을 달아 화살표로 점을
          고르게 하므로, 이름이 없으면 화면 낭독기가 이름 없는 'application'만 읽습니다(DonutChart와 같은 이유).
        */}
        <RechartsLineChart
          data={rows}
          aria-label={ariaLabel ?? lineChartLabel(rows, series)}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
        >
          <XAxis
            dataKey="date"
            ticks={xTicks}
            interval={0}
            stroke={AXIS_LINE}
            tickLine={false}
            tick={(props) => <EdgeDateTick {...props} first={first} last={last} />}
          />
          <YAxis
            type="number"
            domain={yAxis.domain}
            ticks={yAxis.ticks}
            interval={0}
            width="auto"
            axisLine={false}
            tickLine={false}
            tick={{ fill: AXIS_TEXT, fontSize: TICK_FONT }}
            tickFormatter={(value: number) => valueFormat(value)}
          />
          <Tooltip
            cursor={{ stroke: GUIDE, strokeWidth: 1 }}
            // 값이 없는 계열도 툴팁에 "—"로 남깁니다 — 기본(filterNull)은 그 줄을 지웁니다.
            filterNull={false}
            isAnimationActive={false}
            wrapperStyle={{ outline: "none", zIndex: 40 }}
            content={(props) => (
              <LineChartTooltip
                model={
                  props.active
                    ? tooltipFor(
                        (props.payload?.[0]?.payload as LineRow | undefined) ??
                          rows.find((row) => row.date === props.label),
                      )
                    : null
                }
              />
            )}
          />
          {yAxis.zeroLine ? <ReferenceLine y={0} stroke={GUIDE} strokeWidth={1} /> : null}
          {series.map((entry, index) => {
            const isolated = new Set(isolatedPointIndexes(rows, entry.key));
            return (
              <Line
                key={entry.key}
                isAnimationActive={false}
                type="monotone"
                dataKey={entry.key}
                name={entry.label}
                stroke={colors[index]}
                strokeWidth={2}
                connectNulls={false}
                dot={(dot) =>
                  isolated.has(dot.index) ? (
                    <circle key={`${entry.key}-${dot.index}`} cx={dot.cx} cy={dot.cy} r={2.5} fill={colors[index]} stroke="none" />
                  ) : null
                }
                activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
              />
            );
          })}
        </RechartsLineChart>
      </ResponsiveContainer>
    </figure>
  );
}
