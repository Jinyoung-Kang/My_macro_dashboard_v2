/**
 * 종목 스코어카드 화면(/scorecard)의 KPI 띠·지표 표 규칙 — React 없이 시험합니다(ADR 0004 규칙 3).
 *
 * 값을 모르면 null(화면 "—") — 0으로 채우지 않습니다(예전 화면은 비교 대상 수·지표 수를 모르면 0으로 적었음). 음수는 −(U+2212)이고(QA-705),
 * 실제 값은 등락이 아니라 크기·위치라 본문 잉크입니다(좋고 나쁨은 '방향'과 백분위가 나름).
 */
import { stockHref } from "./detail";
import { formatNumber, withMinusSign } from "./format";
import type { KpiItem } from "./kpi";
import type { ScorecardMetric, ScorecardResponse, StockUniverseResponse } from "./types";

/** 유한한 수인가. */
function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 소수 둘째 자리(음수 −) — 베타·수익률. */
const TWO = (value: number) => withMinusSign(formatNumber(value, 2));
/** 정수(천 단위 쉼표) — 점수·개수. */
const COUNT = (value: number) => formatNumber(value, 0);

/** '가격 지표 평균' 보조 글 — 몇 개 지표의 평균인지(모르면 수 없이)와 종합 점수가 아니라는 말(예전 지표 칸의 캡션과 메모를 한 줄로). */
export function priceScoreNote(scoredCount: number | null | undefined): string {
  const head = finite(scoredCount) ? `${formatNumber(scoredCount, 0)}개 지표의 백분위 평균` : "지표 백분위 평균";
  return `${head} — 종합 점수가 아닙니다. 재무·성장·밸류에이션은 빠져 있습니다.`;
}

/**
 * '스코어 요약' KPI 띠 — 종목(값 = 티커, 보조 '이름 · 섹터', 타일 전체가 그 종목 상세 링크 /s/us/{티커} — 요청 없음)·가격 지표 평균(n점)·
 * 베타(vs 기준)·비교 대상(n종목, 보조 = 집단 이름과 백분위의 뜻). 출처 줄은 한 타일에만(띠 전체가 같은 일별 종가) — 첫 숫자 타일 '가격 지표 평균'에
 * 둡니다. 종목 타일에 두면 타일 안 차례(이름 → 값 → 출처 → 보조 글)상 '이름 · 섹터'가 출처 줄 아래 각주처럼 떨어졌습니다(브라우저 확인).
 */
export function scorecardKpis(
  data: Pick<ScorecardResponse, "symbol" | "name" | "sector" | "benchmark" | "priceScore" | "scoredCount" | "raw" | "universeSize" | "universeLabel">,
  source: string,
): KpiItem[] {
  const symbol = data.symbol?.trim() ? data.symbol.trim() : null;
  const beta = data.raw?.beta;
  const about = [data.name, data.sector].filter((part): part is string => typeof part === "string" && part.trim() !== "").join(" · ");
  return [
    {
      key: "symbol",
      label: "종목",
      value: symbol,
      valueKind: "label",
      note: about || null,
      ...(symbol ? { href: stockHref("us", symbol) } : {}),
    },
    {
      key: "priceScore",
      label: "가격 지표 평균",
      value: finite(data.priceScore) ? data.priceScore : null,
      format: COUNT,
      unit: "점",
      note: priceScoreNote(data.scoredCount),
      source,
    },
    {
      key: "beta",
      label: `베타 (vs ${data.benchmark})`,
      value: finite(beta) ? beta : null,
      format: TWO,
      note: "1.0이면 기준과 같은 폭으로 움직였다는 뜻",
    },
    {
      key: "universe",
      label: "비교 대상",
      value: finite(data.universeSize) ? data.universeSize : null,
      format: COUNT,
      unit: "종목",
      note: `${data.universeLabel ? `${data.universeLabel} — ` : ""}백분위는 이 집단 안에서의 위치입니다.`,
    },
  ];
}

/** '원자료' KPI 띠 — 1·6개월 수익률(음수 −)·표본(거래일 수)·측정 구간. 점수로 바꾸기 전의 값입니다. */
export function scorecardRawKpis(data: Pick<ScorecardResponse, "raw" | "years">): KpiItem[] {
  const known = (value: number | null | undefined) => (finite(value) ? value : null);
  return [
    { key: "momentum1m", label: "1개월 수익률", value: known(data.raw?.momentum1m), format: TWO, unit: "%" },
    { key: "momentum6m", label: "6개월 수익률", value: known(data.raw?.momentum6m), format: TWO, unit: "%" },
    { key: "samples", label: "표본", value: known(data.raw?.samples), format: COUNT, unit: "일", note: "거래일 수" },
    { key: "years", label: "측정 구간", value: finite(data.years) ? `최근 ${formatNumber(data.years, 0)}년` : null, valueKind: "label" },
  ];
}

/** 지표 표 '실제 값' 글 — 숫자(소수 첫째) + 단위, 음수 −. 모르면 null(표가 '—'). */
export function metricValueText(metric: Pick<ScorecardMetric, "value" | "unit">): string | null {
  return finite(metric.value) ? withMinusSign(`${formatNumber(metric.value, 1)}${metric.unit ?? ""}`) : null;
}

/** 백분위를 모르는 까닭 — 값 자체가 없으면(표본 부족) 비교 대상 수가 원인이 아닙니다(QA-088 — 두 경우를 나눠 적음). 백분위가 있으면 null. */
export function metricScoreEmptyReason(metric: Pick<ScorecardMetric, "value" | "score">): string | null {
  if (finite(metric.score)) return null;
  return metric.value === null ? "표본이 부족해 값을 잴 수 없어 백분위도 없습니다" : "비교 대상이 10개 미만이라 백분위를 내지 않습니다";
}

/** 백분위를 모르는 까닭의 짧은 글 — 표 칸 '—' 옆에 늘 보이는 글(긴 글은 마우스 설명 — QA-719). 백분위가 있으면 null. */
export function metricScoreEmptyShort(metric: Pick<ScorecardMetric, "value" | "score">): string | null {
  if (finite(metric.score)) return null;
  return metric.value === null ? "표본 부족" : "비교 대상 10개 미만";
}

/** 지표별 백분위 막대 — 백분위를 모르는 지표는 뺍니다(0으로 그리지 않음). */
export function metricBars(metrics: readonly ScorecardMetric[] | null | undefined): { name: string; value: number }[] {
  return (metrics ?? []).filter((metric) => finite(metric.score)).map((metric) => ({ name: metric.label, value: metric.score as number }));
}

/** 종목 고르기 선택지 — '티커 · 이름'(받은 차례). */
export function universeOptions(rows: StockUniverseResponse["rows"] | null | undefined): { value: string; label: string }[] {
  return (rows ?? []).map((row) => ({ value: row.ticker, label: `${row.ticker} · ${row.name}` }));
}
