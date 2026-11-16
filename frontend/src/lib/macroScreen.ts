/**
 * 매크로 화면(/macro)의 화면 모델 — 목차 항목, 지표 표의 묶음 줄과 미리보기 칸, 절마다의 KPI 띠 타일(작업대 화면 언어 P5a, ADR 0004 — React를 모름).
 *
 * 지표 줄은 홈 시장 표와 같은 규칙(lib/home `macroCardRow` — 값은 수집기 priceStr, 변화는 delta·pct 그대로, 출처·장 상태·지연·시각과 추정·이전 값)에
 * 실시간 시각·전일·전일값 출처·티커를 덧붙입니다. KPI 타일은 공용 KPI 띠(components/patterns KpiStrip)의 타일과 같은 모양의 값입니다(lib은 components를
 * 가져오지 않아 모양을 여기 따로 적음 — 구조가 같으면 그대로 넘어감). 모르는 값은 null('—')이고 0으로 채우지 않습니다. 음수 부호는 −(U+2212)입니다.
 */
import { indicatorHref } from "./detail";
import { delayLabel, EMPTY, formatKst, formatNumber, formatSampleWindow, formatSignedMinus, withMinusSign, withoutLeadingIcon } from "./format";
import { macroCardRow, macroCardSession, macroItemSource, type HomeRow, type MarketClock } from "./home";
import { categoryDelay } from "./macroCards";
import type { MacroCardView } from "./macroLive";
import { MACRO_SECTIONS } from "./marketSections";
import { presentText } from "./patterns";
import type { SectionIndexItem } from "./sectionIndex";
import { uniqueSources } from "./sources";
import type { AdvancedEntry, AdvancedIndicators, FxSeries, RiskEntry, RiskIndicators, SpreadBlock } from "./types";

// ---------------------------------------------------------------- KPI 타일

/** KPI 띠 타일 하나 — 공용 KpiStrip의 KpiItem과 같은 모양(쓰는 칸만). */
export type MacroKpi = {
  key: string;
  label: string;
  value: string | number | null;
  unit?: string | null;
  change?: { change?: number | null; changePct?: number | null; digits?: number; pctDigits?: number; caption?: string | null; unit?: string | null };
  status?: { tone: "ok" | "warn" | "danger"; text: string; srPrefix?: string };
  note?: string | null;
  source?: string | null;
  asOf?: string | null;
  emptyReason?: string | null;
  isEstimated?: boolean;
  isProxy?: boolean;
  isStale?: boolean;
  staleReason?: string | null;
};

/** 받지 못한 값의 사유 — 수집기·백엔드가 값을 주지 못함(available=false). */
export const COLLECT_FAILED = "수집 실패";

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 부호 없는 값 글(음수만 −) — 모르면 null. */
function plainValue(value: number | null | undefined, digits: number): string | null {
  const known = finite(value);
  return known === null ? null : withMinusSign(formatNumber(known, digits));
}

/** 부호 있는 값 글(양수 +·음수 −, 반올림해 0이면 부호 없음) — 모르면 null. 금리차처럼 부호가 곧 뜻인 값. */
function signedValue(value: number | null | undefined, digits: number): string | null {
  const known = finite(value);
  return known === null ? null : formatSignedMinus(known, digits).text;
}

// ---------------------------------------------------------------- 금리차

/** 금리차 한 쌍의 KPI — 공식 확정치(FRED) 둘과 스크래핑 참고 시세(TradingView) 셋(없으면 null). */
export type SpreadKpis = { official: MacroKpi[]; scraped: MacroKpi[] | null };

/**
 * 금리차 패널의 두 KPI 띠. 값은 셋째 자리·부호(+/−)·'%p', 변화는 변화 칩(셋째 자리·'%p'). 공식 값의 기준일은 시계열 마지막 날짜입니다.
 * 스크래핑 값이 이어받은 금리로 계산됐으면 스프레드 타일에 '이전 값' 배지(QA-060), 스프레드를 못 받았으면 '—'와 '수집 실패'.
 */
export function spreadKpis(block: SpreadBlock | null | undefined, pair: string, change: number | null): SpreadKpis {
  const points = block?.points ?? [];
  const lastDate = points.length > 0 ? points[points.length - 1].date : null;
  const fred = block ? `FRED ${block.longId} − ${block.shortId}` : "FRED";
  const official: MacroKpi[] = [
    {
      key: "official",
      label: `${pair} 스프레드`,
      value: signedValue(block?.latest, 3),
      unit: "%p",
      change: { change, digits: 3, unit: "%p", caption: "직전 확정치 대비" },
      source: fred,
      asOf: lastDate,
    },
    { key: "previous", label: "직전 확정치", value: signedValue(block?.previous, 3), unit: "%p", source: fred },
  ];
  const scraped = block?.scraped;
  if (!scraped) {
    return { official, scraped: null };
  }
  const tenor = (id: string | undefined) => (id ?? "").replace("DGS", "");
  return {
    official,
    scraped: [
      {
        key: "scraped",
        label: `${pair} 스프레드`,
        value: signedValue(scraped.spread, 3),
        unit: "%p",
        emptyReason: scraped.spread === null ? COLLECT_FAILED : null,
        change: { change: scraped.delta, digits: 3, unit: "%p", caption: "직전 대비" },
        source: "TradingView 참고 시세",
        isStale: scraped.isStale === true,
        staleReason: scraped.isStale ? "이전 금리 포함(수집 실패)" : null,
      },
      { key: "long", label: `미국채 ${tenor(block?.longId)}년물`, value: plainValue(scraped.longValue, 3), unit: "%" },
      { key: "short", label: `미국채 ${tenor(block?.shortId)}년물`, value: plainValue(scraped.shortValue, 3), unit: "%" },
    ],
  };
}

// ---------------------------------------------------------------- 신용·변동성

/** 위험 지표 다섯 — 화면 차례·이름·단위·자릿수. */
export const RISK_ENTRIES: readonly { key: keyof RiskIndicators; label: string; unit: string; digits: number }[] = [
  { key: "vix", label: "CBOE VIX (주식 변동성)", unit: "", digits: 2 },
  { key: "move", label: "MOVE (채권 변동성)", unit: "", digits: 2 },
  { key: "hyOas", label: "하이일드 스프레드 (HY OAS)", unit: "%p", digits: 2 },
  { key: "cpSpread", label: "3M 금융 CP 스프레드", unit: "%p", digits: 2 },
  { key: "stlfsi", label: "세인트루이스 연준 금융스트레스", unit: "pt", digits: 2 },
];

/** 위험 지표마다의 출처(타일 출처 줄). MOVE는 실제 ICE BofA MOVE가 아니라 ^TNX 변동성 기반 추정입니다. */
export const RISK_SOURCES: Readonly<Record<keyof RiskIndicators, string>> = {
  vix: "Yahoo Finance (^VIX)",
  move: "Yahoo Finance ^TNX 기반 추정",
  hyOas: "FRED BAMLH0A0HYM2 (ICE BofA 하이일드 OAS)",
  cpSpread: "FRED CPF3M − DGS3MO (계산)",
  stlfsi: "FRED STLFSI4",
};

/**
 * 신용·변동성 KPI 띠 — 값·단위·변화(직전 대비)·기준일·출처. 받지 못한 지표는 '—'와 '수집 실패'. 대리 지표(MOVE — isProxy)는 '대리 지표' 배지와
 * 주의 상태 글 '실제 지표가 아닙니다 — {출처 설명}'을 늘 보입니다.
 */
export function riskKpis(risk: Partial<RiskIndicators> | null | undefined): MacroKpi[] {
  return RISK_ENTRIES.map((entry) => {
    const item: RiskEntry | undefined = risk?.[entry.key];
    const available = item?.available === true;
    const unit = entry.unit || null;
    const asOf = presentText(item?.asOf);
    const proxyLabel = presentText(item?.sourceLabel);
    return {
      key: entry.key,
      label: entry.label,
      value: available ? plainValue(item?.value, entry.digits) : null,
      unit,
      emptyReason: available ? null : COLLECT_FAILED,
      change: { change: available ? item?.delta : null, digits: entry.digits, unit, caption: "직전 대비" },
      note: asOf ? `기준일 ${asOf}` : null,
      source: RISK_SOURCES[entry.key],
      isProxy: item?.isProxy === true,
      ...(item?.isProxy ? { status: { tone: "warn" as const, text: `실제 지표가 아닙니다${proxyLabel ? ` — ${proxyLabel}` : ""}` } } : {}),
    };
  });
}

// ---------------------------------------------------------------- 심화 지표

/**
 * 심화 지표 해석 색 → 상태 글의 톤(아이콘 + 글 — 값 글자색으로만 상태를 전하지 않음). 초록 정상, 노랑·주황 주의, 빨강 위험. 파랑(평탄·완화 등 중립)과
 * 모르는 색은 null — 상태 글을 톤 없이 메모에 적습니다. 위험은 '오류'가 아니라 시장 상태라 낭독기 머리말을 '주의: '로 둡니다(안내 상자 위험 톤과 같음).
 */
export function advancedStatus(entry: Pick<AdvancedEntry, "status" | "color">): MacroKpi["status"] | null {
  const text = presentText(entry.status);
  if (text === null) return null;
  switch (entry.color) {
    case "green":
      return { tone: "ok", text };
    case "yellow":
    case "orange":
      return { tone: "warn", text };
    case "red":
      return { tone: "danger", text, srPrefix: "주의: " };
    default:
      return null;
  }
}

/**
 * 심화 지표 KPI 띠 — 응답 차례(order) 그대로. 값은 지표 자릿수·단위, 변화는 직전 대비, 상태는 아이콘 + 글(톤이 없는 상태는 메모 앞에 '상태: …'),
 * 메모는 해석 글 다음에 '표본 백분위 · 표본 · 기준일'(표본을 함께 적어야 '3년 안의 중간'이 '역사적 중간'으로 읽히지 않음), 출처는 지표마다.
 * 받지 못한 지표는 '—'와 '수집 실패'(상태·표본은 적지 않음).
 */
export function advancedKpis(data: AdvancedIndicators | null | undefined): MacroKpi[] {
  if (!data) return [];
  return data.order
    .map((id) => data.latest[id])
    .filter((entry): entry is AdvancedEntry => Boolean(entry))
    .map((entry) => {
      const unit = entry.unit || null;
      if (!entry.available) {
        return { key: entry.id, label: entry.label, value: null, unit, emptyReason: COLLECT_FAILED, source: presentText(entry.source) };
      }
      const status = advancedStatus(entry);
      const percentile = finite(entry.percentile);
      const sample = percentile === null ? null : formatSampleWindow(entry.percentileFrom, entry.percentileCount, entry.percentileYears);
      const asOf = presentText(entry.asOf);
      const stats = [
        status === null && presentText(entry.status) ? `상태: ${presentText(entry.status)}` : null,
        percentile === null ? null : `표본 백분위 ${formatNumber(percentile, 1)}%`,
        sample ? `표본 ${sample}` : null,
        asOf ? `기준일 ${asOf}` : null,
      ].filter((part): part is string => part !== null);
      const note = [presentText(entry.note), stats.length > 0 ? stats.join(" · ") : null].filter((part): part is string => part !== null).join(" ");
      return {
        key: entry.id,
        label: entry.label,
        value: plainValue(entry.value, entry.digits),
        unit,
        change: { change: entry.delta, digits: entry.digits, unit, caption: "직전 대비" },
        ...(status ? { status } : {}),
        note: note || null,
        source: presentText(entry.source),
      };
    });
}

// ---------------------------------------------------------------- 환율 비교

/** 환율 비교의 고른 계열 KPI — 끝값(둘째 자리 — 위 지표 표와 같은 자릿수)·단위, 기간 변화율, 메모 '기준일 … · 최근 …'. */
export function fxKpis(series: readonly FxSeries[]): MacroKpi[] {
  return series.map((entry) => ({
    key: entry.id,
    label: entry.label,
    value: plainValue(entry.latest, 2),
    unit: presentText(entry.unit),
    change: { changePct: entry.changePct, pctDigits: 2, caption: "기간" },
    note: entry.baseDate ? `기준일 ${entry.baseDate} · 최근 ${entry.latestDate ?? EMPTY}` : null,
  }));
}

// ---------------------------------------------------------------- 지표 표

/** 지표 표의 줄 하나 — 홈 시장 표의 줄(macroCardRow)에 미리보기 칸을 덧붙인 것. */
export type MacroIndicatorRow = HomeRow & {
  /** 수집 실패(status fail) — 값·변화가 없고 사유 '수집 실패'. */
  failed: boolean;
  /** 전일 값 글(수집기 prevStr) — 모르면 null. */
  prevText: string | null;
  /** 전일 값의 출처(공식 확정치 등) — 없으면 null. */
  prevSource: string | null;
  ticker: string | null;
  /** 출처(참고 시세 표기 포함, 장 상태 없음) — 미리보기 '출처' 줄. */
  originSource: string | null;
  /** 장 상태와 지연 — '개장 · 실시간'·'마감'(지연은 열린 장만, /macro 장 상태 배지와 같은 규칙). 모르면 null. */
  sessionText: string | null;
  /** 기준 시각 — 실시간이면 '실시간 HH:MM:SS 수신|거래 · 세션', 아니면 카드 시각(formatKst). 모르면 null. */
  timeText: string | null;
  /** 예전 저장본(지연 칸 없음)의 알림 글(카드 note) — 지금 저장본은 null. */
  legacyNote: string | null;
  /** 카드 경고(선물 대신 지수 값·추정치·보정 실패 — 수집기 warning)만. 수집 실패는 값 칸이 '—'와 사유로 말하므로 넣지 않습니다(`warning`은 둘을 합친 글). */
  cardWarning: string | null;
  /** 실시간 값을 얹은 줄인가(ADR 0024 — 표시 전용). */
  live: boolean;
};

export type MacroIndicatorGroup = {
  /** 범주 id(응답 그대로). */
  id: string;
  /** 범주 절 닻 id — macroCategoryAnchor. */
  anchorId: string;
  /** 범주 이름(앞 그림 문자 뗌). */
  title: string;
  /** 부제 — 카드들의 시세 지연 요약(lib/macroCards categoryDelay). */
  subtitle: string | null;
  /** 출처 줄 — 카드 출처를 겹치지 않게 모은 것. */
  source: string | null;
  rows: MacroIndicatorRow[];
};

/** 범주 절 닻 id — 'macro-cat-{범주 id}'(소문자·숫자·하이픈만 — 다른 문자는 하이픈으로). */
export function macroCategoryAnchor(categoryId: string): string {
  return `macro-cat-${categoryId.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;
}

/** 실시간 시각 글 — 'HH:MM:SS 수신|거래 · 세션'(받은 시각인지 거래 시각인지를 함께 — TradingView는 거래 시각을 주지 않음). */
function liveTime(live: NonNullable<MacroCardView["live"]>): string {
  return `${live.at} ${live.received ? "수신" : "거래"}${live.session ? ` · ${live.session}` : ""}`;
}

function joinPresent(parts: readonly (string | null | undefined)[]): string | null {
  const kept = parts.map((part) => presentText(part)).filter((part): part is string => part !== null);
  return kept.length > 0 ? kept.join(" · ") : null;
}

/** 카드 하나 → 지표 표의 줄. 실시간을 얹은 카드는 출처 배지의 시각을 실시간 시각으로 바꿉니다(저장본 시각을 실시간 값의 시각으로 읽지 않게). */
export function macroIndicatorRow(item: MacroCardView, clock: MarketClock): MacroIndicatorRow {
  const row = macroCardRow(item, clock, indicatorHref(item.key));
  const failed = item.status === "fail";
  const session = macroCardSession(item, clock);
  const live = item.live !== undefined;
  const lastTs = presentText(item.lastTs);
  return {
    ...row,
    asOf: item.live ? liveTime(item.live) : row.asOf,
    failed,
    prevText: failed ? null : presentText(item.prevStr),
    prevSource: presentText(item.prevSource),
    ticker: presentText(item.ticker),
    originSource: macroItemSource(item),
    sessionText: joinPresent([session.label, delayLabel(session.delayMin)]),
    timeText: item.live ? `실시간 ${liveTime(item.live)}` : lastTs === null ? null : formatKst(lastTs),
    legacyNote: item.delayMinutes === undefined ? (presentText(item.note) ? withoutLeadingIcon(item.note as string) : null) : null,
    cardWarning: presentText(item.warning),
    live,
  };
}

/**
 * 매크로 개요의 범주 → 지표 표 묶음(응답 범주 차례 그대로). `categories`는 실시간 값을 얹은 카드(lib/macroLive macroCardView)이고, `clock`의
 * 수집 시각은 개요의 collectedAtKst입니다(장 상태의 멈춤 판정 — /macro 장 상태 배지와 같음). 응답이 없으면 빈 목록.
 */
export function macroIndicatorGroups(
  categories: readonly { id: string; title: string; note?: string | null; items: readonly MacroCardView[] }[] | null | undefined,
  clock: MarketClock,
): MacroIndicatorGroup[] {
  return (categories ?? []).map((category) => ({
    id: category.id,
    anchorId: macroCategoryAnchor(category.id),
    title: withoutLeadingIcon(category.title) || category.title,
    subtitle: categoryDelay({ ...category, items: [...category.items] }) ?? null,
    source: uniqueSources(category.items.map((item) => macroItemSource(item))) || null,
    rows: category.items.map((item) => macroIndicatorRow(item, clock)),
  }));
}

/** 줄 키 → 줄(미리보기 칸이 고른 키로 찾음). */
export function macroRowIndex(groups: readonly MacroIndicatorGroup[]): ReadonlyMap<string, MacroIndicatorRow> {
  return new Map(groups.flatMap((group) => group.rows.map((row) => [row.id, row] as const)));
}

// ---------------------------------------------------------------- 목차

/**
 * 매크로 화면 목차 — 지표(개수 = 카드 수, 하위 = 범주) · 환율 비교 · 장단기 금리차 · 신용·변동성 · 심화 지표 · 단독 차트 · 비공식 시세 · 경제 캘린더(운영자만).
 * 회원 일곱·운영자 여덟. 절 id는 lib/marketSections MACRO_SECTIONS. 개요를 아직 받지 못했으면(`groups` null) 지표 개수를 모르고 하위 칸이 없습니다.
 */
export function macroIndexItems(groups: readonly MacroIndicatorGroup[] | null, owner: boolean): SectionIndexItem[] {
  const total = groups === null ? null : groups.reduce((sum, group) => sum + group.rows.length, 0);
  const items: SectionIndexItem[] = [
    {
      id: MACRO_SECTIONS.indicators,
      label: "지표",
      count: total,
      children: (groups ?? []).map((group) => ({ id: group.anchorId, label: group.title, count: group.rows.length })),
    },
    { id: MACRO_SECTIONS.fx, label: "환율 비교" },
    { id: MACRO_SECTIONS.spreads, label: "장단기 금리차" },
    { id: MACRO_SECTIONS.risk, label: "신용·변동성" },
    { id: MACRO_SECTIONS.advanced, label: "심화 지표" },
    { id: MACRO_SECTIONS.single, label: "단독 차트" },
    { id: MACRO_SECTIONS.scraped, label: "비공식 시세" },
  ];
  if (owner) {
    items.push({ id: MACRO_SECTIONS.calendar, label: "경제 캘린더" });
  }
  return items;
}
