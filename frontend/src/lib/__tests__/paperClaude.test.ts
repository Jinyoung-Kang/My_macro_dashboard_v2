/**
 * 모의 매매 단계 3a(Claude 재량 책)의 표기 — 결정 상세(판단·제안 주문·검증·사용량), 시작·미리보기 카드, 노출 추이.
 * 숫자·통과 여부·어긋남 판정은 서버 값 그대로이고 화면은 이름만 붙인다(ADR 0004). 모르는 값은 "—", 0으로 채우지 않는다.
 */
import { describe, expect, it } from "vitest";
import {
  API_COST_ESTIMATE_NOTE,
  API_COST_NOT_SENT,
  apiUsageView,
  CLAUDE_COST_NOTE,
  claimLabelBadges,
  claudeDecisionView,
  claudeExposureChart,
  claudePreviewResultView,
  claudeStartPrompt,
  decisionMeta,
  initialDecisionResultView,
  orderReasonText,
  proposedSizeText,
  rejectReasonText,
  stanceBadge,
} from "../paper";
import type { PaperBookSummary, PaperDecisionDetail } from "../types";

function book(code: string, over: Partial<PaperBookSummary> = {}): PaperBookSummary {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000,
    cash: 12.34, nav: 100123.45, equityValue: 100111.11, exposurePct: 99.99, returnPct: 0.12345,
    lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: null, benchmark: null, ...over,
  };
}

const CLAUDE_NOT_STARTED = book("claude", { kind: "CLAUDE", label: "Claude 계좌", status: "NOT_STARTED", startedOn: null });

/** decision.schema.json 모양의 응답 + 검증 결과(자바 record 그대로 — 주문이 order 안에). */
const RESPONSE = {
  schemaVersion: 2,
  stance: "RISK_OFF",
  targetEquityExposurePct: 35,
  exposureRationale: "10Y 4.9%·브렌트 92 — 할인율·비용 물가 두 축이 압박",
  summary: "노출을 35%로 낮추고 방어 섹터 일부만",
  orders: [
    {
      ticker: "XLV", side: "BUY", targetWeightPct: 12, sellFraction: null, timing: "NEXT_CLOSE",
      thesis: "방어 섹터 상대 강도 개선", labels: ["사실", "해석", "사실"], invalidation: "XLV가 200일선 아래로",
    },
    {
      ticker: "NVDA", side: "BUY", targetWeightPct: 15, sellFraction: null, timing: "NEXT_OBSERVATION",
      thesis: "교차 확인 2곳", labels: ["가설", "확인 필요"], invalidation: "다음 13F에서 축소",
    },
    { ticker: "AAPL", side: "SELL", targetWeightPct: null, sellFraction: 0.5, timing: "NEXT_OBSERVATION", thesis: "비중 축소", labels: [], invalidation: "" },
  ],
  noTradeReason: null,
  watchlist: [{ ticker: "TLT", condition: "10Y 4.75% 아래로 3일" }],
  confidence: 0.62,
  validation: [
    { order: { ticker: "XLV", side: "BUY", targetWeightPct: 12, sellFraction: null, timing: "NEXT_CLOSE" }, accepted: true, rejectReason: null, detail: null },
    {
      order: { ticker: "NVDA", side: "BUY", targetWeightPct: 15, sellFraction: null, timing: "NEXT_OBSERVATION" },
      accepted: false, rejectReason: "WEIGHT_CAP", detail: "목표 15% > 종목 상한 10%",
    },
    { order: { ticker: "AAPL", side: "SELL", targetWeightPct: null, sellFraction: 0.5, timing: "NEXT_OBSERVATION" }, accepted: false, rejectReason: "MYSTERY", detail: null },
  ],
  exposureMismatch: false,
};

describe("Claude 결정 표기 조각", () => {
  it("자세 배지 — 이름과 코드, 모르면 글자 그대로, 없으면 null", () => {
    expect(stanceBadge("RISK_ON")?.label).toBe("위험 선호 (RISK_ON)");
    expect(stanceBadge("RISK_OFF")?.className).toContain("text-warn");
    expect(stanceBadge("SIDEWAYS")?.label).toBe("SIDEWAYS");
    expect(stanceBadge(null)).toBeNull();
  });

  it("라벨 배지 — 받은 순서·중복 없이, 가설·확인 필요는 사실과 다른 색", () => {
    const badges = claimLabelBadges(["사실", "가설", "사실", "확인 필요", 3, "새 라벨"]);
    expect(badges.map((badge) => badge.label)).toEqual(["사실", "가설", "확인 필요", "새 라벨"]);
    expect(badges[0].className).toContain("text-ok");
    expect(badges[2].className).toContain("text-warn");
    expect(claimLabelBadges(undefined)).toEqual([]);
  });

  it("거절 사유 — 이름 (코드)와 설명(숫자 대신 설정 키), 모르는 코드는 그대로, 없으면 —", () => {
    expect(rejectReasonText("OVER_ALLOCATED").label).toBe("배분 합 100% 초과 (OVER_ALLOCATED)");
    expect(rejectReasonText("OVER_ALLOCATED").title).toContain("큰 주문부터 받고");
    expect(rejectReasonText("WEIGHT_CAP").title).toContain("maxWeightStockPct");
    expect(rejectReasonText("STALE_INPUT").label).toBe("입력 자료 오래됨 (STALE_INPUT)");
    // 1주 미만 부분 매도 — 장부가 전량으로 집행하니 검증기가 거절합니다. 이름이 없으면 코드만 보여 사유를 알 수 없습니다.
    expect(rejectReasonText("BELOW_ONE_SHARE").label).toBe("1주 미만 부분 매도 (BELOW_ONE_SHARE)");
    expect(rejectReasonText("BELOW_ONE_SHARE").title).toContain("전량 매도로 집행");
    expect(rejectReasonText("MYSTERY")).toEqual({ label: "MYSTERY" });
    expect(rejectReasonText(null)).toEqual({ label: "—" });
  });

  it("제안 주문 크기 — 매수는 목표 비중, 매도는 보유 비율(없으면 전량), 매수에 목표가 없으면 —", () => {
    expect(proposedSizeText("BUY", 12, null)).toBe("목표 비중 12.00%");
    expect(proposedSizeText("BUY", null, null)).toBe("—");
    expect(proposedSizeText("SELL", null, 0.5)).toBe("보유의 50%");
    expect(proposedSizeText("SELL", null, null)).toBe("전량");
    expect(proposedSizeText("HOLD", 1, 1)).toBe("—");
  });

  it("Claude 주문 근거 — 근거 [라벨] · 무효화, 근거가 없으면 키: 값 요약", () => {
    expect(orderReasonText({ thesis: "방어 섹터 상대 강도 개선", labels: ["사실", "해석"], invalidation: "200일선 아래로" }))
      .toBe("방어 섹터 상대 강도 개선 [사실·해석] · 무효화: 200일선 아래로");
    expect(orderReasonText({ thesis: "비중 축소", labels: [], invalidation: "" })).toBe("비중 축소");
    expect(orderReasonText({ labels: ["사실"] })).toBe("labels: 사실");
  });
});

describe("Claude 결정 상세", () => {
  it("판단·제안 주문·검증·관찰 목록 — 응답 값 그대로, 거절 사유는 이름과 서버 설명", () => {
    const view = claudeDecisionView({ book: "claude", response: RESPONSE, targetExposurePct: 35 });
    expect(view.recognized).toBe(true);
    expect(view.hasResponse).toBe(true);
    expect(view.stance?.label).toBe("위험 회피 (RISK_OFF)");
    expect(view.targetExposure).toBe("35.0%");
    expect(view.confidence).toBe("62.0%");
    expect(view.mismatch).toBeNull();
    expect(view.summary).toBe("노출을 35%로 낮추고 방어 섹터 일부만");
    expect(view.noTradeReason).toBeNull();

    expect(view.orders.map((row) => [row.ticker, row.side, row.size, row.timing, row.thesis, row.labels.map((b) => b.label).join(","), row.invalidation]))
      .toEqual([
        ["XLV", "매수", "목표 비중 12.00%", "다음 종가", "방어 섹터 상대 강도 개선", "사실,해석", "XLV가 200일선 아래로"],
        ["NVDA", "매수", "목표 비중 15.00%", "다음 관측치", "교차 확인 2곳", "가설,확인 필요", "다음 13F에서 축소"],
        ["AAPL", "매도", "보유의 50%", "다음 관측치", "비중 축소", "", "—"],
      ]);
    expect(view.validation.map((row) => [row.ticker, row.size, row.result.label, row.reason, row.detail])).toEqual([
      ["XLV", "목표 비중 12.00%", "통과", "—", "—"],
      ["NVDA", "목표 비중 15.00%", "거절", "비중 상한 초과 (WEIGHT_CAP)", "목표 15% > 종목 상한 10%"],
      ["AAPL", "보유의 50%", "거절", "MYSTERY", "—"],
    ]);
    expect(view.watchlist).toEqual([{ key: "0-TLT", ticker: "TLT", condition: "10Y 4.75% 아래로 3일" }]);
    // 사용량이 없으면 칸을 만들지 않습니다.
    expect(view.usage).toEqual([]);
  });

  it("목표 노출은 결정 표 값이 먼저, 없으면 응답 값 — 어긋남은 서버 판정(결정 필드 또는 응답 필드)", () => {
    expect(claudeDecisionView({ book: "claude", response: RESPONSE, targetExposurePct: null }).targetExposure).toBe("35.0%");
    expect(claudeDecisionView({ book: "claude", response: { ...RESPONSE, targetEquityExposurePct: null } }).targetExposure).toBe("—");
    const fromField = claudeDecisionView({ book: "claude", response: RESPONSE, exposureMismatch: true });
    expect(fromField.mismatch?.label).toBe("목표 노출 ≠ 주문");
    expect(fromField.mismatch?.title).toContain("15%p");
    expect(claudeDecisionView({ book: "claude", response: { ...RESPONSE, exposureMismatch: true } }).mismatch).not.toBeNull();
  });

  it("검증 결과를 펼쳐 보내도(같은 줄에 ticker) 같은 줄로, 미리보기처럼 응답 밖에 따로 보내면 그것을", () => {
    const flat = claudeDecisionView({
      book: "claude",
      response: { ...RESPONSE, validation: undefined },
      validation: [{ ticker: "XLE", side: "BUY", targetWeightPct: 5, sellFraction: null, timing: "NEXT_CLOSE", accepted: false, rejectReason: "MIN_NOTIONAL", detail: "$300 < $500" }],
    });
    expect(flat.validation.map((row) => [row.ticker, row.result.label, row.reason, row.detail]))
      .toEqual([["XLE", "거절", "최소 금액 미만 (MIN_NOTIONAL)", "$300 < $500"]]);
  });

  it("사용량 — 모델과 토큰(서버 이름이든 Anthropic 원래 이름이든), 모르는 값은 —", () => {
    const view = claudeDecisionView({
      book: "claude", response: RESPONSE, model: "claude-sonnet-5-5",
      usage: { input_tokens: 24512, outputTokens: 3120, cache_read_input_tokens: 0, stopReason: "end_turn" },
    });
    expect(view.usage.map((cell) => [cell.label, cell.value])).toEqual([
      ["모델", "claude-sonnet-5-5"],
      ["입력 토큰", "24,512"],
      ["출력 토큰", "3,120"],
      ["캐시 읽기 토큰", "0"],
      ["캐시 쓰기 토큰", "—"],
      ["멈춘 이유", "end_turn"],
    ]);
  });

  it("응답이 없으면(형식 오류·거절·API 오류) Claude 기록이지만 응답 없음 — 빈 표를 '주문 없음'으로 그리지 않게", () => {
    const view = claudeDecisionView({ book: "claude", response: null, usage: { inputTokens: 100, outputTokens: 0 } });
    expect(view.recognized).toBe(true);
    expect(view.hasResponse).toBe(false);
    expect(view.orders).toEqual([]);
    expect(view.targetExposure).toBe("—");
    expect(view.usage.map((cell) => cell.label)).toContain("입력 토큰");
  });

  it("응답이 없을 때의 한 줄은 상태에 맞춰 — 건너뛴 기록(SKIPPED)은 'Claude를 부르지 않음 — 서버 사유', 형식 오류·거절·API 오류만 그 문구", () => {
    const cap = "일일 호출 상한(6회, KST 2026-10-27)에 닿아 Claude를 부르지 않았습니다 — 설정 apiDailyCallCap — 그날 재량 주문 없음";
    // recordSkipped 모양 — 사유가 summary와 skipped 둘 다에, 오류·사용량은 없음
    const skipped = claudeDecisionView({
      book: "claude", status: "SKIPPED",
      response: { summary: cap, book: "claude", kind: "SCHEDULED", asOfTradingDate: "2026-10-26", skipped: cap, settings: {} },
    });
    expect(skipped.recognized).toBe(true);
    expect(skipped.hasResponse).toBe(false);
    expect(skipped.skipped).toBe(cap);
    expect(skipped.noResponse).toBe(`Claude를 부르지 않음 — ${cap}`);
    expect(skipped.noResponse).not.toContain("응답 형식 오류");
    // skipped 키가 없고 summary만 있어도 사유로 읽습니다(응답이 없을 때만).
    const paused = "일시정지 중 — Claude를 부르지 않고 주문을 내지 않습니다(재개한 뒤의 결정부터 다시 부릅니다)";
    expect(claudeDecisionView({ book: "claude", status: "SKIPPED", response: { summary: paused } }).noResponse)
      .toBe(`Claude를 부르지 않음 — ${paused}`);
    // 상태를 모르면 건너뛴 기록만 남기는 skipped 키로 알아봅니다 — summary만으로는 단정하지 않음
    expect(claudeDecisionView({ book: "claude", response: { skipped: paused } }).noResponse).toBe(`Claude를 부르지 않음 — ${paused}`);
    expect(claudeDecisionView({ book: "claude", response: { summary: "?" } }).noResponse).toBe("검사한 모델 응답이 없습니다(상태와 오류를 보세요).");
    // 사유가 없는 SKIPPED도 지어내지 않고 없다고
    expect(claudeDecisionView({ book: "claude", status: "SKIPPED", response: {} }).noResponse)
      .toBe("Claude를 부르지 않음 — 서버가 사유를 남기지 않았습니다.");

    for (const status of ["REFUSED", "FORMAT_ERROR", "API_ERROR"]) {
      const failed = claudeDecisionView({ book: "claude", status, response: null });
      expect(failed.noResponse).toBe("검사한 모델 응답이 없습니다 — 응답 형식 오류·모델 거절·API 오류면 그날 재량 주문이 없습니다(상태와 오류를 보세요).");
      expect(failed.skipped).toBeNull();
    }
    expect(claudeDecisionView({ book: "claude", status: "OK", response: null }).noResponse).toBe("검사한 모델 응답이 없습니다(상태와 오류를 보세요).");
  });

  it("응답이 있으면 응답 없음 줄은 없고, summary는 모델의 요약이지 건너뛴 사유가 아니다 — skipped 키가 있으면 그것만", () => {
    const view = claudeDecisionView({ book: "claude", status: "OK", response: RESPONSE });
    expect(view.noResponse).toBeNull();
    expect(view.skipped).toBeNull();
    const noted = claudeDecisionView({ book: "claude", status: "OK", response: { ...RESPONSE, skipped: "결정 중 일시정지 — 집행 안 함" } });
    expect(noted.hasResponse).toBe(true);
    expect(noted.skipped).toBe("결정 중 일시정지 — 집행 안 함");
  });

  it("규칙 책 기록은 Claude 기록으로 보지 않는다 — 응답 모양(stance만)으로도", () => {
    expect(claudeDecisionView({ book: "rules", response: { gate: {}, selection: {} } }).recognized).toBe(false);
    expect(claudeDecisionView({ book: "rules", response: { stance: "neutral" } }).recognized).toBe(false);
    // 책 코드를 모르더라도 검증 결과·목표 노출이 있으면 Claude 기록입니다.
    expect(claudeDecisionView({ response: { targetEquityExposurePct: 50 } }).recognized).toBe(true);
  });

  it("상세 머리 — 프레임 칸은 response.framework의 판 번호·상태(임시면 '임시 v0'), 제목은 마우스를 올려 본다", () => {
    const detail: PaperDecisionDetail = {
      id: 3, book: "claude", asOfTradingDate: "2026-10-26", kind: "SCHEDULED", status: "OK", decidedAtKst: "2026-10-27 07:41",
      model: "claude-sonnet-5-5", frameworkVersion: 0, settingsVersion: 2, selectionAsOf: null, targetExposurePct: 35,
      summary: null, orderCount: 3, rejectedCount: 2, pricesFinal: true, error: null,
      packet: {}, packetHash: null,
      response: { ...RESPONSE, framework: { version: 0, status: "INTERIM", title: "임시 v0 — OS 원문 반영 전" } },
      usage: null, noteIds: null, latencyMs: null, retryCount: 0,
    };
    expect(decisionMeta(detail).map((cell) => [cell.label, cell.value]).slice(4)).toEqual([
      ["모델", "claude-sonnet-5-5"],
      ["프레임 버전", "임시 v0"],
      ["목표 주식 노출", "35.0%"],
    ]);
    expect(decisionMeta(detail).find((cell) => cell.key === "frameworkVersion")?.title).toBe("임시 v0 — OS 원문 반영 전");
    // 사용자 판은 번호만, response.framework가 없으면 목록의 frameworkVersion(상태 모름 — 번호만)
    const user = { ...detail, frameworkVersion: 1, response: { ...RESPONSE, framework: { version: 1, status: "USER", title: "투자 OS" } } };
    expect(decisionMeta(user).find((cell) => cell.key === "frameworkVersion")?.value).toBe("v1");
    expect(decisionMeta({ ...detail, frameworkVersion: 2, response: RESPONSE }).find((cell) => cell.key === "frameworkVersion")?.value)
      .toBe("v2");
  });

  it("상세 머리 — 단계 3a 기록(판 번호 전 임시 프롬프트, {version:null, interim:true})은 '판 번호 없음', 규칙 책은 칸이 없다", () => {
    const old: PaperDecisionDetail = {
      id: 4, book: "claude", asOfTradingDate: "2026-10-26", kind: "MANUAL", status: "OK", decidedAtKst: null,
      model: "claude-sonnet-5-5", frameworkVersion: null, settingsVersion: 2, selectionAsOf: null, targetExposurePct: null,
      summary: null, orderCount: 0, rejectedCount: 0, pricesFinal: true, error: null,
      packet: {}, packetHash: null,
      response: { ...RESPONSE, framework: { version: null, interim: true, label: "프레임 v1 준비 전 임시" } },
      usage: null, noteIds: null, latencyMs: null, retryCount: 0,
    };
    expect(decisionMeta(old).find((cell) => cell.key === "frameworkVersion")?.value).toBe("임시 — 판 번호 없음(단계 3b 전 기록)");
    expect(decisionMeta({ ...old, book: "rules", model: null, response: {} }).find((cell) => cell.key === "frameworkVersion"))
      .toBeUndefined();
  });

  it("F3 상세 머리 — Claude를 부르지 않은 SKIPPED(response에 framework 없음)는 '단계 3b 전 기록'이 아니라 'Claude를 부르지 않음'", () => {
    const skipped: PaperDecisionDetail = {
      id: 9, book: "claude", asOfTradingDate: "2026-11-05", kind: "SCHEDULED", status: "SKIPPED", decidedAtKst: "2026-11-06 07:30",
      model: null, frameworkVersion: null, settingsVersion: 3, selectionAsOf: null, targetExposurePct: null,
      summary: "일일 호출 상한(6회)에 닿아 Claude를 부르지 않았습니다", orderCount: 0, rejectedCount: 0, pricesFinal: true, error: null,
      packet: null, packetHash: null,
      response: { summary: "일일 호출 상한", book: "claude", kind: "SCHEDULED", asOfTradingDate: "2026-11-05", skipped: "일일 호출 상한", settings: {} },
      usage: null, noteIds: null, latencyMs: null, retryCount: 0,
    };
    const cell = decisionMeta(skipped).find((entry) => entry.key === "frameworkVersion");
    expect(cell?.value).toBe("— (Claude를 부르지 않음)");
    expect(cell?.value).not.toContain("3b 전");
    // framework도 SKIPPED도 아닌 모양을 모르는 기록은 단정하지 않습니다.
    expect(decisionMeta({ ...skipped, status: "API_ERROR", response: {} }).find((entry) => entry.key === "frameworkVersion")?.value)
      .toBe("— (판 기록 없음)");
  });
});

describe("Claude 책 시작 카드", () => {
  const BOOKS = [book("rules", { kind: "RULES", label: "규칙 계좌" }), CLAUDE_NOT_STARTED];

  it("시작 전이면 카드 — 출발일 패킷·검증·사후 체결·노출은 Claude가, 임시 v0이면 OS 원문으로 v1을 만든 뒤 시작 권고, 비용 안내", () => {
    const prompt = claudeStartPrompt(
      { initialized: true, startDate: "2026-10-23", books: BOOKS },
      { version: 0, status: "INTERIM", title: "임시 v0 — OS 원문 반영 전" },
    );
    expect(prompt?.bookCode).toBe("claude");
    expect(prompt?.title).toBe("Claude 계좌 시작");
    expect(prompt?.body).toContain("출발일(2026-10-23) 기준 입력 패킷");
    expect(prompt?.body).toContain("검증기(하드 규칙)를 통과한 주문만 출발일 종가에 사후 체결");
    expect(prompt?.body).toContain("노출 0%도 100%도 거절 사유가 아닙니다");
    expect(prompt?.framework.tone).toBe("warn");
    expect(prompt?.framework.text).toContain("지금 프레임은 임시 v0입니다 — OS 원문으로 v1을 만든 뒤 시작을 권합니다");
    expect(prompt?.framework.text).toContain("'OS 원문으로 새 판 만들기'");
    expect(prompt?.cost).toContain("Sonnet 5.5 호출 1회, 약 $0.1");
    expect(prompt?.confirmPreview).toContain("장부·결정·주문 기록은 바꾸지 않습니다(사용량과, 없을 때만 출발일 기관 선정");
    expect(prompt?.confirmPreview).toContain(CLAUDE_COST_NOTE);
    expect(prompt?.confirmStart).toContain("정말 시작할까요?");
    expect(prompt?.confirmStart).toContain("'계좌 초기화'");
    expect(prompt?.confirmStart).toContain("미리보기와 같은 답이 나온다는 보장은 없습니다");
    expect(prompt?.confirmStart).toContain("프레임은 아직 임시 v0입니다.");
  });

  it("프레임 안내 — 사용자 판이면 그 판 번호(정보색), 승인으로 임시를 이어받은 판은 그 번호로 권고, 판을 모르면 단정하지 않는다", () => {
    const base = { initialized: true, startDate: "2026-10-23", books: BOOKS };
    const user = claudeStartPrompt(base, { version: 1, status: "USER", title: "투자 OS 2026-10" });
    expect(user?.framework).toEqual({
      tone: "info",
      text: "지금 프레임은 v1 (투자 OS 2026-10)입니다 — Claude는 이 판으로 판단합니다. 시작은 한 번뿐이니 미리보기로 이 판의 판단을 먼저 볼 수 있습니다.",
    });
    expect(user?.confirmStart).toContain("판단 프레임은 v1입니다.");
    const inherited = claudeStartPrompt(base, { version: 2, status: "INTERIM", title: null });
    expect(inherited?.framework.text).toContain("지금 프레임은 임시 v2입니다 — OS 원문으로 사용자 판을 만든 뒤 시작을 권합니다.");
    const unknown = claudeStartPrompt(base);
    expect(unknown?.framework.tone).toBe("warn");
    expect(unknown?.framework.text).toContain("지금 프레임 판을 아직 읽지 못했습니다");
    expect(unknown?.confirmStart).not.toContain("프레임");
  });

  it("이미 시작했거나·초기화 전이거나·Claude 책이 없으면 카드 없음", () => {
    expect(claudeStartPrompt({ initialized: true, startDate: "2026-10-23", books: [book("claude", { kind: "CLAUDE" })] })).toBeNull();
    expect(claudeStartPrompt({ initialized: false, startDate: "2026-10-23", books: BOOKS })).toBeNull();
    expect(claudeStartPrompt({ initialized: true, startDate: "2026-10-23", books: [BOOKS[0]] })).toBeNull();
  });

  it("미리보기 결과 — 성공은 정보색(장부 그대로·다시 부르면 달라질 수 있음), 실패·ok:false는 경고", () => {
    const ok = claudePreviewResultView({ ok: true, preview: true, model: "claude-sonnet-5-5", response: RESPONSE });
    expect(ok.tone).toBe("info");
    expect(ok.text).toContain("claude-sonnet-5-5의 응답을 검증까지 했습니다");
    expect(ok.text).toContain("장부·결정·주문 기록은 바꾸지 않았습니다");
    // 미리보기는 사용량 말고도 출발일 선정·출발일 종가를 남깁니다(없을 때만) — "사용량만"이라고 하지 않음
    expect(ok.text).toContain("출발일 기관 선정");
    expect(ok.text).not.toContain("사용량만");
    expect(ok.text).toContain("답이 달라질 수 있습니다");
    const failed = claudePreviewResultView({ ok: true, status: "FORMAT_ERROR", error: "orders[0].ticker: 형식이 다릅니다", response: null });
    expect(failed).toEqual({
      tone: "warn",
      text: "미리보기 — 응답 형식 오류: orders[0].ticker: 형식이 다릅니다. 장부·결정·주문 기록은 바꾸지 않았습니다"
        + "(남긴 것: 사용량, 없을 때만 출발일 기관 선정·제안 종목의 출발일 종가).",
    });
    expect(claudePreviewResultView({ ok: false, message: "하루 호출 상한(6회)에 닿았습니다." }))
      .toEqual({ tone: "warn", text: "하루 호출 상한(6회)에 닿았습니다." });
  });

  it("시작 결과 — 책 이름을 받고, 결정 오류(응답 형식 오류 등)는 경고색으로 붙인다", () => {
    const started = initialDecisionResultView({
      ok: true, fills: [],
      decision: {
        id: 5, book: "claude", asOfTradingDate: "2026-10-23", kind: "INITIAL", status: "FORMAT_ERROR", decidedAtKst: null, model: "claude-sonnet-5-5",
        frameworkVersion: null, settingsVersion: 1, selectionAsOf: null, targetExposurePct: null, summary: null, orderCount: 0,
        rejectedCount: 0, pricesFinal: true, error: "응답이 스키마와 다릅니다",
      },
    }, "Claude 계좌");
    expect(started.tone).toBe("warn");
    expect(started.text).toBe("Claude 계좌를 시작했습니다 · 2026-10-23 초기 결정 · 주문 0건 · 사후 체결 0건 — 오류: 응답이 스키마와 다릅니다");
    expect(initialDecisionResultView({ ok: false }, "Claude 계좌").text).toBe("Claude 계좌를 시작하지 못했습니다.");
    // 기본 이름은 그대로 규칙 책입니다.
    expect(initialDecisionResultView({ ok: false }).text).toBe("규칙 계좌를 시작하지 못했습니다.");
  });
});

describe("Claude 노출 추이", () => {
  it("서버 순서 그대로 행으로 — 모르는 값은 null(선을 끊음), 날짜 없는 줄은 뺌, 마지막 날 한 줄", () => {
    const chart = claudeExposureChart([
      { tradingDate: "2026-10-23", targetExposurePct: 60, actualExposurePct: 58.237 },
      { tradingDate: "2026-10-26", targetExposurePct: null, actualExposurePct: 57.1 },
      { tradingDate: null, targetExposurePct: 10, actualExposurePct: 10 },
      { tradingDate: "2026-10-27", targetExposurePct: 35, actualExposurePct: null },
    ]);
    expect(chart.rows).toEqual([
      { date: "2026-10-23", target: 60, actual: 58.237 },
      { date: "2026-10-26", target: null, actual: 57.1 },
      { date: "2026-10-27", target: 35, actual: null },
    ]);
    expect(chart.series.map((line) => line.key)).toEqual(["target", "actual"]);
    expect(chart.latest).toBe("2026-10-27 — 목표 35.0% · 실제 —");
  });

  it("기록이 없거나 필드가 없으면 빈 행과 null", () => {
    expect(claudeExposureChart(undefined)).toMatchObject({ rows: [], latest: null });
    expect(claudeExposureChart([])).toMatchObject({ rows: [], latest: null });
  });
});

describe("Claude 호출 사용량(명세 C8)", () => {
  const USAGE = {
    today: {
      day: "2026-10-27", calls: 2, cap: 6, inputTokens: 45012, outputTokens: 6200, cacheReadTokens: 7800, cacheWriteTokens: 0,
      estCostUsd: 0.0912, estimatedCalls: 1, isEstimated: true,
    },
    month: {
      month: "2026-10", days: 3, calls: 5, inputTokens: 120034, outputTokens: 15500, cacheReadTokens: 23400, cacheWriteTokens: 8100,
      estCostUsd: 0.3104, estimatedCalls: 4, isEstimated: true,
    },
    note: "호출 수는 성공·실패를 모두 셉니다. 토큰은 응답이 알려 준 값의 합입니다.",
  };

  it("오늘(호출/상한·추정 비용·토큰)과 이달 누적 — 서버 값 그대로, 추정 비용은 '추정'과 추정한 호출 수를 함께", () => {
    const view = apiUsageView(USAGE);
    expect(view?.todayLabel).toBe("오늘(KST 2026-10-27)");
    expect(view?.today.map((cell) => [cell.label, cell.value])).toEqual([
      ["호출 / 하루 상한", "2 / 6회"], ["추정 비용", "추정 $0.09 · 추정 1/2회"],
      ["입력 토큰", "45,012"], ["출력 토큰", "6,200"], ["캐시 읽기 토큰", "7,800"], ["캐시 쓰기 토큰", "0"],
    ]);
    expect(view?.monthLabel).toBe("이달(KST 2026-10)");
    expect(view?.month.map((cell) => [cell.label, cell.value])).toEqual([
      ["호출", "5회"], ["추정 비용", "추정 $0.31 · 추정 4/5회"],
      ["입력 토큰", "120,034"], ["출력 토큰", "15,500"], ["캐시 읽기 토큰", "23,400"], ["캐시 쓰기 토큰", "8,100"],
    ]);
    expect(view?.capReached).toBe(false);
    expect(view?.note).toBe(USAGE.note);
    // 추정한 호출이 전체보다 적으면 빠진 호출이 있다고 적습니다(단가 도입 전·토큰 모름).
    expect(view?.costNote).toContain(API_COST_ESTIMATE_NOTE);
    expect(view?.costNote).toContain("추정에서 빠진 호출이 있습니다");
  });

  it("추정 금액이 null이면 '—'(0으로 채우지 않음), 1센트 미만은 4자리 — Haiku 한 번이 $0.00으로 보이지 않게", () => {
    const none = apiUsageView({ ...USAGE, today: { ...USAGE.today, estCostUsd: null, estimatedCalls: 0 } });
    expect(none?.today[1]).toEqual({ key: "estCost", label: "추정 비용", value: "—" });
    const haiku = apiUsageView({ ...USAGE, today: { ...USAGE.today, calls: 1, estCostUsd: 0.0045, estimatedCalls: 1 } });
    expect(haiku?.today[1].value).toBe("추정 $0.0045 · 추정 1/1회");
    const all = apiUsageView({ ...USAGE, month: { ...USAGE.month, estimatedCalls: 5 }, today: { ...USAGE.today, estimatedCalls: 2 } });
    expect(all?.costNote).toBe(API_COST_ESTIMATE_NOTE);
  });

  it("상한에 닿으면 표시, 모르는 값은 —(0으로 채우지 않음), 추정 필드를 보내지 않는 서버는 비용 칸 없이 그렇다고, 사용량이 없으면 null", () => {
    expect(apiUsageView({ ...USAGE, today: { ...USAGE.today, calls: 6 } })?.capReached).toBe(true);
    const partial = apiUsageView({ today: { day: "2026-10-27", calls: 1, cap: null }, month: {} });
    expect(partial?.today[0].value).toBe("1 / —회");
    expect(partial?.today[1].value).toBe("—");
    expect(partial?.today.some((cell) => cell.key === "estCost")).toBe(false);
    expect(partial?.month[0].value).toBe("—회");
    expect(partial?.monthLabel).toBe("이달(KST —)");
    expect(partial?.note).toBeNull();
    expect(partial?.costNote).toBe(API_COST_NOT_SENT);
    expect(apiUsageView(undefined)).toBeNull();
    expect(apiUsageView({ note: "x" })).toBeNull();
  });

  it("수동 호출 문턱(manual — 한국 카드): 상한 − 예약 칸과 문턱 닿음, 미국 기본(인자 없음)은 칸·판정이 예전 그대로", () => {
    const withReserve = { ...USAGE, today: { ...USAGE.today, cap: 20, calls: 13, scheduledReserve: 7, manualLimit: 13 } };
    const us = apiUsageView(withReserve);
    expect(us?.today.map((cell) => cell.key)).toEqual(["calls", "estCost", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]);
    expect(us).not.toHaveProperty("manualReached");

    const kr = apiUsageView(withReserve, { manual: true });
    expect(kr?.today[1]).toEqual({ key: "manualLimit", label: "수동 호출 문턱", value: "13회(하루 상한 20 − 정기 작업 몫 7)" });
    expect(kr?.manualReached).toBe(true);
    expect(kr?.capReached).toBe(false);
    expect(apiUsageView({ ...withReserve, today: { ...withReserve.today, calls: 12 } }, { manual: true })?.manualReached).toBe(false);
    // 문턱을 보내지 않는 서버 — 칸을 그리지 않고 닿음도 모름(false)
    const old = apiUsageView(USAGE, { manual: true });
    expect(old?.today.some((cell) => cell.key === "manualLimit")).toBe(false);
    expect(old?.manualReached).toBe(false);
  });
});
