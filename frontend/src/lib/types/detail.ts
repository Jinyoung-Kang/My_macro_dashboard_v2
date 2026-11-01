/**
 * 검색 상세 화면(종목 /s/<시장>/<코드>·지표 /markets/i/<id>·기관 /institutions/<CIK>)의 외부 정보 응답 — GET /api/detail/*, POST /api/detail/summary.
 * 수집기 실시간 조회를 그대로 전한 것이라 출처·받은 시각·출처별 오류가 함께 옵니다. 없는 값은 null(화면은 "—").
 */

export type DetailMarket = "us" | "kr";

/** 핵심 지표 한 칸 — 미국·해외는 숫자(value)와 단위, 국내는 네이버가 적은 글(text, 단위 포함). */
export type DetailStat = {
  key: string;
  label: string;
  value: number | null;
  text: string | null;
  /** money(통화 금액) · price(가격) · x(배수) · pct(이미 % 값) · count(개수) · text(글 그대로). */
  unit: "money" | "price" | "x" | "pct" | "count" | "text" | string;
};

export type DetailQuote = {
  market: DetailMarket;
  code: string;
  /** 차트(GET /api/macro/ticker)에 쓸 Yahoo 심볼 — 국내는 코스피 '.KS'·코스닥 '.KQ'. */
  yahooSymbol: string;
  name: string | null;
  exchange: string | null;
  currency: string | null;
  kind: string | null;
  price: number | null;
  previousClose: number | null;
  change: number | null;
  changePct: number | null;
  asOf: string | null;
  marketState: string | null;
  stats: DetailStat[];
  profile: {
    sector: string | null;
    industry: string | null;
    country: string | null;
    website: string | null;
    employees: number | null;
    summary: string | null;
  } | null;
  consensus: { targetMean: number | null; recommendation: string | null; analysts: number | null } | null;
  research: { title: string | null; broker: string | null; date: string | null; url: string }[];
  source: { label: string; url: string } | null;
  error: string | null;
  fetchedAt: string | null;
};

export type DetailQuoteResponse = { available: boolean; message?: string; quote?: DetailQuote };

export type DetailNewsItem = {
  title: string;
  url: string;
  publisher: string | null;
  publishedAt: string | null;
  /** Yahoo Finance · 네이버 증권 · Google News. */
  source: string;
};

export type DetailNewsResponse = {
  available: boolean;
  message?: string;
  news?: { items: DetailNewsItem[]; errors: Record<string, string>; error: string | null; fetchedAt: string | null };
};

export type DetailSymbol = {
  market: DetailMarket;
  code: string;
  yahooSymbol: string;
  name: string;
  exchange: string | null;
  kind: string | null;
  source: string;
};

export type DetailSymbolsResponse = {
  available: boolean;
  message?: string;
  symbols?: { items: DetailSymbol[]; errors?: Record<string, string>; error?: string | null };
};

export type DetailSummarySource = { n: number; label: string; url: string | null };

export type DetailSummaryResponse = {
  status: boolean;
  summary: string | null;
  model?: string | null;
  generatedAtKst?: string;
  cached?: boolean;
  sources?: DetailSummarySource[];
  quota?: { used: number; limit: number | null };
  error: string | null;
};
