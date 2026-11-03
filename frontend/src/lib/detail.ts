/**
 * 검색 상세 화면(종목 /s/<시장>/<코드>·지표 /markets/i/<id>·기관 /institutions/<CIK>)의 표시 규칙 — React를 모르는 순수 함수(ADR 0004).
 * 명세 docs/specs/2026-11-01-search-detail.md. 외부 정보는 GET /api/detail/*(수집기 실시간 조회), 차트는 GET /api/macro/ticker.
 *
 * 값이 없으면 "—"(0으로 채우지 않음). 외부 출처는 링크로 함께 적습니다(Yahoo Finance·Google Finance·Investing.com·네이버 증권·SEC EDGAR).
 */
import { EMPTY, formatKoreanScale, formatKst, formatNumber, withoutLeadingIcon } from "./format";
import type { LineRow } from "./lineChart";
import type { DetailMarket, DetailQuote, DetailStat } from "./types/detail";
import type { MacroCategory, MacroItem, MacroOverview } from "./types/macro";

/** 차트 기간 — 수집기 /live/ticker 기간 그대로(1mo·6mo·1y·5y). */
export const DETAIL_RANGES = [
  { key: "1mo", label: "1개월" },
  { key: "6mo", label: "6개월" },
  { key: "1y", label: "1년" },
  { key: "5y", label: "5년" },
] as const;
export type DetailRange = (typeof DETAIL_RANGES)[number]["key"];

const US_CODE = /^[A-Za-z0-9^=.-]{1,24}$/;
const KR_CODE = /^[0-9A-Z]{6}$/;

// ------------------------------------------------------------------ 주소

/** 종목 상세 주소 — 코드는 한 조각으로 인코딩('^GSPC', 'KRW=X'). */
export function stockHref(market: DetailMarket, code: string): string {
  return `/s/${market}/${encodeURIComponent(code)}`;
}

/** 지표 상세 주소 — 매크로 카드 키. */
export function indicatorHref(key: string): string {
  return `/markets/i/${encodeURIComponent(key)}`;
}

/** 기관 상세 주소 — 13F CIK. */
export function institutionHref(cik: string): string {
  return `/institutions/${encodeURIComponent(cik)}`;
}

/**
 * 종목 상세 주소 조각 → 시장·코드(백엔드와 같은 규칙: us = Yahoo 심볼 형식·대문자, kr = 6자리 대문자 영숫자). 틀리면 null(화면은 404).
 */
export function parseStockRoute(market: string, code: string): { market: DetailMarket; code: string } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(code).trim().toUpperCase();
  } catch {
    return null;
  }
  const m = market.trim().toLowerCase();
  if (m === "kr") return KR_CODE.test(decoded) ? { market: "kr", code: decoded } : null;
  if (m === "us") return US_CODE.test(decoded) ? { market: "us", code: decoded } : null;
  return null;
}

/** 기관 상세 주소 조각 → CIK(숫자 1~10자리). 틀리면 null(화면은 404). 앞의 0은 그대로 둡니다(13F 기관 목록의 CIK 글과 같게). */
export function parseCik(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw).trim();
  } catch {
    return null;
  }
  return /^\d{1,10}$/.test(decoded) ? decoded : null;
}

/** 지표 상세 주소 조각 → 매크로 카드 키(영문·숫자·_·- 40자 이내). 틀리면 null(화면은 404). */
export function parseIndicatorKey(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw).trim();
  } catch {
    return null;
  }
  return /^[A-Za-z0-9_-]{1,40}$/.test(decoded) ? decoded : null;
}

/** 차트에 쓸 Yahoo 심볼 — 시세 응답의 값, 아직 없으면 미국은 코드 그대로·국내는 코스피 '.KS'로 어림(시세가 오면 바로잡힘). */
export function chartSymbol(market: DetailMarket, code: string, quote: DetailQuote | null | undefined): string {
  if (quote?.yahooSymbol) return quote.yahooSymbol;
  return market === "kr" ? `${code}.KS` : code;
}

/** 시세 차트 행 — GET /api/macro/ticker 점(종가, 없으면 값)을 날짜(YYYY-MM-DD)별로. 값을 모르면 null(선이 끊김). */
export function chartRows(points: readonly { date: string; close?: number | null; value?: number | null }[] | null | undefined): LineRow[] {
  return (points ?? []).map((point) => {
    const value = point.close ?? point.value ?? null;
    return { date: point.date.slice(0, 10), close: value !== null && Number.isFinite(value) ? value : null };
  });
}

/** 차트 행의 값 키. */
export const CHART_KEY = "close";

// ------------------------------------------------------------------ 지표

/**
 * 차트를 그리지 않는 지표와 이유 — 카드 값과 Yahoo 티커의 뜻이 달라 같은 자리에 두면 틀리게 읽히는 것.
 * 미국채 2년물 카드는 TradingView 수익률(%)인데 티커 ZT=F는 2년물 선물 가격이라 차트로 쓰지 않습니다(indicators.py 주석).
 */
export const INDICATOR_NO_CHART: Readonly<Record<string, string>> = {
  us02y: "2년물 카드는 TradingView 수익률(%)이고 Yahoo 티커 ZT=F는 선물 가격이라 차트를 그리지 않습니다. 금리차 차트는 매크로 지표 화면에 있습니다.",
};

/** 매크로 개요 저장본에서 지표 하나와 그 범주 — 없으면 null. */
export function findIndicator(
  overview: Pick<MacroOverview, "categories"> | null | undefined,
  key: string,
): { item: MacroItem; category: MacroCategory } | null {
  for (const category of overview?.categories ?? []) {
    const item = category.items.find((entry) => entry.key === key);
    if (item) return { item, category };
  }
  return null;
}

/** 지표 차트 심볼 — 카드 티커(Yahoo 심볼), 차트를 그리지 않는 지표(INDICATOR_NO_CHART)·티커 없는 카드는 null. */
export function indicatorChartSymbol(item: Pick<MacroItem, "key" | "ticker">): string | null {
  if (INDICATOR_NO_CHART[item.key] !== undefined) return null;
  return item.ticker && US_CODE.test(item.ticker) ? item.ticker : null;
}

/** 지표 이름 → 외부 검색 이름 — 괄호 안 영문 약칭(“달러 인덱스 (DXY)” → “DXY”)이 있으면 그것, 없으면 뉴스 검색어와 같은 이름. */
export function indicatorSearchName(name: string): string {
  const inner = [...withoutLeadingIcon(name).matchAll(/\(([^)]*)\)/g)].map((match) => match[1].trim()).find((text) => /[A-Za-z]{2,}/.test(text));
  return inner ?? indicatorNewsQuery(name);
}

/** 기관 평가액 추이 — 13F 분기(보고 기준일 오름차순)별 총 평가액(달러). */
export function institutionValueRows(quarters: readonly { reportDate: string; totalValue: number | null }[] | null | undefined): LineRow[] {
  return [...(quarters ?? [])]
    .sort((a, b) => a.reportDate.localeCompare(b.reportDate))
    .map((quarter) => ({ date: quarter.reportDate.slice(0, 10), [CHART_KEY]: Number.isFinite(quarter.totalValue) ? quarter.totalValue : null }));
}

// ------------------------------------------------------------------ 값 글

/** 가격 단위 — 원화는 '원', 그 밖은 통화 코드(모르면 없음). */
export function currencyUnit(currency: string | null | undefined): string | undefined {
  if (!currency) return undefined;
  return currency === "KRW" ? "원" : currency;
}

/** 장 상태 — Yahoo marketState(REGULAR·CLOSED·PRE·POST)·네이버 marketStatus(OPEN·CLOSE)를 한국어로. 모르면 null. */
export function marketStateText(state: string | null | undefined): string | null {
  switch ((state ?? "").toUpperCase()) {
    case "REGULAR":
    case "OPEN":
      return "장중";
    case "CLOSED":
    case "CLOSE":
      return "장 마감";
    case "PRE":
    case "PREPRE":
      return "장 시작 전";
    case "POST":
    case "POSTPOST":
      return "시간 외 거래";
    default:
      return null;
  }
}

/** 종류 — Yahoo quoteType·네이버 종목 종류를 한국어로. 모르는 값은 그대로, 없으면 null. */
export function kindText(kind: string | null | undefined): string | null {
  if (!kind) return null;
  const names: Record<string, string> = {
    EQUITY: "주식",
    STOCK: "주식",
    ETF: "ETF",
    ETN: "ETN",
    INDEX: "지수",
    CURRENCY: "환율",
    FUTURE: "선물",
    MUTUALFUND: "펀드",
    CRYPTOCURRENCY: "가상자산",
  };
  return names[kind.toUpperCase()] ?? kind;
}

/** 통화 금액을 조·억 단위로 — 달러·원은 한글 이름, 그 밖 통화는 코드. */
export function moneyText(value: number | null | undefined, currency: string | null | undefined): string {
  const unit = currency === "USD" ? "달러" : currency === "KRW" ? "원" : (currency ?? "");
  return formatKoreanScale(value, unit).trimEnd();
}

/** 개수(거래량·주식 수)를 조·억·만 단위로 — 단위 글 없이. */
export function countText(value: number | null | undefined): string {
  return formatKoreanScale(value, "").trimEnd();
}

/** 핵심 지표 한 칸의 글 — 국내(text)는 네이버가 적은 글 그대로, 미국·해외는 단위대로. 없으면 "—". */
export function statText(stat: DetailStat, currency: string | null | undefined): string {
  if (stat.text) return stat.text;
  const value = stat.value;
  if (value === null || !Number.isFinite(value)) return EMPTY;
  switch (stat.unit) {
    case "money":
      return moneyText(value, currency);
    case "count":
      return countText(value);
    case "x":
      return `${formatNumber(value, 2)}배`;
    case "pct":
      return `${formatNumber(value, 2)}%`;
    default:
      return formatNumber(value, 2);
  }
}

/** 가격 자릿수 — 원화·엔화는 정수, 1 미만은 넷째 자리, 그 밖은 둘째 자리. */
export function priceDigits(price: number | null | undefined, currency: string | null | undefined): number {
  if (currency === "KRW" || currency === "JPY") return 0;
  return price !== null && price !== undefined && Math.abs(price) < 1 ? 4 : 2;
}

/** 투자의견 — Yahoo 키는 한국어로, 네이버 평균 점수(1~5)는 '평균 4.00 / 5'. 모르면 null. */
export function recommendationText(market: DetailMarket, value: string | null | undefined): string | null {
  if (!value) return null;
  if (market === "kr") return /^\d+(\.\d+)?$/.test(value) ? `평균 ${value} / 5` : value;
  const names: Record<string, string> = {
    strong_buy: "적극 매수",
    buy: "매수",
    hold: "보유",
    underperform: "비중 축소",
    sell: "매도",
    none: "의견 없음",
  };
  return names[value] ?? value;
}

/** 뉴스 시각 — 1시간 안은 'N분 전', 하루 안은 'N시간 전', 일주일 안은 'N일 전', 그 밖은 KST 날짜·시각. 없으면 "시각 모름". */
export function newsTime(iso: string | null | undefined, now: Date): string {
  if (!iso) return "시각 모름";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "시각 모름";
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60000);
  if (minutes < 0) return formatKst(iso);
  if (minutes < 60) return `${Math.max(1, minutes)}분 전`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}시간 전`;
  if (minutes < 60 * 24 * 7) return `${Math.floor(minutes / (60 * 24))}일 전`;
  return formatKst(iso);
}

/** Yahoo 섹터 → 한국어(GICS 11 섹터의 Yahoo 이름). 모르면 받은 글 그대로. */
const SECTOR_KO: Readonly<Record<string, string>> = {
  Technology: "기술",
  Healthcare: "헬스케어",
  "Financial Services": "금융",
  "Consumer Cyclical": "경기소비재",
  "Consumer Defensive": "필수소비재",
  "Communication Services": "커뮤니케이션 서비스",
  Industrials: "산업재",
  Energy: "에너지",
  Utilities: "유틸리티",
  "Real Estate": "부동산",
  "Basic Materials": "소재",
};

export function sectorKo(sector: string | null | undefined): string | null {
  if (!sector) return null;
  return SECTOR_KO[sector] ?? sector;
}

/** Yahoo 나라 이름 → 한국어(자주 나오는 것만). 모르면 받은 글 그대로. */
const COUNTRY_KO: Readonly<Record<string, string>> = {
  "United States": "미국",
  China: "중국",
  Japan: "일본",
  "United Kingdom": "영국",
  "South Korea": "한국",
  Taiwan: "대만",
  Netherlands: "네덜란드",
  Germany: "독일",
  France: "프랑스",
  Canada: "캐나다",
  Switzerland: "스위스",
  Ireland: "아일랜드",
  Israel: "이스라엘",
  "Hong Kong": "홍콩",
  Singapore: "싱가포르",
  Australia: "호주",
  India: "인도",
  Bermuda: "버뮤다",
};

export function countryKo(country: string | null | undefined): string | null {
  if (!country) return null;
  return COUNTRY_KO[country] ?? country;
}

/** 팝업 창의 기업 설명 글자 상한(사용자 요청 2026-11-03 — 간략하게, 전체 개요는 상세 화면). */
export const QUICK_PROFILE_CHARS = 160;

/**
 * 개요 앞부분 — 문장 단위로 상한(`maxChars`) 안에서 담고, 첫 문장부터 길거나 짧은 조각(예: 'Apple Inc.')뿐이면 상한에서 단어 경계로 잘라 '…'.
 * 줄바꿈은 공백으로. 문장 끝은 마침표·물음표·느낌표 뒤 공백이고, 한국어는 '…다.한국거래소'처럼 띄어 쓰지 않은 문장 끝도 나눕니다. 없으면 null.
 */
export function briefSummary(text: string | null | undefined, maxChars: number = QUICK_PROFILE_CHARS): string | null {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  if (flat.length <= maxChars) return flat;
  let out = "";
  for (const sentence of flat.split(/(?<=[.!?。])\s+|(?<=[가-힣]\.)(?=[가-힣A-Za-z])/)) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (next.length > maxChars) break;
    out = next;
  }
  if (out.length >= maxChars / 3) return out;
  const cut = flat.slice(0, maxChars);
  const space = cut.lastIndexOf(" ");
  return `${(space > maxChars / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:·(]+$/, "")}…`;
}

/** 팝업 창의 기업 설명 한 벌 — 업종 줄·개요 앞부분·영문 원문인지·출처 이름. */
export type QuickProfile = { industry: string | null; text: string; english: boolean; source: string | null };

/**
 * 종목 팝업 창의 간략한 기업 설명(사용자 요청 2026-11-03) — 상세 화면 '회사 개요'와 같은 시세 응답의 개요(한국어가 있으면 한국어: 미국은 네이버
 * 해외주식, 국내 주식은 WISEfn 기업개요, 국내 ETF는 네이버 개요). 업종은 섹터·업종을 한국어 이름으로. 개요가 없으면 null(지어내지 않음).
 */
export function quickProfile(quote: DetailQuote | null | undefined, maxChars: number = QUICK_PROFILE_CHARS): QuickProfile | null {
  const profile = quote?.profile;
  if (!profile) return null;
  const korean = briefSummary(profile.summaryKo, maxChars);
  const text = korean ?? briefSummary(profile.summary, maxChars);
  if (!text) return null;
  const parts = [sectorKo(profile.sector), profile.industryKo ?? profile.industry].filter((part): part is string => Boolean(part));
  const industry = parts.length > 0 ? [...new Set(parts)].join(" · ") : null;
  return {
    industry,
    text,
    // 미국 종목의 영문 개요(Yahoo) — 국내는 한국어 원문이 summary 칸에 옵니다(네이버 ETF 개요).
    english: !korean && quote?.market === "us",
    source: korean ? profile.koSource?.label ?? quote?.source?.label ?? null : quote?.source?.label ?? null,
  };
}

/** 뉴스 한 쪽 — 쪽당 {@code perPage}건(기본 5), 쪽 번호는 1부터, 범위 밖이면 가까운 끝 쪽. */
export const NEWS_PER_PAGE = 5;

export function newsPage<T>(items: readonly T[], page: number, perPage: number = NEWS_PER_PAGE): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const at = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return { items: items.slice((at - 1) * perPage, at * perPage), page: at, pages };
}

// ------------------------------------------------------------------ 검색어·이름

/** 지표 이름 → 뉴스 검색어 — 괄호 안(영문 약칭·단위)과 '($)' 같은 단위 꼬리를 뗍니다("미국채 10년물 수익률(%)" → "미국채 10년물 수익률"). */
export function indicatorNewsQuery(name: string): string {
  const stripped = withoutLeadingIcon(name).replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  return stripped.length >= 2 ? stripped : withoutLeadingIcon(name).trim();
}

/**
 * 기관 이름 → 화면 이름과 뉴스 검색어. 수집기 이름은 '국기 한글 (English)' 꼴이라 화면은 국기만 떼고, 검색어는 괄호 안 영문(없으면 한글 이름).
 */
export function institutionNames(name: string): { display: string; query: string } {
  const display = withoutLeadingIcon(name).trim();
  const english = /\(([^)]+)\)\s*$/.exec(display)?.[1]?.trim();
  return { display, query: english && english.length >= 2 ? english : display.replace(/\([^)]*\)/g, "").trim() };
}

/**
 * 회사 이름 → 13F 보유 기관 검색어(GET /api/guru/holders — 공시 이름에 들어간 글로 찾음). 13F 공시 이름은 대문자 영문이고 'INC'·'CORP' 꼬리가
 * 다르게 붙어 법인 꼬리·앞의 THE·기호를 뗍니다("Apple Inc." → "APPLE", "The Walt Disney Company" → "WALT DISNEY"). 두 글자보다 짧으면 null(찾지 않음).
 */
export function holderQuery(name: string | null | undefined): string | null {
  if (!name) return null;
  const words = name
    .replace(/[.,()]/g, " ")
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean);
  const suffixes = new Set(["INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "LTD", "LIMITED", "PLC", "SA", "NV", "AG", "LLC", "LP", "CLASS", "A", "B", "C", "COMMON", "STOCK", "ORDINARY", "SHARES", "ADR"]);
  while (words.length > 1 && suffixes.has(words[words.length - 1])) words.pop();
  // 13F 공시 이름은 앞의 THE를 쓰지 않습니다("The Walt Disney Company" → "WALT DISNEY CO").
  if (words.length > 1 && words[0] === "THE") words.shift();
  const query = words.join(" ").trim();
  return query.length >= 2 ? query : null;
}

// ------------------------------------------------------------------ 외부 링크

export type ExternalLink = { label: string; url: string };

/** 외부 출처 링크 — 상세 화면 아래 '다른 곳에서 보기'. 국내는 네이버 증권을 먼저. */
export function externalLinks(market: DetailMarket, code: string, yahooSymbol: string, name?: string | null): ExternalLink[] {
  const yahoo = { label: "Yahoo Finance", url: `https://finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}` };
  const investing = { label: "Investing.com", url: `https://www.investing.com/search/?q=${encodeURIComponent(name || code)}` };
  if (market === "kr") {
    return [
      { label: "네이버 증권", url: `https://m.stock.naver.com/domestic/stock/${encodeURIComponent(code)}` },
      { label: "Google Finance", url: `https://www.google.com/finance/quote/${encodeURIComponent(code)}:KRX` },
      yahoo,
      investing,
      { label: "DART 공시", url: `https://dart.fss.or.kr/dsab007/main.do?textCrpNm=${encodeURIComponent(name || code)}` },
    ];
  }
  const links = [yahoo, { label: "Google Finance", url: `https://www.google.com/finance?q=${encodeURIComponent(yahooSymbol)}` }, investing];
  // 미국 상장 보통주 모양(지수 ^·환율·선물 =·해외 거래소 '.' 꼬리가 없음)이면 SEC 공시 목록도
  if (/^[A-Z]{1,5}(-[A-Z])?$/.test(code)) {
    links.push({ label: "SEC EDGAR 공시", url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(code)}` });
  }
  return links;
}

/** 기관의 외부 링크 — SEC EDGAR 13F 공시 목록. */
export function institutionLinks(cik: string): ExternalLink[] {
  return [
    { label: "SEC EDGAR 13F 공시", url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(cik)}&type=13F-HR` },
  ];
}

// ------------------------------------------------------------------ AI 요약

/** 요약 한 줄 — 글과 근거 번호들(줄 끝의 [1]·[1][2]·[1, 2]). 번호는 글에서 뗍니다. */
export type SummaryLine = { text: string; refs: number[]; kind: "heading" | "bullet" | "text" };

/** 요약 글 → 줄 — 빈 줄은 빼고, '- '로 시작하면 목록, '…:'로 끝나면 머리 줄. */
export function summaryLines(summary: string | null | undefined): SummaryLine[] {
  return (summary ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const refs: number[] = [];
      const text = line
        .replace(/\s*(\[\s*\d+(?:\s*,\s*\d+)*\s*\])+\s*$/g, (tail) => {
          for (const match of tail.matchAll(/\d+/g)) refs.push(Number(match[0]));
          return "";
        })
        .trim();
      const bullet = /^[-•·]\s+/.test(text);
      return {
        text: bullet ? text.replace(/^[-•·]\s+/, "") : text,
        refs: [...new Set(refs)],
        kind: bullet ? "bullet" : /[:：]$/.test(text) ? "heading" : "text",
      };
    });
}
