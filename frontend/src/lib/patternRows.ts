/**
 * 자산 행·스파크라인·기간 탭(components/patterns)의 표시 규칙 — 순수 함수(ADR 0004).
 *
 * 값 없음 판정은 `lib/patterns.ts`의 `isMissingValue`, 숫자 서식은 `lib/format.ts`,
 * Y 범위는 `lib/chartAxis.ts`의 `valueDomain`을 그대로 씁니다. 컴포넌트는 여기서 만든 글·좌표만 그립니다.
 */
import { valueDomain } from "./chartAxis";
import { formatNumber } from "./format";
import { isMissingValue, presentText } from "./patterns";

/**
 * 자산 행에 찍을 값 글. 모르면 null — 화면은 "—"를 그리고 단위는 붙이지 않습니다(QA-049).
 *
 * - `valueText`(수집기가 서식해 보낸 글, 예: macro 카드의 `priceStr`)가 글로 오면 그것이 이깁니다.
 *   그 글이 "N/A"·빈 글·"—"이면 숫자 `value`가 있어도 값 없음입니다 — 수집기가 '없음'이라고 판정한 값을
 *   화면이 남은 숫자로 되살리지 않습니다.
 * - `valueText`가 null·undefined면 `value`를 `formatNumber`(소수 둘째 자리)로 찍습니다. NaN·Infinity는 값 없음, 0은 값입니다.
 */
export function assetValueText(value: number | null | undefined, valueText?: string | null): string | null {
  if (typeof valueText === "string") {
    return isMissingValue(valueText) ? null : valueText.trim();
  }
  return isMissingValue(value) ? null : formatNumber(value as number);
}

/** 자산 행 모델이 읽는 필드 — `AssetRowData`(components/patterns/AssetRow.tsx)의 부분집합입니다. */
export type AssetRowFlags = {
  value: number | null;
  valueText?: string | null;
  sub?: string | null;
  spark?: readonly (number | null)[];
  isEstimated?: boolean;
  isProxy?: boolean;
  isStale?: boolean;
  warning?: string | null;
};

export type AssetRowModel = {
  /** 찍을 값 글. null이면 "—"(단위 없음). */
  valueText: string | null;
  /** 보조 글(티커·시장 등). 비었거나 "N/A"면 null. */
  sub: string | null;
  /** 경고 글(예: "수집 실패"). 비었거나 "N/A"면 null. */
  warning: string | null;
  /** 스파크라인을 그릴 수 있는가 — 알려진 점이 2개 이상. */
  showSpark: boolean;
  /** 배지 줄을 그릴지 — 추정·대리·이전 값·경고·출처(showProvenance) 가운데 하나라도 있으면. */
  hasBadges: boolean;
};

/**
 * 자산 행 한 줄의 표시 모델. 플래그가 있으면 배지 줄이 반드시 생깁니다(숨기는 옵션 없음).
 *
 * @param showProvenance 참이면 출처 배지를 늘 그립니다(출처를 몰라도 "출처 —").
 */
export function assetRowModel(row: AssetRowFlags, showProvenance = false): AssetRowModel {
  const warning = presentText(row.warning);
  return {
    valueText: assetValueText(row.value, row.valueText),
    sub: presentText(row.sub),
    warning,
    showSpark: knownPointCount(row.spark) >= 2,
    hasBadges: Boolean(row.isEstimated || row.isProxy || row.isStale || warning !== null || showProvenance),
  };
}

/** 유한한 숫자의 개수. null·NaN·Infinity는 세지 않습니다. */
function knownPointCount(values: readonly (number | null | undefined)[] | undefined): number {
  return values ? values.filter((value) => typeof value === "number" && Number.isFinite(value)).length : 0;
}

/** 스파크라인의 한 점(SVG 좌표, 왼쪽 위가 0,0). */
export type SparkPoint = { x: number; y: number };

/**
 * 스파크라인 좌표 — 값이 없는 자리(null·NaN)에서 선을 끊어 조각 목록으로 돌려줍니다.
 *
 * - 알려진 점이 2개 미만이면 null(그리지 않음). 앞뒤가 비어 혼자 남은 점은 점 하나짜리 조각입니다.
 * - X는 원래 순번 기준이라 빈 자리만큼 간격이 남습니다(빈 구간을 이어 붙이지 않음 — connectNulls=false와 같은 뜻).
 * - Y 범위는 `valueDomain(…, false)` — 0을 억지로 넣지 않고, 0 이상인 계열은 0 아래로 내리지 않으며 위아래 여백을 둡니다.
 * - `inset`은 선 굵기의 절반쯤 — 끝점이 잘리지 않게 안쪽으로 들입니다. 좌표는 소수 둘째 자리로 반올림합니다.
 */
export function sparklineSegments(
  values: readonly (number | null | undefined)[],
  width: number,
  height: number,
  inset = 1.5,
): SparkPoint[][] | null {
  if (knownPointCount(values) < 2 || !(width > 2 * inset) || !(height > 2 * inset)) {
    return null;
  }
  const [lower, upper] = valueDomain(
    values.map((value) => ({ value: typeof value === "number" ? value : null })),
    false,
  ) as [number, number];
  const stepX = (width - 2 * inset) / (values.length - 1);
  const spanY = upper - lower;
  const segments: SparkPoint[][] = [];
  let current: SparkPoint[] = [];
  values.forEach((value, index) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      return;
    }
    current.push({
      x: round2(inset + index * stepX),
      y: round2(inset + ((upper - value) / spanY) * (height - 2 * inset)),
    });
  });
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 기간 탭에 그릴 구간 — `allowed`(저장 구간 안의 키)가 있으면 그 안의 것만, 순서는 `ranges`를 따릅니다.
 * `allowed`가 없으면 전부. 저장 구간 밖의 탭은 그리지 않습니다(설계서 §6, PRINCIPLES "기간 탭은 저장 구간을 넘지 않음").
 */
export function visibleRanges<R extends { key: string }>(ranges: readonly R[], allowed?: readonly R["key"][]): R[] {
  return allowed ? ranges.filter((range) => allowed.includes(range.key)) : [...ranges];
}

/**
 * 고를 수 있는 구간 키. `value`가 그려지는 탭이면 그대로, 아니면 그려지는 첫 탭, 하나도 없으면 null.
 *
 * 기간 탭은 고른 값이 허용 밖이면 아무것도 선택하지 않은 채로 그립니다 — 부르는 쪽이 이 함수로 상태를 맞춥니다.
 * 키보드로 들어갈 탭(tabIndex 0)도 이 규칙으로 정합니다.
 */
export function allowedRangeKey<R extends { key: string }>(
  value: R["key"] | null | undefined,
  ranges: readonly R[],
  allowed?: readonly R["key"][],
): R["key"] | null {
  const keys = visibleRanges(ranges, allowed).map((range) => range.key);
  if (value !== null && value !== undefined && keys.includes(value)) {
    return value;
  }
  return keys[0] ?? null;
}

/**
 * 기간 탭 키보드 이동 — ←·→는 이웃 탭(끝에서 반대쪽 끝으로 돎), Home·End는 처음·끝. 그 밖의 키는 null.
 * 지금 탭이 목록에 없으면 →·Home은 처음, ←·End는 끝으로 갑니다.
 */
export function rangeKeyAfter<K extends string>(keys: readonly K[], current: K | null, key: string): K | null {
  if (keys.length === 0) {
    return null;
  }
  const index = current === null ? -1 : keys.indexOf(current);
  switch (key) {
    case "ArrowRight":
      return keys[index < 0 ? 0 : (index + 1) % keys.length];
    case "ArrowLeft":
      return keys[index < 0 ? keys.length - 1 : (index - 1 + keys.length) % keys.length];
    case "Home":
      return keys[0];
    case "End":
      return keys[keys.length - 1];
    default:
      return null;
  }
}
