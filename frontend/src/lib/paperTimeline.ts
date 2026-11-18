/**
 * 모의매매 결정 로그의 시각순 목록(작업대 P6 — 명세 §7-1 '결정 로그: 종류 태그가 붙은 타임라인') 줄 모양. 화면(DecisionsSection·ReviewsSection)은 이 값을
 * 공용 시각순 목록(components/patterns Timeline)의 줄로 옮기기만 합니다(ADR 0004 — 표시 규칙은 순수 함수).
 *
 * - 결정: 거래일 묶음(머리 '거래일 YYYY-MM-DD'), 시각 열 = 결정 시각(KST 'MM-DD HH:mm' — 거래일이 묶음 머리라 연도를 빼 5.5rem 열에 들어감), 종류 태그
 *   (정기·수동·재선정일·초기 결정·출발은 중립, 장중 확인·장중 판단 n은 시계 아이콘), 요약 = 상태 배지·주문 수·목표 노출(Claude 계좌)·가격·서버 요약·오류.
 *   줄 이름(검사 칸 제목·대화상자 이름)은 '{거래일} {종류}' — 지금 결정 상세 영역 이름('… 상세')의 앞부분과 같습니다.
 * - 주간 복기: 시각 열 = 복기 주(그 주 마지막 날), 종류 태그 '주간 복기', 요약 = 상태 배지·창·판정 수·연결된 제안·안내. 줄 이름 '{주} 주 복기'(복기 한 건의 영역 이름과 같음).
 * - 값은 서버 값 그대로이고 모르는 값은 '—'(0으로 채우지 않음). 차례는 서버 차례(최근이 위).
 */
import { EMPTY, formatKst, formatWithUnit } from "./format";
import {
  type Badge,
  decisionKindLabel,
  decisionOrdersText,
  decisionStatusBadge,
  isIntradayKind,
  pricesFinalText,
  type ReviewRow,
  reviewRows,
  storedText,
} from "./paper";
import { krDecisionKindLabel, krPricesFinalText } from "./paperKr";
import type { PaperMarketCode } from "./paperMarket";
import type { PaperDecisionSummary, PaperReviewSummary } from "./types";

/** 묶음 머리 — 이어진 같은 key의 줄이 한 묶음(components/patterns MasterDetailGroup과 같은 모양). */
export interface PaperTimelineGroup {
  key: string;
  label: string;
  /** 기계가 읽는 날짜(YYYY-MM-DD) — 날짜 꼴이 아니면 없음. */
  dateTime?: string;
}

/** 결정 목록의 줄 하나(표시 문자열). */
export interface DecisionTimelineRow {
  /** 줄 키 = 결정 번호(문자열 — 목록-검사 data-item-key). */
  key: string;
  id: number;
  /** 시각 열 — 결정 시각 'MM-DD HH:mm'(KST). 모르면 '—'. */
  at: string;
  /** 결정 시각 ISO(+09:00) — 읽지 못하면 없음. */
  dateTime?: string;
  /** 종류 이름(한국 출발은 '출발(초기 결정)'). */
  kind: string;
  /** 장중 확인·장중 판단 n — 종류 태그에 시계 아이콘. */
  intraday: boolean;
  /** 검사 칸 제목·대화상자 이름 '{거래일} {종류}'. */
  title: string;
  /** 거래일 묶음. 거래일이 비면 null(묶음 없이). */
  group: PaperTimelineGroup | null;
  status: Badge;
  /** 주문 수 — '2건'·'2건 · 거절 1', 모르면 '—'. */
  orders: string;
  /** 목표 노출(Claude 계좌만 — '35.0%', 모르면 '—'). 규칙 계좌는 null(늘 비는 값이라 줄에 두지 않음). */
  exposure: string | null;
  /** 가격 — 확정 종가·확정 전 값(주의색)·한국 잠정(토스)·모르면 '—'. */
  price: { label: string; className: string; title?: string };
  /** 서버 요약 — 없으면 null(줄에는 '—'). */
  summary: string | null;
  /** 저장된 오류 문장 — 없으면 null. */
  error: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KST_MINUTE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;

/** 결정 시각 → 시각 열 글('MM-DD HH:mm')과 ISO. KST 문장 꼴이 아니면 formatKst 글 그대로(ISO 없음). */
export function decisionTimeCell(decidedAtKst: string | null | undefined): { at: string; dateTime?: string } {
  const text = formatKst(decidedAtKst);
  const match = KST_MINUTE.exec(text);
  if (!match) return { at: text || EMPTY };
  const [, year, month, day, hour, minute] = match;
  return { at: `${month}-${day} ${hour}:${minute}`, dateTime: `${year}-${month}-${day}T${hour}:${minute}+09:00` };
}

/** 거래일 묶음 머리. 거래일이 비면 null. */
export function tradingDayGroup(date: string | null | undefined): PaperTimelineGroup | null {
  if (!date) return null;
  return { key: date, label: `거래일 ${date}`, dateTime: DATE.test(date) ? date : undefined };
}

/**
 * 결정 목록(서버 차례 — 최근 순) → 시각순 목록 줄. `showExposure`는 Claude 계좌(목표 노출 칸이 있던 계좌)일 때 참입니다. 한국은 종류·가격 글이 한국 것
 * (출발(초기 결정)·잠정(토스))입니다.
 */
export function decisionTimelineEntries(
  rows: readonly PaperDecisionSummary[],
  { market, showExposure }: { market: PaperMarketCode; showExposure: boolean },
): DecisionTimelineRow[] {
  const korea = market === "KR";
  return rows.map((row) => {
    const kind = korea ? krDecisionKindLabel(row.kind) : decisionKindLabel(row.kind);
    const price: { label: string; className: string; title?: string } = korea ? krPricesFinalText(row.pricesFinal) : pricesFinalText(row.pricesFinal);
    return {
      key: String(row.id),
      id: row.id,
      ...decisionTimeCell(row.decidedAtKst),
      kind,
      intraday: row.kind === "CHECKPOINT" || isIntradayKind(row.kind),
      title: `${row.asOfTradingDate} ${kind}`,
      group: tradingDayGroup(row.asOfTradingDate),
      status: decisionStatusBadge(row.status, row.kind),
      orders: decisionOrdersText(row),
      exposure: showExposure ? formatWithUnit(row.targetExposurePct, 1, "%") : null,
      price,
      summary: row.summary ? row.summary : null,
      error: storedText(row.error),
    };
  });
}

/** 주간 복기 목록의 줄 하나 — 복기 표 줄(lib/paper ReviewRow)에 시각 열·이름을 더함. */
export interface ReviewTimelineRow extends ReviewRow {
  /** 시각 열 — 복기 주(YYYY-MM-DD). */
  at: string;
  dateTime?: string;
  /** 검사 칸 제목·대화상자 이름 '{주} 주 복기'(복기 한 건 영역 이름과 같음). */
  title: string;
}

/** 복기 목록(서버 차례 — 주 최근 순) → 시각순 목록 줄. 값은 복기 표 줄(reviewRows) 그대로입니다. */
export function reviewTimelineEntries(reviews: readonly PaperReviewSummary[]): ReviewTimelineRow[] {
  return reviewRows(reviews).map((row) => ({
    ...row,
    at: row.weekEnding || EMPTY,
    dateTime: DATE.test(row.weekEnding) ? row.weekEnding : undefined,
    title: `${row.weekEnding} 주 복기`,
  }));
}
