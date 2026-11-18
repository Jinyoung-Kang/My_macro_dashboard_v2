/**
 * 스타일·위험 화면(/style)의 짝 표·유사도 행렬·성격 검사 칸·위험 KPI 띠 규칙 — React 없이 시험합니다(ADR 0004 규칙 3).
 *
 * 값을 모르면 null(화면 "—") — 0으로 채우지 않습니다. 음수는 −(U+2212)입니다(VaR·ES·위험 기여 — QA-704·709).
 */
import type { DetailProperty } from "./detailEntity";
import { EMPTY, formatNumber, formatUsd, formatWithUnit, withMinusSign } from "./format";
import { heatmapStepRange } from "./heatmap";
import { filerName } from "./holdings";
import type { KpiItem } from "./kpi";
import { topPairs } from "./transforms";
import type { GuruProfile, GuruRiskResponse } from "./types";

/** 유사도 기준 — 겹침 비중(%, 대각선 100)·코사인(0~1, 대각선 1). */
export type SimilarityMode = "overlap" | "cosine";

/** 원화 병기 — 공용 환율 훅(useUsdKrw)의 환산 함수와 환율 문구(lib/consensusScreen과 같은 꼴). */
export type KrwNote = { toKrw: (usd: number | null | undefined) => string | null; note: string };

/**
 * 표 머리·행렬·짝 표에 쓰는 짧은 이름 — 국기를 뗀 이름(lib/holdings filerName)에서 끝의 괄호 설명(영문 이름)을 뗍니다.
 * 예전에는 그림 문자 정규식만 써서 국기를 이루는 지역 표시 문자가 남았습니다(QA-153).
 */
export function styleShortName(name: string): string {
  return (filerName(name) ?? name).replace(/\s*\(.*\)\s*$/, "").trim();
}

/** 마우스 설명에 쓰는 전체 이름 — 국기를 뗀 이름(비면 받은 글). */
export function styleFullName(name: string): string {
  return filerName(name) ?? name;
}

/** 유사도 단계 기준 — 겹침 100, 코사인 1(대각선 값). */
export function similarityMax(mode: SimilarityMode): number {
  return mode === "overlap" ? 100 : 1;
}

/**
 * 유사도 값 글 — 겹침 소수 첫째, 코사인 둘째 자리. 그 자릿수에서 0으로 반올림되는 양수는 '<0.1'·'<0.01'입니다 — 표 히트맵은 0보다 큰 값을 칠하고 참 0은
 * 칠하지 않으므로, '0.0'으로 적으면 칠한 '0.0'과 칠하지 않은 '0.0'이 섞여 둘을 가를 수 없었습니다(QA-718 — 비중 히트맵의 '<0.1%'(QA-454)와 같은 규칙).
 */
export function similarityText(mode: SimilarityMode, value: number): string {
  const digits = similarityDigits(mode);
  if (value > 0 && value < 10 ** -digits / 2) return similarityBelowText(mode);
  return formatNumber(value, digits);
}

/** 유사도 값 자릿수 — 겹침 1, 코사인 2. */
function similarityDigits(mode: SimilarityMode): number {
  return mode === "overlap" ? 1 : 2;
}

/** 0으로 반올림되는 양수의 글 — 겹침 '<0.1', 코사인 '<0.01'(범례 설명 글도 씀). */
export function similarityBelowText(mode: SimilarityMode): string {
  const digits = similarityDigits(mode);
  return `<${formatNumber(10 ** -digits, digits)}`;
}

/** 짝 표 한 줄 — 순위·두 기관(짧은 이름·전체 이름)·값. 키는 두 기관의 받은 이름(짝마다 하나). */
export type SimilarityPair = { key: string; rank: number; left: string; leftTitle: string; right: string; rightTitle: string; value: number };

/**
 * '가장 닮은 짝' 줄 — 행렬에서 직접 만든 상위 `limit` 쌍(서버의 topPairs는 겹침 순이라 코사인을 고르면 목록과 기준이 어긋남 — lib/transforms topPairs).
 * 기관 12곳이면 66쌍이라 브라우저에서 충분합니다. 모르는 칸(null)은 빠집니다.
 */
export function similarityPairs(
  institutions: readonly { name: string }[],
  matrix: readonly (readonly (number | null | undefined)[] | undefined)[] | null | undefined,
  limit = 8,
): SimilarityPair[] {
  if (!matrix) return [];
  return topPairs(institutions, matrix, (name) => name, limit).map((pair, index) => ({
    key: `${pair.left}|${pair.right}`,
    rank: index + 1,
    left: styleShortName(pair.left),
    leftTitle: styleFullName(pair.left),
    right: styleShortName(pair.right),
    rightTitle: styleFullName(pair.right),
    value: pair.value,
  }));
}

/** 표 히트맵 열·행 — components/charts `HeatmapColumn`·`HeatmapRow`와 같은 꼴(lib는 components를 가져오지 않음 — ADR 0004). */
export type SimilarityHeatmap = {
  columns: { key: string; label: string; title: string }[];
  rows: { key: string; label: string; title: string; values: (number | null | undefined)[]; selfIndex: number }[];
};

/** 유사도 행렬 → 표 히트맵 열·행(행·열 = 기관, 짧은 이름·전체 이름 마우스 설명, 대각선 = 자기 칸). 행렬에 없는 칸은 모름(undefined → '—'). */
export function similarityHeatmap(
  institutions: readonly { cik: string; name: string }[],
  matrix: readonly (readonly (number | null | undefined)[] | undefined)[],
): SimilarityHeatmap {
  return {
    columns: institutions.map((entry) => ({ key: entry.cik, label: styleShortName(entry.name), title: styleFullName(entry.name) })),
    rows: institutions.map((entry, row) => ({
      key: entry.cik,
      label: styleShortName(entry.name),
      title: styleFullName(entry.name),
      values: institutions.map((_, col) => matrix[row]?.[col]),
      selfIndex: row,
    })),
  };
}

/** 히트맵 범례 단계 글 — 겹침 '0~20%'…, 코사인 '0.0~0.2'…(단계 = 값 ÷ 최댓값의 구간, lib/heatmap). */
export function similarityStepLabel(mode: SimilarityMode, step: 1 | 2 | 3 | 4 | 5): string {
  const [low, high] = heatmapStepRange(step);
  return mode === "overlap" ? `${Math.round(low * 100)}~${Math.round(high * 100)}%` : `${formatNumber(low, 1)}~${formatNumber(high, 1)}`;
}

/** 기관 표시 이름 — 국기를 뗀 이름, 비면 'CIK …'. */
export function profileName(row: Pick<GuruProfile, "cik" | "name">): string {
  return filerName(row.name) ?? `CIK ${row.cik}`;
}

/** 성격 검사 칸 제목 — 그 CIK의 기관 이름. 자료에 없는 CIK면 null(검사 칸 틀이 '고른 줄이 지금 자료에 없습니다'). */
export function profileTitle(rows: readonly Pick<GuruProfile, "cik" | "name">[] | null | undefined, cik: string): string | null {
  const row = (rows ?? []).find((entry) => entry.cik === cik);
  return row ? profileName(row) : null;
}

/** 글 값 — 비었거나 "—"면 null. */
function present(text: string | null | undefined): string | null {
  const trimmed = (text ?? "").trim();
  return trimmed && trimmed !== EMPTY ? trimmed : null;
}

/** 유한한 수인가. */
function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 회전율을 모르는 까닭 — 표 칸의 마우스 설명과 같은 글. */
export const TURNOVER_EMPTY_REASON = "직전 분기가 없어 계산할 수 없습니다";

/**
 * 기관 성격 검사 칸 속성 — 기관 소개(긴 글)·CIK(고정폭)·기준 분기·포트폴리오 총액·원화 환산(보조 = 환율 문구)·종목 수·유효 종목 수(보조 '1 ÷ HHI')·
 * HHI(허핀달 지수 — 비중 제곱의 합, 소수 넷째 자리)·상위 10종목 비중·분기 회전율(모르면 '—'과 까닭)·수집 분기 수. 응답에 오는데 표에는 없는 HHI·
 * 수집 분기 수를 여기서 보입니다(새 요청 없음).
 */
export function profileItems(row: GuruProfile, krw: KrwNote): DetailProperty[] {
  const desc = present(row.desc);
  return [
    ...(desc ? [{ label: "기관 소개", value: desc, block: true }] : []),
    { label: "CIK", value: present(row.cik), mono: true },
    { label: "기준 분기", value: present(row.reportDate) },
    { label: "포트폴리오 총액", value: present(formatUsd(row.totalValue)) },
    { label: "원화 환산", value: krw.toKrw(row.totalValue), note: krw.note },
    { label: "종목 수", value: finite(row.holdingCount) ? `${formatNumber(row.holdingCount, 0)}종목` : null },
    { label: "유효 종목 수", value: finite(row.effectiveHoldings) ? formatNumber(row.effectiveHoldings, 1) : null, note: "1 ÷ HHI" },
    // HHI 0은 비중이 하나도 없을 때의 값(백엔드 GuruStyle.herfindahl) — 모르는 것과 같아 "—"입니다(그때 유효 종목 수도 null).
    { label: "HHI", value: finite(row.hhi) && row.hhi > 0 ? formatNumber(row.hhi, 4) : null, note: "비중(0~1) 제곱의 합 — 1이면 한 종목" },
    { label: "상위 10종목", value: finite(row.top10Weight) ? formatWithUnit(row.top10Weight, 1, "%") : null },
    {
      label: "분기 회전율",
      value: finite(row.turnover) ? formatWithUnit(row.turnover, 1, "%") : null,
      emptyReason: finite(row.turnover) ? null : TURNOVER_EMPTY_REASON,
    },
    { label: "수집 분기 수", value: finite(row.quarterCount) ? `${formatNumber(row.quarterCount, 0)}분기` : null },
  ];
}

/** 부호 있는 퍼센트 값 글 — 음수는 −(U+2212). 모르면 "—"(KPI 띠는 값 null로 받아 '—'를 그림). */
export function signedUnitText(value: number | null | undefined, digits: number, unit: string): string {
  return withMinusSign(formatWithUnit(value, digits, unit));
}

/** 소수 둘째 자리 숫자 서식(음수 −) — KPI 값 서식. */
const TWO = (value: number) => withMinusSign(formatNumber(value, 2));

/** 값 — 유한한 수만(모르면 null — '—'). */
function known(value: number | null | undefined): number | null {
  return finite(value) ? value : null;
}

/**
 * 포트폴리오 위험 KPI 띠 '위험 지표' 여덟 — 연율 변동성(보조 '표본 n일 · 시작 ~ 끝')·베타(vs 벤치마크)·추적오차·최대낙폭·VaR 95·99%·ES 95·99%.
 * 값은 등락이 아니라 위험의 크기라 본문 잉크(등락색 없음), 음수(VaR·ES는 손실이라 음수 — QA-709)는 −, 단위는 값 옆 작은 글. 보조 글은 옛 지표 칸의
 * 설명 그대로입니다. 출처는 띠를 담은 패널 머리가 적습니다(띠에 다시 적지 않음).
 */
export function riskKpis(metrics: NonNullable<GuruRiskResponse["metrics"]>, benchmark: string): KpiItem[] {
  const window =
    finite(metrics.samples) && metrics.from && metrics.to ? `표본 ${formatNumber(metrics.samples, 0)}일 · ${metrics.from} ~ ${metrics.to}` : null;
  return [
    { key: "volatility", label: "연율 변동성", value: known(metrics.volatility), format: TWO, unit: "%", note: window },
    { key: "beta", label: `베타 (vs ${benchmark})`, value: known(metrics.beta), format: TWO, note: "1.0이면 벤치마크와 같은 폭으로 움직였다는 뜻" },
    { key: "trackingError", label: "추적오차 (연율)", value: known(metrics.trackingError), format: TWO, unit: "%", note: "벤치마크와 얼마나 달랐나 — 좋고 나쁨은 말하지 않습니다" },
    { key: "maxDrawdown", label: "최대낙폭", value: known(metrics.maxDrawdown), format: TWO, unit: "%", note: "구간 내 고점 대비 최대 하락" },
    { key: "var95", label: "VaR (95%)", value: known(metrics.var95), format: TWO, unit: "%", note: "일일 최대 예상 손실" },
    { key: "var99", label: "VaR (99%)", value: known(metrics.var99), format: TWO, unit: "%", note: "극단 상황" },
    { key: "es95", label: "ES (95%)", value: known(metrics.es95), format: TWO, unit: "%", note: "VaR 초과 시 평균 손실" },
    { key: "es99", label: "ES (99%)", value: known(metrics.es99), format: TWO, unit: "%", note: "VaR 초과 시 평균 손실" },
  ];
}

/** 위험 패널의 기관 이름(섹터 막대 이름 등) — 기관별 성격 목록에서 그 CIK의 이름, 목록에 없으면 'CIK …'. */
export function riskInstitutionName(rows: readonly Pick<GuruProfile, "cik" | "name">[] | null | undefined, cik: string): string {
  return profileTitle(rows, cik) ?? `CIK ${cik}`;
}
