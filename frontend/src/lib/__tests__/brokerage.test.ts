/**
 * 토스증권 실제 계좌 탭의 표기(lib/brokerage, ADR 0025) — 순수 함수.
 *
 *  - 수량은 소수 6자리까지(미국 소수점 주식), 끝 0은 지우고 천 단위 쉼표, 모르면 "—"(0으로 채우지 않음)
 *  - 주당 가격은 한국 정수·미국 2~4자리, 총액은 한국 0자리·미국 2자리, 손익은 부호
 *  - 주문 상태·방향·호가 유형·유효 조건은 한국어 이름표, 모르는 값은 원문
 *  - 상태 → 화면 모양(꺼짐·실패·숫자), 문구는 백엔드 message가 있으면 그것, 없으면 고정 문구
 *  - '이전 값' 사유는 서버 이전 값(isStale)·화면 다시 읽기 실패(refreshError) 모두 받은 시각과 함께
 *  - 손익률은 '대시보드 계산'이라고 적고, 모르면 "—"
 * 값은 모두 토스 스펙 예시에서 만든 합성 값입니다.
 */
import { describe, expect, it } from "vitest";

import {
  amountDigits,
  brokerageScope,
  brokerageStaleNote,
  brokerageStateLabel,
  brokerageView,
  BUYING_POWER_NOTE,
  formatAmount,
  formatPrice,
  formatQuantity,
  formatSignedAmount,
  marketValueNote,
  orderKindText,
  orderPriceText,
  orderSideLabel,
  orderStatusLabel,
  orderTypeLabel,
  profitLossNote,
  timeInForceLabel,
} from "../brokerage";
import type { BrokerageSummary } from "../types/brokerage";

describe("수량", () => {
  it("소수 6자리까지, 끝 0은 지우고 천 단위 쉼표", () => {
    expect(formatQuantity(0.123456)).toBe("0.123456");
    expect(formatQuantity(0.5)).toBe("0.5");
    expect(formatQuantity(12)).toBe("12");
    expect(formatQuantity(1234.5)).toBe("1,234.5");
    expect(formatQuantity(100)).toBe("100");
    // 7자리 아래는 반올림, -0은 0
    expect(formatQuantity(0.1234567)).toBe("0.123457");
    expect(formatQuantity(-0.0000001)).toBe("0");
  });

  it("모르면 '—' — 0으로 채우지 않는다", () => {
    for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatQuantity(value)).toBe("—");
    }
    expect(formatQuantity(0)).toBe("0");
  });
});

describe("가격·총액", () => {
  it("주당 가격 — 한국은 정수, 미국은 소수 2~4자리", () => {
    expect(formatPrice(72000, "KR")).toBe("72,000");
    expect(formatPrice(150.25, "US")).toBe("150.25");
    expect(formatPrice(150, "US")).toBe("150.00");
    expect(formatPrice(9.0045, "US")).toBe("9.0045");
    expect(formatPrice(9.00451, "US")).toBe("9.0045");
    expect(formatPrice(null, "US")).toBe("—");
  });

  it("총액 — 한국 0자리, 미국 2자리, 손익은 부호(0으로 찍히면 부호 없음)", () => {
    expect(amountDigits("KR")).toBe(0);
    expect(amountDigits("US")).toBe(2);
    expect(formatAmount(7200000, "KR")).toBe("7,200,000");
    expect(formatAmount(1234.5, "US")).toBe("1,234.50");
    expect(formatSignedAmount(700000, "KR")).toBe("+700,000");
    expect(formatSignedAmount(-12.345, "US")).toBe("-12.35");
    expect(formatSignedAmount(0.001, "US")).toBe("0.00");
    expect(formatAmount(null, "KR")).toBe("—");
    expect(formatSignedAmount(undefined, "US")).toBe("—");
  });
});

describe("주문 이름표", () => {
  it("상태 열 가지 — 모르는 값은 원문, 없으면 '—'", () => {
    expect(orderStatusLabel("PENDING")).toBe("체결 대기");
    expect(orderStatusLabel("PARTIAL_FILLED")).toBe("부분 체결");
    expect(orderStatusLabel("FILLED")).toBe("체결 완료");
    expect(orderStatusLabel("CANCELED")).toBe("취소 완료");
    expect(orderStatusLabel("REPLACE_REJECTED")).toBe("정정 거부");
    expect(orderStatusLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(orderStatusLabel(null)).toBe("—");
    expect(orderStatusLabel("")).toBe("—");
  });

  it("방향·호가 유형·유효 조건 — 모르는 값은 원문", () => {
    expect(orderSideLabel("BUY")).toBe("매수");
    expect(orderSideLabel("SELL")).toBe("매도");
    expect(orderSideLabel("SHORT")).toBe("SHORT");
    expect(orderTypeLabel("LIMIT")).toBe("지정가");
    expect(orderTypeLabel("MARKET")).toBe("시장가");
    expect(orderTypeLabel("STOP")).toBe("STOP");
    expect(timeInForceLabel("DAY")).toBe("당일");
    expect(timeInForceLabel("CLS")).toBe("장 마감");
    expect(timeInForceLabel("OPG")).toBe("장 개시");
    expect(timeInForceLabel("GTC")).toBe("GTC");
    expect(orderKindText({ orderType: "LIMIT", timeInForce: "CLS" })).toBe("지정가 · 장 마감");
    expect(orderKindText({ orderType: "MARKET", timeInForce: null })).toBe("시장가");
    expect(orderKindText({ orderType: null, timeInForce: null })).toBe("—");
  });

  it("주문 가격 — 지정가는 가격, 시장가 금액 주문은 '금액 …', 둘 다 없으면 '—'", () => {
    expect(orderPriceText({ price: 70000, orderAmount: null }, "KR")).toBe("70,000");
    expect(orderPriceText({ price: null, orderAmount: 1000 }, "US")).toBe("금액 1,000.00");
    expect(orderPriceText({ price: null, orderAmount: null }, "US")).toBe("—");
  });
});

describe("상태 → 화면 모양", () => {
  it("DISABLED는 안내만 — 백엔드 문구가 있으면 그것, 없으면 고정 문구", () => {
    expect(brokerageView({ available: false, state: "DISABLED", message: "꺼져 있습니다." })).toEqual({ kind: "disabled", text: "꺼져 있습니다." });
    const fallback = brokerageView({ available: false, state: "DISABLED", message: null });
    expect(fallback.kind).toBe("disabled");
    expect(fallback.kind === "disabled" && fallback.text).toMatch(/꺼져 있습니다/);
  });

  it("OK이고 available이면 숫자, 둘이 어긋나거나 모르는 state면 실패(숫자를 짐작해 그리지 않음)", () => {
    expect(brokerageView({ available: true, state: "OK", message: null })).toEqual({ kind: "ok" });
    expect(brokerageView({ available: false, state: "OK", message: null }).kind).toBe("failure");
    expect(brokerageView({ available: true, state: "RATE_LIMITED", message: null }).kind).toBe("failure");
    const unknown = brokerageView({ available: false, state: "SOMETHING" as never, message: null });
    expect(unknown).toEqual({ kind: "failure", text: "실제 계좌를 읽지 못했습니다." });
  });

  it("실패 문구 — 백엔드 message 우선, 없으면 state별 고정 문구", () => {
    expect(brokerageView({ available: false, state: "RATE_LIMITED", message: "  한도 초과  " })).toEqual({ kind: "failure", text: "한도 초과" });
    for (const state of ["NOT_CONFIGURED", "COLLECTOR_UNREACHABLE", "IP_NOT_ALLOWED", "AUTH_FAILED", "RATE_LIMITED", "NO_ACCOUNT",
      "REFRESHING", "UPSTREAM_ERROR"] as const) {
      const view = brokerageView({ available: false, state, message: null });
      expect(view.kind, state).toBe("failure");
      expect(view.kind === "failure" && view.text.length > 0, state).toBe(true);
      expect(view.kind === "failure" && view.text, state).not.toBe("실제 계좌를 읽지 못했습니다.");
    }
  });

  it("상태 짧은 이름 — 모르는 값은 원문, 없으면 null", () => {
    expect(brokerageStateLabel("RATE_LIMITED")).toBe("호출 한도");
    expect(brokerageStateLabel("NEW_STATE")).toBe("NEW_STATE");
    expect(brokerageStateLabel(null)).toBeNull();
  });
});

describe("'이전 값' 사유", () => {
  const fresh = { isStale: false, staleReason: null, fetchedAtKst: "2026-03-29 09:30" } as const;

  it("서버가 이전 값을 보이면 받은 시각과 그 실패의 이름", () => {
    expect(brokerageStaleNote({ ...fresh, isStale: true, staleReason: "RATE_LIMITED" }, null)).toBe(
      "2026-03-29 09:30에 받은 값 — 그 뒤 새로 읽지 못함(호출 한도)",
    );
    expect(brokerageStaleNote({ ...fresh, isStale: true, staleReason: null }, null)).toBe("2026-03-29 09:30에 받은 값 — 그 뒤 새로 읽지 못함");
  });

  it("화면의 다시 읽기가 실패하면 앞서 받은 값 — 받은 시각과 함께", () => {
    expect(brokerageStaleNote(fresh, "요청 실패 (HTTP 500)")).toBe("2026-03-29 09:30에 받은 값 — 다시 읽기 실패");
    expect(brokerageStaleNote({ ...fresh, fetchedAtKst: null }, "x")).toBe("받은 시각을 모르는 값 — 다시 읽기 실패");
  });

  it("새 값이고 다시 읽기도 성공이면 배지 없음", () => {
    expect(brokerageStaleNote(fresh, null)).toBeNull();
    expect(brokerageStaleNote(fresh, "")).toBeNull();
  });
});

describe("요약 보조 글·쪽", () => {
  const summary: BrokerageSummary = {
    purchaseAmount: 6500000, marketValue: 7200000, marketValueAfterCost: 7185600, profitLoss: 700000,
    profitLossAfterCost: 685600, dailyProfitLoss: 50000, profitLossPct: 10.7692, profitLossPctAfterCost: 10.5477,
  };

  it("손익률은 '대시보드 계산'이라고 적고, 비용 차감 후 손익을 덧붙인다", () => {
    expect(profitLossNote(summary, "KR")).toBe("손익률 +10.77%(대시보드 계산) · 비용 차감 후 +685,600원(+10.55%)");
    expect(marketValueNote(summary, "KR")).toBe("비용 차감 후 7,185,600원");
  });

  it("모르는 손익률은 '—'(0.00%로 채우지 않음), 비용 차감 후 값이 없으면 그 부분을 뺀다", () => {
    const empty = { ...summary, profitLossPct: null, profitLossAfterCost: null, marketValueAfterCost: null };
    expect(profitLossNote(empty, "US")).toBe("손익률 —(대시보드 계산)");
    expect(profitLossNote(null, "US")).toBe("손익률 —(대시보드 계산)");
    expect(marketValueNote(empty, "US")).toBeNull();
    expect(profitLossNote({ ...summary, profitLossPctAfterCost: null }, "US")).toBe("손익률 +10.77%(대시보드 계산) · 비용 차감 후 +685,600.00 달러");
  });

  it("한국 화면은 원화 쪽(다른 쪽은 미국), 미국 화면은 달러 쪽 — 매수 가능 금액은 더하지 말라고", () => {
    expect(brokerageScope("KR")).toEqual({ currencyLabel: "원화", otherCurrencyLabel: "달러", other: "US", otherScreen: "모의매매(미국)" });
    expect(brokerageScope("US")).toEqual({ currencyLabel: "달러", otherCurrencyLabel: "원화", other: "KR", otherScreen: "모의매매(한국)" });
    expect(BUYING_POWER_NOTE).toBe("통화별 현금 기반 — 두 화면의 금액을 더하지 마세요");
  });
});
