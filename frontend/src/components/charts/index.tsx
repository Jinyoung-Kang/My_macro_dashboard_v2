"use client";

import { type ComponentProps, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  DefaultTooltipContent,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  type PieLabelRenderProps,
  type PieSectorShapeProps,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Sector,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { EMPTY, formatChartNumber } from "@/lib/format";
import { readableOn, valueDescKey } from "@/lib/chartTooltip";
import { type DonutLabelGeometry, donutLabelsFit, truncateToWidth } from "@/lib/chartAxis";
import {
  axisLabelWidth,
  fixedYAxis,
  inLegend,
  isolatedPointIndexes,
  lineChartLabel,
  lineXAxis,
  lineYAxis,
  markerLabelSide,
  markerLabelWidth,
  type LineRow,
  type LineYAxis,
  tailPointShown,
} from "@/lib/lineChart";

import {
  AXIS_LINE,
  AXIS_TEXT,
  CHART_FONT,
  ChartLegend,
  EdgeDateTick,
  GRID_LINE,
  GUIDE,
  ISOLATED_DOT_R,
  NO_VERTICAL_GRID,
  REFERENCE_DASH,
  REFERENCE_LINE_CLASS,
  SERIES_COLORS,
  TAIL_DASH,
  TOOLTIP_BOX,
} from "./frame";
import { ChartSizeHold } from "./sizeHold";
import { LineChart as SingleLineChart } from "./LineChart";

/*
 * 차트 래퍼 — 기본은 격자 없는 단일 선 문법(명세 docs/specs/2026-10-31-v2-coinbase-ui.md §5): 선 차트는 격자·면적 그라디언트 없이 끝과 중간 눈금
 * (lib/lineChart의 lineYAxis·lineXAxis — Y는 둥근 간격, X는 날짜 경계), 글자 범례, 덮개 모양 툴팁. 막대는 격자 없이 0 기준선.
 * 큰 분석 차트는 `grid`로 옅은 가로 격자를 켭니다(작업대 실행 명세 docs/specs/2026-11-15-v2-workbench-ui.md W6 — 선 차트 세 개와 세로 막대, 1px
 * border-subtle, Y 눈금 자리에만). 어느 화면에서 켤지는 화면 단계(P5)가 정합니다. 산점도는 늘 옅은 격자(두 축이 다 데이터).
 * 축·기준선·격자 색과 툴팁 상자·글자 범례·계열 색은 차트 틀(frame.tsx — LineChart와 함께 씀). SVG 글자는 12px 이상(명세 D9).
 */
const AXIS = { fill: AXIS_TEXT, fontSize: CHART_FONT };

export { SERIES_COLORS };

/**
 * 한 줄로만 그리는 세로축 라벨.
 *
 * Recharts 기본 렌더러는 폭을 넘는 라벨을 여러 줄로 접습니다. 막대가 15개면
 * 한 칸이 24px 남짓인데 두 줄은 26px이 넘어서 **위아래 라벨이 서로 겹칩니다**
 * (실제로 수급 레이더 화면에서 종목명이 뭉개져 읽을 수 없었습니다).
 * 잘라서 한 줄로 그리고, 전체 이름은 툴팁이 보여 줍니다.
 *
 * Recharts가 넘기는 className(recharts-cartesian-axis-tick-value)을 그대로 붙입니다 — 축 폭 맞춤(width="auto")이 이 이름으로 눈금 글을
 * 찾아 잽니다. 빼면 잴 글이 없어 축 폭이 0으로 줄어듭니다.
 */
function CategoryTick({
  x,
  y,
  payload,
  maxWidth,
  className,
}: {
  x?: number | string;
  y?: number | string;
  payload?: { value?: string | number };
  maxWidth: number;
  className?: string;
}) {
  const label = String(payload?.value ?? "");
  return (
    <text
      className={className}
      x={Number(x) || 0}
      y={Number(y) || 0}
      dy={4}
      textAnchor="end"
      fill={AXIS_TEXT}
      fontSize={AXIS.fontSize}
    >
      <title>{label}</title>
      {truncateToWidth(label, maxWidth)}
    </text>
  );
}

/**
 * 막대 끝에 값을 적습니다.
 *
 * <p>값을 툴팁에만 두면 <b>마우스를 올려야</b> 숫자를 알 수 있습니다. 순위표
 * 성격의 차트(수급 상위, 섹터 수익률)는 "얼마나"가 곧 내용이라, 막대 길이만
 * 보여 주고 숫자를 감추면 그 자리에서 표로 다시 눈을 옮겨야 합니다.
 *
 * <p>라벨은 막대 바깥 끝에서 6px 떨어진 패널 면 위에 적습니다 — 양수는 오른쪽 끝 오른쪽(글 시작 맞춤), 음수는 왼쪽 끝 왼쪽(글 끝 맞춤).
 * Recharts의 가로 막대는 음수 막대를 x = 0선 자리, width = 음수로 넘기므로 두 끝을 min·max로 정리해 씁니다 — 예전 `x - 6`은 0선 왼쪽,
 * 곧 막대 안쪽 시작점이라 막대가 글보다 길면 하락 파랑 막대 위에 축 글색(1.43:1)이 됐습니다(QA-499). 음수 라벨 자리는 HorizontalBars가
 * X축 왼쪽 여백(NEG_LABEL_ROOM)으로 남깁니다.
 */
function BarValueLabel({
  x,
  y,
  width,
  height,
  value,
  unit,
  digits,
}: {
  // Recharts는 LabelList content에 좌표를 문자열로 넘기는 경우가 있어
  // 느슨하게 받고 숫자로 맞춥니다.
  x?: number | string;
  y?: number | string;
  width?: number | string;
  height?: number | string;
  value?: unknown;
  unit: string;
  digits: number;
}) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return null;
  }
  const left = Number(x) || 0;
  const barWidth = Number(width) || 0;
  const start = Math.min(left, left + barWidth);
  const end = Math.max(left, left + barWidth);
  const positive = amount >= 0;

  return (
    <text
      x={positive ? end + 6 : start - 6}
      y={(Number(y) || 0) + (Number(height) || 0) / 2}
      dy={4}
      textAnchor={positive ? "start" : "end"}
      fill={AXIS_TEXT}
      fontSize={AXIS.fontSize}
    >
      {`${formatChartNumber(amount, digits)}${unit}`}
    </text>
  );
}

/**
 * 툴팁 상자 스타일.
 *
 * <p><b>왜 손봤는가</b> — 기본 스타일은 배경이 카드 배경과 같고
 * 테두리도 흐려서, 툴팁이 차트 위에 떠 있는 것인지 그려진 것인지 구분되지
 * 않았습니다. 막대 위에 겹치면 글자가 막대 색과 뒤섞여 숫자를 읽을 수
 * 없었습니다(실제로 화면에서 그랬습니다).
 *
 * <p>고친 것: 바탕은 불투명한 덮개 바탕(surface-2)으로 막대·선을 가리고, 떠 있는 덮개라 안쪽 밝은 1px 경계(border-overlay)·덮개 그림자·
 * 4px 모서리(차트 틀 TOOLTIP_BOX — 새 LineChart 툴팁과 같은 상자). 글자는 본문색(text), 날짜는 보조색(text-2).
 *
 * <p>툴팁은 미끄러지지 않습니다(isAnimationActive: false — 명세 §3-8 '차트 애니메이션 없음', 새 LineChart와 같음). Recharts 기본값 'auto'는
 * 움직임 줄이기를 켜지 않은 화면에서 툴팁을 0.4초 동안 옮겼습니다(QA-500).
 */
function tooltipStyle() {
  return {
    isAnimationActive: false,
    contentStyle: TOOLTIP_BOX,
    labelStyle: { color: "var(--text-2)", fontWeight: 600, marginBottom: 4 },
    itemStyle: { color: "var(--text)", padding: 0 },
    wrapperStyle: { outline: "none", zIndex: 40 },
  };
}

/**
 * 막대 차트의 마우스 커서(행 강조) 색.
 *
 * <p>Recharts 기본값은 밝은 회색(#ccc)입니다. 어두운 면에서는
 * 이 회색이 막대보다 밝아, 가리키는 막대의 값 라벨이 <b>흰 배경 위 흰 글씨</b>가
 * 됩니다. 강조는 남기되 색은 hover 토큰(surface-2)으로 바꿉니다 — 패널 면(surface)보다 한 단계만 밝습니다.
 */
const BAR_CURSOR = { fill: "var(--surface-2)" };

export type Point = { date: string; value: number | null };

/**
 * 단일 시계열 라인 차트(옛 화면) — 새 선 차트(LineChart)와 같은 문법으로 그립니다: 격자·면적 그라디언트 없음, Y축은 끝값 두 개
 * (`precision` 자리 + `unit`), X축은 첫·마지막 날짜, 툴팁은 눈금보다 한 자리 더(정확한 값 확인). 모르는 값(null)에서 선을 끊습니다.
 */
export function LineSeries({
  data,
  // 기본 선 색은 검증된 계열 첫 색 — 예전 #58A6FF는 다크 밝기 띠(L 0.48~0.67)를 벗어났습니다(0.715).
  color = SERIES_COLORS.blue,
  height = 260,
  unit = "",
  zeroLine = false,
  precision = 2,
  grid = false,
  ariaLabel,
}: {
  data: Point[];
  color?: string;
  height?: number;
  unit?: string;
  /**
   * 0을 범위에 넣고, 0이 범위 안쪽이면 0선을 그립니다 (스프레드·지수처럼 부호가 의미 있는 값).
   *
   * 선 색(text-3)은 축선(border)보다 진해 구분은 되지만, 선만으로는
   * "역전"이라는 뜻까지 전달되지 않습니다. 부호가 판정으로 이어지는
   * 차트는 카드 쪽에서 배너 한 줄을 함께 띄웁니다(색·선만으로 의미를
   * 나르지 않기 위해서입니다). 예: 심화 매크로의 T10Y3M·NFCI.
   */
  zeroLine?: boolean;
  /**
   * 세로축 눈금 소수 자릿수.
   *
   * 기본 2는 %·%p처럼 소수가 의미 있는 값 기준입니다. 십억 달러처럼
   * 정수 자릿수가 큰 계열에 2를 쓰면 "880.00B"처럼 의미 없는 0만
   * 늘어나므로 0을 넘겨 주세요.
   */
  precision?: number;
  /** 큰 분석 차트의 옅은 가로 격자(작업대 실행 명세 W6) — 선 차트 LineChart의 `grid`와 같습니다. */
  grid?: boolean;
  /**
   * 차트 이름(화면 낭독기 — Tab으로 닿는 그림에 붙음). 주지 않으면 선 차트 LineChart의 기본 이름 '선 차트: 값 · 첫 날짜 ~ 마지막 날짜'(계열 이름이
   * '값' 하나라 무엇의 추이인지 말하지 않음 — 화면이 '순유동성 추이 (조 달러)'처럼 넘깁니다, QA-617).
   */
  ariaLabel?: string;
}) {
  return (
    <SingleLineChart
      data={data}
      series={[{ key: "value", label: "값", color }]}
      height={height}
      grid={grid}
      ariaLabel={ariaLabel}
      includeZero={zeroLine}
      valueFormat={(value) => `${formatChartNumber(value, precision)}${unit}`}
      tooltipFormat={(value) => `${formatChartNumber(value, precision + 1)}${unit}`}
    />
  );
}

export type MultiSeries = {
  key: string;
  name: string;
  color: string;
  /**
   * 어느 축에 그릴지. 단위나 자릿수가 다른 계열은 "right"로 분리하세요.
   *
   * <p><b>왜 필요한가</b> — KRX 화면은 선물 종가(약 1,100)와 미결제약정(약
   * 300,000)을 한 축에 겹쳐 그렸습니다. 스케일이 300배 차이라 종가 선이 0에
   * 눌려 완전히 납작해지고, 정작 읽어야 할 종가 흐름이 보이지 않았습니다.
   * 이 프로젝트의 규칙(차트는 축부터 정직해야 합니다)에 맞춰 축을 나눕니다.
   */
  axis?: "left" | "right";
  /**
   * 툴팁 값의 소수 자릿수(기본 2). 원 단위 정수 금액(모의매매 한국 책 순자산)은 0 — 기본 2자리면 "100,312,450.00"처럼 없는 자리가 보입니다.
   */
  valueDigits?: number;
  /**
   * 점선으로 그림(strokeDasharray "6 4") — 계좌·관측이 아니라 계산한 참고선(모의매매 한국의 노출 맞춘 참고선)을 실제 계열과 갈라 보이게.
   * 이름(범례·툴팁)이 함께 뜻을 나릅니다(선 모양만으로 전하지 않음).
   */
  dashed?: boolean;
  /**
   * 꼬리 계열 — 이 키의 계열(본 계열)에 붙는 장중 값 단계의 '마지막 순자산 줄 → 오늘 추정 점'(장중 명세 §4, 선 차트 LineChart의 `tailOf`와 같은 뜻).
   * 더 잘게 끊은 점선("3 3" — 참고선 "6 4"와 다름)으로 그리고, 글자 범례에서 빼며, 툴팁 줄은 꼬리 자신의 점(본 계열 값이 없는 행)에만 둡니다 —
   * 꼬리가 시작하는 마지막 줄에서는 본 계열과 같은 숫자라 겹쳐 적지 않습니다. 이름('{계좌} · 추정 HH:MM')이 그 점이 추정이라는 뜻을 나르고, 앞 값이
   * 없는 외딴 꼬리 점은 점으로 남깁니다. 색·자릿수(`valueDigits`)는 부르는 쪽이 본 계열과 같게 넘깁니다.
   */
  tailOf?: string;
};

/**
 * 여러 시계열 비교 — 격자 없이 Y는 둥근 간격 눈금(데이터 범위를 그 배수로 — 고정 domain이면 그 범위 안), X는 첫·마지막 날짜와 날짜 경계의 중간 눈금
 * (그림 너비에 맞춘 개수 — 너비를 잼), 글자 범례(두 계열 이상), 덮개 모양 툴팁.
 * 단위가 다른 계열은 오른쪽 축으로 나눌 수 있지만(KRX 두 곳) 새로 쓰지 않습니다 — 이중 축은 PRINCIPLES가 피하라는 모양이라 패널을 나누는 쪽이
 * 낫습니다(명세 §12 제안). 오른쪽 축 계열은 부르는 쪽이 이름에 어느 축인지 적습니다.
 */
/** 계열 색 툴팁 줄 — 공용 `tooltipStyle`의 줄 모양에서 글자색만 뺌(색은 줄마다 `SeriesColorTooltipContent`가 넣음). */
const SERIES_COLOR_ITEM = { padding: 0 } as const;

/**
 * 계열 색 툴팁 — Recharts 기본 툴팁 내용(`DefaultTooltipContent` — 상자·제목·줄 표지·접근성 속성 그대로)에 줄마다 읽히는 계열 색을 넣어 넘깁니다.
 * 줄 색은 선 색(`stroke`)에서 오고, 덮개 바탕 대비 4.5:1이 모자라면 `readableOn`이 밝힙니다.
 */
export function SeriesColorTooltipContent(props: ComponentProps<typeof DefaultTooltipContent>) {
  const payload = props.payload?.map((entry) => ({
    ...entry,
    color: typeof entry.color === "string" ? readableOn(entry.color) : entry.color,
  }));
  return <DefaultTooltipContent {...props} payload={payload} />;
}

/** 세로 표시선 이름과 선 사이(px) — lib/lineChart markerLabelSide의 여백(Recharts 표시선 이름의 안쪽 여백 5에 한 칸 더)과 같은 값. */
const MARKER_LABEL_PAD = 6;
/** 이웃 이름표 사이에 남길 최소 틈(px). */
const MARKER_LABEL_GAP = 4;

/**
 * 이름표를 그릴 세로 표시선(QA-736) — 그림 너비를 알면 선마다 이름표의 x 범위(선 오른쪽 또는 왼쪽 — markerLabelSide, 폭은 이름표 글 폭 어림 markerLabelWidth —
 * 축 글 폭 어림은 한글을 넉넉히 잡아 겹치지 않는 이름표까지 숨겼음, QA-777)를
 * 셈해, 앞(날짜가 이른) 이름표와 겹치거나 4px보다 가까운 뒤 이름표는 그리지 않습니다. 선은 모두 그립니다. 너비를 모르면(측정 전) 모두 그립니다(예전과 같음).
 * 날짜가 행에 없는 표시선은 Recharts가 그리지 않아 셈에서 뺍니다.
 */
function shownMarkerLabels(
  rows: readonly LineRow[],
  markers: readonly { x: string; label: string }[],
  width: number | null,
): Set<{ x: string; label: string }> {
  if (!(width !== null && width > 0) || rows.length < 2) return new Set(markers);
  const lastIndex = rows.length - 1;
  const placed = markers
    .map((marker) => ({ marker, index: rows.findIndex((row) => row.date === marker.x) }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index);
  const shown = new Set<{ x: string; label: string }>();
  const taken: { left: number; right: number }[] = [];
  for (const { marker, index } of placed) {
    const at = (index / lastIndex) * width;
    const labelWidth = markerLabelWidth(marker.label, CHART_FONT);
    const side = markerLabelSide(rows, marker.x, marker.label, { width, fontSize: CHART_FONT });
    const left = side === "left" ? at - MARKER_LABEL_PAD - labelWidth : at + MARKER_LABEL_PAD;
    const right = left + labelWidth;
    if (taken.some((range) => left < range.right + MARKER_LABEL_GAP && right > range.left - MARKER_LABEL_GAP)) continue;
    taken.push({ left, right });
    shown.add(marker);
  }
  return shown;
}

export function MultiLineSeries({
  data,
  series,
  height = 280,
  unit = "",
  rightUnit = "",
  precision = 1,
  rightPrecision = 0,
  zeroLine = false,
  domain,
  markers = [],
  ariaLabel,
  axisWidth,
  grid = false,
  tooltipOrder,
  tooltipSeriesColors = false,
}: {
  data: Record<string, unknown>[];
  series: MultiSeries[];
  height?: number;
  unit?: string;
  /** 오른쪽 축 단위 (axis: "right" 계열용). */
  rightUnit?: string;
  precision?: number;
  rightPrecision?: number;
  /**
   * 왼쪽 축 범위를 고정합니다(없으면 자료에 맞춤). 0~100%처럼 뜻이 정해진 값은 자료에 맞추면 58%와 62%의 차이가 축 전체로
   * 부풀어 보입니다 — 주식 노출 비율 차트가 [0, 100]을 씁니다.
   */
  domain?: [number, number];
  /**
   * 0선을 그립니다 (순포지션처럼 부호가 곧 방향인 값).
   *
   * 롱·숏이 뒤집히는 지점이 격자선 하나로만 남으면, 어느 선이 언제 0을
   * 넘었는지 눈으로 좇기 어렵습니다.
   */
  zeroLine?: boolean;
  /**
   * 세로 기준선 — x는 data의 date 값, label은 선 위에 적는 짧은 이름(예: 모의 매매 순자산 곡선의 "프레임 v1" — 그날부터 판단 프레임이
   * 바뀜). 범주 축이라 data에 없는 날짜는 그려지지 않고, 좁은 그림에서 이웃 이름표와 겹치는 뒤 이름표는 그리지 않으므로(선은 남음 — QA-736),
   * 부르는 쪽이 같은 내용을 글로도 적습니다(선만으로 뜻을 나르지 않음).
   */
  markers?: { x: string; label: string }[];
  /**
   * 차트 이름. Recharts 접근성 층이 그림(svg)을 role="application" 탭 정지점으로 만들므로, 이름이 없으면 낭독기가 이름 없는
   * 응용 프로그램으로 읽습니다(새 LineChart·도넛과 같은 이유). 주지 않으면 선 차트 LineChart와 같은 꼴의 기본 이름 — '선 차트: 계열 이름들 · 첫 날짜 ~
   * 마지막 날짜'(lib/lineChart lineChartLabel — 꼬리 계열은 본 계열의 이어진 점이라 범례처럼 이름에서 뺌, QA-617).
   */
  ariaLabel?: string;
  /**
   * 왼쪽 축 폭(px). 주지 않으면 눈금 글 폭에 맞춥니다(Recharts width="auto" — 그린 눈금을 재서 넓힘). 고정 64px에서는 단위가 긴 눈금
   * ('193,971 계약')이 두 줄로 접혀 위 끝값이 SVG 밖으로 잘렸습니다. 여러 차트의 축을 같은 폭으로 맞출 때만 줍니다.
   */
  axisWidth?: number;
  /**
   * 큰 분석 차트의 옅은 가로 격자(작업대 실행 명세 W6 — 1px border-subtle). 왼쪽 축 눈금 자리에 긋고, 계열이 모두 오른쪽 축이면 오른쪽 축 눈금에 긋습니다
   * (두 축의 눈금을 섞어 긋지 않음).
   */
  grid?: boolean;
  /**
   * 툴팁 줄 차례. "value"면 그 시점 값이 큰 차례(같은 값은 계열 차례 — `lib/chartTooltip` `valueDescKey`), 주지 않으면 Recharts 기본(이름 차례 —
   * 알파벳·가나다). 기관 13F 비중 추이(그 분기의 비중 순위 — 2026-11-17 사용자 요구)와 모의매매 순자산 곡선·환율 비교·COT 포지셔닝 추이
   * (2026-11-18 사용자 요구)가 씀.
   */
  tooltipOrder?: "value";
  /**
   * 툴팁 줄 글자(이름·값)를 계열 색으로. 덮개 바탕에서 글자 대비 4.5:1이 모자란 색은 툴팁 글자에서만 같은 색을 밝혀 씁니다(`readableOn` — 선 색은
   * 그대로). 주지 않으면 지금처럼 본문색(공용 규칙 — 차트 틀 `TOOLTIP_BOX`). `tooltipOrder="value"`를 쓰는 차트와 같은 넷이 씀.
   */
  tooltipSeriesColors?: boolean;
}) {
  const rows = data as unknown as readonly LineRow[];
  const specsOf = (side: "left" | "right") =>
    series.filter((entry) => (entry.axis ?? "left") === side).map((entry) => ({ key: entry.key, label: entry.name }));
  const usesRight = series.some((entry) => entry.axis === "right");
  // 그림 너비(px) — X 중간 눈금 개수를 고릅니다(선 차트 LineChart와 같음). 재기 전에는 null(첫·마지막만).
  const [width, setWidth] = useState<number | null>(null);
  const leftLabel = (value: number) => `${formatChartNumber(value, precision)}${unit}`;
  const rightLabel = (value: number) => formatChartNumber(value, rightPrecision);
  // 눈금 — 선 차트(LineChart)와 같은 규칙(lib/lineChart의 lineYAxis: 둥근 간격, 0은 zeroLine일 때만). 고정 범위(domain)면 그 범위 안의 둥근 간격.
  const leftAxis: LineYAxis | null = domain
    ? fixedYAxis(domain, { zeroLine, format: leftLabel })
    : lineYAxis(rows, specsOf("left"), { includeZero: zeroLine, format: leftLabel });
  const rightAxis = usesRight ? lineYAxis(rows, specsOf("right"), { format: rightLabel }) : null;
  if (data.length === 0 || (leftAxis === null && rightAxis === null)) {
    return <div className="py-10 text-center text-sm text-text-3">표시할 시계열이 없습니다.</div>;
  }

  // X 눈금에 줄 너비 — 그림 너비에서 왼쪽 축(눈금 글 폭 어림 또는 axisWidth)·오른쪽 축(76)·오른쪽 여백(8)을 뺍니다.
  const leftWidth = axisWidth ?? Math.max(0, ...(leftAxis?.ticks ?? []).map((tick) => axisLabelWidth(leftLabel(tick), CHART_FONT))) + 12;
  const plotWidth = width === null ? null : width - leftWidth - (usesRight ? 76 : 0) - 8;
  const xAxis = lineXAxis(rows, { width: plotWidth, fontSize: CHART_FONT });
  const markerLabelShown = shownMarkerLabels(rows, markers, plotWidth);
  const xTicks = xAxis.ticks;
  const first = xTicks[0] ?? "";
  const last = xTicks[xTicks.length - 1] ?? "";
  const unitOf = (name: string) =>
    series.find((entry) => entry.name === name)?.axis === "right" ? rightUnit : unit;
  const digitsOf = (name: string) => series.find((entry) => entry.name === name)?.valueDigits ?? 2;
  // 글자 범례 — 이름은 부르는 쪽 그대로(오른쪽 축 계열은 이름에 '(오른쪽)'·'(우)'를 적어 넘깁니다 — KRX 두 곳). 꼬리 계열은 넣지 않습니다.
  const legend = series
    .filter((entry) => inLegend(entry))
    .map((entry) => ({ key: entry.key, label: entry.name, color: entry.color, dashed: entry.dashed }));

  return (
    <figure className="m-0">
      <ChartLegend entries={legend} />
      <ChartSizeHold>
      <ResponsiveContainer width="100%" height={height} onResize={(nextWidth) => setWidth(nextWidth)}>
        <LineChart
          data={data}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          aria-label={
            ariaLabel ??
            lineChartLabel(rows, series.filter((entry) => entry.tailOf === undefined).map((entry) => ({ key: entry.key, label: entry.name })))
          }
        >
          {grid ? (
            <CartesianGrid yAxisId={leftAxis ? "left" : "right"} vertical={false} verticalCoordinatesGenerator={NO_VERTICAL_GRID} stroke={GRID_LINE} strokeWidth={1} syncWithTicks />
          ) : null}
          <XAxis
            dataKey="date"
            ticks={xTicks}
            interval={0}
            stroke={AXIS_LINE}
            tickLine={false}
            tick={(props) => <EdgeDateTick {...props} first={first} last={last} labels={xAxis.labels} />}
          />
          <YAxis
            yAxisId="left"
            type="number"
            domain={leftAxis?.domain ?? ["auto", "auto"]}
            ticks={leftAxis?.ticks}
            interval={0}
            axisLine={false}
            tickLine={false}
            tick={AXIS}
            width={axisWidth ?? "auto"}
            tickFormatter={leftLabel}
          />
          {/*
            오른쪽 축은 쓰는 계열이 있을 때만 보입니다(빈 축은 눈금만 늘립니다).
            눈금에는 단위를 붙이지 않습니다 — "320,000 계약"처럼 길어지면 두 줄로
            접히며 맨 위 눈금이 잘렸습니다. 단위는 범례와 툴팁이 말해 줍니다.
          */}
          <YAxis
            yAxisId="right"
            type="number"
            orientation="right"
            hide={!usesRight}
            domain={rightAxis?.domain ?? ["auto", "auto"]}
            ticks={rightAxis?.ticks}
            interval={0}
            axisLine={false}
            tickLine={false}
            tick={AXIS}
            width={76}
            tickFormatter={rightLabel}
          />
          <Tooltip
            {...tooltipStyle()}
            {...(tooltipOrder === "value" ? { itemSorter: valueDescKey } : {})}
            {...(tooltipSeriesColors ? { itemStyle: SERIES_COLOR_ITEM, content: SeriesColorTooltipContent } : {})}
            cursor={{ stroke: GUIDE, strokeWidth: 1 }}
            formatter={(value, name, item) => {
              // 꼬리 줄은 꼬리 자신의 점에만 — 마지막 줄에서는 본 계열과 같은 숫자입니다(null을 돌려주면 Recharts가 그 줄을 그리지 않음). 꼬리 점에서
              // 본 계열은 값이 null이라 툴팁 기본값(filterNull)이 이미 뺍니다.
              const tail = series.find((entry) => entry.key === String(item?.dataKey) && entry.tailOf !== undefined);
              if (tail && !tailPointShown((item?.payload ?? {}) as LineRow, tail)) {
                return null;
              }
              return [
                value === null || value === undefined
                  ? EMPTY
                  : `${formatChartNumber(Number(value), digitsOf(String(name)))}${unitOf(String(name))}`,
                String(name),
              ];
            }}
          />
          {leftAxis?.zeroLine ? <ReferenceLine yAxisId="left" y={0} stroke={GUIDE} strokeWidth={1} /> : null}
          {/*
            경계선은 계열선보다 흐린 회색 점선 — 값이 아니라 "여기서 조건이 바뀜" 표시라 계열색과 겹치지 않게 합니다. 이름은 선 오른쪽에
            적고, 오른쪽에 적으면 그림 끝을 넘는 선(마지막 날짜 근처)만 왼쪽에 적습니다 — 예전에는 마지막 '프레임 v5'가 잘렸습니다.
          */}
          {/* 이름표가 이웃 이름표와 겹치면 뒤 이름표를 그리지 않습니다(선은 남음 — QA-736). 판은 부르는 쪽이 글로도 적습니다(markers 설명). */}
          {markers.map((marker) => (
            <ReferenceLine
              key={`${marker.x}-${marker.label}`}
              yAxisId="left"
              x={marker.x}
              stroke={GUIDE}
              strokeDasharray="4 3"
              strokeWidth={1}
              label={markerLabelShown.has(marker) ? {
                value: marker.label,
                position: markerLabelSide(rows, marker.x, marker.label, { width: plotWidth, fontSize: CHART_FONT }) === "left"
                  ? "insideTopRight"
                  : "insideTopLeft",
                fill: AXIS_TEXT,
                fontSize: CHART_FONT,
              } : undefined}
            />
          ))}
          {series.map((entry) => {
            // 꼬리는 앞 값이 없으면 점 하나뿐 — 선만으로는 사라지므로 외딴 점은 점으로(선 차트 LineChart와 같은 규칙). 본 계열은 그리지 않던 그대로.
            const isolated = entry.tailOf !== undefined ? new Set(isolatedPointIndexes(rows, entry.key)) : null;
            return (
              <Line
                isAnimationActive={false}
                key={entry.key}
                yAxisId={entry.axis ?? "left"}
                type="monotone"
                dataKey={entry.key}
                name={entry.name}
                stroke={entry.color}
                strokeWidth={2}
                strokeDasharray={entry.tailOf !== undefined ? TAIL_DASH : entry.dashed ? REFERENCE_DASH : undefined}
                // 계산한 참고선 표지 — 고대비에서 CanvasText로(globals.css, QA-498). 꼬리 계열은 계좌 색 그대로.
                className={entry.dashed && entry.tailOf === undefined ? REFERENCE_LINE_CLASS : undefined}
                dot={
                  isolated
                    ? (dot) =>
                        isolated.has(dot.index) ? (
                          <circle key={`${entry.key}-${dot.index}`} cx={dot.cx} cy={dot.cy} r={ISOLATED_DOT_R} fill={entry.color} stroke="none" />
                        ) : null
                    : false
                }
                // hover 점도 참고선이면 같은 표지 — 선과 다른 층(activeDot circle)이라 g의 표지가 닿지 않습니다(QA-509).
                activeDot={{
                  r: 4,
                  strokeWidth: 2,
                  stroke: "var(--surface)",
                  ...(entry.dashed && entry.tailOf === undefined ? { className: REFERENCE_LINE_CLASS } : {}),
                }}
                connectNulls={false}
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>
      </ChartSizeHold>
    </figure>
  );
}

/**
 * 음수 막대 왼쪽에 남기는 값 라벨 자리(px) — 가장 음수인 막대의 바깥 끝과 Y축 선 사이. 오른쪽 여백(68 — 양수 라벨 자리)과 맞춥니다(QA-499).
 */
const NEG_LABEL_ROOM = 60;

/**
 * 가로 막대 (수급 순위·수익률 비교). 값이 하나라도 음수면 X축 왼쪽 여백(padding.left)에 음수 라벨 자리(NEG_LABEL_ROOM)를 둡니다 — 막대 영역이
 * 그만큼 좁아집니다. 바깥 여백(margin.left)은 Y축 이름표 바깥에 공간을 더할 뿐 축 선과 막대 사이를 벌리지 않아 쓰지 않습니다. 모두 양수면 그대로입니다.
 */
export function HorizontalBars({
  data,
  height = 360,
  unit = "",
  digits = 1,
  valueName = "값",
  neutral = false,
  ariaLabel,
}: {
  data: { name: string; value: number }[];
  height?: number;
  unit?: string;
  /** 막대 끝 라벨의 소수 자릿수. */
  digits?: number;
  /** 툴팁에 표시할 값의 이름. "값"보다 무엇인지 말해 주는 편이 낫습니다. */
  valueName?: string;
  /**
   * 방향이 없는 값(보유 기관 수·백분위·비중)이면 true — 모든 막대를 중립색으로.
   * 이 화면들에서 빨강은 "순매수·상승"이라, 방향 없는 값을 빨강으로 칠하면 잘못 읽힙니다.
   */
  neutral?: boolean;
  /**
   * 차트 이름(화면 낭독기 — Recharts 접근성 층이 그림을 role="application" Tab 정지점으로 만듦). 주지 않으면 '막대 차트: {valueName}'(QA-617) —
   * 화면이 '섹터 1M 수익률'처럼 무엇의 막대인지 넘깁니다. 값은 막대 끝 글자와 같은 화면의 표가 나릅니다.
   */
  ariaLabel?: string;
}) {
  if (data.length === 0) {
    return <div className="py-10 text-center text-sm text-text-3">표시할 데이터가 없습니다.</div>;
  }

  // 항목이 많으면 높이를 늘립니다. 고정 높이로 30개를 그리면 한 칸이 12px이라
  // 막대도 라벨도 읽을 수 없습니다.
  const chartHeight = Math.max(height, data.length * 26 + 48);
  const hasNegative = data.some((entry) => entry.value < 0);

  return (
    <ChartSizeHold>
    <ResponsiveContainer width="100%" height={chartHeight}>
      <BarChart
        data={data}
        layout="vertical"
        aria-label={ariaLabel ?? `막대 차트: ${valueName}`}
        // 오른쪽 여백은 막대 끝 값 라벨이 잘리지 않을 만큼 둡니다.
        margin={{ top: 8, right: 68, bottom: 0, left: 8 }}
      >
        <XAxis
          type="number"
          axisLine={false}
          tick={AXIS}
          tickLine={false}
          padding={hasNegative ? { left: NEG_LABEL_ROOM } : undefined}
          tickFormatter={(value: number) => `${formatChartNumber(value, 0)}${unit}`}
        />
        {/* 축 폭은 이름표 폭에 맞춥니다(width="auto") — 고정 150px은 12px 글자에서 영문 대문자가 섞인 24칸 이름('KODEX 코스닥150선물인버…')을 왼쪽에서 잘랐습니다. */}
        <YAxis
          type="category"
          dataKey="name"
          stroke={AXIS_LINE}
          width="auto"
          tickLine={false}
          interval={0}
          tick={(props) => <CategoryTick {...props} maxWidth={24} />}
        />
        <Tooltip
          {...tooltipStyle()}
          cursor={BAR_CURSOR}
          formatter={(value) => [`${formatChartNumber(Number(value), digits)}${unit}`, valueName]}
        />
        <ReferenceLine x={0} stroke={GUIDE} />
        {/* 한국 관행: 양수(순매수·상승) 빨강, 음수 파랑 — 상승·하락 토큰(패널 면 surface 위 그래픽 대비 5.84·8.06:1 — 작업대 실행 명세 §3-5) */}
        <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive={false}>
          {data.map((entry) => (
            <Cell
              key={entry.name}
              fill={neutral ? SERIES_COLORS.blue : entry.value >= 0 ? "var(--up)" : "var(--down)"}
            />
          ))}
          <LabelList
            dataKey="value"
            content={(props) => <BarValueLabel {...props} unit={unit} digits={digits} />}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
    </ChartSizeHold>
  );
}

/** 순매수/순매도를 색으로 구분하는 막대 차트. */
export function SignedBars({
  data,
  height = 320,
  unit = "",
  valueName = "순매수",
  grid = false,
  ariaLabel,
}: {
  /**
   * color를 주면 부호 색(빨강=+, 파랑=−) 대신 그 색으로 칠합니다. 거래량처럼 부호가
   * 없는 값에 빨강을 쓰면 이 화면들의 약속(빨강 = 매수·상승)과 섞여 잘못 읽힙니다.
   */
  data: { name: string; value: number; color?: string }[];
  height?: number;
  unit?: string;
  valueName?: string;
  /** 큰 분석 차트의 옅은 가로 격자(작업대 실행 명세 W6 — 1px border-subtle, Y 눈금 자리에만). */
  grid?: boolean;
  /** 차트 이름(화면 낭독기 — HorizontalBars와 같음). 주지 않으면 '막대 차트: {valueName}'(QA-617). */
  ariaLabel?: string;
}) {
  if (data.length === 0) {
    return <div className="py-10 text-center text-sm text-text-3">표시할 데이터가 없습니다.</div>;
  }

  return (
    <ChartSizeHold>
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} aria-label={ariaLabel ?? `막대 차트: ${valueName}`}>
        {grid ? <CartesianGrid vertical={false} verticalCoordinatesGenerator={NO_VERTICAL_GRID} stroke={GRID_LINE} strokeWidth={1} syncWithTicks /> : null}
        <XAxis dataKey="name" stroke={AXIS_LINE} tick={AXIS} tickLine={false} interval={0} angle={-25} height={70} textAnchor="end" />
        {/* 축 폭은 눈금 글 폭에 맞춥니다(width="auto") — 고정 64px은 음수 부호·긴 단위('-16,000계약')의 앞자리를 잘랐습니다. */}
        <YAxis
          axisLine={false}
          tick={AXIS}
          tickLine={false}
          width="auto"
          tickFormatter={(value: number) => `${formatChartNumber(value, 0)}${unit}`}
        />
        <Tooltip
          {...tooltipStyle()}
          cursor={BAR_CURSOR}
          formatter={(value) => [`${formatChartNumber(Number(value), 0)}${unit}`, valueName]}
        />
        <ReferenceLine y={0} stroke={GUIDE} />
        <Bar dataKey="value" radius={[4, 4, 0, 0]} isAnimationActive={false}>
          {data.map((entry) => (
            <Cell key={entry.name} fill={entry.color ?? (entry.value >= 0 ? "var(--up)" : "var(--down)")} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
    </ChartSizeHold>
  );
}

/**
 * 산점도 — 두 지표가 실제로 같이 움직이는지 눈으로 봅니다.
 *
 * <p>상관계수 하나만 보면 놓치는 것이 있습니다. 0.7이라는 숫자는 "대체로 같이
 * 움직인다"일 수도 있고 "평소엔 무관한데 몇 번의 급변이 끌어올린 값"일 수도
 * 있습니다. 점을 뿌려 보면 그 차이가 바로 보입니다.
 */
export function ScatterPlot({
  data,
  xLabel,
  yLabel,
  xUnit = "",
  yUnit = "",
  height = 320,
  color = SERIES_COLORS.blue,
}: {
  data: { x: number; y: number; date: string }[];
  xLabel: string;
  yLabel: string;
  xUnit?: string;
  yUnit?: string;
  height?: number;
  color?: string;
}) {
  if (data.length === 0) {
    return <div className="py-10 text-center text-sm text-text-3">표시할 점이 없습니다.</div>;
  }

  return (
    // 점 하나하나가 role="img"로 노출돼 스크린리더에 수백 개의 이름 없는 그림이 됩니다. 산점도는 장식이고
    // 상관계수·표본 수는 옆에 글자로 있으므로 보조기기에는 통째로 숨깁니다.
    <div aria-hidden="true">
    <ChartSizeHold>
    <ResponsiveContainer width="100%" height={height}>
      {/*
        접근성 층을 끕니다(accessibilityLayer — Recharts 기본 켬) — 켜 두면 그림(svg)에 role="application"·tabindex=0이 붙어, 보조기기에서 뺀 상자 안에
        읽어 주지 않는 Tab 정지점이 생겼습니다(QA-616). 다른 차트는 이 층으로 화살표 키 탐색을 주고 이름(aria-label)을 달지만, 산점도는 읽기에서 뺀 그림입니다.
      */}
      <ScatterChart accessibilityLayer={false} margin={{ top: 8, right: 16, bottom: 28, left: 8 }}>
        {/* 두 축이 다 데이터라 격자를 남기되 옅게(옅은 경계 border-subtle — 큰 차트의 가로 격자와 같은 색). */}
        <CartesianGrid stroke={GRID_LINE} strokeWidth={1} />
        <XAxis
          type="number"
          dataKey="x"
          name={xLabel}
          stroke={AXIS_LINE}
          tick={AXIS}
          tickLine={false}
          tickFormatter={(value: number) => `${formatChartNumber(value, 2)}`}
          label={{ value: `${xLabel}${xUnit ? ` (${xUnit})` : ""}`, position: "insideBottom",
                   offset: -18, fill: AXIS_TEXT, fontSize: CHART_FONT }}
        />
        {/*
          Y축 이름 — X축 이름과 같은 글꼴(12px·text-3)로 축 칸 왼쪽에 세워 적습니다(QA-665 — 예전에는 X축 이름만 있어 Y 값이 무엇의 몇 단위인지 그림만으로는
          몰랐음). 이름은 그림 x 약 6~20px에 세로 가운데로 섭니다(가장 긴 '금융스트레스 (STLFSI4) (pt)'도 y 79~231 — 그림 영역 8~302 안). 눈금 글은 축 칸(70px)
          오른쪽에 맞춰 글 길이에 따라 왼쪽 끝이 달라(여섯 자 '600.00' 33px, 여덟 자 '1,200.00' 23px), 겹치지 않는 까닭은 이름 옆 높이에 오는 눈금이 짧아서입니다 —
          가장 넓은 눈금은 절댓값이 큰 맨 위·맨 아래이고, 지금 계열 목록에서 이름 옆 눈금은 여섯 자 이하라 13px 이상 떨어집니다. 이름 옆 눈금이 다섯 자리 수준
          ('30,000.00' — 17px)인 계열이 들어오면 이름과 겹치므로 그때 축 칸 폭이나 왼쪽 여백을 늘립니다.
        */}
        <YAxis
          type="number"
          dataKey="y"
          name={yLabel}
          stroke={AXIS_LINE}
          tick={AXIS}
          tickLine={false}
          width={70}
          tickFormatter={(value: number) => `${formatChartNumber(value, 2)}`}
          label={{ value: `${yLabel}${yUnit ? ` (${yUnit})` : ""}`, angle: -90, position: "insideLeft",
                   fill: AXIS_TEXT, fontSize: CHART_FONT, textAnchor: "middle" }}
        />
        <ZAxis range={[24, 24]} />
        {/* 0선을 그어 사분면이 보이게 합니다 — 변화끼리 비교할 때 핵심입니다. */}
        <ReferenceLine x={0} stroke={GUIDE} />
        <ReferenceLine y={0} stroke={GUIDE} />
        <Tooltip
          {...tooltipStyle()}
          cursor={{ strokeDasharray: "3 3", stroke: GUIDE }}
          formatter={(value, name) => [
            `${formatChartNumber(Number(value), 3)}${String(name) === xLabel ? xUnit : yUnit}`,
            String(name),
          ]}
          labelFormatter={() => ""}
        />
        {/*
          등장 애니메이션 없음(명세 §3-8, QA-500 — 기본값 'auto'는 점이 0에서 자라며 나타남). 불투명도 0.8 — 바탕과 섞인 점 색이 패널 면(surface) 위 3.34:1,
          페이지 바탕(bg) 위 3.67:1(그래픽 3:1 — QA-615, 예전 0.55는 2.27·2.37:1). 겹친 점은 더 진해 보여 몰린 곳은 그대로 드러납니다.
        */}
        <Scatter data={data} fill={color} fillOpacity={0.8} isAnimationActive={false} />
      </ScatterChart>
    </ResponsiveContainer>
    </ChartSizeHold>
    </div>
  );
}

/** 도넛 조각 하나. 색·이름·표시 값은 부르는 쪽이 정합니다(값 계산은 lib — ADR 0004). */
export interface DonutSegment {
  key: string;
  name: string;
  /** 조각 크기(같은 차트 안에서 비례 — 보통 비중 %). */
  value: number;
  color: string;
  /** 툴팁 맨 앞에 굵게 적는 값(예: "12.3%"). */
  valueText: string;
  /** 툴팁 둘째 줄(예: 평가액). */
  caption?: string | null;
  /** 툴팁 셋째 줄(묶음 내역). */
  detail?: string | null;
  /** 고리 밖에 적을 직접 라벨. 없으면 범례·툴팁·표가 나릅니다. */
  label?: string | null;
}

/**
 * 도넛 툴팁 — 값이 앞(굵게), 이름이 뒤. 이름 앞의 짧은 선이 조각 색입니다(글자에는 계열 색을 입히지 않음). 그 견본은 고대비(forced-colors)에서도
 * 조각 색 그대로입니다(forced-color-adjust-none — 조각 SVG와 같은 규칙, QA-497).
 */
function DonutTooltip({ active, payload }: { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }) {
  const datum = payload?.[0]?.payload as DonutSegment | undefined;
  if (!active || !datum) return null;
  return (
    <div style={tooltipStyle().contentStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          aria-hidden
          className="forced-color-adjust-none"
          style={{ display: "inline-block", width: 12, height: 2, borderRadius: 1, backgroundColor: datum.color }}
        />
        <strong style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{datum.valueText}</strong>
        <span style={{ color: "var(--text-2)" }}>{datum.name}</span>
      </div>
      {datum.caption && <div style={{ marginTop: 2, color: "var(--text-2)" }}>{datum.caption}</div>}
      {datum.detail && <div style={{ marginTop: 2, maxWidth: 260, color: AXIS_TEXT }}>{datum.detail}</div>}
    </div>
  );
}

/** 라벨을 붙인 도넛의 자리 — 아래 Pie에 넘기는 값(여백 8 · 바깥 70% · 라벨 거리 20 · 글자 12px)과 같습니다. */
const DONUT_LABEL_GEOMETRY: DonutLabelGeometry = { margin: 8, outerPct: 70, offset: 20, fontSize: CHART_FONT };

/** 직접 라벨 — 고리 밖, 본문 글자색(조각 색이 아님). 라벨이 없는 조각은 그리지 않습니다. */
function DonutLabel(props: PieLabelRenderProps) {
  const label = (props.payload as DonutSegment | undefined)?.label;
  if (!label) return null;
  return (
    <text x={props.x} y={props.y} textAnchor={props.textAnchor} dominantBaseline="central" fill="var(--text-2)" fontSize={DONUT_LABEL_GEOMETRY.fontSize}>
      {label}
    </text>
  );
}

/** 가리킨 조각을 4px 바깥으로 — 마우스에 반응하는 것이 보이게(색은 바꾸지 않음). */
function DonutSector(props: PieSectorShapeProps) {
  return <Sector {...props} outerRadius={props.isActive ? props.outerRadius + 4 : props.outerRadius} />;
}

/**
 * 부분-전체 도넛(조각 여섯 개 이하에서만 — 부르는 쪽이 지킴).
 *
 * <p>조각 사이는 표면색 2px 선으로 띄웁니다(테두리가 아니라 틈 — 이웃 조각이 색으로만 붙어 보이지 않게). 그래서 {@code surface}는
 * 차트가 놓이는 바탕색이어야 합니다 — 기본은 카드 표면 var(--surface), 페이지 바탕(bg-bg) 위에 놓이면 "var(--bg)"를 넘깁니다.
 * 12시 방향에서 시계 방향으로, 받은 순서대로 그립니다. 조각마다 툴팁이 있고, 범례·표는 부르는
 * 쪽이 함께 그립니다(툴팁은 보조 — 값은 범례·표에서도 읽힘).
 */
export function DonutChart({
  segments,
  surface = "var(--surface)",
  height = 220,
  ariaLabel,
}: {
  segments: DonutSegment[];
  surface?: string;
  height?: number;
  /** 차트 전체를 한 문장으로(화면 낭독기용 — 표가 같은 값을 나름). */
  ariaLabel: string;
}) {
  // 그려진 너비 — 직접 라벨이 SVG 끝에서 잘리지 않을 만큼 넓을 때만 라벨을 붙입니다(측정 전에는 붙이지 않음).
  const [width, setWidth] = useState<number | null>(null);
  if (segments.length === 0) {
    return <div className="py-10 text-center text-sm text-text-3">표시할 구성이 없습니다.</div>;
  }
  const labelled = donutLabelsFit(width, height, segments.map((segment) => segment.label), DONUT_LABEL_GEOMETRY);
  const margin = DONUT_LABEL_GEOMETRY.margin;
  // recharts는 조각 색을 자료의 fill에서 읽습니다(Cell은 3.x에서 폐기 예정).
  const data = segments.map((segment) => ({ ...segment, fill: segment.color }));
  return (
    <figure className="m-0">
      <ChartSizeHold>
      <ResponsiveContainer width="100%" height={height} onResize={(nextWidth) => setWidth(nextWidth)}>
        {/*
          이름은 Tab으로 닿는 SVG 자체에 붙입니다 — Recharts의 접근성 층이 SVG에 role="application"·tabindex=0을 달아 화살표로 조각을
          고르게 하는데, 이름을 바깥 figure에 두면 Tab으로 들어간 화면 낭독기가 이름 없는 'application'만 읽었습니다. figure에는 같은
          이름을 다시 달지 않습니다(두 번 읽힘).
        */}
        <PieChart aria-label={ariaLabel} margin={{ top: margin, right: margin, bottom: margin, left: margin }}>
          {/* 툴팁은 미끄러지지 않습니다(명세 §3-8, QA-500 — 상자 모양만 tooltipStyle()과 같고 펼치지는 않음). */}
          <Tooltip
            content={(props) => <DonutTooltip active={props.active} payload={props.payload} />}
            wrapperStyle={{ outline: "none", zIndex: 40 }}
            isAnimationActive={false}
          />
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            startAngle={90}
            endAngle={-270}
            // 직접 라벨을 고리 밖에 적을 때는 고리를 조금 줄여 글자 자리를 남깁니다(바깥 비율은 DONUT_LABEL_GEOMETRY와 같음).
            innerRadius={labelled ? "50%" : "58%"}
            outerRadius={labelled ? `${DONUT_LABEL_GEOMETRY.outerPct}%` : "82%"}
            stroke={surface}
            strokeWidth={2}
            isAnimationActive={false}
            label={labelled ? DonutLabel : false}
            labelLine={false}
            shape={DonutSector}
          />
        </PieChart>
      </ResponsiveContainer>
      </ChartSizeHold>
    </figure>
  );
}

/** 선 차트(격자 없음·끝값 축·null에서 끊김) — 화면은 이 지정자(@/components/charts)에서 가져옵니다(테스트 mock이 여기에만 걸림). */
export { LineChart } from "./LineChart";

/** 비중 히트맵 — 표 히트맵(패턴 HeatmapTable)의 감싸개(WeightHeatmap.tsx), 화면은 이 지정자에서 가져옵니다(테스트 mock이 여기에 걸림). */
export { WeightHeatmap } from "./WeightHeatmap";
