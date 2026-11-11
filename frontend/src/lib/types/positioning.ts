/**
 * 백엔드 응답 계약 — COT·KRX 선물·수급 레이더·투자자별 매매.
 *
 * 값이 없을 수 있는 필드는 전부 `| null`입니다. 프런트는 그 null을 그대로 "—"로 표시하고,
 * 절대 0으로 바꾸지 않습니다. 가져올 때는 `@/lib/types`(배럴)를 그대로 쓰면 됩니다.
 */
export interface CotSummary {
  asset: string;
  available: boolean;
  category?: string;
  error?: string | null;
  date?: string;
  ncNet?: number | null;
  commNet?: number | null;
  nrNet?: number | null;
  change1w?: number | null;
  change4w?: number | null;
  change13w?: number | null;
  percentile?: number | null;
  ageDays?: number | null;
}

export interface CotAssetResponse {
  asset: string;
  available: boolean;
  message?: string;
  code?: string;
  category?: string;
  collectedAtKst?: string;
  ageSeconds?: number;
  rows: { date: string; ncNet: number; commNet: number; nrNet: number }[];
  summary?: CotSummary;
}

export interface KrxRow {
  date: string;
  futuresClose: number | null;
  changePct: number | null;
  changePctReported: number | null;
  volume: number | null;
  openInterest: number | null;
  oiChange: number | null;
  theoryPrice: number | null;
  marketBasis: number | null;
  contractName: string;
  marketPhase: string;
  cotOiIndex: number | null;
}

export interface KrxFuturesResponse {
  available: boolean;
  message?: string;
  isEstimated?: boolean;
  estimateNotice?: string;
  collectedAtKst?: string;
  ageSeconds?: number;
  stale?: boolean;
  rows: KrxRow[];
  latest?: {
    date?: string;
    futuresClose: number | null;
    changePct: number | null;
    changePctReported: number | null;
    volume: number | null;
    openInterest: number | null;
    oiChange: number | null;
    marketBasis: number | null;
    theoryPrice: number | null;
    contractName?: string;
    marketPhase?: string;
    cotOiIndex: number | null;
    basisState?: string;
    basisNote?: string;
    oiChange5dAvg: number | null;
  };
}

export interface InvestorTrendResponse {
  available: boolean;
  message?: string;
  collectedAtKst?: string;
  ageSeconds?: number;
  dataDate?: string | null;
  measure?: string;
  unit?: string;
  source?: string;
  rows: { investor: string; netToday: number; net5d: number; net20d: number; stance: string }[];
}

export interface RadarRow {
  rank: number;
  code: string;
  name: string;
  price: number | null;
  changePct: number | null;
  netAmountEok: number | null;
  source?: string;
  collectedAt?: string;
}

export interface RadarResponse {
  available: boolean;
  message?: string;
  /** 폴백 체인이 모두 실패했을 때, 소스별로 왜 못 줬는지. */
  reasons?: string[];
  warning?: string;
  market: string;
  investor: string;
  tradeType: string;
  /** 실제로 받은 기간. 요청과 다르면(기간 요청이 하루치로 바뀜) `requestedIntervalType`과 `warning`이 함께 옵니다. */
  intervalType: string;
  requestedIntervalType?: string;
  readMode: string;
  source?: string | null;
  sourceKind?: string | null;
  isHistorical?: boolean;
  historyDate?: string | null;
  /** 행의 기준일(YYYY-MM-DD) — 당일 조회가 앞 거래일 확정 순위로 대체되면 그 날짜. 출처가 밝히지 않으면 null. */
  dataDate?: string | null;
  collectedAtKst?: string;
  ageSeconds?: number;
  stale?: boolean;
  rows: RadarRow[];
}

/** 외국인·기관 공통 수급 (상위 N 목록의 교집합). */
export interface RadarConsensusResponse {
  available: boolean;
  message?: string;
  reasons?: string[];
  warning?: string;
  note?: string;
  market: string;
  tradeType: string;
  intervalType: string;
  topN: number;
  foreignCount?: number;
  institutionCount?: number;
  sources?: string[];
  collectedAtKst?: string;
  ageSeconds?: number;
  stale?: boolean;
  rows: RadarConsensusRow[];
}

export interface RadarConsensusRow {
  code: string;
  name: string;
  price: number | null;
  changePct: number | null;
  foreignEok: number | null;
  institutionEok: number | null;
  /** 한쪽 금액이 없으면 null입니다(0으로 채우지 않습니다). */
  totalEok: number | null;
  foreignRank: number | null;
  institutionRank: number | null;
}

// ----------------------------------------------- COT 극단값 백테스트
export interface CotExtremeSummary {
  count: number;
  mean: number | null;
  median: number | null;
  winRate: number | null;
  best: number | null;
  worst: number | null;
}

export interface CotExtremeSide {
  side: string;
  rule: string;
  h4: CotExtremeSummary;
  h13: CotExtremeSummary;
  baseline4: CotExtremeSummary;
  baseline13: CotExtremeSummary;
}

export interface CotExtremesResponse {
  available: boolean;
  message?: string;
  asset: string;
  percentile: number;
  lookbackWeeks?: number;
  priceProxy?: string | null;
  priceProxyLabel?: string | null;
  proxyNotice?: string;
  priceFrom?: string;
  priceTo?: string;
  sides?: CotExtremeSide[];
  recentEvents?: {
    date: string;
    side: string;
    net: number;
    percentile: number;
    return4w: number | null;
    return13w: number | null;
  }[];
}

// ---------------------------------------------------------------- 투자자별 매매 (토스증권 공식)
/** 최근 N개 기록의 순매수 합. 값이 있는 날만 더하며 days가 그 일수입니다(null은 "모름"). */
export interface FlowWindow {
  sum: number | null;
  days: number;
  window: number;
}

export interface FlowRow {
  key: string;
  label: string;
  latest: number | null;
  net5: FlowWindow;
  net20: FlowWindow;
  /** +n: n일째 순매수, −n: n일째 순매도, 0: 모름·0 (기관 세부에는 없음) */
  streak?: number;
}

export interface FlowSummary {
  records: number;
  latestDate?: string;
  latestUpdatedAt?: string;
  /** 최신 기록이 오늘 — 장 종료 전까지 바뀔 수 있는 잠정치 */
  provisional?: boolean;
  investors?: FlowRow[];
  breakdown?: FlowRow[];
  foreignerHolding?: { ratePct: number; date: string; changePp: number | null; fromDate: string | null };
  series?: { date: string; foreigner: number | null; institution: number | null; individual: number | null }[];
  /** (시장 수급만) 그 시장을 실제로 받은 시각. 저장본 수집 시각은 마지막으로 받은 시장의 것입니다 */
  fetchedAt?: string | null;
  /** (시장 수급만) 이번 수집에 실패해 직전 값을 이어받은 시장 — 값은 fetchedAt 때의 것(QA-076) */
  isStale?: boolean;
  staleReason?: string | null;
}

export interface MarketFlowsResponse {
  available: boolean;
  message?: string;
  unit?: string;
  source?: string;
  note?: string;
  markets?: Record<string, FlowSummary>;
  collectedAtKst?: string;
  ageSeconds?: number | null;
}

export interface StockFlowsResponse {
  available: boolean;
  message?: string;
  unit?: string;
  source?: string;
  note?: string;
  stocks: (FlowSummary & { code: string; available: boolean })[];
}

export interface SpotFuturesRow {
  key: string;
  label: string;
  spotToday: number | null;
  spot5: number | null;
  spot20: number | null;
  futuresToday: number | null;
  futures5: number | null;
  futures20: number | null;
  verdictToday: string;
  verdict5: string;
  verdict20: string;
}

export interface SpotFuturesResponse {
  available: boolean;
  message?: string;
  spotDate?: string | null;
  futuresDate?: string | null;
  sameDay?: boolean;
  rows?: SpotFuturesRow[];
  spotSource?: string;
  futuresSource?: string;
  collectedAtKst?: string;
  ageSeconds?: number | null;
  /** 코스피 현물을 실제로 받은 시각. 저장본 수집 시각(collectedAtKst)은 마지막으로 받은 시장의 것입니다 */
  spotFetchedAt?: string | null;
  /** 이번 수집에 실패해 직전 KOSPI 현물을 이어받음 — 값은 spotFetchedAt 때의 것(QA-116) */
  spotIsStale?: boolean;
  spotStaleReason?: string | null;
  spotStaleSince?: string | null;
}
