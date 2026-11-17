/**
 * 시장 행·국면 모델 — 홈(/)·매크로(/macro)·국면(/regime)·지표 상세가 함께 쓰는 표시 규칙, React를 모르는 순수 함수(ADR 0004).
 *
 * lib/home에서 글자 그대로 옮겨 왔습니다(P5a 검토 — lib/home은 모의매매 모듈(paper·paperMarket·paperCurrent·paperOverview·paperRoutes)을 가져오므로,
 * 시장 화면이 lib/home을 가져오면 운영자 전용 모의매매 코드 chunk까지 첫 적재로 받았습니다). lib/home은 같은 이름으로 다시 내보냅니다.
 * 숫자는 전부 백엔드·수집기가 보낸 값이고, 모르는 값은 null(화면 "—")이며 0으로 채우지 않습니다.
 */
import { delayLabel, formatNumber, formatSignedMinus } from "./format";
import { MARKETS, sessionStatus, tradeDayFrom, tradeTimeFrom } from "./marketSessions";
import { assetMonogram } from "./patternRows";
import { presentText } from "./patterns";
import type { MacroItem, RegimeResponse, RegimeSignal } from "./types";

/** 매크로 지표 전체 표 화면 — '매크로 지표 전체 보기'(홈 시장 패널·지표를 찾지 못한 지표 상세)가 갑니다. 행 하나는 그 지표의 상세(indicatorHref)로 갑니다. */
export const MARKET_HREF = "/macro";

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
 * (같은 홈 화면의 변화 칩·KPI와 같은 글자 — 명세 D4, QA-600). /regime 화면의 판정 근거도 이 모델이고, 판정 기록·판정 성과도 같은 −입니다(QA-636).
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
 * 붙입니다(/macro 지표 표의 출처(lib/macroScreen macroIndicatorRow)·지표 상세도 이 함수를 씁니다).
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
 * 카드 한 장의 장 상태와 지연 — /macro 지표 표의 기준 칸·미리보기(lib/macroScreen macroIndicatorRow)도 이 함수를 씁니다(ADR 0017 결정 6, PRINCIPLES "지표 카드의 개장/마감 배지").
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
 * - 이어받은 값은 "이전 값" 배지 + 사유(수집기가 비우면 "수집 실패").
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
