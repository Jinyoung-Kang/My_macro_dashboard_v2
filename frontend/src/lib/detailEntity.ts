/**
 * 상세 대상 화면(종목 /s/<시장>/<코드>·지표 /markets/i/<id>·기관 /institutions/<CIK>)의 속성·연결 모델 — 작업대 대상 문법(P4 — 대상 머리·왼쪽 속성·
 * 가운데 탭·오른쪽 연결)의 속성 줄과 연결 주소를 만드는 React를 모르는 순수 함수(ADR 0004). 값이 없으면 null(화면은 "—", 0으로 채우지 않음).
 *
 * 주소·값 글 같은 기본 규칙은 lib/detail에 있고, 이 모듈은 상세 화면만 가져옵니다 — lib/detail은 셸(빵부스러기·명령 팔레트)이 모든 화면에서 싣는
 * 모듈이라 여기 것을 거기 두면 모든 화면의 첫 적재에 실렸습니다(webpack 빌드로 잼 — 홈 첫 적재 압축 전 약 3.5KB·gzip 약 0.5KB). 따로 두어
 * lib/detail ↔ lib/infoSearch가 서로 가져오는 일도 없습니다(정보 검색 키 문법은 이 모듈만 가져옴).
 */
import { visibleMenus } from "./access";
import {
  countryKo,
  currencyUnit,
  INDICATOR_NO_CHART,
  indicatorChartSymbol,
  indicatorHref,
  priceDigits,
  recommendationText,
  sectorKo,
  statText,
} from "./detail";
import { EMPTY, formatNumber, formatSignedMinus, formatUsd, formatWeightPercent, withoutLeadingIcon } from "./format";
import type { HomeRow } from "./home";
import { isEntityKey, searchHref } from "./infoSearch";
import type { DetailMarket, DetailQuote } from "./types/detail";
import type { GuruHoldersResponse, Holding, PortfolioResponse } from "./types/institution";
import type { MacroItem, MacroOverview } from "./types/macro";
import type { SessionUser } from "./types";

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

/**
 * 애널리스트 의견 속성 — 평균 목표가·투자의견·의견 수(미국 Yahoo, 국내 네이버 컨센서스). 모르면 null(일부만 모르면 그 줄이 "—").
 * 받은 값만 — 의견이 없거나 세 값을 모두 모르면(수집기는 지수·ETF·모르는 심볼에도 값이 모두 null인 객체를 줌) 빈 목록이라 화면이 패널을 그리지
 * 않고, 국내는 네이버가 의견 수를 주지 않아 늘 비는 '의견 수' 줄을 두지 않습니다(회사 개요와 같은 규칙 — QA-580).
 */
export function consensusItems(market: DetailMarket, quote: Pick<DetailQuote, "consensus" | "currency">): DetailProperty[] {
  const consensus = quote.consensus;
  if (!consensus) return [];
  const rows: DetailProperty[] = [
    { label: "평균 목표가", value: consensus.targetMean !== null && Number.isFinite(consensus.targetMean) ? moneyPriceText(consensus.targetMean, quote.currency) : null },
    { label: "투자의견", value: recommendationText(market, consensus.recommendation) },
  ];
  if (market !== "kr") {
    rows.push({ label: "의견 수", value: consensus.analysts !== null && Number.isFinite(consensus.analysts) ? `${formatNumber(consensus.analysts, 0)}곳` : null });
  }
  return rows.some((row) => row.value !== null) ? rows : [];
}

/**
 * 뜻이 다른 티커(INDICATOR_NO_CHART — 차트·연결에서 뺌)의 속성 '티커' 줄 note — 이 카드 값의 출처가 아님(QA-589). 지금은 2년물 하나라 그 뜻(선물 가격·
 * 수익률)을 적고, 표에 없는 키는 일반 글.
 */
const NO_CHART_TICKER_NOTE: Readonly<Record<string, string>> = {
  us02y: "Yahoo 선물 가격 — 이 카드 값(수익률)의 출처가 아님",
};

/** 지표 속성에 쓰는 카드 행의 칸(lib/home macroCardRow 결과). */
export type IndicatorRowFields = Pick<HomeRow, "valueText" | "asOf" | "isEstimated" | "isStale" | "staleReason" | "warning">;

/**
 * 지표 속성(지표 상세 왼쪽 칸) — 범주·티커·카드 키(고정폭)·값(추정·이전 값 배지)·전일·값 출처·장 상태·기준 시각·경고(있을 때만). 뜻이 다른 티커
 * (us02y ZT=F)는 값을 그대로 두고(수집기 덮어쓰기 실패 경고가 이 이름을 가리킴) 이 카드 값의 출처가 아니라는 note를 붙입니다. 값 출처와 장 상태는
 * 부르는 쪽이 홈 시장 표와 같은 규칙(lib/home macroItemSource·macroCardSession)으로 넘깁니다 — 이 모듈은 lib/home을 가져오지 않습니다(형식만).
 */
export function indicatorProperties(
  item: Pick<MacroItem, "key" | "ticker" | "prevStr">,
  row: IndicatorRowFields,
  context: { category: string; source: string | null; session: string | null },
): DetailProperty[] {
  const out: DetailProperty[] = [
    { label: "범주", value: presentValue(context.category) },
    {
      label: "티커",
      value: presentValue(item.ticker),
      mono: true,
      ...(INDICATOR_NO_CHART[item.key] !== undefined
        ? { note: NO_CHART_TICKER_NOTE[item.key] ?? "뜻이 다른 Yahoo 티커 — 이 카드 값의 출처가 아님" }
        : {}),
    },
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
 * 최신 분기의 보유 종목 수(기관 상세 보유 종목 탭의 개수 줄 — '552종목 가운데 비중 상위 30종목'). 응답 holdings는 백엔드가 비중 상위 topN줄로 잘라
 * 보내므로 전체 수는 이것으로 셉니다(QA-585). 분기가 없거나 수를 모르면 null — 응답 길이로 짐작하지 않습니다.
 */
export function latestHoldingCount(quarters: PortfolioResponse["quarters"] | null | undefined): number | null {
  const count = latestQuarter(quarters)?.holdingCount;
  return typeof count === "number" && Number.isFinite(count) ? count : null;
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

/** 보유 줄의 키 — 목록-검사 줄 키와 같은 'CUSIP:클래스'. */
function holdingKey(holding: Pick<Holding, "cusip" | "class">): string {
  return `${holding.cusip}:${holding.class}`;
}

/**
 * 보유 줄 이름표(기관 상세 보유 종목 — 검사 칸 영역 이름·제목, 좁은 화면 대화상자 제목). 키는 'CUSIP:클래스'. 13F 보유 줄은 공시 이름이 같은 다른
 * 증권(A·C주, 'ISHARES TR' 아래 여러 ETF, 우선주·보통주)이 흔해 이름이 겹치는 줄에만 구분자를 붙입니다 — 먼저 ' · 클래스'(겹친 줄의 클래스가
 * 모두 있고 서로 다를 때), 그것으로 갈리지 않으면 ' · CUSIP …', 그래도 겹치면 키(QA-587 — 백엔드 Sec13FService.lineLabels·lib/consensus
 * consensusBars와 같은 규칙). 겹치지 않는 이름은 그대로입니다.
 */
export function holdingItemLabels(holdings: readonly Pick<Holding, "name" | "cusip" | "class">[]): Map<string, string> {
  const labels = holdings.map((holding) => holding.name);
  const byName = new Map<string, number[]>();
  holdings.forEach((holding, index) => byName.set(holding.name, [...(byName.get(holding.name) ?? []), index]));
  for (const [name, same] of byName) {
    if (same.length < 2) continue;
    const byClass = same.map((index) => `${name} · ${holdings[index].class}`);
    const classesTell = same.every((index) => (holdings[index].class ?? "").trim() !== "") && new Set(byClass).size === same.length;
    same.forEach((index, at) => {
      labels[index] = classesTell ? byClass[at] : `${name} · CUSIP ${holdings[index].cusip}`;
    });
  }
  const used = new Set<string>();
  const out = new Map<string, string>();
  holdings.forEach((holding, index) => {
    let label = labels[index];
    if (used.has(label)) label = `${label} · ${holdingKey(holding)}`;
    used.add(label);
    out.set(holdingKey(holding), label);
  });
  return out;
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
