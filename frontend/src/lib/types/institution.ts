/**
 * 백엔드 응답 계약 — 13F 기관·구루.
 *
 * 값이 없을 수 있는 필드는 전부 `| null`입니다. 프런트는 그 null을 그대로 "—"로 표시하고,
 * 절대 0으로 바꾸지 않습니다. 가져올 때는 `@/lib/types`(배럴)를 그대로 쓰면 됩니다.
 */
export interface Holding {
  name: string;
  cusip: string;
  class: string;
  value: number | null;
  shares: number | null;
  weight: number | null;
  weightDiff: number | null;
  sharesDiff: number | null;
  action: string;
}

export interface PortfolioResponse {
  available: boolean;
  message?: string;
  error?: string | null;
  cik: string;
  institution?: { name?: string; desc?: string };
  collectedAtKst?: string;
  ageSeconds?: number;
  quarters: { filingDate: string; reportDate: string; totalValue: number; holdingCount: number }[];
  latest?: { reportDate: string; filingDate: string; totalValue: number | null };
  holdings: Holding[];
  /**
   * 줄 하나 = 증권 하나(한 회사의 보통주 클래스만 합침 — 교집합과 같은 규칙), 값 = 그 분기 그 줄 항목들의 비중 합.
   * 키는 최신 분기의 공시 이름이고, 이름이 겹치는 줄에만 클래스 표기나 CUSIP이 붙습니다. 미보유 분기는 0, 들고 있는데 비중을 모르면 null
   */
  weightHistory?: { dates: string[]; series: Record<string, (number | null)[]> };
}

export interface ConsensusRow {
  /** 행의 고유 키(증권 또는 한 회사의 보통주 클래스들). 표시 이름은 겹칠 수 있어 화면은 이것으로 행을 구분합니다. */
  key: string;
  /** 가장 많은 기관이 쓴 공시 이름 */
  name: string;
  /** 대표 CUSIP */
  cusip: string;
  holders: string[];
  actions: string[];
  holderCount: number;
  /** 평가액·비중을 아는 기관만 더한 값. 하나도 모르면 null */
  totalValue: number | null;
  avgWeight: number | null;
  maxWeight: number | null;
  buyCount: number;
  sellCount: number;
}

export interface ConsensusResponse {
  available: boolean;
  participants: string[];
  participantCount: number;
  availableDates: string[];
  reportDate: string | null;
  minHolders: number;
  rows: ConsensusRow[];
}

/** 구루 스타일 프로파일. */
export interface GuruProfilesResponse {
  available: boolean;
  message?: string;
  note?: string;
  rows: GuruProfile[];
}

export interface GuruProfile {
  cik: string;
  key: string;
  name: string;
  desc: string;
  reportDate: string | null;
  totalValue: number | null;
  holdingCount: number;
  /** 1/HHI — 쏠림을 반영한 "실질" 종목 수. 종목 수만 세면 인덱스와 집중투자가 같아집니다. */
  effectiveHoldings: number | null;
  hhi: number;
  top10Weight: number;
  /** 직전 분기가 없으면 null (0이 아닙니다). */
  turnover: number | null;
  quarterCount: number;
}

/** 기관 간 유사도. */
export interface GuruSimilarityResponse {
  available: boolean;
  message?: string;
  note?: string;
  institutions: { cik: string; key: string; name: string; reportDate: string }[];
  /** 겹침 비중 (%) — 대각선은 100. */
  overlap: number[][];
  /** 코사인 유사도 (0~1) — 대각선은 1. */
  cosine: number[][];
  topPairs: { left: string; right: string; overlap: number; cosine: number }[];
}

/** 이 종목을 누가 들고 있나. */
export interface GuruHoldersResponse {
  available: boolean;
  message?: string;
  query: string;
  rows: {
    institution: string;
    cik: string;
    name: string;
    cusip: string;
    weight: number;
    value: number;
    reportDate: string;
  }[];
  /** 자르기 전 일치 건수. 백엔드는 비중 상위 200행까지만 rows에 담습니다(QA-133). 빈 검색어 응답에는 없습니다. */
  totalMatches?: number;
  /** rows가 일치 행 일부(비중 상위)뿐이면 true. */
  truncated?: boolean;
}

/** 구루 포트폴리오 위험. */
export interface GuruRiskResponse {
  available: boolean;
  message?: string;
  note?: string;
  cik: string;
  benchmark: string;
  years: number;
  institution?: Record<string, string>;
  reportDate?: string;
  collectedAtKst?: string;
  ageSeconds?: number;
  stale?: boolean;
  /** 13F에 티커가 없어 이름으로 가격을 찾습니다. 못 찾은 몫은 분석에서 빠집니다. */
  coverage?: {
    holdings: number;
    totalHoldings: number;
    weight: number;
    totalWeight: number;
    uncovered: { name: string; weight: number; reason?: string }[];
    uncoveredCount: number;
  };
  metrics?: {
    volatility: number | null;
    var95: number | null;
    var99: number | null;
    es95: number | null;
    es99: number | null;
    maxDrawdown: number | null;
    beta: number | null;
    trackingError: number | null;
    samples: number;
    from: string;
    to: string;
  };
  contributions?: GuruRiskContribution[];
  sectors?: { sector: string; weight: number }[];
}

export interface GuruRiskContribution {
  ticker: string;
  name: string;
  sector: string | null;
  weight: number;
  volatility: number | null;
  marginal: number | null;
  /** 기여의 합 = 포트폴리오 변동성. 개별 변동성을 그냥 더한 값이 아닙니다. */
  contribution: number | null;
  share: number | null;
}

// ------------------------------------------------ 13F 공통 신규 매수
export interface NewBuysResponse {
  available: boolean;
  participants: string[];
  participantCount: number;
  availableDates: string[];
  reportDate?: string | null;
  minHolders: number;
  note?: string;
  rows: {
    /** 행의 고유 키 — 교집합과 같은 규칙 */
    key: string;
    name: string;
    cusip?: string;
    buyers: string[];
    buyerCount: number;
    totalValue: number;
    avgWeight: number;
    reportDate: string;
  }[];
}
