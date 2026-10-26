/**
 * 백엔드 응답 계약 — 거시·금리·유동성·섹터·환율.
 *
 * 값이 없을 수 있는 필드는 전부 `| null`입니다. 프런트는 그 null을 그대로 "—"로 표시하고,
 * 절대 0으로 바꾸지 않습니다. 가져올 때는 `@/lib/types`(배럴)를 그대로 쓰면 됩니다.
 */
export interface MacroItem {
  key: string;
  name: string;
  note?: string | null;
  /** 거래되는 시장 id — 개장/마감 판정용 (lib/marketSessions MARKETS의 키) */
  market?: string | null;
  ticker?: string | null;
  status: "ok" | "single" | "fail";
  price?: number | null;
  priceStr?: string | null;
  delta?: number | null;
  pct?: number | null;
  deltaStr?: string | null;
  prevStr?: string | null;
  prevValue?: number | null;
  prevSource?: string | null;
  lastTs?: string | null;
  source?: string | null;
  /**
   * 이 카드 출처의 시세 지연(분). 0이면 실시간, null이면 모름. 화면은 개장 상태와 한 배지로 합칩니다
   * ("개장 · 10분 지연" — 장이 닫혀 있으면 지연은 툴팁에만). 없는 응답(예전 저장본)은 note 배지를 그대로 씁니다.
   */
  delayMinutes?: number | null;
  /** 지연이 아닌 알림(선물 대신 지수 값·추정치·보정 실패) — 경고 배지로 따로 보입니다 */
  warning?: string | null;
  /** 비공식 참고 시세(TradingView) — 출처 줄에 '참고 시세'로 적습니다 */
  isReference?: boolean;
  /** 추정치인가(수집기 macro_cards — 지금은 TradingView 참고 시세 카드만 보냄). 참이면 화면은 '추정' 배지를 반드시 보입니다 */
  isEstimated?: boolean;
  /** 이번 수집이 실패해 직전 저장본의 값·시각을 그대로 이어받은 카드 (note가 "⚠️ 이전 값") */
  isStale?: boolean;
  staleReason?: string | null;
}

export interface MacroCategory {
  id: string;
  title: string;
  note?: string | null;
  items: MacroItem[];
}

export interface SpreadBlock {
  longId: string;
  shortId: string;
  points: { date: string; value: number }[];
  latest: number | null;
  previous: number | null;
  /** 같은 쌍을 스크래핑 시세로 계산한 "지금" 값. 공식 확정치와 함께 보여 줍니다. */
  scraped?: ScrapedSpread;
}

export interface MacroOverview {
  available: boolean;
  readMode: string;
  message?: string;
  collectedAtKst?: string;
  ageSeconds?: number;
  stale?: boolean;
  categories: MacroCategory[];
  rates?: Record<string, { current: number | null; previous: number | null }>;
  spreads?: {
    realtime: ScrapedSpread;
    official10y2y: SpreadBlock;
    official30y2y: SpreadBlock;
  };
}

/** 스크래핑 수익률로 계산한 "지금" 스프레드 (공식 확정치와 성격이 다릅니다). */
export interface ScrapedSpread {
  /** 만기 키(us02y·us10y·us30y). 값 자체는 longValue/shortValue에만 있습니다. */
  longKey?: string;
  shortKey?: string;
  longValue: number | null;
  shortValue: number | null;
  spread: number | null;
  previousSpread: number | null;
  delta: number | null;
  /** 수집 실패로 이어받은 이전 금리가 섞였으면 true — '지금 시장' 값이 아닙니다. */
  isStale?: boolean;
}

export interface RiskEntry {
  available: boolean;
  label?: string;
  unit?: string;
  value?: number | null;
  previous?: number | null;
  delta?: number | null;
  pct?: number | null;
  asOf?: string | null;
  percentile?: number | null;
  /** 백분위 표본의 첫 날짜·개수·기간(년). 지표마다 다릅니다(IG·HY는 FRED 제한으로 3년). */
  percentileFrom?: string | null;
  percentileCount?: number | null;
  percentileYears?: number | null;
  isProxy?: boolean;
  sourceLabel?: string | null;
  points?: { date: string; value: number }[];
}

export interface RiskIndicators {
  vix: RiskEntry;
  move: RiskEntry;
  hyOas: RiskEntry;
  cpSpread: RiskEntry;
  stlfsi: RiskEntry;
}

export interface AdvancedEntry {
  id: string;
  label: string;
  unit: string;
  digits: number;
  group: string;
  why: string;
  source: string;
  available: boolean;
  value?: number | null;
  prev?: number | null;
  delta?: number | null;
  asOf?: string | null;
  percentile?: number | null;
  /** 백분위 표본의 첫 날짜·개수·기간(년). 지표마다 다릅니다(IG·HY는 FRED 제한으로 3년). */
  percentileFrom?: string | null;
  percentileCount?: number | null;
  percentileYears?: number | null;
  status?: string;
  color?: string;
  note?: string;
}

export interface AdvancedIndicators {
  order: string[];
  latest: Record<string, AdvancedEntry>;
  derived: { impliedNominal10y?: number; decomposition?: string };
}

export interface LiquidityRow {
  date: string;
  walcl: number;
  wtregen: number;
  rrpM: number;
  rrpB: number;
  netLiquidityM: number;
  netLiquidityT: number;
  walclT: number;
  wtregenB: number;
}

export interface LiquidityResponse {
  available: boolean;
  isEstimated?: boolean;
  message?: string;
  collectedAtKst?: string;
  ageSeconds?: number;
  stale?: boolean;
  rows: LiquidityRow[];
  latest?: {
    date?: string;
    netLiquidityT: number | null;
    previousT: number | null;
    deltaT: number | null;
    pct: number | null;
    walclT?: number | null;
    tgaB?: number | null;
    rrpB?: number | null;
  };
  momentum?: { change4w: number | null; change12w: number | null };
}

export interface SectorRow {
  ticker: string;
  name: string;
  kind: string;
  price: number | null;
  returns: Record<string, number | null>;
  alpha?: Record<string, number | null>;
  ranks?: Record<string, number>;
  /** 수집 실패로 직전 저장본에서 이어받은 행(수익률이 그만큼 멈춰 있음). */
  isStale?: boolean;
  staleReason?: string | null;
}

export interface SectorResponse {
  available: boolean;
  message?: string;
  period: string;
  periods: string[];
  collectedAtKst?: string;
  ageSeconds?: number;
  stale?: boolean;
  benchmark: string;
  benchmarkReturns: Record<string, number | null>;
  sectors: SectorRow[];
  assetClasses: SectorRow[];
}

/** 💱 환율·달러인덱스 비교 차트. */
export interface FxSeriesResponse {
  available: boolean;
  message?: string;
  period: string;
  /** index = 기준일 100 · raw = 원래 단위 */
  mode: "index" | "raw";
  /** 단위가 섞인 계열을 raw로 겹쳐 그리는 중인지. 화면이 경고를 띄웁니다. */
  mixedUnits?: boolean;
  selected?: string[];
  catalog: { id: string; label: string; unit: string | null; ticker: string | null }[];
  series: FxSeries[];
  collectedAtKst?: string;
  ageSeconds?: number;
  stale?: boolean;
}

export interface FxSeries {
  id: string;
  label: string;
  unit: string | null;
  ticker: string | null;
  available: boolean;
  latest: number | null;
  latestDate: string | null;
  /** 기준일은 계열마다 다를 수 있습니다(시장별 휴일이 다릅니다). */
  baseDate: string | null;
  baseValue: number | null;
  changePct: number | null;
  points: { date: string; value: number | null }[];
}

/** 💱 원/달러 (달러 금액을 원화로 병기할 때). */
export interface UsdKrwResponse {
  available: boolean;
  /** 값이 없으면 available=false이고 rate는 없습니다(기본 환율을 지어내지 않습니다). */
  rate?: number;
  name?: string;
  lastTs?: string | null;
  source?: string | null;
  collectedAtKst?: string;
  message?: string;
}
