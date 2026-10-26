/**
 * 홈 화면 테스트의 고정 응답(이야기) — 로컬 v2 API 실측(2026-10-26) 모양을 줄여 옮긴 것입니다.
 * 테스트 파일이 아니라 자료라 vitest가 따로 돌리지 않습니다(이름이 *.test.ts가 아님). 함수마다 새 객체를 돌려줘
 * 이야기마다 고쳐 써도 서로 섞이지 않습니다.
 */
import type {
  InboxResponse,
  MacroItem,
  MacroOverview,
  PaperBookSummary,
  PaperOverviewResponse,
  PaperStatusResponse,
  RegimeResponse,
  StatusIssuesResponse,
} from "../types";

export function regimeExpansion(): RegimeResponse {
  return {
    available: true,
    asOf: "2026-10-16",
    verdict: {
      code: "EXPANSION",
      label: "확장 (Expansion)",
      summary: "성장·신용 신호가 모두 정상이고 유동성도 들어오고 있습니다. 위험자산에 우호적인 조합입니다.",
      growthAxis: "양호",
      liquidityAxis: "확대",
      signals: [
        { id: "curve", label: "장단기 금리차 10Y-3M", value: 0.78, unit: "%p", state: "정상",
          reading: "장기 금리가 단기보다 높습니다(정상 구조).", healthy: true },
        { id: "nfci", label: "시카고 연준 금융상황지수", value: -0.496, unit: "", state: "완화적",
          reading: "0(장기 평균)보다 낮습니다 — 자금 조달 여건이 평균보다 느슨합니다.", healthy: true },
        { id: "hyOas", label: "하이일드 스프레드", value: 3.4, unit: "%p", state: "정상", reading: "정상 범위입니다.", healthy: true },
        { id: "liquidity", label: "연준 순유동성 4주 변화", value: 0.031358, unit: "조 달러", state: "확대",
          reading: "최근 4주 동안 시장으로 유동성이 들어왔습니다.", healthy: true },
      ],
      missing: [],
    },
    timeline: [],
    episodes: [],
    note: "임계치는 역사적 분포에 근거한 참고치이며 투자 판단의 근거가 아닙니다.",
  };
}

/** 하이일드 스프레드를 받지 못한 날 — 백엔드는 그 신호를 signals에서 빼고 missing에 이름만 적습니다(Regime.classify). */
export function regimeUnknown(): RegimeResponse {
  const base = regimeExpansion();
  return {
    ...base,
    available: false,
    asOf: null,
    verdict: {
      code: "UNKNOWN",
      label: "판정 불가",
      summary: "입력 지표가 빠져 국면을 판정하지 않습니다. 빠진 값을 0으로 메우면 '중립'이라는 틀린 판정이 됩니다.",
      growthAxis: "판정 불가",
      liquidityAxis: "판정 불가",
      signals: (base.verdict?.signals ?? []).filter((signal) => signal.id !== "hyOas"),
      missing: ["하이일드 스프레드 (HY OAS)"],
    },
  };
}

export function macroItem(overrides: Partial<MacroItem> & Pick<MacroItem, "key" | "name">): MacroItem {
  return {
    note: "실시간",
    market: "nyse",
    ticker: "^GSPC",
    status: "ok",
    price: 7622.990234375,
    priceStr: "7,622.99",
    delta: -40.4599609375,
    pct: -0.5279601211768575,
    deltaStr: "-40.46 (-0.53%)",
    prevStr: "7,663.45",
    lastTs: "2026-10-24 04:59 KST",
    source: "Yahoo Finance (^GSPC)",
    delayMinutes: 0,
    ...overrides,
  };
}

export function macroOverview(): MacroOverview {
  return {
    readMode: "auto",
    available: true,
    collectedAtKst: "2026-10-26 16:51 KST",
    ageSeconds: 166,
    stale: false,
    categories: [
      {
        id: "fx",
        title: "💵 통화 및 환율",
        note: "실시간",
        items: [
          macroItem({ key: "usdkrw", name: "원/달러 (USD/KRW)", market: "fx", ticker: "KRW=X", price: 1322.280029296875,
            priceStr: "1,322.28", delta: -1.3800048828125, pct: -0.10425674623225525, lastTs: "2026-10-26 16:51 KST",
            source: "Yahoo Finance (KRW=X)" }),
        ],
      },
      {
        id: "us_equity",
        title: "🇺🇸 미국 주가지수 및 선물",
        note: "종목마다 다름 — 카드 배지 참고",
        items: [
          macroItem({ key: "sp500", name: "S&P 500" }),
          macroItem({ key: "sp500_fut", name: "S&P 500 선물 (ES)", market: "cme", ticker: "ES=F", price: 7674, priceStr: "7,674.00",
            delta: 14.25, pct: 0.1860374033095075, lastTs: "2026-10-26 16:41 KST", source: "Yahoo Finance (ES=F)", delayMinutes: 10 }),
        ],
      },
      {
        id: "asia_equity",
        title: "🌏 아시아 주요 주가지수",
        note: "종목마다 다름 — 카드 배지 참고",
        items: [
          macroItem({ key: "kospi200_night_scraped", name: "코스피200 야간선물", market: "krx_futures", ticker: null,
            note: "20분 지연 · 참고 시세", price: 839.7, priceStr: "839.70", delta: null, pct: null, deltaStr: "N/A", prevStr: "N/A",
            lastTs: "2026-10-26 16:51 KST (TradingView 수집 시각 · 장 밖)", source: "TradingView Scanner", delayMinutes: 20,
            isReference: true, isEstimated: false }),
        ],
      },
    ],
  };
}

export function book(overrides: Partial<PaperBookSummary> & Pick<PaperBookSummary, "code" | "kind" | "label">): PaperBookSummary {
  return {
    status: "ACTIVE",
    startedOn: "2026-10-23",
    initialCash: 100000,
    cash: 1953.13,
    nav: 99951,
    equityValue: 97997.87,
    exposurePct: 98.05,
    returnPct: -0.05,
    lastObservedAtKst: "2026-10-26 04:56 KST",
    positions: 11,
    staleCount: 0,
    stats: null,
    benchmark: "bench_spy",
    ...overrides,
  };
}

export function paperOverview(): PaperOverviewResponse {
  return {
    available: true,
    initialized: true,
    pendingBackfill: [],
    startDate: "2026-10-23",
    books: [
      book({ code: "rules", kind: "RULES", label: "규칙 계좌" }),
      book({ code: "claude", kind: "CLAUDE", label: "Claude 계좌", nav: 99967.28, returnPct: -0.03, positions: 9 }),
      book({ code: "bench_spy", kind: "BENCHMARK", label: "SPY 계좌", nav: 99950.22, benchmark: null }),
      book({ code: "bench_mix", kind: "BENCHMARK", label: "60/40 계좌", nav: 99950.39 }),
    ],
    navSeries: { dates: ["2026-10-23"], books: { rules: [99951], claude: [99967.28], bench_spy: [99950.22], bench_mix: [99950.39] } },
    quotes: {
      collectedAtKst: "2026-10-26 16:37 KST",
      ageSeconds: 1025,
      barDate: "2026-10-23",
      finalClose: true,
      tickers: 615,
      staleTickers: [],
      stale: false,
    },
  };
}

export function paperStatus(enabled = false): PaperStatusResponse {
  return { available: true, schemaReady: true, initialized: true, enabled, startDate: "2026-10-23", initialCash: 100000 };
}

export function inbox(): InboxResponse {
  return {
    unread: 2,
    items: [
      { id: 12, kind: "REGIME_CHANGE", occurredOn: "2026-10-25", title: "[국면 전환] 후퇴 경계 → 확장", body: "", late: false,
        createdAt: "2026-10-25 18:00 KST", read: false },
      { id: 11, kind: "INSTITUTION_NEW", occurredOn: "2026-10-20", title: "Berkshire 13F 신규 편입", body: "", late: false,
        createdAt: "2026-10-20 09:00 KST", read: true },
      { id: 10, kind: "FOREIGN_STREAK", occurredOn: "2026-10-18", title: "외국인 5일 연속 순매수", body: "", late: false,
        createdAt: "2026-10-18 16:00 KST", read: false },
    ],
  };
}

export function issues(errors = 0, warnings = 0): StatusIssuesResponse {
  return {
    generatedAt: "2026-10-26 16:54 KST",
    collectorReachable: true,
    lookbackHours: 24,
    lastRunStatus: "ok",
    counts: { errors, warnings, recentGroups: 1, missingDatasets: 0 },
    current: [],
    recent: [],
    missing: [],
    text: "",
  };
}
