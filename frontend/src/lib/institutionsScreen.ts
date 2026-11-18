/**
 * 13F 포트폴리오 화면(/institutions)의 화면 모델 — 기관 목록 줄·고른 기관 요약 KPI·비중 추이 선 이름표·보유 표 줄 키를 만드는 React를 모르는 순수 함수
 * (ADR 0004 규칙 3). 값이 없으면 null(화면은 "—"), 0으로 채우지 않습니다.
 */
import { distinctLabels } from "./chartAxis";
import { type DetailProperty, holdingDetailItems, holdingItemLabels } from "./detailEntity";
import { EMPTY, formatKoreanScale, formatNumber } from "./format";
import { filerName } from "./holdings";
import type { KpiItem } from "./kpi";
import { presentText } from "./patterns";
import type { Holding, PortfolioResponse } from "./types/institution";

/** 기관 목록 API(/api/sec13f/institutions)의 줄 하나 — 이 화면이 쓰는 칸만. */
export type InstitutionEntry = { key: string; name: string; cik: string; desc: string };

/** 기관 목록 줄(고르기) — 키는 CIK, 이름은 국기를 뗀 이름(이름이 비면 'CIK …' — 지어내지 않음), 설명은 받은 글 그대로. */
export type InstitutionItem = { key: string; label: string; desc: string };

/** 기관 목록 줄 — 받은 차례 그대로. 목록을 받기 전이면 빈 목록. */
export function institutionItems(list: readonly InstitutionEntry[] | null | undefined): InstitutionItem[] {
  return (list ?? []).map((entry) => ({ key: entry.cik, label: filerName(entry.name) ?? `CIK ${entry.cik}`, desc: entry.desc }));
}

/**
 * 고른 기관 패널의 제목 — 기관 목록의 이름(국기를 뗌), 목록을 아직 못 받았거나 없는 기관이면 포트폴리오 응답의 기관 이름, 그것도 없으면 'CIK …'
 * (이름을 지어내지 않음). 같은 백엔드 기관 표의 이름이라 새 요청이 없습니다.
 */
export function institutionTitle(
  items: readonly InstitutionItem[],
  cik: string,
  portfolio: Pick<PortfolioResponse, "institution"> | null | undefined,
): string {
  return items.find((item) => item.key === cik)?.label ?? filerName(portfolio?.institution?.name) ?? `CIK ${cik}`;
}

/** 요약 KPI 띠 첫 타일의 출처 줄 — 기관 상세 보유 종목 패널과 같은 글. */
export const PORTFOLIO_SOURCE = "SEC EDGAR 13F";

/** 원화 환산(공용 환율 훅 useUsdKrw의 두 칸) — 환율을 모르면 toKrw가 null, note는 그 사실을 적은 글. */
export type KrwConversion = { toKrw: (usd: number | null | undefined) => string | null; note: string };

/**
 * 고른 기관의 포트폴리오 요약 KPI 띠 — 최신 공시 기준일(보조 '제출일 …') · 포트폴리오 총액(값 '…억' + 단위 '달러', 보조 '약 …원 · 원/달러 … 기준 · 시각' — 환율을 모르면 그
 * 사실 한 줄) · 수집된 분기(n개, 보조 = 분기 기준일 목록). 예전 지표 칸 셋과 같은 값·글입니다. 출처 줄은 첫 타일에만 둡니다 — 띠 전체가 같은 13F
 * 저장본이라 같은 글을 세 번 되풀이하지 않습니다(순유동성·섹터 띠와 같은 규칙). 응답이 없으면 빈 목록.
 */
export function portfolioKpis(
  data: Pick<PortfolioResponse, "latest" | "quarters"> | null | undefined,
  krw: KrwConversion,
  source: string,
): KpiItem[] {
  if (!data) {
    return [];
  }
  const latest = data.latest ?? null;
  const total = typeof latest?.totalValue === "number" && Number.isFinite(latest.totalValue) ? latest.totalValue : null;
  const quarters = data.quarters ?? [];
  return [
    {
      key: "reportDate",
      label: "최신 공시 기준일",
      value: presentText(latest?.reportDate),
      note: `제출일 ${presentText(latest?.filingDate) ?? EMPTY}`,
      source,
    },
    {
      key: "totalValue",
      label: "포트폴리오 총액",
      value: total,
      // 값 글은 조·억 단위 숫자('2,993억'), 통화는 단위 칸('달러') — 예전 formatCurrency 글('2,993억 달러')과 같은 글자입니다. 통화를 값 글에 두면
      // 좁은 타일(1024 — 타일 안쪽 약 131px)에서 '2,993억 달' / '러'처럼 낱말 안에서 꺾였습니다(타일의 wrap-anywhere). 단위 칸은 값의 마지막 글자와
      // 한 묶음이라 홀로 다음 줄로 가지 않습니다(공용 KPI 띠).
      format: usdScaleNumber,
      unit: "달러",
      // 달러 금액은 크기가 잘 안 잡혀 매크로 화면이 수집한 같은 원/달러로 환산해 함께 적습니다(환율을 모르면 환산 없이 그 사실만).
      note: [total === null ? null : krw.toKrw(total), krw.note].filter((text): text is string => Boolean(text)).join(" · "),
    },
    {
      key: "quarters",
      label: "수집된 분기",
      value: quarters.length,
      format: (value) => formatNumber(value, 0),
      unit: "개",
      note: quarters.map((quarter) => quarter.reportDate).join(", ") || null,
    },
  ];
}

/** 달러 금액의 조·억·만 단위 숫자 글(통화 없이 — formatCurrency의 '… 달러'에서 통화를 뺀 것). */
function usdScaleNumber(value: number): string {
  return formatKoreanScale(value, "").trim();
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

/**
 * 보유 표 줄 이름표(검사 칸 제목·대화상자 이름·줄 단추 이름) — 키는 `holdingRowKeys`의 줄 키. 기관 상세 보유 줄과 같은 규칙(lib/detailEntity
 * holdingItemLabels — 공시 이름이 겹치는 줄에만 ' · 클래스'·' · CUSIP …')이고, 'CUSIP:클래스'까지 같은 줄('#n' 꼬리 키)은 그 꼬리를 이름표에도 붙여
 * 서로 다르게 둡니다(QA 자료는 중복 0).
 */
export function holdingRowLabels(holdings: readonly Pick<Holding, "name" | "cusip" | "class">[]): Map<string, string> {
  const base = holdingItemLabels(holdings);
  const keys = holdingRowKeys(holdings);
  const out = new Map<string, string>();
  holdings.forEach((holding, index) => {
    const key = keys[index];
    const label = base.get(`${holding.cusip}:${holding.class}`) ?? holding.name;
    const tail = key.slice(`${holding.cusip}:${holding.class}`.length);
    out.set(key, tail ? `${label} ${tail}` : label);
  });
  return out;
}

/**
 * 보유 줄 검사 칸의 속성 — 기관 상세 보유 종목 검사 칸과 같은 줄(공시 이름·클래스·CUSIP·비중·평가액·주식 수·주식 수 변화·비중 변화·동작 — lib/detailEntity
 * holdingDetailItems)에 '원화 환산'(평가액을 화면이 받은 같은 원/달러로 — 환율·평가액을 모르면 "—", 보조 글은 환율 문구)을 평가액 다음에 더합니다.
 */
export function holdingInspectorItems(holding: Holding, krw: KrwConversion): DetailProperty[] {
  const items = holdingDetailItems(holding);
  const at = items.findIndex((item) => item.label === "평가액");
  const krwItem: DetailProperty = { label: "원화 환산", value: krw.toKrw(holding.value), note: krw.note };
  return at < 0 ? [...items, krwItem] : [...items.slice(0, at + 1), krwItem, ...items.slice(at + 1)];
}
