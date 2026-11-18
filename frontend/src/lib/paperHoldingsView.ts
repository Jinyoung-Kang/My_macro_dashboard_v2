/**
 * 모의매매 보유·체결 탭의 보유 검사 칸(작업대 P6 — 실행 명세 §7-1 '보유: 목록-검사')에 쓰는 순수 규칙(ADR 0004). 값은 보유 응답(GET books/{code}/positions)
 * 그대로이고 서식은 보유 표와 같은 함수(lib/paper·lib/paperKr)입니다 — 새 숫자를 만들지 않고, 모르면 '—'(0으로 채우지 않음).
 *
 * 진입 논거·조건 확인(checks·holdingChecks)은 보유 응답에 없고 결정 상세(GET decisions/{id})에만 있어(데이터 공백 — 계획 §12-1), 검사 칸은 새 요청 없이
 * 결정 로그로 가리킵니다(HoldingInspector).
 */
import { deltaColor, EMPTY, formatKst, formatNumber, formatPercent, formatWithUnit } from "./format";
import { liveShown, livePriceTitle, returnVsCost, tradedAtText } from "./livePrices";
import { formatSharePrice, heldText, positionBadges, stopText } from "./paper";
import { krPositionBadges, krPositionPriceTitle } from "./paperKr";
import type { PaperMarketCode } from "./paperMarket";
import type { LivePrice, PaperPosition } from "./types";

/** 보유 검사 칸의 속성 한 줄 — 이름·값 글(모르면 '—')·값 글자색(등락 칸만)·보조 글. 공용 속성 목록(PropertyList)이 그립니다. */
export interface PositionProperty {
  key: string;
  label: string;
  value: string;
  /** 등락 값의 글자색(평가 손익·실시간 평단 대비 — lib/format deltaColor, 값이 부호를 함께 적음). 없으면 본문색. */
  tone?: string;
  note?: string | null;
}

/**
 * 보유 한 줄 → 검사 칸 속성: 수량 · 평단 · 가격(관측 시각) · 평가액 · 비중 · 평가 손익 · 최고가 · 스탑과 거리 · 보유 기간 · 표지(가격 없음·현금성·사후 체결·
 * 기업행위 확인 필요 등 — 배지 글과 설명) · 실시간(받았으면 그 가격·평단 대비·거래 시각 — 표시 전용). 미국은 달러 4자리 주당 가격·2자리 총액, 한국은 원 정수.
 */
export function positionProperties(
  position: PaperPosition,
  market: PaperMarketCode = "US",
  live: LivePrice | null = null,
): PositionProperty[] {
  const korea = market === "KR";
  const unit = korea ? "원" : "달러";
  const price = (value: number | null | undefined) => formatSharePrice(value, market);
  const withUnit = (text: string) => (text === EMPTY ? EMPTY : `${text} ${unit}`);
  const badges = korea ? krPositionBadges(position) : positionBadges(position);
  const observed = position.lastPriceAtKst ? `${formatKst(position.lastPriceAtKst)} 관측` : null;
  const priceNote = korea ? (krPositionPriceTitle(position) ?? observed) : observed;
  const unrealized = formatPercent(position.unrealizedPct);
  const properties: PositionProperty[] = [
    { key: "qty", label: korea ? "수량(주)" : "수량", value: formatNumber(position.qty, 0) },
    { key: "avgCost", label: "평단", value: withUnit(price(position.avgCost)) },
    { key: "lastPrice", label: "가격(장부)", value: withUnit(price(position.lastPrice)), note: priceNote },
    { key: "marketValue", label: "평가액", value: withUnit(formatNumber(position.marketValue, korea ? 0 : 2)) },
    { key: "weight", label: "비중(순자산 대비)", value: formatWithUnit(position.weightPct, 1, "%") },
    { key: "unrealized", label: "평가 손익(평단 대비)", value: unrealized, ...(unrealized === EMPTY ? {} : { tone: deltaColor(position.unrealizedPct) }) },
    { key: "high", label: "최고가", value: withUnit(price(position.highWatermark)) },
    { key: "stop", label: "스탑 가격 · 거리", value: stopText(position, market) },
    { key: "held", label: "보유 기간", value: heldText(position, market) },
    {
      key: "badges",
      label: "표지",
      value: badges.length > 0 ? badges.map((badge) => badge.label).join(" · ") : "없음",
      note: badges.map((badge) => badge.title).filter((title): title is string => typeof title === "string" && title !== "").join(" ") || null,
    },
  ];
  if (live) {
    const shown = liveShown(live);
    const pct = returnVsCost(shown.price, position.avgCost);
    const pctText = formatPercent(pct);
    properties.push({
      key: "live",
      label: "실시간(표시 전용)",
      value: `${withUnit(price(shown.price))} · 평단 대비 ${pctText}`,
      ...(pctText === EMPTY ? {} : { tone: deltaColor(pct) }),
      note: `${shown.session ? `${shown.session} ` : ""}${tradedAtText(shown.tradedAt)} 거래 — ${livePriceTitle(live, price)}`,
    });
  }
  return properties;
}

// ---------------------------------------------------------------- 주문·체결 거르기(받은 줄만 — 서버 거르기 없음, 새 요청 없음)

/** 거르기 칸 하나 — 키·이름·그 칸에 드는 줄 수(받은 최근 줄 안). */
export interface RowFilterOption {
  key: string;
  label: string;
  count: number;
}

/** 주문 상태 거르기의 칸 — 전체 · 대기 · 체결 · 그 밖(제안·만료·취소·거절·모르는 값). */
export type OrderStatusFilter = "all" | "pending" | "filled" | "other";

function orderStatusGroup(status: string | null | undefined): Exclude<OrderStatusFilter, "all"> {
  if (status === "PENDING") return "pending";
  if (status === "FILLED") return "filled";
  return "other";
}

/** 주문 상태 거르기 칸 — 이름 뒤 개수는 받은 줄 기준('대기 2'). 줄이 없는 칸도 그립니다(0 — 고를 수 있는 칸이 바뀌지 않게). */
export function orderStatusOptions(orders: readonly { status: string | null }[]): RowFilterOption[] {
  const count = (group: Exclude<OrderStatusFilter, "all">) => orders.filter((order) => orderStatusGroup(order.status) === group).length;
  return [
    { key: "all", label: "전체", count: orders.length },
    { key: "pending", label: "대기", count: count("pending") },
    { key: "filled", label: "체결", count: count("filled") },
    { key: "other", label: "그 밖(제안·만료·취소·거절)", count: count("other") },
  ];
}

/** 고른 주문 상태 칸의 줄만(서버 차례 그대로). */
export function filterOrders<T extends { status: string | null }>(orders: readonly T[], filter: OrderStatusFilter): T[] {
  return filter === "all" ? [...orders] : orders.filter((order) => orderStatusGroup(order.status) === filter);
}

/** 체결 방향 거르기의 칸 — 전체 · 매수 · 매도. */
export type FillSideFilter = "all" | "BUY" | "SELL";

/** 체결 방향 거르기 칸 — 이름 뒤 개수는 받은 줄 기준. */
export function fillSideOptions(fills: readonly { side: string | null }[]): RowFilterOption[] {
  return [
    { key: "all", label: "전체", count: fills.length },
    { key: "BUY", label: "매수", count: fills.filter((fill) => fill.side === "BUY").length },
    { key: "SELL", label: "매도", count: fills.filter((fill) => fill.side === "SELL").length },
  ];
}

/** 고른 방향의 체결만(서버 차례 그대로). */
export function filterFills<T extends { side: string | null }>(fills: readonly T[], filter: FillSideFilter): T[] {
  return filter === "all" ? [...fills] : fills.filter((fill) => fill.side === filter);
}
