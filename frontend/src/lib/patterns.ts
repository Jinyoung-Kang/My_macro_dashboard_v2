/**
 * 화면 패턴(components/patterns)이 쓰는 표시 규칙 — 순수 함수(ADR 0004).
 *
 * 컴포넌트는 여기서 만든 글자와 방향만 그립니다. 숫자 서식 자체는 `lib/format.ts`를 그대로 씁니다
 * (빈값 "—", 부호·색은 반올림 뒤 보이는 숫자 기준, 시각은 `formatKst`).
 */
import { delayLabel, EMPTY, formatKst, formatNumber, formatSignedMinus } from "./format";

/**
 * 표시할 값이 '없음'인가.
 *
 * null·undefined·false·NaN·±Infinity, 빈 글, 이미 "—"이거나 "-"인 글, 수집기가 보내는 "N/A"(대소문자 무관).
 * React 요소처럼 다른 객체는 값이 있는 것으로 봅니다 — 부르는 쪽이 이미 그린 것이기 때문입니다.
 */
export function isMissingValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false) {
    return true;
  }
  if (typeof value === "number") {
    return !Number.isFinite(value);
  }
  if (typeof value === "string") {
    const text = value.trim();
    return text === "" || text === EMPTY || text === "-" || text.toUpperCase() === "N/A";
  }
  return false;
}

/**
 * 사유·설명·판정·보조 글처럼 덧붙이는 글 — 앞뒤 공백을 떼고, 값 없음(빈 글·"—"·"N/A", `isMissingValue`)이면 null.
 * 패턴 전부가 이 규칙 하나를 씁니다 — 수집기의 "N/A"를 사유처럼 찍지 않습니다.
 */
export function presentText(text: string | null | undefined): string | null {
  return typeof text === "string" && !isMissingValue(text) ? text.trim() : null;
}

/** 보이는(반올림된) 숫자의 방향. flat은 0으로 찍히는 값 — 화살표 없이 중립색. 부호 글은 `formatSignedMinus`(lib/format.ts). */
export type ChangeDirection = "up" | "down" | "flat";

export type ChangeChipModel = {
  direction: ChangeDirection;
  /** 변화량(단위는 부르는 쪽이 옆에 붙임). 모르면 null. */
  change: string | null;
  /** 변화율 — "%"까지 붙은 글. 모르면 null. */
  changePct: string | null;
};

/**
 * 변화 칩의 글과 방향. 변화량·변화율을 둘 다 모르면 null — 칩을 생략합니다(0.00%를 만들지 않음).
 *
 * 방향은 보이는 숫자의 부호로 정합니다. 둘 다 0으로 찍히면 flat, 두 부호가 어긋나면(자료 오류) 방향을 단정하지 않고 flat.
 * `pctDigits`(기본 = `digits`)는 변화율만의 자릿수입니다 — 금리처럼 변화량은 셋째, 변화율은 둘째 자리로 찍을 때.
 */
export function changeChipModel(
  change: number | null | undefined,
  changePct: number | null | undefined,
  digits = 2,
  pctDigits = digits,
): ChangeChipModel | null {
  const amount = isMissingValue(change) ? null : formatSignedMinus(change as number, digits);
  const pct = isMissingValue(changePct) ? null : formatSignedMinus(changePct as number, pctDigits);
  if (amount === null && pct === null) {
    return null;
  }
  const signs = [amount?.sign ?? 0, pct?.sign ?? 0].filter((sign) => sign !== 0);
  let direction: ChangeDirection = "flat";
  if (signs.length > 0 && signs.every((sign) => sign > 0)) {
    direction = "up";
  } else if (signs.length > 0 && signs.every((sign) => sign < 0)) {
    direction = "down";
  }
  return {
    direction,
    change: amount ? amount.text : null,
    changePct: pct ? `${pct.text}%` : null,
  };
}

/**
 * 출처 배지 글 — "출처 · 실시간|N분 지연 · 시각". 모르는 부분은 빼고, 전부 모르면 "출처 —".
 *
 * `live`가 참이면 지연 분과 상관없이 "실시간". 지연 문구는 `delayLabel`(0분 = 실시간, 모르면 생략)과 같은 규칙입니다.
 * 시각은 `formatKst`로 한 형식(YYYY-MM-DD HH:mm)에 맞춥니다 — 이미 맞춘 글이면 그대로입니다.
 */
export function provenanceText({
  source,
  asOf,
  delayMin,
  live,
}: {
  source?: string | null;
  asOf?: string | null;
  delayMin?: number | null;
  live?: boolean;
}): string {
  const at = presentText(asOf);
  const parts = [presentText(source), live ? "실시간" : delayLabel(delayMin), at === null ? null : formatKst(at)].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(" · ") : `출처 ${EMPTY}`;
}

/**
 * 추정·대리 배지 라벨 — "추정" / "대리 지표" / 둘 다면 "추정 · 대리 지표". 둘 다 아니면 null(배지를 그리지 않음).
 */
export function estimateLabel(estimated?: boolean, proxy?: boolean): string | null {
  const labels = [estimated ? "추정" : null, proxy ? "대리 지표" : null].filter((label): label is string => label !== null);
  return labels.length > 0 ? labels.join(" · ") : null;
}

/**
 * 통계 타일에 찍을 값 글. 모르면 null(화면은 "—"와 사유, 단위는 붙이지 않음 — QA-049).
 *
 * 숫자는 `format`(없으면 `formatNumber` 소수 둘째 자리)으로, 글은 받은 그대로 씁니다.
 * `format`이 "—"나 빈 글을 돌려줘도 값이 없는 것으로 봅니다.
 */
export function statValueText(
  value: number | string | null | undefined,
  format?: (v: number) => string,
): string | null {
  if (isMissingValue(value)) {
    return null;
  }
  const text = typeof value === "number" ? (format ? format(value) : formatNumber(value)) : (value as string).trim();
  return isMissingValue(text) ? null : text;
}

/**
 * 자리표시(Skeleton) 줄 수. 줄 수를 정하지 않았을 때 높이(블록)가 있으면 0줄, 없으면 3줄.
 * 음수·소수·NaN은 0 이상의 정수로 맞춥니다.
 */
export function skeletonLineCount(lines: number | undefined, height: number | undefined): number {
  if (lines === undefined) {
    return height !== undefined && height > 0 ? 0 : 3;
  }
  return Number.isFinite(lines) ? Math.max(0, Math.floor(lines)) : 0;
}
