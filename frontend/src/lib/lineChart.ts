/**
 * 선 차트(components/charts/LineChart)의 순수 규칙 — 축 범위·눈금·색·툴팁 글. React·Recharts를 모릅니다(ADR 0004).
 *
 * 축은 PRINCIPLES "차트는 축부터 정직해야 합니다"를 따릅니다: Y 범위는 데이터 범위(`valueDomain`), 0은 뜻이 있는 계열만,
 * 음수가 될 수 없는 양은 0 아래로 내리지 않습니다. 모르는 값은 null로 두어 선을 끊습니다(이어 그리지 않음).
 * 눈금은 끝만이 아니라 중간에도 둡니다(2026-11-01 사용자 요청) — Y는 둥근 간격(`lineYAxis`), X는 날짜 경계(`lineXTicks`).
 */
import { valueDomain, visualWidth } from "./chartAxis";
import { EMPTY } from "./format";
import { presentText } from "./patterns";

/** 차트 한 행 — 날짜와 계열 키마다 값(모르면 null). */
export type LineRow = { date: string; [key: string]: number | string | null };

/**
 * 계열 정의 — `key`는 행의 키, `label`은 범례·툴팁 이름, `color`가 없으면 기본 색을 순서대로.
 * `legend: false`면 글자 범례에서 뺍니다 — 계열이 아니라 다른 계열에 붙는 표시일 때만 씁니다.
 * `tailOf`(선택)는 꼬리 계열 — 그 키의 계열(본 계열)에 붙는 장중 값 단계의 '마지막 순자산 줄 → 오늘 추정 점' 점선입니다(장중 명세 §4).
 * 점선으로 그리고, 글자 범례에서 빼고(legend를 따로 주지 않아도), 색을 주지 않으면 본 계열 색이며, 툴팁 줄은 꼬리 자신의 점(본 계열 값이 없는 행)에만
 * 둡니다(`tailPointShown`) — 꼬리가 시작하는 마지막 줄의 값은 본 계열과 같은 숫자라 겹쳐 적지 않습니다.
 */
export type LineSeriesSpec = { key: string; label: string; color?: string; legend?: boolean; tailOf?: string };

/** 글자 범례에 넣는 계열인가 — `legend: false`와 꼬리 계열(`tailOf`)은 뺍니다. */
export function inLegend(entry: Pick<LineSeriesSpec, "legend" | "tailOf">): boolean {
  return entry.legend !== false && entry.tailOf === undefined;
}

/**
 * 꼬리 계열의 툴팁 줄을 이 행에 둘지 — 꼬리 값이 있고 본 계열 값이 없는 행(꼬리 자신의 점 — 오늘 추정 점)에서만. 꼬리가 시작하는 마지막 줄은
 * 본 계열 값과 같은 숫자라 줄을 두지 않습니다. 꼬리가 아닌 계열이면 false.
 */
export function tailPointShown(row: LineRow, entry: Pick<LineSeriesSpec, "key" | "tailOf">): boolean {
  return entry.tailOf !== undefined && lineValue(row, entry.key) !== null && lineValue(row, entry.tailOf) === null;
}

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
  /** 축 범위 [아래, 위] — 데이터 범위 + 위아래 여백(valueDomain)을 눈금 간격의 배수로 넓힌 값(고정 범위면 그대로). */
  domain: [number, number];
  /** 눈금 — 아래 끝부터 위 끝까지 같은 간격(1·2·2.5·5 × 10ⁿ)의 둥근 수, 보통 4~6개. */
  ticks: number[];
  /** 0 기준선을 그을지 — includeZero이고 범위가 0을 가로지를 때만. */
  zeroLine: boolean;
};

/** Y 눈금 간격 수의 목표(눈금 5개 안팎)와 상한 — 차트 높이 200~280px에 12px 글자가 겹치지 않는 개수. */
const Y_TICK_INTERVALS = 4;
const Y_TICK_MAX = 7;
/** 둥근 간격의 앞자리 — 10ⁿ을 곱해 씁니다. */
const NICE_STEPS = [1, 2, 2.5, 5, 10];

/** raw 이상인 가장 작은 둥근 간격(1·2·2.5·5 × 10ⁿ). */
function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw));
  return (NICE_STEPS.find((unit) => unit * power >= raw * (1 - 1e-9)) ?? 10) * power;
}

/** step보다 한 단계 큰 둥근 간격(2 → 2.5 → 5 → 10 → 20 …). */
function nextNiceStep(step: number): number {
  return niceStep(step * 1.000001);
}

/** 간격의 자릿수에 맞춰 부동소수 찌꺼기를 없앱니다(0.1 + 0.2 → 0.3). */
function roundToStep(value: number, step: number): number {
  const digits = Math.max(0, Math.ceil(-Math.log10(step)) + 1);
  const rounded = Number(value.toFixed(Math.min(digits, 12)));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * 둥근 눈금 — [lower, upper]를 간격 step의 배수로 넓히고(`fixed`면 넓히지 않고 그 안의 배수만 + 양 끝), 눈금 글(`format`)이 서로 같아지거나
 * 눈금이 너무 많으면 간격을 한 단계씩 키웁니다.
 */
export function niceAxis(
  lower: number,
  upper: number,
  options: { fixed?: boolean; format?: (value: number) => string } = {},
): { domain: [number, number]; ticks: number[] } {
  if (!(upper > lower)) {
    return { domain: [lower, upper], ticks: [lower] };
  }
  let step = niceStep((upper - lower) / Y_TICK_INTERVALS);
  for (let attempt = 0; attempt < 12; attempt += 1, step = nextNiceStep(step)) {
    const low = options.fixed ? lower : roundToStep(Math.floor(lower / step + 1e-9) * step, step);
    const high = options.fixed ? upper : roundToStep(Math.ceil(upper / step - 1e-9) * step, step);
    const first = Math.ceil(low / step - 1e-9);
    const ticks: number[] = [];
    for (let index = first; index * step <= high + step * 1e-9; index += 1) {
      ticks.push(roundToStep(index * step, step));
    }
    if (options.fixed) {
      // 고정 범위의 끝이 간격의 배수가 아니면 끝도 눈금으로 — 가장 가까운 눈금과 간격의 절반 넘게 떨어질 때만(글이 겹치지 않게).
      if (ticks.length === 0 || ticks[0] - low > step / 2) ticks.unshift(low);
      if (high - ticks[ticks.length - 1] > step / 2) ticks.push(high);
    }
    const labels = options.format ? ticks.map(options.format) : null;
    const distinct = labels === null || new Set(labels).size === labels.length;
    if (ticks.length <= Y_TICK_MAX && distinct) {
      return { domain: [low, high], ticks };
    }
  }
  return { domain: [lower, upper], ticks: [lower, upper] };
}

/**
 * Y축 — 모든 계열 값을 모아 `valueDomain`으로 범위를 정하고, 그 범위를 둥근 간격의 배수로 넓혀 같은 간격의 눈금을 답니다(`niceAxis`).
 *
 * - `includeZero`: 0이 뜻을 갖는 계열(스프레드·순포지션)만 범위에 0을 넣습니다. 0 바닥을 지어내지 않습니다(5.85~6.0조에 0~6조 축 금지).
 *   0이 범위에 들면 0은 간격의 배수라 늘 눈금입니다.
 * - `nonNegative`: 음수가 될 수 없는 양이면 아래 끝을 0 아래로 내리지 않습니다(valueDomain도 값이 모두 0 이상이면 그렇게 함 — 여기서 한 번 더 막음).
 *   그래도 음수 값이 오면 Recharts가 범위를 넓혀 그 점을 보입니다(allowDataOverflow 기본 false — 값을 숨기지 않음).
 *   값이 모두 음수면(위 끝도 0 아래) 0으로 올리지 않고 데이터 범위를 그대로 씁니다 — 올리면 아래 끝이 위 끝보다 커져 축이 뒤집힙니다.
 *   0 이상인 아래 끝을 간격의 배수로 내려도 0 아래로는 가지 않습니다.
 * - `format`(선택): 눈금 글 서식 — 두 눈금이 같은 글이 되면(소수 한 자리 서식에 0.05 간격 등) 간격을 키웁니다.
 * - 0 기준선은 includeZero이고 0이 범위 안쪽(끝이 아님)에 있을 때만 — 값이 모두 0 이상이면 0은 축 끝 눈금이 대신 말합니다.
 *
 * @returns 값이 하나도 없으면 null
 */
export function lineYAxis(
  data: readonly LineRow[],
  series: readonly LineSeriesSpec[],
  options: { includeZero?: boolean; nonNegative?: boolean; format?: (value: number) => string } = {},
): LineYAxis | null {
  const points = data.flatMap((row) => series.map((entry) => ({ value: lineValue(row, entry.key) })));
  const [rawLower, rawUpper] = valueDomain(points, options.includeZero === true);
  if (typeof rawLower !== "number" || typeof rawUpper !== "number") {
    return null;
  }
  const lower = options.nonNegative && rawUpper > 0 ? Math.max(0, rawLower) : rawLower;
  const { domain, ticks } = niceAxis(lower, rawUpper, { format: options.format });
  return {
    domain,
    ticks,
    zeroLine: options.includeZero === true && domain[0] < 0 && domain[1] > 0,
  };
}

/** 고정 범위(0~100 같은 뜻이 정해진 값)의 Y축 — 범위는 그대로, 눈금은 그 안의 둥근 간격(`niceAxis` fixed). */
export function fixedYAxis(
  domain: [number, number],
  options: { zeroLine?: boolean; format?: (value: number) => string } = {},
): LineYAxis {
  return {
    domain,
    ticks: niceAxis(domain[0], domain[1], { fixed: true, format: options.format }).ticks,
    zeroLine: options.zeroLine === true && domain[0] < 0 && domain[1] > 0,
  };
}

/**
 * 히어로 차트의 최고·최저 표시 하나 — 그 점의 날짜(행의 date)·값, 글을 점의 어느 쪽에 맞출지(`anchor`), 점의 위·아래 어디에 적을지(`side` — 최고는
 * 보통 위, 최저는 보통 아래).
 */
export type HeroExtreme = { date: string; value: number; anchor: "start" | "middle" | "end"; side: "above" | "below" };

/**
 * 히어로 차트(`variant="hero"`)의 Y 끝값 둘 — 축 범위 끝(여백 8%를 더한, 데이터에 없는 값) 대신 **본 계열의 실제 최고·최저**를 그 점 위·아래에 적습니다.
 * 값이 데이터에 있는 숫자라 짓지 않고, 최고 점 위·최저 점 아래는 선이 지나지 않아(선은 그 값을 넘지 않음 — monotone 보간은 점 사이에서 넘치지 않음)
 * 글이 선·꼬리와 겹치지 않습니다.
 *
 * - 꼬리 계열(`tailOf` — 장중 값 단계의 오늘 추정 점)은 빼고 본 계열(순자산 줄 등 기록된 값)만 봅니다 — 추정 점의 값을 표시 없이 끝값으로 적지 않게.
 *   축 범위는 그대로 꼬리를 담습니다(`lineYAxis`).
 * - 같은 값이 여럿이면 가장 늦은 점. 최고와 최저가 같으면(평평하거나 점 하나) 최고 하나만(low null).
 * - 글 맞춤은 점의 자리(행 순번 ÷ 마지막 순번)로 — 왼쪽 1/5 안이면 start, 오른쪽 1/5 안이면 end, 그 밖은 middle(그림 밖으로 잘리지 않게).
 * - 꼬리는 본 계열의 마지막 값에서 시작해 오른쪽으로 이어지고 그 끝(추정 점)은 본 계열의 최고보다 높거나 최저보다 낮을 수 있어, 그 점(꼬리가 시작하는
 *   점)의 글이 오른쪽으로 번지면 꼬리 점선과 겹칩니다 — 그 점이면 끝 맞춤(end, 글이 왼쪽 — 본 계열 쪽 — 으로). 그 점이 그림 왼쪽 끝이라(기록이 한 줄뿐)
 *   끝 맞춤이면 잘리는 때는 시작 맞춤을 두고, 꼬리가 글 쪽으로 가면(최고 글인데 꼬리가 올라감·최저 글인데 내려감) 글을 점의 반대쪽에 적습니다.
 *
 * @returns 본 계열 값이 하나도 없으면 null
 */
export function heroExtremes(
  data: readonly LineRow[],
  series: readonly LineSeriesSpec[],
): { high: HeroExtreme; low: HeroExtreme | null } | null {
  const mains = series.filter((entry) => entry.tailOf === undefined);
  let high: { index: number; value: number } | null = null;
  let low: { index: number; value: number } | null = null;
  for (let index = 0; index < data.length; index += 1) {
    for (const entry of mains) {
      const value = lineValue(data[index], entry.key);
      if (value === null) continue;
      if (high === null || value >= high.value) high = { index, value };
      if (low === null || value <= low.value) low = { index, value };
    }
  }
  if (high === null || low === null) {
    return null;
  }
  const last = data.length - 1;
  const tails = series.filter((entry) => entry.tailOf !== undefined);
  const lastMain = data.reduce((found, row, index) => (mains.some((entry) => lineValue(row, entry.key) !== null) ? index : found), -1);
  // 꼬리가 시작하는 점(본 계열의 마지막 값)이면 그 뒤 꼬리의 끝 값 — 아니면 null.
  const tailEnd = (index: number): number | null => {
    if (index !== lastMain) return null;
    const ends = data
      .slice(index + 1)
      .flatMap((row) => tails.map((entry) => lineValue(row, entry.key)).filter((value): value is number => value !== null));
    return ends.at(-1) ?? null;
  };
  const point = ({ index, value }: { index: number; value: number }, side: "above" | "below"): HeroExtreme => {
    const at = last <= 0 ? 0.5 : index / last;
    const end = tailEnd(index);
    if (end === null) {
      return { date: data[index].date, value, anchor: at < 0.2 ? "start" : at > 0.8 ? "end" : "middle", side };
    }
    if (at >= 0.2) {
      return { date: data[index].date, value, anchor: "end", side };
    }
    const toward = side === "above" ? end > value : end < value;
    return { date: data[index].date, value, anchor: "start", side: toward ? (side === "above" ? "below" : "above") : side };
  };
  return { high: point(high, "above"), low: low.value === high.value ? null : point(low, "below") };
}

/** 축 글 폭 어림(px) — 라틴 한 칸 ≈ 글자 크기 × 0.6, 한글은 두 칸(`visualWidth`). */
export function axisLabelWidth(text: string, fontSize: number): number {
  return visualWidth(text) * fontSize * 0.6;
}

/** X 눈금 글 사이 최소 틈(px)과 중간 눈금 개수 상한. */
const X_TICK_GAP = 16;
const X_TICK_MAX_INTERIOR = 6;

/** 중간 눈금의 짧은 글 — 양 끝이 연도를 나르므로 일·주는 'MM-DD', 월·분기·반기는 'YYYY-MM', 해 단위는 'YYYY'. */
const monthDay = (date: string) => date.slice(5, 10);
const yearMonth = (date: string) => date.slice(0, 7);
const yearOnly = (date: string) => date.slice(0, 4);

/**
 * 날짜 경계 단위 — 잘게부터. `key`는 날짜를 그 단위의 칸 이름으로 바꾸고(칸이 바뀌는 첫 행이 경계), `label`은 그 경계의 중간 눈금 글입니다.
 */
const DATE_UNITS: readonly { key: (year: number, month: number, day: number) => string; label: (date: string) => string }[] = [
  { key: (year, month, day) => `${year}-${month}-${day}`, label: monthDay },
  {
    // 월요일 시작 주 — 그 주 월요일의 날짜(UTC로 계산해 시간대와 무관).
    key: (year, month, day) => {
      const at = Date.UTC(year, month - 1, day);
      const weekday = (new Date(at).getUTCDay() + 6) % 7;
      return new Date(at - weekday * 86_400_000).toISOString().slice(0, 10);
    },
    label: monthDay,
  },
  { key: (year, month) => `${year}-${month}`, label: yearMonth },
  { key: (year, month) => `${year}-q${Math.floor((month - 1) / 3)}`, label: yearMonth },
  { key: (year, month) => `${year}-h${Math.floor((month - 1) / 6)}`, label: yearMonth },
  { key: (year) => `${year}`, label: yearOnly },
  { key: (year) => `${Math.floor(year / 2)}`, label: yearOnly },
  { key: (year) => `${Math.floor(year / 5)}`, label: yearOnly },
  { key: (year) => `${Math.floor(year / 10)}`, label: yearOnly },
];

/** X축 눈금 — 눈금 행의 date(첫·중간·마지막)와 그 글(양 끝은 date 그대로, 중간은 단위에 맞춘 짧은 글). */
export type LineXAxis = { ticks: string[]; labels: Record<string, string> };

/**
 * X축 눈금 — 첫 날짜와 마지막 날짜, 그리고 그 사이의 중간 눈금.
 *
 * - `width`(그림 너비 px)를 모르면(측정 전·0) 첫·마지막만 — 너비를 모르고 중간 눈금을 달면 좁은 화면에서 글이 겹칩니다.
 * - 중간 눈금은 날짜 경계에 둡니다 — 일·주(월요일)·월·분기·반기·연·2·5·10년 가운데 경계 수가 너비에 들어가는 개수(그 단위의 짧은 글 폭으로 잼,
 *   많아야 6) 이하인 단위들의 경계 행(그 칸의 첫 거래일)을 놓아 보고, 가장 많이 놓이는 단위(같으면 잘은 쪽)를 씁니다 — 행 순번 자리라 경계가
 *   양 끝 글 가까이 몰리면 덜 놓입니다. 글은 일·주 'MM-DD', 월·분기·반기 'YYYY-MM', 해 단위 'YYYY' — 양 끝의
 *   전체 날짜가 연도를 나릅니다. 모든 행이 'YYYY-MM-DD'로 시작하지 않으면 고른 간격의 행에 글은 date 그대로.
 * - 범주 축이라 행 순번 비율로 자리를 잽니다(첫 행 왼쪽 끝, 마지막 행 오른쪽 끝 — Recharts 선 차트의 point 축). 첫 글은 왼쪽 끝에 붙고
 *   마지막 글은 오른쪽 끝에 붙으므로(EdgeDateTick), 중간 글은 가운데 맞춤으로 잡아 이웃·양 끝 글과 `X_TICK_GAP` 넘게 떨어진 것만 남깁니다.
 * - 좁은 그림(작은 여러 차트)에서 전체 날짜 양 끝 사이에 중간 눈금이 하나도 들어가지 않고 양 끝의 달이 다르면, 양 끝을 'YYYY-MM'으로 줄여 한 번 더
 *   고릅니다 — 정확한 날짜는 툴팁이 나릅니다.
 */
export function lineXAxis(data: readonly LineRow[], options: { width?: number | null; fontSize?: number } = {}): LineXAxis {
  if (data.length === 0) {
    return { ticks: [], labels: {} };
  }
  const dates = data.map((row) => row.date);
  const first = dates[0];
  const last = dates[dates.length - 1];
  const width = options.width ?? 0;
  if (first === last || !(width > 0) || dates.length <= 2) {
    return { ticks: first === last ? [first] : [first, last], labels: { [first]: first, [last]: last } };
  }
  const full = layoutXAxis(dates, width, options.fontSize ?? 12, (date) => date);
  const dated = dates.every((date) => /^\d{4}-\d{2}-\d{2}/.test(date));
  if (full.ticks.length > 2 || !dated || yearMonth(first) === yearMonth(last)) {
    return full;
  }
  return layoutXAxis(dates, width, options.fontSize ?? 12, yearMonth);
}

/** `lineXAxis`의 한 번 고르기 — 양 끝 글은 `endLabel`(전체 날짜 또는 'YYYY-MM'). */
function layoutXAxis(dates: readonly string[], width: number, fontSize: number, endLabel: (date: string) => string): LineXAxis {
  const first = dates[0];
  const last = dates[dates.length - 1];
  const widthOf = (text: string) => axisLabelWidth(text, fontSize);
  const free = width - widthOf(endLabel(first)) - widthOf(endLabel(last)) - X_TICK_GAP;
  const lastIndex = dates.length - 1;
  const roomFor = (labels: readonly string[]) =>
    Math.min(X_TICK_MAX_INTERIOR, Math.max(0, Math.floor(free / (Math.max(0, ...labels.map(widthOf)) + X_TICK_GAP))));

  const x = (index: number) => (index / lastIndex) * width;
  const lastLeft = width - widthOf(endLabel(last));
  // 후보 행을 왼쪽부터 놓아 봅니다 — 이웃·양 끝 글과 X_TICK_GAP 넘게 떨어진 것만.
  const place = (candidates: readonly number[], label: (date: string) => string): LineXAxis => {
    let right = widthOf(endLabel(first));
    const ticks: string[] = [first];
    const labels: Record<string, string> = { [first]: endLabel(first), [last]: endLabel(last) };
    for (const index of candidates) {
      const text = label(dates[index]);
      const half = widthOf(text) / 2;
      if (x(index) - half >= right + X_TICK_GAP && x(index) + half <= lastLeft - X_TICK_GAP) {
        ticks.push(dates[index]);
        labels[dates[index]] = text;
        right = x(index) + half;
      }
    }
    ticks.push(last);
    return { ticks, labels };
  };

  const parts = dates.map((date) => /^(\d{4})-(\d{2})-(\d{2})/.exec(date));
  if (parts.some((match) => match === null)) {
    const room = roomFor(dates);
    const even = Array.from({ length: room }, (_, index) => Math.round(((index + 1) * lastIndex) / (room + 1)));
    return place(even.filter((index, at) => index > 0 && index < lastIndex && even.indexOf(index) === at), (date) => date);
  }
  const ymd = parts.map((match) => match!.slice(1, 4).map(Number) as [number, number, number]);
  let best = place([], (date) => date);
  for (const unit of DATE_UNITS) {
    const keys = ymd.map(([year, month, day]) => unit.key(year, month, day));
    const boundaries = keys.flatMap((key, index) => (index > 0 && index < lastIndex && key !== keys[index - 1] ? [index] : []));
    if (boundaries.length === 0 || boundaries.length > roomFor(boundaries.map((index) => unit.label(dates[index])))) {
      continue;
    }
    const placed = place(boundaries, unit.label);
    if (placed.ticks.length > best.ticks.length) {
      best = placed;
    }
  }
  return best;
}

/** 세로 표시선 이름과 선 사이(px) — Recharts 표시선 이름의 안쪽 여백(offset 5)에 한 칸 더. */
const MARKER_LABEL_PAD = 6;

/**
 * 세로 표시선(예: 순자산 곡선의 '프레임 v5') 이름을 선의 어느 쪽에 적을지 — 기본은 오른쪽, 오른쪽에 적으면 그림 오른쪽 끝을 넘을 때만 왼쪽.
 * 자리는 범주 축의 행 순번 비율(`lineXAxis`와 같음). 그림 너비를 모르면(측정 전) 마지막 행의 표시선만 왼쪽. 표시선 날짜가 행에 없으면 오른쪽
 * (Recharts가 그리지 않음).
 */
export function markerLabelSide(
  data: readonly LineRow[],
  x: string,
  label: string,
  options: { width?: number | null; fontSize?: number } = {},
): "right" | "left" {
  const index = data.findIndex((row) => row.date === x);
  if (index < 0 || data.length < 2) {
    return "right";
  }
  const lastIndex = data.length - 1;
  const width = options.width ?? 0;
  if (!(width > 0)) {
    return index === lastIndex ? "left" : "right";
  }
  const at = (index / lastIndex) * width;
  return at + MARKER_LABEL_PAD + axisLabelWidth(label, options.fontSize ?? 12) > width ? "left" : "right";
}

/** X축 눈금 행의 date만(`lineXAxis`의 ticks) — 너비를 주지 않으면 첫·마지막. */
export function lineXTicks(data: readonly LineRow[], options: { width?: number | null; fontSize?: number } = {}): string[] {
  return lineXAxis(data, options).ticks;
}

/**
 * 계열 색 — 색을 넘긴 계열은 그 색, 아니면 기본 색 목록(SERIES_COLORS)의 **같은 자리** 색(i번째 계열 = i번째 색).
 * 색을 넘기지 않은 꼬리 계열(`tailOf`)은 본 계열의 색입니다(기본 색 자리를 쓰지 않음 — 같은 계좌의 선과 그 꼬리가 같은 색).
 *
 * 기본 색은 되풀이하지 않습니다. 넷째 계열에 첫 색을 다시 쓰면 두 선이 같은 색이 되어 구분되지 않습니다 — 그래서
 * 자리에 맞는 기본 색이 없는데 색도 넘기지 않았으면 오류를 던집니다(조용히 같은 색을 쓰는 대신 부르는 쪽이 색을 정하거나 패널을 나눔).
 * 꼬리의 본 계열이 목록에 없을 때도 오류입니다(어느 선의 꼬리인지 모르는 점선을 짐작한 색으로 그리지 않음).
 */
export function lineSeriesColors(series: readonly LineSeriesSpec[], palette: readonly string[]): string[] {
  const own = series.map((entry, index) => {
    if (entry.color) {
      return entry.color;
    }
    if (entry.tailOf !== undefined) {
      return null;
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
  return own.map((color, index) => {
    if (color !== null) {
      return color;
    }
    const entry = series[index];
    const main = series.findIndex((other) => other.key === entry.tailOf && other.tailOf === undefined);
    const mainColor = main >= 0 ? own[main] : null;
    if (mainColor === null) {
      throw new Error(`LineChart: 꼬리 계열 "${entry.label}"의 본 계열 "${entry.tailOf}"이 목록에 없습니다 — 본 계열을 넘기거나 color를 주세요.`);
    }
    return mainColor;
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
 * 꼬리 계열(`tailOf`)만 예외입니다: 꼬리 줄은 꼬리 자신의 점(`tailPointShown`)에만 두고, 그 점에서는 본 계열의 "—" 줄을 빼 꼬리 이름
 * ('… · 추정 23:58')이 그 계열의 값으로 읽히게 합니다(그날 순자산 줄은 아직 없고 추정 점만 있음).
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
    items: series.flatMap((entry, index) => {
      const value = lineValue(row, entry.key);
      if (entry.tailOf !== undefined ? !tailPointShown(row, entry) : value === null && series.some((tail) => tail.tailOf === entry.key && tailPointShown(row, tail))) {
        return [];
      }
      return [{
        key: entry.key,
        label: entry.label,
        color: colors[index] ?? "var(--text-3)",
        text: value === null ? EMPTY : valueFormat(value),
      }];
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

// ---------------------------------------------------------------- 히어로 차트 문지르기(명세 §5)

/**
 * 문지르는 점의 순번 — Recharts가 넘기는 활성 자리(툴팁의 `activeIndex`·이벤트의 `activeTooltipIndex`: number | string | null | undefined,
 * 키보드·터치에서는 "3" 같은 글)를 행 순번으로 바꿉니다. 정수가 아니거나 행 범위 밖이면 null(문지르지 않음 — 지금 값을 보임).
 *
 * @param length 지금 그리는 행 수
 */
export function scrubIndex(raw: unknown, length: number): number | null {
  if (typeof raw !== "number" && (typeof raw !== "string" || raw.trim() === "")) {
    return null;
  }
  const index = Number(raw);
  return Number.isInteger(index) && index >= 0 && index < length ? index : null;
}

/** 문지르는 점의 표시 글 — 히어로(components/patterns/Hero의 `scrub`)가 큰 숫자·날짜·'기간 시작 대비' 칩으로 그립니다. */
export type ScrubModel = {
  /** 그 점의 값(valueFormat). 그날 값이 없으면 "—"(0으로 채우지 않음). */
  valueText: string;
  /** 그 점의 날짜(행의 date 그대로). */
  dateText: string;
  /** 기간의 첫 유효값 대비 변화량 — 그 점의 값을 모르면 null(칩 생략). */
  change: number | null;
  /** 같은 기준의 변화율(%) — 기준이 0 이하이면(비율의 뜻이 없음) 또는 값을 모르면 null. */
  changePct: number | null;
  /** 추정 점인가 — 장중 값 단계의 '오늘 추정 점'(점선 꼬리). 문지르는 동안에도 추정 배지가 보이게 합니다(원칙 A3). */
  isEstimated: boolean;
  /**
   * 꼬리 점의 설명 — 부르는 쪽이 준 글(없으면 null). 추정 점이면 배지 안의 설명(예: 기준 시각 "23:58" → '추정 · 23:58'), 추정이 아닌 꼬리 점
   * (현금뿐 계좌 — 그 점은 장부 값)이면 배지 없이 적는 글(예: "장부"). 히어로의 낭독 알림도 같은 글을 읽습니다.
   */
  estimateNote: string | null;
};

/**
 * 꼬리 점(장중 값 단계의 오늘 추정 점) — 문지르기가 그 날짜의 점을 읽는 법.
 *
 * - `date`: 꼬리 점의 날짜(행의 date).
 * - `valueKey`(선택): 그 날 값을 읽을 키 — 꼬리 계열(`tailOf`)의 키. 꼬리 점의 날에는 본 계열 값이 없습니다(그날 순자산 줄이 아직 없음). 주지 않으면 본 키.
 * - `isEstimated`(선택, 기본 true): 추정 점인가. false는 현금뿐 계좌처럼 그 점이 장부 값인 꼬리(추정 배지 없이 `note`만).
 * - `note`(선택): 그 점의 설명(추정이면 기준 시각 'HH:MM', 장부 값이면 '장부').
 */
export type ScrubEstimate = { date: string; note?: string | null; valueKey?: string; isEstimated?: boolean };

/**
 * 문지르는 점 → 표시 글. 순번이 null이거나 범위 밖이면 null(문지르지 않음).
 *
 * - 변화는 **기간의 첫 유효값**(그 계열에서 처음으로 값이 있는 행) 대비입니다 — 그 기간 안에서 얼마나 움직였는지. 그 점이 첫 유효값이면 0.
 * - 그 점의 값이 없으면 값 "—"와 변화 null(칩 생략) — 날짜는 그대로 보입니다(그날 기록이 없음을 보임).
 * - `estimate`(선택, `ScrubEstimate`): 꼬리 점의 날짜를 문지르면 값은 꼬리 키(`valueKey`)에서 읽고(같은 첫 유효값 대비 변화), 추정 점이면
 *   `isEstimated`와 설명, 장부 값 꼬리 점이면 추정 아님 + 설명('장부')을 냅니다. 꼬리 선(점선)은 범례에 넣지 않고(계열의 `tailOf`), 추정 표시는
 *   이 모델로 히어로가 그립니다.
 */
export function scrubModel(
  rows: readonly LineRow[],
  key: string,
  index: number | null,
  valueFormat: (value: number) => string,
  options: { estimate?: ScrubEstimate | null } = {},
): ScrubModel | null {
  const at = scrubIndex(index, rows.length);
  if (at === null) {
    return null;
  }
  const row = rows[at];
  const estimate = options.estimate != null && options.estimate.date === row.date ? options.estimate : null;
  const value = estimate?.valueKey ? (lineValue(row, estimate.valueKey) ?? lineValue(row, key)) : lineValue(row, key);
  const base = rows.map((entry) => lineValue(entry, key)).find((entry): entry is number => entry !== null) ?? null;
  const change = value !== null && base !== null ? value - base : null;
  return {
    valueText: value === null ? EMPTY : valueFormat(value),
    dateText: row.date,
    change,
    changePct: change !== null && base !== null && base > 0 ? (change / base) * 100 : null,
    isEstimated: estimate !== null && estimate.isEstimated !== false,
    estimateNote: estimate ? presentText(estimate.note) : null,
  };
}
