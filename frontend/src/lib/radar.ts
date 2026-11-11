/**
 * 수급 레이더 화면의 순수 규칙 — 소스 이름·순서, 재무 패널의 행 나누기.
 */
import type { KrFundamentalsCompany } from "./types";

/** 진단 표의 소스 이름 — 폴백 체인과 같은 이름으로. */
export const SOURCE_LABELS: Record<string, string> = {
  kis: "KIS (장중 가집계)",
  daum: "Daum",
  naver: "Naver",
  toss: "토스증권 (공식)",
};

/** 폴백 체인 순서. 표도 이 순서로 보여 줍니다. */
export const SOURCE_ORDER = ["kis", "daum", "naver", "toss"];

export function sourceLabel(name: string): string {
  return SOURCE_LABELS[name] ?? name.toUpperCase();
}

/** 진단 응답의 소스 맵을 체인 순서의 행으로. 모르는 소스는 뒤에 둡니다. */
export function sortBySourceOrder<T>(sources: Record<string, T>): ({ name: string } & T)[] {
  const rank = (name: string) => {
    const index = SOURCE_ORDER.indexOf(name);
    return index < 0 ? SOURCE_ORDER.length : index;
  };
  return Object.entries(sources)
    .map(([name, value]) => ({ name, ...value }))
    .sort((a, b) => rank(a.name) - rank(b.name));
}

/** 자료가 없는 종목은 available=false이고 나머지 칸이 비어 있는 같은 모양의 행입니다. */
export type FundamentalsRow = KrFundamentalsCompany;

/**
 * 재무 패널의 행 나누기. 재무도 시세도 없는 종목을 "—"로 가득 찬 줄로 늘어놓으면 정작 볼 줄이
 * 묻히므로, 자료가 있는 종목만 표에 두고 나머지는 한 줄로 알립니다.
 */
export function splitFundamentals(codes: readonly string[], companies: readonly KrFundamentalsCompany[]) {
  const byCode = new Map(companies.map((company) => [company.code, company]));
  const all: FundamentalsRow[] = codes.map(
    (code) => byCode.get(code) ?? ({ code, available: false } as FundamentalsRow),
  );
  const hasData = (row: FundamentalsRow) => row.available || row.marketCap != null;
  return {
    all,
    rows: all.filter(hasData),
    empty: all.filter((row) => !hasData(row)),
    covered: all.filter((row) => row.available).length,
  };
}

/**
 * 누적 이력에서 보여 줄 거래일과 행(하루치를 받는 화면, latest=true).
 *
 * - 고른 날이 없으면 응답이 알려 준 날(그 조건의 가장 최근 거래일)
 * - 조건을 바꿔도 고른 날은 그대로 둡니다. 새 조건에 그날 기록이 없으면 선택지(기록이 있는 날만)에 없으므로 앞에
 *   붙입니다 — 안 붙이면 선택 상자는 다른 날을 보이는데 표는 고른 날 기준이라, 둘이 서로 다른 날을 가리켰습니다.
 * - 행은 그날 것만, 최대 30행
 */
export function historySelection<Row extends { obsDate: string }>(
  chosen: string,
  data: { dates: string[]; obsDate?: string | null; rows: Row[] } | null | undefined,
): { dates: string[]; selectedDate: string; dateOptions: string[]; rows: Row[] } {
  const dates = data?.dates ?? [];
  const selectedDate = chosen || data?.obsDate || "";
  const dateOptions = selectedDate && !dates.includes(selectedDate) ? [selectedDate, ...dates] : dates;
  const rows = (data?.rows ?? []).filter((row) => row.obsDate === selectedDate).slice(0, 30);
  return { dates, selectedDate, dateOptions, rows };
}
