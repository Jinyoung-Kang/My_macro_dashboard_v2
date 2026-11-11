/**
 * 실제 매매(ADR 0028) 표기·판단 순수 함수(lib/realtrade).
 *
 *  - 끄기 단추는 꺼짐을 확실히 읽었을 때만 숨긴다(읽기 실패·읽을 수 없음·모르는 상태면 보임)
 *  - 켜기는 꺼짐 + 서버 두 스위치 켜짐 + 지원 시장일 때만, 아니면 이유
 *  - 상태 칩(꺼짐·켜짐·매수 멈춤·멈춤(사유)·끄는 중·서버에서 꺼짐)
 *  - 손실 한도 입력(1~50, 소수 둘째 자리), 기준 대비 손익·멈춤선, 모르는 값은 null/"—"
 *  - 서버 오류 코드 읽기(code 칸은 정확히 비교, 없을 때만 문구 안 코드·409 어림)와 코드별 문구, 모르면 서버 문구 그대로
 *  - 손실 한도 표시(baselineTotal이 오면 상한 없는 총액 기준), 미체결 취소 불가(서버 스위치 꺼짐), 정기 작업 멈춤(기동 뒤 주기 없음·서버 시각 기준),
 *    비상 순서 문구, 취소 포기·결과 모름 건수와 끄기 뒤 안내의 우선순위
 *  - 시각·창·이벤트·건너뜀 표기 — 모르는 코드는 받은 글자 그대로
 *  - RT3-UI-1: 수집기 상태를 읽지 못함(collector null·사유 status-unreadable)은 '서버에서 꺼짐'이 아니라 '서버 상태를 읽지 못함 — 다시 읽는 중'
 *    (미체결 취소 불가 판단은 모름을 켜짐으로 보지 않음), 이상 멈춤 사유 collector-disabled 이름표
 *  - RT3-UI-3: 끄기 뒤 표시는 다시 켜짐으로 돌아오거나(끄는 중·꺼짐을 본 뒤) 끄기 응답보다 큰 버전의 켜짐·이상 멈춤을 받으면 지운다
 */
import { describe, expect, it } from "vitest";
import {
  actionDoneText,
  skipDayText,
  ACTION_TIMEOUT_MS,
  actionTimeoutText,
  DISABLE_TIMEOUT_MS,
  requestTimedOut,
  preflightNote,
  baselineDelta,
  cancelBlocked,
  cancelGaveUpCount,
  cancelGaveUpText,
  canResume,
  canUpdate,
  CONFIRM_TEXT,
  disableDoneUnresolvedText,
  disableFeedback,
  EMERGENCY_STEPS,
  enableBlock,
  eventDetailText,
  eventKindLabel,
  formatSignedWon,
  formatWon,
  haltReasonLabel,
  jobStallText,
  jobStalled,
  kstClock,
  limitRows,
  lossLimitText,
  lossLine,
  nextDisableSentMark,
  orderStatusText,
  parseLossLimit,
  realTradeChip,
  realTradeErrorCode,
  realTradeErrorText,
  realTradePnl,
  SERVER_UNKNOWN_TEXT,
  serverEnabled,
  serverSwitchState,
  serverSwitchText,
  serverUnknownText,
  showDisable,
  showDisableError,
  previewImmediateText,
  previewTimingText,
  skippedText,
  sourceBookLabel,
  toNumber,
  unresolvedOffCount,
  windowText,
} from "@/lib/realtrade";

const ON = { collector: true, backend: true, reason: null };

describe("단추를 보이는 조건", () => {
  it("끄기는 켜짐·멈춤·끄는 중·모르는 상태·읽기 실패·읽을 수 없음이면 보이고, 꺼짐을 읽었을 때만 숨긴다", () => {
    for (const state of ["LIVE", "HALTED", "STOPPING", "SOMETHING_NEW"]) {
      expect(showDisable({ available: true, state }, false), state).toBe(true);
    }
    expect(showDisable({ available: true, state: "OFF" }, false)).toBe(false);
    expect(showDisable({ available: true, state: "OFF" }, true)).toBe(true);
    expect(showDisable(null, true)).toBe(true);
    expect(showDisable(null, false)).toBe(true);
    expect(showDisable({ available: false, state: "OFF" }, false)).toBe(true);
  });

  // 끄기 요청이 실패(시간 한도 포함)했더라도 그 뒤 확실히 읽은 상태가 끄는 중·꺼짐이면 요청은 처리된 것이다(QA-345 — 독립 검토).
  it("QA-345: 끄기 실패 안내는 다시 읽은 상태가 끄는 중·꺼짐이면 내리고, 상태를 모르거나 아직 켜짐·멈춤이면 남긴다", () => {
    expect(showDisableError(null, { available: true, state: "LIVE" }, false)).toBe(false);
    for (const state of ["LIVE", "HALTED"]) {
      expect(showDisableError("응답 없음", { available: true, state }, false), state).toBe(true);
    }
    for (const state of ["OFF", "STOPPING"]) {
      expect(showDisableError("응답 없음", { available: true, state }, false), state).toBe(false);
      expect(showDisableError("응답 없음", { available: true, state }, true), `${state} — 다시 읽기 실패`).toBe(true);
    }
    expect(showDisableError("응답 없음", null, false)).toBe(true);
    expect(showDisableError("응답 없음", { available: false, state: "OFF" }, false)).toBe(true);
  });

  it("켜기는 꺼짐 + 서버 두 스위치 + 지원 시장일 때만 — 아니면 이유", () => {
    const base = { available: true, supported: true, state: "OFF", serverEnabled: ON };
    expect(enableBlock(base)).toBeNull();
    expect(enableBlock({ ...base, serverEnabled: { ...ON, collector: false, reason: "disabled" } })).toMatch(/서버 스위치/);
    expect(enableBlock({ ...base, serverEnabled: { ...ON, backend: null } })).toMatch(/서버 스위치/);
    expect(enableBlock({ ...base, state: "LIVE" })).toMatch(/꺼져 있을 때만/);
    expect(enableBlock({ ...base, supported: false })).toMatch(/준비 중/);
    expect(enableBlock({ ...base, available: false })).toMatch(/읽지 못해/);
    expect(enableBlock(null)).toMatch(/읽지 못해/);
  });

  it("SEC-5: 서버 스위치가 꺼졌는데(또는 모름) 끄는 중·멈춤이거나 미종료 주문이 있으면 '이 기능이 미체결을 취소할 수 없음'", () => {
    const off = { collector: false, backend: true, reason: "disabled" };
    expect(cancelBlocked({ state: "STOPPING", serverEnabled: off })).toBe(true);
    expect(cancelBlocked({ state: "HALTED", serverEnabled: { ...ON, backend: false } })).toBe(true);
    expect(cancelBlocked({ state: "STOPPING", serverEnabled: null })).toBe(true);
    expect(cancelBlocked({ state: "LIVE", serverEnabled: off, unfinishedOrders: 2 })).toBe(true);
    expect(cancelBlocked({ state: "OFF", serverEnabled: off, unfinishedOrders: 1 })).toBe(true);
    // 서버 스위치가 켜져 있으면 정기 작업이 취소를 보냅니다.
    expect(cancelBlocked({ state: "STOPPING", serverEnabled: ON, unfinishedOrders: 3 })).toBe(false);
    // 켜짐·꺼짐에 미종료 주문이 없거나 그 칸이 없으면 상태만 봅니다.
    expect(cancelBlocked({ state: "LIVE", serverEnabled: off, unfinishedOrders: 0 })).toBe(false);
    expect(cancelBlocked({ state: "LIVE", serverEnabled: off })).toBe(false);
    expect(cancelBlocked({ state: "OFF", serverEnabled: off })).toBe(false);
    expect(cancelBlocked(null)).toBe(false);
  });

  it("RT-BE-6: 켜짐·멈춤·끄는 중인데 정기 작업의 마지막 주기가 3분 넘게 지났으면 멈춘 것으로 본다", () => {
    const now = Date.parse("2026-11-06T00:10:00Z");
    expect(jobStalled({ state: "LIVE", jobLastCycleAt: "2026-11-06T00:06:59Z" }, now)).toBe(true);
    // 한 주기 안에서 수집기 시간 초과가 겹쳐 1~3분 걸리는 것은 멈춤이 아닙니다(오탐 방지).
    expect(jobStalled({ state: "LIVE", jobLastCycleAt: "2026-11-06T00:08:00Z" }, now)).toBe(false);
    expect(jobStalled({ state: "HALTED", jobLastCycleAt: "2026-11-06T09:05:00+09:00" }, now)).toBe(true);
    expect(jobStalled({ state: "STOPPING", jobLastCycleAt: "2026-11-06T00:00:00.123456789Z" }, now)).toBe(true);
    // 시간대가 없으면 KST로 읽습니다(09:05 KST = 00:05Z → 5분 지남).
    expect(jobStalled({ state: "LIVE", jobLastCycleAt: "2026-11-06T09:05:00" }, now)).toBe(true);
    expect(jobStalled({ state: "LIVE", jobLastCycleAt: "2026-11-06T09:09:55" }, now)).toBe(false);
    expect(jobStalled({ state: "LIVE", jobLastCycleAt: "2026-11-06T00:09:30Z" }, now)).toBe(false);
    // 꺼짐이면 정기 작업이 할 일이 없고, 값이 없거나(null — 기동 뒤 아직 주기 없음) 못 읽으면 판단하지 않습니다.
    expect(jobStalled({ state: "OFF", jobLastCycleAt: "2026-11-06T00:00:00Z" }, now)).toBe(false);
    expect(jobStalled({ state: "LIVE", jobLastCycleAt: null }, now)).toBe(false);
    expect(jobStalled({ state: "LIVE" }, now)).toBe(false);
    expect(jobStalled({ state: "LIVE", jobLastCycleAt: "어제" }, now)).toBe(false);
    expect(jobStalled(null, now)).toBe(false);
  });

  it("RT2-FE-2: 기동 뒤 한 주기도 끝내지 못했으면 기동 시각(jobStartedAt)으로 판단하고, 기준은 응답의 서버 시각(serverTime — 없으면 받은 시각)", () => {
    const received = Date.parse("2026-11-06T00:10:00Z");
    const serverTime = "2026-11-06T00:10:00.123456Z";
    // 주기를 끝낸 적 없음 + 기동 181초 뒤 → 멈춤, 기동 1분 뒤 → 아님.
    expect(jobStalled({ state: "LIVE", jobLastCycleAt: null, jobStartedAt: "2026-11-06T00:06:59Z", serverTime }, received)).toBe(true);
    expect(jobStalled({ state: "STOPPING", jobStartedAt: "2026-11-06T00:06:59Z" }, received)).toBe(true);
    expect(jobStalled({ state: "LIVE", jobLastCycleAt: null, jobStartedAt: "2026-11-06T00:09:00Z", serverTime }, received)).toBe(false);
    // 마지막 주기가 있으면 그것이 먼저입니다(기동은 오래전이어도 주기는 돌고 있음).
    expect(jobStalled({ state: "LIVE", jobLastCycleAt: "2026-11-06T00:09:50Z", jobStartedAt: "2026-11-05T00:00:00Z", serverTime }, received)).toBe(false);
    // 둘 다 null(백엔드 스위치·스케줄러 꺼짐)이면 판단하지 않습니다.
    expect(jobStalled({ state: "LIVE", jobLastCycleAt: null, jobStartedAt: null, serverTime }, received)).toBe(false);

    // 브라우저 시계가 5분 빨라도(받은 시각이 5분 뒤) 서버 시각 기준이면 거짓 멈춤이 없고, 느려도 진짜 멈춤은 잡습니다.
    const fast = received + 5 * 60_000;
    expect(jobStalled({ state: "LIVE", jobLastCycleAt: "2026-11-06T00:09:50Z", serverTime }, fast)).toBe(false);
    const slow = received - 10 * 60_000;
    expect(jobStalled({ state: "LIVE", jobLastCycleAt: "2026-11-06T00:06:00Z", serverTime }, slow)).toBe(true);
    // 서버 시각을 못 읽으면 받은 시각으로 대신합니다.
    expect(jobStalled({ state: "LIVE", jobLastCycleAt: "2026-11-06T00:09:50Z", serverTime: "모름" }, fast)).toBe(true);
    expect(jobStalled({ state: "LIVE", jobLastCycleAt: "2026-11-06T00:09:50Z", serverTime: null }, received)).toBe(false);
  });

  it("RT2-FE-2: 멈춤 배너의 마지막 주기 글 — 주기가 있으면 그 시각, 없으면 '기동 뒤 끝낸 주기 없음'", () => {
    expect(jobStallText({ jobLastCycleAt: "2026-11-06T00:06:59Z", jobStartedAt: "2026-11-06T00:00:00Z" })).toBe("마지막 주기 09:06:59");
    expect(jobStallText({ jobLastCycleAt: null, jobStartedAt: "2026-11-06T00:06:59Z" })).toBe("기동 뒤 끝낸 주기 없음(기동 09:06:59)");
    expect(jobStallText({ jobStartedAt: null })).toBe("기동 뒤 끝낸 주기 없음(기동 —)");
  });

  it("RT2-FE-3: 취소 포기·결과 모름 건수 — 1건 이상일 때만, 결과 모름은 꺼짐일 때만", () => {
    expect(cancelGaveUpCount({ cancelGaveUpOrders: 2 })).toBe(2);
    expect(cancelGaveUpCount({ cancelGaveUpOrders: 0 })).toBeNull();
    expect(cancelGaveUpCount({ cancelGaveUpOrders: null })).toBeNull();
    expect(cancelGaveUpCount({})).toBeNull();
    expect(cancelGaveUpCount(null)).toBeNull();
    expect(unresolvedOffCount({ state: "OFF", unresolvedOrders: 1 })).toBe(1);
    expect(unresolvedOffCount({ state: "OFF", unresolvedOrders: 0 })).toBeNull();
    expect(unresolvedOffCount({ state: "OFF", unresolvedOrders: null })).toBeNull();
    expect(unresolvedOffCount({ state: "STOPPING", unresolvedOrders: 1 })).toBeNull();
    expect(unresolvedOffCount(null)).toBeNull();
    expect(cancelGaveUpText(3)).toBe("취소를 5번 보냈지만 3건이 아직 살아 있습니다 — 토스증권 앱에서 직접 취소하세요");
    expect(disableDoneUnresolvedText(1)).toBe("꺼졌습니다 — 결과를 모르는 주문 1건은 토스증권 앱에서 확인하세요");
  });

  it("RT2-FE-3: 끄기 뒤 안내 — 취소 포기(위험) > 취소 불가(서버 스위치) > 꺼짐 + 결과 모름(경고) > 정리 끝·취소 중", () => {
    const base = { serverEnabled: ON, unfinishedOrders: 1, cancelGaveUpOrders: 0, unresolvedOrders: 0 };
    const gaveUp = disableFeedback({ ...base, state: "STOPPING", cancelGaveUpOrders: 1 });
    expect(gaveUp).toMatchObject({ kind: "gave-up", tone: "danger" });
    expect(gaveUp.text).toBe(cancelGaveUpText(1));
    expect(gaveUp.text).not.toContain("취소 중");
    expect(disableFeedback({ ...base, state: "HALTED", cancelGaveUpOrders: 2 }).kind).toBe("gave-up");
    expect(disableFeedback({ ...base, state: "STOPPING", serverEnabled: { ...ON, collector: false } })).toMatchObject({ kind: "blocked", tone: "warn" });
    const unresolved = disableFeedback({ ...base, state: "OFF", unfinishedOrders: 0, unresolvedOrders: 1 });
    expect(unresolved).toMatchObject({ kind: "unresolved", tone: "warn", text: disableDoneUnresolvedText(1) });
    expect(unresolved.text).not.toContain("정리 끝");
    expect(disableFeedback({ ...base, state: "OFF", unfinishedOrders: 0 })).toMatchObject({ kind: "done", tone: "ok" });
    expect(disableFeedback({ ...base, state: "STOPPING" })).toMatchObject({ kind: "sent", tone: "info" });
    expect(disableFeedback(null)).toMatchObject({ kind: "sent" });
  });

  it("SEC-1: 비상 순서는 수집기만 다시 만들기(deploy.sh 재배포가 아님) — 화면 끄기 → 서버 끄기 한 줄 → 수집기 스위치 → 토스 앱 취소", () => {
    expect(EMERGENCY_STEPS).not.toMatch(/재배포|다시 배포/);
    expect(EMERGENCY_STEPS).toContain("TOSS_TRADING_ENABLED=false");
    expect(EMERGENCY_STEPS).toContain("수집기만 다시 만듦");
    expect(EMERGENCY_STEPS).toContain("deploy.sh 아님");
    expect(EMERGENCY_STEPS).toContain("POST /api/realtrade/disable");
    const order = ["화면 끄기", "POST /api/realtrade/disable", "TOSS_TRADING_ENABLED=false", "토스증권 앱에서 미체결 취소"].map((part) => EMERGENCY_STEPS.indexOf(part));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("멈춤 해제는 멈춤이거나 켜짐 + 매수 멈춤, 설정 바꾸기는 켜짐일 때만", () => {
    expect(canResume({ state: "HALTED", buysPaused: false })).toBe(true);
    expect(canResume({ state: "LIVE", buysPaused: true })).toBe(true);
    expect(canResume({ state: "LIVE", buysPaused: false })).toBe(false);
    expect(canResume({ state: "OFF", buysPaused: true })).toBe(false);
    expect(canUpdate({ state: "LIVE" })).toBe(true);
    expect(canUpdate({ state: "HALTED" })).toBe(false);
  });
});

describe("상태 칩", () => {
  const chip = (over: Record<string, unknown>) =>
    realTradeChip({ state: "OFF", haltReason: null, buysPaused: false, serverEnabled: ON, ...over });

  it("꺼짐·켜짐·매수 멈춤·멈춤(사유)·끄는 중", () => {
    expect(chip({})).toEqual({ label: "꺼짐", tone: "neutral" });
    expect(chip({ state: "LIVE" })).toEqual({ label: "켜짐", tone: "ok" });
    expect(chip({ state: "LIVE", buysPaused: true }).label).toBe("켜짐 · 매수 멈춤(손실 한도)");
    expect(chip({ state: "HALTED", haltReason: "unknown-order" })).toEqual({ label: "멈춤(주문 결과를 모름(unknown-order))", tone: "danger" });
    expect(chip({ state: "STOPPING" })).toEqual({ label: "끄는 중", tone: "warn" });
  });

  it("서버 스위치가 하나라도 꺼지면 꺼짐·켜짐 대신 '서버에서 꺼짐' — 멈춤·끄는 중은 그대로", () => {
    const off = { ...ON, backend: false };
    expect(chip({ serverEnabled: off }).label).toBe("서버에서 꺼짐");
    expect(chip({ state: "LIVE", serverEnabled: off }).label).toBe("서버에서 꺼짐");
    expect(chip({ state: "HALTED", haltReason: "turnover", serverEnabled: off }).label).toMatch(/^멈춤/);
    expect(chip({ state: "STOPPING", serverEnabled: off }).label).toBe("끄는 중");
  });

  it("모르는 상태는 받은 글자 그대로, 모르는 멈춤 사유도 코드 그대로", () => {
    expect(chip({ state: "PAUSED_NEW" })).toEqual({ label: "PAUSED_NEW", tone: "warn" });
    expect(haltReasonLabel("new-reason")).toBe("new-reason");
    expect(haltReasonLabel(null)).toBe("사유 모름");
  });

  it("서버 스위치 한 줄", () => {
    expect(serverSwitchText({ collector: false, backend: true, reason: "limits-invalid" })).toBe(
      "수집기 꺼짐 · 백엔드 켜짐 — 한도 설정이 올바르지 않음(limits-invalid)",
    );
    expect(serverSwitchText(null)).toBe("수집기 모름 · 백엔드 모름");
  });
});

describe("숫자", () => {
  it("손실 한도는 1~50, 소수 둘째 자리까지 — 그 밖은 null", () => {
    expect(parseLossLimit("15")).toBe(15);
    expect(parseLossLimit(" 12.5 ")).toBe(12.5);
    expect(parseLossLimit("1")).toBe(1);
    expect(parseLossLimit("50")).toBe(50);
    for (const bad of ["", "0", "0.5", "50.01", "51", "-5", "12.345", "abc", "1e1"]) expect(parseLossLimit(bad), bad).toBeNull();
    expect(lossLimitText(15)).toBe("15");
    expect(lossLimitText(12.5)).toBe("12.50");
  });

  it("기준 대비 손익과 멈춤선 — 하나라도 모르면 null(0으로 채우지 않음), 숫자 글자도 읽는다", () => {
    expect(baselineDelta(10_500_000, "10000000")).toEqual({ amount: 500_000, pct: 5 });
    expect(baselineDelta(null, 10_000_000)).toEqual({ amount: null, pct: null });
    expect(baselineDelta(10, 0)).toEqual({ amount: 10, pct: null });
    expect(lossLine(10_000_000, 15)).toBe(8_500_000);
    expect(lossLine(null, 15)).toBeNull();
    expect(toNumber("12.5")).toBe(12.5);
    expect(toNumber("")).toBeNull();
    expect(toNumber("x")).toBeNull();
    expect(toNumber(Number.NaN)).toBeNull();
  });

  it("손실 한도 표시 — baselineTotal이 오면 '상한 없는 총액 − baselineTotal', 비율과 멈춤선의 한도 금액은 E0(baselineEquity) 기준", () => {
    // 상한 1,000만·총액 3,000만으로 켬(E0 1,000만, U0 3,000만) → 보유가 떨어져 총액 2,700만, E는 상한에 걸려 그대로 1,000만.
    const capped = { lastPreflight: { equity: 10_000_000, total: 27_000_000 }, baselineEquity: 10_000_000, baselineTotal: 30_000_000, lossLimitPct: 15 };
    const pnl = realTradePnl(capped);
    expect(pnl.basis).toBe("total");
    expect(pnl.amount).toBe(-3_000_000);
    expect(pnl.pct).toBe(-30);
    // 매수 멈춤 조건 (U − U0) ≤ −(15% × E0) → 총액 3,000만 − 150만 = 2,850만 이하.
    expect(pnl.line).toBe(28_500_000);
    expect(pnl.now).toBe(27_000_000);
    expect(pnl.base).toBe(30_000_000);
    // 숫자 글자도 읽고, 지금 총액을 모르면 손익은 null(운용 평가액으로 대신하지 않음).
    const unknownTotal = realTradePnl({ ...capped, lastPreflight: { equity: 10_000_000 }, baselineTotal: "30000000" });
    expect(unknownTotal).toMatchObject({ basis: "total", amount: null, pct: null, line: 28_500_000 });
    // baselineTotal이 없거나 null이면 예전처럼 운용 평가액 − E0, 멈춤선 E0 × (1 − 한도).
    for (const baselineTotal of [undefined, null]) {
      expect(realTradePnl({ ...capped, lastPreflight: { equity: 9_500_000, total: 27_000_000 }, baselineTotal })).toEqual({
        basis: "equity", amount: -500_000, pct: -5, line: 8_500_000, now: 9_500_000, base: 10_000_000,
      });
    }
    expect(realTradePnl({ lastPreflight: null, baselineEquity: null, lossLimitPct: null })).toMatchObject({ amount: null, pct: null, line: null });
  });

  it("원 단위 — 모르면 '—'(단위 없음), 부호", () => {
    expect(formatWon(1_234_567)).toBe("1,234,567원");
    expect(formatWon(null)).toBe("—");
    expect(formatSignedWon(500)).toBe("+500원");
    expect(formatSignedWon(-500)).toBe("-500원");
    expect(limitRows(null).map((row) => row.text)).toEqual(["—", "—", "—", "—"]);
    expect(limitRows({ maxOrderKrw: 5_000_000, maxOrdersPerDay: 40, maxBuyKrwPerDay: "20000000", maxEquityKrw: 30_000_000 })).toEqual([
      { label: "운용 평가액 상한", text: "30,000,000원" },
      { label: "1건 상한", text: "5,000,000원" },
      { label: "하루 매수 상한", text: "20,000,000원" },
      { label: "하루 주문 수 상한", text: "40건" },
    ]);
  });
});

describe("서버 오류 코드", () => {
  const failure = (message: string, status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { status, ...extra });

  it("코드 칸·문구 안의 코드를 찾고, 없으면 409만 버전 충돌", () => {
    expect(realTradeErrorCode(failure("confirm-mismatch", 400))).toBe("confirm-mismatch");
    expect(realTradeErrorCode(failure("비밀번호가 틀렸습니다(password-invalid)", 403))).toBe("password-invalid");
    expect(realTradeErrorCode(failure("잠김", 423, { code: "password-locked" }))).toBe("password-locked");
    expect(realTradeErrorCode(failure("요청 실패 (HTTP 409)", 409))).toBe("version-conflict");
    expect(realTradeErrorCode(failure("not-supported", 400))).toBe("not-supported");
    expect(realTradeErrorCode(failure("server-disabled", 409))).toBe("server-disabled");
    // 403이라도 코드가 없으면 모름(Origin 거절 등을 비밀번호 틀림으로 읽지 않음).
    expect(realTradeErrorCode(failure("접근할 수 없습니다.", 403))).toBeNull();
    expect(realTradeErrorCode("x")).toBeNull();
  });

  it("RT-CONTRACT-4·SEC-3: 서버 본문의 error(code 칸)는 정확히 비교 — 409 book-changed·invalid-state·not-ready는 버전 충돌이 아니다", () => {
    expect(realTradeErrorCode(failure("따라 하던 계좌가 바뀌었습니다 — 끄고 다시 켜세요.", 409, { code: "book-changed" }))).toBe("book-changed");
    expect(realTradeErrorCode(failure("지금 상태에서는 할 수 없습니다.", 409, { code: "invalid-state" }))).toBe("invalid-state");
    expect(realTradeErrorCode(failure("준비 전입니다.", 409, { code: "not-ready" }))).toBe("not-ready");
    for (const code of ["book-changed", "invalid-state", "not-ready"]) {
      expect(realTradeErrorCode(failure("요청 실패 (HTTP 409)", 409, { code })), code).not.toBe("version-conflict");
    }
    // 아는 코드는 code 칸이 정확히 같을 때만 — 문구에 다른 코드 글자가 있어도 code 칸이 먼저입니다.
    expect(realTradeErrorCode(failure("version-conflict 아님", 409, { code: "invalid-state" }))).toBe("invalid-state");
    expect(realTradeErrorCode(failure("x", 409, { code: "version-conflict" }))).toBe("version-conflict");
    // 모르는 코드가 오면(409라도) 짐작하지 않고 null — 화면은 서버 문구를 그대로 보입니다.
    expect(realTradeErrorCode(failure("서버 문구", 409, { code: "something-new" }))).toBeNull();
    // 코드 칸에 아는 코드를 품은 다른 글자(includes로는 걸림)도 아는 코드로 읽지 않습니다.
    expect(realTradeErrorCode(failure("서버 문구", 409, { code: "version-conflict-later" }))).toBeNull();
    // code가 없을 때만 문구 안 코드 → 그래도 없으면 409를 버전 충돌로 어림(예전 모양).
    expect(realTradeErrorCode(failure("요청 실패 (HTTP 409)", 409, { code: null }))).toBe("version-conflict");
    expect(realTradeErrorCode(failure("멈춤 해제 실패(book-changed)", 409))).toBe("book-changed");
  });

  it("book-changed는 '끄고 다시 켜서 예상 목록 확인', invalid-state·not-ready는 서버 문구 그대로(없으면 코드별 기본 문구)", () => {
    expect(realTradeErrorText("book-changed", "resume", "서버 문구")).toMatch(/끄고 다시 켜서 예상 목록을 확인/);
    expect(realTradeErrorText("book-changed", "resume", "서버 문구")).not.toMatch(/다시 읽었으니/);
    expect(realTradeErrorText("invalid-state", "enable", "끄는 중이라 켤 수 없습니다.")).toBe("끄는 중이라 켤 수 없습니다.");
    expect(realTradeErrorText("not-ready", "enable", "실제 매매 표가 아직 없습니다.")).toBe("실제 매매 표가 아직 없습니다.");
    expect(realTradeErrorText("invalid-state", "enable", null)).toMatch(/상태/);
    expect(realTradeErrorText("not-ready", "enable", "")).toMatch(/준비/);
    for (const code of ["invalid-state", "not-ready"] as const) {
      expect(realTradeErrorText(code, "enable", null), code).not.toMatch(/다른 곳에서 실제 매매 설정이 바뀌었습니다/);
    }
  });

  it("코드별 문구, 모르면 서버 문구 그대로", () => {
    expect(realTradeErrorText("confirm-mismatch", "enable", null)).toContain(`'${CONFIRM_TEXT.enable}'`);
    expect(realTradeErrorText("confirm-mismatch", "resume", null)).toContain("'멈춤 해제'");
    expect(realTradeErrorText("password-invalid", "enable", null)).toMatch(/비밀번호가 틀렸습니다/);
    expect(realTradeErrorText("password-locked", "update", null)).toMatch(/30분/);
    expect(realTradeErrorText("version-conflict", "enable", null)).toMatch(/다시 읽었으니/);
    expect(realTradeErrorText(null, "enable", "서버 문구")).toBe("서버 문구");
    expect(realTradeErrorText(null, "enable", null)).toBe("요청을 처리하지 못했습니다.");
  });
});

describe("표기", () => {
  it("시각은 서울 시각 HH:mm(:ss) — ISO는 바꾸고, HH:mm:ss는 그대로, 모르는 모양은 받은 글자 그대로", () => {
    expect(kstClock("08:50:30")).toBe("08:50:30");
    expect(kstClock("09:00:00")).toBe("09:00");
    expect(kstClock("2026-11-05T23:50:30Z")).toBe("08:50:30");
    expect(kstClock("2026-11-06T09:30:00+09:00")).toBe("09:30");
    expect(kstClock("곧")).toBe("곧");
    expect(kstClock(null)).toBe("—");
  });

  it("창 한 줄 — 종류 이름표와 시각, 글자 하나면 그대로", () => {
    expect(windowText({ kind: "SYNC", start: "08:50:30", end: "08:58:30" })).toBe("시가 맞추기 08:50:30~08:58:30");
    expect(windowText({ purpose: "SYNC_FOLLOWUP", start: "09:00:30", end: "09:30:00" })).toBe("맞추기(시장가) 09:00:30~09:30");
    expect(windowText({ kind: "SYNC_AT", start: "09:10:00", end: "09:13:00" })).toBe("개장 10분 뒤 맞추기 09:10~09:13");
    expect(windowText({ kind: "NEW_KIND", start: null, end: null })).toBe("NEW_KIND —~—");
    expect(windowText("08:50 시가")).toBe("08:50 시가");
  });

  it("이벤트 내용은 용도·책·사유·건수만", () => {
    expect(eventDetailText({ purpose: "SYNC", accepted: 5, filled: 5, missed: 0, skipped: 1, blocked: 0, symbol: "005930" })).toBe(
      "시가 맞추기 · 접수 5 · 체결 5 · 놓침 0 · 건너뜀 1 · 막힘 0",
    );
    expect(eventDetailText({ reason: "unknown-order" })).toBe("사유 unknown-order");
    expect(eventDetailText({ sourceBook: "kr_claude2" })).toBe("Claude 계좌2");
    expect(eventDetailText({})).toBeNull();
    expect(eventDetailText(null)).toBeNull();
  });

  it("주문 상태는 토스 상태가 먼저, 없으면 보낸 결과 — 모르는 값은 원문", () => {
    expect(orderStatusText({ brokerStatus: "FILLED", sendOutcome: "ACCEPTED" })).toBe("체결 완료");
    expect(orderStatusText({ brokerStatus: null, sendOutcome: "UNKNOWN" })).toBe("결과 모름");
    expect(orderStatusText({ brokerStatus: "NEW_STATUS", sendOutcome: "ACCEPTED" })).toBe("NEW_STATUS");
    expect(orderStatusText({ brokerStatus: null, sendOutcome: null })).toBe("—");
  });

  it("책 이름은 사용자가 고른 이름(규칙 계좌·Claude 계좌1·Claude 계좌2)이 먼저, 건너뛴 종목은 사유와 함께", () => {
    expect(sourceBookLabel("kr_claude", "한국 Claude 계좌")).toBe("Claude 계좌1");
    expect(sourceBookLabel("kr_new", "새 책")).toBe("새 책");
    expect(sourceBookLabel(null)).toBe("—");
    expect(skippedText({ symbol: "005930", name: "삼성전자", reason: "opposite-pending" })).toBe(
      "삼성전자 005930 — 반대 방향 미체결 있음(opposite-pending)",
    );
    expect(skippedText({ symbol: "000660", reason: "new-code" })).toBe("000660 — new-code");
    expect(skippedText("글자 하나")).toBe("글자 하나");
    expect(skippedText({ symbol: "000660", reason: "pending-stop" })).toBe("000660 — 따라 하는 계좌의 오늘 대기 스탑 종목 — 매수 안 함(pending-stop)");
  });

  it("개장 10분 뒤 맞추기·장중 스탑 매도(ADR 0033) — 이름표·건수 줄·예상 목록의 맞추기 방식", () => {
    expect(eventKindLabel("STOP_SELL")).toBe("스탑 매도");
    expect(eventDetailText({ sent: 2, blocked: 1, missed: 0, date: "2026-11-10", symbol: "005930" }, "STOP_SELL")).toBe("보냄 2 · 놓침 0 · 막힘 1");
    expect(previewTimingText("2026-11-10T00:10:00Z")).toBe("개장 10분 뒤 맞추기 09:10 시장가");
    expect(previewTimingText(null)).toBe("시가 맞추기(시가 단일가)");
  });

  it("QA-344: 예상 목록의 맞추기 글은 세션 날짜를 앞에 적고, 창이 열려 있을 때만 '바로 주문' 안내를 낸다", () => {
    expect(previewTimingText("2026-11-06T00:10:00Z", "2026-11-06")).toBe("2026-11-06 개장 10분 뒤 맞추기 09:10 시장가");
    expect(previewTimingText(null, "2026-11-09")).toBe("2026-11-09 시가 맞추기(시가 단일가)");
    expect(previewTimingText("2026-11-06T00:10:00Z", "내일")).toBe("개장 10분 뒤 맞추기 09:10 시장가");   // 날짜 모양이 아니면 적지 않음
    expect(previewImmediateText(true, "enable")).toBe(
      "지금 맞추기 창이 열려 있습니다 — 창이 열려 있는 동안 켜면 이 목록이 바로 주문됩니다(실제 주문은 그때 보유·가격으로 다시 계산).",
    );
    expect(previewImmediateText(true, "update")).toContain("바꾸면 이 목록이 바로 주문됩니다");
    expect(previewImmediateText(true, "resume")).toContain("멈춤을 풀면 이 목록이 바로 주문됩니다");
    for (const value of [false, null, undefined, "true", 1]) expect(previewImmediateText(value, "enable")).toBeNull();
  });

  it("QA-345: 쓰기 요청의 시간 한도 — 끄기 20초·켜기류 90초, 한도를 넘긴 오류만 '처리됐을 수 있음'으로 가른다", () => {
    expect(DISABLE_TIMEOUT_MS).toBe(20_000);
    expect(ACTION_TIMEOUT_MS).toBe(90_000);
    expect(requestTimedOut(Object.assign(new Error("백엔드가 90초 안에 응답하지 않았습니다"), { status: 0, timedOut: true }))).toBe(true);
    expect(requestTimedOut(Object.assign(new Error("백엔드 API에 연결하지 못했습니다"), { status: 0, timedOut: false }))).toBe(false);
    expect(requestTimedOut(new Error("요청 실패 (HTTP 500)"))).toBe(false);
    expect(requestTimedOut(null)).toBe(false);
    expect(actionTimeoutText()).toBe(
      "90초 안에 응답을 받지 못했습니다 — 요청이 처리됐을 수 있으니 창을 닫고 상태를 확인하세요(상태는 다시 읽는 중입니다).",
    );
  });

  it("QA-347: 켜기·해제 뒤 안내는 '다음 맞추기부터'가 아니라 전체 맞추기와 그날 바로 따라 하는 것을 가르고, 해제는 풀기 전 상태로 가른다", () => {
    expect(actionDoneText("enable")).toContain("전체 맞추기는 다음 맞추기(");
    expect(actionDoneText("enable")).toContain("오늘 남은 장중 주문과 장중 스탑은 바로 따라 합니다");
    expect(actionDoneText("resume", "HALTED")).toMatch(/^이상 멈춤을 풀었습니다 — 전체 맞추기는 다음 맞추기에서/);
    expect(actionDoneText("resume", "LIVE")).toBe("매수 멈춤을 풀었습니다 — 매수도 바로 다시 따라 합니다.");
    expect(actionDoneText("resume", null)).toMatch(/^이상 멈춤을 풀었습니다/);
    expect(actionDoneText("update", "LIVE")).toMatch(/^설정을 바꿨습니다/);
    for (const text of [actionDoneText("enable"), actionDoneText("resume", "HALTED"), actionDoneText("resume", "LIVE")]) {
      expect(text).not.toContain("다음 맞추기부터");
    }
    expect(skipDayText("ledger-behind")).toBe("오늘은 맞추기와 장중 따라 하기를 쉽니다 — 사유 ledger-behind. 스탑 매도만 합니다.");
    expect(skipDayText("market-closed")).toBe("오늘은 쉽니다 — 사유 market-closed. 주문을 보내지 않습니다.");
  });

  it("QA-342: 준비 안 됨 이벤트(개장이 가깝도록 장 운영 정보·수집기 상태를 못 받음) — 이름표와 사유 코드", () => {
    expect(eventKindLabel("UNAVAILABLE")).toBe("준비 안 됨(주문을 내지 못하는 중)");
    expect(eventDetailText({ reason: "calendar-unavailable", date: "2026-11-10" }, "UNAVAILABLE")).toBe("사유 calendar-unavailable");
  });
});

describe("RT3-UI-1: 수집기 상태를 읽지 못함은 꺼짐이 아니라 모름", () => {
  const UNREADABLE = { collector: null, backend: true, reason: "status-unreadable" };
  const chip = (over: Record<string, unknown>) =>
    realTradeChip({ state: "LIVE", haltReason: null, buysPaused: false, serverEnabled: UNREADABLE, ...over });

  it("서버 스위치 상태 — 꺼짐을 확인했으면 off, 둘 다 켜짐이면 on, 수집기를 읽지 못했으면 unknown(사유 status-unreadable이면 받은 값과 관계없이)", () => {
    expect(serverSwitchState({ serverEnabled: ON })).toBe("on");
    expect(serverSwitchState({ serverEnabled: { collector: false, backend: true, reason: "disabled" } })).toBe("off");
    expect(serverSwitchState({ serverEnabled: UNREADABLE })).toBe("unknown");
    expect(serverSwitchState({ serverEnabled: { ...UNREADABLE, reason: null } })).toBe("unknown");
    // 백엔드가 아직 collector를 false로 싣더라도 사유가 '읽지 못함'이면 꺼짐으로 단정하지 않습니다.
    expect(serverSwitchState({ serverEnabled: { collector: false, backend: true, reason: "status-unreadable" } })).toBe("unknown");
    expect(serverSwitchState({ serverEnabled: { collector: true, backend: true, reason: "status-unreadable" } })).toBe("unknown");
    // 백엔드 스위치가 꺼졌음을 알면 수집기를 몰라도 꺼짐입니다(주문이 나가지 않음).
    expect(serverSwitchState({ serverEnabled: { ...UNREADABLE, backend: false } })).toBe("off");
    expect(serverSwitchState({ serverEnabled: null })).toBe("unknown");
    // 모름은 켜짐이 아닙니다(취소 불가 판단·켜기 막기).
    expect(serverEnabled({ serverEnabled: UNREADABLE })).toBe(false);
    expect(serverEnabled({ serverEnabled: ON })).toBe(true);
  });

  it("칩 — 켜짐·꺼짐인데 수집기를 모르면 '서버에서 꺼짐' 대신 상태 + '서버 상태를 읽지 못함 — 다시 읽는 중'(경고)", () => {
    expect(SERVER_UNKNOWN_TEXT).toBe("서버 상태를 읽지 못함 — 다시 읽는 중");
    expect(chip({})).toEqual({ label: "켜짐 · 서버 상태를 읽지 못함 — 다시 읽는 중", tone: "warn" });
    expect(chip({ serverEnabled: { collector: false, backend: true, reason: "status-unreadable" } }).label).toBe(
      "켜짐 · 서버 상태를 읽지 못함 — 다시 읽는 중",
    );
    expect(chip({ buysPaused: true }).label).toBe("켜짐 · 매수 멈춤(손실 한도) · 서버 상태를 읽지 못함 — 다시 읽는 중");
    expect(chip({ state: "OFF" })).toEqual({ label: "꺼짐 · 서버 상태를 읽지 못함 — 다시 읽는 중", tone: "warn" });
    for (const state of ["LIVE", "OFF"]) expect(chip({ state }).label, state).not.toContain("서버에서 꺼짐");
    // 꺼짐을 확인한 경우와 멈춤·끄는 중은 그대로입니다.
    expect(chip({ serverEnabled: { collector: false, backend: true, reason: "disabled" } }).label).toBe("서버에서 꺼짐");
    expect(chip({ serverEnabled: { ...UNREADABLE, backend: false } }).label).toBe("서버에서 꺼짐");
    expect(chip({ state: "STOPPING" }).label).toBe("끄는 중");
    expect(chip({ state: "HALTED", haltReason: "turnover" }).label).toMatch(/^멈춤/);
  });

  it("서버 스위치 한 줄은 수집기 '모름'과 사유 이름표, 켜기는 '읽지 못해 켤 수 없음 — 다시 읽는 중', 경고 문구는 꺼졌다고 단정하지 않는다", () => {
    expect(serverSwitchText(UNREADABLE)).toBe("수집기 모름 · 백엔드 켜짐 — 수집기 상태를 읽지 못함(status-unreadable)");
    expect(serverSwitchText({ collector: false, backend: true, reason: "status-unreadable" })).toBe(
      "수집기 모름 · 백엔드 켜짐 — 수집기 상태를 읽지 못함(status-unreadable)",
    );
    expect(enableBlock({ available: true, supported: true, state: "OFF", serverEnabled: UNREADABLE })).toBe(
      "서버 스위치 상태를 읽지 못해 켤 수 없습니다 — 다시 읽는 중",
    );
    expect(enableBlock({ available: true, supported: true, state: "OFF", serverEnabled: { collector: false, backend: true, reason: "disabled" } })).toBe(
      "서버 스위치가 꺼져 있어 켤 수 없습니다",
    );
    const text = serverUnknownText(UNREADABLE);
    expect(text.startsWith("서버 상태를 읽지 못함 — 다시 읽는 중(수집기 상태를 읽지 못함(status-unreadable))")).toBe(true);
    expect(text).toContain("꺼졌다는 뜻은 아닙니다");
    expect(text).not.toMatch(/꺼져 있어 주문이 나가지 않습니다/);
  });

  it("미체결 취소 불가 판단(SEC-5)은 모름을 켜짐으로 보지 않는다 — 끄는 중·멈춤·미종료 주문이면 그대로 참", () => {
    expect(cancelBlocked({ state: "LIVE", serverEnabled: UNREADABLE, unfinishedOrders: 2 })).toBe(true);
    expect(cancelBlocked({ state: "STOPPING", serverEnabled: UNREADABLE })).toBe(true);
    expect(cancelBlocked({ state: "HALTED", serverEnabled: UNREADABLE })).toBe(true);
    expect(cancelBlocked({ state: "LIVE", serverEnabled: UNREADABLE, unfinishedOrders: 0 })).toBe(false);
  });

  it("이상 멈춤 사유 collector-disabled — 칩·이벤트 내용에 '수집기 매매 스위치가 꺼져 멈춤 — 다시 켜려면 멈춤 해제'", () => {
    const label = "수집기 매매 스위치가 꺼져 멈춤 — 다시 켜려면 멈춤 해제(collector-disabled)";
    expect(haltReasonLabel("collector-disabled")).toBe(label);
    expect(chip({ state: "HALTED", haltReason: "collector-disabled" })).toEqual({ label: `멈춤(${label})`, tone: "danger" });
    expect(eventDetailText({ reason: "collector-disabled" }, "HALT")).toBe(`사유 ${label}`);
    expect(eventDetailText({ reason: "repeated-error", code: "collector-http-500" }, "HALT")).toBe("사유 같은 오류 반복(repeated-error)");
    // 이상 멈춤이 아닌 이벤트의 사유는 받은 코드 그대로입니다.
    expect(eventDetailText({ reason: "collector-disabled" }, "SKIP_DAY")).toBe("사유 collector-disabled");
  });
});

describe("RT3-UI-3: 끄기 뒤 표시는 다시 켜짐으로 돌아오면 지운다", () => {
  it("끄는 중·꺼짐을 본 뒤 켜짐·이상 멈춤을 받으면 지운다(끄는 중 → 꺼짐은 버전이 올라도 남김 — 정리 끝 안내)", () => {
    let mark = nextDisableSentMark({ version: 4, sawOff: false }, { state: "STOPPING", version: 4 });
    expect(mark).toEqual({ version: 4, sawOff: true });
    mark = nextDisableSentMark(mark, { state: "OFF", version: 5 });
    expect(mark).toEqual({ version: 4, sawOff: true });
    expect(nextDisableSentMark(mark, { state: "LIVE", version: 6 })).toBeNull();
    expect(nextDisableSentMark({ version: null, sawOff: true }, { state: "LIVE", version: null })).toBeNull();
    expect(nextDisableSentMark({ version: null, sawOff: true }, { state: "HALTED", version: 9 })).toBeNull();
  });

  it("꺼짐 쪽을 보지 못했어도 끄기 응답보다 큰 버전의 켜짐이면 지운다 — 같거나 작은 버전의 켜짐(끄기 직후 진행 중이던 읽기)은 남긴다", () => {
    const sent = { version: 4, sawOff: false };
    expect(nextDisableSentMark(sent, { state: "LIVE", version: 3 })).toBe(sent);
    expect(nextDisableSentMark(sent, { state: "LIVE", version: 4 })).toBe(sent);
    expect(nextDisableSentMark(sent, { state: "LIVE", version: 6 })).toBeNull();
    expect(nextDisableSentMark(sent, { state: "HALTED", version: 5 })).toBeNull();
    // 끄기 응답에 버전이 없거나 상태에 버전이 없으면 꺼짐 쪽을 본 뒤에만 지웁니다.
    expect(nextDisableSentMark({ version: null, sawOff: false }, { state: "LIVE", version: 9 })).toEqual({ version: null, sawOff: false });
    expect(nextDisableSentMark(sent, { state: "LIVE", version: null })).toBe(sent);
  });

  it("보내지 않았거나 상태가 없거나 모르는 상태면 그대로", () => {
    expect(nextDisableSentMark(null, { state: "LIVE", version: 9 })).toBeNull();
    const sent = { version: 4, sawOff: false };
    expect(nextDisableSentMark(sent, null)).toBe(sent);
    expect(nextDisableSentMark(sent, { state: null, version: null })).toBe(sent);
    expect(nextDisableSentMark(sent, { state: "SOMETHING_NEW", version: 9 })).toBe(sent);
    const seen = { version: 4, sawOff: true };
    expect(nextDisableSentMark(seen, { state: "OFF", version: 5 })).toBe(seen);
  });
});

describe("운용 평가액 설명 줄 — 휴장일·토스 점검 중에도 마지막 값(2026-11-08)", () => {
  it("읽은 적이 없으면 그렇게", () => {
    expect(preflightNote(null)).toBe("아직 토스에서 읽은 적 없음");
    expect(preflightNote({ fetchedAt: null })).toBe("아직 토스에서 읽은 적 없음");
  });
  it("그날 마감 뒤(휴장일 포함)에 읽은 값이면 '마지막 거래일 마감 뒤 값'(휴장일에 보는 금요일 마감 뒤 값)", () => {
    expect(preflightNote({ fetchedAt: "2026-11-06T06:41:02Z", afterClose: true }, "2026-11-07T03:00:00Z")).toBe(
      "토스에서 읽은 시각 2026-11-06 15:41:02 · 마지막 거래일 마감 뒤 값",
    );
  });
  it("장중에 읽은 값을 다음 날 보면 '이전 값', 같은 날이면 시각만", () => {
    expect(preflightNote({ fetchedAt: "2026-11-06T00:10:05Z", afterClose: false }, "2026-11-07T03:00:00Z")).toBe(
      "토스에서 읽은 시각 2026-11-06 09:10:05 · 이전 값",
    );
    expect(preflightNote({ fetchedAt: "2026-11-06T00:10:05Z", afterClose: false }, "2026-11-06T03:00:00Z")).toBe(
      "토스에서 읽은 시각 2026-11-06 09:10:05",
    );
  });
  it("afterClose가 없는 옛 응답·달력이 모름(null)이면 날짜로만 가름", () => {
    expect(preflightNote({ fetchedAt: "2026-11-06T00:10:05Z" }, "2026-11-06T14:59:59Z")).toBe("토스에서 읽은 시각 2026-11-06 09:10:05");
    expect(preflightNote({ fetchedAt: "2026-11-06T00:10:05Z", afterClose: null }, "2026-11-06T15:00:00Z")).toBe(
      "토스에서 읽은 시각 2026-11-06 09:10:05 · 이전 값",
    );
  });
});
