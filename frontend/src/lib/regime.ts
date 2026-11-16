/**
 * 국면 판정 기록의 표기 — React를 모르는 순수 함수(ADR 0004).
 *
 * 판정 근거 네 개를 한 줄로 적습니다. 단위는 화면의 다른 곳과 같게: 금리차·하이일드는 %p,
 * NFCI는 단위 없는 지수, 순유동성 변화는 조·억 달러(PRINCIPLES "한국식 단위").
 * 값을 모르는 입력은 "—"로 둡니다 — 0으로 채우지 않습니다.
 * 음수 글자는 −(U+2212)입니다 — 홈 국면 패널(lib/home regimeHeroModel, QA-600)·변화 칩과 같은 글자(명세 D4, QA-636).
 */
import { EMPTY, formatNumber, formatSignedMinus, formatTrillionDelta, withMinusSign } from "./format";
import type { RegimeLogEntry, RegimeLogInput, RegimeResponse, TrackRecordCell } from "./types";

const ORDER = [
  { key: "curve10y3m", label: "10Y-3M", format: (v: number) => `${formatSignedMinus(v, 2).text}%p` },
  { key: "nfci", label: "NFCI", format: (v: number) => formatSignedMinus(v, 2).text },
  // 하이일드 스프레드는 늘 양수라 부호(+)를 붙이지 않습니다 — 음수가 오면 −로.
  { key: "hyOas", label: "하이일드", format: (v: number) => `${withMinusSign(formatNumber(v, 2))}%p` },
  { key: "liquidity4w", label: "순유동성 4주", format: (v: number) => withMinusSign(formatTrillionDelta(v)) },
] as const;

/** 부호 붙은 값 — 양수 '+', 음수 '−'(U+2212), 반올림해 0이면 부호 없음, 모르면 '—'. 뒤에 단위(%·%p)를 붙입니다. */
function signedText(value: number | null | undefined, suffix: string): string {
  return value === null || value === undefined || !Number.isFinite(value) ? EMPTY : `${formatSignedMinus(value, 2).text}${suffix}`;
}

/** "2026-10-08" → "10-08". 형식이 다르면 그대로. */
function shortDate(value: string | null | undefined): string {
  return value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(5, 10) : (value ?? EMPTY);
}

/** 판정 근거를 표시 순서대로: [{label, value, asOf, asOfDate}] — asOf는 월-일로 줄인 글, asOfDate는 받은 기준일 그대로(모르면 null). */
export function regimeInputCells(inputs: RegimeLogEntry["inputs"]) {
  return ORDER.map(({ key, label, format }) => {
    const input: RegimeLogInput | undefined = inputs?.[key];
    const value = input?.value;
    return {
      key,
      label,
      value: value === null || value === undefined || !Number.isFinite(value) ? EMPTY : format(value),
      asOf: input?.asOf ? shortDate(input.asOf) : EMPTY,
      asOfDate: input?.asOf ?? null,
    };
  });
}

/**
 * 판정 기록 한 건의 한 줄 요약(타임라인 줄)의 마디 — 근거 넷을 '이름 값'으로(모르는 값은 —), 판정하지 못한 날은 사유 수를 덧붙입니다. 화면은 마디를
 * ' · '로 잇고 마디 안에서는 줄을 바꾸지 않습니다('하이일드 / 3.43%p'처럼 이름과 값이 갈리지 않게). 사유는 받지 못한 입력만이 아니라 오래된 입력
 * ('입력 오래됨: …')도 있어 '판정 불가 사유'라 부릅니다(백엔드 regime_log의 missing). 기준일·사유 글·규칙 판은 검사 칸에 둡니다.
 */
export function regimeLogSummaryParts(entry: Pick<RegimeLogEntry, "inputs" | "missing">): string[] {
  const parts = regimeInputCells(entry.inputs).map((cell) => `${cell.label} ${cell.value}`);
  const reasons = (entry.missing ?? []).length;
  if (reasons > 0) parts.push(`판정 불가 사유 ${reasons}`);
  return parts;
}

/**
 * 판정 성과 표의 한 줄(국면 × 기간)을 화면 문자열로.
 *
 * 표본이 부족하면 수익률 칸에 숫자 대신 "표본 부족"을 적습니다 — 몇 개 안 되는 수익률의 평균은 우연이라,
 * 숫자를 보여 주는 순간 신호처럼 읽힙니다. 표본 수와 겹치지 않는 표본 수는 언제나 적습니다.
 */
export function trackRecordRow(cell: TrackRecordCell, base: TrackRecordCell | undefined) {
  const samples = `${cell.count}건 · 독립 ${cell.independent}`;
  if (!cell.sufficient) {
    return {
      horizon: `${cell.horizonWeeks}주 뒤`,
      samples,
      sufficient: false,
      mean: "표본 부족",
      median: EMPTY,
      winRate: EMPTY,
      excess: EMPTY,
      baseline: baselineText(base),
    };
  }
  return {
    horizon: `${cell.horizonWeeks}주 뒤`,
    samples,
    sufficient: true,
    mean: signedText(cell.mean, "%"),
    median: signedText(cell.median, "%"),
    winRate: cell.winRate === null ? EMPTY : `${formatNumber(cell.winRate, 0)}%`,
    excess: signedText(cell.excessMean, "%p"),
    baseline: baselineText(base),
  };
}

function baselineText(base: TrackRecordCell | undefined): string {
  if (!base || base.mean === null) return EMPTY;
  const win = base.winRate === null ? EMPTY : `${formatNumber(base.winRate, 0)}% 상승`;
  return `${signedText(base.mean, "%")} · ${win}`;
}

/**
 * 국면 이력 띠의 이름(그림 하나 — role=img) — 기간·주간 판정 수·구간 수만 말하고 자세한 구간은 아래 표에 맡깁니다(QA-635). 띠의 칸 수백 개를
 * 하나씩 읽히지 않습니다. 재현 점이 없으면 null(띠를 그리지 않음).
 */
export function regimeBandLabel(timeline: RegimeResponse["timeline"], episodeCount: number): string | null {
  const points = timeline ?? [];
  if (points.length === 0) return null;
  const first = points[0].date;
  const last = points[points.length - 1].date;
  return `국면 이력 띠 — ${first} ~ ${last}, 주간 판정 ${points.length}번·구간 ${episodeCount}개(최근 구간은 아래 표)`;
}

/** 국면 범주의 톤 — 공용 태그(Tag)의 의도 셋과 중립. */
export type RegimeTone = "ok" | "warn" | "danger" | "neutral";
/** 국면 범주의 아이콘 이름 — 화면이 아이콘 부품으로 바꿉니다(이 모듈은 React를 모름). */
export type RegimeIcon = "check" | "alert" | "info" | "unknown";

/**
 * 국면 범주의 톤과 아이콘(D1 결정 거리 3 — '상태색은 늘 아이콘 + 글'을 국면 범주색에도, 권장안). 색만으로 국면을 가르지 않게 네 국면과 판정 불가가
 * 모두 아이콘과 글(국면 이름)을 함께 씁니다 — 사분면·이력 띠 범례·판정 기록·판정 성과의 국면 태그가 이 규칙 하나를 씁니다.
 *
 * - 확장: 정상(체크) · 후퇴 경계: 주의(삼각) · 침체 경계: 위험(삼각 — 공용 태그가 낭독기에 '주의:'를 먼저 읽힘)
 * - 회복: 중립(안내 아이콘 — 강조 파랑은 누를 수 있는 것에만, 원칙 A1) · 판정 불가와 모르는 코드: 중립(점선 원)
 */
export function regimeTone(code: string | null | undefined): { tone: RegimeTone; icon: RegimeIcon } {
  switch (code) {
    case "EXPANSION":
      return { tone: "ok", icon: "check" };
    case "LATE":
      return { tone: "warn", icon: "alert" };
    case "CONTRACTION":
      return { tone: "danger", icon: "alert" };
    case "RECOVERY":
      return { tone: "neutral", icon: "info" };
    default:
      return { tone: "neutral", icon: "unknown" };
  }
}
