/**
 * 홈(/) 화면의 표시 규칙 — React를 모르는 순수 함수(ADR 0004).
 *
 * 숫자는 전부 백엔드·수집기가 보낸 값입니다(국면 판정·신호 값, 계좌 순자산·출발 대비 수익률·최근 변화, 매크로 카드 시세·변화, 알림 수,
 * 수집 오류·경고 수, 끊긴 출처). 여기서는 고르고, 이름을 붙이고, KPI 타일·표 행·자산 행 모양으로 옮기기만 합니다 — 판정 글을 지어내거나
 * 일간 변화처럼 응답에 없는 숫자를 빼기로 만들지 않습니다. 모르는 값은 null(화면 "—")이고 0으로 채우지 않습니다.
 */
import { indicatorHref } from "./detail";
import { delayLabel, EMPTY, formatDate, formatKst, formatNumber, formatSignedMinus, formatWithUnit, withoutLeadingIcon } from "./format";
import type { InfoSourcesResponse } from "./info";
import { MARKETS, sessionStatus, tradeDayFrom, tradeTimeFrom } from "./marketSessions";
import { TABS } from "./nav";
import { bookCard, formatDollars, isTimedBook, withParticle } from "./paper";
import { formatMoney, marketMeta, type PaperMarketCode } from "./paperMarket";
import { currentSource, currentView } from "./paperCurrent";
import { bookAssetRow, bookStale } from "./paperOverview";
import { assetMonogram, assetValueText } from "./patternRows";
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
 * 자동 갱신 간격(ms) — 기존 화면의 간격을 그대로 따릅니다(국면 /regime 5분, 모의매매 /paper 1분, 알림 레이아웃 5분, 상태 /status 1분,
 * 끊긴 출처는 셸의 수집 끊김 안내 띠와 같은 5분 — 같은 경로라 동시에 나가면 요청 하나).
 * 매크로는 5분입니다 — /macro의 기본 60초(=live=true, 신선도 기준 60초)를 쓰면 백엔드가 Yahoo 수집을 그만큼 자주 깨웁니다(429 이력).
 */
export const HOME_REFRESH_MS = {
  regime: 300_000,
  macro: 300_000,
  paper: 60_000,
  alerts: 300_000,
  storeStatus: 60_000,
  sources: 300_000,
} as const;

/** 국면 이력 기간 — /regime 화면의 기본(5년)과 같게 둬 백엔드 응답 캐시(analytics.regime:5)를 함께 씁니다. */
export const HOME_REGIME_YEARS = 5;

/** 알림 요약에 보일 최근 알림 수. */
export const HOME_ALERT_LIMIT = 3;

/** 매크로 지표 전체 표 화면 — '매크로 지표 전체 보기'(홈 시장 패널·지표를 찾지 못한 지표 상세)가 갑니다. 행 하나는 그 지표의 상세(indicatorHref)로 갑니다. */
export const MARKET_HREF = "/macro";

/**
 * 모의매매 행이 가는 화면 — 셸의 모의매매 탭과 같은 곳(lib/nav TABS). 미국 책 화면이 /paper/us로 옮겨 가면 탭 href와 함께 따라갑니다
 * (탭보다 먼저 /paper/us를 박으면 그 경로가 생기기 전까지 404).
 */
export const PAPER_HREF = TABS.find((tab) => tab.key === "paper")?.href ?? "/paper";

/**
 * 홈 시장 표 한 줄 — components/patterns `AssetRowData`와 같은 모양(lib는 components를 가져오지 않으므로 여기 따로 적음).
 * 변화를 모르면 null(칩 생략), 값을 모르면 value·valueText 둘 다 null("—"). 계좌 손익 표의 줄은 `PaperPnlRow`.
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
  /** 왼쪽 아바타의 모노그램(티커 앞 글자 — `assetMonogram`). 모르면 null(아바타 칸 없음). */
  avatarText?: string | null;
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
 * 방향이 뜻을 가진 셋(역전·긴축·유입)은 부호를 붙입니다 — 부호 규칙은 /regime 판정 기록 표(lib/regime.ts)와 같고, 음수 글자는 −(U+2212)입니다
 * (같은 홈 화면의 변화 칩·KPI와 같은 글자 — 명세 D4, QA-600). /regime 표의 음수 글자는 P5a에서 맞춥니다.
 */
const REGIME_SLOTS: readonly { id: string; label: string; format: (value: number) => string }[] = [
  { id: "curve", label: "장단기 금리차 10Y-3M", format: (value) => formatSignedMinus(value, 2).text },
  { id: "nfci", label: "시카고 연준 금융상황지수", format: (value) => formatSignedMinus(value, 3).text },
  { id: "hyOas", label: "하이일드 스프레드", format: (value) => formatNumber(value, 2) },
  { id: "liquidity", label: "연준 순유동성 4주 변화", format: (value) => formatSignedMinus(value, 3).text },
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
 * 국면 모델(홈 국면 패널·KPI 띠의 국면 타일 — 이름의 Hero는 옛 국면 히어로 때의 것) — 판정 라벨·문장·기준일·받지 못한 입력·신호 네 자리(+ 백엔드가 더 보내면 그 뒤에).
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
 * - 아바타는 티커 앞 글자(`assetMonogram` — 영문 티커가 없으면 이름 첫 글자). 장식이라 뜻은 이름이 나릅니다.
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
    avatarText: assetMonogram({ name: item.name, ticker: item.ticker }),
  };
}

export type MarketGroup = { id: string; title: string; rows: HomeRow[] };

/**
 * 매크로 개요의 범주 순서 그대로 범주별 행 묶음. 제목 앞 그림 문자는 뗍니다(카드 제목에 아이콘을 쓰지 않음). 응답이 없으면 빈 목록.
 * 장 상태의 멈춤 판정에 쓰는 수집 시각은 개요의 collectedAtKst입니다(/macro SessionBadge와 같음).
 * 행이 가는 곳은 {@code href}를 주면 모든 행이 그곳, 주지 않으면 행마다 그 지표의 상세(/markets/i/<키> — 사용자 요청 2026-11-02).
 */
export function marketGroups(
  overview: Pick<MacroOverview, "categories" | "collectedAtKst"> | null | undefined,
  clock: Omit<MarketClock, "collectedAt">,
  href?: string,
): MarketGroup[] {
  const withCollected: MarketClock = { ...clock, collectedAt: overview?.collectedAtKst ?? null };
  return (overview?.categories ?? []).map((category: MacroCategory) => ({
    id: category.id,
    title: withoutLeadingIcon(category.title) || category.title,
    rows: (category.items ?? []).map((item) => macroCardRow(item, withCollected, href ?? indicatorHref(item.key))),
  }));
}

/**
 * 시장 묶음 표가 보일 묶음 — 고른 묶음이 목록에 있으면 그것, 아니면(처음·다시 읽은 저장본에서 그 범주가 사라짐) 첫 묶음. 묶음이 없으면 null.
 * 고른 키를 화면 상태로만 두므로 범주가 사라져도 빈 표가 남지 않습니다.
 */
export function pickMarketGroup(groups: readonly MarketGroup[], picked: string | null | undefined): MarketGroup | null {
  return groups.find((group) => group.id === picked) ?? groups[0] ?? null;
}

// ---------------------------------------------------------------- ② 모의매매(미국·한국)

/** 정기 작업이 꺼진 사본에서 홈이 적는 안내(로컬 v2는 PAPER_ENABLED=false 고정 — 상태는 운영 서버(Vultr) 한 곳에만, ADR 0023). */
export const PAPER_DISABLED_NOTE = "정기 작업 꺼짐(PAPER_ENABLED=false) — 이 화면은 읽기 전용 사본";

/**
 * 두 책을 견주지 않는다는 문구 — 홈 계좌 패널에 시장마다(미국·한국 모두) 적습니다(2단계 명세 §3·§6, K40). 같은 문장이 한국 개요의 한계 문구에도
 * 있습니다(서버 — §6 순서의 여덟째 줄).
 */
export const PAPER_COMPARE_NOTE =
  "미국·한국 계좌는 출발일·비용 모형·체결 시점·스탑 집행·통화가 달라 수익률을 서로 비교하지 않습니다";

/** 한국 탭의 계좌 행이 가는 화면 — 모의매매(한국) 개요. */
export const PAPER_KR_HREF = paperMarketPath("KR");

export type PaperHomeModel = {
  /** 이 모델의 시장(패널의 미국 | 한국 고르기). */
  market: PaperMarketCode;
  /** 장부를 읽을 수 있는가(테이블이 없으면 false). */
  available: boolean;
  /** 장부를 못 읽거나 계좌가 없을 때의 안내. 행이 있으면 null. */
  message: string | null;
  /** 계좌 손익 표의 줄(`paperPnlRows` — 개요의 계좌 순서 그대로). 장부를 읽을 수 없으면 빈 목록. */
  rows: PaperPnlRow[];
  /** 계좌 숫자의 출처 — 장부, 장중 추정인 행이 하나라도 있으면 장중 시세로 다시 평가했다는 말을 덧붙임(lib/paperCurrent currentSource). */
  source: string;
  /**
   * "출발 2026-10-23 · 처음 현금 100,000 달러 · 변화율은 출발 대비"(한국은 "… 100,000,000원 …"). 미국 Claude 계좌2가 다른 날 출발했으면 그 출발을
   * 덧붙입니다("… · Claude 계좌2는 2026-11-02 출발(앞으로 체결)" — 계좌2 행의 수익률은 계좌2 자기 출발 대비).
   */
  startLine: string;
  /** 정기 작업이 꺼져 있으면 그 안내, 아니면(켜짐·모름) null. */
  disabledNote: string | null;
  /** 한국 정기 작업이 쉬는 사유(서버 dormantReason) — 계좌 행이 있을 때만(행이 없으면 message가 그 사유). 미국은 늘 null. */
  dormantNote: string | null;
  /** 두 책을 견주지 않는다는 문구 — 시장마다 같은 글(PAPER_COMPARE_NOTE). */
  compareNote: string;
};

/** 모든 계좌의 처음 현금이 같으면 그 값, 다르거나 하나라도 모르면 null(한 숫자로 적을 수 없음). */
function sharedInitialCash(books: readonly PaperBookSummary[]): number | null {
  const values = books.map((book) => finite(book.initialCash));
  const first = values[0];
  return first !== undefined && first !== null && values.every((value) => value === first) ? first : null;
}

/**
 * 계좌 손익 표 패널 모델 — 계좌 줄(`paperPnlRows`)·출처·출발 줄·정기 작업 꺼짐/쉼 안내·두 책 비교하지 않음 문구.
 *
 * - 줄: 모의매매 개요의 계좌 행과 같은 규칙(lib/paperOverview bookAssetRow — 순자산, 출발 대비 수익률, 가격 없는 보유·늦은 관측치의 "이전 값" + 사유,
 *   사후 체결 대기 경고)과 지금 값 보기(lib/paperCurrent currentView — 최근 변화·단계 표기)를 표 칸으로 나눈 것입니다. 규칙을 두 곳에 두지 않습니다(ADR 0004).
 * - 처음 현금은 상태 응답(설정값)이 우선이고, 없으면 계좌들의 값이 모두 같을 때만 그 값.
 * - 한국(`market` "KR" — 2단계 명세 §4-16): 같은 규칙을 원 단위 정수로(처음 현금 "100,000,000원"), 행 링크는 /paper/kr, 사후 체결 대기 경고 없음
 *   (bookAssetRow 한국 규칙). 정기 작업이 쉬면 그 사유 — 계좌가 없으면 안내 자리에, 있으면 표 아래 한 줄. 미국 모델은 인자 없이도 같습니다.
 */
export function paperHomeModel(
  overview: PaperOverviewResponse | null | undefined,
  status: PaperStatusResponse | null | undefined,
  options: { market?: PaperMarketCode; href?: string } = {},
): PaperHomeModel {
  const market = options.market ?? "US";
  const korea = market === "KR";
  const available = overview?.available === true;
  const books = available ? (overview?.books ?? []) : [];
  const rows = paperPnlRows(overview, options);

  const dormant = korea && available ? presentText(overview?.dormantReason) : null;
  let message: string | null = null;
  if (overview && !available) {
    message = presentText(overview.message) ?? "모의매매 장부를 아직 읽을 수 없습니다.";
  } else if (available && rows.length === 0) {
    message = dormant
      ? `한국 계좌가 쉬고 있습니다 — ${dormant}`
      : korea
        ? "아직 한국 계좌가 없습니다 — 모의매매(한국) 화면에서 한국 초기화를 합니다."
        : "아직 계좌가 없습니다 — 모의매매 화면에서 초기화합니다.";
  }

  const startDate = presentText(overview?.startDate) ?? presentText(status?.startDate);
  const initialCash = finite(status?.initialCash) ?? sharedInitialCash(books);
  const cashText = korea ? formatMoney(initialCash, "KR") : formatDollars(initialCash, 0);
  // 미국 Claude 계좌2(시각 지정 계좌 — 앞으로 체결로 늦게, 출발일 S부터, 계좌2 명세 §4-1)는 출발일이 다르면 그 출발을 덧붙입니다. 출발일만 적으면 계좌2도
  // 개요의 출발일에 출발한 것처럼 읽히는데, 행의 수익률은 서버가 계좌2 자기 출발 대비로 셉니다. 시작 전(출발일 없음)·같은 날 출발이면 적지 않고, 다른 계좌
  // (사후 체결로 함께 출발한 미국 네 계좌·한국 계좌)의 줄은 예전 그대로입니다.
  const lateStarts = startDate === null ? [] : books
    .filter((book) => isTimedBook(book.code) && book.status !== "NOT_STARTED" && presentText(book.startedOn) !== null
      && book.startedOn !== startDate)
    .map((book) => `${withParticle(book.label, "은")} ${book.startedOn} 출발(앞으로 체결)`);
  const startLine = [`출발 ${startDate ?? EMPTY}`, `처음 현금 ${cashText}`, "변화율은 출발 대비", ...lateStarts].join(" · ");

  return {
    market,
    available,
    message,
    rows,
    source: currentSource(rows.some((row) => row.isEstimated), market),
    startLine,
    disabledNote: status?.enabled === false ? PAPER_DISABLED_NOTE : null,
    dormantNote: dormant && rows.length > 0 ? `한국 정기 작업이 쉬고 있습니다 — ${dormant}` : null,
    compareNote: PAPER_COMPARE_NOTE,
  };
}

// ---------------------------------------------------------------- ② 계좌 손익 표(운영자)

/**
 * 계좌 손익 표 한 줄 — 모의매매 개요의 계좌 행 규칙(lib/paperOverview `bookAssetRow`)과 지금 값 보기(lib/paperCurrent `currentView`)를 표 칸으로
 * 나눈 것입니다. 숫자는 모두 서버 값이고 화면은 계산하지 않습니다(출발 대비 수익률·최근 변화 모두 서버 값).
 */
export type PaperPnlRow = {
  /** 계좌 코드(행 키). */
  id: string;
  name: string;
  /** 종류 · 상태('규칙 · 운용 중') — 계좌 소개 한 줄은 모의매매 화면에 둡니다. */
  sub: string;
  /** 모의매매 화면(미국 /paper/us·한국 /paper/kr) — 계좌마다의 주소는 없습니다. */
  href: string;
  /** 순자산 글(미국 달러 소수 둘째 · 한국 원 정수 — 자산 행과 같은 assetValueText). 모르면 null("—"). */
  valueText: string | null;
  unit: string;
  /** 출발 대비 수익률(지금 값, 옛 응답이면 장부). 모르면 null(칩 없이 "—"). */
  returnPct: number | null;
  /** 최근 변화(서버 dayChangePct)와 그 이름('오늘'·'10-30 변화')·기준('10-29 잠정 대비'). 옛 응답·출발 전·모르면 null("—"). */
  day: { pct: number; label: string; base: string | null } | null;
  /** 값의 기준 — 단계 표기('장중 추정 23:58'·'10-30 확정', 옛 응답이면 '마지막 관측 …') · 덧붙임('장중가 1/2종목'). 출발 전·모르면 null. */
  basis: string | null;
  isEstimated: boolean;
  isStale: boolean;
  staleReason: string | null;
  /** 사후 체결 대기(미국 벤치마크가 출발일 종가를 기다림) — bookAssetRow 그대로. */
  warning: string | null;
};

/**
 * 계좌 손익 표의 행 — 개요의 계좌 순서 그대로. 장부를 읽을 수 없으면 빈 목록(안내는 paperHomeModel `message`).
 *
 * - 순자산·출발 대비 수익률·추정 배지·사후 체결 대기 경고는 모의매매 개요의 계좌 행과 같은 규칙(bookAssetRow)입니다 — 규칙을 두 곳에 두지 않습니다(ADR 0004).
 * - 최근 변화는 지금 값의 변화 한 줄(`currentView().day` — 서버 dayChangePct, 이름 '오늘'·'MM-DD 변화'와 기준 '… 대비')을 칸으로 나눈 것입니다.
 * - 기준 칸은 단계 표기와 덧붙임입니다. 기준 칸이 관측 시각을 이미 적으므로 이전 값 사유는 그 시각을 뺀 꼴(lib/paperOverview `bookStale`의
 *   "hero" 자리 — '관측 시각을 단계 표기로 이미 적는 자리')을 씁니다. 같은 시각을 한 줄에 두 번 적지 않습니다.
 * - 출발 전 계좌는 변화·기준이 없습니다(보조 글의 상태가 '시작 전'을 말함).
 */
export function paperPnlRows(
  overview: PaperOverviewResponse | null | undefined,
  options: { market?: PaperMarketCode; href?: string } = {},
): PaperPnlRow[] {
  if (overview?.available !== true) {
    return [];
  }
  const market = options.market ?? "US";
  const korea = market === "KR";
  const href = options.href ?? (korea ? PAPER_KR_HREF : PAPER_HREF);
  const session = overview.liveSession ?? null;
  const context = { pendingBackfill: overview.pendingBackfill ?? [], quotes: overview.quotes ?? null, ...(korea ? { market } : {}), session };
  return (overview.books ?? []).map((book) => {
    const asset = bookAssetRow(book, context);
    const view = currentView(book, { market, session });
    const card = bookCard(book, [], market);
    const stale = bookStale(book, context, "hero");
    const started = book.status !== "NOT_STARTED";
    const dayPct = started ? finite(view.day?.pct) : null;
    return {
      id: book.code,
      name: book.label,
      sub: joinPresent([card.kind, card.status.label]) ?? "",
      href,
      valueText: assetValueText(asset.value, asset.valueText),
      unit: asset.unit,
      returnPct: finite(asset.changePct),
      day: view.day && dayPct !== null ? { pct: dayPct, label: view.day.label, base: view.day.base } : null,
      basis: started ? joinPresent([view.stageLabel, ...view.notes]) : null,
      isEstimated: asset.isEstimated === true,
      isStale: stale.isStale,
      staleReason: stale.reason,
      warning: asset.warning,
    };
  });
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
      // 서버가 만든 제목 — 예전 알림의 국기·나침반 같은 그림 문자는 화면에서 뗍니다(/alerts와 같음)
      title: presentText(withoutLeadingIcon(item.title ?? "")) ?? "(제목 없음)",
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
  /**
   * 수 묶음의 톤 — 오류가 있으면 danger, 경고·누락 데이터셋이 있으면 warn, 그 밖(없음·모름)은 neutral. 글이 본 뜻이고 색은 보조입니다.
   * 수집기 연결 안 됨은 톤에 넣지 않습니다 — 그 주의는 안내(notice)가 아이콘과 함께 한 곳에서 나릅니다(QA-505, /status 배너와 같음).
   */
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
 * 주의 안내를 붙이고, 누락 데이터셋은 모름("—")으로 둡니다(/status IssuesPanel·QA-102와 같은 규칙 — 예전 백엔드는 이때도 0을 보냄).
 * 주의는 안내 한 곳이 나르고 수 묶음의 톤은 수로만 정합니다 — 수 묶음까지 주의로 그리면 한 줄에 주의 아이콘이 둘 서고 '오류 0건'
 * 앞에 주의 아이콘이 붙습니다(QA-505). /status도 이때 수는 중립이고 주의는 배너 한 곳입니다.
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
  } else if ((warnings !== null && warnings > 0) || (missing !== null && missing > 0)) {
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

// ---------------------------------------------------------------- ④ 끊긴 출처(운영자)

/** 끊긴 출처 한 줄 — 출처 이름 · 끊긴 종류('차단됨 — 잠시 멈춤'·'형식 바뀜' 등, 서버 글) · 사유 · 끊긴 시각. */
export type SourceIncidentRow = {
  key: string;
  label: string;
  kindLabel: string;
  reason: string | null;
  /** 끊긴 시각(KST 표시). 모르면 null. */
  since: string | null;
};

export type SourceIncidentsModel = {
  rows: SourceIncidentRow[];
  /** 줄이 없을 때의 글 — 끊긴 출처 없음, 또는 판정 기록·저장본이 없어 모름(끊긴 출처가 없다고 적지 않음). 줄이 있으면 null. */
  message: string | null;
};

/** 끊긴 출처가 없을 때의 글. */
export const NO_SOURCE_INCIDENTS = "끊긴 출처가 없습니다";

/**
 * 끊긴 출처(/api/info/sources incidents — 셸의 수집 끊김 안내 띠와 같은 응답) → 줄. 서버 순서 그대로이고, 띠를 닫았는지와 상관없이 지금 끊긴 출처를
 * 모두 적습니다(닫기는 띠의 일). 판정 기록이 없으면(로컬 PC — 차단 통과 수집은 운영 서버에서만) '끊긴 출처가 없습니다'라고 적지 않고 모른다고 적습니다.
 */
export function sourceIncidentsModel(response: InfoSourcesResponse | null | undefined): SourceIncidentsModel {
  if (!response) {
    return { rows: [], message: null };
  }
  if (response.available === false) {
    return { rows: [], message: "출처 판정 저장본을 아직 읽을 수 없습니다" };
  }
  const rows = (response.incidents ?? []).map((incident) => {
    const since = presentText(incident.since);
    return {
      key: incident.key,
      label: presentText(incident.label) ?? incident.task,
      kindLabel: presentText(incident.kindLabel) ?? incident.kind,
      reason: presentText(incident.reason),
      since: since ? formatKst(since) : null,
    };
  });
  if (rows.length > 0) {
    return { rows, message: null };
  }
  if (response.recorded === false) {
    return { rows, message: "출처 판정 기록이 없습니다 — 판정은 운영 서버에서만 합니다" };
  }
  return { rows, message: NO_SOURCE_INCIDENTS };
}

// ---------------------------------------------------------------- 맨 위 요약(KPI 띠)

/**
 * KPI 타일 하나 — components/patterns `KpiItem`과 같은 모양(lib는 components를 가져오지 않으므로 여기 따로 적음). 값을 모르면 `value: null`(화면 "—").
 */
export type HomeKpi = {
  key: string;
  label: string;
  value: string | number | null;
  format?: (value: number) => string;
  unit?: string | null;
  valueKind?: "number" | "label";
  neutral?: boolean;
  change?: { change?: number | null; changePct?: number | null; digits?: number; pctDigits?: number; caption?: string | null };
  status?: { tone: "ok" | "warn" | "danger"; text: string };
  note?: string | null;
  emptyReason?: string | null;
  pending?: boolean;
  pendingLines?: number;
  pendingLinesWide?: number;
  isEstimated?: boolean;
  isProxy?: boolean;
  isStale?: boolean;
  staleReason?: string | null;
  /** 출처 줄 — 출처(참고 시세·장 상태 포함)·시각·지연·툴팁(시장 타일 — 시장 묶음 표의 출처 배지와 같은 값). */
  source?: string | null;
  asOf?: string | null;
  delayMin?: number | null;
  provenanceTitle?: string | null;
  href?: string;
};

/** 경로 하나를 읽은 상태 — 값과 오류(useApi와 같은 칸 — lib는 hooks를 가져오지 않음). 값도 오류도 없으면 읽는 중입니다. */
export type HomeReadState<T> = { data: T | null; error: string | null };

/** KPI 띠가 읽는 것 — 홈 화면 훅이 읽은 응답 그대로(모의매매 값은 두지 않음 — 계좌 손익 표 패널이 따로 읽음). */
export type HomeKpiInput = {
  regime: HomeReadState<RegimeResponse>;
  macro: HomeReadState<MacroOverview>;
  unread: HomeReadState<{ unread?: number | null }>;
  /** 운영자만 — 운영자가 아니면 타일을 두지 않으므로 읽지 않은 상태 그대로 넘겨도 됩니다. */
  issues: HomeReadState<StatusIssuesResponse>;
};

/** KPI 띠의 시장 타일 넷 — 매크로 카드 키(수집기 indicators.py). 순서가 띠의 순서입니다. */
export const HOME_KPI_MARKET_KEYS = ["sp500", "kospi", "usdkrw", "us10y"] as const;

/**
 * 시장 타일의 짧은 이름과 단위 — 카드 이름('미국채 10년물 수익률(%)'·'코스피 (KOSPI)')은 140px 타일에서 두 줄로 접혀 짧게 적습니다.
 * 단위는 값 글(수집기 priceStr — 숫자만)에 없는 것을 이름 대신 붙입니다(원/달러 = 1달러의 원, 미국채 수익률 = %).
 */
const HOME_KPI_MARKET_LABELS: Record<(typeof HOME_KPI_MARKET_KEYS)[number], { label: string; unit: string | null }> = {
  sp500: { label: "S&P 500", unit: null },
  kospi: { label: "코스피", unit: null },
  usdkrw: { label: "원/달러", unit: "원" },
  us10y: { label: "미국채 10년물", unit: "%" },
};

/** 시장 타일 변화 칩의 캡션 — 무엇과 견준 변화인지(지표 상세 대상 머리와 같은 말). */
export const KPI_CHANGE_CAPTION = "전일 대비";

/** 읽기에 실패한 타일의 사유 — 오류 글과 다시 시도는 그 패널이 보입니다. */
export const KPI_READ_FAILED = "읽지 못함";

/** 저장본에 그 카드가 없을 때의 사유(수집기 카드 목록이 바뀌었거나 아직 수집 전). */
export const KPI_NOT_IN_SNAPSHOT = "저장본에 없음";

/**
 * 읽는 중 시장 타일의 자리 줄 수 — 값이 온 뒤의 변화 칩 1 · 이전 값 배지 1 · 출처 줄 3줄(타일이 좁은 두 칸 390·네 칸 1024~1060에서 접힌 줄 수) 자리입니다.
 * 한 줄의 칸은 가장 높은 타일까지 늘어나므로 가장 긴 시장 타일에만 주면 띠 높이가 맞습니다(국면·알림 타일은 자리표시 한 줄 — QA-598). 타일이 198px보다
 * 좁은 두 칸(띠 404px 미만 — 뷰포트 436 미만)·네 칸(띠 816px 미만)과 한 줄 배치(xl)는 출처 줄이 더 꺾여 이전 값 자료(배지 있음)가 187~208px이라 네 줄로
 * 줄이면 더 밀려 다섯 줄 그대로 둡니다(QA-604).
 */
const KPI_MARKET_PENDING_LINES = 5;
/**
 * 타일이 넓은 배치(띠 404px 이상의 두 칸 198~300px · 세 칸 sm~lg 192~312px · 띠 816px 이상의 네 칸 198px~ — components/patterns KpiStrip
 * `pendingLinesWide`)의 시장 타일 자리 줄 수 — 출처 줄이 덜 꺾여 읽은 뒤 타일이 QA 자료(이전 값 배지 있음) 154~187px, 새 자료(배지 없음) 128~178px라
 * 다섯 줄 자리표시(200px)가 두 자료 모두에서 컸습니다(QA-604). 네 줄이면 172px입니다(막대 수는 그대로 — 다섯째 막대를 그 배치에서 CSS로 감추고 넷째를 짧게).
 */
const KPI_MARKET_PENDING_LINES_WIDE = 4;
/**
 * 읽는 중 수집 오류 타일(운영자)의 자리 줄 수 — 값 뒤 상태 글 한 줄(경고·누락 수) 자리입니다. 일곱 타일의 마지막이라 두 칸(390)·세 칸(sm)에서는 마지막 줄에
 * 혼자 남아 그 줄 높이를 이 타일이 정합니다(QA 데이터 390 읽은 뒤 92px — 자리 줄이 없으면 64px, 하나면 88px). 다른 배치에서는 같은 줄의 시장 타일이 더 높습니다.
 */
const KPI_ERRORS_PENDING_LINES = 1;

/** 읽는 중·실패면 그 상태의 타일, 값이 있으면 null(그 다음을 부르는 쪽이 그림). `pendingLines`·`pendingLinesWide`는 읽는 중일 때만 넘깁니다. */
function kpiReadState(base: HomeKpi, read: HomeReadState<unknown>, pendingLines?: number, pendingLinesWide?: number): HomeKpi | null {
  if (read.data !== null) {
    return null;
  }
  if (read.error !== null) {
    return { ...base, value: null, emptyReason: KPI_READ_FAILED };
  }
  return { ...base, value: null, pending: true, ...(pendingLines ? { pendingLines } : {}), ...(pendingLinesWide ? { pendingLinesWide } : {}) };
}

function regimeKpi(read: HomeReadState<RegimeResponse>): HomeKpi {
  const base: HomeKpi = { key: "regime", label: "국면", value: null, valueKind: "label", href: "/regime" };
  const state = kpiReadState(base, read);
  if (state) return state;
  const model = regimeHeroModel(read.data);
  // 판정 불가는 판정 난 라벨과 같은 잉크로 그리지 않습니다(중립 — 국면 패널과 같음). 기준일을 모르면 줄을 두지 않습니다(패널이 '—'로 적음).
  return { ...base, value: model.label, neutral: !model.known, note: model.asOf ? `기준일 ${model.asOf}` : null };
}

function marketKpi(
  key: (typeof HOME_KPI_MARKET_KEYS)[number],
  read: HomeReadState<MacroOverview>,
  clock: Omit<MarketClock, "collectedAt">,
): HomeKpi {
  const { label, unit } = HOME_KPI_MARKET_LABELS[key];
  const href = indicatorHref(key);
  const base: HomeKpi = { key, label, value: null, href };
  const state = kpiReadState(base, read, KPI_MARKET_PENDING_LINES, KPI_MARKET_PENDING_LINES_WIDE);
  if (state) return state;
  const overview = read.data as MacroOverview;
  const item = (overview.categories ?? []).flatMap((category) => category.items ?? []).find((card) => card.key === key);
  if (!item) {
    return { ...base, emptyReason: KPI_NOT_IN_SNAPSHOT };
  }
  // 시장 묶음 표의 행과 같은 규칙(macroCardRow — 값은 수집기 priceStr, 변화는 delta·pct 그대로, 수집기 자릿수).
  const row = macroCardRow(item, { ...clock, collectedAt: overview.collectedAtKst ?? null }, href);
  const value = assetValueText(row.value, row.valueText);
  return {
    ...base,
    value,
    unit,
    // 변화의 기준을 캡션으로 — 수집기 delta·pct는 직전 종가 대비입니다(미국채 참고 시세는 TradingView 전일 종가, 없으면 FRED 공식 확정치 — 지표 상세 머리와 같은 말).
    change: { change: row.change, changePct: row.changePct, digits: row.changeDigits ?? 2, pctDigits: 2, caption: KPI_CHANGE_CAPTION },
    // 값이 없으면 경고('수집 실패' 등)가 그 사유, 값이 있으면 경고를 상태 글(아이콘 + 글)로.
    emptyReason: value === null ? row.warning : null,
    ...(value !== null && row.warning ? { status: { tone: "warn" as const, text: row.warning } } : {}),
    // 출처 줄은 시장 묶음 표의 '기준' 칸과 같은 값 — 출처(비공식 참고 시세면 '· 참고 시세')·장 상태·열린 장의 지연·시각, 닫힌 장의 지연은 툴팁.
    // 미국채 10년물은 수집기가 TradingView 참고 시세로 덮어써 시각이 수집 시각이므로(QA-137·138) 출처·지연 없이 시각만 적으면 그 시각의 공식 값으로 읽힙니다.
    source: row.source ?? null,
    asOf: presentText(row.asOf),
    delayMin: row.delayMin ?? null,
    provenanceTitle: row.provenanceTitle ?? null,
    isEstimated: row.isEstimated === true,
    isStale: row.isStale === true,
    staleReason: row.staleReason ?? null,
  };
}

function unreadKpi(read: HomeReadState<{ unread?: number | null }>): HomeKpi {
  const base: HomeKpi = { key: "unread", label: "읽지 않은 알림", value: null, unit: "건", format: (value) => formatNumber(value, 0), href: "/alerts" };
  return kpiReadState(base, read) ?? { ...base, value: finite(read.data?.unread) };
}

function issuesKpi(read: HomeReadState<StatusIssuesResponse>): HomeKpi {
  const base: HomeKpi = { key: "errors", label: "수집 오류", value: null, unit: "건", format: (value) => formatNumber(value, 0), href: "/status" };
  const state = kpiReadState(base, read, KPI_ERRORS_PENDING_LINES);
  if (state) return state;
  const model = storeStatusModel(read.data);
  // 상태 글은 그 글이 말하는 것의 톤으로만 — 경고·누락이 있으면 그 수, 수집기에 닿지 못하면 그 사실(둘 다 주의). 오류 수는 타일 값이 나르므로
  // 상태 글에 넣지 않고 위험 톤도 쓰지 않습니다(오류만 있을 때 '경고 0건 · 누락 0개'에 위험 아이콘·'오류:' 머리말이 붙던 것). 모두 0이고 닿으면 상태 글 없음.
  const warnings = finite(read.data?.counts?.warnings);
  const missing = model.notice ? null : finite(read.data?.counts?.missingDatasets);
  const flagged = (warnings !== null && warnings > 0) || (missing !== null && missing > 0);
  const parts = [
    flagged ? `경고 ${model.parts[1].text ?? EMPTY} · 누락 ${model.parts[2].text ?? EMPTY}` : null,
    model.notice ? "수집기 연결 안 됨" : null,
  ].filter((part): part is string => part !== null);
  return {
    ...base,
    value: finite(read.data?.counts?.errors),
    ...(parts.length > 0 ? { status: { tone: "warn" as const, text: parts.join(" · ") } } : {}),
  };
}

/**
 * 홈 맨 위 KPI 띠 — 국면 · S&P 500 · 코스피 · 원/달러 · 미국채 10년물 · 읽지 않은 알림 · 수집 오류(운영자만). 타일마다 그 대상 화면 링크입니다.
 *
 * - 모의매매 값은 두지 않습니다 — 모의 자료는 계좌 손익 표 패널 하나만 읽습니다.
 * - 숫자는 응답 그대로(시장 타일은 시장 묶음 표와 같은 macroCardRow 규칙 — 값 priceStr·변화 delta/pct·추정·이전 값 배지·출처 줄). 모르면 "—"이고 0으로 적지 않습니다.
 * - 읽는 중이면 자리표시(pending), 읽지 못했으면 "—" + '읽지 못함'(오류 글과 다시 시도는 그 패널), 저장본에 카드가 없으면 "—" + '저장본에 없음'.
 */
export function homeKpiItems(
  input: HomeKpiInput,
  options: { owner: boolean; clock: Omit<MarketClock, "collectedAt"> },
): HomeKpi[] {
  return [
    regimeKpi(input.regime),
    ...HOME_KPI_MARKET_KEYS.map((key) => marketKpi(key, input.macro, options.clock)),
    unreadKpi(input.unread),
    ...(options.owner ? [issuesKpi(input.issues)] : []),
  ];
}
