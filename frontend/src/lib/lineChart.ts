/**
 * 선 차트(components/charts/LineChart)의 순수 규칙 — 축 범위·눈금·색·툴팁 글. React·Recharts를 모릅니다(ADR 0004).
 *
 * 축은 PRINCIPLES "차트는 축부터 정직해야 합니다"를 따릅니다: Y 범위는 데이터 범위(`valueDomain`), 0은 뜻이 있는 계열만,
 * 음수가 될 수 없는 양은 0 아래로 내리지 않습니다. 모르는 값은 null로 두어 선을 끊습니다(이어 그리지 않음).
 */
import { valueDomain } from "./chartAxis";
import { EMPTY } from "./format";
import { presentText } from "./patterns";

/** 차트 한 행 — 날짜와 계열 키마다 값(모르면 null). */
export type LineRow = { date: string; [key: string]: number | string | null };

/** 계열 정의 — `key`는 행의 키, `label`은 범례·툴팁 이름, `color`가 없으면 기본 색을 순서대로. */
export type LineSeriesSpec = { key: string; label: string; color?: string };

/** 계열 값 하나 — 유한한 숫자만 값입니다. null·문자열("N/A" 등)·NaN·±Infinity는 모름(null). */
export function lineValue(row: LineRow, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 그릴 값이 하나라도 있는가 — 행이 없거나 모든 칸이 모름이면 false(빈 상태 문구를 보임). */
export function hasLineValues(data: readonly LineRow[], series: readonly LineSeriesSpec[]): boolean {
  return data.some((row) => series.some((entry) => lineValue(row, entry.key) !== null));
}

/**
 * Recharts에 넘길 행 — 계열 칸을 숫자 아니면 null로 맞춥니다.
 * 수집기의 "N/A" 같은 글이 그대로 가면 좌표가 NaN이 되어 선이 깨지므로, 모름은 모두 null(= 선 끊김)로 바꿉니다.
 */
export function normalizeLineRows(data: readonly LineRow[], series: readonly LineSeriesSpec[]): LineRow[] {
  return data.map((row) => {
    const out: LineRow = { date: row.date };
    for (const entry of series) {
      out[entry.key] = lineValue(row, entry.key);
    }
    return out;
  });
}

export type LineYAxis = {
  /** 축 범위 [아래, 위] — 데이터 범위 + 위아래 여백(valueDomain). */
  domain: [number, number];
  /** 눈금 — 축 끝값 두 개만. */
  ticks: [number, number];
  /** 0 기준선을 그을지 — includeZero이고 범위가 0을 가로지를 때만. */
  zeroLine: boolean;
};

/**
 * Y축 — 모든 계열 값을 모아 `valueDomain`으로 범위를 정하고, 눈금은 그 끝값 두 개.
 *
 * - `includeZero`: 0이 뜻을 갖는 계열(스프레드·순포지션)만 범위에 0을 넣습니다. 0 바닥을 지어내지 않습니다(5.85~6.0조에 0~6조 축 금지).
 * - `nonNegative`: 음수가 될 수 없는 양이면 아래 끝을 0 아래로 내리지 않습니다(valueDomain도 값이 모두 0 이상이면 그렇게 함 — 여기서 한 번 더 막음).
 *   그래도 음수 값이 오면 Recharts가 범위를 넓혀 그 점을 보입니다(allowDataOverflow 기본 false — 값을 숨기지 않음).
 *   값이 모두 음수면(위 끝도 0 아래) 0으로 올리지 않고 데이터 범위를 그대로 씁니다 — 올리면 아래 끝이 위 끝보다 커져 축이 뒤집힙니다.
 * - 0 기준선은 includeZero이고 0이 범위 안쪽(끝이 아님)에 있을 때만 — 값이 모두 0 이상이면 0은 축 끝 눈금이 대신 말합니다.
 *
 * @returns 값이 하나도 없으면 null
 */
export function lineYAxis(
  data: readonly LineRow[],
  series: readonly LineSeriesSpec[],
  options: { includeZero?: boolean; nonNegative?: boolean } = {},
): LineYAxis | null {
  const points = data.flatMap((row) => series.map((entry) => ({ value: lineValue(row, entry.key) })));
  const [rawLower, rawUpper] = valueDomain(points, options.includeZero === true);
  if (typeof rawLower !== "number" || typeof rawUpper !== "number") {
    return null;
  }
  const lower = options.nonNegative && rawUpper > 0 ? Math.max(0, rawLower) : rawLower;
  const upper = rawUpper;
  return {
    domain: [lower, upper],
    ticks: [lower, upper],
    zeroLine: options.includeZero === true && lower < 0 && upper > 0,
  };
}

/** X축 눈금 — 첫 날짜와 마지막 날짜만(행이 하나면 그 날짜 하나, 없으면 빈 목록). */
export function lineXTicks(data: readonly LineRow[]): string[] {
  if (data.length === 0) {
    return [];
  }
  const first = data[0].date;
  const last = data[data.length - 1].date;
  return first === last ? [first] : [first, last];
}

/**
 * 계열 색 — 색을 넘긴 계열은 그 색, 아니면 기본 색 목록(SERIES_COLORS)의 **같은 자리** 색(i번째 계열 = i번째 색).
 *
 * 기본 색은 되풀이하지 않습니다. 넷째 계열에 첫 색을 다시 쓰면 두 선이 같은 색이 되어 구분되지 않습니다 — 그래서
 * 자리에 맞는 기본 색이 없는데 색도 넘기지 않았으면 오류를 던집니다(조용히 같은 색을 쓰는 대신 부르는 쪽이 색을 정하거나 패널을 나눔).
 */
export function lineSeriesColors(series: readonly LineSeriesSpec[], palette: readonly string[]): string[] {
  return series.map((entry, index) => {
    if (entry.color) {
      return entry.color;
    }
    const color = palette[index];
    if (color === undefined) {
      throw new Error(
        `LineChart: ${index + 1}번째 계열 "${entry.label}"에 줄 기본 색이 없습니다 — 기본 색은 ${palette.length}개뿐이고 되풀이하지 않습니다. ` +
          "color를 넘기거나 패널을 나누세요.",
      );
    }
    return color;
  });
}

/**
 * 이웃이 모두 모름인 외딴 점의 자리 — 선 없이 점으로 찍어야 보입니다.
 * 선(connectNulls=false)은 두 점 사이에만 그어지므로, 앞뒤가 null인 값 하나는 선만으로는 화면에서 사라집니다(값을 숨기게 됨).
 */
export function isolatedPointIndexes(data: readonly LineRow[], key: string): number[] {
  const known = data.map((row) => lineValue(row, key) !== null);
  return known.flatMap((isKnown, index) =>
    isKnown && !known[index - 1] && !known[index + 1] ? [index] : [],
  );
}

export type LineTooltipModel = {
  date: string;
  items: { key: string; label: string; color: string; text: string }[];
  /** "출처 · …" 줄 — 출처를 모르면 null(줄을 빼고 지어내지 않음). */
  sourceLine: string | null;
};

/**
 * 툴팁 글 — 날짜, 계열마다 이름·색·값(모르면 "—"), 출처 줄.
 * 값이 없는 계열도 줄을 남겨 "—"로 적습니다 — 줄이 사라지면 그날 그 계열이 있었는지 없었는지 알 수 없습니다.
 */
export function lineTooltipModel(
  row: LineRow,
  series: readonly LineSeriesSpec[],
  colors: readonly string[],
  valueFormat: (value: number) => string,
  source?: string | null,
): LineTooltipModel {
  return {
    date: row.date,
    items: series.map((entry, index) => {
      const value = lineValue(row, entry.key);
      return {
        key: entry.key,
        label: entry.label,
        color: colors[index] ?? "var(--text-3)",
        text: value === null ? EMPTY : valueFormat(value),
      };
    }),
    sourceLine: sourceLineText(source),
  };
}

/** 툴팁의 출처 줄 — 출처를 모르면(빈 글·"N/A") null. */
function sourceLineText(source: string | null | undefined): string | null {
  const text = presentText(source);
  return text === null ? null : `출처 · ${text}`;
}

/**
 * 화면 낭독기용 차트 이름 — "선 차트: 계열들 · 첫 날짜 ~ 마지막 날짜". 값은 툴팁과 화면의 글(히어로·표)이 나릅니다.
 */
export function lineChartLabel(data: readonly LineRow[], series: readonly LineSeriesSpec[]): string {
  const names = series.map((entry) => entry.label).join(", ");
  const ticks = lineXTicks(data);
  const span = ticks.length === 0 ? "" : ` · ${ticks.join(" ~ ")}`;
  return `선 차트: ${names}${span}`;
}
