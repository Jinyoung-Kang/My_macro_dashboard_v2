/**
 * 순유동성 화면(/liquidity)의 차트 입력과 맨 위 KPI 띠 — 순수 함수(ADR 0004 규칙 3).
 *
 * 차트 입력 — 단위를 KPI 타일과 같게 맞춥니다.
 *
 * 저장본 단위는 조 달러(walclT)와 십억 달러(wtregenB·rrpB)로 서로 다릅니다. 화면 표기는 조·억으로
 * 통일하므로 십억 단위 계열은 10을 곱해 억으로 옮깁니다. 예전에는 차트만 셋 다 조 달러로 그려
 * (a) 타일은 "5.2 십억 달러", 차트는 "0.01T"로 단위가 달랐고 (b) ON RRP 실제 수준(약 0.005조)에서는
 * 눈금이 전부 "0.00T"였습니다. 모르는 값은 0이 아니라 null입니다.
 */
import { formatBillionUsd, formatTrillionDelta, formatTrillionUsd, withMinusSign } from "./format";
import type { KpiItem } from "./kpi";
import type { LiquidityResponse, LiquidityRow } from "./types";

export interface DatedValue {
  date: string;
  value: number | null;
}

export function liquidityChartSeries(rows: readonly LiquidityRow[]) {
  const billionsToEok = (value: number | null | undefined) =>
    value === null || value === undefined ? null : value * 10;
  return {
    netLiquidity: rows.map((row): DatedValue => ({ date: row.date, value: row.netLiquidityT ?? null })),
    components: {
      walcl: rows.map((row): DatedValue => ({ date: row.date, value: row.walclT ?? null })),
      tga: rows.map((row): DatedValue => ({ date: row.date, value: billionsToEok(row.wtregenB) })),
      rrp: rows.map((row): DatedValue => ({ date: row.date, value: billionsToEok(row.rrpB) })),
    },
  };
}

// ---------------------------------------------------------------- 맨 위 요약(KPI 띠)

/**
 * KPI 타일 하나 — 공용 KPI 띠의 타일 형(lib/kpi KpiItem — 정본)에서 값을 글로, 변화 칸을 늘 채우는 꼴로 좁힌 것.
 * 값을 모르면 `value`가 "—"(화면 Empty) — 0으로 채우지 않습니다.
 */
export type LiquidityKpi = KpiItem & { value: string | null; change?: { change: number | null; digits: number; unit: string; caption: string } };

/** 변화 칩에 넘기는 변화량 — 그 단위(`unit`)로 옮긴 값과 소수 자릿수. */
export type TrillionDeltaChip = { change: number; digits: number; unit: string };

/** 조·억·만 단위(lib/format formatKoreanScale과 같은 표 — 그 함수는 글만 돌려주어 여기 따로 둠). */
const SCALE: readonly (readonly [number, string])[] = [
  [1e12, "조 달러"],
  [1e8, "억 달러"],
  [1e4, "만 달러"],
  [1, "달러"],
];

/** 단위별 소수 자릿수 — formatKoreanScale의 scaleDigits와 같은 규칙(조: 1,000조 이상 정수·100조 이상 하나·그 아래 셋, 억: 1,000억 이상 정수·그 아래 하나). */
function scaleDigits(unit: number, magnitude: number): number {
  if (unit === 1e12) return magnitude >= 1e15 ? 0 : magnitude >= 1e14 ? 1 : 3;
  if (unit === 1e8) return magnitude >= 1e11 ? 0 : 1;
  return 0;
}

/**
 * 조 달러 단위 변화량 → 변화 칩 값(단위·자릿수). 단위는 formatKoreanScale·formatTrillionDelta와 같게 고릅니다 — 크기에 맞는 단위로 내려 적고(조 단위로
 * 그대로 적으면 '+0.005조 달러'가 '변화 없음'처럼 보임), 반올림이 다음 단위에 닿으면 올립니다(9,999.95억 → 1.000조). 그래서 칩 글('+47.0' + '억 달러')이
 * 예전 변화 글('+47.0억 달러')과 같은 숫자입니다. 모르는 값은 null(칩 없음).
 */
export function trillionDeltaChip(deltaT: number | null | undefined): TrillionDeltaChip | null {
  if (deltaT === null || deltaT === undefined || !Number.isFinite(deltaT)) {
    return null;
  }
  const value = deltaT * 1e12;
  const magnitude = Math.abs(value);
  let index = SCALE.findIndex(([unit]) => magnitude >= unit);
  if (index < 0) {
    index = SCALE.length - 1;
  }
  for (;;) {
    const [unit, label] = SCALE[index];
    const digits = scaleDigits(unit, magnitude);
    const rounded = Number((value / unit).toFixed(digits));
    if (index > 0 && Math.abs(rounded) >= SCALE[index - 1][0] / unit) {
      index -= 1;
      continue;
    }
    return { change: value / unit, digits, unit: label };
  }
}

/** 화면이 넘기는 환율 환산 — hooks/useUsdKrw의 같은 이름 함수(환율을 모르면 null — 그 줄을 뺌). */
export type UsdKrwConvert = {
  trillionToKrw: (value: number | null | undefined) => string | null;
  billionToKrw: (value: number | null | undefined) => string | null;
  /** 어느 환율로 언제 환산했는지(원화를 적은 화면은 늘 함께 적음). */
  note: string;
};

/** 메모 조각을 ' · '로 — 빈 조각은 뺍니다. 음수 부호는 −(QA-627). */
function memo(...parts: (string | null | undefined)[]): string | null {
  const shown = parts.filter((part): part is string => typeof part === "string" && part.trim() !== "");
  return shown.length > 0 ? withMinusSign(shown.join(" · ")) : null;
}

/**
 * 순유동성 화면 맨 위 KPI 띠 — 순유동성 · 연준 총자산 · TGA · RRP(최신 주) · 4주 변화 · 12주 변화(모멘텀). 응답에 그 묶음이 없으면 그 타일들을 두지 않습니다
 * (예전 화면이 묶음째 그리지 않던 것과 같음).
 *
 * - 순유동성: 값(조 달러), 변화 칩(전주 대비 — `trillionDeltaChip`), 메모(원화 환산 · 환율 기준), 출처 줄(FRED · 기준일).
 * - 총자산·TGA·RRP: 값과 원화 환산 메모(TGA·RRP는 해석 한 줄을 이어 붙임).
 * - 4주·12주 변화: 값(부호 −, QA-627)과 원화 환산 메모. 값 자체가 변화량이라 칩을 두지 않습니다(부호가 방향).
 * - 추정치 모드(`isEstimated`)면 모든 타일에 '추정' 배지 — 화면 위 위험 안내 상자와 함께.
 */
export function liquidityKpis(
  response: Pick<LiquidityResponse, "latest" | "momentum" | "isEstimated"> | null | undefined,
  usdKrw: UsdKrwConvert,
  source: string,
): LiquidityKpi[] {
  if (!response) {
    return [];
  }
  const estimated = Boolean(response.isEstimated);
  const items: LiquidityKpi[] = [];
  const { latest, momentum } = response;
  if (latest) {
    const chip = trillionDeltaChip(latest.deltaT);
    items.push(
      {
        key: "net",
        label: "순유동성 (Net Liquidity)",
        value: formatTrillionUsd(latest.netLiquidityT),
        change: chip ? { ...chip, caption: "전주 대비" } : undefined,
        note: memo(usdKrw.trillionToKrw(latest.netLiquidityT), usdKrw.note),
        source,
        asOf: latest.date ?? null,
        isEstimated: estimated,
      },
      {
        key: "walcl",
        label: "연준 총자산 (WALCL)",
        value: formatTrillionUsd(latest.walclT),
        note: memo(usdKrw.trillionToKrw(latest.walclT)),
        isEstimated: estimated,
      },
      {
        key: "tga",
        label: "재무부 일반계정 (TGA)",
        value: formatBillionUsd(latest.tgaB),
        note: memo(usdKrw.billionToKrw(latest.tgaB), "TGA 증가 = 시장에서 자금 흡수"),
        isEstimated: estimated,
      },
      {
        key: "rrp",
        label: "역레포 (ON RRP)",
        value: formatBillionUsd(latest.rrpB),
        note: memo(usdKrw.billionToKrw(latest.rrpB), "RRP 감소 = 시장으로 유동성 환류"),
        isEstimated: estimated,
      },
    );
  }
  if (momentum) {
    items.push(
      {
        key: "change4w",
        label: "4주 변화",
        value: withMinusSign(formatTrillionDelta(momentum.change4w)),
        note: memo(usdKrw.trillionToKrw(momentum.change4w), "유동성은 방향과 속도가 함께 중요합니다."),
        isEstimated: estimated,
      },
      {
        key: "change12w",
        label: "12주 변화",
        value: withMinusSign(formatTrillionDelta(momentum.change12w)),
        note: memo(usdKrw.trillionToKrw(momentum.change12w)),
        isEstimated: estimated,
      },
    );
  }
  return items;
}
