/**
 * 13F 포트폴리오 화면(/institutions)의 화면 모델 — 기관 목록 줄·비중 추이 선 이름표·보유 표 줄 키를 만드는 React를 모르는 순수 함수(ADR 0004 규칙 3).
 * 값이 없으면 null(화면은 "—"), 0으로 채우지 않습니다.
 */
import { distinctLabels } from "./chartAxis";
import { filerName } from "./holdings";
import type { Holding } from "./types/institution";

/** 기관 목록 API(/api/sec13f/institutions)의 줄 하나 — 이 화면이 쓰는 칸만. */
export type InstitutionEntry = { key: string; name: string; cik: string; desc: string };

/** 기관 목록 줄(고르기) — 키는 CIK, 이름은 국기를 뗀 이름(이름이 비면 'CIK …' — 지어내지 않음), 설명은 받은 글 그대로. */
export type InstitutionItem = { key: string; label: string; desc: string };

/** 기관 목록 줄 — 받은 차례 그대로. 목록을 받기 전이면 빈 목록. */
export function institutionItems(list: readonly InstitutionEntry[] | null | undefined): InstitutionItem[] {
  return (list ?? []).map((entry) => ({ key: entry.cik, label: filerName(entry.name) ?? `CIK ${entry.cik}`, desc: entry.desc }));
}

/** 비중 추이 선 이름표 폭 — 예전 '앞 18자 + …'와 같은 폭입니다. 구분자가 붙은 이름표는 구분자만큼 더 길 수 있습니다. */
export const WEIGHT_LINE_LABEL_WIDTH = 19;

/** 비중 추이 선 하나 — 응답 series 키(그대로 데이터 키)·범례와 툴팁 이름표·선 색. */
export type WeightLine = { key: string; name: string; color: string };

/**
 * 비중 추이 선(상위 10줄) — 키 차례는 응답 그대로, 색은 받은 색 목록을 차례대로 돌려 씁니다(색 상수는 화면 파일 — 팔레트 기록이 그 자리를 읽음).
 * 이름표는 키 뒤의 구분자(' · 클래스', ' · CUSIP …')를 남기고 이름 쪽을 줄입니다 — 앞에서 자르면 같은 이름의 두 줄이 같은 이름표가 됩니다(QA-120).
 */
export function weightLines(series: Readonly<Record<string, unknown>> | null | undefined, colors: readonly string[]): WeightLine[] {
  const keys = Object.keys(series ?? {}).slice(0, 10);
  const labels = distinctLabels(keys, WEIGHT_LINE_LABEL_WIDTH);
  return keys.map((key, index) => ({ key, name: labels[index], color: colors[index % colors.length] }));
}

/**
 * 보유 표 줄 키 — 'CUSIP:클래스'(기관 상세 보유 줄·목록-검사 줄과 같은 키). 같은 키가 또 나오면 두 번째부터 '#2'·'#3' 꼬리를 붙여 서로 다르게 둡니다
 * (QA 자료 12기관은 중복 0 — 응답이 바뀌어도 React 키·고른 줄이 겹치지 않게). 줄 차례 그대로입니다.
 */
export function holdingRowKeys(holdings: readonly Pick<Holding, "cusip" | "class">[]): string[] {
  const seen = new Map<string, number>();
  return holdings.map((holding) => {
    const base = `${holding.cusip}:${holding.class}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}#${count}`;
  });
}
