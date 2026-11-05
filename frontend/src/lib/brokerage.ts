/**
 * 토스증권 실제 계좌 탭(읽기 전용, ADR 0025 — docs/specs/2026-11-05-toss-account-readonly.md §5)의 표기 — React를 모르는 순수 함수(ADR 0004).
 *
 * 모의 장부와 별개 기능입니다. 이 파일은 lib/format·lib/paperMarket(시장별 자릿수·단위)과 응답 계약 lib/types/brokerage만 가져오고,
 * 모의·홈 모듈은 이 파일을 가져오지 않습니다(components/screens/brokerage/__tests__/brokerageBoundary.test.ts). 숫자는 백엔드가 보낸
 * 값 그대로 찍고(이 화면이 계산하는 숫자는 없음), 모르는 값은 "—"입니다 — 0으로 채우지 않습니다.
 */
import { EMPTY, formatKst, formatNumber, formatPercent, formatSigned } from "./format";
import { marketMeta, type PaperMarketCode } from "./paperMarket";
import type { BrokerageAccountResponse, BrokerageOrderRow, BrokerageSummary } from "./types/brokerage";

/** 값이 없거나 숫자로 쓸 수 없는가(null·undefined·NaN·±Infinity) — lib/format과 같은 규칙. */
function missing(value: number | null | undefined): value is null | undefined {
  return value === null || value === undefined || !Number.isFinite(value);
}

/** 미국 소수점 주식의 수량 자릿수 — 토스는 소수 6자리까지 줍니다(공식 FAQ). */
const QUANTITY_DIGITS = 6;

/**
 * 보유·주문 수량 — 소수 6자리까지, 끝의 0은 지우고 천 단위 쉼표("12"·"0.5"·"0.123456"·"1,234.5"). 모르면 "—".
 * 모의 보유 표처럼 정수 자릿수(formatNumber(qty, 0))로 찍으면 0.5주가 "1", 0.123456주가 "0"이 되어 쓰지 않습니다.
 */
export function formatQuantity(value: number | null | undefined): string {
  if (missing(value)) {
    return EMPTY;
  }
  const rounded = Number(value.toFixed(QUANTITY_DIGITS));
  return (Object.is(rounded, -0) ? 0 : rounded).toLocaleString("ko-KR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: QUANTITY_DIGITS,
  });
}

/**
 * 주당 가격(평균 매입가·현재가·주문 가격·평균 체결가) — 한국은 원 단위 정수, 미국은 소수 2~4자리(센트 아래가 있을 때만 4자리까지).
 * 모르면 "—". 단위는 표 머리가 적습니다.
 */
export function formatPrice(value: number | null | undefined, market: PaperMarketCode): string {
  if (missing(value)) {
    return EMPTY;
  }
  if (market === "KR") {
    return formatNumber(value, 0);
  }
  const rounded = Number(value.toFixed(4));
  return (Object.is(rounded, -0) ? 0 : rounded).toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/** 총액(평가금액·매입금액·체결 금액·매수 가능 금액)의 소수 자릿수 — 한국 0자리, 미국 2자리(lib/paperMarket과 같음). 색도 이 자릿수로 정합니다. */
export function amountDigits(market: PaperMarketCode): number {
  return market === "KR" ? 0 : marketMeta(market).moneyDigits;
}

/** 총액(단위 없이 — 표 머리·타일 단위가 적음). 모르면 "—". */
export function formatAmount(value: number | null | undefined, market: PaperMarketCode): string {
  return formatNumber(value, amountDigits(market));
}

/** 부호를 붙인 총액(평가손익·일간 손익, 단위 없이). 0으로 찍히면 부호 없음. 모르면 "—". */
export function formatSignedAmount(value: number | null | undefined, market: PaperMarketCode): string {
  return formatSigned(value, amountDigits(market));
}

/** 받은 글자의 이름표 — 모르는 값은 받은 글자 그대로(지어내지 않음), 없으면 "—". 토스는 모르는 enum 값을 허용하라고 적습니다. */
function labelOf(table: Readonly<Record<string, string>>, code: string | null | undefined): string {
  if (typeof code !== "string" || code.trim() === "") {
    return EMPTY;
  }
  return table[code] ?? code;
}

const ORDER_STATUS: Readonly<Record<string, string>> = {
  PENDING: "체결 대기",
  PENDING_CANCEL: "취소 대기",
  PENDING_REPLACE: "정정 대기",
  PARTIAL_FILLED: "부분 체결",
  FILLED: "체결 완료",
  CANCELED: "취소 완료",
  REJECTED: "거부됨",
  CANCEL_REJECTED: "취소 거부",
  REPLACE_REJECTED: "정정 거부",
  REPLACED: "정정됨",
};

const ORDER_SIDE: Readonly<Record<string, string>> = { BUY: "매수", SELL: "매도" };

const ORDER_TYPE: Readonly<Record<string, string>> = { LIMIT: "지정가", MARKET: "시장가" };

const TIME_IN_FORCE: Readonly<Record<string, string>> = { DAY: "당일", CLS: "장 마감", OPG: "장 개시" };

/** 주문 상태(토스 OrderStatus 열 가지) — 모르는 값은 원문. */
export function orderStatusLabel(status: string | null | undefined): string {
  return labelOf(ORDER_STATUS, status);
}

/** 주문 방향 — 매수·매도, 모르는 값은 원문. */
export function orderSideLabel(side: string | null | undefined): string {
  return labelOf(ORDER_SIDE, side);
}

/** 호가 유형 — 지정가·시장가, 모르는 값은 원문. */
export function orderTypeLabel(orderType: string | null | undefined): string {
  return labelOf(ORDER_TYPE, orderType);
}

/** 주문 유효 조건 — 당일·장 마감·장 개시, 모르는 값은 원문. */
export function timeInForceLabel(timeInForce: string | null | undefined): string {
  return labelOf(TIME_IN_FORCE, timeInForce);
}

/** 호가 유형과 유효 조건을 한 칸에("지정가 · 당일"). 둘 다 모르면 "—". */
export function orderKindText(row: Pick<BrokerageOrderRow, "orderType" | "timeInForce">): string {
  const parts = [orderTypeLabel(row.orderType), timeInForceLabel(row.timeInForce)].filter((part) => part !== EMPTY);
  return parts.length > 0 ? parts.join(" · ") : EMPTY;
}

/**
 * 주문 가격 칸 — 지정가면 그 가격, 시장가라 가격이 없고 금액 기반 미국 매수면 "금액 1,000.00", 둘 다 없으면 "—".
 */
export function orderPriceText(row: Pick<BrokerageOrderRow, "price" | "orderAmount">, market: PaperMarketCode): string {
  if (!missing(row.price)) {
    return formatPrice(row.price, market);
  }
  if (!missing(row.orderAmount)) {
    return `금액 ${formatAmount(row.orderAmount, market)}`;
  }
  return EMPTY;
}

/** 상태 짧은 이름 — 이전 값의 사유에 씁니다. 모르는 값은 원문. */
const STATE_SHORT: Readonly<Record<string, string>> = {
  OK: "정상",
  DISABLED: "꺼짐",
  NOT_CONFIGURED: "키 설정 없음",
  COLLECTOR_UNREACHABLE: "수집기에 닿지 못함",
  IP_NOT_ALLOWED: "허용되지 않은 IP",
  AUTH_FAILED: "인증 실패",
  RATE_LIMITED: "호출 한도",
  NO_ACCOUNT: "계좌를 정하지 못함",
  REFRESHING: "다른 요청이 읽는 중",
  UPSTREAM_ERROR: "토스 응답 오류",
};

/**
 * 상태별 고정 문구 — 백엔드가 `message`를 보내지 않았을 때만 씁니다(백엔드 문구도 state별 고정 문구라 수집기·토스 글은 오지 않음).
 * 꺼짐은 안내, 나머지는 읽지 못한 이유입니다.
 */
const STATE_MESSAGE: Readonly<Record<string, string>> = {
  DISABLED: "실제 계좌 조회가 꺼져 있습니다. 운영 서버에서만 켜는 기능이라 이 화면은 토스증권을 부르지 않습니다.",
  NOT_CONFIGURED: "수집기에 토스증권 키가 없어 실제 계좌를 읽지 못했습니다.",
  COLLECTOR_UNREACHABLE: "수집기에 닿지 못해 실제 계좌를 읽지 못했습니다.",
  IP_NOT_ALLOWED: "토스증권이 이 서버의 IP를 허용하지 않아 실제 계좌를 읽지 못했습니다.",
  AUTH_FAILED: "토스증권 인증에 실패해 실제 계좌를 읽지 못했습니다.",
  RATE_LIMITED: "토스증권 호출 한도에 걸려 실제 계좌를 읽지 못했습니다. 잠시 뒤 다시 읽으세요.",
  NO_ACCOUNT: "종합매매 계좌를 하나로 정하지 못해(없거나 둘 이상) 실제 계좌를 읽지 못했습니다.",
  REFRESHING: "다른 요청이 실제 계좌를 읽는 중입니다. 잠시 뒤 다시 읽으세요.",
  UPSTREAM_ERROR: "토스증권 응답을 읽지 못했습니다.",
};

const UNKNOWN_FAILURE = "실제 계좌를 읽지 못했습니다.";

/** 상태 짧은 이름. 없으면 null. */
export function brokerageStateLabel(state: string | null | undefined): string | null {
  if (typeof state !== "string" || state.trim() === "") {
    return null;
  }
  return STATE_SHORT[state] ?? state;
}

/** 화면이 그릴 모양 — 꺼짐(안내만), 실패(이유 + 다시 시도), 숫자(OK). */
export type BrokerageView = { kind: "disabled"; text: string } | { kind: "failure"; text: string } | { kind: "ok" };

/**
 * 응답 → 화면 모양. 숫자는 `state`가 OK이고 `available`이 참일 때만 그립니다(둘이 어긋나거나 모르는 state면 실패로 — 숫자를 짐작해
 * 그리지 않음). 문구는 백엔드 `message`(state별 고정 문구)가 있으면 그것, 없으면 이 파일의 고정 문구입니다.
 */
export function brokerageView(response: Pick<BrokerageAccountResponse, "available" | "state" | "message">): BrokerageView {
  const state = typeof response.state === "string" ? response.state : "";
  const message = typeof response.message === "string" && response.message.trim() !== "" ? response.message.trim() : null;
  if (state === "DISABLED") {
    return { kind: "disabled", text: message ?? STATE_MESSAGE.DISABLED };
  }
  if (state === "OK" && response.available === true) {
    return { kind: "ok" };
  }
  return { kind: "failure", text: message ?? STATE_MESSAGE[state] ?? UNKNOWN_FAILURE };
}

/**
 * '이전 값' 배지의 사유 — 서버가 이전 값을 보이거나(`isStale`, 수집기 캐시의 직전 성공값) 화면의 다시 읽기가 실패해(useApi `refreshError`)
 * 앞서 받은 값을 그대로 보일 때. 받은 시각을 함께 적습니다. 둘 다 아니면 null(배지 없음).
 */
export function brokerageStaleNote(
  response: Pick<BrokerageAccountResponse, "isStale" | "staleReason" | "fetchedAtKst">,
  refreshError: string | null | undefined,
): string | null {
  const when = response.fetchedAtKst ? `${formatKst(response.fetchedAtKst)}에 받은 값` : "받은 시각을 모르는 값";
  if (response.isStale === true) {
    const reason = brokerageStateLabel(response.staleReason);
    return `${when} — 그 뒤 새로 읽지 못함${reason ? `(${reason})` : ""}`;
  }
  if (refreshError) {
    return `${when} — 다시 읽기 실패`;
  }
  return null;
}

/** 이 화면의 쪽과 다른 쪽 — 배너의 "원화 자산만 — 달러 자산은 모의매매(미국)의 실제 계좌 탭". */
export interface BrokerageScope {
  /** 이 화면의 통화 이름("원화"·"달러"). */
  currencyLabel: string;
  /** 다른 쪽 통화 이름. */
  otherCurrencyLabel: string;
  /** 다른 쪽 시장(링크 주소). */
  other: PaperMarketCode;
  /** 다른 쪽 화면 이름("모의매매(미국)"). */
  otherScreen: string;
}

export function brokerageScope(market: PaperMarketCode): BrokerageScope {
  return market === "KR"
    ? { currencyLabel: "원화", otherCurrencyLabel: "달러", other: "US", otherScreen: "모의매매(미국)" }
    : { currencyLabel: "달러", otherCurrencyLabel: "원화", other: "KR", otherScreen: "모의매매(한국)" };
}

/** 매수 가능 금액 타일의 보조 글 — 두 통화의 금액이 통합증거금·자동 환전으로 겹치는지 스펙으로 확인되지 않아 더하지 말라고만 적습니다. */
export const BUYING_POWER_NOTE = "통화별 현금 기반 — 두 화면의 금액을 더하지 마세요";

/** 일간 손익 타일의 보조 글 — 토스의 요약 일간 비율은 원화 환산 합산이라 싣지 않습니다. */
export const DAILY_PROFIT_NOTE = "금액만 — 일간 수익률은 싣지 않음";

/**
 * 평가손익 타일의 보조 글 — 손익률(대시보드 계산: 같은 통화의 손익 ÷ 매입금액)과, 있으면 비용 차감 후 손익·손익률.
 * 손익률을 모르면 "—"로 적습니다(0.00%로 채우지 않음).
 */
export function profitLossNote(summary: BrokerageSummary | null | undefined, market: PaperMarketCode): string {
  const pct = `손익률 ${formatPercent(summary?.profitLossPct)}(대시보드 계산)`;
  const afterCost = summary?.profitLossAfterCost;
  if (missing(afterCost)) {
    return pct;
  }
  const afterPct = missing(summary?.profitLossPctAfterCost) ? "" : `(${formatPercent(summary?.profitLossPctAfterCost)})`;
  return `${pct} · 비용 차감 후 ${formatSignedAmount(afterCost, market)}${marketMeta(market).moneyUnit}${afterPct}`;
}

/** 평가금액 타일의 보조 글 — 비용 차감 후 평가금액이 있을 때만. */
export function marketValueNote(summary: BrokerageSummary | null | undefined, market: PaperMarketCode): string | null {
  const value = summary?.marketValueAfterCost;
  return missing(value) ? null : `비용 차감 후 ${formatAmount(value, market)}${marketMeta(market).moneyUnit}`;
}
