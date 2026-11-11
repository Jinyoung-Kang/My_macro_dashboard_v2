/**
 * ISA 계좌(ADR 0029·0034)의 표기·입력 검사 — lib/isa 순수 함수.
 *
 *  - 모르는 값은 "—"(0으로 채우지 않음), 숫자 글자(BigDecimal)도 읽음
 *  - 시작 창(총 잔고 + 줄마다 종목·수량·매입 금액), 고치기 창(매입 금액 = 수량 × 가격), 총 잔고·수수료율 입력 검사
 *  - 서버 오류 코드(invalid-request·not-found·already-started·not-started·already-recorded)별 문구
 *  - 실시간 평가: 받은 가격이 없으면 서버 값 그대로, 받았으면 평가액·손익·비중 다시 계산, 기준 시각 = 받은 가격의 시각 중 가장 이른 것
 *  - '확인'에 실을 가격(받았으면 live, 끊겼거나 없으면 생략)
 * 값은 모두 합성 값입니다(실제 계좌 자료 아님).
 */
import { describe, expect, it } from "vitest";
import {
  buildApplyRequest,
  buildEditTradeRequest,
  confirmLineFromInstruction,
  confirmLineFromStop,
  confirmLineFromTrade,
  confirmLineWarning,
  estimateFee,
  updateConfirmLine,
  autoNoteLabel,
  buildCommissionRequest,
  buildPositionRequest,
  buildStartRequest,
  buildTotalRequest,
  canConfirm,
  canSkip,
  COST_NOTE,
  emptyPositionForm,
  emptyStartLine,
  formatPrice,
  formatShares,
  formatSignedWon,
  formatWeight,
  formatWon,
  instructionStatusLabel,
  instructionWhenText,
  isaBasisNote,
  isaBasisText,
  isaErrorCode,
  isaErrorNeedsReload,
  isaErrorText,
  isaValuation,
  kstInputFromIso,
  kstShort,
  MIDDAY_GUIDE,
  NEGATIVE_CASH_TEXT,
  notifiedText,
  parseDecimal,
  positionFormAmount,
  positionFormFromRow,
  sessionLabel,
  sessionStatusLabel,
  sideLabel,
  STOP_GUIDE,
  stopNotifiedText,
  stopTimingLabel,
  stopWindowText,
  symbolText,
  targetClock,
  timeSortValue,
  toNumber,
  tradeGuide,
  unavailableText,
  unpricedText,
} from "../isa";
import type { IsaPosition, IsaSummary } from "../types/isa";

function position(over: Partial<IsaPosition> = {}): IsaPosition {
  return {
    symbol: "111110", name: "합성전자", quantity: 100, avgPrice: 12_000, purchaseAmount: 1_200_000, lastPrice: 12_500, marketValue: 1_250_000,
    profitLoss: 50_000, profitLossPct: 4.17, weightPct: 24.51, feesPaid: 0, taxesPaid: 0, ...over,
  };
}

describe("표기 — 모르면 —", () => {
  it("숫자·숫자 글자를 읽고 못 읽으면 null", () => {
    expect(toNumber(5)).toBe(5);
    expect(toNumber("1234.5")).toBe(1234.5);
    expect(toNumber("")).toBeNull();
    expect(toNumber("abc")).toBeNull();
    expect(toNumber(Number.NaN)).toBeNull();
    expect(toNumber(null)).toBeNull();
  });

  it("원·부호 원·가격·수량·비중", () => {
    expect(formatWon(1_234_567)).toBe("1,234,567원");
    expect(formatWon("2500000.00")).toBe("2,500,000원");
    expect(formatWon(null)).toBe("—");
    expect(formatSignedWon(12_345)).toBe("+12,345원");
    expect(formatSignedWon(-12_345)).toBe("-12,345원");
    expect(formatSignedWon(undefined)).toBe("—");
    expect(formatPrice(12_500)).toBe("12,500원");
    expect(formatPrice("12500.5")).toBe("12,500.50원");
    expect(formatShares(4)).toBe("4");
    expect(formatShares(null)).toBe("—");
    expect(formatWeight(9.5)).toBe("9.50%");
    expect(formatWeight(null)).toBe("—");
  });

  it("이름표 — 모르는 값은 받은 글자 그대로, 없으면 —", () => {
    expect(sideLabel("SELL")).toBe("매도");
    expect(sideLabel(null)).toBe("—");
    expect(instructionStatusLabel("PLANNED")).toBe("미확인");
    expect(instructionStatusLabel("RECORDED")).toBe("확인함(잔고 반영)");
    expect(instructionStatusLabel("SKIPPED")).toBe("건너뜀");
    expect(instructionStatusLabel("MYSTERY")).toBe("MYSTERY");
    expect(sessionStatusLabel("NONE")).toBe("지시 없음");
    expect(sessionStatusLabel("UNAVAILABLE")).toBe("못 만듦");
    expect(symbolText("111110", "합성전자")).toBe("합성전자 111110");
    expect(symbolText("111110", null)).toBe("111110");
    expect(symbolText(null, null)).toBe("—");
    expect(autoNoteLabel("expired")).toBe("마감까지 확인하지 않아 닫힘");
    expect(autoNoteLabel("no-holding")).toBe("보유 없음");
    expect(autoNoteLabel("restart")).toBe("새로 시작하며 닫힘");
    expect(autoNoteLabel("not-trading")).toBe("거래일이 아니게 되어 닫힘");
    expect(autoNoteLabel("restored")).toBe("DB 복원으로 건너뜀");
    expect(autoNoteLabel("not-notified")).toBe("마감까지 알리지 못해 건너뜀");
    expect(autoNoteLabel("new-code")).toBe("new-code");
    expect(autoNoteLabel(null)).toBe("—");
  });

  it("세션 날짜 → 'MM/DD(요일)', 알림 시각, 보낸 적 없으면 '보내기 전'", () => {
    expect(sessionLabel("2026-11-09")).toBe("11/09(월)");
    expect(sessionLabel("2026-02-30")).toBe("2026-02-30");
    expect(sessionLabel(null)).toBe("—");
    expect(kstShort("2026-11-06T13:41:00Z")).toBe("11/06 22:41");
    expect(notifiedText({ notifiedMorningAt: null })).toBe("보내기 전");
    expect(notifiedText({ notifiedMorningAt: "2026-11-09T08:00:30+09:00", notifiedMiddayAt: "2026-11-09T12:15:00+09:00", notifiedPrecloseAt: "2026-11-09T15:00:00+09:00" }))
      .toBe("아침 11/09 08:00 · 장 중반 11/09 12:15 · 마감 전 11/09 15:00");
  });

  it("가격 모르는 종목 — 코드 글자·{symbol, name} 모두, 없으면 null", () => {
    expect(unpricedText(["222220", { symbol: "333330", name: "합성바이오" }])).toBe("222220, 합성바이오 333330");
    expect(unpricedText([])).toBeNull();
    expect(unpricedText(null)).toBeNull();
  });

  it("확인·건너뜀은 미확인 지시만", () => {
    expect(canConfirm({ status: "PLANNED" })).toBe(true);
    expect(canConfirm({ status: "RECORDED" })).toBe(false);
    expect(canConfirm({ status: "SKIPPED" })).toBe(false);
    expect(canSkip({ status: "PLANNED" })).toBe(true);
    expect(canSkip({ status: "RECORDED" })).toBe(false);
  });
});

describe("숫자 입력", () => {
  it("천 단위 쉼표는 자리가 맞을 때만, 소수 자릿수·음수는 옵션대로", () => {
    expect(parseDecimal("10,000,000", { maxDecimals: 2 })).toBe(10_000_000);
    expect(parseDecimal("1,00", { maxDecimals: 2 })).toBeNull();
    expect(parseDecimal("1.234", { maxDecimals: 2 })).toBeNull();
    expect(parseDecimal("-1", { maxDecimals: 2 })).toBeNull();
    expect(parseDecimal("-1", { maxDecimals: 2, allowNegative: true })).toBe(-1);
    expect(parseDecimal("", { maxDecimals: 2 })).toBeNull();
  });

  it("시각 글자 → datetime-local 값(서울), 못 읽으면 빈 칸", () => {
    expect(kstInputFromIso("2026-11-06T13:41:00Z")).toBe("2026-11-06T22:41");
    expect(kstInputFromIso("2026-11-06 22:41:30")).toBe("2026-11-06T22:41");
    expect(kstInputFromIso("모름")).toBe("");
    expect(kstInputFromIso(null)).toBe("");
  });
});

describe("시작 창 입력", () => {
  const line = (symbol: string, quantity: string, purchaseAmount: string) => ({ symbol, quantity, purchaseAmount });

  it("총 잔고 + 줄(종목은 이름·코드 그대로), 빈 줄 건너뜀, 실시간 가격은 있을 때만", () => {
    const checked = buildStartRequest({ totalAsset: "10,000,000", lines: [line("005930", "10", "1,000,000"), emptyStartLine(), line("합성전자", "3.5", "0")], prices: { "005930": 12_000 } });
    expect(checked).toEqual({
      ok: true,
      body: {
        totalAsset: 10_000_000,
        positions: [{ symbol: "005930", quantity: 10, purchaseAmount: 1_000_000 }, { symbol: "합성전자", quantity: 3.5, purchaseAmount: 0 }],
        prices: { "005930": 12_000 },
      },
    });
    const noPrices = buildStartRequest({ totalAsset: "100", lines: [], prices: {} });
    expect(noPrices).toEqual({ ok: true, body: { totalAsset: 100, positions: [] } });
  });

  it("틀린 입력은 보내지 않고 고칠 것을 줄 번호로 — 총 잔고·종목·수량·매입 금액", () => {
    const checked = buildStartRequest({ totalAsset: "0", lines: [line("", "0", "-1"), line("A", "1", "")] });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.errors[0]).toMatch(/^총 잔고/);
    expect(checked.errors[1]).toMatch(/^1번째 줄: 종목/);
    expect(checked.errors[1]).toContain("수량은 0보다 큰 수");
    expect(checked.errors[2]).toMatch(/^2번째 줄: 매입 금액/);
  });
});

describe("고치기 창 입력", () => {
  it("매입 금액 = 수량 × 가격을 바로 — 읽지 못하면 null", () => {
    expect(positionFormAmount({ symbol: "", name: "", quantity: "3", price: "1,000" })).toBe(3000);
    expect(positionFormAmount(emptyPositionForm())).toBeNull();
  });

  it("추가는 originalSymbol 없이, 고치기는 원래 코드를 싣고, 이름은 있을 때만", () => {
    expect(buildPositionRequest({ symbol: "합성전자", name: "", quantity: "3", price: "1000" })).toEqual({ ok: true, body: { symbol: "합성전자", quantity: 3, price: 1000 } });
    expect(buildPositionRequest({ symbol: "111110", name: "내 이름", quantity: "3", price: "1000" }, "222220")).toEqual({
      ok: true, body: { originalSymbol: "222220", symbol: "111110", name: "내 이름", quantity: 3, price: 1000 },
    });
  });

  it("틀린 입력은 보내지 않음, 잔고 한 줄 → 입력(가격은 평균 매입가)", () => {
    const checked = buildPositionRequest({ symbol: " ", name: "", quantity: "0", price: "x" });
    expect(checked.ok).toBe(false);
    expect(positionFormFromRow(position())).toEqual({ symbol: "111110", name: "합성전자", quantity: "100", price: "12000" });
  });
});

describe("총 잔고·수수료율 입력", () => {
  it("총 잔고 — 0보다 큰 원, 실시간 가격은 있을 때만", () => {
    expect(buildTotalRequest("1,000", { "111110": 12 })).toEqual({ ok: true, body: { totalAsset: 1000, prices: { "111110": 12 } } });
    expect(buildTotalRequest("1,000", {})).toEqual({ ok: true, body: { totalAsset: 1000 } });
    expect(buildTotalRequest("0").ok).toBe(false);
  });

  it("수수료율 — 0~1%", () => {
    expect(buildCommissionRequest("0.015")).toEqual({ ok: true, body: { commissionPct: 0.015 } });
    expect(buildCommissionRequest("0")).toEqual({ ok: true, body: { commissionPct: 0 } });
    expect(buildCommissionRequest("1.5").ok).toBe(false);
    expect(buildCommissionRequest("-1").ok).toBe(false);
    expect(buildCommissionRequest("abc").ok).toBe(false);
  });
});

describe("서버 오류 코드", () => {
  it("ApiError의 code 칸을 정확히 비교하고, 없으면 문구 안의 코드 글자", () => {
    expect(isaErrorCode({ code: "already-recorded", message: "x" })).toBe("already-recorded");
    expect(isaErrorCode({ code: "something-else", message: "already-recorded" })).toBeNull();
    expect(isaErrorCode({ code: null, message: "409 already-started" })).toBe("already-started");
    expect(isaErrorCode(new Error("요청 실패 (HTTP 500)"))).toBeNull();
    expect(isaErrorCode(null)).toBeNull();
  });

  it("코드별 문구 — 서버 문구를 덧붙이고, 화면과 서버가 어긋난 오류는 다시 읽기", () => {
    expect(isaErrorText("invalid-request", "수량이 비었습니다")).toBe("입력이 올바르지 않습니다 — 수량이 비었습니다");
    expect(isaErrorText("invalid-request", null)).toBe("입력이 올바르지 않습니다. 칸을 확인하세요.");
    expect(isaErrorText("not-found", "x")).toMatch(/^그 행이나 지시를 찾지 못했습니다/);
    expect(isaErrorText("already-started", null)).toMatch(/^이미 시작한 계좌입니다 — 시작은 한 번만/);
    expect(isaErrorText("not-started", null)).toMatch(/^아직 시작하지 않은 계좌입니다/);
    expect(isaErrorText("already-recorded", null)).toMatch(/^이미 확인한 지시입니다/);
    expect(isaErrorText(null, "서버 문구")).toBe("서버 문구");
    expect(isaErrorText(null, null)).toBe("요청을 처리하지 못했습니다.");
    expect((["invalid-request", "not-found", "already-started", "not-started", "already-recorded"] as const).map((code) => isaErrorNeedsReload(code)))
      .toEqual([false, true, true, true, true]);
  });
});

describe("안내 글", () => {
  it("동시호가 안내는 그 세션 개장 시각 기준, 모르면 08:30~09:00, '확인'을 누르라는 뜻", () => {
    expect(tradeGuide("2026-11-19T10:00:00+09:00")).toMatch(/^장전 동시호가\(09:30~10:00\)에 시장가로 내면 규칙 계좌와 같은 시가에 체결됩니다/);
    expect(tradeGuide(null)).toMatch(/^장전 동시호가\(08:30~09:00\)/);
    expect(tradeGuide("모름")).toMatch(/^장전 동시호가\(08:30~09:00\)/);
    expect(tradeGuide(null)).toContain("'확인'을 눌러 실제 수량·체결 금액·수수료를 적으세요");
    expect(tradeGuide(null)).not.toContain("자동 기록");
  });

  it("시각 맞추기 지시 안내 — 'HH:MM 이후 시장가'", () => {
    expect(tradeGuide("2026-11-10T09:00:00+09:00", "2026-11-10T00:10:00Z")).toMatch(/^09:10 이후 시장가로 내면 규칙 계좌와 같은 때\(09:10\)에 체결됩니다/);
    expect(tradeGuide(null, "모름")).toMatch(/^장전 동시호가/);
    expect(targetClock("2026-11-10T00:10:00Z")).toBe("09:10");
    expect(targetClock(null)).toBeNull();
  });

  it("'못 만듦' 사유별 문구 — 시가 밖 시점 주문은 할 일을, 그 밖·없음은 중립 문구", () => {
    expect(unavailableText("timed-orders")).toContain("규칙 계좌가 시가 밖 시점으로 주문해 ISA는 이번 세션 시가 지시를 만들지 않았습니다");
    for (const reason of ["decision-pending", "price-missing", "record-pending", null, undefined, ""]) {
      const text = unavailableText(reason);
      expect(text).toMatch(/^이 세션의 지시를 만들지 못했습니다/);
      expect(text).not.toContain("앞 세션 지시");
    }
  });

  // QA-353: 잔고의 가격 고치기는 매입 금액만 바꾸고 현금·실현 손익을 못 맞춘다(ADR 0034 개정). 수정 전 글은 '잔고에서 가격을 고치고'였다(재현 커밋에서는 it.fails).
  it("QA-353 체결 값이 다르면 잔고가 아니라 매매 내역의 '고치기'로 안내", () => {
    expect(MIDDAY_GUIDE).toContain("매매 내역의 '고치기'");
    expect(MIDDAY_GUIDE).not.toContain("잔고에서 가격을 고치");
  });

  it("시스템은 실제 매매를 볼 수 없어 확인을 안 누르면 알림이 간다는 뜻, 비용 안내, 음수 현금 경고", () => {
    expect(MIDDAY_GUIDE).toContain("실제 매매를 볼 수 없습니다");
    expect(MIDDAY_GUIDE).toContain("12:15");
    expect(MIDDAY_GUIDE).toContain("15:00");
    expect(COST_NOTE).toContain("어림");
    expect(NEGATIVE_CASH_TEXT).toContain("음수");
  });

  it("스탑 지시 이름표·건너뜀 머리·매도 창", () => {
    expect(stopTimingLabel("MARKET")).toBe("장중 시장가");
    expect(stopTimingLabel("NEXT_CLOSE")).toBe("종가 단일가 시장가");
    expect(stopTimingLabel(null)).toBe("—");
    expect(stopNotifiedText({ notifiedAt: "2026-11-09T11:30:10+09:00" })).toBe("알림 11/09 11:30");
    expect(stopNotifiedText({ notifiedAt: null })).toBe("보내기 전");
    expect(instructionWhenText({ session: "2026-11-10", targetAt: "2026-11-10T00:10:00Z" })).toBe("11/10(화) 09:10 이후 시장가 ");
    expect(instructionWhenText({ session: "2026-11-06", targetAt: null })).toBe("11/06(금) 시가 ");
    expect(stopWindowText({ timing: "NEXT_CLOSE", targetAt: "2026-11-19T07:30:00Z" })).toBe("16:20~16:30");
    expect(stopWindowText({ timing: "AT_MINUTE", targetAt: "2026-11-09T09:10:00+09:00" })).toBe("09:10 이후");
    expect(stopWindowText({ timing: "MARKET", targetAt: null })).toBe("—");
    expect(STOP_GUIDE).not.toMatch(/\d{2}:\d{2}/);
    expect(STOP_GUIDE).toContain("'확인'");
  });
});

describe("실시간 평가와 '확인' 가격", () => {
  const POSITIONS: IsaPosition[] = [
    position(),
    position({ symbol: "222220", name: "합성화학", quantity: "50", avgPrice: 53_000, purchaseAmount: 2_650_000, lastPrice: "53000", marketValue: 2_650_000, profitLoss: 0, profitLossPct: 0, weightPct: 51.96 }),
    position({ symbol: "333330", name: "합성바이오", quantity: 10, avgPrice: 9_000, purchaseAmount: 90_000, lastPrice: null, marketValue: null, profitLoss: null, profitLossPct: null, weightPct: null }),
  ];
  const SUMMARY: IsaSummary = {
    cash: 1_200_000, marketValue: 3_900_000, totalAsset: 5_100_000, purchaseTotal: 3_940_000, profitLoss: null, profitLossPct: null,
    feesPaid: 100, taxesPaid: 200, commissionPct: 0.015, unpriced: ["333330"],
  };

  it("받은 실시간 가격이 없으면 서버 값 그대로 — 가격이 있는 종목은 '직전 종가', 기준 시각 없음", () => {
    const view = isaValuation(POSITIONS, SUMMARY, {});
    expect(view).toMatchObject({ cash: 1_200_000, marketValue: 3_900_000, totalAsset: 5_100_000, purchaseTotal: 3_940_000, profitLoss: null, unpriced: ["333330"], live: 0, close: 2, basisAt: null });
    expect(view.positions[0]).toMatchObject({ priceSource: "close", priceAt: null, marketValue: 1_250_000 });
    expect(view.positions[2].priceSource).toBeNull();
    expect(isaBasisText(view)).toBe("—");
    expect(isaBasisNote(view)).toBe("실시간 가격을 아직 받지 못해 서버가 준 직전 종가(밤 관측치)로 평가");
  });

  it("받았으면 평가액 = Σ수량 × 가격(못 받은 종목은 직전 종가), 총 잔고 = 현금 + 평가액, 종목 손익·비중을 다시 셈", () => {
    const quotes = { "111110": { price: 13_000, at: "2026-11-09T05:31:05Z" } };
    const view = isaValuation(POSITIONS, SUMMARY, quotes);
    expect(view.marketValue).toBe(3_950_000);
    expect(view.totalAsset).toBe(5_150_000);
    expect(view.profitLoss).toBeNull();
    expect(view.positions[0]).toMatchObject({ lastPrice: 13_000, marketValue: 1_300_000, profitLoss: 100_000, priceSource: "live", priceAt: "2026-11-09T05:31:05Z" });
    expect(view.positions[0].profitLossPct).toBeCloseTo((100_000 / 1_200_000) * 100, 5);
    expect(view.positions[0].weightPct).toBeCloseTo((1_300_000 / 5_150_000) * 100, 5);
    expect(view.positions[1]).toMatchObject({ priceSource: "close", marketValue: 2_650_000 });
    expect(view.unpriced).toEqual([{ symbol: "333330", name: "합성바이오" }]);
    expect(isaBasisNote(view)).toBe("실시간 1종목 · 직전 종가 1종목 — 평가액·손익·비중만 다시 계산(지시는 직전 종가)");
  });

  it("전부 받으면 손익 = 평가액 − 매입 금액 합, 기준 시각은 가장 이른 것, 쓸 수 없는 가격은 받지 않은 것으로", () => {
    const quotes = {
      "111110": { price: 13_000, at: "2026-11-09T05:31:05Z" },
      "222220": { price: 54_000, at: "2026-11-09T05:30:59Z" },
      "333330": { price: 9_500, at: null },
    };
    const view = isaValuation(POSITIONS, SUMMARY, quotes);
    expect(view.profitLoss).toBe(1_300_000 + 2_700_000 + 95_000 - 3_940_000);
    expect(view.basisAt).toBe("2026-11-09T05:30:59Z");
    expect(isaBasisText(view)).toBe("2026-11-09 14:30:59 KST");
    expect(isaValuation(POSITIONS, SUMMARY, { "111110": { price: 0, at: null } }).live).toBe(0);
    expect(isaValuation(null, null, {})).toMatchObject({ positions: [], cash: null, totalAsset: null, live: 0 });
  });


  it("정렬의 시각 값 — ISO를 ms로, 못 읽으면 null", () => {
    expect(timeSortValue("2026-11-09T00:00:00Z")).toBe(Date.parse("2026-11-09T00:00:00Z"));
    expect(timeSortValue("모름")).toBeNull();
    expect(timeSortValue(null)).toBeNull();
  });
});

describe("체결 입력 창(2026-11-09)", () => {
  const item = { id: 7, symbol: "222220", name: "합성화학", side: "SELL", quantity: 3, refPrice: 53_000, weightPct: 0, status: "PLANNED", notifiedNightAt: null, notifiedMorningAt: null };
  const stop = { id: 4, session: "2026-11-10", symbol: "111110", name: "합성전자", side: "SELL", quantity: 5, timing: "MARKET", targetAt: null, status: "PLANNED", notifiedAt: null };
  const live = { "222220": { price: 54_000, at: null } };

  it("수수료 어림 — 금액 × 수수료율, 원 미만 절사, 수수료율을 모르면 0", () => {
    expect(estimateFee(125_000, 0.015)).toBe(18);
    expect(estimateFee(125_000, null)).toBe(0);
  });

  it("줄 — 실시간 가격으로 수량·금액·단가·수수료를 채움(출처 live), 없으면 기준가(close), 그것도 없으면 빈칸", () => {
    expect(confirmLineFromInstruction(item, live, 0.015)).toMatchObject({ instructionId: 7, quantity: "3", amount: "162000", price: "54000", fee: "24", source: "live", instructed: 3, feeEdited: false });
    expect(confirmLineFromInstruction(item, {}, 0.015)).toMatchObject({ amount: "159000", price: "53000", source: "close" });
    expect(confirmLineFromStop(stop, {}, 12_000, 0.015)).toMatchObject({ stopInstructionId: 4, instructionId: null, amount: "60000", fee: "9" });
    expect(confirmLineFromStop(stop, {}, null, 0.015)).toMatchObject({ amount: "", price: "", fee: "" });
  });

  it("칸 맞추기 — 금액을 고치면 단가, 단가를 고치면 금액, 수량을 고치면 금액(단가 유지), 수수료는 직접 고치기 전까지 다시 셈, 출처는 금액·단가를 고치면 user", () => {
    let line = confirmLineFromInstruction(item, live, 0.015);
    line = updateConfirmLine(line, "amount", "150,001", 0.015);
    expect(line).toMatchObject({ amount: "150,001", price: "50000.33", fee: "22", source: "user" });
    line = updateConfirmLine(line, "price", "51000", 0.015);
    expect(line).toMatchObject({ price: "51000", amount: "153000", fee: "22" });
    line = updateConfirmLine(line, "quantity", "2", 0.015);
    expect(line).toMatchObject({ quantity: "2", amount: "102000", fee: "15" });
    line = updateConfirmLine(line, "fee", "40", 0.015);
    expect(line).toMatchObject({ fee: "40", feeEdited: true });
    line = updateConfirmLine(line, "amount", "100000", 0.015);
    expect(line).toMatchObject({ fee: "40", price: "50000" });
    const quantityOnly = updateConfirmLine(confirmLineFromInstruction(item, live, 0.015), "quantity", "2", 0.015);
    expect(quantityOnly.source).toBe("live");
    const unread = updateConfirmLine(confirmLineFromInstruction(item, live, 0.015), "amount", "abc", 0.015);
    expect(unread).toMatchObject({ amount: "abc", price: "54000" });
  });

  // QA-352: 수정 전에는 수량을 고치면 늘 단가 × 수량으로 금액을 다시 써, 직접 적은 총액이 조용히 덮어써졌다(재현 커밋에서는 it.fails).
  it("QA-352 금액을 직접 적은 뒤 수량을 고치면 금액을 지키고 단가를 다시 셈 — 단가를 마지막으로 적었으면 지금처럼 금액을 다시 셈", () => {
    const twenty = { ...item, quantity: 20, refPrice: 48_000 };
    let line = confirmLineFromInstruction(twenty, {}, 0.015);
    expect(line).toMatchObject({ quantity: "20", amount: "960000", price: "48000" });
    line = updateConfirmLine(line, "amount", "950,000", 0.015);
    expect(line).toMatchObject({ amount: "950,000", price: "47500" });
    line = updateConfirmLine(line, "quantity", "19", 0.015);
    expect(line).toMatchObject({ quantity: "19", amount: "950,000", price: "50000", fee: "142", source: "user" });
    // 그 뒤 단가를 적으면 다시 단가가 기준 — 수량을 고치면 금액이 따라감
    line = updateConfirmLine(line, "price", "49000", 0.015);
    expect(line).toMatchObject({ amount: "931000" });
    line = updateConfirmLine(line, "quantity", "20", 0.015);
    expect(line).toMatchObject({ amount: "980000", price: "49000" });
    // 읽지 못하는 수량이면 금액·단가를 건드리지 않음
    const typed = updateConfirmLine(confirmLineFromInstruction(twenty, {}, 0.015), "amount", "950000", 0.015);
    expect(updateConfirmLine(typed, "quantity", "", 0.015)).toMatchObject({ amount: "950000", price: "47500" });
  });

  it("QA-352 고치기 창 — 저장된 체결 금액은 '적은 금액'이라 수량만 고치면 금액은 그대로이고 단가가 다시 계산돼 경고가 뜸", () => {
    const trade = { id: 3, at: null, side: "BUY", symbol: "222220", name: "합성화학", quantity: 3, price: 50_000.33, amount: 150_001, fee: 30, tax: 0, realizedPnl: null, realizedPct: null, priceSource: "user", taxAssumed: false };
    const line = updateConfirmLine(confirmLineFromTrade(trade), "quantity", "2", 0.015);
    expect(line).toMatchObject({ quantity: "2", amount: "150001", price: "75000.5", fee: "30" });
    expect(confirmLineWarning(line)).toContain("높습니다");
    expect(buildEditTradeRequest(line)).toEqual({ ok: true, body: { quantity: 2, amount: 150_001, fee: 30 } });
  });

  // QA-355: 수정 전에는 수수료 칸에 경고가 없어 평균 단가를 수수료 칸에 적어도 그대로 보냈다(재현 커밋에서는 it.fails).
  it("QA-355 수수료 경고 — 체결 금액의 1%를 넘고 100원을 넘으면 글, 작은 매매의 최소 수수료·어림 수수료는 경고 없음, 단가 경고와 함께도 보임", () => {
    const swapped = { price: "54000", refPrice: 54_000, amount: "162000", fee: "54000" };
    expect(confirmLineWarning(swapped)).toContain("수수료");
    const onePercent = { price: "54000", refPrice: 54_000, amount: "162000", fee: "1620" };
    expect(confirmLineWarning(onePercent)).toBeNull();
    const tiny = { price: "500", refPrice: 500, amount: "500", fee: "100" };
    expect(confirmLineWarning(tiny)).toBeNull();
    const usual = { price: "54000", refPrice: 54_000, amount: "162000", fee: "24" };
    expect(confirmLineWarning(usual)).toBeNull();
    const both = { price: "162000", refPrice: 54_000, amount: "486000", fee: "162000" };
    expect(confirmLineWarning(both)).toContain("높습니다");
    expect(confirmLineWarning(both)).toContain("수수료");
    const unread = { price: "54000", refPrice: 54_000, amount: "abc", fee: "54000" };
    expect(confirmLineWarning(unread)).toBeNull();
  });

  it("경고 — 단가가 참고 가격에서 10% 넘게 벗어나면 글, 안이면 없음", () => {
    expect(confirmLineWarning({ price: "54000", refPrice: 53_000 })).toBeNull();
    expect(confirmLineWarning({ price: "162000", refPrice: 54_000 })).toContain("높습니다");
    expect(confirmLineWarning({ price: "", refPrice: 54_000 })).toBeNull();
  });

  it("본문 — 지시 번호·수량·금액·수수료·출처, 체결 금액이 없으면 막고, 수량은 정수만, 수수료는 비우면 0", () => {
    const line = confirmLineFromInstruction(item, live, 0.015);
    expect(buildApplyRequest([line, confirmLineFromStop(stop, {}, 12_000, 0.015)])).toEqual({
      ok: true,
      body: { items: [
        { instructionId: 7, quantity: 3, amount: 162_000, fee: 24, priceSource: "live" },
        { stopInstructionId: 4, quantity: 5, amount: 60_000, fee: 9, priceSource: "close" },
      ] },
    });
    expect(buildApplyRequest([{ ...line, amount: "" }]).ok).toBe(false);
    expect(buildApplyRequest([{ ...line, quantity: "1.5" }]).ok).toBe(false);
    expect(buildApplyRequest([{ ...line, fee: "" }])).toMatchObject({ ok: true, body: { items: [{ fee: 0 }] } });
    expect(buildApplyRequest([]).ok).toBe(false);
  });

  it("고치기 — 적어 둔 값으로 채우고 수수료를 유지, 본문은 수량·금액·수수료", () => {
    const trade = { id: 3, at: null, side: "SELL", symbol: "222220", name: "합성화학", quantity: 3, price: 50_000.33, amount: 150_001, fee: 30, tax: 300, realizedPnl: 1, realizedPct: 1, priceSource: "user", taxAssumed: false };
    const line = confirmLineFromTrade(trade);
    expect(line).toMatchObject({ quantity: "3", amount: "150001", price: "50000.33", fee: "30", feeEdited: true, instructed: null });
    expect(buildEditTradeRequest(updateConfirmLine(line, "amount", "151000", 0.015))).toEqual({ ok: true, body: { quantity: 3, amount: 151_000, fee: 30 } });
  });
});
