/**
 * ISA 계좌(ADR 0029, 명세 docs/specs/2026-11-06-isa-manual-account.md §8)의 표기·입력 검사 — lib/isa 순수 함수.
 *
 *  - 모르는 값은 "—"(0으로 채우지 않음), 숫자 글자(BigDecimal)도 읽음
 *  - 시작 매수 목록 붙여 넣기: 줄마다 '코드 수량 가격'(빈칸·탭), 천 단위 쉼표, 줄 번호가 붙은 오류, 시작 매수 합이 시작 현금보다 크면 보내지 않음
 *  - 장부 행 입력: 종류마다 쓰는 칸만 싣고, 조정은 음수 수량, 매수·매도 비용은 비우면 0, 고치기는 id·메모를 늘 실음
 *  - 서버 오류 코드(invalid-request·ledger-invalid·not-found·already-started·not-started·already-recorded)별 문구
 *  - 그 세션 개장 시각(instructions.open)으로 동시호가 안내와 체결 고치기 기본 시각(장 시간 변경일), '못 만듦' 사유별 문구,
 *    고치기에서 시각을 바꾸지 않았으면 원문 시각을 그대로(초·소수초를 잃지 않게)
 *  - 실시간 평가(명세 2026-11-06-us-costs-backfill §6): 받은 가격이 없으면 서버 값 그대로, 받았으면 평가액 = 현금 + Σ수량 × 가격(못 받은 종목은
 *    직전 종가), 손익 = 평가액 − 순입금, 비중 다시 계산, 기준 시각 = 받은 가격의 시각 중 가장 이른 것(초까지), 가격 모르는 종목은 평가에서 뺌
 *  - 장부 정렬의 시각 값(못 읽으면 null — 맨 뒤)
 * 값은 모두 합성 값입니다(실제 계좌 자료 아님).
 */
import { describe, expect, it } from "vitest";
import {
  buildLedgerRequest,
  buildStartRequest,
  canFixFill,
  canSkip,
  emptyLedgerForm,
  fillAtDefault,
  formatPrice,
  formatShares,
  formatSignedWon,
  formatWeight,
  formatWon,
  instructionStatusLabel,
  isaBasisNote,
  isaBasisText,
  isaErrorCode,
  isaErrorNeedsReload,
  canConfirmTrade,
  canUndoConfirm,
  isaErrorText,
  notifiedText as notifiedLabel,
  tradeConfirmText,
  isaValuation,
  isoFromKstInput,
  kindLabel,
  kstInputFromIso,
  kstShort,
  ledgerFields,
  ledgerFormFromInstruction,
  ledgerFormFromRow,
  ledgerRowForInstruction,
  notifiedText,
  parseDecimal,
  parseStartBuys,
  sessionLabel,
  sessionStatusLabel,
  sideLabel,
  sourceLabel,
  startBuysTotal,
  symbolText,
  timeSortValue,
  toNumber,
  stopNoteLabel,
  stopNotifiedText,
  STOP_GUIDE,
  stopTimingLabel,
  stopWindowText,
  targetClock,
  tradeGuide,
  unavailableText,
  unpricedText,
  instructionWhenText,
  PENDING_INSTRUCTIONS_GUIDE,
} from "../isa";
import type { IsaHolding, IsaInstructionItem, IsaLedgerRow, IsaSummary } from "../types/isa";

function item(over: Partial<IsaInstructionItem> = {}): IsaInstructionItem {
  return {
    id: 7, symbol: "111110", name: "합성전자", side: "BUY", quantity: 4, refPrice: 12_500, weightPct: 9.5, status: "PLANNED",
    notifiedNightAt: null, notifiedMorningAt: null, ...over,
  };
}

function row(over: Partial<IsaLedgerRow> = {}): IsaLedgerRow {
  return {
    id: 31, at: "2026-11-09T09:00:00+09:00", kind: "BUY", symbol: "111110", name: "합성전자", quantity: 4, price: 12_600, amount: null,
    fee: 0, tax: 0, source: "AUTO", instructionId: 7, note: null, ...over,
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
    expect(formatShares(-2)).toBe("-2");
    expect(formatShares(null)).toBe("—");
    expect(formatWeight(9.5)).toBe("9.50%");
    expect(formatWeight(null)).toBe("—");
  });

  it("이름표 — 모르는 값은 받은 글자 그대로, 없으면 —", () => {
    expect(kindLabel("DEPOSIT")).toBe("입금");
    expect(kindLabel("ADJUST")).toBe("조정");
    expect(kindLabel("MYSTERY")).toBe("MYSTERY");
    expect(kindLabel(null)).toBe("—");
    expect(sideLabel("SELL")).toBe("매도");
    expect(sourceLabel("AUTO")).toBe("자동(지시대로)");
    expect(sourceLabel("USER")).toBe("직접 입력");
    expect(instructionStatusLabel("PLANNED")).toBe("지시 — 체결 기록 전");
    expect(instructionStatusLabel("RECORDED")).toBe("체결 기록됨");
    expect(instructionStatusLabel("SKIPPED")).toBe("건너뜀");
    expect(sessionStatusLabel("NONE")).toBe("지시 없음");
    expect(sessionStatusLabel("UNAVAILABLE")).toBe("못 만듦");
    expect(symbolText("111110", "합성전자")).toBe("합성전자 111110");
    expect(symbolText("111110", null)).toBe("111110");
    expect(symbolText(null, null)).toBe("—");
  });

  it("세션 날짜 → 'MM/DD(요일)', 알림 시각은 밤·아침, 보낸 적 없으면 '보내기 전'", () => {
    expect(sessionLabel("2026-11-09")).toBe("11/09(월)");
    expect(sessionLabel("2026-11-06")).toBe("11/06(금)");
    expect(sessionLabel("2026-02-30")).toBe("2026-02-30");
    expect(sessionLabel(null)).toBe("—");
    expect(kstShort("2026-11-06T13:41:00Z")).toBe("11/06 22:41");
    expect(notifiedText(item())).toBe("보내기 전");
    expect(notifiedText(item({ notifiedNightAt: "2026-11-06T22:41:00+09:00", notifiedMorningAt: "2026-11-09T08:00:30+09:00" })))
      .toBe("밤 11/06 22:41 · 아침 11/09 08:00");
  });

  it("가격 모르는 종목 — 코드 글자·{symbol, name} 모두, 없으면 null", () => {
    expect(unpricedText(["222220", { symbol: "333330", name: "합성바이오" }])).toBe("222220, 합성바이오 333330");
    expect(unpricedText([])).toBeNull();
    expect(unpricedText(null)).toBeNull();
  });

  it("체결 고치기는 기록 전·기록됨, 건너뜀은 기록 전만", () => {
    expect(canFixFill(item({ status: "PLANNED" }))).toBe(true);
    expect(canFixFill(item({ status: "RECORDED" }))).toBe(true);
    expect(canFixFill(item({ status: "SKIPPED" }))).toBe(false);
    expect(canFixFill(item({ status: "SUPERSEDED" }))).toBe(false);
    expect(canSkip(item({ status: "PLANNED" }))).toBe(true);
    expect(canSkip(item({ status: "RECORDED" }))).toBe(false);
  });

  it("지시로 적힌 장부 행 — instructionId가 같은 가장 앞(최근) 행", () => {
    const ledger = [row({ id: 40, instructionId: null }), row({ id: 39, instructionId: 7, source: "USER" }), row({ id: 31 })];
    expect(ledgerRowForInstruction(ledger, 7)?.id).toBe(39);
    expect(ledgerRowForInstruction(ledger, 99)).toBeNull();
    expect(ledgerRowForInstruction(null, 7)).toBeNull();
  });
});

describe("숫자·시각 입력", () => {
  it("천 단위 쉼표는 자리가 맞을 때만, 소수 자릿수·음수는 옵션대로", () => {
    expect(parseDecimal("10,000,000", { maxDecimals: 2 })).toBe(10_000_000);
    expect(parseDecimal("1000", { maxDecimals: 0 })).toBe(1000);
    expect(parseDecimal("1,00", { maxDecimals: 2 })).toBeNull();
    expect(parseDecimal("12.345", { maxDecimals: 2 })).toBeNull();
    expect(parseDecimal("-3", { maxDecimals: 0 })).toBeNull();
    expect(parseDecimal("-3", { maxDecimals: 0, allowNegative: true })).toBe(-3);
    expect(parseDecimal("", { maxDecimals: 2 })).toBeNull();
    expect(parseDecimal("1e3", { maxDecimals: 2 })).toBeNull();
  });

  it("datetime-local ↔ KST ISO — 빈 칸은 undefined(서버가 지금으로), 모양이 틀리면 null", () => {
    expect(isoFromKstInput("2026-11-06T14:55")).toBe("2026-11-06T14:55:00+09:00");
    expect(isoFromKstInput("2026-11-06T14:55:30")).toBe("2026-11-06T14:55:30+09:00");
    expect(isoFromKstInput("")).toBeUndefined();
    expect(isoFromKstInput("내일")).toBeNull();
    expect(kstInputFromIso("2026-11-06T05:55:00Z")).toBe("2026-11-06T14:55");
    expect(kstInputFromIso("2026-11-06T14:55:00+09:00[Asia/Seoul]")).toBe("2026-11-06T14:55");
    expect(kstInputFromIso("2026-11-06T14:55:00")).toBe("2026-11-06T14:55");
    expect(kstInputFromIso(null)).toBe("");
  });
});

describe("시작 매수 목록 붙여 넣기", () => {
  it("줄마다 '코드 수량 가격' — 빈칸·탭, 천 단위 쉼표, 빈 줄 건너뜀, 코드는 대문자로", () => {
    const parsed = parseStartBuys("111110 4 12,500\n\n  0000a0\t3\t9000  \r\n222220 1 300000.5");
    expect(parsed.errors).toEqual([]);
    expect(parsed.buys).toEqual([
      { symbol: "111110", quantity: 4, price: 12_500 },
      { symbol: "0000A0", quantity: 3, price: 9000 },
      { symbol: "222220", quantity: 1, price: 300_000.5 },
    ]);
    expect(startBuysTotal(parsed.buys)).toBe(4 * 12_500 + 3 * 9000 + 300_000.5);
  });

  it("틀린 줄은 줄 번호와 무엇이 틀렸는지 — 칸 수·코드·수량·가격", () => {
    const parsed = parseStartBuys("111110 4\n12345 4 100\n111110 0 100\n111110 4 -1\n111110 4 12500");
    expect(parsed.buys).toEqual([{ symbol: "111110", quantity: 4, price: 12_500 }]);
    expect(parsed.errors).toHaveLength(4);
    expect(parsed.errors[0]).toMatch(/^1번째 줄: '코드 수량 가격' 세 칸이어야 합니다/);
    expect(parsed.errors[1]).toMatch(/^2번째 줄: 종목 코드는 여섯 자리/);
    expect(parsed.errors[2]).toMatch(/^3번째 줄: 수량은 0보다 큰 수/);
    expect(parsed.errors[3]).toMatch(/^4번째 줄: 가격은 0보다 큰 수/);
  });

  it("시작 본문 — 시작 현금 + 시작 매수, 시작 시각은 적었을 때만, 매수 없이도 됨", () => {
    expect(buildStartRequest({ cash: "5,000,000", startedAt: "", buys: "" })).toEqual({ ok: true, body: { cash: 5_000_000, buys: [] } });
    expect(buildStartRequest({ cash: "5000000", startedAt: "2026-11-06T14:55", buys: "111110 4 12500" })).toEqual({
      ok: true,
      body: { cash: 5_000_000, startedAt: "2026-11-06T14:55:00+09:00", buys: [{ symbol: "111110", quantity: 4, price: 12_500 }] },
    });
  });

  it("시작 현금이 없거나 0, 줄 오류, 시작 매수 합이 시작 현금보다 크면 보내지 않는다", () => {
    const empty = buildStartRequest({ cash: "", startedAt: "", buys: "" });
    expect(empty.ok).toBe(false);
    expect(!empty.ok && empty.errors[0]).toMatch(/시작 현금은 0보다 큰/);
    const over = buildStartRequest({ cash: "100000", startedAt: "", buys: "111110 10 12500" });
    expect(!over.ok && over.errors).toEqual([
      "시작 매수 합(125,000원)이 시작 현금(100,000원)보다 큽니다 — 현금이 음수가 되는 장부는 받지 않습니다.",
    ]);
    const bad = buildStartRequest({ cash: "100000", startedAt: "어제", buys: "x" });
    expect(!bad.ok && bad.errors).toHaveLength(2);
  });
});

describe("장부 행 입력", () => {
  it("종류마다 쓰는 칸", () => {
    expect(ledgerFields("BUY")).toEqual({ symbol: true, quantity: true, price: true, amount: false, costs: true });
    expect(ledgerFields("SELL")).toEqual({ symbol: true, quantity: true, price: true, amount: false, costs: true });
    expect(ledgerFields("ADJUST")).toEqual({ symbol: true, quantity: true, price: false, amount: false, costs: false });
    expect(ledgerFields("DEPOSIT")).toEqual({ symbol: false, quantity: false, price: false, amount: true, costs: false });
    expect(ledgerFields("WITHDRAW")).toEqual({ symbol: false, quantity: false, price: false, amount: true, costs: false });
  });

  it("매수 추가 — 종목·수량·체결가, 비용은 비우면 0, 시각·메모는 적었을 때만", () => {
    const form = { ...emptyLedgerForm("BUY"), symbol: "111110", quantity: "4", price: "12,600" };
    expect(buildLedgerRequest(form)).toEqual({
      ok: true,
      body: { kind: "BUY", symbol: "111110", quantity: 4, price: 12_600, fee: 0, tax: 0 },
    });
    const full = { ...form, fee: "150", tax: "30", at: "2026-11-09T09:00", note: "  합성 메모 " };
    expect(buildLedgerRequest(full, { instructionId: 7 })).toEqual({
      ok: true,
      body: {
        kind: "BUY", instructionId: 7, symbol: "111110", quantity: 4, price: 12_600, fee: 150, tax: 30,
        at: "2026-11-09T09:00:00+09:00", note: "합성 메모",
      },
    });
  });

  it("입금·출금은 금액만, 조정은 음수 수량(가격 없음)", () => {
    expect(buildLedgerRequest({ ...emptyLedgerForm("DEPOSIT"), amount: "1,000,000", symbol: "무시" })).toEqual({
      ok: true, body: { kind: "DEPOSIT", amount: 1_000_000 },
    });
    expect(buildLedgerRequest({ ...emptyLedgerForm("ADJUST"), symbol: "111110", quantity: "-2", price: "999" })).toEqual({
      ok: true, body: { kind: "ADJUST", symbol: "111110", quantity: -2 },
    });
  });

  it("고치기는 id를 싣고 메모를 늘 실음(지운 메모가 남지 않게)", () => {
    const form = ledgerFormFromRow(row({ note: "합성" }));
    expect(form).not.toBeNull();
    const result = buildLedgerRequest({ ...(form as NonNullable<typeof form>), note: "" }, { id: 31, instructionId: 7 });
    expect(result).toEqual({
      ok: true,
      body: { kind: "BUY", id: 31, instructionId: 7, symbol: "111110", quantity: 4, price: 12_600, fee: 0, tax: 0, at: "2026-11-09T09:00:00+09:00", note: "" },
    });
  });

  it("틀린 입력은 보내지 않고 고칠 것을 적는다", () => {
    const result = buildLedgerRequest({ ...emptyLedgerForm("SELL"), symbol: "12", quantity: "-1", price: "0", fee: "x", at: "nope" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toEqual([
      "종목 코드는 여섯 자리입니다(예: 005930).",
      "수량은 0보다 큰 수입니다.",
      "체결가는 0보다 큰 원 단위 가격입니다.",
      "수수료는 0 이상의 원 단위 금액입니다(비우면 0).",
      "시각을 알아볼 수 없습니다 — 비우면 지금 시각으로 적습니다.",
    ]);
    const adjust = buildLedgerRequest({ ...emptyLedgerForm("ADJUST"), symbol: "111110", quantity: "0" });
    expect(!adjust.ok && adjust.errors).toEqual(["조정 수량은 0이 아닌 수입니다(줄면 음수)."]);
    expect(buildLedgerRequest({ ...emptyLedgerForm("WITHDRAW"), amount: "" }).ok).toBe(false);
  });

  it("장부 행 → 입력 — 모르는 종류는 고칠 수 없음(null)", () => {
    expect(ledgerFormFromRow(row())).toEqual({
      kind: "BUY", symbol: "111110", quantity: "4", price: "12600", amount: "", fee: "0", tax: "0", at: "2026-11-09T09:00", note: "",
    });
    expect(ledgerFormFromRow(row({ kind: "MYSTERY" }))).toBeNull();
  });

  it("지시 → 체결 고치기 입력 — 적힌 행이 있으면 그 행, 없으면 방향·종목·수량(체결가는 비움)", () => {
    expect(ledgerFormFromInstruction(item({ side: "SELL", quantity: 3 }), null)).toEqual({
      ...emptyLedgerForm("SELL"), symbol: "111110", quantity: "3",
    });
    expect(ledgerFormFromInstruction(item(), row({ price: 12_700 })).price).toBe("12700");
  });
});

describe("서버 오류 코드", () => {
  it("ApiError의 code 칸을 정확히 비교하고, 없으면 문구 안의 코드 글자", () => {
    expect(isaErrorCode({ code: "ledger-invalid", message: "현금이 음수" })).toBe("ledger-invalid");
    expect(isaErrorCode({ code: "something-else", message: "ledger-invalid" })).toBeNull();
    expect(isaErrorCode({ code: null, message: "409 already-started" })).toBe("already-started");
    expect(isaErrorCode(new Error("요청 실패 (HTTP 500)"))).toBeNull();
    expect(isaErrorCode(null)).toBeNull();
  });

  it("코드별 문구 — 서버 문구를 덧붙이고, 화면과 서버가 어긋난 오류는 다시 읽기", () => {
    expect(isaErrorText("invalid-request", "quantity가 비었습니다")).toBe("입력이 올바르지 않습니다 — quantity가 비었습니다");
    expect(isaErrorText("invalid-request", null)).toBe("입력이 올바르지 않습니다. 칸을 확인하세요.");
    expect(isaErrorText("ledger-invalid", "현금 -1")).toBe(
      "이 행을 적으면 현금이나 보유 수량이 음수가 됩니다 — 수량·가격·금액을 확인하세요. (현금 -1)",
    );
    expect(isaErrorText("not-found", "x")).toMatch(/^그 행이나 지시를 찾지 못했습니다/);
    expect(isaErrorText("already-started", null)).toMatch(/^이미 시작한 계좌입니다 — 시작은 한 번만/);
    expect(isaErrorText("not-started", null)).toMatch(/^아직 시작하지 않은 계좌입니다/);
    expect(isaErrorText(null, "서버 문구")).toBe("서버 문구");
    expect(isaErrorText(null, null)).toBe("요청을 처리하지 못했습니다.");
    expect(["invalid-request", "ledger-invalid", "not-found", "already-started", "not-started"].map((code) =>
      isaErrorNeedsReload(code as Parameters<typeof isaErrorNeedsReload>[0]))).toEqual([false, false, true, true, true]);
  });
});

describe("그 세션 개장 시각(ISA-R6) — 장 시간 변경일", () => {
  it("동시호가 안내는 개장 30분 전부터 개장까지 — 모르면 08:30~09:00", () => {
    expect(tradeGuide("2026-11-19T10:00:00+09:00")).toMatch(/^장전 동시호가\(09:30~10:00\)에 시장가로 내면 규칙 계좌와 같은 시가에 체결됩니다/);
    expect(tradeGuide("2026-11-19T01:00:00Z")).toMatch(/^장전 동시호가\(09:30~10:00\)/);
    expect(tradeGuide("2026-11-09T09:00:00+09:00")).toMatch(/^장전 동시호가\(08:30~09:00\)/);
    expect(tradeGuide(null)).toMatch(/^장전 동시호가\(08:30~09:00\)/);
    expect(tradeGuide("모름")).toMatch(/^장전 동시호가\(08:30~09:00\)/);
    expect(tradeGuide(null)).toContain("'체결 고치기'로 고치세요");
  });

  it("체결 고치기 기본 시각 — 개장 시각, 모르면 그 세션 09:00, 세션도 모르면 빈 칸", () => {
    expect(fillAtDefault("2026-11-19", "2026-11-19T10:00:00+09:00")).toBe("2026-11-19T10:00");
    expect(fillAtDefault("2026-11-19", "2026-11-19T01:00:00Z")).toBe("2026-11-19T10:00");
    expect(fillAtDefault("2026-11-09", null)).toBe("2026-11-09T09:00");
    expect(fillAtDefault("2026-11-09", "모름")).toBe("2026-11-09T09:00");
    expect(fillAtDefault(null, null)).toBe("");
  });
});

describe("'못 만듦' 사유별 문구(ISA-API-4)", () => {
  it("앞 지시 기록 대기·시가 밖 시점 주문은 할 일을, 그 밖·없음은 중립 문구", () => {
    expect(unavailableText("record-pending")).toContain("앞 세션 지시를 체결 고치기·건너뜀으로 처리하세요");
    expect(unavailableText("timed-orders")).toContain(
      "규칙 계좌가 시가 밖 시점으로 주문해 ISA는 이번 세션 시가 지시를 만들지 않았습니다",
    );
    for (const reason of ["decision-pending", "price-missing", null, undefined, ""]) {
      const text = unavailableText(reason);
      expect(text).toMatch(/^이 세션의 지시를 만들지 못했습니다/);
      expect(text).not.toContain("규칙 계좌의 목표를 다 받지 못한");
      expect(text).not.toContain("앞 세션 지시");
      expect(text).not.toContain("시가 밖 시점");
    }
  });
});

describe("고치기의 시각 원문(ISA-API-1)", () => {
  const original = "2026-11-06T05:55:37.123456Z";

  it("시각 칸을 바꾸지 않았으면 원문 시각을 그대로 싣는다(초·소수초 — 같은 순간의 시작 입금보다 앞에 놓이지 않게)", () => {
    const form = ledgerFormFromRow(row({ id: 32, at: original, instructionId: null, source: "USER", note: "시작 매수" }));
    expect(form?.at).toBe("2026-11-06T14:55");
    const result = buildLedgerRequest({ ...(form as NonNullable<typeof form>), fee: "15" }, { id: 32, originalAt: original });
    expect(result.ok && result.body.at).toBe(original);
  });

  it("시각을 바꾸면 고친 시각(KST), 원문을 모르면 지금처럼", () => {
    const form = ledgerFormFromRow(row({ at: original })) as NonNullable<ReturnType<typeof ledgerFormFromRow>>;
    const moved = buildLedgerRequest({ ...form, at: "2026-11-06T15:10" }, { id: 31, originalAt: original });
    expect(moved.ok && moved.body.at).toBe("2026-11-06T15:10:00+09:00");
    expect(buildLedgerRequest(form, { id: 31 }).ok && buildLedgerRequest(form, { id: 31 })).toMatchObject({
      body: { at: "2026-11-06T14:55:00+09:00" },
    });
    expect(buildLedgerRequest(form, { id: 31, originalAt: null }).ok && buildLedgerRequest(form, { id: 31, originalAt: null }))
      .toMatchObject({ body: { at: "2026-11-06T14:55:00+09:00" } });
  });
});

describe("이미 적힌 지시(already-recorded)", () => {
  it("코드·문구·다시 읽기 — 그 지시에 직접 적은 행이 이미 있으면 그 행을 고치게", () => {
    expect(isaErrorCode({ code: "already-recorded", message: "이미 체결이 적힌 지시" })).toBe("already-recorded");
    expect(isaErrorCode({ code: null, message: "409 already-recorded" })).toBe("already-recorded");
    expect(isaErrorText("already-recorded", "x")).toMatch(/^이 지시에는 이미 직접 적은 체결 행이 있습니다/);
    expect(isaErrorText("already-recorded", null)).toContain("체결 고치기");
    expect(isaErrorNeedsReload("already-recorded")).toBe(true);
  });
});

describe("실시간 평가(명세 2026-11-06-us-costs-backfill §6)", () => {
  const HOLDINGS: IsaHolding[] = [
    { symbol: "111110", name: "합성전자", quantity: 100, avgPrice: 12_000, lastPrice: 12_500, marketValue: 1_250_000, weightPct: 24.51 },
    { symbol: "222220", name: "합성화학", quantity: "50", avgPrice: 53_000, lastPrice: "53000", marketValue: 2_650_000, weightPct: 51.96 },
    { symbol: "333330", name: "합성바이오", quantity: 10, avgPrice: 9_000, lastPrice: null, marketValue: null, weightPct: null },
  ];
  const SUMMARY: IsaSummary = {
    // 가격 모르는 보유(333330)가 있어 서버도 손익을 비움(ManualAccountService — 평가액은 아는 종목만).
    cash: 1_200_000, marketValue: 3_900_000, equity: 5_100_000, netDeposit: 5_000_000, profitLoss: null, profitLossPct: null, unpriced: ["333330"],
  };

  it("받은 실시간 가격이 없으면 서버 값 그대로 — 가격이 있는 종목은 '직전 종가', 기준 시각 없음", () => {
    const view = isaValuation(HOLDINGS, SUMMARY, {});
    expect(view).toMatchObject({
      cash: 1_200_000, marketValue: 3_900_000, equity: 5_100_000, netDeposit: 5_000_000, profitLoss: null, profitLossPct: null,
      unpriced: ["333330"], live: 0, close: 2, basisAt: null,
    });
    expect(view.holdings.map((row) => [row.symbol, row.priceSource, row.marketValue, row.weightPct])).toEqual([
      ["111110", "close", 1_250_000, 24.51],
      ["222220", "close", 2_650_000, 51.96],
      ["333330", null, null, null],
    ]);
    expect(isaBasisText(view)).toBe("—");
    expect(isaBasisNote(view)).toBe("실시간 가격을 아직 받지 못해 서버가 준 직전 종가(밤 관측치)로 평가");
  });

  it("받았으면 평가액 = 현금 + Σ수량 × 가격(못 받은 종목은 직전 종가), 비중을 다시 센다 — 가격 모르는 보유가 남으면 손익·손익률은 null(서버와 같음)", () => {
    const view = isaValuation(HOLDINGS, SUMMARY, { "111110": { price: 13_000, at: "2026-11-09T05:31:05Z" } });
    expect(view.marketValue).toBe(1_300_000 + 2_650_000);
    expect(view.equity).toBe(5_150_000);
    expect(view.profitLoss).toBeNull();
    expect(view.profitLossPct).toBeNull();
    expect(view.live).toBe(1);
    expect(view.close).toBe(1);
    const [live, close, unknown] = view.holdings;
    expect(live).toMatchObject({ lastPrice: 13_000, marketValue: 1_300_000, priceSource: "live", priceAt: "2026-11-09T05:31:05Z" });
    expect(live.weightPct).toBeCloseTo((1_300_000 / 5_150_000) * 100, 10);
    expect(close).toMatchObject({ lastPrice: 53_000, marketValue: 2_650_000, priceSource: "close", priceAt: null });
    expect(close.weightPct).toBeCloseTo((2_650_000 / 5_150_000) * 100, 10);
    // 가격을 모르는 종목은 0으로 채우지 않고 평가에서 뺍니다.
    expect(unknown).toMatchObject({ lastPrice: null, marketValue: null, weightPct: null, priceSource: null });
    expect(view.unpriced).toEqual([{ symbol: "333330", name: "합성바이오" }]);
    expect(isaBasisNote(view)).toBe("실시간 1종목 · 직전 종가 1종목 — 평가액·손익·비중만 다시 계산(장부·지시는 직전 종가)");
  });

  it("기준 시각은 받은 가격의 시각 중 가장 이른 것(초까지) — 직전 종가 종목은 넣지 않고, 시각을 모르는 가격은 건너뜀", () => {
    const view = isaValuation(HOLDINGS, SUMMARY, {
      "111110": { price: 13_000, at: "2026-11-09T05:31:05Z" },
      "222220": { price: 54_000, at: "2026-11-09T05:30:59Z" },
      "333330": { price: 9_500, at: null },
    });
    expect(view.basisAt).toBe("2026-11-09T05:30:59Z");
    expect(isaBasisText(view)).toBe("2026-11-09 14:30:59 KST");
    expect(view.live).toBe(3);
    expect(view.close).toBe(0);
    expect(view.unpriced).toEqual([]);
    expect(view.equity).toBe(1_200_000 + 1_300_000 + 2_700_000 + 95_000);
    // 서버 목록에서 가격을 몰랐던 종목도 실시간 가격을 받았으니 손익 = 평가액 − 순입금
    expect(view.profitLoss).toBe(295_000);
    expect(view.profitLossPct).toBeCloseTo(5.9, 10);
    expect(isaBasisNote(view)).toBe("실시간 3종목 — 평가액·손익·비중만 다시 계산(장부·지시는 직전 종가)");
  });

  it("쓸 수 없는 가격(0·음수·NaN)은 받지 않은 것으로, 현금·순입금을 모르면 평가액·손익은 —(null)", () => {
    expect(isaValuation(HOLDINGS, SUMMARY, { "111110": { price: 0, at: "2026-11-09T05:31:05Z" } }).live).toBe(0);
    expect(isaValuation(HOLDINGS, SUMMARY, { "111110": { price: Number.NaN, at: null } }).live).toBe(0);
    const unknownCash = isaValuation(HOLDINGS, { ...SUMMARY, cash: null }, { "111110": { price: 13_000, at: null } });
    expect(unknownCash.equity).toBeNull();
    expect(unknownCash.profitLoss).toBeNull();
    expect(unknownCash.holdings[0].weightPct).toBeNull();
    // 순입금 0·음수는 손익률만 null — 가격 모르는 보유가 없는 두 종목으로 재서 이 조건 하나만 보게 함(손익은 값이 있음).
    const priced = HOLDINGS.slice(0, 2);
    const zeroDeposit = isaValuation(priced, { ...SUMMARY, netDeposit: 0, unpriced: [] }, { "111110": { price: 13_000, at: null } });
    expect(zeroDeposit.profitLoss).toBe(1_200_000 + 1_300_000 + 2_650_000);
    expect(zeroDeposit.profitLossPct).toBeNull();
    const negativeDeposit = isaValuation(priced, { ...SUMMARY, netDeposit: -1, unpriced: [] }, { "111110": { price: 13_000, at: null } });
    expect(negativeDeposit.profitLoss).toBe(1_200_000 + 1_300_000 + 2_650_000 + 1);
    expect(negativeDeposit.profitLossPct).toBeNull();
    const pricedUnknownCash = isaValuation(priced, { ...SUMMARY, cash: null, unpriced: [] }, { "111110": { price: 13_000, at: null } });
    expect(pricedUnknownCash.profitLoss).toBeNull();
    expect(isaValuation(null, null, {})).toMatchObject({ holdings: [], equity: null, live: 0, close: 0, unpriced: [] });
  });

  it("장부 정렬의 시각 값 — ISO를 ms로, 못 읽으면 null", () => {
    expect(timeSortValue("2026-11-09T09:00:00+09:00")).toBe(Date.parse("2026-11-09T00:00:00Z"));
    expect(timeSortValue("2026-11-09T09:00:00+09:00[Asia/Seoul]")).toBe(Date.parse("2026-11-09T00:00:00Z"));
    expect(timeSortValue(null)).toBeNull();
    expect(timeSortValue("")).toBeNull();
    expect(timeSortValue("모름")).toBeNull();
  });
});

describe("개장 10분 뒤 시각 맞추기·장중 스탑 지시(ADR 0033)", () => {
  it("tradeGuide — targetAt이 있으면 'HH:MM 이후 시장가', 없으면 장전 동시호가 글 그대로", () => {
    expect(tradeGuide("2026-11-10T09:00:00+09:00", "2026-11-10T00:10:00Z")).toMatch(/^09:10 이후 시장가로 내면 규칙 계좌와 같은 때\(09:10\)에 체결됩니다/);
    expect(tradeGuide("2026-11-19T10:00:00+09:00", "2026-11-19T10:10:00+09:00")).toContain("10:10 이후 시장가");
    expect(tradeGuide("2026-11-10T09:00:00+09:00", null)).toMatch(/^장전 동시호가\(08:30~09:00\)/);
    expect(tradeGuide(null, "모름")).toMatch(/^장전 동시호가/);
    expect(targetClock("2026-11-10T00:10:00Z")).toBe("09:10");
    expect(targetClock(null)).toBeNull();
  });

  it("스탑 지시 — 방식·메모·알림 이름표, 모르는 값은 받은 글자", () => {
    expect(stopTimingLabel("MARKET")).toBe("장중 시장가");
    expect(stopTimingLabel("AT_MINUTE")).toBe("장중 시장가");
    expect(stopTimingLabel("NEXT_CLOSE")).toBe("종가 단일가 시장가");
    expect(stopTimingLabel("NEW")).toBe("NEW");
    expect(stopTimingLabel(null)).toBe("—");
    expect(stopNoteLabel("close-fallback")).toBe("1분봉이 없어 그날 종가로 어림");
    expect(stopNoteLabel(null)).toBe("—");
    expect(stopNotifiedText({ notifiedAt: "2026-11-09T11:30:10+09:00" })).toBe("알림 11/09 11:30");
    expect(stopNotifiedText({ notifiedAt: null })).toBe("보내기 전");
  });

  // QA-324: 리뷰 TXT-7 — 스탑 지시 메모의 no-price(다음 날 07:00까지 값 없음)·restored(DB 복원 멈춤)가 영어 글자 그대로 보이고, 개장 10분 뒤 시각 맞추기
  // 지시의 건너뜀 확인 창·'처리 안 된 지난 지시' 안내가 '시가'라고만 적었음.
  it("스탑 지시 메모 no-price·restored는 우리말, 시각 맞추기 지시의 건너뜀 머리는 'HH:MM 이후 시장가', 지난 지시 안내는 두 경우", () => {
    expect(stopNoteLabel("no-price")).toBe("값을 구하지 못해 건너뜀(다음 날 07:00)");
    expect(stopNoteLabel("restored")).toBe("DB 복원으로 건너뜀");
    expect(instructionWhenText({ session: "2026-11-10", targetAt: "2026-11-10T00:10:00Z" })).toBe("11/10(화) 09:10 이후 시장가 ");
    expect(instructionWhenText({ session: "2026-11-06", targetAt: null })).toBe("11/06(금) 시가 ");
    expect(instructionWhenText({ session: null, targetAt: "2026-11-10T00:10:00Z" })).toBe("");
    expect(PENDING_INSTRUCTIONS_GUIDE).toContain("그 세션 시가(개장 10분 뒤 시각 맞추기 지시는 그 시각의 1분봉 값)가 들어오면");
  });

  // QA-314: 매도 창은 그 줄의 기준 시각(서버 targetAt)에서 셈 — 장 시간 변경일(2026-11-19 10:00~16:30)도 그날 시각, 고정 09:10·15:20~15:30이 아님.
  it("stopWindowText — 종가 단일가는 마감 10분 전~마감, 장중 시장가는 기준 시각 이후, 모르면 '—'", () => {
    expect(stopWindowText({ timing: "NEXT_CLOSE", targetAt: "2026-11-06T15:30:00+09:00" })).toBe("15:20~15:30");
    expect(stopWindowText({ timing: "NEXT_CLOSE", targetAt: "2026-11-19T07:30:00Z" })).toBe("16:20~16:30");
    expect(stopWindowText({ timing: "AT_MINUTE", targetAt: "2026-11-19T01:10:00Z" })).toBe("10:10 이후");
    expect(stopWindowText({ timing: "AT_MINUTE", targetAt: "2026-11-09T09:10:00+09:00" })).toBe("09:10 이후");
    expect(stopWindowText({ timing: "MARKET", targetAt: "2026-11-09T11:32:00+09:00" })).toBe("11:32 이후");
    expect(stopWindowText({ timing: "MARKET", targetAt: null })).toBe("—");
    expect(stopWindowText({ timing: "NEW", targetAt: "2026-11-09T11:32:00+09:00" })).toBe("—");
    expect(STOP_GUIDE).not.toMatch(/\d{2}:\d{2}/);
  });
});

describe("장 중반 매매 확인(2026-11-08)", () => {
  it("'매매함'은 기록 전·기록된 지시 가운데 표시도 사용자 체결도 없을 때만, 지우기는 표시가 있을 때만", () => {
    expect(canConfirmTrade({ status: "PLANNED" })).toBe(true);
    expect(canConfirmTrade({ status: "RECORDED", recordedByUser: false, confirmedAt: null })).toBe(true);
    expect(canConfirmTrade({ status: "RECORDED", recordedByUser: true })).toBe(false);
    expect(canConfirmTrade({ status: "PLANNED", confirmedAt: "2026-11-09T01:00:00Z" })).toBe(false);
    expect(canConfirmTrade({ status: "SKIPPED" })).toBe(false);
    expect(canUndoConfirm({ status: "PLANNED", confirmedAt: "2026-11-09T01:00:00Z" })).toBe(true);
    expect(canUndoConfirm({ status: "PLANNED", confirmedAt: null })).toBe(false);
    expect(canUndoConfirm({ status: "SKIPPED", confirmedAt: "2026-11-09T01:00:00Z" })).toBe(false);
  });
  it("매매 확인 칸·알림 칸의 글", () => {
    expect(tradeConfirmText({ status: "PLANNED" })).toBe("확인 전");
    expect(tradeConfirmText({ status: "RECORDED", recordedByUser: true })).toBe("체결 기록함");
    expect(tradeConfirmText({ status: "PLANNED", confirmedAt: "2026-11-09T01:00:00Z" })).toMatch(/^매매함 /);
    expect(tradeConfirmText({ status: "SKIPPED" })).toBe("—");
    expect(notifiedLabel({ notifiedNightAt: null, notifiedMorningAt: null, notifiedMiddayAt: "2026-11-09T03:15:00Z" })).toMatch(/^장 중반 /);
  });
});
