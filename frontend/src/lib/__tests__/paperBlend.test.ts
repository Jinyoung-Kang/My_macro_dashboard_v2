/**
 * 모의 매매 — 두 기관 그룹 섞기(D27)의 표기. 그룹 B 트랙레코드·신호 풀·기관 가중·후보 점수·점수 기여·배분 방식.
 * 숫자(가중·확신도·점수)는 서버 값을 표기만 하고 다시 계산하지 않는다(ADR 0004). 모르는 값은 "—", 0으로 채우지 않는다.
 */
import { describe, expect, it } from "vitest";
import {
  eligibilityBadge,
  formatRatioPercent,
  formatScore,
  groupBadge,
  groupBCriteria,
  groupBLimit,
  groupRankText,
  groupsOf,
  orderReasonText,
  poolWeightNote,
  ruleDecisionView,
  selectionHistoryRows,
  signalPoolRows,
  trackRecordLimits,
  trackSourceText,
  windowLabel,
} from "../paper";
import type { PaperTrackRecordCandidate } from "../types";

function candidate(cik: string, over: Partial<PaperTrackRecordCandidate> = {}): PaperTrackRecordCandidate {
  return {
    cik, name: `기관 ${cik}`, style: null, rank: null, eligible: false, ineligibleReason: null, cagrPct: 12.3456,
    cumReturnPct: 25.5, spyCumReturnPct: 20.25, excessVsSpyPct: 5.25, volPct: 18.2, mddPct: -12.1, sharpe: 0.71,
    periodsUsed: 8, periodsTotal: 8, coverageMin: 0.523, coverageAvg: 0.786, firstFilingDate: "2024-11-14",
    lastFilingDate: "2026-08-14", storedQuarters: null, complete: false, selected: false, periods: [], ...over,
  };
}

const CRITERIA_A = { windowYears: 7, minPeriods: 24, minCoverage: 0.5, avgCoverage: 0.7 };

describe("그룹 B 트랙레코드", () => {
  it("자격 기준 — 서버 기준이 있으면 그것, 없으면 그룹 B의 창·구간 수에 그룹 A의 커버리지 기준", () => {
    expect(groupBCriteria({ windowYears: 2, minPeriods: 6 }, CRITERIA_A))
      .toEqual({ windowYears: 2, minPeriods: 6, minCoverage: 0.5, avgCoverage: 0.7 });
    const sent = { windowYears: 2, minPeriods: 6, minCoverage: 0.6, avgCoverage: 0.8 };
    expect(groupBCriteria({ windowYears: 2, minPeriods: 6, criteria: sent }, CRITERIA_A)).toEqual(sent);
    // 창·구간 수나 그룹 A 기준을 모르면 짐작하지 않음
    expect(groupBCriteria({ windowYears: null, minPeriods: 6 }, CRITERIA_A)).toBeNull();
    expect(groupBCriteria({ windowYears: 2, minPeriods: 6 }, null)).toBeNull();
    expect(groupBCriteria(null, CRITERIA_A)).toBeNull();
  });

  it("창 이름 — 연수를 모르면 숫자 없이", () => {
    expect(windowLabel(2)).toBe("2년 창");
    expect(windowLabel(7)).toBe("7년 창");
    expect(windowLabel(null)).toBe("창");
  });

  it("자격 배지 — 그룹 B는 complete=false를 수집 중으로 보지 않는다(서버가 collecting을 보낼 때만)", () => {
    expect(eligibilityBadge(candidate("a", { complete: false }), "B").label).toBe("자격 없음");
    expect(eligibilityBadge(candidate("b", { complete: false, collecting: true }), "B").label).toBe("수집 중");
    expect(eligibilityBadge(candidate("c", { complete: false, eligible: true }), "B").label).toBe("자격");
    // 그룹 A는 예전 그대로
    expect(eligibilityBadge(candidate("d", { complete: false })).label).toBe("수집 중");
  });

  it("출처 칸 — q30·q8과 저장 분기 수, 출처를 모르면 —", () => {
    expect(trackSourceText(candidate("a", { source: "q30", storedQuarters: 30 }))).toEqual({
      label: "q30 · 30분기", title: "후보 수집 저장본(sec.13f.{cik}.q30) — 같은 분기 JSON의 CUSIP 매핑 티커",
    });
    expect(trackSourceText(candidate("b", { source: "q8" })).label).toBe("q8");
    expect(trackSourceText(candidate("b", { source: "q8" })).title).toContain("8분기");
    expect(trackSourceText(candidate("c", { source: null })).label).toBe("—");
    expect(trackSourceText(candidate("d")).label).toBe("—");
  });

  it("한계 — 서버 문구 뒤에 '그룹 B는 2년 창 — 표본이 짧다'를 덧붙이고, 서버가 이미 보냈으면 두 번 적지 않는다", () => {
    const server = ["복제 수익률입니다.", "생존 편향이 있습니다."];
    const lines = trackRecordLimits(server, { windowYears: 2 }, 7);
    expect(lines.slice(0, 2)).toEqual(server);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("그룹 B는 2년 창 — 표본이 짧다");
    expect(lines[2]).toContain("7년 창의 그룹 A");
    expect(trackRecordLimits(server, null, 7)).toEqual(server);
    const already = [...server, "그룹 B는 2년 창이라 표본이 짧습니다."];
    expect(trackRecordLimits(already, { windowYears: 2 }, 7)).toEqual(already);
    expect(trackRecordLimits(undefined, { windowYears: null }, null)[0]).toContain("그룹 B는 짧은 창 — 표본이 짧다");
    expect(groupBLimit(1, null)).toContain("그룹 B는 1년 창 — 표본이 짧다");
  });

  it("선정 이력 — 그룹 A·B 후보 둘 다에서 이름을 찾고, 두 그룹에 모두 있으면 앞(그룹 A) 이름", () => {
    const rows = selectionHistoryRows(
      [{ asOfDate: "2026-10-23", selectedCiks: ["dq", "bh"] }],
      [candidate("dq", { name: "듀케인(그룹 A)" }), candidate("dq", { name: "🇺🇸 듀케인" }), candidate("bh", { name: "버크셔" })],
    );
    expect(rows).toEqual([{ asOfDate: "2026-10-23", names: "듀케인(그룹 A), 버크셔" }]);
  });
});

describe("그룹 배지·순위·가중", () => {
  it("그룹 이름 정리 — 글자만, 대문자, 중복 없이, A·B 먼저", () => {
    expect(groupsOf(["B", "a", "A", 3, null, "C"])).toEqual(["A", "B", "C"]);
    expect(groupsOf("A")).toEqual([]);
    expect(groupsOf(undefined)).toEqual([]);
  });

  it("배지 — A · B · AB(두 그룹 모두), 모르면 null", () => {
    expect(groupBadge(["A"])?.label).toBe("A");
    expect(groupBadge(["B"])?.label).toBe("B");
    const both = groupBadge(["B", "A"]);
    expect(both?.label).toBe("AB");
    expect(both?.title).toContain("두 그룹 모두");
    expect(both?.className).toContain("text-ok");
    expect(groupBadge([])).toBeNull();
    expect(groupBadge(null)).toBeNull();
  });

  it("순위 — 'A 1위 · B 1위', 한 그룹만이면 그 순위, 둘 다 모르면 —", () => {
    expect(groupRankText(1, 1)).toBe("A 1위 · B 1위");
    expect(groupRankText(3, null)).toBe("A 3위");
    expect(groupRankText(null, 2)).toBe("B 2위");
    expect(groupRankText(null, undefined)).toBe("—");
  });

  it("가중·확신도는 0~1 비율을 소수 1자리 %로, 점수는 소수 3자리 — 모르면 —", () => {
    expect(formatRatioPercent(1 / 3)).toBe("33.3%");
    expect(formatRatioPercent(1)).toBe("100.0%");
    expect(formatRatioPercent(0)).toBe("0.0%");
    expect(formatRatioPercent(null)).toBe("—");
    expect(formatScore(0.36667)).toBe("0.367");
    expect(formatScore(0)).toBe("0.000");
    expect(formatScore(undefined)).toBe("—");
  });

  it("신호 풀 줄 — 서버 순서 그대로, CIK 없는 줄은 빼고, 이름·순위·가중을 모르면 CIK·—", () => {
    const rows = signalPoolRows([
      { cik: "0001536411", name: "듀케인", groups: ["A", "B"], rankA: 1, rankB: 1, weight: 0.3667 },
      { cik: "0001656456", name: "아팔루사", groups: ["A"], rankA: 2, rankB: null, weight: 0.1333 },
      { cik: "0001067983", name: null, groups: ["B"], rankA: null, rankB: 4, weight: null },
      { name: "CIK 없음", groups: ["A"] },
      "text",
    ]);
    expect(rows.map(({ key: _key, group, ...row }) => ({ ...row, group: group?.label ?? null }))).toEqual([
      { cik: "0001536411", name: "듀케인", group: "AB", rankA: "1위", rankB: "1위", ranks: "A 1위 · B 1위", weight: "36.7%" },
      { cik: "0001656456", name: "아팔루사", group: "A", rankA: "2위", rankB: "—", ranks: "A 2위", weight: "13.3%" },
      { cik: "0001067983", name: "CIK 0001067983", group: "B", rankA: "—", rankB: "4위", ranks: "B 4위", weight: "—" },
    ]);
    expect(signalPoolRows(undefined)).toEqual([]);
    expect(signalPoolRows({ pool: [] })).toEqual([]);
  });

  it("풀 설명 — 그룹 A 몫을 받으면 숫자로, 아니면 g로", () => {
    expect(poolWeightNote(0.5)).toContain("그룹 A 50.0% · 그룹 B 50.0%");
    expect(poolWeightNote(null)).toContain("그룹 A 몫 g · 그룹 B 몫 1 − g");
    expect(poolWeightNote(0.5)).toContain("두 그룹에 모두 든 기관은 두 몫을 다 받습니다");
  });
});

describe("결정 기록 — 두 그룹을 섞은 뒤 모양", () => {
  const RESPONSE = {
    selection: {
      asOf: "2026-10-23",
      ciks: ["0001536411", "0001656456", "0001067983"],
      groupA: [
        { cik: "0001536411", name: "듀케인", rank: 1 },
        { cik: "0001656456", name: "아팔루사", rank: 2 },
      ],
      groupB: [
        { cik: "0001536411", name: "🇺🇸 듀케인 패밀리 오피스", rank: 1 },
        { cik: "0001067983", name: "🇺🇸 버크셔 해서웨이", rank: 2 },
      ],
      pool: [
        { cik: "0001536411", name: "듀케인", groups: ["A", "B"], rankA: 1, rankB: 1, weight: 0.5333 },
        { cik: "0001656456", name: "아팔루사", groups: ["A"], rankA: 2, rankB: null, weight: 0.1333 },
        { cik: "0001067983", name: "🇺🇸 버크셔 해서웨이", groups: ["B"], rankA: null, rankB: 2, weight: 0.3333 },
      ],
    },
    signals: {
      events: [
        // 섞은 뒤 이벤트에는 순위가 없을 수 있다 — 같은 기록의 신호 풀에서 그룹 순위를 찾는다
        { cik: "0001536411", ticker: "NVDA", action: "NEW", sharesChangePct: null, weightPct: 12.3, previousWeightPct: null },
        { cik: "0001067983", name: "🇺🇸 버크셔 해서웨이", ticker: "NVDA", action: "ADDED", sharesChangePct: 45, weightPct: 2.5, previousWeightPct: 1.5 },
        // 풀에 없는 기관 — 줄이 가진 이름, 그것도 없으면 CIK 그대로
        { cik: "0000000001", name: "모르는 기관", ticker: "XOM", action: "CLOSED", weightPct: 0, previousWeightPct: 1 },
      ],
      candidates: [
        {
          ticker: "NVDA", buyerCiks: ["0001536411", "0001067983"], score: 0.61663, combinedWeightPct: 14.8,
          contributions: [
            { cik: "0001536411", filerWeight: 0.5333, conviction: 1, points: 0.5333 },
            { cik: "0001067983", name: "🇺🇸 버크셔 해서웨이", groups: ["B"], filerWeight: 0.3333, conviction: 0.25, points: 0.08333 },
            { filerWeight: 0.1, conviction: 0.1, points: 0.01 },
          ],
        },
        { ticker: "AAPL", buyerCiks: ["0001656456", "0001536411"], score: null, combinedWeightPct: null, contributions: [] },
      ],
      closedBy: { XOM: ["0000000001", "0001656456"] },
    },
    settings: { allocation: "CONVICTION", minTargetPct: 1, convictionCapPct: 10 },
  };

  it("선정 — 신호 풀 표(그룹·순위·가중)와 그룹별 이름표, 이름은 먼저 본 값", () => {
    const selection = ruleDecisionView(RESPONSE).selection;
    expect(selection?.asOf).toBe("2026-10-23");
    expect(selection?.ranking).toEqual([]);
    expect(selection?.pool.map((row) => [row.name, row.group?.label, row.rankA, row.rankB, row.weight])).toEqual([
      ["듀케인", "AB", "1위", "1위", "53.3%"],
      ["아팔루사", "A", "2위", "—", "13.3%"],
      ["버크셔 해서웨이", "B", "—", "2위", "33.3%"],
    ]);
    expect(selection?.groupANames).toBe("듀케인 · 1위, 아팔루사 · 2위");
    // 두 그룹에 모두 든 듀케인은 그룹 B 목록에서도 같은 이름(먼저 본 신호 풀의 이름)
    expect(selection?.groupBNames).toBe("듀케인 · 1위, 버크셔 해서웨이 · 2위");
    expect(selection?.selectedNames).toBe("듀케인 · A 1위 · B 1위, 아팔루사 · A 2위, 버크셔 해서웨이 · B 2위");
  });

  it("그룹이 비면 '자격 있는 기관 없음', 서버 ciks가 없으면 풀 순서로 신호 기관을 적는다", () => {
    const view = ruleDecisionView({
      selection: { asOf: "2026-10-23", groupA: RESPONSE.selection.groupA, groupB: [], pool: RESPONSE.selection.pool.slice(0, 2) },
    });
    expect(view.selection?.groupBNames).toBe("자격 있는 기관 없음");
    expect(view.selection?.selectedNames).toBe("듀케인 · A 1위 · B 1위, 아팔루사 · A 2위");
  });

  it("신호 이벤트 — 기관 이름표에 그룹 순위, 풀에 없는 기관은 줄의 이름 그대로(순위 없음)", () => {
    expect(ruleDecisionView(RESPONSE).events.map((row) => [row.filer, row.ticker, row.action])).toEqual([
      ["듀케인 · A 1위 · B 1위", "NVDA", "신규 편입"],
      ["버크셔 해서웨이 · B 2위", "NVDA", "확대"],
      ["모르는 기관", "XOM", "전량 매도"],
    ]);
  });

  it("매수 후보 — 점수(소수 3자리), 모르는 점수는 —, 섞은 뒤 기록이라 scored", () => {
    const view = ruleDecisionView(RESPONSE);
    expect(view.scored).toBe(true);
    expect(view.candidates.map(({ ticker, score, rankSum, buyers }) => [ticker, score, rankSum, buyers])).toEqual([
      ["NVDA", "0.617", "—", "듀케인 · A 1위 · B 1위, 버크셔 해서웨이 · B 2위"],
      ["AAPL", "—", "—", "아팔루사 · A 2위, 듀케인 · A 1위 · B 1위"],
    ]);
  });

  it("점수 기여 — 후보 순서·서버 순서 그대로, 그룹은 줄의 값 또는 풀, CIK 없는 줄은 뺀다", () => {
    const view = ruleDecisionView(RESPONSE);
    expect(view.contributions.map(({ key: _key, group, ...row }) => ({ ...row, group: group?.label ?? null }))).toEqual([
      { ticker: "NVDA", filer: "듀케인 · A 1위 · B 1위", group: "AB", filerWeight: "53.3%", conviction: "100.0%", points: "0.533" },
      { ticker: "NVDA", filer: "버크셔 해서웨이 · B 2위", group: "B", filerWeight: "33.3%", conviction: "25.0%", points: "0.083" },
    ]);
    expect(view.convictionNote).toContain("min(그 종목의 기관 내 비중, 10%) ÷ 10%");
  });

  it("배분 방식 — 확신도 비례·동일 비중, 하한·상한은 기록 값, 설정의 묶음·점 이름 모양도 읽는다", () => {
    expect(ruleDecisionView(RESPONSE).allocation)
      .toBe("배분: 확신도 비례(CONVICTION) — 목표 비중 = 종목 상한 × 점수 ÷ 최고 점수(가장 강한 후보가 상한), 목표가 1.0% 미만이면 '확신도 낮음'으로 뺍니다.");
    expect(ruleDecisionView({ ...RESPONSE, settings: { blend: { allocation: "EQUAL" } } }).allocation)
      .toBe("배분: 동일 비중(EQUAL) — 목표 비중 = min(100% ÷ 최대 종목 수, 종목 상한).");
    expect(ruleDecisionView({ ...RESPONSE, settings: { "blend.allocation": "CONVICTION" } }).allocation).toContain("목표가 하한 미만이면");
    expect(ruleDecisionView({ ...RESPONSE, settings: null, allocation: { mode: "EQUAL" } }).allocation).toContain("동일 비중(EQUAL)");
    expect(ruleDecisionView({ ...RESPONSE, settings: { allocation: "TOP_HEAVY" } }).allocation).toBe("배분: TOP_HEAVY");
    expect(ruleDecisionView({ ...RESPONSE, settings: {} }).allocation).toBeNull();
    // 상한을 모르면 숫자 없이
    expect(ruleDecisionView({ ...RESPONSE, settings: {} }).convictionNote).toContain("min(그 종목의 기관 내 비중, 상한) ÷ 상한");
  });

  it("전량 매도 — 풀에 없는 기관은 CIK 그대로(이벤트의 이름을 빌려 오지 않음)", () => {
    expect(ruleDecisionView(RESPONSE).closed).toEqual([
      { ticker: "XOM", filers: "CIK 0000000001, 아팔루사 · A 2위", count: "2곳" },
    ]);
  });

  it("그룹 목록이 순위표(줄마다 selected)면 선정된 줄만 이름표·그룹에 — 순위표에만 있는 기관에 그룹·순위를 붙이지 않는다", () => {
    const rank = (cik: string, name: string, rankNo: number, selected: boolean) =>
      ({ cik, name, rank: rankNo, metric: "CAGR", cagrPct: 10 - rankNo, excessVsSpyPct: null, sharpe: 0.5, selected });
    const view = ruleDecisionView({
      selection: {
        asOf: "2026-11-17",
        ciks: ["a1", "b1"],
        // a1은 그룹 A에서 뽑혔고 그룹 B 순위표에는 3위로만 있음(뽑히지 않음)
        groupA: [rank("a1", "알파", 1, true), rank("a2", "브라보", 2, false)],
        groupB: [rank("b1", "찰리", 1, true), rank("a1", "알파", 3, false)],
        pool: [
          { cik: "a1", name: "알파", groups: ["A"], rankA: 1, rankB: null, weight: 0.5 },
          { cik: "b1", name: "찰리", groups: ["B"], rankA: null, rankB: 1, weight: 0.5 },
        ],
        groupWeightA: 0.5,
        // 대조한 기관 줄 — 전량 매도처럼 CIK만 오는 줄의 이름을 여기서 찾습니다
        filers: [{ cik: "z9", name: "줄루", groups: ["B"], rankA: null, rankB: 4 }],
      },
      signals: {
        events: [],
        candidates: [{ ticker: "MSFT", buyerCiks: ["a1", "b1"], score: 0.4, combinedWeightPct: 3, contributions: [{ cik: "a1", filerWeight: 0.5, conviction: 0.5, points: 0.25 }] }],
        closedBy: { KO: ["z9"] },
      },
    });
    expect(view.selection?.groupANames).toBe("알파 · 1위");
    expect(view.selection?.groupBNames).toBe("찰리 · 1위");
    expect(view.selection?.groupWeightA).toBe(0.5);
    expect(view.contributions.map((row) => [row.filer, row.group?.label])).toEqual([["알파 · A 1위", "A"]]);
    expect(view.closed).toEqual([{ ticker: "KO", filers: "줄루 · B 4위", count: "1곳" }]);
    // 그룹 순위표는 줄의 selected만 — 신호 풀에 있는 알파라도 그룹 B 순위표에서는 "선정"이 아님
    expect(view.selection?.rankingA.map((row) => [row.rank, row.name, row.selected, row.cagr])).toEqual([
      ["1", "알파", true, "+9.00%"], ["2", "브라보", false, "+8.00%"],
    ]);
    expect(view.selection?.rankingB.map((row) => [row.name, row.selected])).toEqual([["찰리", true], ["알파", false]]);
    expect(view.selection?.ranking).toEqual([]);
  });

  it("섞기 전 선정(legacy)으로 낸 결정 — 그룹 B는 '섞기 전' 문구(자격 없음과 구별)", () => {
    const view = ruleDecisionView({
      selection: {
        asOf: "2026-10-23", ciks: ["a1"], legacy: true, groupB: [],
        groupA: [{ cik: "a1", name: "알파", rank: 1, selected: true }],
        pool: [{ cik: "a1", name: "알파", groups: ["A"], rankA: 1, rankB: null, weight: 1 }],
      },
    });
    expect(view.selection?.groupANames).toBe("알파 · 1위");
    expect(view.selection?.groupBNames).toBe("없음 — 두 그룹을 섞기 전의 선정입니다");
    expect(view.selection?.pool.map((row) => row.weight)).toEqual(["100.0%"]);
  });
});

describe("매수 주문 근거 — 점수 기여", () => {
  it("문장(text)이 있으면 그것, 없으면 점수와 기관(그룹)·행동·가중 × 확신도", () => {
    const reason = {
      score: 0.61663,
      contributions: [
        { cik: "0001536411", name: "듀케인", groups: ["B", "A"], filerWeight: 0.5333, conviction: 1, points: 0.5333, action: "NEW", weightPct: 12.3 },
        { cik: "0001067983", groups: ["B"], filerWeight: 0.3333, conviction: 0.25, points: 0.0833, action: "ADDED", weightPct: 2.5 },
      ],
      rankInPlan: 1,
    };
    expect(orderReasonText(reason)).toBe(
      "점수 0.617: 듀케인(AB) 신규 편입 · 가중 53.3% × 확신도 100.0%, CIK 0001067983(B) 확대 · 가중 33.3% × 확신도 25.0%",
    );
    expect(orderReasonText({ ...reason, text: "2곳 동시 매수(점수 0.617)" })).toBe("2곳 동시 매수(점수 0.617)");
    expect(orderReasonText({ contributions: [{ cik: "x", filerWeight: null, conviction: null }] })).toBe("CIK x · 가중 — × 확신도 —");
    // 기여가 없으면 예전처럼 키: 값 요약
    expect(orderReasonText({ score: 0.5, contributions: [] })).toBe("score: 0.5 · contributions: —");
  });
});
