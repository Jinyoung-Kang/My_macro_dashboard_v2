import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { endpoints } from "../endpoints";

/** 서버가 받는 것: 경로 + (이름, 디코딩한 값) 목록(순서 포함). 인코딩 표기 차이는 무시합니다. */
function received(url: string) {
  const parsed = new URL(url, "http://backend");
  return { path: decodeURIComponent(parsed.pathname), params: [...parsed.searchParams.entries()] };
}

/**
 * 예전 화면 코드의 주소 조립식(before)을 그대로 옮겨 적고, 새 함수(after)와 같은 값으로 부릅니다.
 * 값은 화면이 실제로 쓰는 모양입니다. 서버가 받는 경로·파라미터가 같아야 합니다.
 */
type Case = { name: string; before: string; after: string };
const s = (value: string): string => value;   // 조건식이 상수로 접히지 않게

const CASES: Case[] = [
  ...[true, false].map((live) => ({
    name: `macro.overview live=${live}`,
    before: `/api/macro/overview${live ? "?live=true" : ""}`,
    after: endpoints.macro.overview(live),
  })),
  ...[["usdkrw", "dxy"], []].map((selected) => ({
    name: `macro.fx ${selected.length}개`,
    before: `/api/macro/fx?ids=${selected.join(",")}&period=${"5y"}&mode=${"index"}`,
    after: endpoints.macro.fx(selected, "5y", "index"),
  })),
  { name: "macro.fred", before: `/api/macro/fred/${"T10Y2Y"}?years=10`, after: endpoints.macro.fred("T10Y2Y", 10) },
  { name: "macro.ticker", before: `/api/macro/ticker?symbol=${encodeURIComponent("^VIX")}&period=${"6mo"}`,
    after: endpoints.macro.ticker("^VIX", "6mo") },
  { name: "liquidity", before: `/api/liquidity?years=${"5"}`, after: endpoints.macro.liquidity("5") },
  { name: "sector", before: `/api/sector/rotation?period=${"1M"}`, after: endpoints.macro.sectorRotation("1M") },
  { name: "13f.portfolio", before: `/api/sec13f/portfolio?cik=${"0001067983"}&quarters=${"8"}&topN=${"15"}`,
    after: endpoints.institution.portfolio("0001067983", "8", "15") },
  ...[[s("0001067983,0001336528"), s("2026-06-30")], [s(""), s("")]].map(([ciks, reportDate]) => ({
    name: `13f.consensus ciks=${ciks || "없음"}`,
    before: `/api/sec13f/consensus?minHolders=${"3"}&topN=40${
      ciks ? `&ciks=${ciks}` : ""
    }${reportDate ? `&reportDate=${reportDate}` : ""}`,
    after: endpoints.institution.consensus({ minHolders: "3", topN: 40, ciks, reportDate }),
  })),
  ...[s("2026-06-30"), s("")].map((reportDate) => ({
    name: `13f.newBuys reportDate=${reportDate || "없음"}`,
    before: `/api/sec13f/new-buys?minHolders=${"2"}` +
      (reportDate ? `&reportDate=${encodeURIComponent(reportDate)}` : ""),
    after: endpoints.institution.newBuys("2", reportDate),
  })),
  { name: "guru.holders", before: `/api/guru/holders?q=${encodeURIComponent("APPLE INC")}`,
    after: endpoints.institution.guruHolders("APPLE INC") },
  { name: "guru.risk", before: `/api/guru/risk?cik=${"0001067983"}&benchmark=${"SPY"}&years=${"1"}`,
    after: endpoints.institution.guruRisk("0001067983", "SPY", "1") },
  { name: "scorecard", before: `/api/stock/scorecard?symbol=${"AAPL"}&benchmark=${"SPY"}&years=${"1"}`,
    after: endpoints.insight.scorecard("AAPL", "SPY", "1") },
  { name: "correlation",
    before: `/api/analytics/correlation?x=${encodeURIComponent("liquidity:net")}&y=${encodeURIComponent("etf:QQQ")}` +
      `&window=${"60"}&years=${"5"}&mode=${"change"}`,
    after: endpoints.insight.correlation({ x: "liquidity:net", y: "etf:QQQ", window: "60", years: "5", mode: "change" }) },
  { name: "regime", before: `/api/analytics/regime?years=${"5"}`, after: endpoints.insight.regime("5") },
  { name: "alerts.rule", before: `/api/alerts/rules/${3}`, after: endpoints.alerts.rule(3) },
  { name: "alerts.inbox", before: `/api/alerts/inbox?limit=${50}`, after: endpoints.alerts.inbox(50) },
  { name: "admin.user", before: `/api/admin/users/${7}`, after: endpoints.admin.user(7) },
  { name: "admin.audit", before: `/api/admin/audit?limit=${100}`, after: endpoints.admin.audit(100) },
  { name: "regimeLog", before: `/api/analytics/regime/log?limit=${"90"}`, after: endpoints.insight.regimeLog(90) },
  { name: "regimeTrackRecord", before: `/api/analytics/regime/track-record?asset=${encodeURIComponent("069500.KS")}`,
    after: endpoints.insight.regimeTrackRecord("069500.KS") },
  { name: "cot.asset", before: `/api/cot/asset?name=${encodeURIComponent("S&P 500 E-Mini")}`,
    after: endpoints.positioning.cotAsset("S&P 500 E-Mini") },
  { name: "cot.extremes",
    before: `/api/cot/extremes?name=${encodeURIComponent("S&P 500 E-Mini")}` + `&percentile=${"90"}&lookbackWeeks=${"156"}`,
    after: endpoints.positioning.cotExtremes("S&P 500 E-Mini", "90", "156") },
  { name: "krx.futures", before: "/api/krx/futures?days=60", after: endpoints.positioning.krxFutures(60) },
  { name: "krx.intraday", before: "/api/krx/intraday?minutes=30", after: endpoints.positioning.krxIntraday(30) },
  { name: "radar.ranking",
    before: `/api/radar/ranking?market=${"KOSPI"}&investor=${encodeURIComponent("외국인")}` +
      `&tradeType=${encodeURIComponent("순매수")}&intervalType=${"DAY"}&topN=${"30"}`,
    after: endpoints.positioning.radarRanking({ market: "KOSPI", investor: "외국인", tradeType: "순매수", intervalType: "DAY", topN: "30" }) },
  { name: "radar.consensus",
    before: `/api/radar/consensus?market=${"KOSDAQ"}&tradeType=${encodeURIComponent("순매도")}` +
      `&intervalType=${"DAY"}&topN=${"30"}`,
    after: endpoints.positioning.radarConsensus({ market: "KOSDAQ", tradeType: "순매도", intervalType: "DAY", topN: "30" }) },
  ...[s("2026-09-25"), s("")].map((date) => ({
    name: `radar.history obsDate=${date || "없음"}`,
    before: `/api/radar/history?market=${encodeURIComponent("KOSPI")}&investor=${encodeURIComponent(
      "외국인",
    )}&tradeType=${encodeURIComponent("순매수")}&latest=true${date ? `&obsDate=${date}` : ""}`,
    after: endpoints.positioning.radarHistory({ market: "KOSPI", investor: "외국인", tradeType: "순매수", obsDate: date }),
  })),
  { name: "kr.stockFlows", before: `/api/kr/stock-flows?codes=${"005930,000660"}`,
    after: endpoints.positioning.stockFlows("005930,000660") },
  { name: "kr.fundamentals", before: `/api/kr/fundamentals?codes=${"005930,000660"}`,
    after: endpoints.publicData.fundamentals("005930,000660") },
  { name: "kr.marketTotals", before: "/api/kr/market-totals?days=180", after: endpoints.publicData.marketTotals(180) },
  { name: "publicApis", before: `/api/status/public-apis?run=${3}`, after: endpoints.publicData.apiStatus(3) },
  { name: "status.refresh", before: "/api/status/refresh?runFast=true", after: endpoints.status.refresh(true) },
  { name: "status.run", before: `/api/status/run/${"macro_collected"}`, after: endpoints.status.runTask("macro_collected") },
  { name: "status.history", before: `/api/status/history?task=${encodeURIComponent("macro_collected")}&limit=1`,
    after: endpoints.status.history("macro_collected", 1) },
  { name: "ai.test", before: `/api/ai/test?engineId=${"auto"}&prompt=${encodeURIComponent("연결 확인 & 한 문장")}`,
    after: endpoints.ai.test("auto", "연결 확인 & 한 문장") },
  { name: "toss.diagnostics", before: `/api/ai/toss/diagnostics?run=${2}`, after: endpoints.toss.diagnostics(2) },
  { name: "toss.exchangeRate", before: "/api/ai/toss/exchange-rate?base=USD&quote=KRW",
    after: endpoints.toss.exchangeRate("USD", "KRW") },
  { name: "toss.indices", before: "/api/ai/toss/indices?symbols=KOSPI,KOSDAQ", after: endpoints.toss.indices("KOSPI,KOSDAQ") },
  { name: "paper.positions", before: "/api/paper/books/rules/positions", after: endpoints.paper.positions("rules") },
  { name: "paper.orders", before: "/api/paper/books/claude/orders?limit=50", after: endpoints.paper.orders("claude", 50) },
  { name: "paper.fills", before: "/api/paper/books/bench_spy/fills?limit=50", after: endpoints.paper.fills("bench_spy", 50) },
  { name: "paper.nav", before: "/api/paper/books/bench_mix/nav", after: endpoints.paper.nav("bench_mix") },
  { name: "paper.bookStatus", before: "/api/paper/books/rules/status", after: endpoints.paper.bookStatus("rules") },
  { name: "paper.bookReset", before: "/api/paper/books/claude/reset", after: endpoints.paper.bookReset("claude") },
  ...[s("2026-10-23"), s("")].map((asOf) => ({
    name: `paper.trackRecord asOf=${asOf || "없음"}`,
    before: `/api/paper/track-record${asOf ? `?asOf=${asOf}` : ""}`,
    after: endpoints.paper.trackRecord(asOf),
  })),
  { name: "paper.decisions", before: "/api/paper/decisions?book=rules&limit=50", after: endpoints.paper.decisions("rules", 50) },
  { name: "paper.decision", before: `/api/paper/decisions/${12}`, after: endpoints.paper.decision(12) },
  { name: "paper.frameworkVersion", before: `/api/paper/framework/versions/${0}`, after: endpoints.paper.frameworkVersion(0) },
  { name: "paper.approveProposal", before: `/api/paper/framework/proposals/${5}/approve`, after: endpoints.paper.approveProposal(5) },
  { name: "paper.rejectProposal", before: `/api/paper/framework/proposals/${5}/reject`, after: endpoints.paper.rejectProposal(5) },
  ...[true, false].map((includeExpired) => ({
    name: `paper.notes includeExpired=${includeExpired}`,
    before: `/api/paper/notes?includeExpired=${includeExpired}`,
    after: endpoints.paper.notes(includeExpired),
  })),
  { name: "paper.archiveNote", before: `/api/paper/notes/${9}`, after: endpoints.paper.archiveNote(9) },
  { name: "paper.review", before: `/api/paper/reviews/${"2026-10-30"}`, after: endpoints.paper.review("2026-10-30") },
  // 시장 단위 경로(2단계 명세 §4-16): 미국은 옛 주소 그대로(?market 없음), 한국은 ?market=KR(메모 목록은 includeExpired 뒤).
  { name: "paper.market(US).overview", before: "/api/paper/overview", after: endpoints.paper.market("US").overview },
  { name: "paper.market(KR).overview", before: "/api/paper/overview?market=KR", after: endpoints.paper.market("KR").overview },
  { name: "paper.market(US).live", before: "/api/paper/live", after: endpoints.paper.market("US").live },
  { name: "paper.market(KR).live", before: "/api/paper/live?market=KR", after: endpoints.paper.market("KR").live },
  { name: "paper.market(KR).status", before: "/api/paper/status?market=KR", after: endpoints.paper.market("KR").status },
  { name: "paper.market(KR).init", before: "/api/paper/init?market=KR", after: endpoints.paper.market("KR").init },
  { name: "paper.market(KR).runRisk", before: "/api/paper/run/risk?market=KR", after: endpoints.paper.market("KR").runRisk },
  { name: "paper.market(KR).runInitialDecision", before: "/api/paper/run/initial-decision?market=KR",
    after: endpoints.paper.market("KR").runInitialDecision },
  ...[true, false].map((includeExpired) => ({
    name: `paper.market(KR).notes includeExpired=${includeExpired}`,
    before: `/api/paper/notes?includeExpired=${includeExpired}&market=KR`,
    after: endpoints.paper.market("KR").notes(includeExpired),
  })),
  { name: "paper.market(KR).reviews", before: "/api/paper/reviews?market=KR", after: endpoints.paper.market("KR").reviews },
  { name: "paper.market(KR).review", before: `/api/paper/reviews/${"2026-10-30"}?market=KR`,
    after: endpoints.paper.market("KR").review("2026-10-30") },
  { name: "paper.market(KR).runReview", before: "/api/paper/reviews/run?market=KR", after: endpoints.paper.market("KR").runReview },
];

describe("API 경로 — 예전 조립식과 서버가 받는 값이 같다", () => {
  it.each(CASES)("$name", ({ before, after }) => {
    expect(received(after)).toEqual(received(before));
  });
});

describe("값 인코딩", () => {
  it("&·공백이 들어가도 파라미터가 쪼개지지 않는다", () => {
    const url = endpoints.insight.scorecard("BRK.B & CO", "S P Y", "1");
    expect(received(url).params).toEqual([["symbol", "BRK.B & CO"], ["benchmark", "S P Y"], ["years", "1"]]);
  });

  it("경로 조각도 인코딩한다", () => {
    expect(endpoints.status.runTask("a/b")).toBe("/api/status/run/a%2Fb");
    // 책 코드의 "/"가 경로를 바꾸지 않게 — 그대로 붙이면 "../init"이 /api/paper/init/reset으로 풀립니다.
    expect(endpoints.paper.bookReset("../init")).toBe("/api/paper/books/..%2Finit/reset");
  });
});

describe("모의 매매 설정 경로", () => {
  it("설정 저장은 읽기와 같은 경로에 POST하고, 이력은 그 아래", () => {
    expect(endpoints.paper.saveSettings).toBe(endpoints.paper.settings);
    expect(endpoints.paper.settings).toBe("/api/paper/settings");
    expect(endpoints.paper.settingsHistory).toBe("/api/paper/settings/history");
  });
});

describe("모의 매매 프레임·메모 경로", () => {
  it("수동 편집·제안 요청·메모 쓰기는 읽기와 같은 경로에 POST, 승인·거절·보관은 번호 아래", () => {
    expect(endpoints.paper.saveFramework).toBe(endpoints.paper.framework);
    expect(endpoints.paper.framework).toBe("/api/paper/framework");
    expect(endpoints.paper.propose).toBe(endpoints.paper.proposals);
    expect(endpoints.paper.proposals).toBe("/api/paper/framework/proposals");
    expect(endpoints.paper.createNote).toBe("/api/paper/notes");
    expect(endpoints.paper.archiveNote(12)).toBe("/api/paper/notes/12");
    expect(endpoints.paper.approveProposal(12)).toBe("/api/paper/framework/proposals/12/approve");
  });
});

describe("모의 매매 시장 단위 경로", () => {
  it("미국(market('US'))은 옛 키와 글자까지 같다 — 미국 화면 호출부·테스트 mock이 경로로 맞춤", () => {
    const us = endpoints.paper.market("US");
    expect(us.overview).toBe(endpoints.paper.overview);
    expect(us.status).toBe(endpoints.paper.status);
    expect(us.init).toBe(endpoints.paper.init);
    expect(us.runRisk).toBe(endpoints.paper.runRisk);
    expect(us.runDecision).toBe(endpoints.paper.runDecision);
    expect(us.runInitialDecision).toBe(endpoints.paper.runInitialDecision);
    expect(us.reviews).toBe(endpoints.paper.reviews);
    expect(us.runReview).toBe(endpoints.paper.runReview);
    for (const includeExpired of [true, false]) expect(us.notes(includeExpired)).toBe(endpoints.paper.notes(includeExpired));
    expect(us.review("2026-10-30")).toBe(endpoints.paper.review("2026-10-30"));
  });

  it("한국은 끝에 ?market=KR — 같은 경로에 시장 값만 더함(메모 쓰기는 본문 market이라 createNote 그대로)", () => {
    const kr = endpoints.paper.market("KR");
    expect(kr.overview).toBe("/api/paper/overview?market=KR");
    expect(kr.runDecision).toBe("/api/paper/run/decision?market=KR");
    expect(kr.notes(true)).toBe("/api/paper/notes?includeExpired=true&market=KR");
    expect(kr.review("2026-10-30")).toBe("/api/paper/reviews/2026-10-30?market=KR");
    expect(endpoints.paper.createNote).toBe("/api/paper/notes");
  });
});

describe("모의 매매 주간 복기 경로", () => {
  it("목록 아래에 주(날짜)별 한 건과 수동 실행", () => {
    expect(endpoints.paper.reviews).toBe("/api/paper/reviews");
    expect(endpoints.paper.review("2026-10-30")).toBe("/api/paper/reviews/2026-10-30");
    expect(endpoints.paper.runReview).toBe("/api/paper/reviews/run");
  });
});

/** endpoints의 잎(문자열 경로·경로를 만드는 함수)을 모읍니다. */
function leaves(value: unknown, out = { strings: [] as string[], functions: 0 }) {
  if (typeof value === "string") out.strings.push(value);
  else if (typeof value === "function") out.functions += 1;
  else if (value && typeof value === "object") Object.values(value).forEach((v) => leaves(v, out));
  return out;
}

/** 쿼리를 뗀 경로. 동적 조각은 문서 표기로 바꿉니다. */
const documentedForm = (url: string) => new URL(url, "http://backend").pathname
  .replace(/^\/api\/macro\/fred\/[^/]+$/, "/api/macro/fred/{seriesId}")
  .replace(/^\/api\/status\/run\/[^/]+$/, "/api/status/run/{taskName}")
  .replace(/^\/api\/admin\/users\/[^/]+$/, "/api/admin/users/{id}")
  .replace(/^\/api\/alerts\/rules\/[^/]+$/, "/api/alerts/rules/{id}")
  .replace(/^\/api\/paper\/books\/[^/]+\/(positions|orders|fills|nav|status|reset)$/, "/api/paper/books/{code}/$1")
  .replace(/^\/api\/paper\/decisions\/[^/]+$/, "/api/paper/decisions/{id}")
  .replace(/^\/api\/paper\/framework\/versions\/[^/]+$/, "/api/paper/framework/versions/{version}")
  .replace(/^\/api\/paper\/framework\/proposals\/[^/]+\/(approve|reject)$/, "/api/paper/framework/proposals/{id}/$1")
  .replace(/^\/api\/paper\/notes\/[^/]+$/, "/api/paper/notes/{id}")
  .replace(/^\/api\/paper\/reviews\/(?!run$)[^/]+$/, "/api/paper/reviews/{weekEnding}");

describe("docs/API.md 백엔드 표와 대조", () => {
  it("화면이 부르는 경로는 모두 문서(= 백엔드 경로 목록 테스트가 대조하는 표)에 있다", () => {
    const doc = readFileSync(resolve(__dirname, "../../../../docs/API.md"), "utf8");
    // 표 형식 두 가지: `GET /api/x` 또는 | GET | `/api/x` |
    const documented = new Set([...doc.matchAll(/`(?:(?:GET|POST) )?(\/api\/[^`?\s]*)/g)].map((m) => m[1]));
    expect(documented.size).toBeGreaterThan(50);

    const { strings, functions } = leaves(endpoints);
    const paths = [...strings, ...CASES.map(({ after }) => after)].map(documentedForm);
    expect(paths.filter((path) => !documented.has(path))).toEqual([]);
    // 경로를 만드는 함수는 모두 위 CASES에 한 줄 이상 있습니다. 새 함수를 만들었다면 CASES에 추가하고 이 숫자를 고치세요.
    expect(functions).toBe(54);
  });
});
