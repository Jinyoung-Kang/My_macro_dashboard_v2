/**
 * COT 화면(/cot)의 글 규칙 — React 없이 시험합니다(ADR 0004 규칙 3).
 */
import { EMPTY, formatSignedMinus } from "./format";

/**
 * 부호 있는 계약 수(순포지션) — 양수는 '+', 음수는 −(U+2212), 0은 부호 없이, 모르면 "—"(QA-629). 순포지션은 부호가 곧 방향(롱·숏)이라
 * 같은 화면의 변화 칩과 같은 부호로 적습니다.
 */
export function formatSignedCount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return EMPTY;
  }
  return formatSignedMinus(value, 0).text;
}
