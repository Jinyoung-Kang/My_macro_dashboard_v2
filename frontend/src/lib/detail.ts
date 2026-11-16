/**
 * 검색 상세 화면(종목 /s/<시장>/<코드>·지표 /markets/i/<id>·기관 /institutions/<CIK>)의 표시 규칙 — React를 모르는 순수 함수(ADR 0004).
 * 명세 docs/specs/2026-11-01-search-detail.md. 외부 정보는 GET /api/detail/*(수집기 실시간 조회), 차트는 GET /api/macro/ticker.
 *
 * 값이 없으면 "—"(0으로 채우지 않음). 외부 출처는 링크로 함께 적습니다(Yahoo Finance·Google Finance·Investing.com·네이버 증권·SEC EDGAR).
 * 작업대 대상 문법(P4 — 대상 머리·왼쪽 속성·가운데 탭·오른쪽 연결)의 속성 줄과 연결 주소도 여기서 만듭니다(아래 '속성'·'연결').
 *
 * lib/infoSearch가 이 모듈의 주소 함수를 가져오고 이 모듈도 그쪽의 searchHref·isEntityKey를 가져옵니다(서로 가져옴). 둘 다 함수 몸통 안에서만 부르므로
 * 모듈을 읽는 순서와 상관없이 동작합니다 — 모듈 맨 위(최상위 const)에서 서로의 함수를 부르지 않습니다.
 */
import { visibleMenus } from "./access";
import { EMPTY, formatKoreanScale, formatKst, formatNumber, formatSignedMinus, formatUsd, formatWeightPercent, withoutLeadingIcon } from "./format";
import type { HomeRow } from "./home";
import { isEntityKey, searchHref } from "./infoSearch";
import type { LineRow } from "./lineChart";
import { scaleFor } from "./macroLive";
import type { DetailMarket, DetailQuote, DetailStat } from "./types/detail";
import type { GuruHoldersResponse, Holding, PortfolioResponse } from "./types/institution";
import type { MacroCategory, MacroItem, MacroOverview } from "./types/macro";
import type { SessionUser } from "./types";

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

/**
 * 지표 차트 행 — 카드와 같은 단위(QA-185). 엔/원 카드는 100엔당이라 1엔당(50 미만)으로 온 점에 100을 곱합니다(카드와 같은 배율 규칙 — lib/macroLive
 * scaleFor, 수집기 market.quote_scale). 점마다 판정해 이미 100엔당으로 온 점은 그대로 둡니다. 다른 지표는 chartRows 그대로.
 */
export function indicatorChartRows(
  key: string,
  points: readonly { date: string; close?: number | null; value?: number | null }[] | null | undefined,
): LineRow[] {
  return chartRows(points).map((row) => {
    const value = row[CHART_KEY];
    return typeof value === "number" ? { ...row, [CHART_KEY]: value * scaleFor(key, value) } : row;
  });
}

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

/**
 * 주요 뉴스(GET /api/detail/news)·AI 요약(POST /api/detail/summary)의 검색어(q)·이름(label) 상한. 백엔드 DetailService.MAX_QUERY와 같은 값이고,
 * 백엔드는 앞뒤 공백을 뺀 Java 길이(UTF-16 단위)로 재서 넘으면 400입니다(수집기 /live/news는 글자 수로 같은 60).
 */
export const DETAIL_QUERY_MAX = 60;

/** 상한에서 자른 끝에 남으면 떼는 이음 기호·여는 괄호(쉼표·&·하이픈 등 — 'Holdings,' → 'Holdings'). 마침표는 'Inc.' 같은 약칭이라 둡니다. */
const QUERY_TAIL = /[\s,;:·&+/(（[{、，–—-]+$/u;

/** 낱말을 잇는 글자 — 자른 자리 다음 글자가 이것이면 낱말 가운데입니다(글자·숫자·결합 부호). 공백·문장 부호면 낱말 끝입니다. */
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

/**
 * 이름 → 상세 화면의 뉴스·AI 요약 검색어(QA-448). 시세 이름은 Yahoo의 긴 이름(longName)이라 60자를 넘을 수 있어, 넘으면 백엔드 상한 안으로
 * 줄입니다 — 공백을 하나로 줄이고, 글자(코드 포인트)를 가르지 않으면서 백엔드가 세는 UTF-16 길이로 `max` 안까지 담은 뒤 낱말 가운데(다음 글자가
 * 글자·숫자·결합 부호 — 공백이나 'Partner, Inc.'의 쉼표 같은 문장 부호면 낱말 끝)면 앞 낱말 끝까지(앞 절반 안에 공백밖에 없으면 그대로 — 띄어 쓰지
 * 않은 긴 이름), 뒤 절반에서 열려 잘리는 바람에 닫히지 않은 괄호는 그 앞까지(덧붙인 설명이라),
 * 끝에 남은 쉼표·이음 기호를 뗍니다. 상한 안이면 공백만 정리한 그대로, 비면 null.
 */
export function detailQuery(name: string | null | undefined, max: number = DETAIL_QUERY_MAX): string | null {
  const flat = (name ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  if (flat.length <= max) return flat;
  let cut = "";
  for (const char of flat) {
    if (cut.length + char.length > max) break;
    cut += char;
  }
  const next = flat.codePointAt(cut.length);
  const atBoundary = next === undefined || !WORD_CHAR.test(String.fromCodePoint(next));
  const space = cut.lastIndexOf(" ");
  let words = atBoundary || space <= max / 2 ? cut : cut.slice(0, space);
  const open = words.lastIndexOf("(");
  if (open > max / 2 && !words.includes(")", open)) words = words.slice(0, open);
  return words.replace(QUERY_TAIL, "") || null;
}

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
 * 회사 이름 → 13F 보유 기관 검색어(GET /api/guru/holders — 공시 이름에 들어간 글로 찾고, 제출자가 잘라 적은 긴 공시 이름은 그 앞부분으로 검색어가 시작하면
 * 함께 찾음 — QA-436). 13F 공시 이름은 대문자 영문이고 'INC'·'CORP' 꼬리가 다르게 붙어 법인 꼬리·앞의 THE·기호를 뗍니다("Apple Inc." → "APPLE",
 * "The Walt Disney Company" → "WALT DISNEY"). 두 글자보다 짧으면 null(찾지 않음).
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

/**
 * 13F 보유 기관을 회사 이름으로 찾아 한 줄도 없을 때의 안내(정보 검색 보유 탭·종목 상세의 치지 않은 검색과 스타일 화면의 직접 검색, QA-436). 무엇으로
 * 찾았는지와 그 한계를 적고 '보유한 곳이 없다'고 단정하지 않습니다 — 잘라 적은 공시 이름은 백엔드가 함께 찾지만, 줄여 적은 이름(FINANCIAL → FINL)은 이름으로 찾지 못합니다.
 * 정보 검색 보유 탭은 영문 이름이 없는 대상을 티커로 찾으므로(`by: "ticker"`) 그때는 이름이 아니라 티커로 찾았다는 것과 그 까닭(13F 공시 이름에는 티커가
 * 적히지 않음)을 적습니다.
 */
export function holdersNoMatch(query: string, by: "name" | "ticker" = "name"): { title: string; note: string } {
  if (by === "ticker") {
    return {
      title: `‘${query}’ 티커로 찾은 13F 보유 줄이 없습니다`,
      note:
        "영문 이름이 없어 티커로 이 대시보드가 받는 13F 기관의 공시 이름에서 찾았습니다. 13F 공시 이름에는 티커가 적히지 않아 티커로는 보유 줄을 " +
        "찾기 어려우므로, 보유한 곳이 없다고 단정할 수 없습니다.",
    };
  }
  return {
    title: `‘${query}’ 이름으로 찾은 13F 보유 줄이 없습니다`,
    note:
      "이 대시보드가 받는 13F 기관의 공시 이름에서 찾았습니다. 앞부분만 남기고 잘린 공시 이름은 함께 찾지만 줄여 적은 이름(예: FINANCIAL → FINL)은 " +
      "찾지 못하므로, 보유한 곳이 없다고 단정할 수 없습니다.",
  };
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

// ------------------------------------------------------------------ 속성(대상 화면 왼쪽 칸·검사 칸)

/**
 * 속성 한 줄 — components/patterns `PropertyItem`과 같은 꼴(lib는 components를 가져오지 않음 — ADR 0004). 값을 모르면 null(화면은 "—"와 사유,
 * 0으로 채우지 않음). `link`가 있으면 화면이 값 글을 그 주소의 링크로 그립니다(external이면 새 창 — http(s)만).
 */
export type DetailProperty = {
  label: string;
  value: string | number | null;
  key?: string;
  unit?: string | null;
  emptyReason?: string | null;
  /** 식별자(티커·CIK·CUSIP·카드 키) — 고정폭. */
  mono?: boolean;
  note?: string | null;
  isEstimated?: boolean;
  isProxy?: boolean;
  isStale?: boolean;
  staleReason?: string | null;
  source?: string | null;
  /** 긴 글(기관 소개) — 이름 위·값 아래. */
  block?: boolean;
  link?: { href: string; external: boolean } | null;
};

/** 글 값 — 비었거나 "—"면 null(화면이 "—"를 그림). */
function presentValue(text: string | null | undefined): string | null {
  const trimmed = (text ?? "").trim();
  return trimmed && trimmed !== EMPTY ? trimmed : null;
}

/** 핵심 지표(종목 상세 왼쪽 칸) — 시세 응답의 지표 그대로(국내는 네이버 글, 미국·해외는 단위대로 — statText), 모르면 null. */
export function stockStatItems(quote: Pick<DetailQuote, "stats" | "currency">): DetailProperty[] {
  return quote.stats.map((stat) => ({ key: stat.key, label: stat.label, value: presentValue(statText(stat, quote.currency)) }));
}

/** 홈페이지 주소 — http(s)만(수집한 글을 그대로 href에 넣지 않음). 아니면 null. */
export function websiteHref(website: string | null | undefined): string | null {
  return website && /^https?:\/\//i.test(website) ? website : null;
}

/** 홈페이지의 보이는 글 — 'www.'를 뗀 호스트(주소를 풀지 못하면 '회사 홈페이지'). */
function websiteText(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./i, "") || "회사 홈페이지";
  } catch {
    return "회사 홈페이지";
  }
}

/**
 * 회사 개요 속성(종목 상세 왼쪽 칸) — 섹터·업종·나라(한국어 이름 표)·직원 수·홈페이지(새 창 링크). 받은 값만 줄로 둡니다(개요 표의 지금 규칙 —
 * 국내 ETF처럼 개요 글만 있는 종목에 "—" 네 줄을 두지 않음). 개요 글은 가운데 '회사 소개'가 보입니다. 개요가 없으면 빈 목록.
 */
export function profileItems(quote: Pick<DetailQuote, "profile">): DetailProperty[] {
  const profile = quote.profile;
  if (!profile) return [];
  const website = websiteHref(profile.website);
  const rows: DetailProperty[] = [
    { label: "섹터", value: sectorKo(profile.sector) },
    { label: "업종", value: presentValue(profile.industryKo ?? profile.industry) },
    { label: "나라", value: countryKo(profile.country) },
    { label: "직원 수", value: profile.employees !== null && Number.isFinite(profile.employees) ? `${formatNumber(profile.employees, 0)}명` : null },
    { label: "홈페이지", value: website ? websiteText(website) : null, link: website ? { href: website, external: true } : null },
  ];
  return rows.filter((row) => row.value !== null);
}

/** 통화 가격 글 — 자릿수는 priceDigits, 단위는 currencyUnit('360.50 USD'·'89,000 원'). */
export function moneyPriceText(value: number, currency: string | null | undefined): string {
  const unit = currencyUnit(currency);
  return `${formatNumber(value, priceDigits(value, currency))}${unit ? ` ${unit}` : ""}`;
}

/** 애널리스트 의견 속성 — 평균 목표가·투자의견·의견 수(미국 Yahoo, 국내 네이버 컨센서스). 모르면 null. 의견이 없으면 빈 목록. */
export function consensusItems(market: DetailMarket, quote: Pick<DetailQuote, "consensus" | "currency">): DetailProperty[] {
  const consensus = quote.consensus;
  if (!consensus) return [];
  return [
    { label: "평균 목표가", value: consensus.targetMean !== null && Number.isFinite(consensus.targetMean) ? moneyPriceText(consensus.targetMean, quote.currency) : null },
    { label: "투자의견", value: recommendationText(market, consensus.recommendation) },
    { label: "의견 수", value: consensus.analysts !== null && Number.isFinite(consensus.analysts) ? `${formatNumber(consensus.analysts, 0)}곳` : null },
  ];
}

/** 지표 속성에 쓰는 카드 행의 칸(lib/home macroCardRow 결과). */
export type IndicatorRowFields = Pick<HomeRow, "valueText" | "asOf" | "isEstimated" | "isStale" | "staleReason" | "warning">;

/**
 * 지표 속성(지표 상세 왼쪽 칸) — 범주·티커·카드 키(고정폭)·값(추정·이전 값 배지)·전일·값 출처·장 상태·기준 시각·경고(있을 때만). 값 출처와 장 상태는
 * 부르는 쪽이 홈 시장 행과 같은 규칙(lib/home macroItemSource·macroCardSession)으로 넘깁니다 — 이 모듈은 lib/home을 가져오지 않습니다(형식만).
 */
export function indicatorProperties(
  item: Pick<MacroItem, "key" | "ticker" | "prevStr">,
  row: IndicatorRowFields,
  context: { category: string; source: string | null; session: string | null },
): DetailProperty[] {
  const out: DetailProperty[] = [
    { label: "범주", value: presentValue(context.category) },
    { label: "티커", value: presentValue(item.ticker), mono: true },
    { label: "카드 키", value: item.key, mono: true },
    {
      label: "값",
      value: presentValue(row.valueText),
      isEstimated: row.isEstimated === true,
      isStale: row.isStale === true,
      staleReason: row.staleReason ?? null,
    },
    { label: "전일", value: presentValue(item.prevStr) },
    { label: "값 출처", value: presentValue(context.source) },
    { label: "장 상태", value: presentValue(context.session) },
    { label: "기준 시각", value: presentValue(row.asOf) },
  ];
  const warning = presentValue(row.warning);
  if (warning) out.push({ label: "경고", value: warning });
  return out;
}

/** 최신 분기(보고 기준일이 가장 늦은 분기) — 없으면 null. */
function latestQuarter(quarters: PortfolioResponse["quarters"] | null | undefined): PortfolioResponse["quarters"][number] | null {
  return [...(quarters ?? [])].sort((a, b) => b.reportDate.localeCompare(a.reportDate))[0] ?? null;
}

/**
 * 기관 속성(기관 상세 왼쪽 칸) — CIK(고정폭)·보고 기준일·공시일·13F 보고 평가액·보유 종목 수(최신 분기)·분기 수·수집 시각, 기관 소개(긴 글 — 있을 때만).
 * 포트폴리오를 받기 전이면 CIK 한 줄만(나머지는 화면이 '불러오는 중'으로).
 */
export function institutionProperties(data: PortfolioResponse | null | undefined, cik: string): DetailProperty[] {
  const out: DetailProperty[] = [{ label: "CIK", value: cik, mono: true }];
  if (!data) return out;
  const latest = data.latest ?? null;
  const quarter = latestQuarter(data.quarters);
  const total = latest?.totalValue ?? null;
  out.push(
    { label: "보고 기준일", value: presentValue(latest?.reportDate) },
    { label: "공시일", value: presentValue(latest?.filingDate) },
    { label: "13F 보고 평가액", value: total !== null && Number.isFinite(total) ? formatUsd(total) : null },
    {
      label: "보유 종목 수",
      value: quarter && Number.isFinite(quarter.holdingCount) ? `${formatNumber(quarter.holdingCount, 0)}종목` : null,
      note: quarter ? `${quarter.reportDate} 보고 기준` : null,
    },
    { label: "분기 수", value: data.quarters.length > 0 ? `${data.quarters.length}분기` : null },
    { label: "수집 시각", value: presentValue(data.collectedAtKst) },
  );
  const desc = presentValue(withoutLeadingIcon(data.institution?.desc ?? ""));
  if (desc) out.push({ label: "기관 소개", value: desc, block: true });
  return out;
}

/** 부호 있는 변화 글(−는 U+2212) — 모르면 null. */
function signedText(value: number | null | undefined, digits: number, suffix: string): string | null {
  return value !== null && value !== undefined && Number.isFinite(value) ? `${formatSignedMinus(value, digits).text}${suffix}` : null;
}

/** 13F 보유 줄 하나의 속성(기관 상세 보유 종목 검사 칸) — 공시 이름·클래스·CUSIP(고정폭)·비중·평가액·주식 수·주식 수 변화·비중 변화(%p)·동작. */
export function holdingDetailItems(holding: Holding): DetailProperty[] {
  return [
    { label: "공시 이름", value: presentValue(holding.name) },
    { label: "클래스", value: presentValue(holding.class) },
    { label: "CUSIP", value: presentValue(holding.cusip), mono: true },
    { label: "비중", value: presentValue(formatWeightPercent(holding.weight)) },
    { label: "평가액", value: presentValue(formatUsd(holding.value)) },
    { label: "주식 수", value: holding.shares !== null && Number.isFinite(holding.shares) ? `${formatNumber(holding.shares, 0)}주` : null },
    // 변화를 모르면(직전 분기 없음·주식 수나 비중 모름 — 까닭은 '동작' 줄) "—".
    { label: "주식 수 변화", value: signedText(holding.sharesDiff, 0, "주") },
    { label: "비중 변화", value: signedText(holding.weightDiff, 2, "%p") },
    { label: "동작", value: presentValue(withoutLeadingIcon(holding.action)) },
  ];
}

/** 13F 보유 기관 줄 하나의 속성(종목 상세 보유 기관 검사 칸) — 기관·공시 이름·CUSIP(고정폭)·비중·평가액·보고일. */
export function holderDetailItems(row: GuruHoldersResponse["rows"][number]): DetailProperty[] {
  return [
    { label: "기관", value: presentValue(withoutLeadingIcon(row.institution)) },
    { label: "공시 이름", value: presentValue(row.name) },
    { label: "CUSIP", value: presentValue(row.cusip), mono: true },
    { label: "비중", value: presentValue(formatWeightPercent(row.weight)) },
    { label: "평가액", value: presentValue(formatUsd(row.value)) },
    { label: "보고일", value: presentValue(row.reportDate) },
  ];
}

// ------------------------------------------------------------------ 연결(대상 화면 오른쪽 칸)

/**
 * 같은 Yahoo 심볼의 지표(종목 상세 → 지표 상세) — 매크로 카드 가운데 차트 심볼(indicatorChartSymbol — 뜻이 다른 티커 ZT=F는 뺌)이 이 심볼과 같은 첫 카드.
 * 예: /s/us/^GSPC → S&P 500(/markets/i/sp500). 없으면 null.
 */
export function indicatorForSymbol(
  overview: Pick<MacroOverview, "categories"> | null | undefined,
  yahooSymbol: string | null | undefined,
): { key: string; name: string; href: string } | null {
  const symbol = (yahooSymbol ?? "").trim().toUpperCase();
  if (!symbol) return null;
  for (const category of overview?.categories ?? []) {
    for (const item of category.items) {
      if (indicatorChartSymbol(item)?.toUpperCase() === symbol) return { key: item.key, name: item.name, href: indicatorHref(item.key) };
    }
  }
  return null;
}

/** 종목의 정보 검색 대상 키 — 미국 'us:<티커>'·국내 'kr:<6자리>'(모양이 틀리면 — 지수 ^·환율 =X 등 — infoSearchEntityLink가 null). */
export function stockEntityKey(market: DetailMarket, code: string): string {
  return `${market}:${code.trim().toUpperCase()}`;
}

/** 13F 기관의 정보 검색 대상 키 — 'cik:<10자리>'(앞을 0으로 채움 — 정보 검색 키 문법). 숫자가 아니면 null. */
export function institutionEntityKey(cik: string): string | null {
  return /^\d{1,10}$/.test(cik) ? `cik:${cik.padStart(10, "0")}` : null;
}

/**
 * 정보 검색 대상 화면으로 가는 링크(ADR 0041 — /search?e=<키>) — 키 모양이 정보 검색 문법(lib/infoSearch isEntityKey)에 맞고 이 사용자에게 /search가
 * 보일 때만(lib/access visibleMenus), 아니면 null.
 */
export function infoSearchEntityLink(
  key: string | null | undefined,
  label: string,
  user: SessionUser | null | undefined,
): { label: string; href: string } | null {
  if (!isEntityKey(key) || visibleMenus([{ href: "/search" }], user).length === 0) return null;
  return { label, href: searchHref({ e: key }) };
}
