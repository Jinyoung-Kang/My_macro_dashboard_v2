/**
 * 모의매매 결정 로그의 시각순 목록 줄(lib/paperTimeline — 작업대 P6 W13): 결정은 거래일 묶음·결정 시각 'MM-DD HH:mm'·종류(장중 확인·장중 판단은 시계 표지)·
 * 상태·주문 수·목표 노출(Claude 계좌만)·가격·서버 요약·오류, 주간 복기는 복기 주·이름 '{주} 주 복기'와 복기 표 줄 값. 모르는 값은 '—'(0으로 채우지 않음).
 */
import { describe, expect, it } from "vitest";

import { EMPTY } from "../format";
import { decisionTimeCell, decisionTimelineEntries, reviewTimelineEntries, tradingDayGroup } from "../paperTimeline";
import type { PaperDecisionSummary, PaperReviewSummary } from "../types";

function decision(id: number, over: Partial<PaperDecisionSummary> = {}): PaperDecisionSummary {
  return {
    id, book: "rules", asOfTradingDate: "2026-10-26", kind: "SCHEDULED", status: "OK", decidedAtKst: "2026-10-27 07:31",
    model: null, frameworkVersion: null, settingsVersion: 1, selectionAsOf: null, targetExposurePct: null,
    summary: "매도 신호 없음", orderCount: 2, rejectedCount: 1, pricesFinal: true, error: null, ...over,
  };
}

describe("decisionTimeCell — 결정 시각 열", () => {
  it("KST 글('YYYY-MM-DD HH:mm', 꼬리 KST·초)은 'MM-DD HH:mm'과 ISO(+09:00)", () => {
    expect(decisionTimeCell("2026-10-27 07:31")).toEqual({ at: "10-27 07:31", dateTime: "2026-10-27T07:31+09:00" });
    expect(decisionTimeCell("2026-11-04 01:05 KST")).toEqual({ at: "11-04 01:05", dateTime: "2026-11-04T01:05+09:00" });
    expect(decisionTimeCell("2026-11-04 01:05:42 KST")).toEqual({ at: "11-04 01:05", dateTime: "2026-11-04T01:05+09:00" });
  });

  it("모르면 '—'(ISO 없음), 꼴이 다른 글은 그대로", () => {
    expect(decisionTimeCell(null)).toEqual({ at: EMPTY });
    expect(decisionTimeCell("")).toEqual({ at: EMPTY });
    expect(decisionTimeCell("어제 아침")).toEqual({ at: "어제 아침" });
  });
});

describe("tradingDayGroup — 거래일 묶음 머리", () => {
  it("날짜면 '거래일 날짜'와 기계 날짜, 비면 묶음 없음", () => {
    expect(tradingDayGroup("2026-10-26")).toEqual({ key: "2026-10-26", label: "거래일 2026-10-26", dateTime: "2026-10-26" });
    expect(tradingDayGroup("10/26")).toEqual({ key: "10/26", label: "거래일 10/26", dateTime: undefined });
    expect(tradingDayGroup("")).toBeNull();
    expect(tradingDayGroup(null)).toBeNull();
  });
});

describe("decisionTimelineEntries — 결정 줄", () => {
  it("미국 규칙 계좌: 키 = 결정 번호, 이름 '{거래일} {종류}', 상태·주문 수·가격·요약, 목표 노출 없음", () => {
    const [line] = decisionTimelineEntries([decision(7)], { market: "US", showExposure: false });
    expect(line).toMatchObject({
      key: "7", id: 7, at: "10-27 07:31", dateTime: "2026-10-27T07:31+09:00", kind: "정기", intraday: false,
      title: "2026-10-26 정기", group: { key: "2026-10-26", label: "거래일 2026-10-26" }, orders: "2건 · 거절 1", exposure: null,
      summary: "매도 신호 없음", error: null,
    });
    expect(line.status.label).toBe("주문 냄");
    expect(line.price.label).toBe("확정 종가");
  });

  it("값을 모르면 '—' — 주문 수·가격·목표 노출(Claude), 요약은 null(줄에서 '—')", () => {
    const [line] = decisionTimelineEntries(
      [decision(8, { status: "NO_TRADE", orderCount: null, rejectedCount: null, pricesFinal: null, summary: null, targetExposurePct: null })],
      { market: "US", showExposure: true },
    );
    expect(line.orders).toBe(EMPTY);
    expect(line.price.label).toBe(EMPTY);
    expect(line.exposure).toBe(EMPTY);
    expect(line.summary).toBeNull();
    expect(line.status.label).toBe("주문 없음");
  });

  it("Claude 계좌: 목표 노출 소수 첫째 자리, 확정 전 값은 주의색, 저장된 오류 문장", () => {
    const [line] = decisionTimelineEntries(
      [decision(21, { book: "claude", targetExposurePct: 35, pricesFinal: false, status: "API_ERROR", error: "[HTTP] 529 overloaded" })],
      { market: "US", showExposure: true },
    );
    expect(line.exposure).toBe("35.0%");
    expect(line.price).toEqual({ label: "확정 전 값", className: "text-warn" });
    expect(line.error).toBe("[HTTP] 529 overloaded");
    expect(line.status.label).toBe("API 오류");
  });

  it("장중 확인·장중 판단 n은 시계 표지와 재시도 없음 상태, 정기·수동·재선정일·초기 결정은 표지 없음", () => {
    const lines = decisionTimelineEntries(
      [
        decision(1, { kind: "CHECKPOINT", status: "API_ERROR" }),
        decision(2, { kind: "INTRADAY_2", status: "FORMAT_ERROR" }),
        decision(3, { kind: "MANUAL" }),
        decision(4, { kind: "REBALANCE" }),
        decision(5, { kind: "INITIAL" }),
      ],
      { market: "US", showExposure: true },
    );
    expect(lines.map((line) => [line.kind, line.intraday])).toEqual([
      ["장중 확인", true], ["장중 판단 2", true], ["수동", false], ["재선정일", false], ["초기 결정", false],
    ]);
    expect(lines.slice(0, 2).map((line) => line.status.label)).toEqual(["API 오류(재시도 없음)", "응답 형식 오류(재시도 없음)"]);
  });

  it("한국: 출발은 '출발(초기 결정)', 가격은 잠정(토스)·확정 — 이름도 한국 종류", () => {
    const lines = decisionTimelineEntries(
      [
        decision(40, { book: "kr_rules", kind: "INITIAL", asOfTradingDate: "2026-10-30", decidedAtKst: "2026-10-30 22:31 KST", pricesFinal: false }),
        decision(41, { book: "kr_rules", pricesFinal: true }),
      ],
      { market: "KR", showExposure: false },
    );
    expect(lines.map((line) => [line.title, line.price.label])).toEqual([
      ["2026-10-30 출발(초기 결정)", "잠정(토스)"],
      ["2026-10-26 정기", "확정"],
    ]);
    expect(lines[0].at).toBe("10-30 22:31");
  });

  it("거래일이 비면 묶음 없음, 차례는 서버 그대로", () => {
    const lines = decisionTimelineEntries([decision(9, { asOfTradingDate: "" }), decision(3), decision(2)], { market: "US", showExposure: false });
    expect(lines.map((line) => line.key)).toEqual(["9", "3", "2"]);
    expect(lines[0].group).toBeNull();
  });
});

describe("reviewTimelineEntries — 주간 복기 줄", () => {
  const review = (weekEnding: string, over: Partial<PaperReviewSummary> = {}): PaperReviewSummary => ({
    weekEnding, status: "OK", windowWeeks: 4, model: "claude-sonnet-5-5", verdictCounts: { 유지: 1, 반증: 1, 판단불가: 0 },
    proposalId: 12, proposalStatus: "PENDING", createdAtKst: `${weekEnding} 21:05`, error: null, retryCount: 0, retryable: false,
    frameworkVersion: 1, ...over,
  } as PaperReviewSummary);

  it("시각 열 = 복기 주, 이름 '{주} 주 복기', 값은 복기 표 줄 그대로(창·판정 수·제안·남긴 시각)", () => {
    const [line, skipped] = reviewTimelineEntries([
      review("2026-10-30"),
      review("2026-10-23", { status: "SKIPPED", verdictCounts: null, proposalId: null, proposalStatus: null, error: "창 안에 결정이 없음" }),
    ]);
    expect(line).toMatchObject({
      key: "2026-10-30", weekEnding: "2026-10-30", at: "2026-10-30", dateTime: "2026-10-30", title: "2026-10-30 주 복기",
      window: "4주", counts: "유지 1 · 반증 1 · 판단불가 0", proposalId: 12, proposal: "제안 #12 · 승인 대기", createdAt: "2026-10-30 21:05",
    });
    expect(line.status.label).toBe("복기 완료");
    expect(skipped).toMatchObject({ counts: EMPTY, proposal: EMPTY, proposalId: null, note: "창 안에 결정이 없음" });
  });
});
