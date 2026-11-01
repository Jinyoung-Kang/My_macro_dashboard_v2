"use client";

import { useEffect, useState, type JSX, type PointerEvent } from "react";
import {
  Line,
  LineChart as RechartsLineChart,
  ReferenceDot,
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
  heroExtremes,
  type HeroExtreme,
  inLegend,
  isolatedPointIndexes,
  lineChartLabel,
  lineSeriesColors,
  lineTooltipModel,
  lineXTicks,
  lineYAxis,
  normalizeLineRows,
  scrubIndex,
  type LineRow,
  type LineSeriesSpec,
  type LineTooltipModel,
} from "@/lib/lineChart";

// 축·기준선·툴팁 상자·글자 범례·기본 계열 색은 래퍼들(index.tsx)과 함께 쓰는 차트 틀(frame.tsx)에서 — 검증한 값을 두 곳에 적지 않습니다.
import {
  AXIS_LINE,
  AXIS_TEXT,
  CHART_FONT,
  ChartLegend,
  EdgeDateTick,
  GUIDE,
  ISOLATED_DOT_R,
  SERIES_COLORS,
  TAIL_DASH,
  TOOLTIP_BOX,
} from "./frame";

/** 히어로 선 — 중립 잉크 하나(방향색을 입히지 않음, 명세 A4). 문지르는 세로 커서는 옅은 경계색. */
const HERO_INK = "var(--text)";
const HERO_CURSOR = "var(--border)";

/** 히어로 그림 위·아래에 남기는 자리(px) — 최고 점 위·최저 점 아래에 적는 끝값 글(12px)이 그림 안에 들어오게(축 범위 여백 8%에 더함). */
const HERO_LABEL_ROOM = 18;

/**
 * 히어로의 Y 끝값 하나 — 본 계열의 실제 최고(보통 점 위)·최저(보통 점 아래) 값을 그 점에 붙여 적습니다(`lib/lineChart` `heroExtremes` — 맞춤과 위·아래는
 * 꼬리와 겹치지 않게 lib가 정함). 축 범위 끝(여백을 더한 값 — 데이터에 없는 숫자)을 그림 오른쪽 안쪽에 적던 예전 끝값은 선·꼬리와 겹쳤습니다.
 */
function HeroExtremeLabel({
  cx,
  cy,
  extreme,
  kind,
  format,
}: {
  cx?: number;
  cy?: number;
  extreme: HeroExtreme;
  /** 최고(high)·최저(low) 표지(시험·검사용). 점의 위·아래는 `extreme.side`. */
  kind: "high" | "low";
  format: (value: number) => string;
}) {
  if (typeof cx !== "number" || typeof cy !== "number" || !Number.isFinite(cx) || !Number.isFinite(cy)) {
    return <g />;
  }
  return (
    <text
      x={cx}
      y={cy}
      dy={extreme.side === "above" ? -8 : 17}
      textAnchor={extreme.anchor}
      fill={AXIS_TEXT}
      fontSize={CHART_FONT}
      data-hero-extreme={kind}
      style={{ fontVariantNumeric: "tabular-nums" }}
    >
      {format(extreme.value)}
    </text>
  );
}

/**
 * 툴팁 상자 — 날짜, 계열마다 짧은 색 선 · 이름 · 값(모르면 "—"), 출처 줄.
 * 상자는 차트 틀의 덮개 모양(TOOLTIP_BOX — 불투명 표면·12px 모서리·덮개 그림자). 글자에는 계열 색을 입히지 않습니다.
 */
export function LineChartTooltip({ model }: { model: LineTooltipModel | null }) {
  if (!model) {
    return null;
  }
  return (
    <div style={TOOLTIP_BOX}>
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
 * 문지르는 점을 알리는 자리 — 툴팁 내용 자리에 두어, Recharts가 마우스·터치·키보드(초점을 둔 차트에서 ←·→) 어느 것으로 정한 활성 자리든
 * 한 길로 받습니다. 활성 자리 글("3")은 `scrubIndex`가 순번으로 바꾸고 범위를 검사합니다. 그리는 것은 없습니다.
 */
function ScrubReporter({
  active,
  activeIndex,
  length,
  onScrub,
}: {
  active: boolean;
  activeIndex: unknown;
  length: number;
  onScrub: (index: number | null) => void;
}) {
  const next = active ? scrubIndex(activeIndex, length) : null;
  useEffect(() => {
    onScrub(next);
  }, [next, onScrub]);
  return null;
}

/**
 * 선 차트 — 격자 없음, Y축은 끝값 두 개(데이터 범위 — 히어로는 실제 최고·최저), X축은 첫·마지막 날짜, 0 기준선은 뜻이 있을 때만, 이중 축 없음, 축 글자 12px.
 *
 * - Y 범위·눈금·0선·색·툴팁 글은 `lib/lineChart.ts`가 정합니다(여기서는 그리기만 — ADR 0004).
 * - 모르는 값(null·"N/A")에서 선을 끊습니다(connectNulls=false). 앞뒤가 모두 모름인 외딴 값은 점으로 찍어 사라지지 않게 합니다.
 * - 색은 계열의 `color`, 없으면 SERIES_COLORS 순서대로(되풀이하지 않음 — 모자라면 오류, `lineSeriesColors`).
 * - 계열이 둘 이상이면 글자 범례를 위에 둡니다(색 선은 보조, 이름이 본 뜻).
 * - 자릿수가 다른 계열을 한 축에 겹치지 않습니다 — 두 번째 축은 없습니다. 그런 계열은 패널(차트)을 나눕니다(PRINCIPLES).
 * - 추정·이전 값 플래그가 있으면 배지가 그림 위에 반드시 보입니다(숨기는 옵션 없음).
 * - 꼬리 계열(`tailOf` — 장중 값 단계의 오늘 추정 점선, 장중 명세 §4): 점선(TAIL_DASH "3 3")·글자 범례에서 뺌·색은 본 계열 색(주지 않으면)·
 *   툴팁 줄은 꼬리 자신의 점에만(`lib/lineChart` `lineTooltipModel`). 앞 값이 없는 외딴 꼬리 점도 점으로 남습니다. 히어로는 툴팁이 없고 문지르기가
 *   그 점을 읽습니다(`scrubModel`의 estimate).
 *
 * `estimated`·`stale`·`staleReason`·`ariaLabel`은 설계서 §1.5 계약에 더한 선택 props입니다.
 *
 * `variant="hero"`(히어로 안의 큰 차트, 명세 §5): 선은 중립 잉크(var(--text)) 하나 — 계열 색을 넘기지 않으면 — , 툴팁 상자 없이 세로 커서와
 * 활성 점만, Y 끝값 둘은 본 계열의 실제 최고·최저 값을 그 점 위·아래에(12px text-3 — 축 범위 끝의 여백 값을 적지 않고 선과 겹치지 않음, 꼬리 계열은
 * 빼고 보며 꼬리가 시작하는 점이면 글을 꼬리 반대쪽으로), X는 첫·마지막 날짜(축선 없음), 높이는 좁은 화면 200·lg 260(`height`를 주면 그 값),
 * 세로 스크롤은 브라우저에 맡기고(touch-action: pan-y) 가로로 끌면 문지릅니다.
 * `onScrub(index | null)`: 가리킨 점의 행 순번(손을 떼거나 벗어나면 null) — `hooks/useChartScrub`에 그대로 넘기고, 표시 글은
 * `lib/lineChart`의 `scrubModel`, 그리는 것은 Hero의 `scrub`입니다. 터치는 손을 떼면 커서도 감춥니다(Recharts는 터치 뒤 툴팁을 남김).
 */
export function LineChart({
  data,
  series,
  height,
  valueFormat = (value: number) => formatNumber(value, 2),
  tooltipFormat,
  includeZero = false,
  nonNegative = false,
  source,
  estimated,
  stale,
  staleReason,
  ariaLabel,
  variant = "default",
  onScrub,
}: {
  data: readonly LineRow[];
  series: readonly LineSeriesSpec[];
  /** 그림 높이(px). 없으면 기본 240, 히어로는 좁은 화면 200·lg 260. */
  height?: number;
  valueFormat?: (value: number) => string;
  /** 툴팁 값 서식 — 없으면 valueFormat. 눈금보다 한 자리 더 보일 때(옛 LineSeries의 정확한 값 확인). */
  tooltipFormat?: (value: number) => string;
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
  /** "hero"면 히어로 안의 큰 단일 선 차트 문법(위 설명). */
  variant?: "default" | "hero";
  /** 가리킨 점의 행 순번(없으면 null) — 문지르기(위 설명). */
  onScrub?: (index: number | null) => void;
}): JSX.Element {
  const hero = variant === "hero";
  // 터치를 뗀 뒤 커서를 감추는 표시 — 다음 터치·마우스 움직임에서 풉니다.
  const [released, setReleased] = useState(false);
  const colors = lineSeriesColors(
    hero ? series.map((entry) => (entry.color ? entry : { ...entry, color: HERO_INK })) : series,
    Object.values(SERIES_COLORS),
  );
  const legendEntries = series.flatMap((entry, index) =>
    inLegend(entry) ? [{ key: entry.key, label: entry.label, color: colors[index] }] : [],
  );
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
  const extremes = hero ? heroExtremes(rows, series) : null;
  const xTicks = lineXTicks(rows);
  const first = xTicks[0] ?? "";
  const last = xTicks[xTicks.length - 1] ?? "";
  const tooltipFor = (row: LineRow | undefined) =>
    row ? lineTooltipModel(row, series, colors, tooltipFormat ?? valueFormat, source) : null;
  const fixedHeight = height ?? (hero ? null : 240);
  // 문지르기 손짓 — 손을 떼면(touchend) 지금 값으로 돌아가고 커서를 감춥니다. 탭 뒤 브라우저가 흉내 내는 mousemove는 진짜 마우스가
  // 아니므로(pointerType이 mouse인 포인터 이벤트가 없음) 감춤을 풀지 않습니다 — 풀면 탭한 점에 커서가 남습니다.
  const scrubEvents = onScrub
    ? {
        onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
          if (event.pointerType === "mouse") setReleased(false);
        },
        onTouchStart: () => setReleased(false),
        onKeyDown: () => setReleased(false),
        onTouchEnd: () => {
          setReleased(true);
          onScrub(null);
        },
      }
    : null;

  const chart = (
    <ResponsiveContainer width="100%" height={fixedHeight ?? "100%"}>
      {/*
        이름은 Tab으로 닿는 SVG 자체에 붙입니다 — Recharts 접근성 층이 SVG에 role="application"·tabindex=0을 달아 화살표로 점을
        고르게 하므로, 이름이 없으면 화면 낭독기가 이름 없는 'application'만 읽습니다(DonutChart와 같은 이유).
      */}
      <RechartsLineChart
        data={rows}
        aria-label={ariaLabel ?? lineChartLabel(rows, series)}
        margin={hero ? { top: 4, right: 0, bottom: 0, left: 0 } : { top: 8, right: 8, bottom: 0, left: 0 }}
      >
        <XAxis
          dataKey="date"
          ticks={xTicks}
          interval={0}
          stroke={AXIS_LINE}
          axisLine={!hero}
          tickLine={false}
          tick={(props) => <EdgeDateTick {...props} first={first} last={last} />}
        />
        <YAxis
          type="number"
          domain={yAxis.domain}
          ticks={yAxis.ticks}
          interval={0}
          width="auto"
          // 히어로는 축 눈금 글을 두지 않고(축 자리도 없음) 실제 최고·최저를 그 점에 적습니다(아래 ReferenceDot). 위아래로 글 자리를 남깁니다.
          orientation={hero ? "right" : "left"}
          mirror={hero}
          axisLine={false}
          tickLine={false}
          tick={hero ? false : { fill: AXIS_TEXT, fontSize: CHART_FONT }}
          {...(hero ? { padding: { top: HERO_LABEL_ROOM, bottom: HERO_LABEL_ROOM } } : {})}
          tickFormatter={(value: number) => valueFormat(value)}
        />
        <Tooltip
          cursor={{ stroke: hero ? HERO_CURSOR : GUIDE, strokeWidth: 1 }}
          // 터치를 뗀 뒤에는 커서·활성 점을 감춥니다(히어로 숫자가 지금 값으로 돌아가는 것과 맞춤). 그 밖에는 Recharts가 정합니다.
          active={onScrub && released ? false : undefined}
          // 값이 없는 계열도 툴팁에 "—"로 남깁니다 — 기본(filterNull)은 그 줄을 지웁니다.
          filterNull={false}
          isAnimationActive={false}
          wrapperStyle={{ outline: "none", zIndex: 40 }}
          content={(props) => (
            <>
              {onScrub ? (
                <ScrubReporter active={props.active === true} activeIndex={props.activeIndex} length={rows.length} onScrub={onScrub} />
              ) : null}
              {/* 히어로는 툴팁 상자 없이 — 값은 히어로의 큰 숫자가 보입니다. */}
              {hero ? null : (
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
            </>
          )}
        />
        {yAxis.zeroLine ? <ReferenceLine y={0} stroke={GUIDE} strokeWidth={1} /> : null}
        {extremes
          ? [{ kind: "high" as const, extreme: extremes.high }, ...(extremes.low ? [{ kind: "low" as const, extreme: extremes.low }] : [])].map(
              ({ kind, extreme }) => (
                <ReferenceDot
                  key={kind}
                  x={extreme.date}
                  y={extreme.value}
                  r={0}
                  ifOverflow="visible"
                  shape={(props) => <HeroExtremeLabel cx={props.cx} cy={props.cy} extreme={extreme} kind={kind} format={valueFormat} />}
                />
              ),
            )
          : null}
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
              strokeDasharray={entry.tailOf !== undefined ? TAIL_DASH : undefined}
              connectNulls={false}
              dot={(dot) =>
                isolated.has(dot.index) ? (
                  <circle key={`${entry.key}-${dot.index}`} cx={dot.cx} cy={dot.cy} r={ISOLATED_DOT_R} fill={colors[index]} stroke="none" />
                ) : null
              }
              activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
            />
          );
        })}
      </RechartsLineChart>
    </ResponsiveContainer>
  );

  return (
    <figure className="m-0">
      {badges}
      <ChartLegend entries={legendEntries} />
      {hero || scrubEvents ? (
        // 히어로 높이 — 좁은 화면 200, lg 260(height를 주지 않았을 때). 세로 스크롤은 브라우저가, 가로 끌기는 문지르기가 받습니다.
        <div className={`${fixedHeight === null ? "h-[200px] lg:h-[260px]" : ""} ${hero ? "touch-pan-y" : ""}`.trim() || undefined} {...scrubEvents}>
          {chart}
        </div>
      ) : (
        chart
      )}
    </figure>
  );
}
