/**
 * 교집합 화면(/consensus)의 거르기 목록·KPI 띠·검사 칸 규칙 — React 없이 시험합니다(ADR 0004 규칙 3).
 *
 * 증권 구분자(CUSIP·발행사)와 막대 이름표는 상세 화면도 쓰는 lib/consensus가 정하고, 여기는 이 화면의 배치에만 쓰는 줄을 만듭니다.
 * 값을 모르면 null(화면 "—") — 0으로 채우지 않습니다.
 */
import { securityNote } from "./consensus";
import type { DetailProperty } from "./detailEntity";
import { EMPTY, formatNumber, formatUsd, formatWeightPercent } from "./format";
import { filerName, filerShortName } from "./holdings";
import type { KpiItem } from "./kpi";
import type { ConsensusResponse, ConsensusRow, NewBuysResponse } from "./types";

/** 거르기 목록 줄 하나 — components/patterns `FilterListItem`과 같은 꼴(lib는 components를 가져오지 않음 — ADR 0004). */
export type FilterChoice = { key: string; label: string };

/** 원화 병기 — 공용 환율 훅(useUsdKrw)의 환산 함수와 환율 문구를 그대로 넘깁니다(환율을 모르면 환산은 null). */
export type KrwNote = { toKrw: (usd: number | null | undefined) => string | null; note: string };

/** 신규 매수 줄 하나(응답 형). */
export type NewBuyRow = NewBuysResponse["rows"][number];

/** 기관 표시 이름 — 국기를 뗀 이름, 비면 'CIK …'(교집합 기관 단추·스타일 화면과 같은 규칙). */
function institutionLabel(entry: { cik: string; name: string }): string {
  return filerName(entry.name) ?? `CIK ${entry.cik}`;
}

/** '분석 대상' 거르기 목록의 줄 — 키는 CIK(요청 ciks와 같은 값), 이름은 국기를 뗀 이름. 받은 차례 그대로입니다. */
export function institutionChoices(institutions: readonly { cik: string; name: string }[] | null | undefined): FilterChoice[] {
  return (institutions ?? []).map((entry) => ({ key: entry.cik, label: institutionLabel(entry) }));
}

/** '분석 대상' 패널 머리의 개수 — 'n곳 / m곳'(고른 수 / 전체). 기관 목록을 아직 모르거나 비었으면 null(개수를 적지 않음 — '0곳'으로 지어내지 않음). */
export function selectionCountText(selected: number, total: number): string | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  return `${selected.toLocaleString("ko-KR")}곳 / ${total.toLocaleString("ko-KR")}곳`;
}

/** 개수 서식(정수, 천 단위 쉼표). */
const COUNT = (value: number) => formatNumber(value, 0);

/**
 * '교집합 기준 분기' 타일 — 응답에 기준 분기가 없으면 각 기관이 자기 최신 분기로 참여한 것(판정 글 — 숫자가 아님). 타일 이름을 '기준 분기'로만 두면
 * 타일 묶음(role=group)의 이름이 왼쪽 칸 고르기 상자 '기준 분기'와 같아 같은 이름의 조작이 둘이 됩니다(낭독기·이름으로 찾기 모두).
 */
const LATEST_LABEL = "각 기관 최신";
const REPORT_DATE_LABEL = "교집합 기준 분기";

/**
 * 교집합 요약 KPI 띠 — 참여 기관 수·교집합 종목 수·교집합 기준 분기. 출처 줄은 첫 타일에만 둡니다(띠 전체가 같은 13F 공시 — 순유동성·섹터 띠와 같은 규칙).
 * 참여 기관 수를 모르면(숫자가 아님) "—", 종목 수는 받은 행 수입니다.
 */
export function consensusKpis(data: Pick<ConsensusResponse, "participantCount" | "rows" | "reportDate">, source: string): KpiItem[] {
  const participants = typeof data.participantCount === "number" && Number.isFinite(data.participantCount) ? data.participantCount : null;
  const reportDate = data.reportDate?.trim() ? data.reportDate.trim() : null;
  return [
    { key: "participants", label: "참여 기관", value: participants, format: COUNT, unit: "곳", source },
    { key: "rows", label: "교집합 종목", value: (data.rows ?? []).length, format: COUNT, unit: "개" },
    reportDate
      ? { key: "reportDate", label: REPORT_DATE_LABEL, value: reportDate }
      : { key: "reportDate", label: REPORT_DATE_LABEL, value: LATEST_LABEL, valueKind: "label" },
  ];
}

/**
 * 처음 읽는 동안의 KPI 띠 — 같은 세 타일의 자리표시(값이 온 뒤 띠가 끼어들어 아래가 밀리지 않게). 첫 타일은 값이 온 뒤와 같은 출처 글을 받아
 * (띠가 pendingMatchesValue로 그림) 같은 높이의 출처 줄을 둡니다(섹터 띠와 같은 규칙).
 */
export function consensusKpisPending(source: string): KpiItem[] {
  return [
    { key: "participants", label: "참여 기관", value: null, pending: true, source },
    { key: "rows", label: "교집합 종목", value: null, pending: true },
    { key: "reportDate", label: REPORT_DATE_LABEL, value: null, pending: true },
  ];
}

/**
 * 줄 이름표(검사 칸 제목·대화상자 이름) — 키는 행 키. 이름이 겹치는 줄(같은 이름의 다른 ETF, 클래스 표기가 갈린 A·C주 — QA-114)에만 ' · {증권 구분}'
 * (CUSIP, 합친 행은 발행사)을 붙이고, 그래도 겹치면 ' · {행 키}'. 겹치지 않는 이름은 그대로입니다.
 */
export function securityTitles(rows: readonly { key: string; name: string; cusip?: string | null }[]): Map<string, string> {
  const counts = new Map<string, number>();
  rows.forEach((row) => counts.set(row.name, (counts.get(row.name) ?? 0) + 1));
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const row of rows) {
    const note = securityNote(row);
    let label = (counts.get(row.name) ?? 0) > 1 && note ? `${row.name} · ${note}` : row.name;
    if (used.has(label)) label = `${label} · ${row.key}`;
    used.add(label);
    out.set(row.key, label);
  }
  return out;
}

/** 글 값 — 비었거나 "—"면 null(화면이 "—"를 그림). */
function present(text: string | null | undefined): string | null {
  const trimmed = (text ?? "").trim();
  return trimmed && trimmed !== EMPTY ? trimmed : null;
}

/** 기관 수 글 — 'n곳'. 숫자가 아니면 null. */
function placeCount(value: number | null | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) ? `${formatNumber(value, 0)}곳` : null;
}

/** 합산 평가액과 원화 환산 두 줄 — 원화 줄의 보조 글은 환율 문구(어느 환율로 언제 — 원화를 적는 화면은 늘 함께 적음). */
function valueItems(total: number | null | undefined, krw: KrwNote): DetailProperty[] {
  return [
    { label: "합산 평가액", value: present(formatUsd(total)) },
    { label: "원화 환산", value: krw.toKrw(total), note: krw.note },
  ];
}

/**
 * 교집합 줄 하나의 속성(검사 칸) — 공시 이름·증권 구분·보유 기관 수·동시 매수·동시 매도(기관 수 — 등락이 아니라 개수, QA-703)·평균·최대 비중·
 * 합산 평가액·원화 환산. 동시 매수·매도의 보조 글은 백엔드가 세는 규칙(Sec13FService — 직전 분기 대비 동작이 신규 매수·비중 확대면 매수, 비중 축소·
 * 전량 매도면 매도)입니다. 보유 기관 목록은 화면이 배지로 따로 그립니다.
 */
export function consensusRowItems(row: ConsensusRow, krw: KrwNote): DetailProperty[] {
  return [
    { label: "공시 이름", value: present(row.name) },
    { label: "증권 구분", value: present(securityNote(row)) },
    { label: "보유 기관 수", value: placeCount(row.holderCount) },
    { label: "동시 매수", value: placeCount(row.buyCount), note: "직전 분기보다 새로 사거나(신규 매수) 늘린(비중 확대) 기관 수" },
    { label: "동시 매도", value: placeCount(row.sellCount), note: "직전 분기보다 줄이거나(비중 축소) 모두 판(전량 매도) 기관 수" },
    { label: "평균 비중", value: present(formatWeightPercent(row.avgWeight)) },
    { label: "최대 비중", value: present(formatWeightPercent(row.maxWeight)) },
    ...valueItems(row.totalValue, krw),
  ];
}

/** 공통 신규 매수 줄 하나의 속성(검사 칸) — 공시 이름·증권 구분·새로 담은 기관 수·평균 비중·합산 평가액·원화 환산·기준 분기. 기관 목록은 배지로 따로. */
export function newBuyRowItems(row: NewBuyRow, krw: KrwNote): DetailProperty[] {
  return [
    { label: "공시 이름", value: present(row.name) },
    { label: "증권 구분", value: present(securityNote(row)) },
    { label: "새로 담은 기관 수", value: placeCount(row.buyerCount) },
    { label: "평균 비중", value: present(formatWeightPercent(row.avgWeight)) },
    ...valueItems(row.totalValue, krw),
    { label: "기준 분기", value: present(row.reportDate) },
  ];
}

/** 기관 배지 — 짧은 이름(국기를 뗀 첫 낱말 — lib/holdings filerShortName)과 전체 이름(국기를 뗀 이름 — 마우스 설명). 받은 차례 그대로, 키는 받은 이름. */
export function filerBadges(names: readonly string[]): { key: string; short: string; full: string }[] {
  return names.map((name) => ({ key: name, short: filerShortName(name), full: filerName(name) ?? name }));
}

/** 참여 기관 줄 — '참여 기관: A, B'(국기를 뗀 이름). 없으면 '참여 기관: —'. */
export function participantsLine(participants: readonly string[] | null | undefined): string {
  const names = (participants ?? []).map((name) => filerName(name) ?? name);
  return `참여 기관: ${names.join(", ") || EMPTY}`;
}
