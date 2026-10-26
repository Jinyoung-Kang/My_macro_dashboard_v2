/**
 * 표(components/patterns/DataTable)의 정렬 규칙 — 순수 함수(ADR 0004). 화면은 여기서 정한 순서대로 그리기만 합니다.
 *
 * 모르는 값(null·"N/A"·"—"·NaN)은 방향과 상관없이 늘 맨 뒤입니다. 내림차순에서 null이 맨 위로 올라오면
 * "가장 큰 값"처럼 읽히고, 오름차순에서 맨 위면 "가장 작은 값"처럼 읽힙니다 — 둘 다 없는 순위를 만듭니다.
 */
import { isMissingValue } from "./patterns";

export type SortDir = "asc" | "desc";
export type SortState = { key: string; dir: SortDir };
export type SortValue = number | string | null;

/** 한국어 글은 가나다, 글 속 숫자는 숫자 크기로("2호" < "10호"). */
const COLLATOR = new Intl.Collator("ko", { numeric: true });

/** 값이 있는 두 정렬 값의 오름차순 비교 — 숫자끼리는 크기, 글끼리는 가나다, 섞이면 숫자가 앞. */
export function compareSortValues(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  if (typeof a === "number") {
    return -1;
  }
  if (typeof b === "number") {
    return 1;
  }
  return COLLATOR.compare(a, b);
}

/**
 * 행을 정렬한 새 배열 — 원래 배열은 건드리지 않습니다. 값이 같으면 원래 순서를 지킵니다(안정 정렬).
 * 모르는 값은 방향과 무관하게 맨 뒤(그들끼리는 원래 순서).
 *
 * @param sortValue 없으면 원래 순서 그대로
 */
export function sortRows<T>(
  rows: readonly T[],
  sortValue: ((row: T) => SortValue | undefined) | undefined,
  dir: SortDir,
): T[] {
  if (!sortValue) {
    return [...rows];
  }
  const keyed = rows.map((row, index) => {
    const value = sortValue(row);
    return { row, index, value: isMissingValue(value) ? null : (value as number | string) };
  });
  const sign = dir === "asc" ? 1 : -1;
  keyed.sort((left, right) => {
    if (left.value === null || right.value === null) {
      if (left.value === null && right.value === null) {
        return left.index - right.index;
      }
      return left.value === null ? 1 : -1;
    }
    return sign * compareSortValues(left.value, right.value) || left.index - right.index;
  });
  return keyed.map((entry) => entry.row);
}

/** 머리 정렬 단추를 눌렀을 때의 다음 상태 — 새 열은 오름차순부터, 같은 열은 오름↔내림. */
export function nextSort(current: SortState | null, key: string): SortState {
  if (current && current.key === key) {
    return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  }
  return { key, dir: "asc" };
}

/** 열 머리의 aria-sort — 지금 정렬한 열에만 붙입니다(정렬하지 않은 열은 속성 없음, ARIA 권고). */
export function ariaSortOf(current: SortState | null, key: string): "ascending" | "descending" | undefined {
  if (!current || current.key !== key) {
    return undefined;
  }
  return current.dir === "asc" ? "ascending" : "descending";
}
