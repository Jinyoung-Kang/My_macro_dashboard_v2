/**
 * 백엔드 응답 계약 — 🧪 모의 알고리즘 매매(`/api/paper/*`, 운영자 전용).
 *
 * 값이 없을 수 있는 필드는 전부 `| null`입니다. 프런트는 그 null을 그대로 "—"로 표시하고,
 * 절대 0으로 바꾸지 않습니다. 금액은 백엔드가 소수 2자리로 반올림해 보내고, 수익률·통계도 백엔드가
 * 계산합니다 — 화면은 고르고 이름 붙여 그리기만 합니다(ADR 0004). 가져올 때는 `@/lib/types`(배럴)를 씁니다.
 *
 * 테이블이 아직 없으면(수집기가 V8 스키마를 적용하기 전) 모든 응답이 `{available: false, message}`뿐입니다.
 * 그래서 `available` 밖의 필드는 선택(`?`)입니다.
 */

/**
 * 모의매매 책의 시장(2단계 명세 §4-16) — 개요·상태 등 시장 단위 경로의 `?market=` 값이자 한국 응답의 `market` 칸. 값이 없으면 미국입니다
 * (미국 응답에는 `market` 칸이 없음 — 시장을 받기 전 글자 그대로). 표기 규칙은 lib/paperMarket.
 */
export type PaperMarketCode = "US" | "KR";

/** 책 종류 — 규칙 책 · Claude 재량 책 · 벤치마크(SPY 100%, SPY 60%·SHY 40%). */
export type PaperBookKind = "RULES" | "CLAUDE" | "BENCHMARK";

/** 책 상태. NOT_STARTED는 현금만 든 책(규칙·Claude 책은 개요의 '규칙 계좌 시작'·'Claude 계좌 시작' — 초기 결정으로 시작). */
export type PaperBookStatus = "NOT_STARTED" | "ACTIVE" | "PAUSED";

/** 책 통계(PaperStats). 표본(일별 수익률 수)이 짧으면 cumReturnPct만 있고 나머지는 null입니다. */
export interface PaperStats {
  cumReturnPct: number | null;
  cagrPct: number | null;
  volPct: number | null;
  /** 최대 낙폭 — 음수(%). */
  mddPct: number | null;
  sharpe: number | null;
  /** benchmark 책 대비 초과 수익률(%p). 비교 기준이 없으면 null. */
  excessPct: number | null;
  beta: number | null;
  sampleDays: number;
}

/** 책 하나의 요약(BookSummary). 개요·보유 응답과 버튼 응답이 같은 모양을 씁니다. */
export interface PaperBookSummary {
  /** rules · claude · bench_spy · bench_mix */
  code: string;
  kind: PaperBookKind;
  label: string;
  status: PaperBookStatus;
  /** 첫 체결 거래일(미국 동부 세션 날짜). 시작 전이면 null. */
  startedOn: string | null;
  initialCash: number | null;
  cash: number | null;
  nav: number | null;
  equityValue: number | null;
  exposurePct: number | null;
  returnPct: number | null;
  lastObservedAtKst: string | null;
  /** 보유 종목 수. */
  positions: number | null;
  /** 가격을 새로 받지 못한 보유 수. */
  staleCount: number | null;
  stats: PaperStats | null;
  /** 통계를 낼 수 없는 사유('달력 없음 — …', 그 시장 달력이 순자산 줄이 걸친 해의 공휴일 목록을 모름). 보통 null. 화면 표시는 2단계 F2. */
  statsReason?: string | null;
  /** 통계 비교 기준 책 코드(rules·claude·bench_mix → bench_spy). bench_spy 자신은 null. */
  benchmark: string | null;
}

/**
 * 장부 관측치(paper.quotes 저장본) 요약 — PaperQueryService.quotesSummary. 저장본이 아직 없으면 이 객체 대신 `quotes: null`입니다.
 * 저장본이 있으면 barDate 밖의 필드는 늘 옵니다(barDate는 쓸 수 있는 봉이 하나도 없을 때만 null).
 */
export interface PaperQuotesSummary {
  collectedAtKst: string;
  /** 수집 뒤 지난 초(0 이상). */
  ageSeconds: number;
  /** 관측치의 최빈 봉 날짜(미국 동부). 장중이면 그날, 장 마감 전후 판단의 근거. */
  barDate: string | null;
  /** 그 봉이 확정 종가인가(봉 날짜 마감 + 15분 뒤에 수집). false면 장중·마감 직후의 지연 시세입니다. */
  finalClose: boolean;
  /** 관측치에 든 티커 수(개수). */
  tickers: number;
  /** 이번 수집에 실패해 직전 저장본의 값을 이어 쓴 티커 이름(목록, 없으면 빈 배열). */
  staleTickers: string[];
  /** 저장본이 늦었는가(수집 3시간 넘게 지남 — 1시간 주기를 두 번 연속 놓침). 신선도 배지를 경고색으로 그립니다. */
  stale: boolean;
}

/** 정기·수동 작업 한 건(paper_job_runs). detail은 JSON 그대로입니다. */
export interface PaperJobRun {
  job: string;
  startedAtKst: string | null;
  finishedAtKst: string | null;
  outcome: string;
  detail: unknown;
}

/** GET /api/paper/overview(?market=KR) */
export interface PaperOverviewResponse {
  available: boolean;
  message?: string;
  /** 한국 응답만 — "KR"(미국 응답에는 칸이 없음). */
  market?: PaperMarketCode;
  /** 한국 응답만 — 장부 통화 "KRW". */
  currency?: string;
  /**
   * 한국 응답만 — 한국 정기 작업(리스크 점검·결정·복기)이 쉬는 사유(출발일이 비었음·한국 초기화 전), 돌면 null. 쉬어도 200이고 조회는
   * 저장본을 읽기만 합니다(docs/API.md '시장 단위 조회').
   */
  dormantReason?: string | null;
  initialized?: boolean;
  /** 네 책의 출발(사후 체결) 거래일 — 설정 dashboard.paper.start-date. */
  startDate?: string | null;
  books?: PaperBookSummary[];
  /** 거래일별 순자산. books[code]는 dates와 같은 길이, 그날 기록이 없는 책은 null(곡선을 끊어 그림). */
  navSeries?: { dates: string[]; books: Record<string, (number | null)[]> } | null;
  quotes?: PaperQuotesSummary | null;
  /** 명세 §6 "화면에 반드시 적을 한계" 여덟 문장(순서대로). */
  limits?: string[];
  /** 최근 작업 기록(10건). */
  jobs?: PaperJobRun[];
  /**
   * 출발일 종가를 아직 받지 못해 사후 체결하지 못한(시작 전으로 남은) 벤치마크 책 코드. 비어 있지 않으면 화면은 초기화 카드를
   * 계속 보입니다 — `initialized`는 책 네 개가 있기만 하면 true라, 그것만 보면 다시 누를 버튼이 사라집니다.
   * 이 필드를 아직 보내지 않는 백엔드에서는 빈 목록으로 봅니다.
   */
  pendingBackfill?: string[];
  /** 가장 최근 기관 선정(선정 순위 순, 이름·순위는 선정 때 값). 아직 선정이 없으면 null. */
  selection?: PaperOverviewSelection | null;
  /**
   * 가장 최근 거래일의 OS 게이트 **지표**(paper_gate_log). 규칙 책·Claude 책 어느 쪽도 구속하지 않습니다(명세 D7·D19).
   * 결정 작업이 아직 한 번도 기록하지 않았으면 null — 이 필드를 아직 보내지 않는 백엔드에서도 null로 봅니다.
   */
  gate?: PaperGateIndicator | null;
  /**
   * Claude 책의 노출 추이(거래일 오름차순, 설계 §8) — 결정 기록의 목표 노출과 그 거래일 장부의 실제 노출. 결정이 없으면 빈 목록이고,
   * 이 필드를 아직 보내지 않는 백엔드에서는 없습니다(화면은 "기록 없음"으로 봅니다).
   */
  claudeExposureSeries?: PaperClaudeExposurePoint[] | null;
  /**
   * 프레임 판 경계(명세 F5) — Claude 책 결정 중 판마다 그 판을 처음 쓴 거래일(날짜 순). 결정이 없으면 빈 목록이고, 이 필드를 아직
   * 보내지 않는 백엔드에서는 없습니다(화면은 경계선을 그리지 않음).
   */
  frameworkBoundaries?: PaperFrameworkBoundary[] | null;
  /**
   * 한국 응답만 — 노출 맞춘 참고선(2단계 명세 §3·K40, 계산만 하고 계좌가 아님). 규칙 계좌 출발 전이면 null, 이 칸을 보내지 않는 백엔드(F2 전)에서는
   * 없습니다.
   */
  exposureReference?: PaperExposureReference | null;
}

/**
 * 노출 맞춘 참고선 — 전날 규칙 계좌 주식 비중 x%를 069500 x% + 153130 (100−x)%로 맞춰 이은 선(금융위 확정 종가, 비용 없음). `dates`는 순자산
 * 곡선과 같은 줄이고 `values`(원 정수)·`stockWeightPct`(그날 값에 쓴 앞 날의 비중)는 같은 길이, 모르는 날은 null. 빈 비중·종가로 멈췄으면
 * `stoppedReason`(그날부터 끝까지 null), 금융위가 아직 내지 않은 마지막 날은 그날만 null입니다.
 */
export interface PaperExposureReference {
  label: string;
  basis: string;
  note: string;
  dates: string[];
  values: (number | null)[];
  stockWeightPct: (number | null)[];
  asOfDate: string | null;
  stoppedReason: string | null;
}

/** 프레임 판 경계 하나 — 그 판(version, status)을 Claude 책 결정이 처음 쓴 거래일. */
export interface PaperFrameworkBoundary {
  tradingDate: string;
  version: number;
  status: PaperFrameworkStatus | string;
}

/**
 * Claude 노출 추이의 거래일 하나. 둘 다 % 값이고 모르면 null(선을 끊어 그림).
 * targetExposurePct는 Claude가 결정에 적은 targetEquityExposurePct(기록·표시용 — 집행은 주문 기준, 설계 §5-3),
 * actualExposurePct는 그 거래일 순자산 기록의 주식 노출(paper_nav_daily.exposure_pct)입니다.
 */
export interface PaperClaudeExposurePoint {
  tradingDate: string;
  targetExposurePct: number | null;
  actualExposurePct: number | null;
}

/** 선정된 기관 하나(개요). 이름·순위를 모르면 null — 화면은 CIK를 대신 적습니다. rank는 그 그룹 안의 순위입니다. */
export interface PaperSelectedFiler {
  cik: string;
  name: string | null;
  rank: number | null;
}

/**
 * 신호 기관 그룹(명세 R1·D27). A = 후보 기관 27곳의 7년 롤링 트랙레코드 상위(기본 5곳),
 * B = 기존 '기관 13F 포트폴리오 분석' 메뉴 12곳의 최근 2년 복제 수익률 상위(기본 4곳). 한 기관이 두 그룹에 모두 들 수 있습니다.
 */
export type PaperFilerGroup = "A" | "B";

/**
 * 개요의 신호 풀 기관 하나(A ∪ B, 겹치면 한 번). groups는 그 기관이 든 그룹(둘 다면 `["A","B"]`).
 * weight는 기관 가중(Signal13F.blendWeights) — **0~1 비율**이고 풀 전체 합이 1입니다. 모르면 null.
 */
export interface PaperOverviewPoolFiler {
  cik: string;
  name: string | null;
  groups: (PaperFilerGroup | string)[];
  weight: number | null;
}

/**
 * 개요의 가장 최근 선정(paper_selection_log) — 두 그룹(선정 순위 순)과 신호 풀(풀 순서 = A 순서 뒤에 B에만 있는 기관).
 * `selected`는 그룹 섞기(D27) 전 모양(선정 = 그룹 A)이라, 그 필드만 오는 백엔드에서는 화면이 그룹 A로 읽습니다.
 */
export interface PaperOverviewSelection {
  asOfDate: string;
  groupA?: PaperSelectedFiler[];
  groupB?: PaperSelectedFiler[];
  pool?: PaperOverviewPoolFiler[];
  selected?: PaperSelectedFiler[];
}

/** 게이트 단계 — L0 동결 · L1 1단계 해제 · L2 전면 해제 · UNKNOWN(입력이 빠져 판정하지 않음, L0로 보지 않음). */
export type PaperGateLevel = "L0" | "L1" | "L2" | "UNKNOWN";

/**
 * 게이트 입력 하나 — 매크로 카드(macro.collected)의 그날 값. 값을 모르면 value가 null입니다(0으로 채우지 않음).
 * 입력 키는 us10y(미국 10년물 %) · brent · wti(달러/배럴) · usdjpy(엔/달러).
 */
export interface PaperGateInput {
  value: number | null;
  /** 값을 읽은 저장본(예: "macro.collected"). */
  source?: string | null;
  /** 그 카드의 마지막 시세 시각(수집기 표기 그대로). */
  lastTs?: string | null;
  /** 수집에 실패해 지난 값을 이어 쓴 카드인가. */
  isStale?: boolean | null;
  /**
   * 그날 조건·연속 일수 계산에 넣었나. 이어 쓴 값이거나 카드 시각이 그 거래일보다 앞이면 false — 값은 기록에 남지만 그 조건은
   * 모르는 값(단계 UNKNOWN)입니다. 이 필드가 생기기 전 기록은 없음.
   */
  counted?: boolean | null;
}

/** 게이트 임계치(GateIndicator.Thresholds, 설정 gate.*). 보내지 않으면 화면은 숫자 없이 조건 이름만 적습니다. */
export interface PaperGateThresholds {
  us10yStage1: number;
  us10yFull: number;
  brentMax: number;
  wtiMax: number;
  usdjpyMin: number;
  confirmDays: number;
}

/**
 * OS 문자 그대로의 게이트 지표(GateIndicator.Result + 입력) — **참고, 구속하지 않음**.
 * 조건: G1 10Y<1단계 기준, G2 10Y≤전면 기준, G3 브렌트≤상한, G4 WTI≤상한, G5 USD/JPY≥기준(참고 조건, 단계에 쓰지 않음).
 * 입력이 없는 조건은 conditions·streaks가 null입니다.
 */
export interface PaperGateIndicator {
  /** 그 지표의 거래일(미국 동부 세션 날짜). */
  tradingDate?: string | null;
  level: PaperGateLevel | string;
  conditions?: Record<string, boolean | null> | null;
  /** 조건이 참인 거래일 연속 수(거짓이면 0, 입력이 없으면 null). */
  streaks?: Record<string, number | null> | null;
  /** 입력 키 → 값. 값만 숫자로 오는 기록도 받습니다(예전 기록·결정 응답의 축약). */
  inputs?: Record<string, PaperGateInput | number | null> | null;
  /** 없는 입력 이름(us10y·brent·wti·usdjpy 순). */
  missing?: string[] | null;
  thresholds?: PaperGateThresholds | null;
  /** 서버 문구(예: "과거 OS가 쓴 트리거 수준 — 구속하지 않음"). */
  note?: string | null;
}

/** GET /api/paper/status */
export interface PaperStatusResponse {
  available: boolean;
  message?: string;
  /** 한국 응답만 — 개요와 같은 머리 칸(시장·통화·쉬는 사유). */
  market?: PaperMarketCode;
  currency?: string;
  dormantReason?: string | null;
  schemaReady?: boolean;
  initialized?: boolean;
  /** dashboard.paper.enabled — false면 정기 작업(리스크·결정)이 일하지 않습니다. 테이블이 없을 때도 옵니다. */
  enabled?: boolean;
  /** 네 책의 출발(사후 체결) 거래일 — 설정 dashboard.paper.start-date. */
  startDate?: string;
  /** 책마다의 처음 현금(달러) — 설정 dashboard.paper.initial-cash. */
  initialCash?: number | null;
  quotes?: PaperQuotesSummary | null;
  /** 최근 작업 기록(30건). */
  jobs?: PaperJobRun[];
  /** 설정 행(paper_settings)의 버전. 행이 없으면(초기화 전) null. */
  settingsVersion?: number | null;
  /** 설정 행에서 키가 없거나 값이 틀려 기본값으로 대신 읽은 키(예: "slippageBp", "gate.brentMax"). 비어 있으면 모두 설정대로. */
  settingsFallbacks?: string[];
  /**
   * Claude 호출 사용량(명세 C8) — 오늘(KST)의 호출 수·상한·토큰·추정 비용과 이달(KST) 누적. 결정·미리보기·시작·프레임 제안이
   * 같은 하루 상한을 씁니다.
   */
  apiUsage?: PaperApiUsage | null;
  /** 미국 종목 재무(SEC XBRL, D28)의 수집 범위 — Claude 책 패킷 8b_fundamentals의 자료. 이 필드를 아직 보내지 않는 백엔드에서는 없습니다. */
  fundamentals?: PaperFundamentalsStatus | null;
  /** 발표·실적 일정(2단계 A)의 수집 범위 — Claude 계좌 패킷 1b_calendar의 자료. 이 필드를 아직 보내지 않는 백엔드에서는 없습니다. */
  calendar?: PaperCalendarStatus | null;
  /** 사건 뉴스 RSS(2단계 B)의 수집 상태 — Claude 계좌 패킷 11b_events의 자료. 이 필드를 아직 보내지 않는 백엔드에서는 없습니다. */
  news?: PaperNewsStatus | null;
  /**
   * 어닝 서프라이즈(2단계 C)의 수집 범위 — Claude 계좌 패킷 8b_fundamentals 줄마다의 최근 4분기 EPS(eps)의 자료. 이 필드를 아직
   * 보내지 않는 백엔드에서는 없습니다.
   */
  earnings?: PaperEarningsStatus | null;
  /**
   * 한국 응답만 — 한국 수집 상태 요약(2단계 명세 §9 x4): 한국 책이 읽는 저장본 일곱 묶음의 수집 시각·세션/기준일·늦음/뒤처짐. 서버가 저장본만
   * 읽어 만들고(수집 유발 없음) 모르는 값은 null입니다. 이 칸을 보내지 않는 백엔드(F2 전)에서는 없습니다.
   */
  collection?: PaperKrCollection | null;
}

/** 한국 수집 상태의 공통 칸 — 수집기 태스크·저장본 이름·저장본이 있나. */
export interface PaperKrCollectionHead {
  task?: string;
  dataset?: string;
  available: boolean;
}

/**
 * 늦음 판정 — true 늦음·false 아님·null 모름(저장본 없음 또는 달력이 그 해를 모름 — 그때 `staleReason`). 관측치·수급은 다음 수집 예정 + 2시간
 * 5분, DART·일정 7일, 뉴스 24시간(서버 규칙).
 */
export interface PaperKrLateness {
  stale: boolean | null;
  staleReason?: string | null;
}

/** GET /api/paper/status?market=KR의 collection(docs/API.md 상태 행). */
export interface PaperKrCollection {
  quotes?: PaperKrCollectionHead & PaperKrLateness & {
    collectedAtKst: string | null; session: string | null; universeDate: string | null; scope: number | null;
  };
  flows?: PaperKrCollectionHead & PaperKrLateness & {
    collectedAtKst: string | null; session: string | null; universeDate: string | null; scope: number | null;
    ok: number | null; sessionMiss?: number | null; noRecords: number | null; carried: number | null; missing: number | null;
  };
  universe?: PaperKrCollectionHead & {
    baseDate: string | null; size: number | null; behind: boolean | null; behindReason: string | null;
  };
  dart?: PaperKrCollectionHead & {
    collectedAtKst: string | null; universe: number | null; krScope: number | null; unmapped: number | null; stale: boolean | null;
  };
  news?: PaperKrCollectionHead & {
    lastFetchKst: string | null; stored7d: number | null; feedsOk: number | null; feedsTotal: number | null;
    failedFeeds: PaperNewsFailedFeed[] | null; stale: boolean | null;
  };
  calendar?: PaperKrCollectionHead & {
    generatedAtKst: string | null; macroCount: number | null; unconfirmed: number | null; horizonTo: string | null; stale: boolean | null;
  };
  fsc?: {
    tasks?: string[]; available: boolean; stocksLatestBasDt: string | null; etfsLatestBasDt: string | null;
    metaCollectedAtKst: string | null; etfBehind: boolean | null;
  };
}

/**
 * 어닝 서프라이즈 수집 범위(2단계 C) — 수집기 상태 저장본(us.earnings_surprise.status)의 요약. 저장본이 없으면 available:false이고
 * 나머지는 모두 null입니다(0으로 채우지 않음 — 화면 —). 숫자는 수집기가 저장된 분기 행으로 셉니다(이번 응답이 아님).
 */
export interface PaperEarningsStatus {
  available: boolean;
  /** 저장된 분기 행이 하나라도 있는 종목 수(개수). */
  covered: number | null;
  /** 대상 — 모의 매매 유니버스에서 ETF를 뺀 종목 수(개수, 실적 일정과 같은 범위). */
  universe: number | null;
  /** 추정치가 있는 분기가 4개 이상 저장된 종목 수(개수). */
  withEstimate4: number | null;
  /** 저장본을 마지막으로 쓴 수집 시각("2026-10-25 21:30 KST"). */
  generatedAtKst: string | null;
}

/**
 * 사건 뉴스 수집 상태(2단계 B) — 수집기 상태 저장본(news.headlines.status)의 요약. 저장본이 없으면 available:false이고 나머지는 모두
 * null입니다(0·빈 목록으로 채우지 않음 — 화면 —). 피드가 모두 실패한 수집은 저장본을 쓰지 않아 그때는 시각이 멈춰 보입니다.
 */
export interface PaperNewsStatus {
  available: boolean;
  /** 보존 7일 안의 헤드라인 수(건, 거르기 전 — 패킷에는 그중 대상 종목·키워드에 걸린 것만). */
  stored7d: number | null;
  /** 피드를 하나라도 받은 마지막 수집 시각("2026-10-25 15:00 KST"). */
  lastFetchKst: string | null;
  /** 그 수집에서 받은 피드 수(개). */
  feedsOk: number | null;
  /** 피드 전체 수(개, 지금 7). */
  feedsTotal: number | null;
  /** 그 수집에서 실패한 피드와 사유. */
  failedFeeds: PaperNewsFailedFeed[] | null;
}

export interface PaperNewsFailedFeed {
  /** 피드 키(예: "bls_cpi") — 설정 news.feeds의 값. */
  feed: string | null;
  source: string | null;
  reason: string | null;
}

/**
 * 발표·실적 일정 수집 범위(2단계 A) — 수집기 저장본(calendar.us_events)의 요약. 저장본이 없으면 available:false이고 나머지는 모두
 * null입니다(0으로 채우지 않음 — 화면 —).
 */
export interface PaperCalendarStatus {
  available: boolean;
  /** 수집 창(앞으로 45일)의 거시 일정 수(개수) — FOMC 상수 + FRED 발표일(CPI·PCE·고용·GDP). 패킷 창(10거래일)보다 넓습니다. */
  macroCount: number | null;
  /** 실적 일정을 받아 둔 종목 수(개수). */
  earningsCovered: number | null;
  /** 실적 일정 대상 — 모의 매매 유니버스에서 ETF를 뺀 종목 수(개수). */
  universe: number | null;
  /** 저장본을 마지막으로 쓴 수집 시각("2026-10-25 15:40 KST"). */
  generatedAtKst: string | null;
  /** FRED 발표일 부분의 상태 — "ok"·"키 미설정"·"실패". 키가 없어도 FOMC 상수는 macroCount에 들어갑니다. */
  fredStatus: string | null;
}

/**
 * 재무 수집 범위(D28) — 수집기 상태 저장본(us.fundamentals.status)의 요약. 저장본이 없으면 available:false이고 숫자는 모두
 * null입니다(0으로 채우지 않음 — 화면 —).
 */
export interface PaperFundamentalsStatus {
  available: boolean;
  /** 모의 매매 유니버스에서 ETF를 뺀 종목 수(개수). */
  universe: number | null;
  /** 그중 SEC CIK가 잡힌 종목 수(개수). */
  mapped: number | null;
  /**
   * 상태 줄에 최신 공시일이 있는 회사 수(개수) — companyfacts가 없거나 아직 받지 못한 회사는 빠집니다. 상태 줄 기준이라, 실패가
   * 3일 넘게 이어져 오류만 남은 회사는 저장된 관측 행이 있어도 빠집니다.
   */
  covered: number | null;
  /** 상태 저장본을 마지막으로 쓴 수집 시각("2026-10-25 12:10 KST"). */
  latestFetchKst: string | null;
  /**
   * 지금 이어받은 상태(isStale)인 회사 수(개수) — 실패해 이전 값을 이어받은 뒤 아직 다시 받지 못한 회사. 그 뒤 실행에서 예산·시간
   * 상한으로 시도하지 않은 회사도 들어가므로 이번 실행의 실패 수가 아닙니다.
   */
  staleCompanies: number | null;
  note: string;
}

/**
 * 추정 비용(명세 C8, 단계 3b) — 설정 단가(pricing.*)로 토큰을 곱한 **어림**이고 청구액이 아닙니다. 단가가 있는 모델(sonnet·haiku)이고
 * 토큰을 아는 호출만 셉니다 — estimatedCalls가 calls보다 작으면 나머지 호출(단가 도입 전·토큰 모름)은 추정에서 빠진 것입니다.
 * 추정한 호출이 없으면 estCostUsd가 null입니다(0으로 채우지 않음). 이 필드를 아직 보내지 않는 백엔드에서는 없습니다.
 */
export interface PaperApiUsageCost {
  estCostUsd?: number | null;
  estimatedCalls?: number | null;
  isEstimated?: boolean;
}

/** Claude 호출 사용량 — 하루(KST) 한 줄. 토큰은 응답이 알려 준 값의 합입니다. */
export interface PaperApiUsageDay extends PaperApiUsageCost {
  /** KST 날짜(YYYY-MM-DD). */
  day: string;
  /** 호출 수 — 성공·실패를 모두 셉니다(키가 없어 보내지 않은 호출은 빼고). */
  calls: number;
  /** 하루 호출 상한(설정 apiDailyCallCap). */
  cap: number;
  /** 정기 작업 몫 예약(설정 apiScheduledReserve, 기본 7 — 2단계 명세 §4-10). 예전 응답에는 없음. */
  scheduledReserve?: number | null;
  /**
   * 수동 호출 문턱 = max(0, cap − scheduledReserve)(기본 13) — 미리보기·시작·수동 결정·프레임 제안·수동 복기는 그날 호출이 이 값 미만일 때만,
   * 정기 작업은 cap까지. 예전 응답에는 없음.
   */
  manualLimit?: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Claude 호출 사용량 — 이달(KST) 누적. */
export interface PaperApiUsageMonth extends PaperApiUsageCost {
  /** KST 달(YYYY-MM). */
  month: string;
  /** 사용량이 남은 날 수. */
  days: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface PaperApiUsage {
  today: PaperApiUsageDay;
  month: PaperApiUsageMonth;
  note?: string;
}

/**
 * 보유 한 줄. 가격을 한 번도 받지 못했으면 lastPrice가 null이고 평가액은 백엔드가 평단으로 낸 값입니다.
 * 주당 가격(avgCost·lastPrice·highWatermark·stopPrice)은 소수 4자리로 옵니다 — 5bp 슬리피지가 싼 종목에서도 보이게.
 */
export interface PaperPosition {
  ticker: string;
  qty: number;
  avgCost: number | null;
  lastPrice: number | null;
  lastPriceAtKst: string | null;
  marketValue: number | null;
  weightPct: number | null;
  unrealizedPct: number | null;
  highWatermark: number | null;
  stopPrice: number | null;
  stopDistancePct: number | null;
  openedOn: string | null;
  holdingTradingDays: number | null;
  /** 보유 거래일을 셀 수 없는 사유('달력 없음 — …', 그 시장 달력이 그해 공휴일 목록을 모름). 보통 null. 화면 표시는 2단계 F2. */
  holdingTradingDaysReason?: string | null;
  priceStale: boolean;
  splitNote: string | null;
  /** 현금성 ETF(SHY 등) — 트레일링 스탑을 적용하지 않습니다. */
  cashLike: boolean;
  /** 사후 체결(출발일 종가)로 연 보유인가 — 보유를 연 시각이 그 종목의 사후 매수 체결 시각과 같으면 true. */
  backfilled: boolean;
  /**
   * 한국 계좌만 — 미처리 기업행위 보류 사유(화면 배지 '기업행위 확인 필요', 2단계 명세 §4-2 'C2c'). 보류가 없으면 null, 미국 행에는 칸이 없음.
   * 보류 중인 보유는 평가가 묶이고 스탑·주문이 보류됩니다.
   */
  corpActionHold?: string | null;
  /**
   * 한국 계좌만 — 그 보류로 묶인 평가의 출처(§9 F3): 평가 가격이 `date`(보유가 반영한 마지막 봉 날짜)의 금융위 확정 종가와 같으면
   * FSC_CONFIRMED, 다르거나 그날 행이 없으면 LAST_VALUATION, 가격을 받은 적 없으면 AVG_COST. 보류가 없으면 null.
   */
  heldValuation?: { source: "FSC_CONFIRMED" | "LAST_VALUATION" | "AVG_COST" | string; date: string | null } | null;
}

/** 재진입 금지(트레일링 스탑 뒤 N거래일). */
export interface PaperLockout {
  ticker: string;
  untilTradingDate: string;
  reason: string;
}

/** GET /api/paper/books/{code}/positions */
export interface PaperPositionsResponse {
  available: boolean;
  message?: string;
  book?: PaperBookSummary;
  positions?: PaperPosition[];
  lockouts?: PaperLockout[];
  cash?: number | null;
}

export type PaperOrderStatus = "PROPOSED" | "REJECTED" | "PENDING" | "FILLED" | "EXPIRED" | "CANCELLED";

/** 주문 한 줄. qty·targetWeightPct·sellFraction 중 하나로 크기를 정합니다(없으면 null). */
export interface PaperOrder {
  id: number;
  ticker: string;
  side: "BUY" | "SELL";
  qty: number | null;
  /**
   * 매수 크기 — 이름과 달리 목표 비중이 아니라 "체결 시점 순자산 대비 살 금액(%)"입니다(장부가 그렇게 읽음). 규칙 책은 이미 든
   * 종목이면 모자란 만큼(목표 − 현재), SHY면 늘릴 만큼을 넣고, 목표 비중은 근거 `reason.targetWeightPct`에 남깁니다.
   */
  targetWeightPct: number | null;
  sellFraction: number | null;
  /** 체결 시점 — 한국 책은 NEXT_OPEN(다음 KR 거래일 시가)뿐입니다(명세 §4-6). */
  timing: "NEXT_OBSERVATION" | "NEXT_CLOSE" | "IMMEDIATE" | "BACKFILL" | "NEXT_OPEN";
  source: "RULE" | "CLAUDE" | "STOP" | "BENCHMARK" | "INITIAL";
  status: PaperOrderStatus;
  rejectReason: string | null;
  /** 주문 근거(JSON 그대로 — 예: `{"cashLimited": true}`). */
  reason: unknown;
  asOfTradingDate: string | null;
  createdAtKst: string | null;
  expiresOn: string | null;
  filledAtKst: string | null;
}

/** GET /api/paper/books/{code}/orders */
export interface PaperOrdersResponse {
  available: boolean;
  message?: string;
  orders?: PaperOrder[];
}

/** 체결 한 줄. price는 슬리피지를 얹은 값, rawPrice는 관측치 그대로(둘 다 주당 가격이라 소수 4자리, gross는 2자리). */
export interface PaperFill {
  id: number;
  orderId: number;
  ticker: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number | null;
  rawPrice: number | null;
  slippageBp: number | null;
  gross: number | null;
  observedAtKst: string | null;
  observationDate: string | null;
  priceSource: string | null;
  /** 사후 체결(그날 종가로 나중에 기록). */
  backfill: boolean;
  /** 한국 계좌만 — 수수료(원, 소수 2자리). 한국 슬리피지는 체결가가 아니라 비용 칸입니다(`price` = 잠정 체결가 그대로). */
  fee?: number | null;
  /** 한국 계좌만 — 세금(증권거래세 + 농어촌특별세, 원). */
  tax?: number | null;
  /** 한국 계좌만 — 슬리피지 금액(원). */
  slippageCost?: number | null;
  /** 한국 계좌만 — 실효 비용 bp = (수수료 + 세금 + 슬리피지) ÷ (체결가 × 수량) × 10⁴(서버 계산, 소수 2자리). */
  costBp?: number | null;
  /** 한국 계좌만 — 금융위 확정 조정 행(없으면 null). */
  confirmation?: PaperFillConfirmation | null;
  /** 한국 계좌만 — 확정 상태(CONFIRMED 행 있음 · WAITING 금융위가 그날을 아직 안 냄 · UNCORRECTED 그날을 냈는데 행 없음). */
  confirmationState?: PaperFillConfirmationState | string | null;
  /** 한국 계좌만 — 확정 상태 문구('금융위 확정 미보정(ETF)'·'금융위 확정 못 함'·'금융위 {기준일}까지 냄 — 그날 값 기다림', 확정이면 null). */
  confirmationNote?: string | null;
}

export type PaperFillConfirmationState = "CONFIRMED" | "WAITING" | "UNCORRECTED";

/**
 * 한국 체결의 금융위 확정 조정 한 행(paper_fill_confirmations) — 체결 행은 그대로 두고 이 행으로 현금·평단을 맞춥니다(2단계 명세 §4-1·K29).
 * 비용 칸은 확정가로 다시 센 값, `cashDelta` = 확정 기준 현금 흐름 − 잠정 기준 현금 흐름(음수 가능).
 */
export interface PaperFillConfirmation {
  confirmedPrice: number | null;
  /** 확정가 − 잠정 체결가(원). */
  priceDiff: number | null;
  fee: number | null;
  tax: number | null;
  slippageCost: number | null;
  /** 확정가 기준 실효 비용 bp. */
  costBp: number | null;
  cashDelta: number | null;
  /** FSC(주식시세) · FSC_ETF(증권상품시세). */
  source: string | null;
  reconciledAtKst: string | null;
}

/** 한국 계좌의 확정 조정 합계 — 그 계좌 전체(목록 상한과 무관). 행이 없으면 cashDelta는 null(0과 구분). */
export interface PaperConfirmationTotal {
  rows: number;
  cashDelta: number | null;
  /** 아직 확정 조정 행이 없는 체결 수. */
  unconfirmed: number;
}

/** GET /api/paper/books/{code}/fills */
export interface PaperFillsResponse {
  available: boolean;
  message?: string;
  /** 한국 계좌만 — 확정 조정 합계(미국 응답에는 칸이 없음). */
  confirmationTotal?: PaperConfirmationTotal | null;
  fills?: PaperFill[];
}

/** 거래일 하나의 순자산 기록. pricesFinal이 false면 장 마감 확정 전 값. */
export interface PaperNavRow {
  tradingDate: string;
  nav: number | null;
  cash: number | null;
  equityValue: number | null;
  exposurePct: number | null;
  pricesFinal: boolean;
}

/** GET /api/paper/books/{code}/nav */
export interface PaperNavResponse {
  available: boolean;
  message?: string;
  book?: PaperBookSummary;
  series?: PaperNavRow[];
}

/**
 * POST /api/paper/init — 멱등. 이미 있는 책은 created에 들지 않습니다.
 * 출발일 종가가 아직 없으면 오류가 아니라 200 + `skipped`(사유)이고, 그 벤치마크는 시작 전으로 남습니다(개요 pendingBackfill).
 */
export interface PaperInitResult {
  ok: boolean;
  created: string[];
  backfilled: string[];
  skipped: { code: string; reason: string }[];
  /** 이번에 설정 행(paper_settings v1)을 새로 만들었는가. */
  settingsCreated: boolean;
  /** 이번에 새로 얼린 출발일 종가 종목 수(paper_start_prices — 이미 얼린 종목은 세지 않음). */
  startPricesCaptured: number;
}

/** POST /api/paper/books/{code}/status */
export interface PaperBookStatusResult {
  ok: boolean;
  book: PaperBookSummary;
  /** 일시정지하며 취소한 대기 주문 수. */
  cancelledOrders: number | null;
}

/** POST /api/paper/books/{code}/reset */
export interface PaperBookResetResult {
  ok: boolean;
  book: PaperBookSummary;
  /** 벤치마크 책을 출발일 종가로 다시 사후 체결했는가. 규칙·Claude 책은 늘 false(현금만 든 시작 전). */
  backfilled: boolean;
  /** 벤치마크를 다시 사후 체결하지 못한 사유(종가가 아직 없음 등). 체결했거나 규칙·Claude 책이면 null. */
  skippedReason: string | null;
}

/** 리스크 작업 한 번의 결과(PaperLedgerService.Outcome). */
export interface PaperRiskOutcome {
  filled: number;
  stopped: number;
  expired: number;
  splits: number;
  booksProcessed: string[];
  skippedReason: string | null;
  /** 책 코드를 앞에 붙인 처리 메모 — 현금 부족으로 줄인 매수, 취소한 주문, 분할 조정 등. */
  notes: string[];
  /** 오류로 되돌린 책(`"claude: IllegalStateException …"`). 하나라도 있으면 응답의 ok가 false입니다. */
  errors: string[];
}

/**
 * POST /api/paper/run/risk. 한 책이 오류로 되돌려져도 HTTP는 200이고 `ok:false`·`outcome.errors`로 알립니다 — 화면은
 * ok를 봐야 실패를 압니다. 테이블이 없으면 outcome 없이 `{available:false, message, ok:false}`입니다.
 */
export interface PaperRiskResult {
  ok: boolean;
  outcome?: PaperRiskOutcome | null;
  message?: string;
}

/**
 * POST /api/paper/run/risk?market=KR — 미국과 같은 `outcome`에 시장·쉬는 사유. 한국이 쉬면 예외가 아니라 `ok:false`·`dormantReason`과 그 사유로
 * 건너뛴 `outcome`입니다(docs/API.md '시장 단위 실행'). 금융위 확정 조정만 했으면 `outcome.confirmed`(행 수).
 */
export interface PaperKrRiskResult extends PaperRiskResult {
  market?: PaperMarketCode;
  dormantReason?: string | null;
}

/** POST /api/paper/init?market=KR — 한국 초기화(멱등). 출발일 없음·달력 없음·거래일 아님·출발 기한 지남은 400(서버 문구). */
export interface PaperKrInitResult {
  ok: boolean;
  market?: PaperMarketCode;
  startDate?: string | null;
  /** 이번에 만든 한국 계좌 코드(이미 있으면 빈 목록). */
  created?: string[];
  settingsCreated?: boolean;
  settingsVersion?: number | null;
  /** 설정 행에 없어 기본값으로 채운 kr.* 키(채운 키가 없으면 빈 목록 — 판을 올리지 않음). */
  settingsKeysWritten?: string[];
  message?: string;
}

/** 한국 출발 단추의 결과(STARTED·ALREADY_STARTED·START_POSTPONED·ERROR). 모르는 값은 받은 글자 그대로 보입니다. */
export type PaperKrStartOutcome = "STARTED" | "ALREADY_STARTED" | "START_POSTPONED" | "ERROR";

/**
 * POST /api/paper/run/initial-decision?market=KR(본문 없음) — 정기 출발을 같은 창·같은 게이트·같은 네 계좌 몫으로 앞당김. 창 밖·게이트 미달·
 * 이미 미룬 세션은 400(서버 문구). `record`는 그 출발의 작업 기록 상세(JSON 그대로 — 화면은 아는 칸만 고름).
 */
export interface PaperKrStartResult {
  ok: boolean;
  market?: PaperMarketCode;
  outcome?: PaperKrStartOutcome | string | null;
  tradingDate?: string | null;
  message?: string | null;
  decisions?: PaperDecisionSummary[] | null;
  books?: PaperBookSummary[] | null;
  record?: unknown;
}

/** 트랙레코드 순위 기준(설정 `trackRecord.metric`, 명세 R10·D20). 기본 CAGR. */
export type PaperTrackRecordMetric = "CAGR" | "EXCESS_VS_SPY" | "SHARPE";

/**
 * 트랙레코드 구간 하나(TrackRecord13F.Period, 명세 R7) — 공시 F_i의 보유를 공시 다음 거래일(start) 종가에 사서
 * 다음 공시의 다음 거래일(end, 마지막 구간은 기준일) 종가까지 든 평가액 가중 수익률. 첫 구간의 start는 7년 창 시작으로 자릅니다.
 * 커버된 평가액이 0이면 returnPct가 null이고, 그 구간은 누적·통계와 periodsUsed에서 빠집니다.
 */
export interface PaperTrackRecordPeriod {
  filingDate: string;
  /** 그 공시가 보고한 분기 말일. */
  reportDate: string;
  start: string;
  end: string;
  returnPct: number | null;
  spyReturnPct: number | null;
  /**
   * 시작·끝 가격이 모두 있는 보유의 평가액 / 그 공시 총평가액(티커 없는 보유 포함) — **0~1 비율**(%가 아님).
   * 자격 기준 `criteria.minCoverage`(0.5)와 같은 단위입니다.
   */
  coverage: number;
  /** 시작·끝 가격이 다 있어 수익률에 들어간 티커 수. */
  coveredTickers: number;
  /** 그 공시의 보유 줄 수(티커 없는 줄 포함). */
  holdings: number;
}

/**
 * 후보 기관 하나의 트랙레코드(TrackRecord13F.Result + 후보 목록 정보). 수익률·통계는 `%`(×100) 값이고, 커버리지는 0~1 비율입니다.
 * 표본이 없으면 수치는 null — 0으로 채우지 않습니다. 자격이 없으면 rank가 null이고 ineligibleReason에 사유(여럿이면 "; ")가 옵니다.
 */
export interface PaperTrackRecordCandidate {
  cik: string;
  name: string;
  /** 가치·집중 · 성장·테크 · 매크로(후보 목록의 분류). */
  style: string | null;
  rank: number | null;
  eligible: boolean;
  ineligibleReason: string | null;
  /** 30분기 수집이 아직 끝나지 않음(complete=false) — 자격 없음, 사유 "수집 중(저장 분기 n/30)". */
  collecting?: boolean;
  cagrPct: number | null;
  cumReturnPct: number | null;
  spyCumReturnPct: number | null;
  /** 누적 − SPY 누적(%p). */
  excessVsSpyPct: number | null;
  volPct: number | null;
  /** 최대 낙폭 — 음수(%). */
  mddPct: number | null;
  sharpe: number | null;
  /** 창 안에서 수익률이 있는 구간 수(자격 기준 minPeriods와 비교). */
  periodsUsed: number | null;
  /** 창 안의 구간 수(수익률이 null인 구간 포함). */
  periodsTotal: number | null;
  coverageMin: number | null;
  coverageAvg: number | null;
  firstFilingDate: string | null;
  lastFilingDate: string | null;
  /** 저장본(sec.13f.{cik}.q30)에 든 분기 수. */
  storedQuarters: number | null;
  complete: boolean;
  /** 그 기준일의 선정(paper_selection_log)에 든 기관인가(그룹 B 표에서는 그룹 B 선정). */
  selected: boolean;
  periods: PaperTrackRecordPeriod[];
  /**
   * 그룹 B만 — 계산에 쓴 저장본. `q30` = 후보 수집 저장본(sec.13f.{cik}.q30, CUSIP 매핑 티커)이 있으면 그것,
   * 없으면 `q8` = 기존 13F 메뉴 저장본(이름 매핑 티커). 그룹 A 후보에는 없습니다.
   */
  source?: "q30" | "q8" | string | null;
  /** 그룹 B만 — 기존 13F 메뉴의 기관 설명(예: "가치투자 포트폴리오, 핵심 우량주 집중"). */
  desc?: string | null;
}

/**
 * 그룹 B(D27) — 기존 13F 메뉴 12곳을 그룹 A와 같은 방법으로 최근 2년 창에서 잰 트랙레코드.
 * 자격 기준의 커버리지는 그룹 A와 같고 창·구간 수만 다릅니다(blend.groupB.windowYears·minPeriods).
 */
export interface PaperTrackRecordGroupB {
  /** 그 기준일에 그룹 B를 계산했는가. false면 candidates가 비어 있고 기준(windowYears 등)은 지금 설정입니다. */
  computed?: boolean;
  /** 선정 수(설정 blend.groupB.topN). */
  topN?: number | null;
  windowYears: number | null;
  minPeriods: number | null;
  metric?: PaperTrackRecordMetric | string | null;
  /** 서버가 그룹 B 기준을 통째로 보내면 그것. 없으면 화면은 windowYears·minPeriods + 그룹 A의 커버리지 기준으로 적습니다. */
  criteria?: PaperTrackRecordCriteria | null;
  candidates: PaperTrackRecordCandidate[];
  /** 그 기준일에 유효한 선정의 그룹 B CIK(그룹 B 순위 순). */
  selected: string[];
}

/**
 * 신호 풀 기관 하나(선정 행의 ranking.pool) — 그룹 A ∪ B. rankA·rankB는 그 그룹 안의 순위(그 그룹에 없으면 null),
 * weight는 기관 가중(0~1 비율, 풀 합 1): w = g·a(rankA) + (1−g)·b(rankB), g = groupWeightA(설계 §4-1).
 */
export interface PaperSignalPoolEntry {
  cik: string;
  name: string | null;
  groups: (PaperFilerGroup | string)[];
  rankA: number | null;
  rankB: number | null;
  weight: number | null;
}

/** 자격 기준(TrackRecord13F.Criteria, 명세 R9·D22). 커버리지는 0~1 비율. */
export interface PaperTrackRecordCriteria {
  windowYears: number;
  minPeriods: number;
  minCoverage: number;
  avgCoverage: number;
}

/** 선정 한 번(paper_selection_log). 선정은 재선정일·초기 선정 때 한 번 남고, 수동 재계산은 바꾸지 않습니다. */
export interface PaperSelectionHistoryEntry {
  asOfDate: string;
  /** 섞은 뒤(D27) 선정이면 신호 풀(A 순서 뒤에 B에만 있는 기관), 그 전이면 선정 기관. */
  selectedCiks: string[];
  /** 그룹별 선정(섞기 전 선정은 groupA만, groupB는 빈 목록). 보내지 않는 백엔드도 있습니다. */
  groupA?: string[];
  groupB?: string[];
}

/**
 * 13F 트랙레코드 수집 진행률(수집기 저장본 sec.13f.track_record_index). 개수는 모두 정수.
 * - filers: 후보 기관 수 · completeCount: 30분기를 다 받은(또는 EDGAR에 더 오래된 공시가 없는) 기관 수
 * - storedFilings / targetFilings: 저장된 공시 수 / 목표(기관 수 × 30)
 */
export interface PaperTrackRecordCollection {
  filers: number;
  completeCount: number;
  storedFilings: number;
  targetFilings: number;
  /** 기관마다의 목표 분기 수(30). 아직 보내지 않는 백엔드에서는 없습니다 — 화면은 targetFilings ÷ filers로 대신합니다. */
  targetQuarters?: number | null;
  updatedAtKst: string | null;
}

/**
 * GET /api/paper/track-record?asOf= (asOf가 없으면 가장 최근 계산).
 * 계산이 아직 없으면 `computed:false`와 수집 진행률(collection)만 옵니다 — 그때 candidates는 없거나 비어 있습니다.
 */
export interface PaperTrackRecordResponse {
  available: boolean;
  message?: string;
  computed?: boolean;
  asOfDate?: string | null;
  windowYears?: number | null;
  metric?: PaperTrackRecordMetric | null;
  criteria?: PaperTrackRecordCriteria | null;
  candidates?: PaperTrackRecordCandidate[];
  /** 그 기준일에 유효한 선정의 CIK(순서는 선정 순위). */
  selected?: string[];
  selectionHistory?: PaperSelectionHistoryEntry[];
  collection?: PaperTrackRecordCollection | null;
  /** 트랙레코드의 한계 — 복제 수익률·생존 편향·커버리지 문구(순서대로). */
  limits?: string[];
  /** 위 선정(selected)의 기준일. */
  selectedAsOfDate?: string | null;
  /** 그룹 B(D27). 이 필드를 아직 보내지 않는 백엔드에서는 없습니다 — 화면은 그룹 B 표를 그리지 않습니다. */
  groupB?: PaperTrackRecordGroupB | null;
  /** 그 기준일에 유효한 선정의 신호 풀(풀 순서). 선정이 없으면 빈 목록, 섞기 전 선정이면 그룹 A만(그룹 A 순위 가중)입니다. */
  pool?: PaperSignalPoolEntry[];
  /** 기관 가중의 그룹 A 몫 g(0~1, 설정 blend.groupWeightA). 보내지 않으면 화면은 숫자 없이 g로 적습니다. */
  groupWeightA?: number | null;
}

/**
 * POST /api/paper/run/rerank — 수동 재계산. 같은 기준일의 트랙레코드를 덮어쓰고 **선정은 바꾸지 않습니다**(selectedUnchanged).
 * computed는 계산한 후보 수(정수) 또는 계산했는지(참·거짓)입니다 — 계약에 둘 중 무엇인지 적혀 있지 않아 화면은 둘 다 받습니다.
 * 테이블이 없으면 `{available:false, message, ok:false}`입니다.
 */
export interface PaperRerankResult {
  ok: boolean;
  asOfDate?: string | null;
  computed?: number | boolean | null;
  /** 자격 있는 기관 수. */
  eligible?: number | null;
  /** 30분기 수집이 끝나지 않아 자격에서 뺀 기관 수. */
  collecting?: number | null;
  selectedUnchanged?: boolean;
  /** 계산하지 못한 이유(후보 목록 저장본 없음·설정 후보가 수집 목록과 겹치지 않음 등). 계산했으면 null. */
  skippedReason?: string | null;
  message?: string;
}

// ---------------------------------------------------------------- 결정 기록(paper_decisions)

/** 결정 종류 — 정기(거래일마다) · 수동(버튼) · 재선정일(분기 13F 공시 기한 다음 거래일) · 초기 결정(출발일). */
export type PaperDecisionKind = "SCHEDULED" | "MANUAL" | "REBALANCE" | "INITIAL";

/**
 * 결정 상태. 규칙 책은 OK(주문 있음)·NO_TRADE(주문 없음)·SKIPPED(일시정지 중이라 주문을 내지 않음)를 씁니다. 나머지는
 * Claude 책(단계 3a)의 실패 종류입니다.
 */
export type PaperDecisionStatus = "OK" | "NO_TRADE" | "REFUSED" | "FORMAT_ERROR" | "API_ERROR" | "SKIPPED";

/**
 * 결정 한 건의 요약(목록 한 줄). model·frameworkVersion·targetExposurePct는 Claude 책만 채우고 규칙 책은 null입니다.
 * frameworkVersion은 그 결정에 쓴 프레임 판 번호입니다(임시 판 v0 포함 — 단계 3b 전 기록은 null).
 * orderCount·rejectedCount는 그 결정이 낸 주문 수·검증에서 거절된 수(개수).
 */
export interface PaperDecisionSummary {
  id: number;
  book: string;
  asOfTradingDate: string;
  kind: PaperDecisionKind | string;
  status: PaperDecisionStatus | string;
  decidedAtKst: string | null;
  model: string | null;
  frameworkVersion: number | null;
  settingsVersion: number | null;
  /** 그 결정이 신호에 쓴 기관 선정의 기준일. 선정이 없었으면 null. */
  selectionAsOf: string | null;
  targetExposurePct: number | null;
  summary: string | null;
  orderCount: number | null;
  rejectedCount: number | null;
  /** 확정 종가로 낸 결정인가. false면 마감 확정 전 값(결정 마감 시각까지 확정 종가가 오지 않음·수동 실행). */
  pricesFinal: boolean | null;
  error: string | null;
}

/** GET /api/paper/decisions?book=&limit= — 최근 순. */
export interface PaperDecisionsResponse {
  available: boolean;
  message?: string;
  decisions?: PaperDecisionSummary[];
}

/** 결정 한 건의 전체 기록 — 요약 + 입력 패킷·응답·사용량. 규칙 책은 packet·usage가 null이고 response가 규칙 책 기록입니다. */
export interface PaperDecisionDetail extends PaperDecisionSummary {
  packet: unknown;
  packetHash: string | null;
  /** 규칙 책은 PaperRuleDecisionRecord 모양, Claude 책은 PaperClaudeDecisionRecord 모양(검증한 모델 응답 + 검증 결과). JSON 그대로입니다. */
  response: unknown;
  /** Claude 책의 토큰 사용량(PaperClaudeUsage 모양). 규칙 책은 null. */
  usage: unknown;
  noteIds: number[] | null;
  latencyMs: number | null;
  retryCount: number | null;
  /**
   * 목표 노출과 주문 반영 뒤 예상 주식 비중이 15%p 넘게 어긋났는가(Claude 책, 설계 §5-3). 결정 표에 열이 없어 서버가 이 필드나
   * response.exposureMismatch 중 하나로 보냅니다 — 화면은 둘 다 읽습니다.
   */
  exposureMismatch?: boolean | null;
  /** 모델이 보낸 원문(response_raw). 형식 오류일 때 무엇이 왔는지 보려고 씁니다. 보내지 않는 백엔드도 있습니다. */
  responseRaw?: string | null;
}

// ---------------------------------------------------------------- Claude 재량 책(단계 3a)

/** 판단 자세(decision.schema.json stance). */
export type PaperClaudeStance = "RISK_ON" | "RISK_OFF" | "NEUTRAL" | "UNCERTAIN";

/** 주장마다 붙이는 라벨(decision.schema.json orders[].labels). */
export type PaperClaudeLabel = "사실" | "해석" | "가설" | "확인 필요" | "결정";

/**
 * 모델이 제안한 주문 하나(decision.schema.json orders[]). BUY는 targetWeightPct(목표 비중 %), SELL은 sellFraction(0~1, null이면 전량).
 * 제안 그대로라 검증기가 거절한 주문도 여기 있습니다 — 통과·거절은 검증 결과(validation)에 있습니다.
 */
export interface PaperClaudeOrder {
  ticker: string;
  side: "BUY" | "SELL" | string;
  targetWeightPct?: number | null;
  sellFraction?: number | null;
  timing: "NEXT_OBSERVATION" | "NEXT_CLOSE" | string;
  thesis: string;
  labels: (PaperClaudeLabel | string)[];
  invalidation: string;
}

/**
 * 검증기(OrderValidator, 설계 §5-4)의 거절 사유. 현금 비중·매크로 조건은 사유가 아닙니다(명세 D7) — 노출 0%·100%도 통과합니다.
 */
export type PaperRejectReason =
  | "OUT_OF_UNIVERSE" | "DUPLICATE_TICKER" | "MALFORMED" | "NOT_HELD" | "BELOW_ONE_SHARE" | "LOCKED_OUT" | "WEIGHT_CAP"
  | "MAX_POSITIONS" | "OVER_ALLOCATED" | "MIN_NOTIONAL" | "MONTHLY_CAP" | "MIN_HOLD" | "STALE_INPUT" | "NO_PRICE";

/**
 * 검증 결과 한 줄(OrderValidator.Verdict). 자바 record를 그대로 직렬화하면 주문이 `order` 안에 들고, 펼쳐 보내면 같은 줄에
 * ticker·side…가 옵니다 — 화면은 두 모양을 다 읽습니다.
 */
export interface PaperValidationVerdict {
  order?: {
    ticker: string;
    side: string;
    targetWeightPct: number | null;
    sellFraction: number | null;
    timing: string | null;
  } | null;
  ticker?: string;
  side?: string;
  targetWeightPct?: number | null;
  sellFraction?: number | null;
  timing?: string | null;
  accepted: boolean;
  rejectReason: PaperRejectReason | string | null;
  /** 거절의 구체 내용(서버 문구, 예: "목표 12% > 종목 상한 10%"). 통과면 null. */
  detail: string | null;
}

/** Claude 호출 한 번의 토큰 사용량(AiService.StructuredResult). 모르는 값은 null. */
export interface PaperClaudeUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  latencyMs?: number | null;
  stopReason?: string | null;
}

/** 관찰 목록 한 줄(decision.schema.json watchlist[]). */
export interface PaperClaudeWatch {
  ticker: string;
  condition: string;
}

/**
 * Claude 책 결정 기록(paper_decisions.response) — 스키마로 검사한 모델 응답(decision.schema.json) + 검증 결과.
 * targetEquityExposurePct는 기록·표시용이고 집행은 주문 기준입니다(어긋나면 exposureMismatch, 숫자를 맞추지 않음).
 */
export interface PaperClaudeDecisionRecord {
  schemaVersion?: number;
  stance?: PaperClaudeStance | string;
  targetEquityExposurePct?: number | null;
  exposureRationale?: string | null;
  summary?: string | null;
  orders?: PaperClaudeOrder[];
  noTradeReason?: string | null;
  watchlist?: PaperClaudeWatch[];
  /** 0~1 비율. */
  confidence?: number | null;
  validation?: PaperValidationVerdict[];
  exposureMismatch?: boolean | null;
  /**
   * 그 결정에 쓴 프레임 판(단계 3b) — `{version, status, title}`. 단계 3a 기록은 `{version:null, interim:true, label}` 모양입니다
   * (판 번호를 두기 전 임시 시스템 프롬프트) — 화면은 두 모양을 다 읽습니다.
   */
  framework?: PaperDecisionFramework | null;
}

/** 결정 기록의 프레임 판 표시(response.framework). */
export interface PaperDecisionFramework {
  version: number | null;
  status?: PaperFrameworkStatus | string | null;
  title?: string | null;
  /** 단계 3a 기록만. */
  interim?: boolean | null;
  label?: string | null;
}

/**
 * POST /api/paper/run/initial-decision `{book:"claude", preview:true}` — 초기 결정 미리보기. 호출·검증까지 하고 장부·결정·주문 표에
 * 쓰지 않습니다(남기는 것: 사용량, 없을 때만 출발일 기관 선정·제안 종목의 출발일 종가 — 시작이 같은 값을 씀). 응답 형식 오류·거절·
 * API 오류면 response가 null이고 error·status에 사유가 옵니다.
 */
export interface PaperClaudePreviewResult {
  ok: boolean;
  preview?: boolean;
  packet?: unknown;
  /** 모델 응답(PaperClaudeDecisionRecord 모양, JSON 그대로). */
  response?: unknown;
  validation?: PaperValidationVerdict[] | null;
  usage?: PaperClaudeUsage | null;
  model?: string | null;
  /** 실패 종류(FORMAT_ERROR · REFUSED · API_ERROR · SKIPPED). 성공이면 없거나 null. */
  status?: PaperDecisionStatus | string | null;
  error?: string | null;
  message?: string;
}

/** GET /api/paper/decisions/{id} — orders는 그 결정이 낸 주문 행(보유·체결 탭의 주문 표와 같은 모양). */
export interface PaperDecisionDetailResponse {
  available: boolean;
  message?: string;
  decision?: PaperDecisionDetail | null;
  orders?: PaperOrder[];
}

/** 선정 순위표 한 줄(paper_selection_log.ranking, 상위 10). */
export interface PaperSelectionRankingEntry {
  cik: string;
  name: string | null;
  rank: number | null;
  /** 순위 기준(CAGR · EXCESS_VS_SPY · SHARPE). */
  metric?: string | null;
  cagrPct: number | null;
  excessVsSpyPct: number | null;
  sharpe: number | null;
  selected: boolean;
}

/**
 * 13F 신호 이벤트 하나(Signal13F.Event) — 신호 기관 한 곳의 최신 분기 vs 직전 분기.
 * action: NEW(신규 편입) · ADDED(주식 수 확대, 기준 이상) · CLOSED(전량 매도). weightPct는 그 기관 13F 총액 대비 %.
 * rank는 그룹 섞기(D27) 전 기록의 선정 순위, rankA·rankB는 섞은 뒤 기록의 그룹 순위입니다(없으면 화면이 신호 풀에서 찾음).
 */
export interface PaperSignalEvent {
  cik: string;
  rank?: number | null;
  rankA?: number | null;
  rankB?: number | null;
  ticker: string;
  action: "NEW" | "ADDED" | "CLOSED" | string;
  /**
   * 주식 수 변화(%). ADDED는 (현재−직전)/직전 × 100(두 분기 사이 주식 분할은 직전 주식 수를 분할 뒤 기준으로 맞춘 값),
   * CLOSED는 −100(보유가 0이 됨), NEW는 null(분모 없음).
   */
  sharesChangePct: number | null;
  weightPct: number | null;
  previousWeightPct: number | null;
}

/**
 * 후보 점수에 기관 한 곳이 보탠 몫(Signal13F.Contribution, D27). 점수 기여 points = filerWeight × conviction.
 * filerWeight(기관 가중)·conviction(확신도 = min(그 종목의 기관 내 비중, 상한) ÷ 상한)은 둘 다 **0~1 비율**입니다.
 * name·groups·action·weightPct는 서버가 붙여 보내면 있고, 없으면 화면이 같은 기록의 신호 풀에서 이름·그룹을 찾습니다.
 */
export interface PaperSignalContribution {
  cik: string;
  name?: string | null;
  groups?: (PaperFilerGroup | string)[] | null;
  filerWeight: number | null;
  conviction: number | null;
  points: number | null;
  action?: string | null;
  weightPct?: number | null;
}

/**
 * 매수 후보 하나(Signal13F.Candidate) — 정렬은 서버가 이미 했습니다. 그룹 섞기(D27) 뒤 기록은 점수 ↓ · 매수 기관 수 ↓ · 티커 ↑이고
 * score(= Σ 점수 기여, 0~1)와 contributions가 있습니다. 그 전 기록은 기관 수 ↓ · 순위 합 ↑ · 합산 비중 ↓이고 rankSum이 있습니다.
 */
export interface PaperSignalCandidate {
  ticker: string;
  buyerCiks: string[];
  rankSum?: number | null;
  score?: number | null;
  contributions?: PaperSignalContribution[];
  combinedWeightPct: number | null;
  events?: PaperSignalEvent[];
}

/** 배분 방식(설정 blend.allocation, D27) — 확신도 비례(기본) · 동일 비중. */
export type PaperAllocationMode = "CONVICTION" | "EQUAL";

/**
 * 규칙 책 결정 기록(paper_decisions.response). 게이트는 **참고**로만 남깁니다 — 규칙 책은 게이트를 읽지 않습니다(D19).
 * skipped는 고르지 못한 후보와 사유 `[{ticker, reason}]`입니다(docs/API.md). 화면은 자바 Map.Entry를 그대로 직렬화한
 * `{"티커": "사유"}` 모양도 읽습니다(방어 — 서버는 그 모양을 보내지 않음).
 *
 * selection은 그룹 섞기(D27) 뒤 기록이면 groupA·groupB·pool, 그 전 기록이면 ciks·ranking입니다 — 결정 기록은 바뀌지 않는 이력이라
 * 화면은 두 모양을 다 읽습니다. 배분 방식은 settings.allocation(서버가 그 결정에 쓴 설정값)에 있습니다.
 */
export interface PaperRuleDecisionRecord {
  gate?: PaperGateIndicator | null;
  selection?: {
    asOf: string | null;
    ciks?: string[];
    ranking?: PaperSelectionRankingEntry[];
    /** 섞은 뒤 기록 — 그룹마다 선정 때의 순위표 상위 10(줄마다 selected). 화면은 selected인 줄을 그 그룹의 선정으로 봅니다. */
    groupA?: (PaperSelectionRankingEntry | PaperSelectedFiler)[];
    groupB?: (PaperSelectionRankingEntry | PaperSelectedFiler)[];
    pool?: PaperSignalPoolEntry[];
    groupWeightA?: number | null;
    /** 그룹을 섞기 전에 남긴 선정으로 낸 결정인가(그때는 그룹 B가 없음). */
    legacy?: boolean;
    /** 신호를 대조한 기관마다의 줄(이름·그룹·그룹 순위·가중·출처·대조한 분기). */
    filers?: Record<string, unknown>[];
  } | null;
  signals?: {
    events: PaperSignalEvent[];
    candidates: PaperSignalCandidate[];
    /** 티커 → 그 티커를 전량 매도한 신호 기관 CIK. */
    closedBy: Record<string, string[]>;
  } | null;
  orders?: unknown[];
  skipped?: unknown[];
  notes?: string[];
  /** 그 결정에 쓴 설정값(minHolders·rulesMaxNames·maxWeightStockPct·allocation·convictionCapPct·minTargetPct 등). */
  settings?: Record<string, unknown> | null;
}

/** POST /api/paper/run/decision — 본문 `{book}`. 그 책만 종류 MANUAL로 한 번 결정합니다. */
export interface PaperRunDecisionResult {
  ok: boolean;
  decision?: PaperDecisionSummary | null;
  message?: string;
}

/**
 * POST /api/paper/run/initial-decision — 본문 `{book:"rules"}` 또는 `{book:"claude"}`. 규칙 책은 출발일 기준으로 선정·신호·배분해,
 * Claude 책은 출발일 기준 입력 패킷으로 Claude가 고르고 검증기가 통과시킨 주문을, 출발일 종가로 사후 체결하고 ACTIVE로 바꿉니다.
 * fills는 사후 체결 행 배열입니다(docs/API.md, 미리보기면 빈 배열). 화면은 건수(숫자)로 와도 읽습니다(방어).
 * 트랙레코드 수집이 끝나지 않았거나 이미 시작한 책이면 400(서버 문구)입니다.
 */
export interface PaperInitialDecisionResult {
  ok: boolean;
  decision?: PaperDecisionSummary | null;
  fills?: PaperFill[] | number | null;
  message?: string;
}

// ---------------------------------------------------------------- 설정(paper_settings, 명세 S1~S3)

/**
 * 설정 키 하나의 설명(GET /api/paper/settings keys[]). key는 설정 본문 안의 점 경로입니다(예: "trackRecord.windowYears",
 * "blend.groupB.topN") — 바꾼 키 목록(changedKeys)과 같은 이름입니다.
 */
export interface PaperSettingKey {
  key: string;
  /**
   * 값의 형(서버 표기 그대로 — number · integer · string · boolean · list · phrases(공백이 든 구절 목록 — 사건 뉴스 키워드) ·
   * date · dates · dateTimeMap · aliasMap(한국 키 — 2단계 C1b) 등).
   */
  type: string;
  /** 서버가 검사하는 범위(숫자 키). 없으면 null. */
  min: number | null;
  max: number | null;
  /** 규칙 책(동결된 대조군)에 영향을 주는 키 — 바꾸면 저장 전에 한 번 더 확인합니다(명세 S3). 그 키 시장(market)의 규칙 계좌. */
  affectsRules: boolean;
  /** 그 키를 읽는 책 — "US"·"KR", 두 책 공통이면 null(2단계 명세 §4-13). 예전 응답에는 없음. */
  market?: string | null;
  description: string | null;
  /** 고를 수 있는 값(모델·effort·순위 기준 등). 서버가 보내면 선택 상자, 아니면 글자 입력(서버가 다시 검사). */
  options?: string[] | null;
}

/** GET /api/paper/settings — 지금 설정 행. 행이 없으면(초기화 전) version이 null이고 body는 기본값입니다. */
export interface PaperSettingsResponse {
  available: boolean;
  message?: string;
  version?: number | null;
  body?: Record<string, unknown> | null;
  defaults?: Record<string, unknown> | null;
  keys?: PaperSettingKey[];
}

/**
 * POST /api/paper/settings — 본문은 바꿀 키만 담은 patch(`{"키": 값}`, 키는 keys[].key 그대로). 알려진 키·형·범위는 서버가 검사하고
 * 틀리면 400(서버 문구)입니다. 규칙 책 영향 키를 바꾸면 warning이 옵니다.
 */
export interface PaperSettingsSaveResult {
  ok?: boolean;
  version: number | null;
  changedKeys: string[];
  warning: string | null;
  message?: string;
}

/** 설정 변경 이력 한 줄(paper_settings_history). body는 그 버전의 설정 본문 전체(보내면). */
export interface PaperSettingsHistoryEntry {
  version: number;
  changedKeys: string[];
  createdAtKst: string | null;
  body?: Record<string, unknown> | null;
}

/** GET /api/paper/settings/history — 최근 버전 순. */
export interface PaperSettingsHistoryResponse {
  available: boolean;
  message?: string;
  history?: PaperSettingsHistoryEntry[];
}

// ---------------------------------------------------------------- 프레임(투자 OS)·메모(단계 3b, 명세 F1~F7·D14·D15)

/**
 * 판의 상태 — INTERIM은 사용자 OS 원문을 받기 전 명세·설계의 지침으로 만든 임시 판(v0), USER는 사용자가 만든 판(OS 원문을 옮긴 v1부터).
 * 제안을 승인해 만든 판은 기준 판의 상태를 이어받습니다(백엔드 계약).
 */
export type PaperFrameworkStatus = "INTERIM" | "USER";

/** 원칙 하나 — id는 "P1"처럼, 본문은 400자 이내(F4). */
export interface PaperFrameworkPrinciple {
  id: string;
  text: string;
}

/** 엔진의 규칙 하나 — id는 "E2-R1"처럼, 본문 400자 이내. addedIn은 그 규칙을 더한 판, sourceNoteId는 근거 메모(없으면 null). */
export interface PaperFrameworkRule {
  id: string;
  text: string;
  addedIn: number | null;
  sourceNoteId: number | null;
}

/** 엔진 하나(F1 — 판마다 8개, "E1"~"E8"). */
export interface PaperFrameworkEngine {
  id: string;
  name: string;
  rules: PaperFrameworkRule[];
}

/** 판 본문(paper_framework_versions.body, 계약 A). guidance는 엔진 밖 자유 지침(2,000자 이내). */
export interface PaperFrameworkBody {
  schemaVersion: number;
  title: string;
  status: PaperFrameworkStatus | string;
  principles: PaperFrameworkPrinciple[];
  engines: PaperFrameworkEngine[];
  guidance: string;
}

/**
 * 판 하나의 전체(지금 판·판 하나 읽기). rendered는 그 판을 만들 때의 렌더링(화면용 — 결정의 시스템 프롬프트는 결정 시점 설정으로
 * 다시 렌더링), tokensEst는 문자 수 기반 어림(한글 1자 ≈ 1토큰, ASCII 4자 ≈ 1토큰), overBudget은 그 어림이 설정
 * frameworkTokenBudget을 넘는지(서버 판정 — 막지는 않음, F4).
 */
export interface PaperFrameworkVersion {
  version: number;
  status: PaperFrameworkStatus | string;
  title: string | null;
  body: PaperFrameworkBody | null;
  rendered: string | null;
  tokensEst: number | null;
  overBudget: boolean | null;
  changelog: string | null;
  createdAtKst: string | null;
  /** 이 판을 만든 제안 번호(수동 편집·시드는 null). 계약의 current 모양에는 없어 보내는 백엔드에서만 있습니다. */
  sourceProposalId?: number | null;
  /** 예산(설정 frameworkTokenBudget). 판마다 오지 않으면 응답 맨 위의 tokenBudget, 그것도 없으면 설정 응답에서 읽습니다. */
  tokenBudget?: number | null;
}

/** 판 목록 한 줄. */
export interface PaperFrameworkVersionSummary {
  version: number;
  title: string | null;
  changelog: string | null;
  createdAtKst: string | null;
  sourceProposalId: number | null;
  /** 계약 밖 — 보내면 판 이름에 씁니다("임시 v0"). */
  status?: PaperFrameworkStatus | string | null;
  /** 계약 밖 — 그 판 렌더링의 토큰 어림. */
  tokensEst?: number | null;
}

/** GET /api/paper/framework — 지금 판과 판 목록. */
export interface PaperFrameworkResponse {
  available: boolean;
  message?: string;
  current?: PaperFrameworkVersion | null;
  versions?: PaperFrameworkVersionSummary[];
  /** 렌더링 예산(서버가 지금 설정에서 읽은 frameworkTokenBudget). 계약 밖 — 없으면 화면이 설정 응답에서 읽습니다. */
  tokenBudget?: number | null;
  /**
   * 모든 판에서 쓴 가장 큰 원칙·규칙 번호(엔진별) — 수동 편집의 새 번호를 이보다 크게 매깁니다(지운 id를 판을 건너 다시 쓰지 않게, FW-2).
   * 보내지 않는 백엔드면 기준 판의 id만으로 매깁니다.
   */
  maxIdNumbers?: PaperFrameworkMaxIds | null;
}

/** 모든 판에서 쓴 가장 큰 번호 — principles = P{n}의 n, rules = 엔진 id("E1"~"E8") → E{k}-R{m}의 m. */
export interface PaperFrameworkMaxIds {
  principles?: number | null;
  rules?: Record<string, number | null> | null;
}

/** GET /api/paper/framework/versions/{version} */
export interface PaperFrameworkVersionResponse {
  available: boolean;
  message?: string;
  version?: PaperFrameworkVersion | null;
}

/**
 * POST /api/paper/framework `{body, changelog, baseVersion}`(수동 편집, F3) → 새 판 번호. 형식이 틀리거나 기준 판(baseVersion — 편집을
 * 시작한 판)이 지금 판과 다르면 400(서버 문구). 렌더링이 예산을 넘으면 저장은 하고 warning을 붙입니다(F4 — 막지 않음).
 */
export interface PaperFrameworkSaveResult {
  ok: boolean;
  version?: number | null;
  tokensEst?: number | null;
  overBudget?: boolean | null;
  warning?: string | null;
  message?: string;
}

/** 제안 상태 — 대기(승인·거절 전) · 승인(새 판) · 거절 · 실패(호출·형식 오류 — 자동 반영 없음). */
export type PaperProposalStatus = "PENDING" | "APPROVED" | "REJECTED" | "FAILED";

/** OS 절차 B의 평가(proposal.schema.json assessment[].verdict). */
export type PaperProposalVerdict = "일치" | "보완" | "수정 필요" | "모순";

/** 제안 연산(proposal.schema.json operations[].op). */
export type PaperProposalOp =
  | "ADD_RULE" | "UPDATE_RULE" | "DELETE_RULE" | "ADD_PRINCIPLE" | "UPDATE_PRINCIPLE" | "DELETE_PRINCIPLE";

/** 글의 주장 하나와 지금 프레임의 대조. */
export interface PaperProposalAssessment {
  point: string;
  verdict: PaperProposalVerdict | string;
  reason: string;
}

/**
 * 연산 하나 — target은 ADD_RULE이면 엔진 id("E2"), 규칙 수정·삭제면 규칙 id("E2-R1"), 원칙 수정·삭제면 원칙 id("P3"), 원칙 추가는
 * 무시. text는 추가·수정의 새 본문(300자 이내), 삭제는 null.
 */
export interface PaperProposalOperation {
  op: PaperProposalOp | string;
  target: string;
  text: string | null;
  why: string;
}

/** 프레임 제안 한 건(paper_framework_proposals). 실패면 summary·operations가 없고 error에 사유가 있습니다. */
export interface PaperFrameworkProposal {
  id: number;
  status: PaperProposalStatus | string;
  noteId: number | null;
  model: string | null;
  summary: string | null;
  operations: PaperProposalOperation[] | null;
  assessment: PaperProposalAssessment[] | null;
  beforeAfter: string | null;
  error: string | null;
  createdAtKst: string | null;
  decidedAtKst: string | null;
  /** 승인해 만든 판(승인 전·거절·실패는 null). */
  resultVersion: number | null;
  /** 제안할 때 대조한 판. 승인할 때 지금 판과 다르면 서버가 400("다른 판이 먼저 승인됐습니다 — 다시 제안하세요"). */
  baseVersion: number | null;
  /** 그 호출의 토큰·추정 비용(계약 밖, JSON 그대로). */
  usage?: unknown;
  /** 주간 복기가 낸 제안이면 그 복기 주(YYYY-MM-DD), 아니면 null(2단계 D3). */
  reviewWeekEnding?: string | null;
}

/** GET /api/paper/framework/proposals — 최근 순. */
export interface PaperProposalsResponse {
  available: boolean;
  message?: string;
  proposals?: PaperFrameworkProposal[];
}

/**
 * POST /api/paper/framework/proposals `{noteId?, text?}` — Claude를 한 번 부릅니다(하루 상한 공유, F7). 호출·형식이 실패해도 FAILED 행이
 * 남고 `ok:false`와 그 행이 옵니다(사유는 proposal.error). 상한·다른 요청 진행 중·없는 메모는 400·429(서버 문구).
 */
export interface PaperProposeResult {
  ok: boolean;
  proposal?: PaperFrameworkProposal | null;
  message?: string;
}

/**
 * POST /api/paper/framework/proposals/{id}/approve → 새 판 번호. 대기 아닌 제안·기준 판 불일치·대상 없음은 400. 저장과 같이 새 판의
 * 렌더링 어림(tokensEst)과 예산 초과(overBudget·warning — 승인은 함, F4)도 옵니다.
 */
export interface PaperProposalApproveResult {
  ok: boolean;
  version?: number | null;
  tokensEst?: number | null;
  overBudget?: boolean | null;
  warning?: string | null;
  message?: string;
}

/** POST …/reject, DELETE /api/paper/notes/{id} — 성공 여부만. */
export interface PaperOkResult {
  ok: boolean;
  message?: string;
}

/** 메모 종류 — 시황 메모(기준일·만료일, 유효하면 결정 패킷에 자료로) · 방법론 메모(만료 없음, 프레임 제안에만). */
export type PaperNoteKind = "MARKET" | "INSIGHT";

/** 메모 한 건(paper_notes). active는 서버 판정 — 보관 아님이고 기준일·만료일 안이면(오늘 기준) 참. */
export interface PaperNote {
  id: number;
  kind: PaperNoteKind | string;
  asOfDate: string | null;
  expiresOn: string | null;
  title: string;
  body: string;
  archived: boolean;
  /** 패킷에 실리는가(서버 판정). 한국 메모는 KRX 달력이 지금의 해를 모르면 MARKET 메모가 null(가를 수 없음). */
  active: boolean | null;
  createdAtKst: string | null;
}

/** GET /api/paper/notes?includeExpired= */
export interface PaperNotesResponse {
  available: boolean;
  message?: string;
  /** 유효(active) 판정의 기준일(서버 — 계약 밖). */
  referenceDate?: string | null;
  /** 한국(`?market=KR`) — 시장·쉬는 사유, 달력이 지금의 해를 몰라 기준일을 셀 수 없을 때의 사유(그때 referenceDate는 null). */
  market?: PaperMarketCode;
  dormantReason?: string | null;
  referenceDateReason?: string | null;
  notes?: PaperNote[];
}

/** POST /api/paper/notes `{kind, asOfDate?, expiresOn?, title, body}` — 기준일·만료일을 비우면 서버가 기본값으로 채웁니다. */
export interface PaperNoteCreateResult {
  ok: boolean;
  /** 한국(본문 market:"KR") — 시장·쉬는 사유(쉬어도 메모는 받음). */
  market?: PaperMarketCode;
  dormantReason?: string | null;
  note?: PaperNote | null;
  message?: string;
}

// ------------------------------------------------------------------ 주간 복기(2단계 명세 §3 D1~D6)

/**
 * 복기 상태 — OK(형식 통과) · FORMAT_ERROR(형식 위반, 그 주는 끝) · API_ERROR(호출 실패, 같은 행에서 한 번 다시) · REFUSED(모델 거절, 끝) ·
 * SKIPPED(창 안에 복기할 결정이 없어 부르지 않음).
 */
export type PaperReviewStatus = "OK" | "FORMAT_ERROR" | "API_ERROR" | "REFUSED" | "SKIPPED";

/** 논거 판정(review.schema.json verdicts[].thesisHeld). */
export type PaperReviewThesisHeld = "유지" | "반증" | "판단불가";

/** 판정 수 — OK 행만(그 밖의 행은 서버가 null). */
export interface PaperReviewVerdictCounts {
  유지: number | null;
  반증: number | null;
  판단불가: number | null;
}

/** 복기 목록의 한 줄. */
export interface PaperReviewSummary {
  /** 복기 주 — 그 ISO 주의 마지막 미국 거래일(금요일, 휴장이면 목요일). */
  weekEnding: string;
  status: PaperReviewStatus | string;
  /** 입력에 넣은 주 수(4, 입력 어림이 25,000토큰을 넘으면 2). */
  windowWeeks: number | null;
  model: string | null;
  verdictCounts: PaperReviewVerdictCounts | null;
  proposalId: number | null;
  /** 연결된 프레임 제안의 지금 상태(PENDING·APPROVED·REJECTED·FAILED). */
  proposalStatus: PaperProposalStatus | string | null;
  createdAtKst: string | null;
  error: string | null;
  retryCount: number | null;
  /** API 오류이고 아직 다시 부르지 않음 — 다음 실행이 같은 행에서 한 번 더 부릅니다. */
  retryable: boolean | null;
  frameworkVersion: number | null;
}

/** GET /api/paper/reviews */
export interface PaperReviewsResponse {
  available: boolean;
  message?: string;
  reviews?: PaperReviewSummary[];
  /** 지금 마감이 끝난 가장 최근 복기 주 — 수동 실행이 도는 주. */
  latestWeekEnding?: string | null;
  /** 그 주 정기 복기가 열리는 시각(미국 토요일 09:00 KST, 한국 토요일 22:30 KST). */
  latestOpensAtKst?: string | null;
  /** 한국 응답만 — 최근 복기 주를 셀 수 없는 사유('달력 없음 — …', 그 실행 KRX 달력이 그 해를 모름). 보통 null. */
  latestWeekEndingReason?: string | null;
  /** 한국 응답만 — "KR". */
  market?: PaperMarketCode;
  /** 한국 응답만 — 한국 정기 작업이 쉬는 사유(돌면 null). */
  dormantReason?: string | null;
}

/** 판정 한 줄 — 날짜·종류·상태는 서버가 입력의 결정에서 찾아 붙인 값(없는 id면 null). */
export interface PaperReviewVerdict {
  decisionId: number | null;
  asOf: string | null;
  kind: string | null;
  status: string | null;
  thesisHeld: PaperReviewThesisHeld | string | null;
  note: string | null;
}

/** 복기가 낸 프레임 제안의 요약(승인·거절은 프레임 탭). */
export interface PaperReviewProposal {
  id: number;
  status: PaperProposalStatus | string;
  summary: string | null;
  operationsCount: number | null;
  baseVersion: number | null;
  resultVersion: number | null;
  error: string | null;
}

/** 복기 한 건(GET /api/paper/reviews/{weekEnding}의 review). */
export interface PaperReviewDetail extends Omit<PaperReviewSummary, "proposalId" | "proposalStatus"> {
  trimmedReason: string | null;
  verdicts: PaperReviewVerdict[];
  /** 입력에 있는데 판정이 없는 결정. */
  missingDecisionIds: number[];
  recurringErrors: string[];
  keep: string[];
  proposal: PaperReviewProposal | null;
  /** 코드가 만든 복기 입력(보낸 키 순서 그대로 — 계약 밖, JSON 그대로). */
  input?: unknown;
  /** 검사한 응답(형식 오류면 읽은 그대로, 읽지 못했으면 null). */
  response?: unknown;
  /** 토큰·추정 비용·지연·입력 어림(계약 밖, JSON 그대로). */
  usage?: unknown;
}

/** GET /api/paper/reviews/{weekEnding} */
export interface PaperReviewResponse {
  available: boolean;
  message?: string;
  review?: PaperReviewDetail | null;
}

/**
 * POST /api/paper/reviews/run — 가장 최근 복기 주를 지금 복기합니다(토요일 시각 조건만 빼고 정기 작업과 같음). 이미 있으면 그 행
 * (ALREADY_REVIEWED). 계좌·확정 종가·하루 상한 조건은 400, 다른 복기 진행 중은 429(서버 문구).
 */
export interface PaperRunReviewResult {
  ok: boolean;
  available?: boolean;
  outcome?: "REVIEWED" | "SKIPPED" | "ALREADY_REVIEWED" | string;
  review?: PaperReviewDetail | null;
  message?: string;
}
