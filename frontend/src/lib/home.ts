/**
 * 홈(/) 화면의 표시 규칙 — React를 모르는 순수 함수(ADR 0004).
 *
 * 숫자는 전부 백엔드·수집기가 보낸 값입니다(국면 판정·신호 값, 계좌 순자산·출발 대비 수익률, 매크로 카드 시세·변화, 알림 수,
 * 수집 오류·경고 수). 여기서는 고르고, 이름을 붙이고, 자산 행·타일 모양으로 옮기기만 합니다 — 판정 글을 지어내거나
 * 일간 변화처럼 응답에 없는 숫자를 빼기로 만들지 않습니다. 모르는 값은 null(화면 "—")이고 0으로 채우지 않습니다.
 */
import { delayLabel, EMPTY, formatDate, formatKst, formatNumber, formatSigned, formatWithUnit, withoutLeadingIcon } from "./format";
import { MARKETS, sessionStatus, tradeDayFrom, tradeTimeFrom } from "./marketSessions";
import { TABS } from "./nav";
import { formatDollars } from "./paper";
import { formatMoney, marketMeta, type PaperMarketCode } from "./paperMarket";
import { bookAssetRow, type BookRow } from "./paperOverview";
import { paperMarketPath } from "./paperRoutes";
import { presentText } from "./patterns";
import type {
  InboxResponse,
  MacroCategory,
  MacroItem,
  MacroOverview,
  PaperBookSummary,
  PaperOverviewResponse,
  PaperStatusResponse,
  RegimeResponse,
  RegimeSignal,
  StatusIssuesResponse,
} from "./types";

/**
 * 자동 갱신 간격(ms) — 기존 화면의 간격을 그대로 따릅니다(국면 /regime 5분, 모의매매 /paper 1분, 알림 레이아웃 5분, 상태 /status 1분).
 * 매크로는 5분입니다 — /macro의 기본 60초(=live=true, 신선도 기준 60초)를 쓰면 백엔드가 Yahoo 수집을 그만큼 자주 깨웁니다(429 이력).
 */
export const HOME_REFRESH_MS = {
  regime: 300_000,
  macro: 300_000,
  paper: 60_000,
  alerts: 300_000,
  storeStatus: 60_000,
} as const;

/** 국면 이력 기간 — /regime 화면의 기본(5년)과 같게 둬 백엔드 응답 캐시(analytics.regime:5)를 함께 씁니다. */
export const HOME_REGIME_YEARS = 5;

/** 알림 요약에 보일 최근 알림 수. */
export const HOME_ALERT_LIMIT = 3;

/** 시장 행이 가는 화면. 1단계에는 지표 상세 화면이 없어 매크로 지표 화면으로 보냅니다. */
export const MARKET_HREF = "/macro";

/**
 * 모의매매 행이 가는 화면 — 셸의 모의매매 탭과 같은 곳(lib/nav TABS). 미국 책 화면이 /paper/us로 옮겨 가면 탭 href와 함께 따라갑니다
 * (탭보다 먼저 /paper/us를 박으면 그 경로가 생기기 전까지 404).
 */
export const PAPER_HREF = TABS.find((tab) => tab.key === "paper")?.href ?? "/paper";

/**
 * 홈 시장 행 한 줄 — components/patterns `AssetRowData`와 같은 모양(lib는 components를 가져오지 않으므로 여기 따로 적음).
 * 변화를 모르면 null(칩 생략), 값을 모르면 value·valueText 둘 다 null("—"). 계좌 행은 `PaperHomeRow`.
 */
export type HomeRow = {
  id: string;
  name: string;
  sub: string | null;
  value: number | null;
  /** 서식된 값(수집기 priceStr) — 있으면 value 서식보다 우선, "N/A"는 "—"(lib/patternRows assetValueText). */
  valueText?: string | null;
  unit?: string | null;
  change: number | null;
  changePct: number | null;
  /** 변화량 소수 자릿수(수집기 deltaStr의 자릿수, 모르면 없음 → 기본 2). 변화율은 늘 소수 둘째입니다. */
  changeDigits?: number;
  asOf?: string | null;
  delayMin?: number | null;
  /** 출처 배지 앞부분 — 시장 행은 출처 뒤에 장 상태("개장"·"마감" 등)를 붙입니다(macroCardRow). */
  source?: string | null;
  /** 출처 배지 툴팁 — 닫힌 장이라 배지에 적지 않은 시세 지연(macroCardRow). */
  provenanceTitle?: string | null;
  isEstimated?: boolean;
  isStale?: boolean;
  staleReason?: string | null;
  warning?: string | null;
  href: string;
};

/** 유한한 숫자만 — null·undefined·NaN·Infinity는 null(0으로 바꾸지 않음). */
function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function joinPresent(parts: readonly (string | null | undefined)[], separator = " · "): string | null {
  const kept = parts.map((part) => presentText(part)).filter((part): part is string => part !== null);
  return kept.length > 0 ? kept.join(separator) : null;
}

// ---------------------------------------------------------------- ① 오늘의 국면

/** 기준일(asOf)의 뜻 — 백엔드가 네 입력 계열의 마지막 날짜 중 가장 이른 날을 보냅니다(AnalyticsService.latestCommonDate). */
export const REGIME_AS_OF_NOTE = "네 입력 계열의 마지막 날짜 중 가장 이른 날";

/** 판정 신호 타일 하나. 값을 모르면 valueText가 null — 화면은 "—"와 emptyReason을 그립니다(단위 없음). */
export type RegimeTile = {
  id: string;
  label: string;
  valueText: string | null;
  unit: string | null;
  /** 백엔드가 보낸 상태·해석 글("정상 · 장기 금리가 단기보다 높습니다…"). */
  note: string | null;
  emptyReason: string | null;
};

/**
 * 판정 신호 네 자리(백엔드 Regime.classify의 순서). 백엔드는 입력이 없는 신호를 signals에서 아예 빼고 missing에 이름만 적으므로,
 * 자리를 여기 고정해 둬야 빠진 신호가 "—"로 남습니다(조용히 사라지지 않음). 라벨은 그때만 쓰는 대신 값이고, 신호가 오면 백엔드 라벨을 씁니다.
 * 자릿수는 승인된 홈 시안(금리차·하이일드 소수 둘째, NFCI·순유동성 4주 변화 소수 셋째 — 0.031조 달러를 0.03으로 뭉개지 않음)을 따르고,
 * 방향이 뜻을 가진 셋(역전·긴축·유입)은 부호를 붙입니다(/regime 판정 기록 표와 같은 규칙, lib/regime.ts).
 */
const REGIME_SLOTS: readonly { id: string; label: string; format: (value: number) => string }[] = [
  { id: "curve", label: "장단기 금리차 10Y-3M", format: (value) => formatSigned(value, 2) },
  { id: "nfci", label: "시카고 연준 금융상황지수", format: (value) => formatSigned(value, 3) },
  { id: "hyOas", label: "하이일드 스프레드", format: (value) => formatNumber(value, 2) },
  { id: "liquidity", label: "연준 순유동성 4주 변화", format: (value) => formatSigned(value, 3) },
];

function regimeTile(id: string, fallbackLabel: string, signal: RegimeSignal | undefined, format: (value: number) => string): RegimeTile {
  if (!signal) {
    return { id, label: fallbackLabel, valueText: null, unit: null, note: null, emptyReason: "받지 못함" };
  }
  const value = finite(signal.value);
  return {
    id,
    label: presentText(signal.label) ?? fallbackLabel,
    valueText: value === null ? null : format(value),
    unit: presentText(signal.unit),
    note: joinPresent([signal.state, signal.reading]),
    emptyReason: value === null ? "값 없음" : null,
  };
}

export type RegimeHeroModel = {
  /** 판정 라벨(백엔드, 예 "확장 (Expansion)"). 판정이 없으면 "판정 불가". */
  label: string;
  /** 판정이 났는가 — 백엔드 code가 UNKNOWN이 아니고 available. */
  known: boolean;
  /** 백엔드의 판정 문장(verdict.summary). 화면은 판정 글을 따로 만들지 않습니다. */
  summary: string | null;
  asOf: string | null;
  /** 받지 못한 입력 이름(백엔드 verdict.missing 그대로). */
  missing: string[];
  tiles: RegimeTile[];
  /** 백엔드의 고지(임계치는 참고치 등, 응답 note 그대로). 없으면 null. */
  note: string | null;
};

/**
 * 국면 히어로 모델 — 판정 라벨·문장·기준일·받지 못한 입력·신호 타일 네 개(+ 백엔드가 더 보내면 그 뒤에).
 *
 * "3일 확정"은 여기 없습니다 — 응답에 확정 필드가 없고, 연속 일수를 화면에서 세면 알림 규칙(AlertRules.confirmedChanges:
 * 판정 불가 건너뛰기·같은 입력 기준일 묶음 세지 않기, QA-054)을 다시 구현하게 됩니다(ADR 0004).
 */
export function regimeHeroModel(response: RegimeResponse | null | undefined): RegimeHeroModel {
  const verdict = response?.verdict;
  const signals = verdict?.signals ?? [];
  const tiles = REGIME_SLOTS.map((slot) =>
    regimeTile(slot.id, slot.label, signals.find((signal) => signal.id === slot.id), slot.format));
  for (const signal of signals) {
    if (!REGIME_SLOTS.some((slot) => slot.id === signal.id)) {
      tiles.push(regimeTile(signal.id, signal.label, signal, (value) => formatNumber(value, 2)));
    }
  }
  return {
    label: presentText(verdict?.label) ?? "판정 불가",
    known: Boolean(response?.available) && verdict !== undefined && verdict.code !== "UNKNOWN",
    summary: presentText(verdict?.summary),
    asOf: presentText(response?.asOf),
    missing: (verdict?.missing ?? []).filter((name) => presentText(name) !== null),
    tiles,
    note: presentText(response?.note),
  };
}

// ---------------------------------------------------------------- ③ 시장 카드 행

/**
 * 카드 한 장의 출처 글 — 수집기가 붙인 출처가 우선이고, 예전 저장본(출처 없음)은 티커로 채웁니다. 비공식 참고 시세는 "· 참고 시세"를
 * 붙입니다(/macro 화면 itemSource와 같은 규칙 — 4단계에서 /macro를 옮길 때 하나로 합칩니다).
 */
export function macroItemSource(item: Pick<MacroItem, "source" | "ticker" | "isReference">): string | null {
  const ticker = presentText(item.ticker);
  const source = presentText(item.source) ?? (ticker ? `Yahoo Finance (${ticker})` : null);
  if (!item.isReference) return source;
  return source ? `${source} · 참고 시세` : "참고 시세";
}

/**
 * 장 상태를 판정할 시계 — 보는 시각(화면이 1분마다 갱신, useMinuteClock)·그해 한국 공휴일(천문연, 없으면 내장 표)·
 * 카드를 받은 저장본 수집 시각(멈춘 체결을 휴장으로 추정할 때 씀). `now`가 null이면(첫 렌더) 장 상태를 모릅니다.
 */
export type MarketClock = {
  now: Date | null;
  krOfficial?: readonly string[] | null;
  collectedAt?: string | null;
};

/** 출처 배지에 붙일 장 상태 글과 지연(분). */
export type CardSession = { label: string | null; delayMin: number | null };

/**
 * 카드 한 장의 장 상태와 지연 — /macro의 SessionBadge와 같은 규칙(ADR 0017 결정 6, PRINCIPLES "지표 카드의 개장/마감 배지").
 *
 * - 지연은 장이 열려 있을 때만 뜻이 있습니다. 열려 있으면 "개장" + 지연("개장 · 실시간"), 닫혀 있으면 "마감"·"휴식"·"휴장"·
 *   "휴장 추정"만 적고 지연은 적지 않습니다(값이 언제 것인지는 시각이 말함). 닫힌 장의 이틀 지난 종가에 '실시간'을 찍지 않습니다.
 * - 시간표를 모르는 시장이면 지연만 적습니다.
 * - 보는 시각을 아직 모르면(첫 렌더) 둘 다 비웁니다 — 닫힌 장에 '실시간'을 잠깐이라도 찍지 않습니다.
 * - 이어받은 값(isStale)·수집 실패에는 지연을 붙이지 않습니다(그 지연은 지금 시세의 것이 아님, lib/macroCards categoryDelay와 같음).
 */
export function macroCardSession(
  item: Pick<Partial<MacroItem>, "market" | "lastTs" | "delayMinutes" | "isStale" | "status">,
  clock: MarketClock,
): CardSession {
  if (!clock.now) {
    return { label: null, delayMin: null };
  }
  const delay = item.status === "fail" || item.isStale === true ? null : finite(item.delayMinutes);
  const status = sessionStatus(
    item.market,
    clock.now,
    clock.krOfficial,
    tradeTimeFrom(item.lastTs),
    tradeTimeFrom(clock.collectedAt),
    tradeDayFrom(item.lastTs),
  );
  if (!status) {
    return { label: null, delayMin: delay };
  }
  return { label: status.label, delayMin: status.state === "open" ? delay : null };
}

/**
 * 수집기 deltaStr("-0.007 (-0.14%)")의 변화량 소수 자릿수. 수집기가 카드마다 자릿수를 정하므로(금리 셋째, 지수 둘째)
 * 홈도 그 자릿수로 찍습니다 — 0.007을 "0.01"로, 0.004를 "0.00"으로 뭉개지 않습니다. 숫자로 시작하지 않으면("N/A") null.
 */
export function deltaDigits(deltaStr: string | null | undefined): number | null {
  const match = /^\s*[+\-−]?[\d,]+(?:\.(\d+))?/.exec(deltaStr ?? "");
  return match ? (match[1]?.length ?? 0) : null;
}

/**
 * 매크로 카드 → 자산 행.
 *
 * - 값은 수집기의 priceStr(자릿수를 수집기가 정함), "N/A"면 "—". 수집 실패(status "fail")는 값·변화를 비우고 경고 "수집 실패".
 * - 변화는 delta·pct 숫자 그대로 — null이면 칩을 생략합니다("N/A" deltaStr을 0으로 읽지 않음). 변화량 자릿수는 deltaStr을 따릅니다.
 * - 출처 배지는 "출처 · 장 상태 · 지연 · 시각" 하나(카드마다 배지 하나 — ADR 0017 결정 6). 장 상태·지연 규칙은 `macroCardSession`.
 *   장이 닫혀 배지에 적지 않은 지연은 툴팁(provenanceTitle)에 둡니다 — /macro 장 상태 배지의 툴팁과 같은 규칙(이어받은 값·실패는 없음).
 * - 이어받은 값은 "이전 값" 배지 + 사유(수집기가 비우면 "수집 실패" — cardNotices와 같음).
 * - 추정(isEstimated)·경고(warning)는 있으면 그대로 넘깁니다(배지는 반드시 보임).
 */
export function macroCardRow(item: MacroItem, clock: MarketClock, href: string = MARKET_HREF): HomeRow {
  const failed = item.status === "fail";
  const stale = item.isStale === true;
  const market = item.market ? (MARKETS[item.market]?.name ?? null) : null;
  const session = macroCardSession(item, clock);
  // 장 상태를 아는데 배지에 지연이 빠졌으면 닫힌 장입니다(열린 장이면 macroCardSession이 지연을 넘김).
  const closedDelay = session.label !== null && session.delayMin === null && !failed && !stale ? delayLabel(finite(item.delayMinutes)) : null;
  const digits = failed ? null : deltaDigits(item.deltaStr);
  return {
    id: item.key,
    name: item.name,
    sub: joinPresent([item.ticker, market]),
    value: failed ? null : finite(item.price),
    valueText: failed ? null : (item.priceStr ?? null),
    change: failed ? null : finite(item.delta),
    changePct: failed ? null : finite(item.pct),
    ...(digits === null ? {} : { changeDigits: digits }),
    asOf: presentText(item.lastTs),
    delayMin: session.delayMin,
    source: joinPresent([macroItemSource(item), session.label]),
    provenanceTitle: closedDelay ? `시세 ${closedDelay}(출처 기준) — 장이 닫혀 있어 배지에는 적지 않습니다` : null,
    isEstimated: item.isEstimated === true,
    isStale: stale,
    staleReason: stale ? (presentText(item.staleReason) ?? "수집 실패") : null,
    warning: joinPresent([failed ? "수집 실패" : null, item.warning]),
    href,
  };
}

export type MarketGroup = { id: string; title: string; rows: HomeRow[] };

/**
 * 매크로 개요의 범주 순서 그대로 범주별 행 묶음. 제목 앞 그림 문자는 뗍니다(카드 제목에 아이콘을 쓰지 않음). 응답이 없으면 빈 목록.
 * 장 상태의 멈춤 판정에 쓰는 수집 시각은 개요의 collectedAtKst입니다(/macro SessionBadge와 같음).
 */
export function marketGroups(
  overview: Pick<MacroOverview, "categories" | "collectedAtKst"> | null | undefined,
  clock: Omit<MarketClock, "collectedAt">,
  href: string = MARKET_HREF,
): MarketGroup[] {
  const withCollected: MarketClock = { ...clock, collectedAt: overview?.collectedAtKst ?? null };
  return (overview?.categories ?? []).map((category: MacroCategory) => ({
    id: category.id,
    title: withoutLeadingIcon(category.title) || category.title,
    rows: (category.items ?? []).map((item) => macroCardRow(item, withCollected, href)),
  }));
}

// ---------------------------------------------------------------- ② 모의매매(미국·한국)

/** 정기 작업이 꺼진 사본에서 홈이 적는 안내(로컬 v2는 PAPER_ENABLED=false 고정 — 상태는 AWS 한 곳에만). */
export const PAPER_DISABLED_NOTE = "정기 작업 꺼짐(PAPER_ENABLED=false) — 이 화면은 읽기 전용 사본";

/**
 * 두 책을 견주지 않는다는 문구 — 홈 히어로 탭마다(미국·한국 모두) 적습니다(2단계 명세 §3·§6, K40). 같은 문장이 한국 개요의 한계 문구에도
 * 있습니다(서버 — §6 순서의 여덟째 줄).
 */
export const PAPER_COMPARE_NOTE =
  "미국·한국 책은 출발일·비용 모형·체결 시점·스탑 집행·통화가 달라 수익률을 서로 비교하지 않습니다";

/** 한국 탭의 계좌 행이 가는 화면 — 모의매매(한국) 개요. */
export const PAPER_KR_HREF = paperMarketPath("KR");

/** 홈의 계좌 행 — 모의매매 개요와 같은 행 규칙(lib/paperOverview bookAssetRow) + 모의매매 화면으로 가는 링크. */
export type PaperHomeRow = BookRow & { href: string };

export type PaperHomeModel = {
  /** 이 모델의 시장(히어로 탭). */
  market: PaperMarketCode;
  /** 장부를 읽을 수 있는가(테이블이 없으면 false). */
  available: boolean;
  /** 장부를 못 읽거나 계좌가 없을 때의 안내. 행이 있으면 null. */
  message: string | null;
  /** 히어로 값이 무엇인지 — "Claude 계좌 순자산"(구역 제목에도 있지만, 평가 시각 줄에 서버가 붙인 계좌 이름으로 다시 적습니다). */
  heroCaption: string;
  /** Claude 계좌 순자산(미국 달러 소수 둘째 · 한국 원 정수). 모르면 null("—"). */
  heroValueText: string | null;
  heroUnit: string;
  /** Claude 계좌 출발 대비 수익률(백엔드 returnPct). 일간 변화 필드는 응답에 없어 만들지 않습니다. */
  heroReturnPct: number | null;
  /** 히어로 순자산의 평가 시각 — Claude 계좌의 마지막 관측(KST). 모르면 null("—"). 정기 작업이 켜져 있어도 늘 보입니다. */
  heroAsOf: string | null;
  heroStale: boolean;
  heroStaleReason: string | null;
  rows: PaperHomeRow[];
  /** "출발 2026-10-23 · 처음 현금 100,000 달러 · 변화율은 출발 대비"(한국은 "… 100,000,000원 …"). */
  startLine: string;
  /** 정기 작업이 꺼져 있으면 그 안내, 아니면(켜짐·모름) null. */
  disabledNote: string | null;
  /** 한국 정기 작업이 쉬는 사유(서버 dormantReason) — 계좌 행이 있을 때만(행이 없으면 message가 그 사유). 미국은 늘 null. */
  dormantNote: string | null;
  /** 두 책을 견주지 않는다는 문구 — 탭마다 같은 글(PAPER_COMPARE_NOTE). */
  compareNote: string;
};

/** 모든 계좌의 처음 현금이 같으면 그 값, 다르거나 하나라도 모르면 null(한 숫자로 적을 수 없음). */
function sharedInitialCash(books: readonly PaperBookSummary[]): number | null {
  const values = books.map((book) => finite(book.initialCash));
  const first = values[0];
  return first !== undefined && first !== null && values.every((value) => value === first) ? first : null;
}

/**
 * 모의매매 히어로 모델 — Claude 계좌 순자산(히어로)·평가 시각·네 계좌 행·출발 줄·정기 작업 꺼짐 안내·두 책 비교하지 않음 문구.
 *
 * - 행: 모의매매 개요의 계좌 행과 같은 규칙(lib/paperOverview bookAssetRow — 이름·종류·상태·소개, 순자산, 출발 대비 수익률,
 *   가격 없는 보유·늦은 관측치의 "이전 값" + 사유, 사후 체결 대기 경고)에 링크만 더합니다. 규칙을 두 곳에 두지 않습니다(ADR 0004).
 * - 히어로의 이전 값 배지는 Claude 계좌 행의 것 그대로입니다.
 * - 처음 현금은 상태 응답(설정값)이 우선이고, 없으면 계좌들의 값이 모두 같을 때만 그 값.
 * - 한국(`market` "KR" — 2단계 명세 §4-16): 같은 규칙을 원 단위 정수로(한국 Claude 계좌 순자산·처음 현금 "100,000,000원"), 행 링크는 /paper/kr,
 *   사후 체결 대기 경고 없음(bookAssetRow 한국 규칙). 정기 작업이 쉬면 그 사유 — 계좌가 없으면 안내 자리에, 있으면 행 아래 한 줄.
 *   미국 모델은 인자 없이 예전 그대로입니다(두 책 비교하지 않음 문구만 더함).
 */
export function paperHomeModel(
  overview: PaperOverviewResponse | null | undefined,
  status: PaperStatusResponse | null | undefined,
  options: { market?: PaperMarketCode; href?: string } = {},
): PaperHomeModel {
  const market = options.market ?? "US";
  const korea = market === "KR";
  const href = options.href ?? (korea ? PAPER_KR_HREF : PAPER_HREF);
  const available = overview?.available === true;
  const books = available ? (overview?.books ?? []) : [];
  const context = available
    ? { pendingBackfill: overview?.pendingBackfill ?? [], quotes: overview?.quotes ?? null, ...(korea ? { market } : {}) }
    : {};
  const rows: PaperHomeRow[] = books.map((book) => ({ ...bookAssetRow(book, context), href }));

  const claude = books.find((book) => book.kind === "CLAUDE") ?? null;
  const claudeRow = claude ? rows.find((row) => row.id === claude.code) : undefined;
  const nav = finite(claude?.nav);
  const observed = presentText(claude?.lastObservedAtKst);

  const dormant = korea && available ? presentText(overview?.dormantReason) : null;
  let message: string | null = null;
  if (overview && !available) {
    message = presentText(overview.message) ?? "모의매매 장부를 아직 읽을 수 없습니다.";
  } else if (available && rows.length === 0) {
    message = dormant
      ? `한국 책이 쉬고 있습니다 — ${dormant}`
      : korea
        ? "아직 한국 계좌가 없습니다 — 모의매매(한국) 화면에서 한국 초기화를 합니다."
        : "아직 계좌가 없습니다 — 모의매매 화면에서 초기화합니다.";
  }

  const startDate = presentText(overview?.startDate) ?? presentText(status?.startDate);
  const initialCash = finite(status?.initialCash) ?? sharedInitialCash(books);
  const cashText = korea ? formatMoney(initialCash, "KR") : formatDollars(initialCash, 0);
  const startLine = `출발 ${startDate ?? EMPTY} · 처음 현금 ${cashText} · 변화율은 출발 대비`;

  return {
    market,
    available,
    message,
    heroCaption: `${presentText(claude?.label) ?? (korea ? "한국 Claude 계좌" : "Claude 계좌")} 순자산`,
    heroValueText: nav === null ? null : formatNumber(nav, korea ? 0 : 2),
    heroUnit: marketMeta(market).unitLabel,
    heroReturnPct: finite(claude?.returnPct),
    heroAsOf: observed === null ? null : formatKst(observed),
    heroStale: claudeRow?.isStale === true,
    heroStaleReason: claudeRow?.staleReason ?? null,
    rows,
    startLine,
    disabledNote: status?.enabled === false ? PAPER_DISABLED_NOTE : null,
    dormantNote: dormant && rows.length > 0 ? `한국 정기 작업이 쉬고 있습니다 — ${dormant}` : null,
    compareNote: PAPER_COMPARE_NOTE,
  };
}

// ---------------------------------------------------------------- ④ 알림 요약

/** 숫자 + 단위 글("3건"). 모르면 null — 화면이 `<Empty />`("—" + 읽어 주는 "값 없음")를 그립니다(0으로 적지 않음). */
function countText(value: number | null, unit: string): string | null {
  return value === null ? null : formatWithUnit(value, 0, unit);
}

/** 읽지 않은 알림 수 글 — "3건", 모르면(읽는 중·실패) null. 지난 사건(late)은 백엔드가 세지 않습니다(docs/API.md). */
export function unreadText(data: { unread?: number | null } | null | undefined): string | null {
  return countText(finite(data?.unread), "건");
}

export type AlertSummaryRow = {
  id: number;
  title: string;
  occurredOn: string;
  read: boolean;
  /** 발생 3일 뒤에 들어온 '지난 사건' — 읽지 않은 수에 세지 않습니다. */
  late: boolean;
  /** 읽지 않은 수에 세는 알림인가(안 읽음이고 지난 사건이 아님) — 화면은 이것만 점·굵은 글씨로 강조합니다(/alerts와 같음). */
  unread: boolean;
  /** "지난 사건" · "읽음" · "안 읽음". */
  readLabel: string;
};

/** 최근 알림(최근 순, 백엔드 순서 그대로) 앞의 limit개 — 제목·발생일·읽음 여부(지난 사건은 따로). */
export function latestAlerts(inbox: InboxResponse | null | undefined, limit: number = HOME_ALERT_LIMIT): AlertSummaryRow[] {
  return (inbox?.items ?? []).slice(0, limit).map((item) => {
    const read = item.read === true;
    const late = item.late === true;
    return {
      id: item.id,
      title: presentText(item.title) ?? "(제목 없음)",
      occurredOn: formatDate(item.occurredOn),
      read,
      late,
      unread: !read && !late,
      readLabel: late ? "지난 사건" : read ? "읽음" : "안 읽음",
    };
  });
}

// ---------------------------------------------------------------- ⑤ 데이터 저장소 상태 한 줄

/** 상태 한 줄의 칸 하나 — "수집 태스크 오류" + "2건". 수를 모르면 text가 null(화면은 `<Empty />`). */
export type StoreStatusPart = { label: string; text: string | null };

export type StoreStatusModel = {
  /** 수집 태스크 오류 · 경고 · 누락 데이터셋. */
  parts: StoreStatusPart[];
  /** 수집기에 닿지 못했으면 그 안내(이때 오류·경고 수는 DB 실행 기록만으로 센 것). 아니면 null. */
  notice: string | null;
  /** 오류가 있으면 danger, 경고·누락 데이터셋·수집기 연결 안 됨이면 warn, 그 밖(없음·모름)은 neutral. 글이 본 뜻이고 색은 보조입니다. */
  tone: "danger" | "warn" | "neutral";
  /** 백엔드가 모은 시각(generatedAt, KST 표시). 모르면 null. */
  checkedAt: string | null;
};

/** 수집기에 닿지 못했을 때의 안내(/status 오류·경고 로그의 경고와 같은 뜻). */
export const COLLECTOR_UNREACHABLE_NOTE = "수집기 연결 안 됨 — DB 기록만";

/**
 * 수집 오류·경고·누락 데이터셋 수(/api/status/issues counts — 태스크마다 최근 결과가 error인 수, ok·running이 아닌 나머지 수,
 * 기대 목록에 없는 데이터셋 수).
 *
 * 수집기에 닿지 못하면 백엔드는 DB 실행 기록만으로 셉니다 — 수집기가 멈추면 새 실패가 쌓이지 않아 0/0이 됩니다. 그래서 그때는
 * 안내와 warn 색을 붙이고, 누락 데이터셋은 모름("—")으로 둡니다(/status IssuesPanel·QA-102와 같은 규칙 — 예전 백엔드는 이때도 0을 보냄).
 */
export function storeStatusModel(issues: StatusIssuesResponse | null | undefined): StoreStatusModel {
  const errors = finite(issues?.counts?.errors);
  const warnings = finite(issues?.counts?.warnings);
  const unreachable = issues?.collectorReachable === false;
  const missing = unreachable ? null : finite(issues?.counts?.missingDatasets);
  const checked = presentText(issues?.generatedAt);
  let tone: StoreStatusModel["tone"] = "neutral";
  if (errors !== null && errors > 0) {
    tone = "danger";
  } else if ((warnings !== null && warnings > 0) || (missing !== null && missing > 0) || unreachable) {
    tone = "warn";
  }
  return {
    parts: [
      { label: "수집 태스크 오류", text: countText(errors, "건") },
      { label: "경고", text: countText(warnings, "건") },
      { label: "누락 데이터셋", text: countText(missing, "개") },
    ],
    notice: unreachable ? COLLECTOR_UNREACHABLE_NOTE : null,
    tone,
    checkedAt: checked ? formatKst(checked) : null,
  };
}
