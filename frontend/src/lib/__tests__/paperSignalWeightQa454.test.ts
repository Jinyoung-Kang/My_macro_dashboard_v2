/**
 * 모의 매매 규칙 책 결정의 '13F 신호 이벤트'·'매수 후보' 비중 표기(QA-454 검토 지적). 기록은 모두 합성 값입니다(가상 CIK·티커).
 *
 * 이 표의 비중은 그 기관 13F 총액 대비 %(Signal13F weightPct — 서버가 소수 4자리로 남김)라, 큰 기관이 작게 새로 든 종목은 0.003처럼
 * 0보다 크지만 소수 둘째 자리로 반올림하면 0이 됩니다. 정보 검색·종목 상세의 13F 비중과 같이 '<0.01%'로 적고, 정확히 0(전량 매도의 이번
 * 분기·신규 편입의 직전 분기)은 '0.00%', 모르는 값은 "—"로 둡니다.
 */
import { describe, expect, it } from "vitest";
import { ruleDecisionView } from "../paper";

const RECORD = {
  signals: {
    events: [
      { cik: "0009999901", rank: 1, ticker: "SYTA", action: "NEW", sharesChangePct: null, weightPct: 0.003, previousWeightPct: 0 },
      { cik: "0009999902", rank: 2, ticker: "SYTA", action: "ADDED", sharesChangePct: 40, weightPct: 0.0049, previousWeightPct: 0.0021 },
      { cik: "0009999903", rank: 3, ticker: "SYTB", action: "CLOSED", sharesChangePct: null, weightPct: 0, previousWeightPct: 0.004 },
      { cik: "0009999904", rank: 4, ticker: "SYTC", action: "NEW", sharesChangePct: null, weightPct: 1.25, previousWeightPct: null },
    ],
    candidates: [
      { ticker: "SYTA", buyerCiks: ["0009999901", "0009999902"], rankSum: 3, combinedWeightPct: 0.0079, events: [] },
      { ticker: "SYTC", buyerCiks: ["0009999904"], rankSum: 4, combinedWeightPct: 0.0012, events: [] },
    ],
  },
};

describe("규칙 책 결정 — 13F 신호 비중이 0보다 크고 0.005% 미만이면 '<0.01%'(QA-454)", () => {
  it("신호 이벤트의 비중·직전 비중 — 정확히 0은 0.00%, 모르는 값은 —", () => {
    const view = ruleDecisionView(RECORD);
    expect(view.events.map(({ ticker, weight, previousWeight }) => [ticker, weight, previousWeight])).toEqual([
      ["SYTA", "<0.01%", "0.00%"],
      ["SYTA", "<0.01%", "<0.01%"],
      ["SYTB", "0.00%", "<0.01%"],
      ["SYTC", "1.25%", "—"],
    ]);
  });

  it("매수 후보의 합산 비중", () => {
    const view = ruleDecisionView(RECORD);
    expect(view.candidates.map(({ ticker, combinedWeight }) => [ticker, combinedWeight])).toEqual([
      ["SYTA", "0.01%"],
      ["SYTC", "<0.01%"],
    ]);
  });
});
