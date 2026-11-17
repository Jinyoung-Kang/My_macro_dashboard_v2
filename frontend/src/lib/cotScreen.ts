/**
 * COT 화면(/cot)의 글·KPI 규칙 — React 없이 시험합니다(ADR 0004 규칙 3).
 */
import { EMPTY, formatNumber, formatSignedMinus } from "./format";
import type { KpiItem } from "./kpi";
import type { CotSummary } from "./types";

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

/**
 * KPI 타일 하나 — 공용 KPI 띠의 타일 형(lib/kpi KpiItem — 정본)에 이 띠가 늘 채우는 변화 칸을 좁힌 것.
 * 값을 모르면 `value: null` 또는 "—"(화면 Empty) — 0으로 채우지 않습니다.
 */
export type CotKpi = KpiItem & { change?: { change: number | null; digits: number; caption: string } };

/**
 * 고른 자산의 포지셔닝 요약 KPI 띠 — 스마트머니(비상업) 순포지션(1주 변화 칩·기준일·출처 줄) · 상업 헤저 · 소액/비보고 · 3년 표본 백분위. 순포지션은
 * 부호가 방향이라 −로 적고(`formatSignedCount`), 출처 줄은 첫 타일에만 둡니다(같은 공시 한 건 — 순유동성·섹터 띠와 같은 규칙). 요약이 없으면 빈 목록.
 */
export function cotKpis(summary: CotSummary | null | undefined, source: string): CotKpi[] {
  if (!summary) {
    return [];
  }
  const change1w = typeof summary.change1w === "number" && Number.isFinite(summary.change1w) ? summary.change1w : null;
  return [
    {
      key: "ncNet",
      label: "스마트머니 순포지션",
      value: formatSignedCount(summary.ncNet),
      change: change1w === null ? undefined : { change: change1w, digits: 0, caption: "1주" },
      source,
      asOf: summary.date ?? null,
    },
    { key: "commNet", label: "상업 헤저 순포지션", value: formatSignedCount(summary.commNet) },
    { key: "nrNet", label: "소액/비보고", value: formatSignedCount(summary.nrNet) },
    {
      key: "percentile",
      label: "3년 표본 백분위",
      value: typeof summary.percentile === "number" && Number.isFinite(summary.percentile) ? summary.percentile : null,
      // 단위 '%'는 숫자에 붙입니다(섹터 띠의 수익률과 같은 꼴 — 띠의 단위 자리는 숫자와 4px 띄움).
      format: (value) => `${formatNumber(value, 1)}%`,
      note: "100%에 가까울수록 역사적 최대 롱",
    },
  ];
}
