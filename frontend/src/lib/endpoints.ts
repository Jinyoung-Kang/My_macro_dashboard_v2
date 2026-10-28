/**
 * src/lib/endpoints.ts
 * 백엔드 API 경로를 한 곳에 모읍니다. 화면은 주소 문자열을 직접 만들지 않고 여기 함수를 씁니다.
 *
 * 왜 — 예전에는 31개 파일이 주소를 제각각 만들었습니다. 같은 값을 어떤 곳은 인코딩하고
 * 어떤 곳은 그대로 붙여(`&`·공백이 들어가면 요청이 깨짐), 경로가 바뀌면 여러 파일을 찾아
 * 고쳐야 했습니다. 묶음은 백엔드 기능 패키지(feature/*)와 같게 나눕니다.
 *
 * 규칙
 * - 모든 쿼리 값과 경로 조각은 encodeURIComponent로 인코딩합니다.
 * - 필수 값은 비어 있어도 보냅니다(`ids=`) — 서버가 "비었음"을 판단합니다.
 * - 선택 값은 undefined면 뺍니다. 호출하는 쪽이 "없음"을 undefined로 넘깁니다.
 *
 * 경로 목록은 docs/API.md 백엔드 표와 테스트로 대조합니다(__tests__/endpoints.test.ts).
 */

type QueryValue = string | number | boolean | undefined;

/** 경로 + 쿼리스트링. undefined인 값만 뺍니다(순서 유지). */
function withQuery(path: string, params: Record<string, QueryValue>): string {
  const parts = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`);
  return parts.length > 0 ? `${path}?${parts.join("&")}` : path;
}

const segment = (value: string) => encodeURIComponent(value);

/** 비어 있으면 undefined — 선택 값으로 넘길 때 씁니다. */
const optional = (value: string | null | undefined) => (value ? value : undefined);

export const endpoints = {
  auth: {
    login: "/api/auth/login",
    logout: "/api/auth/logout",
    session: "/api/auth/session",
    logoutAll: "/api/auth/logout-all",
    sessions: "/api/auth/sessions",
    password: "/api/auth/password",
    signup: "/api/auth/signup",
    verify: "/api/auth/verify",
    resetRequest: "/api/auth/reset/request",
    resetConfirm: "/api/auth/reset/confirm",
    deleteAccount: "/api/auth/delete",
  },

  // 🔔 알림 — 규칙·화면 알림함
  alerts: {
    rules: "/api/alerts/rules",
    rule: (id: number) => `/api/alerts/rules/${segment(String(id))}`,
    inbox: (limit: number) => withQuery("/api/alerts/inbox", { limit }),
    unreadCount: "/api/alerts/unread-count",
    read: "/api/alerts/inbox/read",
  },

  // 👥 사용자 관리(운영자)
  admin: {
    users: "/api/admin/users",
    user: (id: number) => `/api/admin/users/${segment(String(id))}`,
    audit: (limit: number) => withQuery("/api/admin/audit", { limit }),
  },

  // 📊 매크로 · 순유동성 · 로테이션
  macro: {
    overview: (live: boolean) => withQuery("/api/macro/overview", { live: live ? true : undefined }),
    risk: "/api/macro/risk",
    advanced: "/api/macro/advanced",
    usdkrw: "/api/macro/usdkrw",
    scraped: "/api/macro/scraped",
    fx: (ids: readonly string[], period: string, mode: string) =>
      withQuery("/api/macro/fx", { ids: ids.join(","), period, mode }),
    fred: (seriesId: string, years: number) => withQuery(`/api/macro/fred/${segment(seriesId)}`, { years }),
    ticker: (symbol: string, period: string) => withQuery("/api/macro/ticker", { symbol, period }),
    liquidity: (years: string | number) => withQuery("/api/liquidity", { years }),
    sectorRotation: (period: string) => withQuery("/api/sector/rotation", { period }),
  },

  // 📑 13F · 🧬 기관 스타일
  institution: {
    institutions: "/api/sec13f/institutions",
    portfolio: (cik: string, quarters: string | number, topN: string | number) =>
      withQuery("/api/sec13f/portfolio", { cik, quarters, topN }),
    consensus: (p: { minHolders: string | number; topN: number; ciks?: string; reportDate?: string }) =>
      withQuery("/api/sec13f/consensus", {
        minHolders: p.minHolders, topN: p.topN, ciks: optional(p.ciks), reportDate: optional(p.reportDate),
      }),
    newBuys: (minHolders: string | number, reportDate?: string) =>
      withQuery("/api/sec13f/new-buys", { minHolders, reportDate: optional(reportDate) }),
    guruProfiles: "/api/guru/profiles",
    guruSimilarity: "/api/guru/similarity",
    guruHolders: (q: string) => withQuery("/api/guru/holders", { q }),
    guruRisk: (cik: string, benchmark: string, years: string | number) =>
      withQuery("/api/guru/risk", { cik, benchmark, years }),
  },

  // 🩺 스코어카드 · 🔗 상관 · 🧭 국면
  insight: {
    stockUniverse: "/api/stock/universe",
    scorecard: (symbol: string, benchmark: string, years: string | number) =>
      withQuery("/api/stock/scorecard", { symbol, benchmark, years }),
    series: "/api/analytics/series",
    correlation: (p: { x: string; y: string; window: string | number; years: string | number; mode: string }) =>
      withQuery("/api/analytics/correlation", { x: p.x, y: p.y, window: p.window, years: p.years, mode: p.mode }),
    regime: (years: string | number) => withQuery("/api/analytics/regime", { years }),
    regimeLog: (limit: string | number) => withQuery("/api/analytics/regime/log", { limit }),
    regimeTrackRecord: (asset: string) => withQuery("/api/analytics/regime/track-record", { asset }),
  },

  // 🏛️ COT · 🇰🇷 파생 · 📡 레이더 · 🏦 투자자별 매매
  positioning: {
    cotAssets: "/api/cot/assets",
    cotOverview: "/api/cot/overview",
    cotAsset: (name: string) => withQuery("/api/cot/asset", { name }),
    cotExtremes: (name: string, percentile: string | number, lookbackWeeks: string | number) =>
      withQuery("/api/cot/extremes", { name, percentile, lookbackWeeks }),
    krxFutures: (days: number) => withQuery("/api/krx/futures", { days }),
    krxInvestorTrend: "/api/krx/investor-trend",
    krxIntraday: (minutes: number) => withQuery("/api/krx/intraday", { minutes }),
    krxSpotFutures: "/api/krx/spot-futures",
    radarOptions: "/api/radar/options",
    radarRanking: (p: { market: string; investor: string; tradeType: string; intervalType: string; topN: string | number }) =>
      withQuery("/api/radar/ranking", {
        market: p.market, investor: p.investor, tradeType: p.tradeType, intervalType: p.intervalType, topN: p.topN,
      }),
    radarConsensus: (p: { market: string; tradeType: string; intervalType: string; topN: string | number }) =>
      withQuery("/api/radar/consensus", {
        market: p.market, tradeType: p.tradeType, intervalType: p.intervalType, topN: p.topN,
      }),
    /** 하루치 이력. obsDate가 없으면 가장 최근 날짜. */
    radarHistory: (p: { market: string; investor: string; tradeType: string; obsDate?: string }) =>
      withQuery("/api/radar/history", {
        market: p.market, investor: p.investor, tradeType: p.tradeType, latest: true, obsDate: optional(p.obsDate),
      }),
    radarDiagnostics: "/api/radar/diagnostics",
    investorFlows: "/api/kr/investor-flows",
    stockFlows: (codes: string) => withQuery("/api/kr/stock-flows", { codes }),
  },

  // 공공 API(공공데이터포털·Open DART)
  publicData: {
    krHolidays: "/api/calendar/kr-holidays",
    fundamentals: (codes: string) => withQuery("/api/kr/fundamentals", { codes }),
    marketTotals: (days: number) => withQuery("/api/kr/market-totals", { days }),
    /** run은 누를 때마다 바꿔 새로 부르게 하는 값입니다(서버는 쓰지 않음). */
    apiStatus: (run: number) => withQuery("/api/status/public-apis", { run }),
  },

  // 🗄️ 저장소 상태 · 교차 검증
  status: {
    overview: "/api/status",
    issues: "/api/status/issues",
    refresh: (runFast: boolean) => withQuery("/api/status/refresh", { runFast }),
    runTask: (taskName: string) => `/api/status/run/${segment(taskName)}`,
    history: (task: string, limit: number) => withQuery("/api/status/history", { task, limit }),
    verification: "/api/verification",
  },

  // 📋 전체 원본 데이터
  snapshot: {
    text: "/api/snapshot/text",
  },

  // 🤖 AI
  ai: {
    engines: "/api/ai/engines",
    reportTypes: "/api/ai/report-types",
    report: "/api/ai/report",
    test: (engineId: string, prompt: string) => withQuery("/api/ai/test", { engineId, prompt }),
  },

  // 🧪 모의 알고리즘 매매(운영자 전용). code는 책 코드(rules · claude · bench_spy · bench_mix · kr_rules · kr_claude · kr_bench_k200 · kr_bench_mix).
  paper: {
    /**
     * 시장 단위 경로(2단계 명세 §4-16, docs/API.md '시장 단위 조회·실행') — 개요·상태·초기화·리스크 점검·수동 결정·시작·메모 목록·복기.
     * 미국("US")은 아래 옛 키와 글자까지 같은 주소(`?market` 없음 — 서버는 없으면 미국), 한국("KR")은 끝에 `?market=KR`
     * (메모 목록은 includeExpired 뒤). 메모 쓰기는 본문 `market`이라 `createNote` 그대로, 계좌 코드 경로(/books/{code}/…)와 결정
     * 목록·한 건은 계좌 코드가 시장을 정해 그대로입니다.
     */
    market: (m: "US" | "KR") => {
      const korea = m === "KR";
      const scoped = (path: string) => (korea ? withQuery(path, { market: "KR" }) : path);
      return {
        overview: scoped("/api/paper/overview"),
        status: scoped("/api/paper/status"),
        init: scoped("/api/paper/init"),
        runRisk: scoped("/api/paper/run/risk"),
        runDecision: scoped("/api/paper/run/decision"),
        runInitialDecision: scoped("/api/paper/run/initial-decision"),
        notes: (includeExpired: boolean) =>
          withQuery("/api/paper/notes", { includeExpired, market: korea ? "KR" : undefined }),
        reviews: scoped("/api/paper/reviews"),
        review: (weekEnding: string) => scoped(`/api/paper/reviews/${segment(weekEnding)}`),
        runReview: scoped("/api/paper/reviews/run"),
      };
    },
    overview: "/api/paper/overview",
    status: "/api/paper/status",
    init: "/api/paper/init",
    runRisk: "/api/paper/run/risk",
    /** 13F 트랙레코드·선정. asOf(YYYY-MM-DD)가 없으면 가장 최근 계산. */
    trackRecord: (asOf?: string) => withQuery("/api/paper/track-record", { asOf: optional(asOf) }),
    /** 수동 재계산 — 본문 `{asOf?}`(없으면 마지막 완료 세션). 선정은 바꾸지 않습니다. */
    runRerank: "/api/paper/run/rerank",
    positions: (code: string) => `/api/paper/books/${segment(code)}/positions`,
    orders: (code: string, limit: number) => withQuery(`/api/paper/books/${segment(code)}/orders`, { limit }),
    fills: (code: string, limit: number) => withQuery(`/api/paper/books/${segment(code)}/fills`, { limit }),
    nav: (code: string) => `/api/paper/books/${segment(code)}/nav`,
    bookStatus: (code: string) => `/api/paper/books/${segment(code)}/status`,
    bookReset: (code: string) => `/api/paper/books/${segment(code)}/reset`,
    /** 책 하나의 결정 기록(최근 순). book은 rules · claude. */
    decisions: (book: string, limit: number) => withQuery("/api/paper/decisions", { book, limit }),
    /** 결정 한 건의 전체 기록(선정·신호·주문·게이트 참고). */
    decision: (id: number) => `/api/paper/decisions/${segment(String(id))}`,
    /** 수동 결정 — 본문 `{book}`. 시각 조건 없이 그 책만 종류 MANUAL로 한 번. */
    runDecision: "/api/paper/run/decision",
    /**
     * 초기 결정("시작") — 본문 `{book}`. 출발일 종가로 사후 체결해 시작합니다. Claude 책은 `{book:"claude", preview:true}`로
     * 미리보기(호출·검증만, 장부에 쓰지 않음)도 합니다.
     */
    runInitialDecision: "/api/paper/run/initial-decision",
    /** 지금 설정(버전·본문·기본값·키 설명). */
    settings: "/api/paper/settings",
    /** 설정 변경 이력(버전마다 바뀐 키). */
    settingsHistory: "/api/paper/settings/history",
    /** 설정 저장 — POST, 본문은 바꿀 키만 담은 patch(`{"키": 값}`). 읽기와 같은 경로입니다. */
    saveSettings: "/api/paper/settings",
    /** 프레임(투자 OS) — 지금 판(렌더링·토큰 어림)과 판 목록. */
    framework: "/api/paper/framework",
    /** 판 하나(전후 비교용 렌더링 포함). */
    frameworkVersion: (version: number) => `/api/paper/framework/versions/${segment(String(version))}`,
    /** 수동 편집 — POST `{body, changelog, baseVersion}`, 새 판(기준 판이 지금 판이 아니면 400). 읽기와 같은 경로입니다. */
    saveFramework: "/api/paper/framework",
    /** 프레임 제안 목록(최근 순). */
    proposals: "/api/paper/framework/proposals",
    /** 제안 요청 — POST `{noteId?, text?}`. Claude를 한 번 부릅니다(하루 상한 공유). 목록과 같은 경로입니다. */
    propose: "/api/paper/framework/proposals",
    /** 제안 승인(새 판) — Claude를 부르지 않습니다. */
    approveProposal: (id: number) => `/api/paper/framework/proposals/${segment(String(id))}/approve`,
    rejectProposal: (id: number) => `/api/paper/framework/proposals/${segment(String(id))}/reject`,
    /** 메모 목록 — includeExpired면 만료한 메모도. */
    notes: (includeExpired: boolean) => withQuery("/api/paper/notes", { includeExpired }),
    /** 메모 쓰기 — POST `{kind, asOfDate?, expiresOn?, title, body}`. */
    createNote: "/api/paper/notes",
    /** 메모 보관 — DELETE(지우지 않고 archived). */
    archiveNote: (id: number) => `/api/paper/notes/${segment(String(id))}`,
    /** 주간 복기 목록(주 최근 순, 판정 수·연결된 제안 상태). */
    reviews: "/api/paper/reviews",
    /** 복기 한 건 — weekEnding은 복기 주(YYYY-MM-DD, 그 주의 마지막 거래일). */
    review: (weekEnding: string) => `/api/paper/reviews/${segment(weekEnding)}`,
    /** 수동 복기 — POST(본문 없음). 가장 최근 복기 주를 지금(토요일 시각 조건 없이). Claude를 한 번 부릅니다(하루 상한 공유). */
    runReview: "/api/paper/reviews/run",
  },

  // 🔌 토스증권 연결 테스트 (경로는 /api/ai/toss 이지만 AI와 관계없음)
  toss: {
    diagnostics: (run: number) => withQuery("/api/ai/toss/diagnostics", { run }),
    exchangeRate: (base: string, quote: string) => withQuery("/api/ai/toss/exchange-rate", { base, quote }),
    indices: (symbols: string) => withQuery("/api/ai/toss/indices", { symbols }),
  },
} as const;
