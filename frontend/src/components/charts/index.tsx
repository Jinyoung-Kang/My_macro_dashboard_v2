"use client";

import { useId, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
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
import { EMPTY, formatNumber } from "@/lib/format";
import { type DonutLabelGeometry, donutLabelsFit, truncateToWidth, valueDomain } from "@/lib/chartAxis";

const AXIS = { stroke: "#8B949E", fontSize: 11 };
const GRID = "#30363D";

/**
 * 시계열 색 (다크 표면 #161B22 기준).
 *
 * dataviz 검증기(scripts/validate_palette.js)를 통과한 조합입니다.
 * 이전 조합(#58A6FF·#D29922·#F85149)은 적록색약에서 노랑↔빨강 ΔE가 5.8로
 * 구분 한계(6) 아래였습니다 — 화면에서도 두 선이 겹쳐 보였습니다.
 */
export const SERIES_COLORS = {
  blue: "#3987e5",
  orange: "#d95926",
  green: "#199e70",
} as const;

/**
 * 한 줄로만 그리는 세로축 라벨.
 *
 * Recharts 기본 렌더러는 폭을 넘는 라벨을 여러 줄로 접습니다. 막대가 15개면
 * 한 칸이 24px 남짓인데 두 줄은 26px이 넘어서 **위아래 라벨이 서로 겹칩니다**
 * (실제로 수급 레이더 화면에서 종목명이 뭉개져 읽을 수 없었습니다).
 * 잘라서 한 줄로 그리고, 전체 이름은 툴팁이 보여 줍니다.
 */
function CategoryTick({
  x,
  y,
  payload,
  maxWidth,
}: {
  x?: number | string;
  y?: number | string;
  payload?: { value?: string | number };
  maxWidth: number;
}) {
  const label = String(payload?.value ?? "");
  return (
    <text
      x={Number(x) || 0}
      y={Number(y) || 0}
      dy={4}
      textAnchor="end"
      fill={AXIS.stroke}
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
 * <p>음수 막대는 0선 왼쪽으로 자라므로 라벨도 왼쪽에 붙입니다.
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
  const positive = amount >= 0;

  return (
    <text
      x={positive ? left + barWidth + 6 : left - 6}
      y={(Number(y) || 0) + (Number(height) || 0) / 2}
      dy={4}
      textAnchor={positive ? "start" : "end"}
      fill={AXIS.stroke}
      fontSize={AXIS.fontSize}
    >
      {`${formatNumber(amount, digits)}${unit}`}
    </text>
  );
}

/**
 * 툴팁 상자 스타일.
 *
 * <p><b>왜 손봤는가</b> — 기본 스타일은 배경(#161B22)이 카드 배경과 같고
 * 테두리도 흐려서, 툴팁이 차트 위에 떠 있는 것인지 그려진 것인지 구분되지
 * 않았습니다. 막대 위에 겹치면 글자가 막대 색과 뒤섞여 숫자를 읽을 수
 * 없었습니다(실제로 화면에서 그랬습니다).
 *
 * <p>고친 것: 배경을 카드보다 <b>더 어둡게</b>(캔버스 색) 낮추고, 테두리를
 * 밝히고, 그림자를 넣어 떠 있게 하고, 글자를 밝은 색으로 올렸습니다.
 */
function tooltipStyle() {
  return {
    contentStyle: {
      backgroundColor: "rgba(1, 4, 9, 0.97)",
      border: "1px solid #8B949E",
      borderRadius: 8,
      boxShadow: "0 8px 24px rgba(0, 0, 0, 0.65)",
      fontSize: 12,
      padding: "8px 10px",
      color: "#F0F6FC",
    },
    labelStyle: { color: "#C9D1D9", fontWeight: 600, marginBottom: 4 },
    itemStyle: { color: "#F0F6FC", padding: 0 },
    wrapperStyle: { outline: "none", zIndex: 40 },
  };
}

/**
 * 막대 차트의 마우스 커서(행 강조) 색.
 *
 * <p>Recharts 기본값은 밝은 회색(rgba(204,204,204,…))입니다. 어두운 테마에서는
 * 이 회색이 막대보다 밝아, 가리키는 막대의 값 라벨이 <b>흰 배경 위 흰 글씨</b>가
 * 됩니다. 강조는 남기되 색은 강조색의 옅은 틴트로 바꿉니다.
 */
const BAR_CURSOR = { fill: "rgba(88, 166, 255, 0.12)" };

export type Point = { date: string; value: number | null };

/** 단일 시계열 라인 차트. */
export function LineSeries({
  data,
  color = "#58A6FF",
  height = 260,
  unit = "",
  zeroLine = false,
  precision = 2,
}: {
  data: Point[];
  color?: string;
  height?: number;
  unit?: string;
  /**
   * 0선을 그립니다 (스프레드·지수처럼 부호가 의미 있는 값).
   *
   * 선 색(#8B949E)은 격자(#30363D)보다 밝아 구분은 되지만, 선만으로는
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
}) {
  // ⚠️ 그라디언트 id는 문서 전체에서 유일해야 합니다. 예전에는 "fill"로
  // 고정돼 있어서, 한 페이지에 차트가 여러 개면(매크로 화면은 3개) 전부
  // 첫 번째 차트의 색을 쓰는 상태였습니다.
  //
  // 훅은 조기 반환보다 **위**에 있어야 합니다 — 렌더마다 호출 순서가 같아야
  // 하기 때문입니다.
  const gradientId = `line-fill-${useId().replace(/:/g, "")}`;

  if (data.length === 0) {
    return <div className="py-10 text-center text-sm text-muted">표시할 시계열이 없습니다.</div>;
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.3} />
            <stop offset="95%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        {/* 점선 격자는 '임계선'처럼 읽힙니다. 격자는 실선 헤어라인으로. */}
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="date" tick={AXIS} minTickGap={40} tickLine={false} />
        <YAxis
          tick={AXIS}
          tickLine={false}
          width={64}
          domain={valueDomain(data, zeroLine)}
          tickFormatter={(value: number) => `${formatNumber(value, precision)}${unit}`}
        />
        <Tooltip
          {...tooltipStyle()}
          cursor={{ stroke: "#8B949E", strokeWidth: 1 }}
          // recharts 3: value는 ValueType | undefined — 숫자로 맞춰 씁니다.
          formatter={(value) => [
            // 툴팁은 눈금보다 한 자리 더 보여 줍니다(정확한 값을 확인하는 곳).
            `${formatNumber(Number(value), precision + 1)}${unit}`,
            "값",
          ]}
        />
        {zeroLine && <ReferenceLine y={0} stroke="#8B949E" strokeWidth={1} />}
        <Area
          isAnimationActive={false}
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={2}
          fill={`url(#${gradientId})`}
          connectNulls={false}
          dot={false}
          activeDot={{ r: 4, strokeWidth: 2, stroke: "#161B22" }}
        />
      </AreaChart>
    </ResponsiveContainer>
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
};

/** 여러 시계열 비교. 단위가 다른 계열은 축을 나눠 그립니다. */
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
   * 바뀜). 범주 축이라 data에 없는 날짜는 그려지지 않으므로, 부르는 쪽이 같은 내용을 글로도 적습니다(선만으로 뜻을 나르지 않음).
   */
  markers?: { x: string; label: string }[];
}) {
  if (data.length === 0) {
    return <div className="py-10 text-center text-sm text-muted">표시할 시계열이 없습니다.</div>;
  }

  const usesRight = series.some((entry) => entry.axis === "right");
  const unitOf = (name: string) =>
    series.find((entry) => entry.name === name)?.axis === "right" ? rightUnit : unit;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        {/* recharts 3: 축 id가 기본값(0)이 아니면 격자에도 같은 id를 줘야 그려집니다. */}
        <CartesianGrid stroke={GRID} vertical={false} yAxisId="left" />
        <XAxis dataKey="date" tick={AXIS} minTickGap={40} tickLine={false} />
        <YAxis
          yAxisId="left"
          tick={AXIS}
          tickLine={false}
          width={64}
          domain={domain ?? ["auto", "auto"]}
          tickFormatter={(value: number) => `${formatNumber(value, precision)}${unit}`}
        />
        {/*
          오른쪽 축은 쓰는 계열이 있을 때만 보입니다(빈 축은 눈금만 늘립니다).
          눈금에는 단위를 붙이지 않습니다 — "320,000 계약"처럼 길어지면 두 줄로
          접히며 맨 위 눈금이 잘렸습니다. 단위는 범례와 툴팁이 말해 줍니다.
        */}
        <YAxis
          yAxisId="right"
          orientation="right"
          hide={!usesRight}
          tick={AXIS}
          tickLine={false}
          width={76}
          domain={["auto", "auto"]}
          tickFormatter={(value: number) => formatNumber(value, rightPrecision)}
        />
        <Tooltip
          {...tooltipStyle()}
          cursor={{ stroke: "#8B949E", strokeWidth: 1 }}
          formatter={(value, name) => [
            value === null || value === undefined
              ? EMPTY
              : `${formatNumber(Number(value), 2)}${unitOf(String(name))}`,
            String(name),
          ]}
        />
        <Legend wrapperStyle={{ fontSize: 11, color: "#8B949E" }} />
        {zeroLine && <ReferenceLine yAxisId="left" y={0} stroke="#8B949E" strokeWidth={1} />}
        {/* 경계선은 계열선보다 흐린 회색 점선 — 값이 아니라 "여기서 조건이 바뀜" 표시라 계열색과 겹치지 않게 합니다. */}
        {markers.map((marker) => (
          <ReferenceLine
            key={`${marker.x}-${marker.label}`}
            yAxisId="left"
            x={marker.x}
            stroke="#8B949E"
            strokeDasharray="4 3"
            strokeWidth={1}
            label={{ value: marker.label, position: "insideTopLeft", fill: AXIS.stroke, fontSize: 10 }}
          />
        ))}
        {series.map((entry) => (
          <Line
            isAnimationActive={false}
            key={entry.key}
            yAxisId={entry.axis ?? "left"}
            type="monotone"
            dataKey={entry.key}
            name={entry.name}
            stroke={entry.color}
            strokeWidth={1.8}
            dot={false}
            connectNulls={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/** 가로 막대 (수급 순위·수익률 비교). */
export function HorizontalBars({
  data,
  height = 360,
  unit = "",
  digits = 1,
  valueName = "값",
  neutral = false,
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
}) {
  if (data.length === 0) {
    return <div className="py-10 text-center text-sm text-muted">표시할 데이터가 없습니다.</div>;
  }

  // 항목이 많으면 높이를 늘립니다. 고정 높이로 30개를 그리면 한 칸이 12px이라
  // 막대도 라벨도 읽을 수 없습니다.
  const chartHeight = Math.max(height, data.length * 26 + 48);

  return (
    <ResponsiveContainer width="100%" height={chartHeight}>
      <BarChart
        data={data}
        layout="vertical"
        // 오른쪽 여백은 막대 끝 값 라벨이 잘리지 않을 만큼 둡니다.
        margin={{ top: 8, right: 68, bottom: 0, left: 8 }}
      >
        <CartesianGrid stroke={GRID} horizontal={false} />
        <XAxis
          type="number"
          tick={AXIS}
          tickLine={false}
          tickFormatter={(value: number) => `${formatNumber(value, 0)}${unit}`}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={150}
          tickLine={false}
          interval={0}
          tick={(props) => <CategoryTick {...props} maxWidth={24} />}
        />
        <Tooltip
          {...tooltipStyle()}
          cursor={BAR_CURSOR}
          formatter={(value) => [`${formatNumber(Number(value), digits)}${unit}`, valueName]}
        />
        <ReferenceLine x={0} stroke="#8B949E" />
        {/* 한국 관행: 양수(순매수·상승) 빨강, 음수 파랑 */}
        <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive={false}>
          {data.map((entry) => (
            <Cell
              key={entry.name}
              fill={neutral ? SERIES_COLORS.blue : entry.value >= 0 ? "#F85149" : "#4493F8"}
            />
          ))}
          <LabelList
            dataKey="value"
            content={(props) => <BarValueLabel {...props} unit={unit} digits={digits} />}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** 순매수/순매도를 색으로 구분하는 막대 차트. */
export function SignedBars({
  data,
  height = 320,
  unit = "",
  valueName = "순매수",
}: {
  /**
   * color를 주면 부호 색(빨강=+, 파랑=−) 대신 그 색으로 칠합니다. 거래량처럼 부호가
   * 없는 값에 빨강을 쓰면 이 화면들의 약속(빨강 = 매수·상승)과 섞여 잘못 읽힙니다.
   */
  data: { name: string; value: number; color?: string }[];
  height?: number;
  unit?: string;
  valueName?: string;
}) {
  if (data.length === 0) {
    return <div className="py-10 text-center text-sm text-muted">표시할 데이터가 없습니다.</div>;
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="name" tick={AXIS} tickLine={false} interval={0} angle={-25} height={70} textAnchor="end" />
        <YAxis
          tick={AXIS}
          tickLine={false}
          width={64}
          tickFormatter={(value: number) => `${formatNumber(value, 0)}${unit}`}
        />
        <Tooltip
          {...tooltipStyle()}
          cursor={BAR_CURSOR}
          formatter={(value) => [`${formatNumber(Number(value), 0)}${unit}`, valueName]}
        />
        <ReferenceLine y={0} stroke="#8B949E" />
        <Bar dataKey="value" radius={[4, 4, 0, 0]} isAnimationActive={false}>
          {data.map((entry) => (
            <Cell key={entry.name} fill={entry.color ?? (entry.value >= 0 ? "#F85149" : "#4493F8")} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
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
    return <div className="py-10 text-center text-sm text-muted">표시할 점이 없습니다.</div>;
  }

  return (
    // 점 하나하나가 role="img"로 노출돼 스크린리더에 수백 개의 이름 없는 그림이 됩니다. 산점도는 장식이고
    // 상관계수·표본 수는 옆에 글자로 있으므로 보조기기에는 통째로 숨깁니다.
    <div aria-hidden="true">
    <ResponsiveContainer width="100%" height={height}>
      <ScatterChart margin={{ top: 8, right: 16, bottom: 28, left: 8 }}>
        <CartesianGrid stroke={GRID} />
        <XAxis
          type="number"
          dataKey="x"
          name={xLabel}
          tick={AXIS}
          tickLine={false}
          tickFormatter={(value: number) => `${formatNumber(value, 2)}`}
          label={{ value: `${xLabel}${xUnit ? ` (${xUnit})` : ""}`, position: "insideBottom",
                   offset: -18, fill: AXIS.stroke, fontSize: 11 }}
        />
        <YAxis
          type="number"
          dataKey="y"
          name={yLabel}
          tick={AXIS}
          tickLine={false}
          width={70}
          tickFormatter={(value: number) => `${formatNumber(value, 2)}`}
        />
        <ZAxis range={[24, 24]} />
        {/* 0선을 그어 사분면이 보이게 합니다 — 변화끼리 비교할 때 핵심입니다. */}
        <ReferenceLine x={0} stroke="#8B949E" />
        <ReferenceLine y={0} stroke="#8B949E" />
        <Tooltip
          {...tooltipStyle()}
          cursor={{ strokeDasharray: "3 3", stroke: "#8B949E" }}
          formatter={(value, name) => [
            `${formatNumber(Number(value), 3)}${String(name) === xLabel ? xUnit : yUnit}`,
            String(name),
          ]}
          labelFormatter={() => ""}
        />
        <Scatter data={data} fill={color} fillOpacity={0.55} />
      </ScatterChart>
    </ResponsiveContainer>
    </div>
  );
}

/**
 * 비중 히트맵 — 분기마다 어느 종목의 비중이 커지고 줄었는지.
 *
 * <p>선 차트로 15개 종목을 겹쳐 그리면 색이 모자라고 선이 엉킵니다. 값의 크기를
 * 색 농도로 칠하면 "어느 칸이 진해지는가"만 보면 됩니다.
 *
 * <p>색만으로 값을 나르지 않도록 <b>칸 안에 숫자도 함께</b> 적습니다.
 */
export function WeightHeatmap({
  dates,
  series,
  unit = "%",
}: {
  dates: string[];
  series: Record<string, (number | null)[]>;
  unit?: string;
}) {
  const names = Object.keys(series);
  if (names.length === 0 || dates.length === 0) {
    return <div className="py-10 text-center text-sm text-muted">표시할 비중 이력이 없습니다.</div>;
  }

  const values = names.flatMap((name) => series[name] ?? []);
  const max = Math.max(...values.filter((v): v is number => typeof v === "number"), 0);

  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="비중 히트맵 (좌우 스크롤)">
      <table className="w-full min-w-[640px] border-collapse text-xs">
        <thead>
          <tr className="text-[11px] text-muted">
            <th className="sticky left-0 bg-surface px-3 py-2 text-left font-medium">종목</th>
            {dates.map((date) => (
              <th key={date} className="px-2 py-2 text-right font-medium tabular-nums">
                {date.slice(2)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {names.map((name) => (
            <tr key={name}>
              <td className="sticky left-0 bg-surface px-3 py-1.5 text-left text-body">{name}</td>
              {(series[name] ?? []).map((value, index) => {
                // 0%는 "데이터 없음"이 아니라 "그 분기에 보유하지 않음"입니다.
                const ratio = typeof value === "number" && max > 0 ? value / max : 0;
                return (
                  <td
                    key={`${name}-${dates[index] ?? index}`}
                    className="px-2 py-1.5 text-right tabular-nums"
                    style={{
                      backgroundColor:
                        typeof value === "number" && value > 0
                          ? `rgba(57, 135, 229, ${0.08 + ratio * 0.62})`
                          : "transparent",
                      // 진한 칸(#2d62a3 부근)은 본문색(#c9d1d9)과 3.9:1로 WCAG AA(4.5:1) 미달 — 흰 글자(6.2:1)로.
                      // 어두운 글자는 3.0:1로 더 나쁩니다(axe 실측).
                      color: ratio > 0.5 ? "#ffffff" : undefined,
                    }}
                    title={`${name} · ${dates[index] ?? ""}`}
                  >
                    {typeof value === "number"
                      ? value > 0
                        ? `${formatNumber(value, 1)}${unit}`
                        // 0%는 "미보유"입니다. 값을 모르는 것(EMPTY)과 같은 기호를
                        // 쓰면 둘을 구분할 수 없습니다.
                        : "·"
                      : EMPTY}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-muted">
        색이 진할수록 비중이 큽니다. &quot;·&quot;는 그 분기에 <b>보유하지 않았다</b>는 뜻이고,
        &quot;{EMPTY}&quot;는 <b>값을 모른다</b>는 뜻입니다 — 둘은 다릅니다.
      </p>
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

/** 도넛 툴팁 — 값이 앞(굵게), 이름이 뒤. 이름 앞의 짧은 선이 조각 색입니다(글자에는 계열 색을 입히지 않음). */
function DonutTooltip({ active, payload }: { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }) {
  const datum = payload?.[0]?.payload as DonutSegment | undefined;
  if (!active || !datum) return null;
  return (
    <div style={tooltipStyle().contentStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span aria-hidden style={{ display: "inline-block", width: 12, height: 2, borderRadius: 1, backgroundColor: datum.color }} />
        <strong style={{ color: "#F0F6FC", fontVariantNumeric: "tabular-nums" }}>{datum.valueText}</strong>
        <span style={{ color: "#C9D1D9" }}>{datum.name}</span>
      </div>
      {datum.caption && <div style={{ marginTop: 2, color: "#C9D1D9" }}>{datum.caption}</div>}
      {datum.detail && <div style={{ marginTop: 2, maxWidth: 260, color: AXIS.stroke }}>{datum.detail}</div>}
    </div>
  );
}

/** 라벨을 붙인 도넛의 자리 — 아래 Pie에 넘기는 값(여백 8 · 바깥 70% · 라벨 거리 20 · 글자 11px)과 같습니다. */
const DONUT_LABEL_GEOMETRY: DonutLabelGeometry = { margin: 8, outerPct: 70, offset: 20, fontSize: 11 };

/** 직접 라벨 — 고리 밖, 본문 글자색(조각 색이 아님). 라벨이 없는 조각은 그리지 않습니다. */
function DonutLabel(props: PieLabelRenderProps) {
  const label = (props.payload as DonutSegment | undefined)?.label;
  if (!label) return null;
  return (
    <text x={props.x} y={props.y} textAnchor={props.textAnchor} dominantBaseline="central" fill="#C9D1D9" fontSize={DONUT_LABEL_GEOMETRY.fontSize}>
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
 * 차트가 놓이는 바탕색이어야 합니다. 12시 방향에서 시계 방향으로, 받은 순서대로 그립니다. 조각마다 툴팁이 있고, 범례·표는 부르는
 * 쪽이 함께 그립니다(툴팁은 보조 — 값은 범례·표에서도 읽힘).
 */
export function DonutChart({
  segments,
  surface,
  height = 220,
  ariaLabel,
}: {
  segments: DonutSegment[];
  surface: string;
  height?: number;
  /** 차트 전체를 한 문장으로(화면 낭독기용 — 표가 같은 값을 나름). */
  ariaLabel: string;
}) {
  // 그려진 너비 — 직접 라벨이 SVG 끝에서 잘리지 않을 만큼 넓을 때만 라벨을 붙입니다(측정 전에는 붙이지 않음).
  const [width, setWidth] = useState<number | null>(null);
  if (segments.length === 0) {
    return <div className="py-10 text-center text-sm text-muted">표시할 구성이 없습니다.</div>;
  }
  const labelled = donutLabelsFit(width, height, segments.map((segment) => segment.label), DONUT_LABEL_GEOMETRY);
  const margin = DONUT_LABEL_GEOMETRY.margin;
  // recharts는 조각 색을 자료의 fill에서 읽습니다(Cell은 3.x에서 폐기 예정).
  const data = segments.map((segment) => ({ ...segment, fill: segment.color }));
  return (
    <figure className="m-0">
      <ResponsiveContainer width="100%" height={height} onResize={(nextWidth) => setWidth(nextWidth)}>
        {/*
          이름은 Tab으로 닿는 SVG 자체에 붙입니다 — Recharts의 접근성 층이 SVG에 role="application"·tabindex=0을 달아 화살표로 조각을
          고르게 하는데, 이름을 바깥 figure에 두면 Tab으로 들어간 화면 낭독기가 이름 없는 'application'만 읽었습니다. figure에는 같은
          이름을 다시 달지 않습니다(두 번 읽힘).
        */}
        <PieChart aria-label={ariaLabel} margin={{ top: margin, right: margin, bottom: margin, left: margin }}>
          <Tooltip content={(props) => <DonutTooltip active={props.active} payload={props.payload} />} wrapperStyle={{ outline: "none", zIndex: 40 }} />
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
    </figure>
  );
}
