/**
 * 모의 매매 단계 2(규칙 책)의 표기 — 규칙 책 시작·결정 로그·OS 게이트 지표(참고)·선정 기관.
 * 서버가 준 숫자를 고르고 이름만 붙인다(ADR 0004). 모르는 값은 "—", 0으로 채우지 않는다.
 */
import { describe, expect, it } from "vitest";
import {
  candidatesNote,
  decisionBookNote,
  decisionBooks,
  decisionKindLabel,
  decisionMeta,
  decisionOrdersText,
  decisionRunBlocked,
  decisionStatusBadge,
  gateLevelBadge,
  gateView,
  initialDecisionResultView,
  orderReasonText,
  PAPER_TABS,
  prettyJson,
  pricesFinalText,
  rejectReasonText,
  resolveDecisionBook,
  ruleDecisionView,
  rulesStartPrompt,
  runDecisionResultView,
  selectedFilersView,
  signalActionLabel,
} from "../paper";
import type { PaperBookSummary, PaperDecisionDetail, PaperDecisionSummary, PaperGateIndicator } from "../types";

function book(code: string, over: Partial<PaperBookSummary> = {}): PaperBookSummary {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000,
    cash: 12.34, nav: 100123.45, equityValue: 100111.11, exposurePct: 99.99, returnPct: 0.12345,
    lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: null, benchmark: null, ...over,
  };
}

const BOOKS = [
  book("rules", { kind: "RULES", label: "규칙 계좌", status: "NOT_STARTED", startedOn: null }),
  book("claude", { kind: "CLAUDE", label: "Claude 계좌", status: "NOT_STARTED", startedOn: null }),
  book("bench_spy", { label: "SPY 계좌" }),
  book("bench_mix", { label: "60/40 계좌" }),
];

function summary(over: Partial<PaperDecisionSummary> = {}): PaperDecisionSummary {
  return {
    id: 7, book: "rules", asOfTradingDate: "2026-10-23", kind: "INITIAL", status: "OK", decidedAtKst: "2026-10-24 09:12",
    model: null, frameworkVersion: null, settingsVersion: 1, selectionAsOf: "2026-10-23", targetExposurePct: null,
    summary: "매수 3 · SHY 1", orderCount: 4, rejectedCount: 0, pricesFinal: true, error: null, ...over,
  };
}

describe("탭", () => {
  it("결정 로그는 이제 내용이 있다(준비 중 아님)", () => {
    expect(PAPER_TABS.find((tab) => tab.key === "decisions")?.opensIn).toBeNull();
  });
});

describe("규칙 책 시작 카드", () => {
  it("규칙 책이 시작 전이면 카드 — 출발일·사후 체결·게이트 없음을 적고, 확인 문구는 되돌리는 길(책 초기화)을 적는다", () => {
    const prompt = rulesStartPrompt({ initialized: true, startDate: "2026-10-23", books: BOOKS });
    expect(prompt?.bookCode).toBe("rules");
    expect(prompt?.title).toBe("규칙 계좌 시작");
    expect(prompt?.body).toContain("출발일(2026-10-23) 기준");
    expect(prompt?.body).toContain("출발일 종가에 사후 체결");
    expect(prompt?.body).toContain("매크로 게이트는 쓰지 않습니다");
    // 두 그룹을 섞는 규칙(D27) — 그룹 A·B, 점수(기관 가중 × 확신도), 확신도 비례 배분. 예전 설명(상위 5곳 · 동일 비중)은 없다.
    expect(prompt?.body).toContain("그룹 A는 후보 기관의 7년 트랙레코드 상위 5곳");
    expect(prompt?.body).toContain("그룹 B는 기존 '기관 13F 포트폴리오 분석' 메뉴 기관의 최근 2년 상위 4곳");
    expect(prompt?.body).toContain("기관 가중 × 확신도");
    expect(prompt?.body).toContain("확신도 비례");
    expect(prompt?.body).toContain("설정의 기본값");
    expect(prompt?.body).not.toContain("동일 비중");
    expect(prompt?.body).not.toMatch(/상위 5곳을\s*선정/);
    expect(prompt?.confirm).toContain("정말 시작할까요?");
    expect(prompt?.confirm).toContain("'계좌 초기화'");
  });

  it("이미 시작했거나·초기화 전이거나·규칙 책이 없으면 카드 없음", () => {
    const started = BOOKS.map((entry) => (entry.kind === "RULES" ? { ...entry, status: "ACTIVE" as const } : entry));
    expect(rulesStartPrompt({ initialized: true, startDate: "2026-10-23", books: started })).toBeNull();
    const paused = BOOKS.map((entry) => (entry.kind === "RULES" ? { ...entry, status: "PAUSED" as const } : entry));
    expect(rulesStartPrompt({ initialized: true, startDate: "2026-10-23", books: paused })).toBeNull();
    expect(rulesStartPrompt({ initialized: false, startDate: "2026-10-23", books: BOOKS })).toBeNull();
    expect(rulesStartPrompt({ initialized: true, startDate: "2026-10-23", books: BOOKS.slice(1) })).toBeNull();
  });

  it("시작 결과 — 주문·사후 체결 수(목록이든 건수든), 주문이 없으면 경고, ok:false는 서버 문구", () => {
    expect(initialDecisionResultView({ ok: true, decision: summary(), fills: [{} as never, {} as never, {} as never, {} as never] }))
      .toEqual({ tone: "info", text: "규칙 계좌를 시작했습니다 · 2026-10-23 초기 결정 · 주문 4건 · 사후 체결 4건 — 매수 3 · SHY 1" });
    expect(initialDecisionResultView({ ok: true, decision: summary({ summary: null }), fills: 3 }).text)
      .toBe("규칙 계좌를 시작했습니다 · 2026-10-23 초기 결정 · 주문 4건 · 사후 체결 3건");
    // 모르는 수는 "—"(0건으로 채우지 않음)
    expect(initialDecisionResultView({ ok: true, decision: summary({ orderCount: null, summary: null }), fills: null }).text)
      .toBe("규칙 계좌를 시작했습니다 · 2026-10-23 초기 결정 · 주문 — · 사후 체결 —");
    const noTrade = initialDecisionResultView({ ok: true, decision: summary({ status: "NO_TRADE", orderCount: 0, summary: null }), fills: 0 });
    expect(noTrade.tone).toBe("warn");
    expect(noTrade.text).toContain("주문이 없습니다 — 현금만 듭니다");
    expect(initialDecisionResultView({ ok: false, message: "이미 시작한 계좌입니다." }))
      .toEqual({ tone: "warn", text: "이미 시작한 계좌입니다." });
  });
});

describe("결정 목록 표기", () => {
  it("종류·상태 — 모르는 값은 받은 글자 그대로", () => {
    expect(decisionKindLabel("SCHEDULED")).toBe("정기");
    expect(decisionKindLabel("REBALANCE")).toBe("재선정일");
    expect(decisionKindLabel("INITIAL")).toBe("초기 결정");
    expect(decisionKindLabel("MANUAL")).toBe("수동");
    expect(decisionKindLabel("WEEKLY")).toBe("WEEKLY");
    expect(decisionKindLabel(null)).toBe("—");
    expect(decisionStatusBadge("OK").label).toBe("주문 냄");
    expect(decisionStatusBadge("NO_TRADE").label).toBe("주문 없음");
    expect(decisionStatusBadge("FORMAT_ERROR").className).toContain("text-warn");
    expect(decisionStatusBadge("ODD").label).toBe("ODD");
  });

  it("주문 칸 — 거절이 있을 때만 붙이고, 모르면 —", () => {
    expect(decisionOrdersText({ orderCount: 3, rejectedCount: 0 })).toBe("3건");
    expect(decisionOrdersText({ orderCount: 3, rejectedCount: 1 })).toBe("3건 · 거절 1");
    expect(decisionOrdersText({ orderCount: 0, rejectedCount: null })).toBe("0건");
    expect(decisionOrdersText({ orderCount: null, rejectedCount: 2 })).toBe("—");
  });

  it("가격 칸 — 확정 전 값은 경고색, 모르면 —", () => {
    expect(pricesFinalText(true).label).toBe("확정 종가");
    expect(pricesFinalText(false)).toEqual({ label: "확정 전 값", className: "text-warn" });
    expect(pricesFinalText(null).label).toBe("—");
  });

  it("결정을 내는 책은 규칙·Claude뿐, 기본은 규칙 책", () => {
    expect(decisionBooks(BOOKS).map((entry) => entry.code)).toEqual(["rules", "claude"]);
    expect(resolveDecisionBook("", BOOKS)).toBe("rules");
    expect(resolveDecisionBook("claude", BOOKS)).toBe("claude");
    expect(resolveDecisionBook("bench_spy", BOOKS)).toBe("rules");
    expect(resolveDecisionBook("", BOOKS.slice(1))).toBe("claude");
    expect(resolveDecisionBook("", BOOKS.slice(2))).toBeNull();
  });

  it("책 안내 — Claude 책은 검증·노출·실패·상한·비용, 규칙 책은 매수일·게이트 없음·수동 결정", () => {
    const claude = decisionBookNote("CLAUDE");
    expect(claude).not.toContain("다음 단계");
    expect(claude).toContain("검증기(하드 규칙)가 주문마다 통과·거절");
    expect(claude).toContain("현금 비중은 Claude가 정하고 검사하지 않습니다");
    expect(claude).toContain("API 오류는 같은 거래일에 한 번 다시 시도");
    expect(claude).toContain("apiDailyCallCap");
    expect(claude).toContain("Sonnet 5.5 호출 1회, 약 $0.1");
    expect(decisionBookNote("RULES")).toContain("매수는 재선정일");
    expect(decisionBookNote("RULES")).toContain("그 재선정일 기준 선정으로 한 번 따라잡습니다");
    expect(decisionBookNote("RULES")).toContain("매크로 게이트는 쓰지 않고");
    expect(decisionBookNote("RULES")).toContain("'지금 결정 실행'");
  });

  it("수동 결정 버튼 — 시작 전인 책·일시정지 중인 Claude 책은 막고 그 길을, 운용 중인 책·일시정지 규칙 책은 null", () => {
    expect(decisionRunBlocked(BOOKS[0])).toContain("'규칙 계좌 시작'");
    expect(decisionRunBlocked(BOOKS[1])).toContain("'Claude 계좌 시작'");
    expect(decisionRunBlocked(BOOKS[1])).not.toContain("다음 단계");
    expect(decisionRunBlocked({ kind: "CLAUDE", status: "ACTIVE" })).toBeNull();
    expect(decisionRunBlocked({ kind: "RULES", status: "ACTIVE" })).toBeNull();
    expect(decisionRunBlocked({ kind: "RULES", status: "PAUSED" })).toBeNull();
    // 일시정지 중인 Claude 책 — 서버가 Claude를 부르지 않고 400을 내므로 버튼에서 먼저 막고 재개하는 길을
    expect(decisionRunBlocked({ kind: "CLAUDE", status: "PAUSED" })).toContain("일시정지 중인 Claude 계좌");
    expect(decisionRunBlocked({ kind: "CLAUDE", status: "PAUSED" })).toContain("재개한 뒤");
    expect(decisionRunBlocked(null)).toBe("계좌가 없습니다.");
  });

  it("수동 결정 결과 — 요약 한 줄, 결정 오류·ok:false는 경고", () => {
    expect(runDecisionResultView({ ok: true, decision: summary({ kind: "MANUAL", status: "NO_TRADE", orderCount: 0, summary: "매도 신호 없음" }) }))
      .toEqual({ tone: "info", text: "2026-10-23 수동 결정 — 주문 없음 · 주문 0건 · 매도 신호 없음" });
    const failed = runDecisionResultView({ ok: true, decision: summary({ kind: "MANUAL", error: "선정 없음", summary: null }) });
    expect(failed.tone).toBe("warn");
    expect(failed.text).toBe("2026-10-23 수동 결정 — 주문 냄 · 주문 4건 — 오류: 선정 없음");
    expect(runDecisionResultView({ ok: false, message: "모의 매매 테이블이 아직 없습니다." }))
      .toEqual({ tone: "warn", text: "모의 매매 테이블이 아직 없습니다." });
    expect(runDecisionResultView({ ok: true }).tone).toBe("warn");
    // 결정 기록 없이 서버 문구만 오면(다른 결정이 돌고 있음 등) 그 문구를 경고로 — 기본 문구로 덮지 않습니다.
    expect(runDecisionResultView({ ok: true, decision: null, message: "다른 결정을 실행하고 있습니다 — 끝난 뒤 다시 누르세요." }))
      .toEqual({ tone: "warn", text: "다른 결정을 실행하고 있습니다 — 끝난 뒤 다시 누르세요." });
  });

  it("후보 안내 — 매수하는 결정(재선정일·초기)과 아닌 결정을 구별", () => {
    expect(candidatesNote("REBALANCE")).toContain("매수하는 결정");
    expect(candidatesNote("INITIAL")).toContain("매수하는 결정");
    expect(candidatesNote("SCHEDULED")).toContain("매수하지 않는 날");
    expect(candidatesNote("MANUAL")).toContain("매수하지 않는 날");
  });
});

describe("결정 상세 머리", () => {
  const detail = (over: Partial<PaperDecisionDetail> = {}): PaperDecisionDetail => ({
    ...summary(), packet: null, packetHash: null, response: {}, usage: null, noteIds: null, latencyMs: null, retryCount: null, ...over,
  });

  it("규칙 책 기록은 다섯 칸 — 소요는 규칙 책도 늘 채우고, Claude 책만 채우는 값은 없으면 칸을 만들지 않는다", () => {
    // 규칙 책 결정은 latency_ms를 늘 쓰고 retry_count는 0입니다(RuleBookService).
    expect(decisionMeta(detail({ latencyMs: 35, retryCount: 0 })).map((cell) => [cell.label, cell.value])).toEqual([
      ["결정 시각", "2026-10-24 09:12"],
      ["선정 기준일", "2026-10-23"],
      ["설정 버전", "v1"],
      ["가격", "확정 종가"],
      ["소요", "0.0초"],
    ]);
    expect(decisionMeta(detail()).map((cell) => cell.label)).toEqual(["결정 시각", "선정 기준일", "설정 버전", "가격"]);
    expect(decisionMeta(detail({ settingsVersion: null, selectionAsOf: null, pricesFinal: false })).map((cell) => cell.value))
      .toEqual(["2026-10-24 09:12", "—", "—", "확정 전 값"]);
  });

  it("Claude 책 값이 있으면 덧붙인다", () => {
    const cells = decisionMeta(detail({
      model: "claude-sonnet-5-5", frameworkVersion: 2, targetExposurePct: 62.5, latencyMs: 41_200, retryCount: 1,
      packetHash: "0123456789abcdef0123", noteIds: [3, 9],
    }));
    expect(cells.slice(4).map((cell) => [cell.label, cell.value])).toEqual([
      ["모델", "claude-sonnet-5-5"],
      ["프레임 버전", "v2"],
      ["목표 주식 노출", "62.5%"],
      ["소요", "41.2초"],
      ["재시도", "1회"],
      ["패킷 해시", "0123456789ab…"],
      ["참조 메모", "#3, #9"],
    ]);
  });
});

describe("주문 근거 한 줄", () => {
  it("서버가 남긴 문장(text)을 자르지 않고 그대로 — 키 순서로 이어 붙이면 둘째 기관부터 잘림", () => {
    const text = "3곳 동시 매수(순위 합 6): 1위 버크셔 해서웨이(0001067983) 신규, 2위 퍼싱 스퀘어(0001336528) +35.0%, 3위 CIK(0000000003) 신규";
    expect(orderReasonText({ rule: "R2·R4", signal: "BUY", kind: "REBALANCE", text, buyers: [{ cik: "0001067983" }] }, 40))
      .toBe(text);
  });

  it("SHY 주문처럼 text가 뒤쪽 키여도 문장을 보이고, text가 없으면 키: 값 요약", () => {
    expect(orderReasonText({
      rule: "R3", signal: "PARKING", kind: "REBALANCE", parking: true, spareCashPct: 45.9875, bufferPct: 0.5, currentWeightPct: 24,
      selectionAsOf: "2026-08-17", text: "남는 현금 45.99% 중 45.49%를 SHY에(여유 0.5%p)", targetWeightPct: 69.4875,
    })).toBe("남는 현금 45.99% 중 45.49%를 SHY에(여유 0.5%p)");
    expect(orderReasonText({ cashLimited: true, note: "현금 부족" })).toBe("cashLimited: true · note: 현금 부족");
    expect(orderReasonText(null)).toBe("—");
  });
});

describe("규칙 책 결정 기록", () => {
  const RESPONSE = {
    gate: { tradingDate: "2026-10-23", level: "L0", conditions: { G1: false }, streaks: { G1: 0 } },
    selection: {
      asOf: "2026-10-23",
      ciks: ["0001067983", "0001336528"],
      ranking: [
        { cik: "0001067983", name: "버크셔 해서웨이", rank: 1, metric: "CAGR", cagrPct: 14.21, excessVsSpyPct: 3.5, sharpe: 0.83, selected: true },
        { cik: "0001336528", name: "퍼싱 스퀘어", rank: 2, metric: "CAGR", cagrPct: 12.1, excessVsSpyPct: -1.25, sharpe: null, selected: true },
        { cik: "0000102909", name: "제외 기관", rank: 6, metric: "CAGR", cagrPct: null, excessVsSpyPct: null, sharpe: 0.5, selected: false },
      ],
    },
    signals: {
      events: [
        { cik: "0001067983", rank: 1, ticker: "AAPL", action: "ADDED", sharesChangePct: 31.5, weightPct: 4.2, previousWeightPct: 3.1 },
        { cik: "0001336528", rank: 2, ticker: "AAPL", action: "NEW", sharesChangePct: null, weightPct: 2.05, previousWeightPct: null },
        // 순위표에 없는 기관 — CIK 그대로(이름을 지어내지 않음)
        { cik: "0009999999", rank: null, ticker: "XOM", action: "CLOSED", sharesChangePct: null, weightPct: 0, previousWeightPct: 1.5 },
        { cik: "0001067983", ticker: null, action: "NEW" },
      ],
      candidates: [{ ticker: "AAPL", buyerCiks: ["0001067983", "0001336528"], rankSum: 3, combinedWeightPct: 6.25, events: [] }],
      closedBy: { XOM: ["0009999999", "0001067983"] },
    },
    orders: [{ ticker: "AAPL", side: "BUY", targetWeightPct: 10 }],
    skipped: [{ GOOGL: "유니버스 밖" }, { ticker: "TSLA", reason: "재진입 금지" }, { key: "META", value: "상위 N 밖" }],
    notes: ["버크셔 해서웨이: 직전 분기 공시 없음", ""],
  };

  it("선정 순위표 — 서버 순서 그대로, 선정 표시, 모르는 숫자는 —", () => {
    const view = ruleDecisionView(RESPONSE);
    expect(view.recognized).toBe(true);
    expect(view.selection?.asOf).toBe("2026-10-23");
    expect(view.selection?.selectedNames).toBe("버크셔 해서웨이 · 1위, 퍼싱 스퀘어 · 2위");
    expect(view.selection?.ranking).toEqual([
      { cik: "0001067983", name: "버크셔 해서웨이", rank: "1", cagr: "+14.21%", excess: "+3.50%p", sharpe: "0.83", selected: true },
      { cik: "0001336528", name: "퍼싱 스퀘어", rank: "2", cagr: "+12.10%", excess: "-1.25%p", sharpe: "—", selected: true },
      { cik: "0000102909", name: "제외 기관", rank: "6", cagr: "—", excess: "—", sharpe: "0.50", selected: false },
    ]);
  });

  it("신호 이벤트 — 기관 이름·순위를 붙이고, 티커 없는 줄은 뺀다", () => {
    const view = ruleDecisionView(RESPONSE);
    expect(view.events.map(({ key: _key, ...row }) => row)).toEqual([
      { filer: "버크셔 해서웨이 · 1위", ticker: "AAPL", action: "확대", actionKey: "ADDED", sharesChange: "+31.50%", weight: "4.20%", previousWeight: "3.10%" },
      { filer: "퍼싱 스퀘어 · 2위", ticker: "AAPL", action: "신규 편입", actionKey: "NEW", sharesChange: "—", weight: "2.05%", previousWeight: "—" },
      { filer: "CIK 0009999999", ticker: "XOM", action: "전량 매도", actionKey: "CLOSED", sharesChange: "—", weight: "0.00%", previousWeight: "1.50%" },
    ]);
  });

  it("매수 후보·매도 신호 — 서버 정렬 그대로, 기관 이름표", () => {
    const view = ruleDecisionView(RESPONSE);
    expect(view.candidates).toEqual([
      // 섞기 전 기록 — 점수가 없어 "—"(0으로 채우지 않음)이고, 화면은 순위 합 칸을 그립니다.
      { ticker: "AAPL", buyers: "버크셔 해서웨이 · 1위, 퍼싱 스퀘어 · 2위", buyerCount: "2곳", score: "—", rankSum: "3", combinedWeight: "6.25%" },
    ]);
    expect(view.scored).toBe(false);
    expect(view.contributions).toEqual([]);
    expect(view.convictionNote).toBeNull();
    // 배분 방식이 기록에 없으면 줄을 만들지 않습니다(섞기 전 기록은 동일 비중이었지만 화면이 채우지 않음).
    expect(view.allocation).toBeNull();
    expect(view.selection?.pool).toEqual([]);
    expect(view.selection?.groupANames).toBeNull();
    expect(view.closed).toEqual([{ ticker: "XOM", filers: "CIK 0009999999, 버크셔 해서웨이 · 1위", count: "2곳" }]);
  });

  it("건너뛴 후보 — {ticker, reason}·Map.Entry({티커: 사유})·{key, value} 모양을 모두 읽는다, 빈 메모는 뺀다", () => {
    const view = ruleDecisionView(RESPONSE);
    expect(view.skipped.map(({ ticker, reason }) => [ticker, reason])).toEqual([
      ["GOOGL", "유니버스 밖"], ["TSLA", "재진입 금지"], ["META", "상위 N 밖"],
    ]);
    expect(view.notes).toEqual(["버크셔 해서웨이: 직전 분기 공시 없음"]);
    expect(view.gate?.level).toBe("L0");
  });

  it("규칙 책 모양이 아니면(Claude 책 응답·빈 값) recognized:false — 표 대신 원본 JSON만", () => {
    for (const response of [null, undefined, "text", [], { stance: "neutral", orders: [] }]) {
      const view = ruleDecisionView(response);
      expect(view.recognized).toBe(false);
      expect(view.events).toEqual([]);
      expect(view.selection).toBeNull();
    }
  });

  it("선정이 비면 '선정 없음' 문구", () => {
    expect(ruleDecisionView({ selection: { asOf: "2026-11-17", ciks: [], ranking: [] } }).selection?.selectedNames)
      .toBe("선정 없음 — 자격 있는 기관이 없었습니다");
  });

  it("원본 JSON은 들여 쓰고, 없으면 null", () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(prettyJson(null)).toBeNull();
    expect(prettyJson(undefined)).toBeNull();
  });

  it("행동 이름", () => {
    expect(signalActionLabel("NEW")).toBe("신규 편입");
    expect(signalActionLabel("ADDED")).toBe("확대");
    expect(signalActionLabel("CLOSED")).toBe("전량 매도");
    expect(signalActionLabel("TRIMMED")).toBe("TRIMMED");
  });
});

describe("OS 게이트 지표(참고)", () => {
  const GATE: PaperGateIndicator = {
    tradingDate: "2026-10-23",
    level: "L1",
    conditions: { G1: true, G2: false, G3: true, G4: true, G5: false },
    streaks: { G1: 4, G2: 0, G3: 12, G4: 9, G5: 0 },
    inputs: {
      us10y: { value: 4.62, source: "macro.collected", lastTs: "2026-10-24 05:59:00 KST", isStale: false },
      brent: { value: 88.4, source: "macro.collected", lastTs: "2026-10-24 05:58", isStale: true },
      wti: 84.1,
      usdjpy: null,
    },
    missing: [],
    note: "과거 OS가 쓴 트리거 수준 — 구속하지 않음",
  };

  it("단계 배지 — 입력이 빠진 날은 '판정 없음'(L0로 보지 않음), 모르는 단계는 글자 그대로", () => {
    expect(gateLevelBadge("L0").label).toBe("L0 · 동결");
    expect(gateLevelBadge("L1").label).toBe("L1 · 1단계 해제");
    expect(gateLevelBadge("L2").label).toBe("L2 · 전면 해제");
    expect(gateLevelBadge("UNKNOWN").label).toBe("판정 없음 · 입력 빠짐");
    expect(gateLevelBadge("L3").label).toBe("L3");
  });

  it("조건 표 — 서버 값 그대로, 임계치를 모르면 기준 이름만, G5는 참고 조건", () => {
    const view = gateView(GATE);
    expect(view?.tradingDate).toBe("2026-10-23");
    expect(view?.levelNote).toContain("10년물 1단계 조건(G1)");
    expect(view?.conditions.map((row) => [row.label, row.state, row.streak])).toEqual([
      ["G1 10년물 < 1단계 기준", "충족", "4거래일 연속"],
      ["G2 10년물 ≤ 전면 기준", "미충족", "0거래일 연속"],
      ["G3 브렌트 ≤ 상한", "충족", "12거래일 연속"],
      ["G4 WTI ≤ 상한", "충족", "9거래일 연속"],
      ["G5 USD/JPY ≥ 기준 (참고 — 단계에 쓰지 않음)", "미충족", "0거래일 연속"],
    ]);
    expect(view?.conditions[4].reference).toBe(true);
    expect(view?.note).toBe("과거 OS가 쓴 트리거 수준 — 구속하지 않음");
  });

  it("임계치를 받으면 숫자로 — 10년물은 2자리, 정수 임계치는 소수 없이", () => {
    const view = gateView({
      ...GATE,
      thresholds: { us10yStage1: 4.8, us10yFull: 4.75, brentMax: 95, wtiMax: 90, usdjpyMin: 155, confirmDays: 3 },
    });
    expect(view?.conditions.map((row) => row.label)).toEqual([
      "G1 10년물 < 4.80%",
      "G2 10년물 ≤ 4.75%",
      "G3 브렌트 ≤ 95 달러",
      "G4 WTI ≤ 90 달러",
      "G5 USD/JPY ≥ 155 엔 (참고 — 단계에 쓰지 않음)",
    ]);
    expect(view?.levelNote).toContain("확인 일수(3거래일)");
  });

  it("입력 표 — 값·시세 시각·지난 값, 숫자만 온 입력도 읽고, 없는 입력은 —(0으로 채우지 않음)", () => {
    const view = gateView(GATE);
    expect(view?.inputs).toEqual([
      { key: "us10y", label: "미국 10년물 금리", value: "4.62%", lastTs: "2026-10-24 05:59", stale: false },
      { key: "brent", label: "브렌트유", value: "88.40 달러", lastTs: "2026-10-24 05:58", stale: true },
      { key: "wti", label: "WTI", value: "84.10 달러", lastTs: "—", stale: false },
      { key: "usdjpy", label: "USD/JPY", value: "—", lastTs: "—", stale: false },
    ]);
  });

  it("입력이 빠진 날 — 조건·연속은 —, 없는 입력 이름을 적는다", () => {
    const view = gateView({
      tradingDate: "2026-10-23", level: "UNKNOWN",
      conditions: { G1: true, G2: true, G3: null, G4: true, G5: true }, streaks: { G1: 1, G2: 1, G3: null, G4: 1, G5: 1 },
      inputs: { us10y: { value: 4.5 }, brent: { value: null }, wti: { value: 70 }, usdjpy: { value: 150 } },
      missing: ["brent"],
    });
    expect(view?.level.label).toBe("판정 없음 · 입력 빠짐");
    expect(view?.levelNote).toContain("없는 입력: 브렌트유");
    expect(view?.conditions[2]).toMatchObject({ state: "—", streak: "—" });
    // 서버 문구가 없으면 기본 문구
    expect(view?.note).toBe("과거 OS가 쓴 트리거 수준 — 구속하지 않음");
  });

  it("기록이 없으면 null", () => {
    expect(gateView(null)).toBeNull();
    expect(gateView(undefined)).toBeNull();
  });

  it("모양이 다른 기록(결정 기록의 JSON)도 깨지지 않는다 — 객체가 아닌 조건·입력은 —, 서버 문구 끝 마침표는 뗀다", () => {
    const view = gateView({
      level: "L2", conditions: "x" as never, streaks: null, inputs: [] as never, missing: "brent" as never, note: "구속하지 않음.",
    });
    expect(view?.conditions.every((row) => row.state === "—" && row.streak === "—")).toBe(true);
    expect(view?.inputs.every((row) => row.value === "—")).toBe(true);
    expect(view?.note).toBe("구속하지 않음");
    expect(view?.tradingDate).toBe("—");
    expect(view?.level.label).toBe("L2 · 전면 해제");
  });
});

describe("개요의 선정 기관", () => {
  it("두 그룹은 그룹 안 순위 순(서버 순서), 풀은 풀 순서 — 풀의 순위는 같은 응답의 그룹 목록에서 찾고, 모르면 CIK·—", () => {
    const view = selectedFilersView({
      asOfDate: "2026-10-23",
      groupA: [
        { cik: "0001536411", name: "듀케인", rank: 1 },
        { cik: "0009999999", name: null, rank: null },
      ],
      groupB: [
        { cik: "0001536411", name: "듀케인", rank: 1 },
        { cik: "0001067983", name: "버크셔 해서웨이", rank: 2 },
      ],
      pool: [
        { cik: "0001536411", name: "듀케인", groups: ["A", "B"], weight: 0.5 },
        { cik: "0009999999", name: null, groups: ["A"], weight: 0.25 },
        { cik: "0001067983", name: "버크셔 해서웨이", groups: ["B"], weight: null },
      ],
    });
    expect(view?.asOfDate).toBe("2026-10-23");
    expect(view?.groupA).toEqual([
      { key: "0-0001536411", rank: "1위", name: "듀케인", cik: "0001536411" },
      { key: "1-0009999999", rank: "—", name: "CIK 0009999999", cik: "0009999999" },
    ]);
    expect(view?.groupB.map((row) => [row.rank, row.name])).toEqual([["1위", "듀케인"], ["2위", "버크셔 해서웨이"]]);
    expect(view?.pool.map(({ name, group, ranks, weight }) => [name, group?.label, ranks, weight])).toEqual([
      ["듀케인", "AB", "A 1위 · B 1위", "50.0%"],
      // 그룹 A 목록에 순위가 없는 기관 — 순위를 지어내지 않음
      ["CIK 0009999999", "A", "—", "25.0%"],
      // 가중을 모르면 —(0%로 채우지 않음)
      ["버크셔 해서웨이", "B", "B 2위", "—"],
    ]);
    expect(selectedFilersView(null)).toBeNull();
  });

  it("그룹 섞기 전 모양(selected만)은 그룹 A로 읽고 풀·그룹 B는 비운다", () => {
    const view = selectedFilersView({ asOfDate: "2026-10-23", selected: [{ cik: "0001067983", name: "버크셔 해서웨이", rank: 1 }] });
    expect(view?.groupA.map((row) => row.name)).toEqual(["버크셔 해서웨이"]);
    expect(view?.groupB).toEqual([]);
    expect(view?.pool).toEqual([]);
    expect(selectedFilersView({ asOfDate: "2026-10-23", groupA: [], groupB: [], pool: [] })?.groupA).toEqual([]);
  });
});

describe("거절 사유 이름표 — 한국 검증기 코드 둘(F2), 미국 코드는 그대로", () => {
  it("UNFILLABLE·BUY_BELOW_ONE_SHARE는 이름표와 설명, 미국 코드·모르는 코드·없음은 예전 그대로", () => {
    expect(rejectReasonText("UNFILLABLE").label).toBe("지금 체결할 수 없는 종목 매수 (UNFILLABLE)");
    expect(rejectReasonText("UNFILLABLE").title).toContain("기업행위 보류");
    expect(rejectReasonText("BUY_BELOW_ONE_SHARE").label).toBe("증가분 1주 미만 (BUY_BELOW_ONE_SHARE)");
    expect(rejectReasonText("BELOW_ONE_SHARE").label).toBe("1주 미만 부분 매도 (BELOW_ONE_SHARE)");
    expect(rejectReasonText("MIN_NOTIONAL").label).toBe("최소 금액 미만 (MIN_NOTIONAL)");
    expect(rejectReasonText("NEW_CODE")).toEqual({ label: "NEW_CODE" });
    expect(rejectReasonText(null)).toEqual({ label: "—" });
  });
});
