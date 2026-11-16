/**
 * 섹터 화면(/sector)의 KPI 띠·검사 칸 규칙 — React 없이 시험합니다(ADR 0004 규칙 3).
 */
import { formatSignedMinus } from "./format";
import type { SectorResponse, SectorRow } from "./types";

/** 기간 열 차례 — 응답 `periods`가 없을 때의 기본(백엔드 섹터 로테이션과 같은 여섯). */
export const SECTOR_PERIODS = ["1W", "1M", "3M", "6M", "YTD", "1Y"] as const;

/**
 * KPI 타일 하나 — components/patterns `KpiItem`과 같은 모양(lib는 components를 가져오지 않으므로 여기 따로 적음 — lib/home `HomeKpi`와 같은 규칙).
 * 값을 모르면 `value: null`(화면 "—") — 0으로 채우지 않습니다.
 */
export type SectorKpi = {
  key: string;
  label: string;
  value: number | null;
  format: (value: number) => string;
  source?: string | null;
};

/** 부호 있는 수익률 글(소수 둘째 자리 + '%') — 양수 '+', 음수 −(U+2212), 0은 부호 없이. 단위를 따로 띄우지 않고 숫자에 붙입니다(변화 칩의 변화율과 같은 꼴). */
export function signedPercentText(value: number): string {
  return `${formatSignedMinus(value, 2).text}%`;
}

/**
 * 섹터 화면 맨 위 KPI 띠 — 벤치마크(S&P 500 — 응답 `benchmark`, 보통 SPY)의 기간별 수익률(응답 `benchmarkReturns` — 새 요청 없음). 섹터 표의
 * α(초과성과 = 섹터 수익률 − 벤치마크 수익률)를 읽는 기준이 화면에 보입니다. 기간 차례는 응답 `periods`(없으면 기본 여섯), 모르는 기간은 "—".
 * 출처 줄은 첫 타일에만 둡니다 — 띠 전체가 같은 저장본(ETF 일별 종가)이라 같은 긴 글을 여섯 번 되풀이하지 않습니다(순유동성 띠와 같은 규칙).
 */
export function sectorKpis(
  response: Pick<SectorResponse, "benchmark" | "benchmarkReturns" | "periods"> | null | undefined,
  source: string,
): SectorKpi[] {
  if (!response) {
    return [];
  }
  const benchmark = response.benchmark?.trim() ? response.benchmark : "SPY";
  const periods = response.periods?.length ? response.periods : [...SECTOR_PERIODS];
  return periods.map((period, index) => {
    const value = response.benchmarkReturns?.[period];
    return {
      key: period,
      label: `S&P 500 (${benchmark}) ${period}`,
      value: typeof value === "number" && Number.isFinite(value) ? value : null,
      format: signedPercentText,
      ...(index === 0 ? { source } : {}),
    };
  });
}

/** 검사 칸 제목 — '정보기술 (XLK)'. 표에 없는 티커면 null(자료에서 사라진 키 — 검사 칸 틀이 그 사실을 적음). */
export function sectorRowTitle(rows: readonly SectorRow[], ticker: string): string | null {
  const row = rows.find((entry) => entry.ticker === ticker);
  return row ? `${row.name} (${row.ticker})` : null;
}
