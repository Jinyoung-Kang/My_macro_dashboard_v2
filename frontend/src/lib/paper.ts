/**
 * 🧪 모의 알고리즘 매매 화면의 표기 — React를 모르는 순수 함수(ADR 0004).
 *
 * 숫자는 전부 백엔드가 계산해 보냅니다(순자산·수익률·통계·스탑 가격·비중). 여기서는 받은 값을 고르고,
 * 이름을 붙이고, 차트 행으로 늘어놓기만 합니다 — 화면에서 다시 계산하면 장부와 화면이 다른 숫자를 말하게 됩니다.
 * 모르는 값(null)은 "—"로 둡니다. 0으로 채우지 않습니다.
 */
import { EMPTY, formatKst, formatLatency, formatNumber, formatPercent, formatSigned, formatWithUnit } from "./format";
import { formatMoney, formatSharePriceFor, type PaperMarketCode } from "./paperMarket";
import type {
  PaperBookResetResult,
  PaperBookStatusResult,
  PaperBookSummary,
  PaperCalendarStatus,
  PaperClaudePreviewResult,
  PaperDecisionDetail,
  PaperDecisionSummary,
  PaperEarningsStatus,
  PaperFrameworkEngine,
  PaperFrameworkMaxIds,
  PaperFrameworkPrinciple,
  PaperFrameworkProposal,
  PaperFrameworkSaveResult,
  PaperFrameworkVersion,
  PaperFrameworkVersionSummary,
  PaperFundamentalsStatus,
  PaperNewsStatus,
  PaperGateIndicator,
  PaperGateThresholds,
  PaperInitialDecisionResult,
  PaperInitResult,
  PaperNote,
  PaperNoteCreateResult,
  PaperNoteKind,
  PaperOkResult,
  PaperOrder,
  PaperOverviewResponse,
  PaperOverviewSelection,
  PaperPosition,
  PaperProposalApproveResult,
  PaperProposeResult,
  PaperQuotesSummary,
  PaperRerankResult,
  PaperReviewDetail,
  PaperReviewSummary,
  PaperReviewVerdictCounts,
  PaperRunReviewResult,
  PaperRiskOutcome,
  PaperRiskResult,
  PaperRunDecisionResult,
  PaperSelectedFiler,
  PaperSelectionHistoryEntry,
  PaperSettingKey,
  PaperSettingsResponse,
  PaperSettingsSaveResult,
  PaperStats,
  PaperTrackRecordCandidate,
  PaperTrackRecordCollection,
  PaperTrackRecordCriteria,
  PaperTrackRecordGroupB,
  PaperTrackRecordPeriod,
} from "./types";

/**
 * 이 화면 숫자의 출처. 다른 화면은 lib/sources.ts에 모으지만, 모의 매매는 운영자 전용 실험 기능이라(다른 화면과 출처가 겹치지 않음) 이 파일에 둡니다
 * (sources.ts로 옮길지는 단계 4 마무리에서 정함).
 */
export const PAPER_SOURCES = {
  ledger: "대시보드 모의 장부 (PostgreSQL paper_*) — 체결가는 Yahoo Finance(yfinance) 지연 시세, 사후 체결은 그날 종가",
  quotes: "Yahoo Finance (yfinance) — 모의 매매 유니버스 일봉(장중 마지막 봉 = 지연 시세, 저장본 paper.quotes)",
  fundamentals: "SEC EDGAR XBRL Company Facts (data.sec.gov, 수집 상태 저장본 us.fundamentals.status) — Claude 계좌 패킷 재무 "
    + "8b_fundamentals의 자료",
  calendar: "FRED release/dates(CPI·PCE·고용·GDP 발표일) · 연준 FOMC 연간 일정표(상수) · Yahoo Finance quoteSummary calendarEvents"
    + "(yfinance, 실적일) — 저장본 calendar.us_events, Claude 계좌 패킷 일정 1b_calendar의 자료",
  news: "RSS 헤드라인(제목·출처·시각만) — Investing.com news_25·news_95·news_14 · 연준 press_monetary · BLS cpi·empsit · SEC "
    + "pressreleases (수집 상태 저장본 news.headlines.status, 보존 7일) — Claude 계좌 패킷 사건 11b_events의 자료",
  earnings: "Yahoo Finance quoteSummary earnings.earningsChart(yfinance 내부 호출, 최근 4분기 EPS 실제치·컨센서스, 수집 상태 저장본 "
    + "us.earnings_surprise.status) — Claude 계좌 패킷 재무 8b_fundamentals의 eps 자료",
  jobs: "대시보드 작업 기록 (PostgreSQL paper_job_runs)",
  trackRecord: "SEC EDGAR 13F-HR(후보 기관 분기 공시, 저장본 sec.13f.{cik}.q30) · 수정주가 Yahoo Finance(yfinance, equity_close) — "
    + "공시일 기준 복제 수익률은 대시보드 백엔드 계산(PostgreSQL paper_track_record)",
  groupB: "SEC EDGAR 13F-HR(기존 13F 메뉴 기관 분기 공시, 저장본 sec.13f.{cik}.q30 — 없으면 q8) · 수정주가 Yahoo Finance(yfinance, "
    + "equity_close) — 공시일 기준 복제 수익률은 대시보드 백엔드 계산(PostgreSQL paper_track_record, 그룹 B)",
  selection: "대시보드 선정 기록 (PostgreSQL paper_selection_log)",
  pool: "대시보드 선정 기록 (PostgreSQL paper_selection_log — 신호 풀·기관 가중은 선정 때 값)",
  collection: "대시보드 수집기 (SEC EDGAR 13F-HR, 저장본 sec.13f.track_record_index)",
  decisions: "대시보드 결정 기록 (PostgreSQL paper_decisions·paper_orders) — 13F 신호는 SEC EDGAR 13F-HR"
    + "(신호 풀 기관 저장본 sec.13f.{cik}.q30 — 없으면 q8)",
  gate: "매크로 카드 저장본 macro.collected(미국 10년물·브렌트·WTI·USD/JPY) — 게이트 단계는 대시보드 백엔드 계산(PostgreSQL paper_gate_log)",
  exposure: "대시보드 결정 기록 (PostgreSQL paper_decisions.target_exposure_pct — Claude 응답) · 대시보드 모의 장부 "
    + "(paper_nav_daily.exposure_pct)",
  settings: "대시보드 모의 매매 설정 (PostgreSQL paper_settings·paper_settings_history)",
  apiUsage: "대시보드 Claude 호출 사용량 (PostgreSQL paper_api_usage — 토큰은 Anthropic API 응답의 usage, 추정 비용은 설정 단가 pricing.* × 토큰)",
  framework: "대시보드 프레임 기록 (PostgreSQL paper_framework_versions — 렌더링·토큰 어림은 대시보드 백엔드 계산)",
  proposals: "대시보드 프레임 제안 (PostgreSQL paper_framework_proposals — 평가·변경 제안은 Claude 응답, Anthropic API)",
  notes: "사용자가 쓴 메모 (PostgreSQL paper_notes)",
  boundaries: "대시보드 결정 기록 (PostgreSQL paper_decisions.framework_version — Claude 계좌 결정이 판마다 처음 쓴 거래일)",
  reviews: "대시보드 주간 복기 (PostgreSQL paper_reviews — 수익률·낙폭·스탑·200일선·무효화 평가는 대시보드 백엔드 계산(장부·Yahoo Finance "
    + "equity_close 수정주가), 판정·반복 오류·제안은 Claude 응답, Anthropic API)",
} as const;

/**
 * 탭 — 명세 U2의 여섯 탭에서 "프레임·메모"를 "프레임"과 "메모" 둘로 나눴습니다(단계 3b). 프레임 탭은 판·제안·편집, 메모 탭은 시황·방법론
 * 메모라 할 일이 달라, 한 탭에 두면 판 비교와 편집 폼 아래로 메모 목록이 밀려납니다. opensIn이 있는 탭은 아직 내용이 없고
 * "다음 단계에서 엽니다"만 보입니다(지금은 없음 — 다음 단계 탭이 생기면 씀). 탭을 숨기지 않는 이유 — 무엇이 올지 보여야 지금 화면이
 * 전부가 아니라는 것을 압니다.
 */
export const PAPER_TABS = [
  { key: "overview", label: "개요", opensIn: null, upcoming: null },
  { key: "selection", label: "기관 선정", opensIn: null, upcoming: null },
  { key: "holdings", label: "보유·체결", opensIn: null, upcoming: null },
  // 결정 로그는 단계 2에서 규칙 책 기록으로 엽니다. Claude 책 기록(패킷·응답·검증·노출)은 단계 3a에서 같은 탭에 더합니다.
  { key: "decisions", label: "결정 로그", opensIn: null, upcoming: null },
  // 프레임·메모는 단계 3b에서 엽니다 — 판(렌더링·토큰 어림)·판 비교·수동 편집·OS 원문 제안·승인, 시황·방법론 메모.
  { key: "framework", label: "프레임", opensIn: null, upcoming: null },
  { key: "notes", label: "메모", opensIn: null, upcoming: null },
  // 설정은 단계 3a에서 엽니다 — 키별 입력·저장(규칙 책 영향 키는 한 번 더 확인)·바꾼 기록(버전).
  { key: "settings", label: "설정", opensIn: null, upcoming: null },
] as const;

export type PaperTabKey = (typeof PAPER_TABS)[number]["key"];

/** 배지 색 — Banner·Freshness와 같은 팔레트. 경고·정상 바탕은 불투명 틴트(globals.css) — 계좌 상세처럼 페이지 바탕 위에 놓여도 대비 4.5:1 이상. */
const TONE = {
  ok: "border-ok/40 bg-ok-tint text-ok",
  warn: "border-warn/40 bg-warn-tint text-warn",
  info: "border-accent/40 bg-accent/10 text-accent",
  muted: "border-border bg-surface-hover text-muted",
} as const;

export type BadgeTone = keyof typeof TONE;

export interface Badge {
  key: string;
  label: string;
  className: string;
  /** 마우스를 올리면 보이는 설명. */
  title?: string;
}

const BOOK_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  ACTIVE: { label: "운용 중", tone: "ok" },
  PAUSED: { label: "일시정지", tone: "warn" },
  NOT_STARTED: { label: "시작 전 · 현금만", tone: "muted" },
};

/** 책 상태 배지. 모르는 상태는 받은 글자 그대로(지어내지 않음). */
export function bookStatusBadge(status: string | null | undefined): Badge {
  const known = status ? BOOK_STATUS[status] : undefined;
  return {
    key: status ?? "unknown",
    label: known?.label ?? status ?? EMPTY,
    className: TONE[known?.tone ?? "muted"],
  };
}

const BOOK_KIND: Record<string, string> = { RULES: "규칙", CLAUDE: "Claude", BENCHMARK: "벤치마크" };

export function bookKindLabel(kind: string | null | undefined): string {
  return kind ? (BOOK_KIND[kind] ?? kind) : EMPTY;
}

/** 받침 있는 말 뒤의 조사 → 받침 없는 말 뒤의 조사. */
const PARTICLE_PAIR = { 을: "를", 은: "는", 이: "가", 과: "와" } as const;

/**
 * 이름 뒤에 조사를 붙입니다 — 마지막 글자에 받침이 있으면 "을·은·이·과", 없으면 "를·는·가·와"("규칙 계좌를", "규칙 계좌는").
 * 계좌 이름은 서버가 보내므로(paper_books.label) 받침을 가정하지 않습니다 — 예전에는 "책"으로 끝나는지만 봐서, 이름이 바뀌면
 * "계좌을"이 됐습니다. 한글로 끝나지 않으면(예: "SPY 100%") 받침을 알 수 없어 "을(를)"처럼 둘 다 적습니다.
 */
export function withParticle(word: string, particle: keyof typeof PARTICLE_PAIR): string {
  const code = word.charCodeAt(word.length - 1);
  const other = PARTICLE_PAIR[particle];
  if (code >= 0xac00 && code <= 0xd7a3) return `${word}${(code - 0xac00) % 28 === 0 ? other : particle}`;
  return `${word}${particle}(${other})`;
}

/** 달러 금액 — 장부는 책마다 10만 달러 규모라 조·억 단위로 줄이지 않고 센트까지 적습니다. */
export function formatDollars(value: number | null | undefined, digits = 2): string {
  return formatWithUnit(value, digits, " 달러");
}

/**
 * 주당 가격(평단·현재가·최고가·스탑가·체결가·관측가) — 미국은 소수 4자리. 백엔드가 4자리로 보내는 까닭이 5bp 슬리피지를 싼
 * 종목에서도 보이게 하려는 것이라, 2자리로 자르면 관측가 9.00과 체결가 9.0045가 둘 다 "9.00"이 됩니다. 총액·비율은 2자리 그대로.
 * 한국(`market` "KR")은 원 단위 호가라 0자리입니다(lib/paperMarket — 슬리피지는 체결가가 아니라 비용 칸).
 */
export function formatSharePrice(value: number | null | undefined, market: PaperMarketCode = "US"): string {
  return formatSharePriceFor(value, market);
}

/** 비교 기준 책의 이름(통계의 초과·베타 기준). 기준이 없으면 null, 목록에 없으면 코드 그대로. */
export function benchmarkLabel(book: PaperBookSummary, books: readonly PaperBookSummary[]): string | null {
  if (!book.benchmark) return null;
  return books.find((entry) => entry.code === book.benchmark)?.label ?? book.benchmark;
}

/** 통계 한 칸. */
export interface StatCell {
  key: keyof PaperStats;
  label: string;
  value: string;
}

/**
 * 통계 칸을 표시 순서대로. 통계가 없거나 값이 null이면 "—".
 *
 * @param benchmark 초과·베타의 비교 기준 이름(benchmarkLabel). 없으면 라벨에 적지 않습니다.
 */
export function statCells(stats: PaperStats | null | undefined, benchmark: string | null): StatCell[] {
  const versus = benchmark ? `(${benchmark} 대비)` : "";
  return [
    { key: "cumReturnPct", label: "누적 수익률", value: formatPercent(stats?.cumReturnPct) },
    { key: "cagrPct", label: "연율 수익률", value: formatPercent(stats?.cagrPct) },
    { key: "volPct", label: "변동성(연율)", value: formatWithUnit(stats?.volPct, 2, "%") },
    { key: "mddPct", label: "최대 낙폭", value: formatPercent(stats?.mddPct) },
    { key: "sharpe", label: "샤프", value: formatNumber(stats?.sharpe, 2) },
    {
      key: "excessPct",
      label: `초과 수익률${versus}`,
      value: stats?.excessPct === null || stats?.excessPct === undefined ? EMPTY : `${formatSigned(stats.excessPct, 2)}%p`,
    },
    { key: "beta", label: `베타${versus}`, value: formatNumber(stats?.beta, 2) },
  ];
}

/**
 * 표본 설명 한 줄. 백엔드가 표본이 짧으면 누적 수익률만 내고 나머지를 null로 비우므로, 그때 왜 비었는지 적습니다
 * (기준 일수는 백엔드가 정함 — 화면이 같은 숫자를 따로 들고 있지 않게 null 모양으로만 판단).
 */
export function sampleNote(stats: PaperStats | null | undefined): string {
  if (!stats) return "통계 없음 — 순자산 기록이 아직 없습니다.";
  // sampleDays는 첫·마지막 순자산 기록 사이의 거래일 수입니다(기록이 빠진 날도 셈 — 연율화 기준).
  const base = `표본 ${formatNumber(stats.sampleDays, 0)}거래일`;
  if (stats.cumReturnPct !== null && stats.cagrPct === null) {
    return `${base} — 표본이 짧아 누적 수익률만 냅니다. 몇 달치로는 통계적 결론을 낼 수 없습니다.`;
  }
  if (stats.cagrPct !== null && stats.volPct === null) {
    return `${base} — 하루 간격 기록이 모자라 변동성·샤프·베타는 비웁니다(기록이 빠진 날의 수익률은 쓰지 않음).`;
  }
  return base;
}

/**
 * 책 카드에 적을 값(전부 표시 문자열). 돈은 그 책 시장의 통화(`market` — 기본 미국 달러, 한국은 원 정수, lib/paperMarket)입니다.
 */
export function bookCard(book: PaperBookSummary, books: readonly PaperBookSummary[], market: PaperMarketCode = "US") {
  const stale = book.staleCount ?? null;
  return {
    status: bookStatusBadge(book.status),
    kind: bookKindLabel(book.kind),
    nav: formatMoney(book.nav, market),
    returnPct: formatPercent(book.returnPct),
    exposure: formatWithUnit(book.exposurePct, 1, "%"),
    cash: formatMoney(book.cash, market),
    initialCash: formatMoney(book.initialCash, market, 0),
    positions: book.positions === null || book.positions === undefined ? EMPTY : `${formatNumber(book.positions, 0)}종목`,
    startedOn: book.startedOn ?? "시작 전",
    lastObserved: formatKst(book.lastObservedAtKst),
    /** 가격을 새로 받지 못한 보유가 있으면 경고 문구, 없거나 모르면 null. */
    staleWarning: stale !== null && stale > 0 ? `가격 없음 ${formatNumber(stale, 0)}종목 — 지난 값으로 평가` : null,
    stats: statCells(book.stats, benchmarkLabel(book, books)),
    sample: sampleNote(book.stats),
  };
}

// ---------------------------------------------------------------- 계좌 정의·상세(개요의 계좌 카드를 누르면 열림)

/** 계좌 정의 한 줄 — 상세 패널의 "정의" 목록(화면 순서대로). */
export interface AccountDefinition {
  key: "method" | "buy" | "sell" | "cash" | "start" | "purpose";
  label: string;
  text: string;
}

/** 계좌 규칙을 정하는 설정 키 하나 — 상세 패널이 지금 값을 설정 응답에서 읽어 적습니다. */
export interface AccountSettingSpec {
  key: string;
  label: string;
  /** 값 뒤에 붙일 단위(예: "%", "거래일", " 달러"). 없으면 값만. */
  unit?: string;
}

/** 계좌 하나의 소개 — 카드에 적는 한 줄(summary)과 상세 패널의 정의·관련 설정. */
export interface AccountProfile {
  summary: string;
  definitions: AccountDefinition[];
  settings: AccountSettingSpec[];
}

/** 시작 방법이 같은 두 벤치마크의 정의 한 줄. */
const BENCHMARK_START =
  "개요의 '초기화'로 시작합니다 — 출발일 종가를 받은 뒤 초기화하면 그 종가로 사후 체결하고, 종가가 아직 없으면 '시작 전'(현금만)으로 남습니다.";

/**
 * 네 계좌의 정의(계좌 코드 → 소개). 문장은 백엔드 규칙(RuleBookService·ClaudeBookService·OrderValidator·PaperAdminService·
 * PaperLedgerService)을 옮긴 것이고, **설정에서 오는 숫자는 문장에 적지 않습니다** — 설정을 바꾸면 문장이 틀리게 되므로, 숫자는
 * `settings`의 키로 설정 응답에서 읽어 따로 적습니다(accountSettingRows). 문장에 남은 숫자는 코드에 고정된 값입니다(확대 기준 +30% —
 * RuleBookService.ADD_THRESHOLD_PCT, 벤치마크 구성 SPY 100%·SPY 60%·SHY 40% — PaperBooks).
 */
export const ACCOUNT_PROFILES: Readonly<Record<string, AccountProfile>> = {
  rules: {
    summary: "13F 신호만 규칙대로 따르는 대조군 — 매크로 판단·재량 없음",
    definitions: [
      {
        key: "method",
        label: "운용 방식",
        text: "신호 기관 풀(그룹 A: 후보 기관의 장기 트랙레코드 상위 ∪ 그룹 B: 기존 13F 메뉴 기관의 최근 상위)의 13F 변화를 규칙대로 "
          + "따릅니다. 거래일마다 한 번(확정 종가를 확인한 뒤) 결정하고, 매크로 게이트는 참고로 기록만 합니다.",
      },
      {
        key: "buy",
        label: "매수",
        text: "재선정일(분기 13F 공시 기한 다음 거래일)과 시작 때만 삽니다 — 풀 기관이 최소 기관 수 이상 신규 편입하거나 주식 수를 "
          + "30% 이상 늘린 종목을 점수(기관 가중 × 확신도) 순으로 골라, 종목·ETF 비중 상한 안에서 배분합니다.",
      },
      {
        key: "sell",
        label: "매도·리스크",
        text: "보유 종목을 풀 기관이 최소 기관 수 이상 전량 매도하면 전량 매도합니다. 장부가 관측치마다 트레일링 스탑(최고가 대비 설정 "
          + "비율만큼 떨어지면 전량 매도, 그 뒤 재진입 금지)을 봅니다 — 현금성 종목은 제외. 일시정지 중에는 스탑도 보지 않습니다(최고가만 "
          + "따라감).",
      },
      {
        key: "cash",
        label: "현금",
        text: "남는 현금은 SHY(현금성)에 둡니다(설정에서 끄면 현금 그대로). 재선정일이 아닌 날은 남는 현금이 기준(순자산 대비 %)을 넘을 "
          + "때만 SHY를 사고, 매수에 현금이 모자라면 SHY를 팔아 메웁니다.",
      },
      {
        key: "start",
        label: "시작·출발일",
        text: "개요의 '규칙 계좌 시작'(초기 결정)으로 시작합니다 — 출발일 기준(그날 이전 공시·가격만)으로 선정·신호를 만들어 고른 종목을 "
          + "출발일 종가에 사후 체결합니다.",
      },
      {
        key: "purpose",
        label: "비교 목적",
        text: "대조군 — 같은 13F 자료를 재량 없이 따랐을 때의 성과입니다. Claude 계좌가 이 계좌와 SPY 계좌를 이기는지 봅니다. 규칙 계좌 "
          + "설정을 바꾸면 실험 조건이 바뀝니다.",
      },
    ],
    settings: [
      { key: "minHolders", label: "최소 기관 수", unit: "곳" },
      { key: "rulesMaxNames", label: "매수 종목 수 상한", unit: "종목" },
      { key: "maxWeightStockPct", label: "종목 비중 상한", unit: "%" },
      { key: "maxWeightEtfPct", label: "ETF 비중 상한", unit: "%" },
      { key: "blend.allocation", label: "배분 방식" },
      { key: "trailingStopPct", label: "트레일링 스탑", unit: "%" },
      { key: "lockoutTradingDays", label: "스탑 뒤 재진입 금지", unit: "거래일" },
      { key: "parkCashInShy", label: "남는 현금을 SHY에" },
      { key: "rules.parkCashThresholdPct", label: "SHY 매수 기준(순자산 대비)", unit: "%" },
      { key: "minOrderNotional", label: "최소 주문 금액", unit: " 달러" },
      { key: "cashLikeTickers", label: "현금성 종목" },
    ],
  },
  claude: {
    summary: "Claude가 패킷을 읽고 주문을 제안하고, 검증기가 하드 규칙으로 거르는 실험군",
    definitions: [
      {
        key: "method",
        label: "운용 방식",
        text: "거래일마다 한 번(결정 시각 이후, 확정 종가를 확인한 뒤) 입력 패킷 — 매크로·레짐·게이트 지표·기관 트랙레코드·13F 변화·시세·"
          + "재무·보유·최근 결정·메모·하드 규칙 — 을 Claude에 보내 주문 목록과 목표 주식 노출을 받습니다. 판단 원칙은 프레임 판(시스템 "
          + "프롬프트)이 정합니다.",
      },
      {
        key: "buy",
        label: "매수",
        text: "Claude가 제안한 매수 가운데 검증기(하드 규칙)를 통과한 것만 대기 주문이 됩니다 — 종목·ETF 비중 상한(현금성 제외), 최대 "
          + "종목 수(현금성 제외), 보유 합계 100% 초과(큰 비중부터 받고 넘치는 매수는 거절), 최소 주문 금액, 월 재량 주문 상한, 재진입 "
          + "금지, 유니버스, 데이터 신선도.",
      },
      {
        key: "sell",
        label: "매도·리스크",
        text: "재량 매도는 최소 보유 거래일이 지난 종목만 통과합니다(현금성 종목은 예외). 트레일링 스탑(최고가 대비 설정 비율만큼 "
          + "떨어지면 전량 매도, 재진입 금지)은 장부가 따로 적용합니다 — 현금성 종목은 제외. 호출 실패·형식 오류인 날은 재량 주문이 없고 "
          + "스탑만 돕니다. 일시정지 중에는 스탑도 보지 않습니다(최고가만 따라감).",
      },
      {
        key: "cash",
        label: "현금",
        text: "현금 비중·주식 노출은 Claude가 정하고 검증기는 보지 않습니다(0%·100%도 거절하지 않음). 목표 노출은 기록·표시용이고 집행은 "
          + "주문 기준입니다.",
      },
      {
        key: "start",
        label: "시작·출발일",
        text: "개요의 'Claude 계좌 시작'(초기 결정)으로 시작합니다 — 출발일 기준 초기 패킷(가격·FRED·13F·트랙레코드·재무는 그날 이하 "
          + "값만, 매크로 카드는 그날 이력이 없어 지금 수집본을 참고로)으로 받은 주문 가운데 검증을 통과한 것을 출발일 종가에 사후 "
          + "체결합니다.",
      },
      {
        key: "purpose",
        label: "비교 목적",
        text: "실험군 — 매크로·13F·재무를 함께 읽는 재량 판단이 기계적 규칙(규칙 계좌)과 시장(SPY 계좌)을 이기는지 봅니다.",
      },
    ],
    settings: [
      { key: "model", label: "모델" },
      { key: "decisionTimeKst", label: "결정 시각(KST)" },
      { key: "apiDailyCallCap", label: "하루 호출 상한", unit: "회" },
      { key: "maxWeightStockPct", label: "종목 비중 상한", unit: "%" },
      { key: "maxWeightEtfPct", label: "ETF 비중 상한", unit: "%" },
      { key: "maxPositions", label: "최대 종목 수(현금성 제외)", unit: "종목" },
      { key: "minOrderNotional", label: "최소 주문 금액", unit: " 달러" },
      { key: "maxDiscretionaryOrdersPerMonth", label: "월 재량 주문 상한", unit: "건" },
      { key: "minHoldTradingDaysForSell", label: "재량 매도 전 최소 보유", unit: "거래일" },
      { key: "trailingStopPct", label: "트레일링 스탑", unit: "%" },
      { key: "lockoutTradingDays", label: "스탑 뒤 재진입 금지", unit: "거래일" },
      { key: "cashLikeTickers", label: "현금성 종목" },
    ],
  },
  bench_spy: {
    summary: "출발일에 SPY 100%를 사서 그대로 드는 시장 기준선",
    definitions: [
      { key: "method", label: "운용 방식", text: "결정을 내지 않습니다. 출발일 종가로 SPY를 한 번 사고 그대로 듭니다." },
      {
        key: "buy",
        label: "매수",
        text: "초기화 때 한 번 — SPY 100%를 출발일 종가에 사후 체결합니다(정수 주라 1주에 못 미치는 잔돈은 현금으로 남음). 그 뒤로는 "
          + "사지 않습니다.",
      },
      { key: "sell", label: "매도·리스크", text: "팔지 않습니다 — 트레일링 스탑을 걸지 않고 리밸런싱도 하지 않습니다." },
      { key: "cash", label: "현금", text: "1주를 채우지 못한 잔돈뿐입니다." },
      { key: "start", label: "시작·출발일", text: BENCHMARK_START },
      {
        key: "purpose",
        label: "비교 목적",
        text: "시장 기준선 — 다른 세 계좌 통계의 초과 수익률·베타는 이 계좌 대비입니다.",
      },
    ],
    settings: [{ key: "slippageBp", label: "체결 슬리피지(네 계좌 공통)", unit: "bp" }],
  },
  bench_mix: {
    summary: "출발일에 SPY 60%·SHY 40%를 사서 그대로 드는 단순 배분 기준 — 리밸런싱 없음",
    definitions: [
      { key: "method", label: "운용 방식", text: "결정을 내지 않습니다. 출발일 종가로 SPY 60%·SHY 40%를 한 번 사고 그대로 듭니다." },
      {
        key: "buy",
        label: "매수",
        text: "초기화 때 한 번 — 두 종목을 출발일 종가에 사후 체결합니다(정수 주라 잔돈은 현금으로 남음). 그 뒤로는 사지 않습니다.",
      },
      {
        key: "sell",
        label: "매도·리스크",
        text: "팔지 않습니다 — 트레일링 스탑·리밸런싱이 없어 비중은 가격에 따라 60/40에서 벌어집니다.",
      },
      {
        key: "cash",
        label: "현금",
        text: "SHY 40%가 현금성 몫입니다 — 현금성 종목(설정 cashLikeTickers, 기본 SHY)이라 구성 차트에서 현금과 한 묶음입니다. 그 밖의 "
          + "현금은 잔돈뿐입니다.",
      },
      { key: "start", label: "시작·출발일", text: BENCHMARK_START },
      {
        key: "purpose",
        label: "비교 목적",
        text: "주식을 덜 든 단순 배분과의 비교 — 현금을 많이 들고 가는 판단이 이 배분보다 나았는지 봅니다. 통계는 SPY 계좌 대비입니다.",
      },
    ],
    settings: [
      { key: "slippageBp", label: "체결 슬리피지(네 계좌 공통)", unit: "bp" },
      { key: "cashLikeTickers", label: "현금성 종목" },
    ],
  },
};

/** 계좌 코드의 소개. 모르는 코드(정의가 없는 계좌)는 null — 지어내지 않습니다. */
export function accountProfile(code: string | null | undefined): AccountProfile | null {
  return code && Object.hasOwn(ACCOUNT_PROFILES, code) ? ACCOUNT_PROFILES[code] : null;
}

/** 배분 방식(blend.allocation) 이름. */
const ALLOCATION_LABEL: Record<string, string> = { CONVICTION: "확신도 비례(CONVICTION)", EQUAL: "동일 비중(EQUAL)" };

/** 상세 패널의 "지금 설정" 한 줄. */
export interface AccountSettingRow {
  key: string;
  label: string;
  value: string;
}

/**
 * 계좌 규칙을 정하는 설정의 지금 값(설정 응답의 body). 설정을 읽지 못했으면(body 없음) 빈 목록 — 화면은 숫자 없이 정의 문장만 보입니다.
 * 키가 없거나 값을 모르면 "—"(기본값으로 채우지 않음 — 지금 설정과 다를 수 있음).
 */
export function accountSettingRows(code: string | null | undefined, body: unknown): AccountSettingRow[] {
  const profile = accountProfile(code);
  if (!profile || !isRecord(body)) return [];
  return profile.settings.map((spec) => {
    const value = settingValueAt(body, spec.key);
    let text: string;
    if (value === null || value === undefined) text = EMPTY;
    else if (spec.key === "blend.allocation" && typeof value === "string") text = ALLOCATION_LABEL[value] ?? value;
    else if (typeof value === "number") text = Number.isFinite(value) ? `${settingText(value)}${spec.unit ?? ""}` : EMPTY;
    else text = settingText(value);
    return { key: spec.key, label: spec.label, value: text };
  });
}

/** 구성 묶음의 종류 — 이름을 따로 그리는 상위 종목 · 나머지 종목(기타) · 현금과 현금성 종목. */
export type CompositionKind = "holding" | "other" | "cash";

/** 구성 차트의 묶음 하나(조각). */
export interface CompositionSegment {
  key: string;
  kind: CompositionKind;
  /** 상위 종목의 범주 순서(0부터, 비중 큰 순) — 화면이 이 순서로 색을 고정 배정합니다. 기타·현금은 null(무채색). */
  slot: number | null;
  label: string;
  /** 비중(순자산 대비 %, 표시 반올림 전). */
  sharePct: number;
  shareText: string;
  valueText: string;
  /**
   * 묶음 내역(둘 이상 묶은 기타의 종목들, 현금성 종목이 있을 때 현금·현금성의 금액 내역). 종목 하나짜리 조각(상위 종목, 남은 종목이
   * 하나뿐인 기타)과 현금만인 묶음은 null.
   */
  detail: string | null;
  /** 고리 옆에 직접 적을 글자(묶음이 DIRECT_LABEL_MAX_SEGMENTS 이하이고 조각이 충분히 클 때만), 아니면 null. */
  directLabel: string | null;
}

/** 구성 표(차트의 표 보기)의 한 줄 — 보유 종목 하나 또는 현금. */
export interface CompositionRow {
  key: string;
  /** 티커, 현금 줄이면 "현금". */
  label: string;
  /** 이 줄이 든 차트 묶음(CompositionSegment.key) — 표의 색 표식이 차트 조각과 같게. */
  segmentKey: string;
  cashLike: boolean;
  isCash: boolean;
  shareText: string;
  valueText: string;
  unrealizedPct: number | null;
  unrealizedText: string;
  qtyText: string;
}

/** 계좌 구성 — 차트 모양·묶음·표. */
export interface AccountComposition {
  /**
   * donut: 의미 있는 묶음이 셋 이상 · meter: 둘 이하(두 조각 파이는 숫자가 더 낫다 — 한 줄 막대로) · none: 비중을 몰라 그리지 않음.
   */
  form: "donut" | "meter" | "none";
  segments: CompositionSegment[];
  rows: CompositionRow[];
  /** 묶음 비중의 합(표시 반올림 전). 그리지 않으면 null. 반올림 오차를 빼면 100입니다. */
  totalPct: number | null;
  /** 그리지 않는 이유(form "none"), 아니면 null. */
  note: string | null;
}

/**
 * 이름과 색을 따로 받는 상위 종목 수. 상위 셋 + 기타 + 현금·현금성 = 최대 다섯 조각.
 *
 * 넷이 아니라 셋인 까닭: 넷째 색(노랑)은 둘째(주황)와 색약 ΔE 4.8·정상 시각 10.6으로 가까워(dataviz 검증기 --pairs all), 묶음이 넷을
 * 넘어 직접 라벨이 빠지는 규칙 계좌의 흔한 모양(종목 열 + SHY)에서 색만으로 둘째와 넷째 종목을 범례·표와 맞출 수 없었습니다. 앞 세
 * 색은 모든 쌍이 통과합니다(색약 최소 9.4, 정상 시각 최소 20.9).
 */
export const COMPOSITION_TOP_N = 3;
/** 직접 라벨을 붙이는 묶음 수의 상한 — 넷까지는 범례와 함께 고리 옆에도 이름을 적고, 넘으면 이웃 라벨이 겹쳐 범례·툴팁·표에 맡깁니다. */
export const DIRECT_LABEL_MAX_SEGMENTS = 4;
/** 이보다 작은 묶음은 그리고 범례·표에 적되, 도넛으로 그릴지 정하는 "의미 있는 묶음 수"에는 세지 않습니다(SPY 계좌의 잔돈 0.1% 같은 것). */
export const COMPOSITION_MEANINGFUL_PCT = 0.5;
/** 직접 라벨을 붙일 최소 조각(%) — 더 작은 조각은 이웃 라벨과 겹쳐 범례·툴팁·표가 대신 나릅니다. */
const DIRECT_LABEL_MIN_PCT = 3;
/** 기타 묶음 내역에 이름을 적을 종목 수 — 넘으면 "외 n종목". */
const OTHER_DETAIL_NAMES = 6;

/** 비중 큰 순, 같으면 티커 순 — 같은 장부면 늘 같은 순서(색 배정이 새로 읽을 때마다 바뀌지 않게). 비중을 모르면 맨 뒤. */
function byShareThenTicker(a: { share: number | null; ticker: string }, b: { share: number | null; ticker: string }): number {
  const left = a.share ?? Number.NEGATIVE_INFINITY;
  const right = b.share ?? Number.NEGATIVE_INFINITY;
  if (left !== right) return right - left;
  return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
}

/**
 * 계좌 구성(보유 응답 → 도넛·표). 상위 COMPOSITION_TOP_N 종목은 종목별(색), 나머지 종목은 "기타 n종목"(무채색), 현금과 현금성 종목(보유
 * 응답의 cashLike — 설정 cashLikeTickers, 기본 SHY)은 "현금·현금성" 한 묶음입니다. 남은 종목이 하나뿐이면 "기타 1종목"으로 감추지 않고
 * 그 티커를 그대로 적습니다(조각 수·색은 같고 이름만 사라지던 것). 현금성 종목이 없으면 그냥 "현금"이라 적습니다(SHY가 없는데
 * '현금성'이라 하지 않게) — 고리 옆 직접 라벨도 같은 규칙입니다(SHY가 대부분인 묶음을 "현금"이라 적으면 현금 칸과 다른 숫자가 됨).
 *
 * 종목 비중은 장부가 계산해 보낸 weightPct(평가액 ÷ 순자산) 그대로입니다 — 보유·체결 탭과 같은 숫자. 현금 몫만 응답에 비중이 없어
 * 같은 응답의 현금 ÷ 순자산으로 냅니다(묶음은 그 값들의 합). 순자산을 모르거나 한 종목이라도 비중을 모르면 그리지 않습니다(form
 * "none") — 일부만 그린 도넛은 모르는 몫을 다른 조각이 차지해 틀린 그림이 됩니다. 표는 그때도 장부 값 그대로 보입니다.
 */
export function accountComposition(
  positions: readonly PaperPosition[] | null | undefined,
  cash: number | null | undefined,
  nav: number | null | undefined,
): AccountComposition {
  const navValue = isNumber(nav) && nav > 0 ? nav : null;
  const entries = (positions ?? []).map((position) => ({
    position,
    ticker: position.ticker,
    share: isNumber(position.weightPct)
      ? position.weightPct
      : navValue !== null && isNumber(position.marketValue) ? (position.marketValue / navValue) * 100 : null,
  }));
  const stocks = entries.filter((entry) => !entry.position.cashLike).sort(byShareThenTicker);
  const cashLike = entries.filter((entry) => entry.position.cashLike).sort(byShareThenTicker);
  const cashValue = isNumber(cash) ? cash : null;
  const cashShare = navValue !== null && cashValue !== null ? (cashValue / navValue) * 100 : null;

  const top = stocks.slice(0, COMPOSITION_TOP_N);
  const rest = stocks.slice(COMPOSITION_TOP_N);
  const segmentOf = (index: number) => (index < COMPOSITION_TOP_N ? `holding:${stocks[index].ticker}` : "other");

  const rows: CompositionRow[] = [
    ...stocks.map((entry, index) => holdingRow(entry.position, entry.share, segmentOf(index))),
    ...cashLike.map((entry) => holdingRow(entry.position, entry.share, "cash")),
    {
      key: "cash", label: "현금", segmentKey: "cash", cashLike: false, isCash: true,
      shareText: formatWithUnit(cashShare, 1, "%"), valueText: formatDollars(cashValue),
      unrealizedPct: null, unrealizedText: EMPTY, qtyText: EMPTY,
    },
  ];

  const shares = [...entries.map((entry) => entry.share), cashShare];
  if (navValue === null || shares.some((share) => share === null)) {
    return {
      form: "none", segments: [], rows, totalPct: null,
      note: "순자산이나 비중을 몰라(—) 구성 차트를 그리지 않습니다 — 아래 표는 장부 값 그대로입니다.",
    };
  }
  if (shares.some((share) => (share as number) < 0)) {
    return { form: "none", segments: [], rows, totalPct: null, note: "음수인 몫이 있어 구성 차트를 그리지 않습니다 — 아래 표를 보세요." };
  }

  const valueOf = (position: PaperPosition) => (isNumber(position.marketValue) ? position.marketValue : 0);
  // short: 고리 옆 직접 라벨에 쓰는 짧은 이름(범례·툴팁은 label 전체).
  const segments: (Omit<CompositionSegment, "directLabel"> & { short: string })[] = top.map((entry, index) => ({
    key: `holding:${entry.ticker}`,
    kind: "holding",
    slot: index,
    label: entry.ticker,
    short: entry.ticker,
    sharePct: entry.share as number,
    shareText: formatWithUnit(entry.share, 1, "%"),
    valueText: formatDollars(entry.position.marketValue),
    detail: null,
  }));
  if (rest.length > 0) {
    const share = rest.reduce((sum, entry) => sum + (entry.share as number), 0);
    const single = rest.length === 1 ? rest[0].ticker : null;
    const names = rest.slice(0, OTHER_DETAIL_NAMES).map((entry) => entry.ticker).join("·");
    const more = rest.length > OTHER_DETAIL_NAMES ? ` 외 ${formatNumber(rest.length - OTHER_DETAIL_NAMES, 0)}종목` : "";
    segments.push({
      key: "other",
      kind: "other",
      slot: null,
      label: single ?? `기타 ${formatNumber(rest.length, 0)}종목`,
      short: single ?? "기타",
      sharePct: share,
      shareText: formatWithUnit(share, 1, "%"),
      valueText: formatDollars(rest.reduce((sum, entry) => sum + valueOf(entry.position), 0)),
      detail: single ? null : `${names}${more}`,
    });
  }
  const cashLikeShare = cashLike.reduce((sum, entry) => sum + (entry.share as number), 0);
  const cashSegmentShare = (cashShare as number) + cashLikeShare;
  if (cashSegmentShare > 0) {
    const tickers = cashLike.map((entry) => entry.ticker);
    segments.push({
      key: "cash",
      kind: "cash",
      slot: null,
      label: tickers.length > 0 ? `현금·현금성(${tickers.join("·")})` : "현금",
      short: tickers.length > 0 ? "현금·현금성" : "현금",
      sharePct: cashSegmentShare,
      shareText: formatWithUnit(cashSegmentShare, 1, "%"),
      valueText: formatDollars((cashValue as number) + cashLike.reduce((sum, entry) => sum + valueOf(entry.position), 0)),
      detail: tickers.length > 0
        ? [`현금 ${formatDollars(cashValue)}`, ...cashLike.map((entry) => `${entry.ticker} ${formatDollars(entry.position.marketValue)}`)]
          .join(" + ")
        : null,
    });
  }

  const meaningful = segments.filter((segment) => segment.sharePct >= COMPOSITION_MEANINGFUL_PCT).length;
  const labelled = segments.length <= DIRECT_LABEL_MAX_SEGMENTS;
  return {
    form: segments.length === 0 ? "none" : meaningful >= 3 ? "donut" : "meter",
    segments: segments.map(({ short, ...segment }) => ({
      ...segment,
      directLabel: labelled && segment.sharePct >= DIRECT_LABEL_MIN_PCT ? `${short} ${segment.shareText}` : null,
    })),
    rows,
    totalPct: segments.reduce((sum, segment) => sum + segment.sharePct, 0),
    note: segments.length === 0 ? "그릴 몫이 없습니다." : null,
  };
}

/** 구성 표의 보유 한 줄. 평가 손익(평단 대비)은 장부 값 그대로. */
function holdingRow(position: PaperPosition, share: number | null, segmentKey: string): CompositionRow {
  return {
    key: `position:${position.ticker}`,
    label: position.ticker,
    segmentKey,
    cashLike: position.cashLike,
    isCash: false,
    shareText: formatWithUnit(share, 1, "%"),
    valueText: formatDollars(position.marketValue),
    unrealizedPct: isNumber(position.unrealizedPct) ? position.unrealizedPct : null,
    unrealizedText: formatPercent(position.unrealizedPct),
    qtyText: formatNumber(position.qty, 0),
  };
}

/** 차트 한 줄(계열)의 키·이름. 색은 화면이 정합니다(components/charts의 팔레트). */
export interface NavSeriesLine {
  key: string;
  name: string;
}

/**
 * 순자산 곡선의 행과 계열.
 *
 * - 계열 순서는 책 목록(서버가 정한 순서)을 따르고, 목록에 없는 책 코드는 뒤에 붙입니다.
 * - 그날 기록이 없는 책은 null 그대로 둡니다 — 차트가 선을 끊어 그립니다(0이나 앞 값으로 채우면 없는 수익률이 생김).
 * - 배열이 dates보다 짧으면 모자란 날도 null입니다.
 */
export function navChart(
  navSeries: PaperOverviewResponse["navSeries"],
  books: readonly PaperBookSummary[],
): { rows: Record<string, string | number | null>[]; series: NavSeriesLine[] } {
  if (!navSeries || !Array.isArray(navSeries.dates) || !navSeries.books) return { rows: [], series: [] };
  const known = books.map((book) => book.code).filter((code) => code in navSeries.books);
  const extra = Object.keys(navSeries.books).filter((code) => !known.includes(code));
  const codes = [...known, ...extra];

  const rows = navSeries.dates.map((date, index) => {
    const row: Record<string, string | number | null> = { date };
    for (const code of codes) {
      const value = navSeries.books[code]?.[index];
      row[code] = typeof value === "number" && Number.isFinite(value) ? value : null;
    }
    return row;
  });
  const series = codes.map((code) => ({ key: code, name: books.find((book) => book.code === code)?.label ?? code }));
  return { rows, series };
}

/** 순자산 축이 적어도 펼쳐 그리는 폭 — 수준의 0.2%($100k면 $200). */
const NAV_MIN_SPAN_RATIO = 0.002;
/** 차트 눈금 간격 수 — Recharts 세로축 기본 tickCount 5 = 간격 4. 범위를 간격의 정확히 4배로 잡아야 눈금이 둥근 값에 섭니다. */
const NAV_TICK_INTERVALS = 4;

/** 순자산 곡선의 세로축 — domain이 undefined면 차트 기본(자료에 맞춤). */
export interface NavAxis {
  domain: [number, number] | undefined;
  precision: number;
}

/** x 이상인 가장 작은 1·2·5×10ⁿ. */
function niceStepAtLeast(x: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(x));
  for (const factor of [1, 2, 5]) {
    if (factor * magnitude >= x * (1 - 1e-9)) return factor * magnitude;
  }
  return 10 * magnitude;
}

/**
 * 순자산 곡선의 세로축 범위와 눈금 소수 자릿수.
 *
 * 책들의 순자산이 거의 안 움직이면(출발 직후·현금 위주 책 — 예: 99,950.22~99,951.00) 자료에 맞춘 축의 눈금 간격이 0.2달러쯤이
 * 되고, 정수로 적는 눈금이 전부 "99,951"처럼 같은 숫자로 반복됩니다. 그럴 때만 축을 수준의 0.2% 이상으로 펼쳐 자료 가운데에 두고,
 * 둥근 간격(1·2·5×10ⁿ) 4칸으로 잡아 눈금 자릿수를 그 간격에 맞춥니다 — 간격이 1달러 미만이면 소수까지 적어 눈금끼리 다릅니다.
 * 값은 건드리지 않습니다(없는 날은 null 그대로 선이 끊김, 축 범위 계산에서도 뺌). 자료 범위가 0.2%보다 넓으면 차트 기본 축을 그대로
 * 씁니다(domain undefined, 정수 눈금).
 */
export function navAxis(chart: { rows: readonly Record<string, unknown>[]; series: readonly NavSeriesLine[] }): NavAxis {
  let min = Infinity;
  let max = -Infinity;
  for (const row of chart.rows) {
    for (const line of chart.series) {
      const value = row[line.key];
      if (typeof value === "number" && Number.isFinite(value)) {
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }
  }
  if (min > max) return { domain: undefined, precision: 0 };

  const minSpan = Math.max(Math.abs(min), Math.abs(max)) * NAV_MIN_SPAN_RATIO || 1;
  if (max - min >= minSpan) return { domain: undefined, precision: 0 };

  const center = (min + max) / 2;
  let step = niceStepAtLeast(minSpan / NAV_TICK_INTERVALS);
  for (;;) {
    const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    let lower = Math.round((center - (step * NAV_TICK_INTERVALS) / 2) / step) * step;
    // 음수가 될 수 없는 순자산에 0 아래 눈금을 찍지 않습니다.
    if (min >= 0 && lower < 0) lower = 0;
    const upper = lower + step * NAV_TICK_INTERVALS;
    if (lower <= min && max <= upper) {
      return { domain: [Number(lower.toFixed(decimals)), Number(upper.toFixed(decimals))], precision: decimals };
    }
    step = niceStepAtLeast(step * 1.5);
  }
}

/**
 * 장부 관측치 한 줄 — 봉 날짜·티커 수·이어받은 값 수. 저장본이 없으면 그렇다고 적습니다.
 * tickers는 개수, staleTickers는 티커 이름 목록으로 옵니다(PaperQueryService.quotesSummary).
 */
export function quotesLine(quotes: PaperQuotesSummary | null | undefined): string {
  if (!quotes) {
    return "장부 관측치(paper.quotes) 저장본이 아직 없습니다 — 수집기의 paper_quotes 태스크가 한 번 돌면 생깁니다.";
  }
  return [
    `봉 날짜 ${quotes.barDate ?? EMPTY}(미국 동부)`,
    `티커 ${formatWithUnit(quotes.tickers, 0, "개")}`,
    `지난 값 이어받음 ${formatNumber(quotes.staleTickers.length, 0)}개`,
  ].join(" · ");
}

/**
 * 재무 수집 범위 한 줄(D28) — "재무(SEC XBRL): 재무가 있는 회사/유니버스(ETF 제외)곳 · 마지막 수집 …". 모르는 값은 —이고,
 * 이어받은 회사가 있으면 그 수를 덧붙입니다. 상태 응답에 이 필드가 없으면(이전 백엔드) null — 줄을 그리지 않습니다.
 */
export function fundamentalsLine(fundamentals: PaperFundamentalsStatus | null | undefined): string | null {
  if (!fundamentals) return null;
  const count = (value: number | null | undefined) => formatNumber(value, 0);
  const parts = [
    `재무(SEC XBRL): ${count(fundamentals.covered)}/${count(fundamentals.universe)}곳`,
    `마지막 수집 ${formatKst(fundamentals.latestFetchKst)}`,
  ];
  if ((fundamentals.staleCompanies ?? 0) > 0) {
    parts.push(`이어받음 ${count(fundamentals.staleCompanies)}곳`);
  }
  return parts.join(" · ");
}

/**
 * 발표·실적 일정 한 줄(2단계 A) — "일정(FRED·FOMC·실적): 거시 n건 · 실적 받은 종목/대상종목 · 갱신 …". 모르는 값은 —이고, FRED
 * 부분이 정상이 아니면(키 미설정·실패) 그 상태를 덧붙입니다(키가 없어도 FOMC는 거시 건수에 셈). 상태 응답에 이 필드가 없으면(이전
 * 백엔드) null — 줄을 그리지 않습니다.
 */
export function calendarLine(calendar: PaperCalendarStatus | null | undefined): string | null {
  if (!calendar) return null;
  const count = (value: number | null | undefined) => formatNumber(value, 0);
  const parts = [
    `일정(FRED·FOMC·실적): 거시 ${count(calendar.macroCount)}건`,
    `실적 ${count(calendar.earningsCovered)}/${count(calendar.universe)}종목`,
    `갱신 ${formatKst(calendar.generatedAtKst)}`,
  ];
  if (calendar.fredStatus && calendar.fredStatus !== "ok") {
    parts.push(`FRED ${calendar.fredStatus}`);
  }
  return parts.join(" · ");
}

/**
 * 사건 뉴스 수집 한 줄(2단계 B) — "사건 뉴스(RSS): 7일 n건 · 피드 받은 수/전체 · 갱신 …". 모르는 값은 —이고, 실패한 피드가 있으면
 * 그 키를 덧붙입니다(사유는 상태 화면·작업 기록에). 상태 응답에 이 필드가 없으면(이전 백엔드) null — 줄을 그리지 않습니다.
 */
export function newsLine(news: PaperNewsStatus | null | undefined): string | null {
  if (!news) return null;
  const count = (value: number | null | undefined) => formatNumber(value, 0);
  const parts = [
    `사건 뉴스(RSS): 7일 ${count(news.stored7d)}건`,
    `피드 ${count(news.feedsOk)}/${count(news.feedsTotal)}`,
    `갱신 ${formatKst(news.lastFetchKst)}`,
  ];
  const failed = (news.failedFeeds ?? []).map((feed) => feed?.feed).filter((key): key is string => Boolean(key));
  if (failed.length > 0) {
    parts.push(`실패 ${failed.join("·")}`);
  }
  return parts.join(" · ");
}

/**
 * 어닝 서프라이즈 수집 한 줄(2단계 C) — "어닝 서프라이즈(yfinance): 행이 있는 종목/대상종목 · 4분기 추정치 4분기 이상 종목 수 · 갱신 …".
 * 모르는 값은 —입니다. 상태 응답에 이 필드가 없으면(이전 백엔드) null — 줄을 그리지 않습니다.
 */
export function earningsLine(earnings: PaperEarningsStatus | null | undefined): string | null {
  if (!earnings) return null;
  const count = (value: number | null | undefined) => formatNumber(value, 0);
  return [
    `어닝 서프라이즈(yfinance): ${count(earnings.covered)}/${count(earnings.universe)}종목`,
    `4분기 ${count(earnings.withEstimate4)}`,
    `갱신 ${formatKst(earnings.generatedAtKst)}`,
  ].join(" · ");
}

/**
 * JSON(주문 근거·작업 detail)을 한 줄로 — `키: 값 · 키: 값`. 비었거나 없으면 "—".
 * 길면 maxLength에서 자릅니다(전체는 jsonTitle로 마우스를 올려 봄).
 */
export function jsonSummary(value: unknown, maxLength = 160): string {
  const text = summarize(value);
  if (!text) return EMPTY;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function summarize(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(summarize).filter(Boolean).join(", ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => {
        const shown = entry !== null && typeof entry === "object" && !Array.isArray(entry)
          ? JSON.stringify(entry)
          : summarize(entry);
        return `${key}: ${shown || EMPTY}`;
      })
      .join(" · ");
  }
  return "";
}

/**
 * 주문 근거 한 줄 — 서버가 사람이 읽을 문장(`reason.text`, 예: "2곳 동시 매수(순위 합 3): 1위 …, 2위 …")을 남겼으면 그 문장을
 * 자르지 않고 그대로, 없으면 {@link jsonSummary}. 규칙 책 근거는 `rule · signal · kind`가 앞에 오고 `text`가 뒤(SHY 주문은 아홉째)라,
 * 키 순서대로 이어 붙여 자르면 둘째 기관부터 잘리거나 문장이 아예 보이지 않습니다.
 */
export function orderReasonText(reason: unknown, maxLength = 120): string {
  if (isRecord(reason)) {
    const text = reason.text;
    if (typeof text === "string" && text.trim()) return text;
    const contributed = contributionReason(reason);
    if (contributed) return contributed;
    const thesis = claudeReason(reason);
    if (thesis) return thesis;
  }
  return jsonSummary(reason, maxLength);
}

/**
 * Claude 주문 근거 한 줄 — "근거 [사실·가설] · 무효화: 조건". Claude 책 주문의 근거는 모델이 쓴 `{thesis, labels, invalidation}`이라
 * 키: 값으로 이어 붙이면 라벨이 배열 글자로 섞이고 무효화 조건이 잘립니다. 근거(thesis)가 없으면 null(호출한 쪽이 키: 값 요약으로).
 */
function claudeReason(reason: Record<string, unknown>): string | null {
  const thesis = textOf(reason.thesis);
  if (!thesis) return null;
  const labels = listOf(reason.labels).filter((label): label is string => typeof label === "string" && label.length > 0);
  const invalidation = textOf(reason.invalidation);
  return `${thesis}${labels.length > 0 ? ` [${labels.join("·")}]` : ""}${invalidation ? ` · 무효화: ${invalidation}` : ""}`;
}

/**
 * 문장(text)이 없는 매수 근거를 점수 기여로 한 줄 — "점수 0.367: 듀케인(AB) 신규 편입 · 가중 36.7% × 확신도 100.0%, …".
 * 그룹 섞기(D27) 뒤 매수 근거는 `{score, contributions:[{cik, name, groups, filerWeight, conviction, points, action, weightPct}]}`라
 * 키: 값으로 이어 붙이면 기관 줄이 JSON 덩어리로 보입니다. 기여가 없으면 null(호출한 쪽이 키: 값 요약으로).
 */
function contributionReason(reason: Record<string, unknown>): string | null {
  const contributions = listOf(reason.contributions).filter(isRecord);
  if (contributions.length === 0) return null;
  const parts = contributions.map((entry) => {
    const name = textOf(entry.name) ?? `CIK ${textOf(entry.cik) ?? EMPTY}`;
    const groups = groupsOf(entry.groups).join("");
    const action = textOf(entry.action);
    return `${name}${groups ? `(${groups})` : ""}${action ? ` ${signalActionLabel(action)}` : ""} · 가중 `
      + `${formatRatioPercent(numberOf(entry.filerWeight))} × 확신도 ${formatRatioPercent(numberOf(entry.conviction))}`;
  });
  const score = numberOf(reason.score);
  return `${score === null ? "" : `점수 ${formatScore(score)}: `}${parts.join(", ")}`;
}

/** 마우스를 올리면 볼 JSON 전체. 없으면 undefined(title을 달지 않음). */
export function jsonTitle(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value || undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** 작업 결과 글자색 — 오류·실패만 경고색. 모르는 값은 본문색. */
export function jobOutcomeClass(outcome: string | null | undefined): string {
  return outcome && /error|fail|오류|실패/i.test(outcome) ? "text-warn" : "text-body";
}

const SIDE: Record<string, string> = { BUY: "매수", SELL: "매도" };
const ORDER_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  PROPOSED: { label: "제안", tone: "muted" },
  PENDING: { label: "대기", tone: "info" },
  FILLED: { label: "체결", tone: "ok" },
  EXPIRED: { label: "만료", tone: "muted" },
  CANCELLED: { label: "취소", tone: "muted" },
  REJECTED: { label: "거절", tone: "warn" },
};
const TIMING: Record<string, string> = {
  NEXT_OBSERVATION: "다음 관측치",
  // 한국 책의 체결 시점(명세 §4-1 — 다음 KR 거래일 시가 단일가, 잠정가는 토스 1분봉 개장 봉).
  NEXT_OPEN: "다음 거래일 시가",
  NEXT_CLOSE: "다음 종가",
  IMMEDIATE: "즉시",
  BACKFILL: "사후 체결",
};
const SOURCE: Record<string, string> = {
  RULE: "규칙",
  CLAUDE: "Claude",
  STOP: "트레일링 스탑",
  BENCHMARK: "벤치마크",
  INITIAL: "초기 결정",
};

const labelOf = (table: Record<string, string>, value: string | null | undefined) =>
  value ? (table[value] ?? value) : EMPTY;

export const sideLabel = (side: string | null | undefined) => labelOf(SIDE, side);
export const timingLabel = (timing: string | null | undefined) => labelOf(TIMING, timing);
export const sourceLabel = (source: string | null | undefined) => labelOf(SOURCE, source);

/** 매수는 상승색, 매도는 하락색(한국 관행, format.deltaColor와 같음). */
export function sideClass(side: string | null | undefined): string {
  return side === "BUY" ? "text-up" : side === "SELL" ? "text-down" : "text-body";
}

export function orderStatusBadge(status: string | null | undefined): Badge {
  const known = status ? ORDER_STATUS[status] : undefined;
  return { key: status ?? "unknown", label: known?.label ?? status ?? EMPTY, className: TONE[known?.tone ?? "muted"] };
}

/**
 * 주문 크기 — 수량이 있으면 수량, 없으면 살 금액(매수) 또는 매도 비율. 매도에 셋 다 없으면 전량입니다
 * (백엔드 규칙: sellFraction이 null이면 전량). 매수에 셋 다 없으면 모름(—).
 *
 * 주문의 `targetWeightPct`는 이름과 달리 "체결 시점 순자산 대비 살 금액(%)"입니다(장부가 그렇게 읽음). 규칙 책·Claude 책 모두 이미 든
 * 종목이면 모자란 만큼(목표 − 현재), SHY면 늘릴 만큼만 넣고 진짜 목표 비중은 근거 `reason.targetWeightPct`에 남기므로, 근거의 목표가
 * 주문 값과 다르면 함께 적습니다. 검증기가 거절한 Claude 매수(REJECTED)는 집행되지 않아 받은 값 그대로(모델이 준 목표 비중)
 * 남으므로 "목표 …% (제안)"으로 적습니다 — "순자산의 …% 매수"로 읽으면 이미 든 비중까지 더 사려 한 것처럼 보입니다.
 */
export function orderSizeText(
  order: Pick<PaperOrder, "side" | "qty" | "targetWeightPct" | "sellFraction"> & { reason?: unknown; status?: string | null },
): string {
  if (order.qty !== null && order.qty !== undefined) return `${formatNumber(order.qty, 0)}주`;
  if (order.status === "REJECTED" && order.side === "BUY" && order.targetWeightPct !== null && order.targetWeightPct !== undefined) {
    return `목표 ${formatNumber(order.targetWeightPct, 2)}% (제안)`;
  }
  if (order.targetWeightPct !== null && order.targetWeightPct !== undefined) {
    const amount = formatNumber(order.targetWeightPct, 2);
    const target = isRecord(order.reason) ? numberOf(order.reason.targetWeightPct) : null;
    const targetText = target === null ? null : formatNumber(target, 2);
    return targetText === null || targetText === amount
      ? `순자산의 ${amount}% 매수`
      : `순자산의 ${amount}% 매수 (목표 ${targetText}%)`;
  }
  if (order.sellFraction !== null && order.sellFraction !== undefined) {
    return `보유의 ${formatNumber(order.sellFraction * 100, 0)}%`;
  }
  return order.side === "SELL" ? "전량" : EMPTY;
}

/** 보유 한 줄의 배지 — 가격 없음 · 사후 체결 · 분할 조정 · 현금성. */
export function positionBadges(position: PaperPosition): Badge[] {
  const badges: Badge[] = [];
  if (position.lastPrice === null || position.lastPrice === undefined) {
    badges.push({
      key: "noPrice", label: "가격 없음 · 평단 평가", className: TONE.warn,
      title: "시세를 한 번도 받지 못해 평단으로 평가했습니다. 트레일링 스탑 판정은 건너뜁니다.",
    });
  } else if (position.priceStale) {
    badges.push({
      key: "stale", label: "가격 없음 · 지난 값", className: TONE.warn,
      title: `이번 관측치에 시세가 없어 ${formatKst(position.lastPriceAtKst)}의 가격으로 평가했습니다. 트레일링 스탑 판정은 건너뜁니다.`,
    });
  }
  if (position.backfilled) {
    badges.push({ key: "backfill", label: "사후 체결", className: TONE.info, title: "출발일 종가로 나중에 기록한 체결입니다." });
  }
  if (position.splitNote) {
    badges.push({ key: "split", label: "분할 조정", className: TONE.info, title: position.splitNote });
  }
  if (position.cashLike) {
    badges.push({ key: "cashLike", label: "현금성", className: TONE.muted, title: "현금성 ETF — 트레일링 스탑을 적용하지 않습니다." });
  }
  return badges;
}

/** 체결 배지 — 사후 체결이면 하나. */
export function fillBadges(fill: { backfill: boolean }): Badge[] {
  return fill.backfill
    ? [{ key: "backfill", label: "사후 체결", className: TONE.info, title: "그날 종가로 나중에 기록한 체결입니다(관측 시각 = 그날 마감)." }]
    : [];
}

/** 스탑 칸 — 현금성은 적용 안 함, 값이 없으면 "—". */
export function stopText(position: Pick<PaperPosition, "cashLike" | "stopPrice" | "stopDistancePct">): string {
  if (position.cashLike) return "적용 안 함";
  if (position.stopPrice === null || position.stopPrice === undefined) return EMPTY;
  const distance = position.stopDistancePct === null || position.stopDistancePct === undefined
    ? ""
    : ` · 거리 ${formatWithUnit(position.stopDistancePct, 1, "%")}`;
  return `${formatSharePrice(position.stopPrice)}${distance}`;
}

/** 보유 기간 칸 — "2026-10-23부터 · 3거래일". 모르는 부분은 "—". */
export function heldText(position: Pick<PaperPosition, "openedOn" | "holdingTradingDays">): string {
  const since = position.openedOn ? `${position.openedOn}부터` : EMPTY;
  const days = position.holdingTradingDays === null || position.holdingTradingDays === undefined
    ? EMPTY
    : `${formatNumber(position.holdingTradingDays, 0)}거래일`;
  return `${since} · ${days}`;
}

/**
 * 일시정지·재개 버튼. 시작 전인 책은 null — 시작은 초기 결정이 합니다(규칙 책은 개요의 '규칙 계좌 시작', 백엔드도 거절).
 */
export function statusToggle(status: string | null | undefined): { next: "ACTIVE" | "PAUSED"; label: string } | null {
  if (status === "ACTIVE") return { next: "PAUSED", label: "일시정지" };
  if (status === "PAUSED") return { next: "ACTIVE", label: "재개" };
  return null;
}

/**
 * 시작 전인 책에 버튼 대신 적는 안내. 책 종류마다 시작하는 길이 다릅니다 — 벤치마크는 초기 결정이 아니라 출발일 종가의
 * 사후 체결로 시작하므로, 종가가 없어 시작 전에 남았다면 할 일은 "기다렸다가 초기화를 다시 누르기"입니다.
 */
export function notStartedNote(kind: string | null | undefined): string {
  if (kind === "BENCHMARK") {
    return "시작 전인 벤치마크 계좌는 출발일 종가로 사후 체결해 시작합니다 — 종가를 받은 뒤 초기화를 다시 누르세요"
      + "(개요 탭의 '초기화' 또는 아래 '계좌 초기화'). 지금은 현금만 듭니다.";
  }
  if (kind === "RULES") {
    return "시작 전인 규칙 계좌는 개요 탭의 '규칙 계좌 시작'(초기 결정)으로 시작합니다 — 출발일 기준 선정·신호로 고른 종목을 "
      + "출발일 종가에 사후 체결합니다. 지금은 현금만 듭니다.";
  }
  if (kind === "CLAUDE") {
    return "시작 전인 Claude 계좌는 개요 탭의 'Claude 계좌 시작'(초기 결정)으로 시작합니다 — 출발일 기준 입력 패킷으로 Claude가 "
      + "고른 주문 가운데 검증(하드 규칙)을 통과한 것만 출발일 종가에 사후 체결합니다. 지금은 현금만 듭니다.";
  }
  return "시작 전인 계좌는 초기 결정으로 시작합니다 — 지금은 현금만 듭니다.";
}

/** 보유·체결 탭의 기본 책 — 고른 책이 목록에 있으면 그것, 아니면 처음으로 시작한 책, 그것도 없으면 첫 책. */
export function resolveBookCode(picked: string, books: readonly PaperBookSummary[]): string | null {
  if (books.some((book) => book.code === picked)) return picked;
  return books.find((book) => book.status !== "NOT_STARTED")?.code ?? books[0]?.code ?? null;
}

/** 책 선택 상자의 선택지. */
export function bookOptions(books: readonly PaperBookSummary[]) {
  return books.map((book) => ({ value: book.code, label: `${book.label} · ${bookStatusBadge(book.status).label}` }));
}

/**
 * 초기화 카드 — 보일 때만 제목·본문, 아니면 null.
 *
 * 초기화 전(`initialized:false`)뿐 아니라, 책 네 개는 있어도 벤치마크가 출발일 종가를 못 받아 시작 전으로 남았으면
 * (`pendingBackfill`) 카드를 계속 보입니다. init은 그때 오류가 아니라 200 + skipped를 돌려주고 책은 만들어 두므로,
 * `initialized`만 보면 다시 누를 버튼이 사라져 보유 탭의 책 초기화라는 우회로밖에 남지 않았습니다.
 */
export function initPrompt(
  overview: Pick<PaperOverviewResponse, "initialized" | "pendingBackfill" | "startDate" | "books">,
): { title: string; body: string } | null {
  const start = overview.startDate ?? EMPTY;
  if (overview.initialized === false) {
    return {
      title: "장부 초기화",
      body: `아직 장부가 없습니다. 초기화하면 계좌 네 개를 만들고, 두 벤치마크 계좌를 출발일(${start}) 종가로 사후 체결합니다. `
        + "규칙 계좌·Claude 계좌는 현금만 든 채 '시작 전'으로 둡니다 — 초기화 뒤 개요의 '규칙 계좌 시작'·'Claude 계좌 시작'"
        + "(초기 결정)으로 각각 시작합니다. "
        + "여러 번 눌러도 이미 있는 계좌는 다시 만들지 않습니다.",
    };
  }
  const pending = overview.pendingBackfill ?? [];
  if (pending.length === 0) return null;
  const books = overview.books ?? [];
  const names = pending.map((code) => books.find((book) => book.code === code)?.label ?? code).join(", ");
  return {
    title: "벤치마크 사후 체결 대기",
    body: `${names}: 출발일(${start}) 종가를 아직 받지 못해 시작하지 않았습니다(현금만). 종가를 받은 뒤 초기화를 다시 누르세요 — `
      + "이미 있는 계좌는 다시 만들지 않고, 시작 전인 벤치마크만 그 종가로 사후 체결합니다.",
  };
}

/** 초기화 결과 한 줄. */
export function initResultText(result: PaperInitResult): string {
  const created = result.created ?? [];
  const backfilled = result.backfilled ?? [];
  const parts = [created.length > 0 ? `만든 계좌 ${created.join(", ")}` : "새로 만든 계좌 없음(이미 있음)"];
  if (backfilled.length > 0) parts.push(`사후 체결 ${backfilled.join(", ")}`);
  for (const skip of result.skipped ?? []) parts.push(`${skip.code} 시작하지 않음 — ${skip.reason}`);
  return parts.join(" · ");
}

/** 리스크 작업 결과 한 줄. 건너뛴 이유가 있으면 덧붙입니다. */
export function riskOutcomeText(outcome: PaperRiskOutcome | null | undefined): string {
  if (!outcome) return "결과를 받지 못했습니다.";
  const books = outcome.booksProcessed ?? [];
  const text = `체결 ${outcome.filled} · 스탑 ${outcome.stopped} · 만료 ${outcome.expired} · 분할 ${outcome.splits}` +
    ` · 처리한 계좌 ${books.length > 0 ? books.join(", ") : "없음"}`;
  return outcome.skippedReason ? `${text} — ${outcome.skippedReason}` : text;
}

/** 리스크 작업 결과의 표시 — 배너 색·요약 줄·오류·메모. */
export interface RiskResultView {
  tone: "warn" | "info";
  /** ok:false일 때 맨 앞에 적을 경고 한 줄, 성공이면 null. */
  warning: string | null;
  summary: string;
  errors: string[];
  notes: string[];
}

/**
 * 리스크 작업 결과(POST run/risk)를 화면에 그릴 모양으로.
 *
 * 한 책이 오류로 되돌려져도 HTTP는 200이라 useAsyncAction은 성공으로 칩니다 — 그래서 응답의 ok를 따로 봐야 합니다.
 * ok:false면 경고색 + errors를, 성공이든 아니든 notes(현금 부족으로 줄인 매수·취소한 주문·분할)를 함께 보입니다.
 * 버리면 사용자는 "체결 0"만 보고 왜 그런지(또는 실패했는지) 알 수 없었습니다.
 */
export function riskResultView(result: PaperRiskResult): RiskResultView {
  const outcome = result.outcome ?? null;
  const errors = outcome?.errors ?? [];
  const failed = result.ok === false;
  return {
    tone: failed ? "warn" : "info",
    warning: !failed
      ? null
      : errors.length > 0
        ? "오류가 난 계좌가 있습니다 — 그 계좌는 이번 관측치 처리를 되돌렸습니다(장부는 그대로)."
        : "리스크 작업이 돌지 않았습니다.",
    // 테이블이 없을 때는 outcome 없이 서버 문구만 옵니다.
    summary: outcome ? riskOutcomeText(outcome) : (result.message ?? riskOutcomeText(null)),
    errors,
    notes: outcome?.notes ?? [],
  };
}

/** 일시정지·재개 결과 한 줄. */
export function statusResultText(result: PaperBookStatusResult): string {
  const cancelled = result.cancelledOrders;
  const tail = cancelled !== null && cancelled !== undefined && cancelled > 0 ? ` · 대기 주문 ${cancelled}건 취소` : "";
  return `${result.book.label}: ${bookStatusBadge(result.book.status).label}${tail}`;
}

/**
 * 책 초기화 결과 — 배너 색과 한 줄. 벤치마크를 다시 사후 체결하지 못했으면(종가 없음) 서버 사유를 경고로 붙입니다.
 * 사유를 버리면 "초기화했습니다 — 지금 시작 전"만 남아, 왜 벤치마크가 현금만 들고 있는지 알 수 없었습니다.
 */
export function resetResultView(result: PaperBookResetResult): { tone: "warn" | "info"; text: string } {
  const base = `${withParticle(result.book.label, "을")} 초기화했습니다 — 지금 ${bookStatusBadge(result.book.status).label}`;
  if (result.skippedReason) {
    return { tone: "warn", text: `${base}. 출발일 종가로 다시 사후 체결하지 못했습니다 — ${result.skippedReason}` };
  }
  return { tone: "info", text: result.backfilled ? `${base} · 출발일 종가로 다시 사후 체결했습니다` : base };
}

// ---------------------------------------------------------------- 기관 선정(13F 트랙레코드)

const TRACK_METRIC: Record<string, string> = {
  CAGR: "연율 수익률(CAGR)",
  EXCESS_VS_SPY: "SPY 대비 초과 수익률",
  SHARPE: "샤프",
};

/** 순위 기준 이름. 모르는 값은 받은 글자 그대로. */
export const trackMetricLabel = (metric: string | null | undefined) => labelOf(TRACK_METRIC, metric);

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
// 결정 기록·선정 기록은 JSON 그대로 오므로 모양을 믿지 않고 하나씩 확인해 읽습니다.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const textOf = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const numberOf = (value: unknown): number | null => (isNumber(value) ? value : null);
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * 0~1 비율을 %로 — 커버리지 표기. 백엔드는 커버리지를 자격 기준(0.5·0.7)과 같은 비율로 보내므로 표기할 때만 100을 곱합니다
 * (주문의 sellFraction 표기와 같음). 소수 1자리 — 0자리면 49.7%가 "50%"로 보여 기준(50%)을 넘은 것처럼 읽힙니다.
 */
export function formatCoverage(value: number | null | undefined): string {
  return isNumber(value) ? formatWithUnit(value * 100, 1, "%") : EMPTY;
}

/** SPY 대비 초과(%p). 수익률(%)끼리의 차이라 단위가 %p입니다. */
export function formatExcessPoints(value: number | null | undefined): string {
  return isNumber(value) ? `${formatSigned(value, 2)}%p` : EMPTY;
}

/** 자격 기준 한 줄 — "창 7년 · 구간 ≥ 24개 · 최소 커버리지 ≥ 50% · 평균 커버리지 ≥ 70%". 기준을 모르면 null. */
export function criteriaText(criteria: PaperTrackRecordCriteria | null | undefined): string | null {
  if (!criteria) return null;
  const threshold = (ratio: number) => (isNumber(ratio) ? formatWithUnit(ratio * 100, 0, "%") : EMPTY);
  return [
    `창 ${formatWithUnit(criteria.windowYears, 0, "년")}`,
    `구간 ≥ ${formatWithUnit(criteria.minPeriods, 0, "개")}`,
    `최소 커버리지 ≥ ${threshold(criteria.minCoverage)}`,
    `평균 커버리지 ≥ ${threshold(criteria.avgCoverage)}`,
  ].join(" · ");
}

/**
 * 자격 배지 — 자격 · 수집 중 · 자격 없음. 사유 문구는 서버가 보낸 그대로 배지 옆에 적습니다(화면이 사유를 짓지 않음).
 * 수집 중(30분기를 아직 다 받지 못함)은 기준 미달과 성격이 달라 — 기다리면 풀림 — 경고색이 아니라 흐린 색입니다.
 *
 * 그룹 B는 30분기 수집이 끝났는지와 상관없이 있는 저장본(q30, 없으면 q8)으로 재므로(D27), complete=false를 수집 중으로 보지 않고
 * 서버가 collecting을 참으로 보낼 때만 수집 중입니다 — 기존 메뉴 기관의 q8 저장본은 complete가 늘 거짓이라 전부 "수집 중"으로 보였을 것입니다.
 */
export function eligibilityBadge(
  candidate: Pick<PaperTrackRecordCandidate, "eligible" | "collecting" | "complete">,
  group: "A" | "B" = "A",
): Badge {
  if (candidate.eligible) {
    return { key: "eligible", label: "자격", className: TONE.ok, title: "자격 기준(구간 수·최소/평균 커버리지)을 모두 넘었습니다." };
  }
  if (candidate.collecting === true || (group === "A" && candidate.complete === false)) {
    return {
      key: "collecting", label: "수집 중", className: TONE.muted,
      title: "13F 분기 공시를 아직 다 받지 못해 자격 판정에서 뺐습니다 — 수집기가 다음 실행에 이어 받습니다.",
    };
  }
  return { key: "ineligible", label: "자격 없음", className: TONE.warn, title: "자격 기준에 못 미쳐 순위에서 뺐습니다." };
}

/** 선정 배지 — 그 기준일의 선정에 든 기관만. */
export function selectedBadge(candidate: Pick<PaperTrackRecordCandidate, "selected">): Badge | null {
  return candidate.selected
    ? { key: "selected", label: "선정", className: TONE.info, title: "이 기준일의 선정(상위 기관)에 든 기관 — 규칙 계좌가 이 기관들의 13F 신호를 씁니다." }
    : null;
}

/**
 * 후보 표의 행 순서 — 순위가 있는(자격 있는) 기관을 순위대로, 그 뒤에 순위가 없는 기관을 서버가 보낸 순서대로.
 * 순위는 서버가 매긴 값 그대로이고 화면은 다시 매기지 않습니다. 서버가 이미 이 순서로 보내면 바뀌는 것이 없습니다(안정 정렬).
 */
export function trackRecordRows(candidates: readonly PaperTrackRecordCandidate[] | null | undefined): PaperTrackRecordCandidate[] {
  const order = (candidate: PaperTrackRecordCandidate) => (isNumber(candidate.rank) ? candidate.rank : Number.POSITIVE_INFINITY);
  return [...(candidates ?? [])].sort((a, b) => {
    const left = order(a);
    const right = order(b);
    return left === right ? 0 : left < right ? -1 : 1;
  });
}

/** 구간 칸 — "수익률이 있는 구간 / 창 안 구간"(예: "26/27"). 둘 다 모르면 "—". */
export function periodsText(candidate: Pick<PaperTrackRecordCandidate, "periodsUsed" | "periodsTotal">): string {
  if (!isNumber(candidate.periodsUsed) && !isNumber(candidate.periodsTotal)) return EMPTY;
  return `${formatNumber(candidate.periodsUsed, 0)}/${formatNumber(candidate.periodsTotal, 0)}`;
}

/** 공시 기간 — "2019-11-14 ~ 2026-08-14". 모르는 쪽은 "—". */
export function filingSpanText(candidate: Pick<PaperTrackRecordCandidate, "firstFilingDate" | "lastFilingDate">): string {
  if (!candidate.firstFilingDate && !candidate.lastFilingDate) return EMPTY;
  return `${candidate.firstFilingDate ?? EMPTY} ~ ${candidate.lastFilingDate ?? EMPTY}`;
}

/**
 * 수집 칸 — "30/30 · 완료", "18/30 · 수집 중". 목표 분기 수를 모르면 "18분기 · 수집 중".
 * complete는 30분기를 다 받았거나 EDGAR에 더 오래된 원본 공시가 없다는 뜻이라, 30에 못 미쳐도 "완료"일 수 있습니다(신생 운용사).
 */
export function quartersText(
  candidate: Pick<PaperTrackRecordCandidate, "storedQuarters" | "complete">,
  targetQuarters: number | null,
): string {
  const stored = candidate.storedQuarters;
  const count = !isNumber(stored)
    ? EMPTY
    : targetQuarters === null
      ? `${formatNumber(stored, 0)}분기`
      : `${formatNumber(stored, 0)}/${formatNumber(targetQuarters, 0)}`;
  return `${count} · ${candidate.complete ? "완료" : "수집 중"}`;
}

/** 개수 — 정수면 그대로, 목록이면 길이(계약상 개수지만 목록으로 와도 "[object Object]"를 그리지 않게), 아니면 null. */
function countOf(value: unknown): number | null {
  if (isNumber(value)) return value;
  return Array.isArray(value) ? value.length : null;
}

/** 수집 진행률 카드의 표시. */
export interface CollectionView {
  /** 기관마다의 목표 분기 수(30). 모르면 null — 수집 칸이 "n분기"로만 적습니다. */
  targetQuarters: number | null;
  line: string;
}

/**
 * 수집 진행률 — "후보 27곳 중 수집 완료 20곳 · 저장 공시 700/810건 · 마지막 수집 …".
 *
 * 기관마다의 목표 분기 수는 서버가 보내면(targetQuarters) 그것을, 아니면 목표 공시 수 ÷ 기관 수가 나누어떨어질 때만 그 몫을
 * 씁니다 — 목표 공시 수가 기관 수 × 30으로 정의돼 있어서입니다. 나누어떨어지지 않으면 정의가 다르다는 뜻이라 짐작하지 않습니다(null).
 */
export function collectionView(collection: PaperTrackRecordCollection | null | undefined): CollectionView {
  if (!collection) {
    return {
      targetQuarters: null,
      line: "수집 진행률 저장본(sec.13f.track_record_index)이 아직 없습니다 — 수집기의 13F 트랙레코드 태스크가 한 번 돌면 생깁니다.",
    };
  }
  const filers = countOf(collection.filers);
  const sent = collection.targetQuarters;
  const derived = filers !== null && filers > 0 && isNumber(collection.targetFilings) && collection.targetFilings % filers === 0
    ? collection.targetFilings / filers
    : null;
  return {
    targetQuarters: isNumber(sent) ? sent : derived,
    line: [
      `후보 ${formatWithUnit(filers, 0, "곳")} 중 수집 완료 ${formatWithUnit(collection.completeCount, 0, "곳")}`,
      `저장 공시 ${formatNumber(collection.storedFilings, 0)}/${formatNumber(collection.targetFilings, 0)}건`,
      `마지막 수집 ${formatKst(collection.updatedAtKst)}`,
    ].join(" · "),
  };
}

/** 구간의 커버리지 칸 — "82.4% (티커 31개 · 보유 40줄)". 보유 줄에는 티커가 없는 줄도 듭니다. */
export function periodCoverageText(period: Pick<PaperTrackRecordPeriod, "coverage" | "coveredTickers" | "holdings">): string {
  return `${formatCoverage(period.coverage)} (티커 ${formatWithUnit(period.coveredTickers, 0, "개")} · 보유 ${formatWithUnit(period.holdings, 0, "줄")})`;
}

/** 선정 이력 한 줄 — 기준일과 선정 기관 이름(후보 목록에 없는 CIK는 CIK 그대로). */
export interface SelectionHistoryRow {
  asOfDate: string;
  names: string;
}

/**
 * 선정 이력 줄. 그룹 섞기(D27) 뒤의 선정은 신호 풀(A 순서 뒤에 B에만 있는 기관)이라 이름은 그룹 A·B 후보 목록 둘 다에서 찾습니다 —
 * 앞에 둔 목록(그룹 A)의 이름이 먼저입니다(두 그룹에 모두 있는 기관의 이름이 줄마다 바뀌지 않게).
 */
export function selectionHistoryRows(
  history: readonly PaperSelectionHistoryEntry[] | null | undefined,
  candidates: readonly PaperTrackRecordCandidate[] | null | undefined,
): SelectionHistoryRow[] {
  const names = new Map<string, string>();
  for (const candidate of candidates ?? []) {
    if (!names.has(candidate.cik)) names.set(candidate.cik, candidate.name);
  }
  return (history ?? []).map((entry) => {
    const ciks = entry.selectedCiks ?? [];
    return {
      asOfDate: entry.asOfDate,
      // 자격 있는 기관이 0곳이면 선정도 비어 있습니다 — 그때 규칙 책은 매수 없이 SHY만 듭니다(설계 §4-0 ⑤).
      names: ciks.length > 0 ? ciks.map((cik) => names.get(cik) ?? cik).join(", ") : "선정 없음 — 자격 있는 기관이 없었습니다",
    };
  });
}

/**
 * 수동 재계산 결과 — 배너 색과 한 줄. ok:false(테이블 없음 등)면 서버 문구를 경고로.
 * 서버가 계산하지 못한 이유(skippedReason)를 보내면 그 문구 그대로 — 원인(후보 목록 저장본 없음, 설정 후보가 수집 목록과
 * 겹치지 않음)마다 할 일이 달라 화면이 한 가지 안내로 뭉뚱그리지 않습니다(resetResultView와 같은 방식).
 * computed는 계산한 후보 수(정수)나 참·거짓으로 옵니다(타입 주석). 선정은 바꾸지 않는다는 것을 결과에도 적습니다 —
 * 순위가 바뀌어 보여도 규칙 책이 쓰는 선정은 그대로라는 것을 놓치기 쉽습니다.
 */
export function rerankResultView(result: PaperRerankResult): { tone: "warn" | "info"; text: string } {
  if (result.ok === false) return { tone: "warn", text: result.message ?? "다시 계산하지 못했습니다." };
  const asOf = result.asOfDate ?? EMPTY;
  if (result.skippedReason) {
    return { tone: "warn", text: `${asOf} 기준 — 계산하지 못했습니다: ${result.skippedReason}` };
  }
  if (result.computed === false || result.computed === 0) {
    return { tone: "warn", text: `${asOf} 기준 — 계산할 후보가 없었습니다. 수집 진행률을 보세요.` };
  }
  const count = isNumber(result.computed) ? ` · 후보 ${formatNumber(result.computed, 0)}곳` : "";
  const unchanged = result.selectedUnchanged === false
    ? ""
    : " — 선정은 바꾸지 않았습니다(선정은 재선정일·초기 선정 때 한 번만 남깁니다)";
  return { tone: "info", text: `${asOf} 기준으로 다시 계산했습니다${count}${unchanged}.` };
}

// ---------------------------------------------------------------- 두 기관 그룹·신호 풀(D27)

/** 창 이름 — "7년 창". 연수를 모르면 "창"(숫자를 지어내지 않음). */
export function windowLabel(years: number | null | undefined): string {
  return isNumber(years) ? `${formatNumber(years, 0)}년 창` : "창";
}

/**
 * 그룹 B 자격 기준. 서버가 기준을 통째로 보내면 그것을, 아니면 그룹 B의 창·구간 수에 그룹 A의 커버리지 기준을 붙입니다 —
 * 계약상 그룹 B의 커버리지 기준은 그룹 A(trackRecord.minCoverage·avgCoverage)와 같습니다. 창·구간 수를 모르면 null.
 */
export function groupBCriteria(
  groupB: Pick<PaperTrackRecordGroupB, "windowYears" | "minPeriods" | "criteria"> | null | undefined,
  criteriaA: PaperTrackRecordCriteria | null | undefined,
): PaperTrackRecordCriteria | null {
  if (!groupB) return null;
  if (groupB.criteria) return groupB.criteria;
  if (!isNumber(groupB.windowYears) || !isNumber(groupB.minPeriods) || !criteriaA) return null;
  return {
    windowYears: groupB.windowYears,
    minPeriods: groupB.minPeriods,
    minCoverage: criteriaA.minCoverage,
    avgCoverage: criteriaA.avgCoverage,
  };
}

/**
 * 그룹 B의 한계 한 줄. 창이 짧으면 구간이 몇 개뿐이라 한 국면을 크게 탄 기관이 순위를 차지합니다 — 7년 창의 그룹 A와 같은 무게로
 * 읽으면 안 된다는 것을 표 옆에 적습니다. 연수는 응답 값(설정 blend.groupB.windowYears)이고, 모르면 숫자 없이 적습니다.
 */
export function groupBLimit(windowYearsB: number | null | undefined, windowYearsA: number | null | undefined): string {
  const longer = isNumber(windowYearsA) ? `${windowLabel(windowYearsA)}의 그룹 A` : "그룹 A";
  return `그룹 B는 ${isNumber(windowYearsB) ? windowLabel(windowYearsB) : "짧은 창"} — 표본이 짧다. 분기 공시 구간이 몇 개뿐이라 `
    + `한 국면을 크게 탄 기관이 순위를 차지하기 쉽고, ${longer}보다 우연의 몫이 큽니다. 기존 13F 메뉴의 저장본(q8)이 8분기라 더 길게 재지 못합니다.`;
}

/**
 * 한계 카드의 줄 — 서버 문구 그대로, 그룹 B가 있으면 그룹 B 줄을 덧붙입니다. 서버가 이미 그룹 B 줄을 보내면(문구에 "그룹 B")
 * 덧붙이지 않습니다 — 같은 한계를 두 번 적지 않게.
 */
export function trackRecordLimits(
  limits: readonly string[] | null | undefined,
  groupB: Pick<PaperTrackRecordGroupB, "windowYears"> | null | undefined,
  windowYearsA: number | null | undefined,
): string[] {
  const lines = [...(limits ?? [])];
  if (groupB && !lines.some((line) => line.includes("그룹 B"))) lines.push(groupBLimit(groupB.windowYears, windowYearsA));
  return lines;
}

const TRACK_SOURCE: Record<string, string> = {
  q30: "후보 수집 저장본(sec.13f.{cik}.q30) — 같은 분기 JSON의 CUSIP 매핑 티커",
  q8: "기존 13F 메뉴 저장본(sec.13f.{cik}.q8, 8분기) — 이름·클래스 매핑 티커",
};

/** 그룹 B 출처 칸 — "q30 · 30분기", "q8 · 8분기". 저장 분기 수를 모르면 출처만, 출처를 모르면 "—". */
export function trackSourceText(
  candidate: Pick<PaperTrackRecordCandidate, "source" | "storedQuarters">,
): { label: string; title?: string } {
  const source = textOf(candidate.source);
  if (!source) return { label: EMPTY };
  const stored = isNumber(candidate.storedQuarters) ? ` · ${formatNumber(candidate.storedQuarters, 0)}분기` : "";
  return { label: `${source}${stored}`, title: TRACK_SOURCE[source] };
}

/** 그룹 이름 목록을 정리 — 글자만, 대문자, 중복 없이, A·B 먼저(그 밖의 값은 받은 순서대로 뒤에). */
export function groupsOf(value: unknown): string[] {
  const seen: string[] = [];
  for (const entry of listOf(value)) {
    const group = typeof entry === "string" ? entry.trim().toUpperCase() : "";
    if (group && !seen.includes(group)) seen.push(group);
  }
  const rank = (group: string) => (group === "A" ? 0 : group === "B" ? 1 : 2);
  return seen.sort((a, b) => rank(a) - rank(b));
}

const GROUP_TITLE: Record<string, { title: string; tone: BadgeTone }> = {
  A: { title: "그룹 A — 후보 기관 트랙레코드(긴 창) 상위", tone: "info" },
  B: { title: "그룹 B — 기존 13F 메뉴 기관의 최근(짧은 창) 상위", tone: "muted" },
  AB: { title: "두 그룹 모두 — 기관 가중을 두 그룹에서 다 받습니다", tone: "ok" },
};

/** 그룹 배지 — "A" · "B" · "AB"(두 그룹 모두). 그룹을 모르면 null. 모르는 그룹 이름은 받은 글자 그대로 붙입니다. */
export function groupBadge(groups: unknown): Badge | null {
  const list = groupsOf(groups);
  if (list.length === 0) return null;
  const label = list.join("");
  const known = GROUP_TITLE[label];
  return { key: `group-${label}`, label, className: TONE[known?.tone ?? "muted"], title: known?.title };
}

/** 그룹 순위 — "A 1위 · B 1위", "A 3위", "B 2위". 둘 다 모르면 "—". */
export function groupRankText(rankA: number | null | undefined, rankB: number | null | undefined): string {
  const parts = [
    isNumber(rankA) ? `A ${formatNumber(rankA, 0)}위` : null,
    isNumber(rankB) ? `B ${formatNumber(rankB, 0)}위` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : EMPTY;
}

/**
 * 0~1 비율을 %로(소수 1자리) — 기관 가중·확신도. 서버는 둘 다 비율로 보내고(합 1·상한 1) 표기할 때만 100을 곱합니다
 * (커버리지 표기와 같음). 모르면 "—".
 */
export function formatRatioPercent(value: number | null | undefined): string {
  return isNumber(value) ? formatWithUnit(value * 100, 1, "%") : EMPTY;
}

/** 후보 점수·점수 기여(Σ 기관 가중 × 확신도, 0~1) — 소수 3자리. 모르면 "—". */
export function formatScore(value: number | null | undefined): string {
  return formatNumber(numberOf(value), 3);
}

/** 신호 풀 한 줄(표시 문자열). */
export interface PoolRow {
  key: string;
  cik: string;
  name: string;
  group: Badge | null;
  rankA: string;
  rankB: string;
  /** 두 그룹 순위를 한 칸에 — "A 1위 · B 1위". */
  ranks: string;
  weight: string;
}

/**
 * 신호 풀(선정 행의 ranking.pool, 결정 기록의 selection.pool)을 표 줄로 — 서버 순서 그대로(A 순서 뒤에 B에만 있는 기관).
 * 가중은 서버가 낸 기관 가중(0~1) 그대로이고 화면은 다시 계산하지 않습니다. JSON이라 줄마다 모양을 확인하고, CIK가 없는 줄은 뺍니다.
 */
export function signalPoolRows(pool: unknown): PoolRow[] {
  return listOf(pool).filter(isRecord).flatMap((entry, index) => {
    const cik = textOf(entry.cik);
    if (!cik) return [];
    const rankA = numberOf(entry.rankA);
    const rankB = numberOf(entry.rankB);
    return [{
      key: `${index}-${cik}`,
      cik,
      name: textOf(entry.name) ?? `CIK ${cik}`,
      group: groupBadge(entry.groups),
      rankA: rankA === null ? EMPTY : `${formatNumber(rankA, 0)}위`,
      rankB: rankB === null ? EMPTY : `${formatNumber(rankB, 0)}위`,
      ranks: groupRankText(rankA, rankB),
      weight: formatRatioPercent(numberOf(entry.weight)),
    }];
  });
}

/**
 * 신호 풀 표 위의 한 줄 — 기관 가중을 어떻게 나눴는지. 그룹 A 몫 g를 서버가 보내면 숫자로(50% · 50%), 아니면 g로 적습니다.
 */
export function poolWeightNote(groupWeightA: number | null | undefined): string {
  const share = isNumber(groupWeightA)
    ? `그룹 A ${formatRatioPercent(groupWeightA)} · 그룹 B ${formatRatioPercent(1 - groupWeightA)}`
    : "그룹 A 몫 g · 그룹 B 몫 1 − g";
  return `신호 풀 = 그룹 A ∪ 그룹 B(겹치는 기관은 한 번). 기관 가중 = ${share}을 각 그룹 안의 순위 가중(1위가 가장 큼, 그룹 안 합 1)으로 `
    + "나눈 값이고, 두 그룹에 모두 든 기관은 두 몫을 다 받습니다. 한 그룹이 비면 다른 그룹이 전부 받습니다(풀 합 100%).";
}

// ---------------------------------------------------------------- 규칙 책 시작(초기 결정)

/** 개요의 "규칙 책 시작" 카드. */
export interface RulesStartPrompt {
  /** 초기 결정을 보낼 책 코드(본문 `{book}`). */
  bookCode: string;
  title: string;
  body: string;
  /** 확인 단계에서 보일 문구. */
  confirm: string;
}

/**
 * 규칙 책 시작 카드 — 규칙 책이 시작 전(NOT_STARTED)일 때만, 아니면 null.
 *
 * 시작은 되돌리기 어려운 동작이라(되돌리려면 책 초기화로 장부를 지워야 함) 카드에 무엇을 하는지 적고, 버튼은 확인 단계를 한 번 거칩니다.
 * 규칙은 두 기관 그룹을 섞는 방식(D27 — 그룹 A·B 선정, 기관 가중 × 확신도 점수, 확신도 비례 배분)이라 그 순서대로 적습니다.
 * 기준 숫자(7년·5곳·2년·4곳·2곳·+30%·10%·10종목·1%)는 설정의 기본값이라 "기본값"이라고 적습니다 — 지금 설정값은 설정 탭(단계 3a)이 보입니다.
 * 트랙레코드 수집이 끝났는지는 화면이 판단하지 않습니다 — 서버가 "수집 중"(400)으로 거절하고, 화면은 그 문구를 그대로 보입니다.
 */
export function rulesStartPrompt(
  overview: Pick<PaperOverviewResponse, "initialized" | "startDate" | "books">,
): RulesStartPrompt | null {
  if (overview.initialized === false) return null;
  const rules = (overview.books ?? []).find((book) => book.kind === "RULES");
  if (!rules || rules.status !== "NOT_STARTED") return null;
  const start = overview.startDate ?? EMPTY;
  return {
    bookCode: rules.code,
    title: `${rules.label} 시작`,
    body: `${withParticle(rules.label, "은")} 아직 현금만 들고 있습니다. 시작하면 출발일(${start}) 기준으로(그날 이전 공시·가격만) 신호 기관 두 그룹을 `
      + "뽑습니다 — 그룹 A는 후보 기관의 7년 트랙레코드 상위 5곳, 그룹 B는 기존 '기관 13F 포트폴리오 분석' 메뉴 기관의 최근 2년 상위 "
      + "4곳입니다. 두 그룹을 합친 신호 풀의 최신 분기 13F에서 2곳 이상이 신규 편입하거나 주식 수를 30% 이상 늘린 종목마다 점수"
      + "(기관 가중 × 확신도 — 그 종목이 그 기관 13F에서 차지하는 비중, 10%에서 상한)를 매기고, 점수 순 상위 10종목을 확신도 비례 "
      + "비중(가장 높은 점수가 종목 상한 10%, 목표 1% 미만은 뺌)으로 출발일 종가에 사후 체결합니다. 남는 현금은 SHY에 둡니다. "
      + "숫자는 모두 설정의 기본값입니다. 매크로 게이트는 쓰지 않습니다(참고 지표로 기록만).",
    confirm: `정말 시작할까요? 출발일(${start}) 종가로 사후 체결하고 계좌를 '운용 중'으로 바꿉니다. 되돌리려면 보유·체결 탭의 `
      + "'계좌 초기화'로 이 계좌의 장부를 모두 지워야 합니다. 후보 기관의 13F 수집이 끝나지 않았으면 서버가 거절합니다.",
  };
}

/**
 * 초기 결정("시작") 결과 — 배너 색과 한 줄. ok:false면 서버 문구를 경고로.
 * 주문이 하나도 없으면(NO_TRADE) 시작은 했지만 현금만 든다는 것을 경고색으로 적습니다 — 정보색이면 "종목을 샀다"로 읽힙니다.
 * 결정에 오류가 있으면(Claude 책의 응답 형식 오류·모델 거절·API 오류) 경고색으로 오류를 붙입니다 — 그때는 그날 재량 주문이 없습니다.
 *
 * @param bookLabel 시작한 책 이름(기본 "규칙 계좌"). Claude 책 카드는 그 책 이름을 넘깁니다.
 */
export function initialDecisionResultView(
  result: PaperInitialDecisionResult,
  bookLabel = "규칙 계좌",
): { tone: "warn" | "info"; text: string } {
  const object = withParticle(bookLabel, "을");
  if (result.ok === false) return { tone: "warn", text: result.message ?? `${object} 시작하지 못했습니다.` };
  const decision = result.decision ?? null;
  const noTrade = decision?.status === "NO_TRADE";
  const parts = [
    `${decision?.asOfTradingDate ?? EMPTY} ${decisionKindLabel(decision?.kind ?? "INITIAL")}`,
    `주문 ${formatWithUnit(decision?.orderCount, 0, "건")}`,
    `사후 체결 ${formatWithUnit(countOf(result.fills), 0, "건")}`,
  ];
  const head = noTrade ? `${object} 시작했지만 주문이 없습니다 — 현금만 듭니다` : `${object} 시작했습니다`;
  const summary = decision?.summary ? ` — ${decision.summary}` : "";
  const error = decision?.error ? ` — 오류: ${decision.error}` : "";
  return { tone: noTrade || error ? "warn" : "info", text: `${head} · ${parts.join(" · ")}${summary}${error}` };
}

// ---------------------------------------------------------------- 결정 로그

const DECISION_KIND: Record<string, string> = {
  SCHEDULED: "정기",
  MANUAL: "수동",
  REBALANCE: "재선정일",
  INITIAL: "초기 결정",
};

/** 결정 종류 이름. 모르는 값은 받은 글자 그대로. */
export const decisionKindLabel = (kind: string | null | undefined) => labelOf(DECISION_KIND, kind);

const DECISION_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  OK: { label: "주문 냄", tone: "ok" },
  NO_TRADE: { label: "주문 없음", tone: "muted" },
  REFUSED: { label: "모델 거절", tone: "warn" },
  FORMAT_ERROR: { label: "응답 형식 오류", tone: "warn" },
  API_ERROR: { label: "API 오류", tone: "warn" },
  SKIPPED: { label: "건너뜀", tone: "muted" },
};

/** 결정 상태 배지. 모르는 상태는 받은 글자 그대로(지어내지 않음). */
export function decisionStatusBadge(status: string | null | undefined): Badge {
  const known = status ? DECISION_STATUS[status] : undefined;
  return { key: status ?? "unknown", label: known?.label ?? status ?? EMPTY, className: TONE[known?.tone ?? "muted"] };
}

/** 주문 칸 — "3건", 거절이 있으면 "3건 · 거절 1". 모르면 "—". */
export function decisionOrdersText(decision: Pick<PaperDecisionSummary, "orderCount" | "rejectedCount">): string {
  if (!isNumber(decision.orderCount)) return EMPTY;
  const rejected = isNumber(decision.rejectedCount) && decision.rejectedCount > 0
    ? ` · 거절 ${formatNumber(decision.rejectedCount, 0)}`
    : "";
  return `${formatNumber(decision.orderCount, 0)}건${rejected}`;
}

/** 가격 칸 — 확정 종가로 냈는지. false는 경고색(마감 확정 전 값으로 낸 결정), 모르면 "—". */
export function pricesFinalText(value: boolean | null | undefined): { label: string; className: string } {
  if (value === true) return { label: "확정 종가", className: "text-body" };
  if (value === false) return { label: "확정 전 값", className: "text-warn" };
  return { label: EMPTY, className: "text-muted" };
}

/** 결정을 내는 책(규칙·Claude) — 벤치마크는 결정을 내지 않습니다. 순서는 서버가 준 책 순서. */
export function decisionBooks(books: readonly PaperBookSummary[]): PaperBookSummary[] {
  return books.filter((book) => book.kind === "RULES" || book.kind === "CLAUDE");
}

/** 결정 로그 탭의 기본 책 — 고른 책이 목록에 있으면 그것, 아니면 규칙 책, 그것도 없으면 첫 책. 결정을 내는 책이 없으면 null. */
export function resolveDecisionBook(picked: string, books: readonly PaperBookSummary[]): string | null {
  const choices = decisionBooks(books);
  if (choices.some((book) => book.code === picked)) return picked;
  return choices.find((book) => book.kind === "RULES")?.code ?? choices[0]?.code ?? null;
}

/** 책마다 결정이 언제·무엇을 하는지 한 문단. */
export function decisionBookNote(kind: string | null | undefined): string {
  if (kind === "CLAUDE") {
    return "Claude 계좌는 거래일마다 한 번(KST 07:30 이후, 확정 종가를 확인한 뒤 — 12:00까지 오지 않으면 있는 값으로 '확정 전 값') 입력 "
      + "패킷을 Claude에 보내 주문 목록과 목표 주식 노출을 받습니다. 검증기(하드 규칙)가 주문마다 통과·거절을 정하고 통과한 주문만 "
      + "대기 주문이 됩니다. 현금 비중은 Claude가 정하고 검사하지 않습니다 — 목표 노출은 기록·표시용이고 집행은 주문 기준입니다. "
      + "응답 형식 오류·모델 거절·API 오류면 그날 재량 주문이 없고(API 오류는 같은 거래일에 한 번 다시 시도), 트레일링 스탑은 계속 돕니다. "
      + "하루 호출 상한(설정 apiDailyCallCap)에 닿으면 그날 결정은 건너뜁니다. '지금 결정 실행'은 시각 조건 없이 Claude를 한 번 "
      + "부릅니다(종류 '수동' — Sonnet 5.5 호출 1회, 약 $0.1, 상한에 셈).";
  }
  return "규칙 계좌는 거래일마다 한 번(KST 07:30 이후, 확정 종가를 확인한 뒤) 결정을 남깁니다. 매수는 재선정일(분기 13F 공시 기한 "
    + "다음 거래일)과 초기 결정 때만 내고(재선정일 결정을 놓쳤거나 그날 선정을 건너뛰었으면 다음 결정 날에 그 재선정일 기준 선정으로 "
    + "한 번 따라잡습니다), 그 밖의 날은 보유 종목의 매도 신호(신호 풀 기관 여러 곳의 전량 매도)와 남는 현금만 봅니다(남는 현금이 "
    + "순자산의 기준(기본 2%, 설정 rules.parkCashThresholdPct)을 넘으면 SHY에 둠 — 신호 매수가 아닌 현금 관리). "
    + "신호는 선정 기준일까지 공시된 13F만 씁니다. 매크로 게이트는 쓰지 않고 참고로 기록만 합니다. "
    + "'지금 결정 실행'은 시각 조건 없이 이 계좌만 한 번 결정하고(종류 '수동' — 매도 신호와 남는 현금만), 확정 종가가 아니면 '확정 전 값'으로 남깁니다.";
}

/**
 * 수동 결정 버튼을 막는 이유 — 시작 전인 책·일시정지 중인 Claude 책이면 문구, 아니면 null. 시작 전 책은 장부가 체결하지 않으므로
 * (현금만) 결정을 내도 주문이 쌓이기만 합니다. 일시정지 중인 Claude 책은 서버가 Claude를 부르지 않고 400을 냅니다(확인 단계의
 * "Claude를 지금 부를까요?"가 틀린 말이 되지 않게 여기서 먼저 막음). 규칙 책은 일시정지 중에도 누를 수 있습니다(주문 없이 '건너뜀'
 * 기록 — 비용 없음). 서버도 다시 판단하고, 그 문구는 버튼 결과로 그대로 보입니다.
 */
export function decisionRunBlocked(book: Pick<PaperBookSummary, "status" | "kind"> | null | undefined): string | null {
  if (!book) return "계좌가 없습니다.";
  if (book.kind === "CLAUDE" && book.status === "PAUSED") {
    return "일시정지 중인 Claude 계좌는 결정을 내지 않습니다(Claude를 부르지 않음) — 보유·체결 탭에서 재개한 뒤 누르세요.";
  }
  if (book.status !== "NOT_STARTED") return null;
  return book.kind === "RULES"
    ? "시작 전인 계좌는 결정을 내지 않습니다 — 개요 탭의 '규칙 계좌 시작'으로 먼저 시작하세요."
    : "시작 전인 계좌는 결정을 내지 않습니다 — 개요 탭의 'Claude 계좌 시작'(초기 결정)으로 먼저 시작하세요.";
}

/** 수동 결정 결과 — 배너 색과 한 줄. ok:false면 서버 문구를, 결정에 오류가 있으면 경고색으로 오류를 붙입니다. */
export function runDecisionResultView(result: PaperRunDecisionResult): { tone: "warn" | "info"; text: string } {
  if (result.ok === false) return { tone: "warn", text: result.message ?? "결정을 내지 못했습니다." };
  const decision = result.decision ?? null;
  if (!decision) return { tone: "warn", text: result.message ?? "결정 기록을 받지 못했습니다." };
  const text = `${decision.asOfTradingDate} ${decisionKindLabel(decision.kind)} 결정 — ${decisionStatusBadge(decision.status).label}`
    + ` · 주문 ${decisionOrdersText(decision)}${decision.summary ? ` · ${decision.summary}` : ""}`;
  return decision.error ? { tone: "warn", text: `${text} — 오류: ${decision.error}` } : { tone: "info", text };
}

/** 결정 상세 머리의 한 칸. */
export interface DecisionMetaCell {
  key: string;
  label: string;
  value: string;
  /** 마우스를 올리면 보이는 설명(예: 프레임 판 제목). */
  title?: string;
}

/**
 * 결정 상세의 프레임 칸 — 그 결정에 쓴 판(response.framework `{version, status, title}`, 없으면 목록의 frameworkVersion). 임시 판이면
 * "임시 v0"처럼 상태를 붙이고(보충 계약 §7) 제목은 마우스를 올려 봅니다. 단계 3a 기록(판 번호를 두기 전의 임시 시스템 프롬프트 —
 * response.framework가 `{version:null, interim:true}`)은 번호가 없어 그렇다고 적습니다 — 빈 칸이면 "프레임 없이"로 읽힙니다. Claude를
 * 부르지 않은 SKIPPED(일시정지·호출 상한)는 판을 쓰지 않았으니 그렇게 적습니다 — "단계 3b 전 기록"으로 적으면 3b 뒤의 기록을 옛 기록으로
 * 읽습니다(F3, docs/API.md도 두 경우를 나눔). 규칙 책은 프레임을 쓰지 않아(명세 F5) 칸이 없습니다.
 */
function decisionFrameworkCell(decision: PaperDecisionDetail): DecisionMetaCell | null {
  const recorded = isRecord(decision.response) ? frameworkInfoOf(decision.response.framework) : null;
  const version = recorded?.version ?? (isNumber(decision.frameworkVersion) ? decision.frameworkVersion : null);
  if (version !== null) {
    return {
      key: "frameworkVersion",
      label: "프레임 버전",
      value: frameworkVersionLabel(version, recorded?.status ?? null),
      title: recorded?.title ?? undefined,
    };
  }
  if (decision.book !== "claude") return null;
  if (recorded?.status === "INTERIM") {
    return { key: "frameworkVersion", label: "프레임 버전", value: "임시 — 판 번호 없음(단계 3b 전 기록)", title: recorded.title ?? undefined };
  }
  if (decision.status === "SKIPPED") {
    return { key: "frameworkVersion", label: "프레임 버전", value: "— (Claude를 부르지 않음)" };
  }
  return { key: "frameworkVersion", label: "프레임 버전", value: "— (판 기록 없음)" };
}

/**
 * 결정 상세 머리 — 결정 시각·선정 기준일·설정 버전·가격, 그리고 있을 때만 붙는 값: 소요(규칙 책도 늘 채움 — 결정 계산 시간)와
 * Claude 책만 채우는 값(모델·프레임·목표 노출·재시도·패킷 해시·메모). 규칙 책 기록에 늘 빈 칸("—") 여섯 개가 늘어서면 무엇이
 * 빠졌는지 오히려 읽기 어렵습니다.
 */
export function decisionMeta(decision: PaperDecisionDetail): DecisionMetaCell[] {
  const cells: DecisionMetaCell[] = [
    { key: "decidedAt", label: "결정 시각", value: formatKst(decision.decidedAtKst) },
    { key: "selectionAsOf", label: "선정 기준일", value: decision.selectionAsOf ?? EMPTY },
    { key: "settingsVersion", label: "설정 버전", value: isNumber(decision.settingsVersion) ? `v${decision.settingsVersion}` : EMPTY },
    { key: "pricesFinal", label: "가격", value: pricesFinalText(decision.pricesFinal).label },
  ];
  if (decision.model) cells.push({ key: "model", label: "모델", value: decision.model });
  const framework = decisionFrameworkCell(decision);
  if (framework) cells.push(framework);
  if (isNumber(decision.targetExposurePct)) {
    cells.push({ key: "targetExposurePct", label: "목표 주식 노출", value: formatWithUnit(decision.targetExposurePct, 1, "%") });
  }
  if (isNumber(decision.latencyMs)) cells.push({ key: "latencyMs", label: "소요", value: formatLatency(decision.latencyMs) });
  if (isNumber(decision.retryCount) && decision.retryCount > 0) {
    cells.push({ key: "retryCount", label: "재시도", value: `${formatNumber(decision.retryCount, 0)}회` });
  }
  if (decision.packetHash) {
    const hash = decision.packetHash;
    cells.push({ key: "packetHash", label: "패킷 해시", value: hash.length > 12 ? `${hash.slice(0, 12)}…` : hash });
  }
  if (Array.isArray(decision.noteIds) && decision.noteIds.length > 0) {
    cells.push({ key: "noteIds", label: "참조 메모", value: decision.noteIds.map((id) => `#${id}`).join(", ") });
  }
  return cells;
}

/**
 * 매수 후보 표 위의 한 줄 — 그 결정이 매수하는 날이었는지. 규칙 책은 재선정일·초기 결정에만 사고(명세 R5) 그 밖의 날은
 * 후보를 기록만 하므로, 후보가 있는데 주문이 없는 정기 결정이 "놓친 매수"로 읽히지 않게 적습니다.
 */
export function candidatesNote(kind: string | null | undefined): string {
  return kind === "REBALANCE" || kind === "INITIAL"
    ? "매수하는 결정입니다 — 후보 상위부터 배분했고, 고르지 못한 후보는 아래에 사유를 남겼습니다."
    : "매수하지 않는 날의 결정입니다(매수는 재선정일·초기 결정에만) — 후보는 참고로 남깁니다.";
}

const SIGNAL_ACTION: Record<string, string> = { NEW: "신규 편입", ADDED: "확대", CLOSED: "전량 매도" };

/** 13F 신호 행동 이름. 모르는 값은 받은 글자 그대로. */
export const signalActionLabel = (action: string | null | undefined) => labelOf(SIGNAL_ACTION, action);

/** 선정 순위표 한 줄(표시 문자열). */
export interface RankingRow {
  cik: string;
  name: string;
  rank: string;
  cagr: string;
  excess: string;
  sharpe: string;
  selected: boolean;
}

/** 신호 이벤트 한 줄(표시 문자열). */
export interface SignalEventRow {
  key: string;
  filer: string;
  ticker: string;
  action: string;
  /** NEW · ADDED · CLOSED — 글자색을 고를 때. */
  actionKey: string;
  sharesChange: string;
  weight: string;
  previousWeight: string;
}

/** 매수 후보 한 줄(표시 문자열). 섞은 뒤 기록은 score, 섞기 전 기록은 rankSum이 채워집니다(없는 쪽은 "—"). */
export interface SignalCandidateRow {
  ticker: string;
  buyers: string;
  buyerCount: string;
  score: string;
  rankSum: string;
  combinedWeight: string;
}

/** 후보 점수에 기관 한 곳이 보탠 몫 한 줄(표시 문자열) — 점수 기여 = 기관 가중 × 확신도. */
export interface ContributionRow {
  key: string;
  ticker: string;
  filer: string;
  group: Badge | null;
  filerWeight: string;
  conviction: string;
  points: string;
}

/** 매도 신호(전량 매도한 신호 기관) 한 줄. */
export interface ClosedSignalRow {
  ticker: string;
  filers: string;
  count: string;
}

/** 고르지 못한 후보 한 줄. */
export interface SkippedRow {
  key: string;
  ticker: string;
  reason: string;
}

/**
 * 결정 기록의 선정 — 섞기 전 기록은 순위표(ranking), 섞은 뒤 기록은 신호 풀(pool)·그룹별 순위표(rankingA·rankingB, 선정 때의 상위 10)·
 * 그룹별 선정 이름.
 */
export interface RuleDecisionSelection {
  asOf: string;
  ranking: RankingRow[];
  rankingA: RankingRow[];
  rankingB: RankingRow[];
  /** 신호를 낸 기관(섞은 뒤면 신호 풀) 이름표. */
  selectedNames: string;
  pool: PoolRow[];
  /** 그룹 A·B 선정 이름표("듀케인 · 1위, …"). 섞기 전 기록이면 null, 그룹이 비었으면 그렇다고. */
  groupANames: string | null;
  groupBNames: string | null;
  /** 기관 가중의 그룹 A 몫(0~1, 선정 때 값). 기록에 없으면 null. */
  groupWeightA: number | null;
}

/** 규칙 책 결정 기록(response)을 화면에 그릴 모양으로. */
export interface RuleDecisionView {
  /** 규칙 책 기록 모양(gate·selection·signals 중 하나라도 있음)인가. 아니면 화면은 원본 JSON만 보입니다. */
  recognized: boolean;
  gate: PaperGateIndicator | null;
  selection: RuleDecisionSelection | null;
  events: SignalEventRow[];
  candidates: SignalCandidateRow[];
  /** 후보가 점수(섞은 뒤 기록)로 정렬됐는가 — 화면은 점수 칸과 기여 표를, 아니면 순위 합 칸을 그립니다. */
  scored: boolean;
  contributions: ContributionRow[];
  /** 배분 방식 한 줄(확신도 비례·동일 비중). 기록에 없으면 null — 그 줄을 그리지 않습니다. */
  allocation: string | null;
  /** 확신도 설명 한 줄(상한을 기록에서 읽으면 숫자로). 점수 기록이 아니면 null. */
  convictionNote: string | null;
  closed: ClosedSignalRow[];
  skipped: SkippedRow[];
  notes: string[];
}

/** 결정 기록 안에서 CIK로 찾는 기관 정보 — 섞기 전 순위표(rank)와 섞은 뒤 그룹·신호 풀(rankA·rankB·groups)을 합친 것. */
interface FilerInfo {
  name: string | null;
  rank: number | null;
  rankA: number | null;
  rankB: number | null;
  groups: string[];
}

/** 이벤트·기여 줄이 스스로 가진 순위(있으면 기록의 순위표보다 먼저). */
interface OwnRanks {
  rank?: number | null;
  rankA?: number | null;
  rankB?: number | null;
}

/**
 * 기관 이름표 — 섞은 뒤 기록은 "듀케인 · A 1위 · B 1위", 섞기 전 기록은 "버크셔 해서웨이 · 1위". 이름을 모르면 줄이 가진 이름,
 * 그것도 없으면 CIK(지어내지 않음), 순위를 모르면 이름만.
 */
function filerLabel(cik: string, own: OwnRanks | null, names: Map<string, FilerInfo>, fallbackName: string | null = null): string {
  const known = names.get(cik);
  const name = known?.name ?? fallbackName ?? `CIK ${cik}`;
  const rankA = own?.rankA ?? known?.rankA ?? null;
  const rankB = own?.rankB ?? known?.rankB ?? null;
  if (rankA !== null || rankB !== null) return `${name} · ${groupRankText(rankA, rankB)}`;
  const rank = own?.rank ?? known?.rank ?? null;
  return rank === null ? name : `${name} · ${formatNumber(rank, 0)}위`;
}

/**
 * 결정 기록의 기관 정보 표 — 섞기 전 순위표(ranking)·그룹 A·그룹 B·신호 풀을 CIK로 합칩니다. 이름은 먼저 본 값을 씁니다
 * (두 그룹에 모두 있는 기관의 이름이 표마다 달라지지 않게). 그룹은 신호 풀이 적은 값, 없으면 그룹 목록에 든 것으로.
 */
function filerInfo(selection: Record<string, unknown> | null): Map<string, FilerInfo> {
  const names = new Map<string, FilerInfo>();
  const merge = (entry: Record<string, unknown>, patch: Partial<FilerInfo>) => {
    const cik = textOf(entry.cik);
    if (!cik) return;
    const current = names.get(cik) ?? { name: null, rank: null, rankA: null, rankB: null, groups: [] };
    names.set(cik, {
      name: current.name ?? textOf(entry.name),
      rank: current.rank ?? patch.rank ?? null,
      rankA: current.rankA ?? patch.rankA ?? null,
      rankB: current.rankB ?? patch.rankB ?? null,
      groups: groupsOf([...current.groups, ...(patch.groups ?? [])]),
    });
  };
  for (const entry of listOf(selection?.ranking).filter(isRecord)) merge(entry, { rank: numberOf(entry.rank) });
  const fromPool = (entry: Record<string, unknown>) =>
    merge(entry, { rankA: numberOf(entry.rankA), rankB: numberOf(entry.rankB), groups: groupsOf(entry.groups) });
  listOf(selection?.pool).filter(isRecord).forEach(fromPool);
  // selection.filers는 신호를 대조한 기관마다의 줄 — 섞기 전 기록은 rank, 섞은 뒤 기록은 그룹·그룹 순위를 씁니다.
  for (const entry of listOf(selection?.filers).filter(isRecord)) {
    merge(entry, { rank: numberOf(entry.rank), rankA: numberOf(entry.rankA), rankB: numberOf(entry.rankB), groups: groupsOf(entry.groups) });
  }
  // 그룹 순위표에서는 선정된 줄만 그룹·순위를 보탭니다 — 그룹 A에서 뽑히고 그룹 B 순위표 6위에만 있는 기관이 "AB"·"B 6위"가 되지 않게.
  for (const entry of selectedEntries(selection?.groupA)) merge(entry, { rankA: numberOf(entry.rank), groups: ["A"] });
  for (const entry of selectedEntries(selection?.groupB)) merge(entry, { rankB: numberOf(entry.rank), groups: ["B"] });
  return names;
}

/**
 * 그룹 목록에서 선정된 줄만. 결정 기록의 groupA·groupB는 선정 때의 순위표(상위 10, 줄마다 selected)이고 개요·계약 초안의 모양은
 * 선정된 기관만이라, selected 표시가 하나라도 있으면 참인 줄만, 없으면 모두를 선정으로 봅니다.
 */
function selectedEntries(value: unknown): Record<string, unknown>[] {
  const entries = listOf(value).filter(isRecord);
  return entries.some((entry) => typeof entry.selected === "boolean") ? entries.filter((entry) => entry.selected === true) : entries;
}

/** 줄이 스스로 가진 순위 — 섞기 전 rank, 섞은 뒤 rankA·rankB. 숫자가 아니면 없는 것으로. */
const ownRanks = (entry: Record<string, unknown>): OwnRanks => ({
  rank: numberOf(entry.rank),
  rankA: numberOf(entry.rankA),
  rankB: numberOf(entry.rankB),
});

/**
 * 고르지 못한 후보와 사유. 서버가 `{ticker, reason}`으로 보내든, 자바 Map.Entry를 그대로 직렬화한 `{"티커": "사유"}`나
 * `{key, value}`로 보내든 같은 줄로 읽습니다 — 계약에 직렬화 모양이 정해져 있지 않아, 모양이 달라 표가 비면 사유가 사라집니다.
 */
function skippedRows(value: unknown): SkippedRow[] {
  const rows: Omit<SkippedRow, "key">[] = [];
  for (const entry of listOf(value)) {
    if (typeof entry === "string") {
      rows.push({ ticker: EMPTY, reason: entry });
    } else if (isRecord(entry)) {
      if (typeof entry.ticker === "string") {
        rows.push({ ticker: entry.ticker, reason: textOf(entry.reason) ?? EMPTY });
      } else if (typeof entry.key === "string" && "value" in entry) {
        rows.push({ ticker: entry.key, reason: textOf(entry.value) ?? EMPTY });
      } else {
        for (const [ticker, reason] of Object.entries(entry)) rows.push({ ticker, reason: textOf(reason) ?? EMPTY });
      }
    }
  }
  return rows.map((row, index) => ({ ...row, key: `${index}-${row.ticker}` }));
}

/** 그 결정에 쓴 설정값 하나 — `settings.키`, 점 이름(`settings["blend.키"]`), 묶음(`settings.blend.키`) 어느 모양이든. */
function settingOf(settings: Record<string, unknown> | null, key: string): unknown {
  if (!settings) return undefined;
  if (key in settings) return settings[key];
  if (`blend.${key}` in settings) return settings[`blend.${key}`];
  return isRecord(settings.blend) ? settings.blend[key] : undefined;
}

/**
 * 배분 방식 한 줄(설계 §4-2, 설정 blend.allocation). 그 결정에 쓴 설정값(settings)에서 읽고, 없으면 기록 맨 위·신호 묶음의 allocation을
 * 봅니다(문자열이든 `{mode}`든). 기록에 없으면 null — 섞기 전 기록은 늘 동일 비중이었지만, 없는 값을 화면이 채우지 않습니다.
 * 하한(blend.minTargetPct)을 기록에서 읽으면 숫자로 적습니다.
 */
function allocationText(record: Record<string, unknown>, settings: Record<string, unknown> | null): string | null {
  const signals = isRecord(record.signals) ? record.signals : null;
  const raw = settingOf(settings, "allocation") ?? record.allocation ?? signals?.allocation;
  const mode = textOf(isRecord(raw) ? raw.mode : raw);
  if (!mode) return null;
  const min = numberOf(settingOf(settings, "minTargetPct"));
  const floor = min === null ? "하한" : `${formatNumber(min, 1)}%`;
  if (mode === "CONVICTION") {
    return `배분: 확신도 비례(CONVICTION) — 목표 비중 = 종목 상한 × 점수 ÷ 최고 점수(가장 강한 후보가 상한), 목표가 ${floor} `
      + "미만이면 '확신도 낮음'으로 뺍니다.";
  }
  if (mode === "EQUAL") return "배분: 동일 비중(EQUAL) — 목표 비중 = min(100% ÷ 최대 종목 수, 종목 상한).";
  return `배분: ${mode}`;
}

/** 그룹 선정 이름표 — "듀케인 · 1위, 아팔루사 · 2위"(선정된 줄만). 그룹 목록이 없으면(섞기 전 기록) null, 비었으면 그렇다고. */
function groupNames(value: unknown, names: Map<string, FilerInfo>): string | null {
  if (!Array.isArray(value)) return null;
  const rows = selectedEntries(value).flatMap((entry) => {
    const cik = textOf(entry.cik);
    if (!cik) return [];
    const name = names.get(cik)?.name ?? textOf(entry.name) ?? `CIK ${cik}`;
    const rank = numberOf(entry.rank);
    return [rank === null ? name : `${name} · ${formatNumber(rank, 0)}위`];
  });
  return rows.length > 0 ? rows.join(", ") : "자격 있는 기관 없음";
}

/**
 * 규칙 책 결정 기록(paper_decisions.response, JSON)을 표(선정·신호 이벤트·매수 후보·점수 기여·매도 신호)와 건너뛴 후보·메모로.
 *
 * 숫자는 서버가 계산한 값을 표기만 합니다(비중·변화율·점수·기관 가중·확신도·순위 합). 기관 이름·그룹·순위는 같은 기록의
 * 선정(섞은 뒤면 그룹 A·B와 신호 풀, 섞기 전이면 순위표)에서 CIK로 찾아 붙이고, 없는 CIK는 CIK 그대로 둡니다(지어내지 않음).
 * 결정 기록은 바뀌지 않는 이력이라 그룹 섞기(D27) 전·후 모양을 다 읽습니다. JSON이라 모양을 믿지 않고 하나씩 확인해 읽습니다 —
 * 모양이 다른 칸은 "—".
 */
export function ruleDecisionView(response: unknown): RuleDecisionView {
  const record = isRecord(response) ? response : {};
  const selection = isRecord(record.selection) ? record.selection : null;
  const signals = isRecord(record.signals) ? record.signals : null;
  const settings = isRecord(record.settings) ? record.settings : null;
  const names = filerInfo(selection);

  const poolRows = signalPoolRows(selection?.pool);
  const ciks = listOf(selection?.ciks).filter((cik): cik is string => typeof cik === "string");
  // 신호를 낸 기관 — 서버의 ciks(섞은 뒤면 신호 풀과 같음), 없으면 신호 풀 순서.
  const selectedCiks = ciks.length > 0 ? ciks : poolRows.map((row) => row.cik);
  // 순위표 줄 — 섞기 전 순위표는 신호 기관 목록(ciks)으로도 선정을 표시하고, 그룹 순위표는 줄의 selected만 봅니다
  // (두 그룹에 모두 든 기관이 그룹 B 순위표에서 선정되지 않았는데 신호 풀에 있다고 "선정"이 붙지 않게).
  const rankingRows = (value: unknown, byCiks: boolean): RankingRow[] => listOf(value).filter(isRecord).flatMap((entry) => {
    const cik = textOf(entry.cik);
    if (!cik) return [];
    const rank = numberOf(entry.rank);
    return [{
      cik,
      name: textOf(entry.name) ?? `CIK ${cik}`,
      rank: rank === null ? EMPTY : formatNumber(rank, 0),
      cagr: formatPercent(numberOf(entry.cagrPct)),
      excess: formatExcessPoints(numberOf(entry.excessVsSpyPct)),
      sharpe: formatNumber(numberOf(entry.sharpe), 2),
      selected: entry.selected === true || (byCiks && selectedCiks.includes(cik)),
    }];
  });
  const ranking = rankingRows(selection?.ranking, true);

  const events: SignalEventRow[] = listOf(signals?.events).filter(isRecord).flatMap((event, index) => {
    const cik = textOf(event.cik);
    const ticker = textOf(event.ticker);
    if (!cik || !ticker) return [];
    const action = textOf(event.action);
    return [{
      key: `${index}-${cik}-${ticker}`,
      filer: filerLabel(cik, ownRanks(event), names, textOf(event.name)),
      ticker,
      action: signalActionLabel(action),
      actionKey: action ?? "",
      sharesChange: formatPercent(numberOf(event.sharesChangePct)),
      weight: formatWithUnit(numberOf(event.weightPct), 2, "%"),
      previousWeight: formatWithUnit(numberOf(event.previousWeightPct), 2, "%"),
    }];
  });

  const candidateEntries = listOf(signals?.candidates).filter(isRecord).filter((candidate) => textOf(candidate.ticker) !== null);
  const candidates: SignalCandidateRow[] = candidateEntries.map((candidate) => {
    const buyers = listOf(candidate.buyerCiks).filter((cik): cik is string => typeof cik === "string");
    return {
      ticker: textOf(candidate.ticker) ?? EMPTY,
      buyers: buyers.length > 0 ? buyers.map((cik) => filerLabel(cik, null, names)).join(", ") : EMPTY,
      buyerCount: `${formatNumber(buyers.length, 0)}곳`,
      score: formatScore(numberOf(candidate.score)),
      rankSum: formatNumber(numberOf(candidate.rankSum), 0),
      combinedWeight: formatWithUnit(numberOf(candidate.combinedWeightPct), 2, "%"),
    };
  });
  const scored = candidateEntries.some((candidate) => isNumber(candidate.score) || Array.isArray(candidate.contributions));

  // 기여 줄은 후보 순서(서버 정렬) 그대로, 후보 안에서는 서버가 보낸 순서 그대로입니다.
  const contributions: ContributionRow[] = candidateEntries.flatMap((candidate, candidateIndex) => {
    const ticker = textOf(candidate.ticker) ?? EMPTY;
    return listOf(candidate.contributions).filter(isRecord).flatMap((entry, index) => {
      const cik = textOf(entry.cik);
      if (!cik) return [];
      const groups = groupsOf(entry.groups);
      return [{
        key: `${candidateIndex}-${index}-${ticker}-${cik}`,
        ticker,
        filer: filerLabel(cik, ownRanks(entry), names, textOf(entry.name)),
        group: groupBadge(groups.length > 0 ? groups : names.get(cik)?.groups),
        filerWeight: formatRatioPercent(numberOf(entry.filerWeight)),
        conviction: formatRatioPercent(numberOf(entry.conviction)),
        points: formatScore(numberOf(entry.points)),
      }];
    });
  });

  const closedBy = isRecord(signals?.closedBy) ? signals.closedBy : {};
  const closed: ClosedSignalRow[] = Object.entries(closedBy).map(([ticker, value]) => {
    const filers = listOf(value).filter((cik): cik is string => typeof cik === "string");
    return {
      ticker,
      filers: filers.length > 0 ? filers.map((cik) => filerLabel(cik, null, names)).join(", ") : EMPTY,
      count: `${formatNumber(filers.length, 0)}곳`,
    };
  });

  const cap = numberOf(settingOf(settings, "convictionCapPct"));
  const capText = cap === null ? "상한" : `${formatNumber(cap, cap % 1 === 0 ? 0 : 1)}%`;
  const selectionAsOf = textOf(selection?.asOf) ?? textOf(selection?.asOfDate);
  return {
    recognized: isRecord(record.gate) || selection !== null || signals !== null,
    gate: isRecord(record.gate) ? (record.gate as unknown as PaperGateIndicator) : null,
    selection: selection
      ? {
        asOf: selectionAsOf ?? EMPTY,
        ranking,
        selectedNames: selectedCiks.length > 0
          ? selectedCiks.map((cik) => filerLabel(cik, null, names)).join(", ")
          : "선정 없음 — 자격 있는 기관이 없었습니다",
        rankingA: rankingRows(selection.groupA, false),
        rankingB: rankingRows(selection.groupB, false),
        pool: poolRows,
        groupANames: groupNames(selection.groupA, names),
        // 섞기 전 선정(legacy)으로 낸 결정은 그룹 B가 아예 없었습니다 — "자격 있는 기관 없음"과 다릅니다.
        groupBNames: selection.legacy === true ? "없음 — 두 그룹을 섞기 전의 선정입니다" : groupNames(selection.groupB, names),
        groupWeightA: numberOf(selection.groupWeightA),
      }
      : null,
    events,
    candidates,
    scored,
    contributions,
    allocation: allocationText(record, settings),
    convictionNote: scored
      ? `점수 = Σ 매수 기관의 기관 가중 × 확신도. 확신도 = min(그 종목의 기관 내 비중, ${capText}) ÷ ${capText} — `
        + "그 기관 13F에서 크게 든 종목일수록 1에 가깝습니다."
      : null,
    closed,
    skipped: skippedRows(record.skipped),
    notes: listOf(record.notes).filter((note): note is string => typeof note === "string" && note.length > 0),
  };
}

/** JSON 원본을 들여 써서(펼쳐 보기용). 없으면 null — 그 칸을 그리지 않습니다. */
export function prettyJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- OS 게이트 지표(참고)

const GATE_LEVEL: Record<string, { label: string; tone: BadgeTone }> = {
  L0: { label: "L0 · 동결", tone: "muted" },
  L1: { label: "L1 · 1단계 해제", tone: "info" },
  L2: { label: "L2 · 전면 해제", tone: "ok" },
  UNKNOWN: { label: "판정 없음 · 입력 빠짐", tone: "warn" },
};

/** 게이트 단계 배지. 모르는 단계는 받은 글자 그대로. */
export function gateLevelBadge(level: string | null | undefined): Badge {
  const known = level ? GATE_LEVEL[level] : undefined;
  return { key: level ?? "unknown", label: known?.label ?? level ?? EMPTY, className: TONE[known?.tone ?? "muted"] };
}

const GATE_INPUTS = [
  { key: "us10y", label: "미국 10년물 금리", unit: "%" },
  { key: "brent", label: "브렌트유", unit: " 달러" },
  { key: "wti", label: "WTI", unit: " 달러" },
  { key: "usdjpy", label: "USD/JPY", unit: " 엔" },
] as const;

const GATE_CONDITIONS = ["G1", "G2", "G3", "G4", "G5"] as const;

/** 임계치 표기 — 정수면 소수 없이(95 달러), 아니면 2자리(4.80%). 10년물은 늘 2자리(OS 원문 표기 4.80·4.75). */
function threshold(value: number | null | undefined, unit: string, alwaysTwo = false): string | null {
  if (!isNumber(value)) return null;
  return `${formatNumber(value, alwaysTwo || !Number.isInteger(value) ? 2 : 0)}${unit}`;
}

/** 조건 이름. 임계치를 받으면 숫자를, 아니면 기준 이름만 적습니다(화면이 설정값을 따로 들고 있지 않게). */
function gateConditionLabel(key: string, t: PaperGateThresholds | null | undefined): string {
  switch (key) {
    case "G1": return `10년물 < ${threshold(t?.us10yStage1, "%", true) ?? "1단계 기준"}`;
    case "G2": return `10년물 ≤ ${threshold(t?.us10yFull, "%", true) ?? "전면 기준"}`;
    case "G3": return `브렌트 ≤ ${threshold(t?.brentMax, " 달러") ?? "상한"}`;
    case "G4": return `WTI ≤ ${threshold(t?.wtiMax, " 달러") ?? "상한"}`;
    case "G5": return `USD/JPY ≥ ${threshold(t?.usdjpyMin, " 엔") ?? "기준"}`;
    default: return key;
  }
}

/** 게이트 조건 한 줄. */
export interface GateConditionRow {
  key: string;
  label: string;
  state: string;
  stateClass: string;
  streak: string;
  /** 단계에 쓰지 않는 참고 조건(G5)인가. */
  reference: boolean;
}

/** 게이트 입력 한 줄. */
export interface GateInputRow {
  key: string;
  label: string;
  value: string;
  lastTs: string;
  stale: boolean;
}

/** 게이트 지표 카드의 표시. */
export interface GateView {
  tradingDate: string;
  level: Badge;
  levelNote: string;
  conditions: GateConditionRow[];
  inputs: GateInputRow[];
  note: string;
}

/**
 * 게이트 지표(참고)를 카드 모양으로. 기록이 없으면 null.
 *
 * 단계와 조건 참·거짓·연속 일수는 서버(GateIndicator)가 낸 값 그대로입니다 — 화면은 다시 판정하지 않습니다.
 * 입력이 없는 조건은 "—"(거짓으로 보지 않음), 입력이 하나라도 없으면 단계는 "판정 없음"(L0로 보지 않음).
 */
export function gateView(gate: PaperGateIndicator | null | undefined): GateView | null {
  if (!gate) return null;
  const t = gate.thresholds ?? null;
  const days = isNumber(t?.confirmDays) ? `확인 일수(${formatNumber(t.confirmDays, 0)}거래일)` : "확인 일수";
  const missingLabels = listOf(gate.missing)
    .filter((key): key is string => typeof key === "string")
    .map((key) => GATE_INPUTS.find((input) => input.key === key)?.label ?? key);
  const levelNote: Record<string, string> = {
    L0: `해제 조건이 ${days}만큼 이어지지 않았습니다 — 동결 단계.`,
    L1: `10년물 1단계 조건(G1)이 ${days} 이상 이어졌습니다.`,
    L2: `10년물·브렌트·WTI 세 조건(G2·G3·G4)이 모두 ${days} 이상 이어졌습니다.`,
    UNKNOWN: `입력이 빠져 단계를 판정하지 않았습니다(L0로 보지 않음)${missingLabels.length > 0 ? ` — 없는 입력: ${missingLabels.join(", ")}` : ""}.`,
  };

  // 결정 기록의 게이트는 JSON 그대로라 모양을 믿지 않습니다 — 객체가 아니면 빈 것으로(조건·연속은 "—").
  const conditions: Record<string, unknown> = isRecord(gate.conditions) ? gate.conditions : {};
  const streaks: Record<string, unknown> = isRecord(gate.streaks) ? gate.streaks : {};
  const keys = [...GATE_CONDITIONS, ...Object.keys(conditions).filter((key) => !(GATE_CONDITIONS as readonly string[]).includes(key))];
  const conditionRows: GateConditionRow[] = keys.map((key) => {
    const holds = conditions[key];
    const streak = streaks[key];
    const reference = key === "G5";
    return {
      key,
      label: `${key} ${gateConditionLabel(key, t)}${reference ? " (참고 — 단계에 쓰지 않음)" : ""}`,
      state: holds === true ? "충족" : holds === false ? "미충족" : EMPTY,
      stateClass: holds === true ? "text-ok" : "text-muted",
      streak: isNumber(streak) ? `${formatNumber(streak, 0)}거래일 연속` : EMPTY,
      reference,
    };
  });

  const inputs: Record<string, unknown> = isRecord(gate.inputs) ? gate.inputs : {};
  const inputRows: GateInputRow[] = GATE_INPUTS.map(({ key, label, unit }) => {
    const raw = inputs[key];
    const input = isRecord(raw) ? raw : null;
    const value = isNumber(raw) ? raw : numberOf(input?.value);
    return {
      key,
      label,
      value: formatWithUnit(value, 2, unit),
      lastTs: formatKst(textOf(input?.lastTs)),
      stale: input?.isStale === true,
    };
  });

  return {
    tradingDate: textOf(gate.tradingDate) ?? EMPTY,
    level: gateLevelBadge(gate.level),
    levelNote: (typeof gate.level === "string" && Object.hasOwn(levelNote, gate.level)) ? levelNote[gate.level] : "",
    conditions: conditionRows,
    inputs: inputRows,
    // 화면이 뒤에 문장을 잇기 때문에 서버 문구 끝의 마침표는 뗍니다("…않음.." 방지).
    note: (textOf(gate.note) ?? "과거 OS가 쓴 트리거 수준 — 구속하지 않음").replace(/[.。]\s*$/, ""),
  };
}

// ---------------------------------------------------------------- 개요의 선정 기관

/** 개요의 선정 기관 한 줄. */
export interface SelectedFilerRow {
  key: string;
  rank: string;
  name: string;
  cik: string;
}

/** 개요의 선정 카드 — 기준일, 두 그룹(그룹 안 순위 순), 신호 풀(풀 순서). */
export interface SelectedFilersView {
  asOfDate: string;
  groupA: SelectedFilerRow[];
  groupB: SelectedFilerRow[];
  pool: PoolRow[];
}

const filerRows = (filers: readonly PaperSelectedFiler[]): SelectedFilerRow[] =>
  filers.map((filer, index) => ({
    key: `${index}-${filer.cik}`,
    rank: isNumber(filer.rank) ? `${formatNumber(filer.rank, 0)}위` : EMPTY,
    name: filer.name ?? `CIK ${filer.cik}`,
    cik: filer.cik,
  }));

/**
 * 가장 최근 선정 — 기준일, 그룹 A·B 줄(서버 순서 그대로), 신호 풀 줄. 선정이 없으면 null.
 *
 * 개요의 풀 줄에는 순위가 없어(`{cik, name, groups, weight}`) 같은 응답의 그룹 A·B 목록에서 CIK로 순위를 찾아 붙입니다 —
 * 순위를 매기지 않고 찾기만 합니다. 그룹 섞기(D27) 전 모양(`selected`만)이 오면 그것을 그룹 A로 읽고 풀은 비웁니다.
 */
export function selectedFilersView(selection: PaperOverviewSelection | null | undefined): SelectedFilersView | null {
  if (!selection) return null;
  const groupA = selection.groupA ?? selection.selected ?? [];
  const groupB = selection.groupB ?? [];
  const rankIn = (filers: readonly PaperSelectedFiler[], cik: string) => filers.find((filer) => filer.cik === cik)?.rank ?? null;
  return {
    asOfDate: selection.asOfDate ?? EMPTY,
    groupA: filerRows(groupA),
    groupB: filerRows(groupB),
    pool: signalPoolRows((selection.pool ?? []).map((entry) => ({
      ...entry,
      rankA: rankIn(groupA, entry.cik),
      rankB: rankIn(groupB, entry.cik),
    }))),
  };
}

// ---------------------------------------------------------------- Claude 재량 책(단계 3a)

/**
 * Claude를 한 번 부를 때의 비용 안내 — 기본 모델(Sonnet 5.5) 한 번의 추정(설계 §5-9: 입력 약 25K·출력 약 4K 토큰 ≈ $0.09).
 * 설정에서 모델을 바꿨으면 그 모델로 부르므로 "기본 모델 기준"이라고 적고, 하루 호출 상한(명세 C8·D18)에 세는 것도 함께 적습니다.
 * 화면이 지금 설정의 모델을 따로 읽어 비용을 다시 계산하지 않습니다(숫자는 설계 표의 추정 그대로).
 */
export const CLAUDE_COST_NOTE = "Sonnet 5.5 호출 1회, 약 $0.1 — 기본 모델 기준 추정입니다(설정 탭에서 모델을 바꿨으면 그 모델로 "
  + "부릅니다). 하루 호출 상한(설정 apiDailyCallCap)에 셉니다.";

const STANCE: Record<string, { label: string; tone: BadgeTone }> = {
  RISK_ON: { label: "위험 선호", tone: "ok" },
  RISK_OFF: { label: "위험 회피", tone: "warn" },
  NEUTRAL: { label: "중립", tone: "muted" },
  UNCERTAIN: { label: "불확실", tone: "muted" },
};

/** 판단 자세 배지 — "위험 선호 (RISK_ON)". 자세가 없으면 null, 모르는 값은 받은 글자 그대로. */
export function stanceBadge(stance: unknown): Badge | null {
  const code = textOf(stance);
  if (!code) return null;
  const known = STANCE[code];
  return { key: `stance-${code}`, label: known ? `${known.label} (${code})` : code, className: TONE[known?.tone ?? "muted"] };
}

/**
 * 주장 라벨(사실 · 해석 · 가설 · 확인 필요 · 결정)의 색. 사실은 확인된 것, 가설·확인 필요는 아직 아닌 것이라 색을 달리합니다 —
 * 근거 문장만 읽으면 가설이 사실처럼 읽힙니다.
 */
const CLAIM_LABEL: Record<string, BadgeTone> = { 사실: "ok", 해석: "info", 가설: "muted", "확인 필요": "warn", 결정: "info" };

/** 주문 근거의 라벨 배지(받은 순서대로, 중복 없이). 모르는 라벨은 흐린 색으로 그대로. */
export function claimLabelBadges(labels: unknown): Badge[] {
  const seen: string[] = [];
  for (const entry of listOf(labels)) {
    const label = textOf(entry);
    if (label && !seen.includes(label)) seen.push(label);
  }
  return seen.map((label) => ({ key: `label-${label}`, label, className: TONE[CLAIM_LABEL[label] ?? "muted"] }));
}

/**
 * 검증기 거절 사유(설계 §5-4) — 이름과 설명. 설명에는 숫자 대신 설정 키 이름을 적습니다(상한 값은 설정이 정하고, 그 결정에 쓴 값은
 * 검증 결과의 detail에 서버가 적어 보냅니다). 현금 비중·매크로 조건은 사유가 아닙니다(명세 D7).
 */
const REJECT_REASON: Record<string, { label: string; title: string }> = {
  OUT_OF_UNIVERSE: { label: "유니버스 밖", title: "모의 매매 유니버스(13F 매핑 종목 + 설정 universeExtraTickers의 ETF)에 없는 종목입니다." },
  DUPLICATE_TICKER: { label: "같은 종목 중복", title: "한 응답에 같은 종목의 주문이 둘 이상입니다." },
  MALFORMED: { label: "크기 형식 오류", title: "매수에 목표 비중이 없거나 범위 밖, 또는 매도 비율이 0~1 밖입니다." },
  NOT_HELD: { label: "보유 없음", title: "들고 있지 않은 종목을 팔려 했습니다." },
  // 장부는 floor(보유 주식 수 × 매도 비율)이 1주 미만이면 전량을 팝니다(설계 §3-1) — 통과시키면 소량 트림이 전량 청산으로 집행됩니다.
  BELOW_ONE_SHARE: {
    label: "1주 미만 부분 매도",
    title: "보유 주식 수 × 매도 비율이 1주 미만인 일부 매도입니다. 장부는 이런 매도를 전량 매도로 집행하므로 거절했습니다 — "
      + "전량을 팔려면 매도 비율을 비우거나 1로 냅니다.",
  },
  LOCKED_OUT: { label: "재진입 금지 중", title: "트레일링 스탑으로 판 뒤 재진입 금지 기간(설정 lockoutTradingDays)입니다." },
  WEIGHT_CAP: {
    label: "비중 상한 초과",
    title: "목표 비중이 종목 상한(설정 maxWeightStockPct)이나 ETF 상한(maxWeightEtfPct)을 넘습니다. 현금성 ETF는 상한이 없습니다.",
  },
  MAX_POSITIONS: { label: "최대 종목 수 초과", title: "사고 나면 보유 종목 수가 설정 maxPositions를 넘습니다." },
  OVER_ALLOCATED: {
    label: "배분 합 100% 초과",
    title: "매수 목표 합과 매도 뒤 남는 보유 비중의 합이 100%를 넘어, 목표 비중이 큰 주문부터 받고 넘친 주문을 거절했습니다.",
  },
  MIN_NOTIONAL: { label: "최소 금액 미만", title: "매수로 늘어나는 금액이 설정 minOrderNotional보다 작습니다." },
  MONTHLY_CAP: { label: "월 주문 상한", title: "이달 재량 주문 누계가 설정 maxDiscretionaryOrdersPerMonth에 닿았습니다." },
  MIN_HOLD: { label: "최소 보유일 전", title: "보유한 지 설정 minHoldTradingDaysForSell 거래일이 안 된 재량 매도입니다(트레일링 스탑은 예외)." },
  STALE_INPUT: { label: "입력 자료 오래됨", title: "가격 저장본이 오래돼 그날 주문을 모두 거절했습니다." },
  NO_PRICE: { label: "가격 없음", title: "그 종목의 가격이 없거나 지난 값이라 금액을 정할 수 없습니다." },
};

/** 거절 사유 칸 — "비중 상한 초과 (WEIGHT_CAP)"와 설명. 사유가 없으면 "—", 모르는 코드는 받은 글자 그대로. */
export function rejectReasonText(code: string | null | undefined): { label: string; title?: string } {
  if (!code) return { label: EMPTY };
  const known = REJECT_REASON[code];
  return known ? { label: `${known.label} (${code})`, title: known.title } : { label: code };
}

/**
 * 제안 주문의 크기 — 매수는 "목표 비중 10.00%", 매도는 "보유의 50%"(비율이 없으면 전량). 매수에 목표 비중이 없으면 "—"
 * (검증기가 MALFORMED로 거절). 장부 주문 표의 크기(orderSizeText — 체결 시점 순자산 대비 살 금액)와 뜻이 달라 함수를 나눕니다.
 */
export function proposedSizeText(side: unknown, targetWeightPct: unknown, sellFraction: unknown): string {
  if (side === "BUY") {
    const target = numberOf(targetWeightPct);
    return target === null ? EMPTY : `목표 비중 ${formatNumber(target, 2)}%`;
  }
  if (side === "SELL") {
    const fraction = numberOf(sellFraction);
    return fraction === null ? "전량" : `보유의 ${formatNumber(fraction * 100, 0)}%`;
  }
  return EMPTY;
}

/** 모델이 제안한 주문 한 줄(표시 문자열). */
export interface ClaudeOrderRow {
  key: string;
  ticker: string;
  side: string;
  /** BUY · SELL — 글자색을 고를 때. */
  sideKey: string;
  size: string;
  timing: string;
  thesis: string;
  labels: Badge[];
  invalidation: string;
}

/** 검증 결과 한 줄(표시 문자열). */
export interface ValidationRow {
  key: string;
  ticker: string;
  side: string;
  sideKey: string;
  size: string;
  result: Badge;
  reason: string;
  reasonTitle?: string;
  detail: string;
}

/** 관찰 목록 한 줄. */
export interface WatchRow {
  key: string;
  ticker: string;
  condition: string;
}

/** Claude 책 결정(또는 미리보기)을 화면에 그릴 모양. */
export interface ClaudeDecisionView {
  /** Claude 책 기록인가(책이 claude이거나 응답이 Claude 모양). 아니면 화면은 이 부분을 그리지 않습니다. */
  recognized: boolean;
  /** 검사한 모델 응답이 있는가 — 형식 오류·거절·API 오류, Claude를 부르지 않은 기록(SKIPPED)이면 없습니다(그날 재량 주문 없음). */
  hasResponse: boolean;
  /**
   * 응답이 없을 때 판단 칸에 적을 한 줄(상태에 맞춰). 응답이 있으면 null. 건너뛴 기록(호출 상한·일시정지)에 "형식 오류·거절·API
   * 오류"를 적으면 실제 사유가 원본 JSON에만 남습니다.
   */
  noResponse: string | null;
  /**
   * Claude를 부르지 않았거나 집행하지 않은 사유 — 서버 문구 그대로(response.skipped, 응답이 없으면 response.summary도). 없으면 null.
   */
  skipped: string | null;
  stance: Badge | null;
  targetExposure: string;
  confidence: string;
  /** 목표 노출과 주문이 어긋남(15%p 넘게) 배지. 어긋나지 않았거나 모르면 null. */
  mismatch: Badge | null;
  summary: string | null;
  exposureRationale: string | null;
  noTradeReason: string | null;
  orders: ClaudeOrderRow[];
  validation: ValidationRow[];
  watchlist: WatchRow[];
  /** 모델·토큰 사용량 칸(있는 값만). */
  usage: DecisionMetaCell[];
}

/** Claude 결정 화면의 입력 — 결정 기록 상세(PaperDecisionDetail) 또는 미리보기 응답(PaperClaudePreviewResult)에서 고른 값. */
export interface ClaudeDecisionSource {
  book?: string | null;
  /** 결정 상태(OK·NO_TRADE·REFUSED·FORMAT_ERROR·API_ERROR·SKIPPED) — 응답이 없을 때 무엇을 적을지 고릅니다. 모르면 없음. */
  status?: string | null;
  response: unknown;
  /** 검증 결과를 응답 밖에 따로 보내면(미리보기) 그것, 아니면 response.validation. */
  validation?: unknown;
  usage?: unknown;
  model?: string | null;
  /** 결정 표의 목표 노출(target_exposure_pct). 없으면 response.targetEquityExposurePct. */
  targetExposurePct?: number | null;
  exposureMismatch?: boolean | null;
}

/** 사용량 JSON에서 토큰 수 하나 — 서버 이름(camelCase)과 Anthropic 원래 이름(snake_case) 어느 쪽이든. 모르면 null. */
function tokensOf(usage: Record<string, unknown> | null, ...names: string[]): number | null {
  if (!usage) return null;
  for (const name of names) {
    const value = numberOf(usage[name]);
    if (value !== null) return value;
  }
  return null;
}

/** 모델이 답하지 못한 상태 — 그날 재량 주문이 없고 사유는 상태와 오류에 있습니다. */
const CLAUDE_FAILED_STATUSES = ["REFUSED", "FORMAT_ERROR", "API_ERROR"];

/**
 * 응답이 없을 때의 한 줄. 건너뛴 기록(SKIPPED — 호출 상한·일시정지)은 Claude를 부르지 않았으니 서버가 남긴 사유를, 형식 오류·거절·API
 * 오류는 상태와 오류를 보라고 적습니다. 상태를 모르면(옛 기록·미리보기 성공 모양) 어느 쪽이라고 단정하지 않습니다.
 */
function claudeNoResponseText(status: string | null, skipped: string | null, skippedKey: boolean): string {
  // 상태를 모를 때는 건너뛴 기록만 남기는 키(response.skipped)로만 알아봅니다 — summary는 모델 응답에도 있는 키입니다.
  if (status === "SKIPPED" || (status === null && skippedKey)) {
    return skipped ? `Claude를 부르지 않음 — ${skipped}` : "Claude를 부르지 않음 — 서버가 사유를 남기지 않았습니다.";
  }
  if (status !== null && CLAUDE_FAILED_STATUSES.includes(status)) {
    return "검사한 모델 응답이 없습니다 — 응답 형식 오류·모델 거절·API 오류면 그날 재량 주문이 없습니다(상태와 오류를 보세요).";
  }
  return "검사한 모델 응답이 없습니다(상태와 오류를 보세요).";
}

/**
 * Claude 책 결정 기록(또는 미리보기)을 판단·제안 주문·검증 결과·관찰 목록·사용량으로.
 *
 * 숫자는 응답·서버 값 그대로입니다(목표 노출·목표 비중·매도 비율·확신도·토큰). 통과·거절과 사유는 검증기(서버)가 정한 값이고 화면은
 * 다시 판정하지 않습니다. 목표 노출이 주문과 어긋났는지(exposureMismatch)도 서버가 정합니다 — 화면은 노출과 주문을 맞춰 보지 않습니다.
 * JSON이라 모양을 믿지 않고 하나씩 확인해 읽습니다(모양이 다른 칸은 "—").
 */
export function claudeDecisionView(source: ClaudeDecisionSource): ClaudeDecisionView {
  const record = isRecord(source.response) ? source.response : null;
  const verdicts = Array.isArray(source.validation) ? source.validation : listOf(record?.validation);
  const usage = isRecord(source.usage) ? source.usage : null;
  const recognized = source.book === "claude"
    || Array.isArray(source.validation)
    || Array.isArray(record?.validation)
    || isNumber(record?.targetEquityExposurePct);
  const hasResponse = record !== null && (textOf(record.stance) !== null || Array.isArray(record.orders));
  // 건너뛴 기록(recordSkipped)은 사유를 skipped와 summary 둘 다에 둡니다. 모델 응답이 있으면 summary는 모델의 요약이라 사유로 읽지 않습니다.
  const skippedKey = textOf(record?.skipped);
  const skipped = skippedKey ?? (hasResponse ? null : textOf(record?.summary));
  const status = textOf(source.status);

  const orders: ClaudeOrderRow[] = listOf(record?.orders).filter(isRecord).flatMap((order, index) => {
    const ticker = textOf(order.ticker);
    if (!ticker) return [];
    const side = textOf(order.side) ?? "";
    return [{
      key: `${index}-${ticker}`,
      ticker,
      side: sideLabel(side || null),
      sideKey: side,
      size: proposedSizeText(side, order.targetWeightPct, order.sellFraction),
      timing: timingLabel(textOf(order.timing)),
      thesis: textOf(order.thesis) ?? EMPTY,
      labels: claimLabelBadges(order.labels),
      invalidation: textOf(order.invalidation) ?? EMPTY,
    }];
  });

  const validation: ValidationRow[] = verdicts.filter(isRecord).flatMap((verdict, index) => {
    // 자바 record 그대로면 주문이 order 안에, 펼쳐 보내면 같은 줄에 있습니다.
    const order = isRecord(verdict.order) ? verdict.order : verdict;
    const ticker = textOf(order.ticker);
    if (!ticker) return [];
    const side = textOf(order.side) ?? "";
    const accepted = verdict.accepted === true;
    const rejected = verdict.accepted === false;
    const reason = rejectReasonText(textOf(verdict.rejectReason));
    return [{
      key: `${index}-${ticker}`,
      ticker,
      side: sideLabel(side || null),
      sideKey: side,
      size: proposedSizeText(side, order.targetWeightPct, order.sellFraction),
      result: accepted
        ? { key: "accepted", label: "통과", className: TONE.ok }
        : rejected
          ? { key: "rejected", label: "거절", className: TONE.warn }
          : { key: "unknown", label: EMPTY, className: TONE.muted },
      reason: reason.label,
      reasonTitle: reason.title,
      detail: textOf(verdict.detail) ?? EMPTY,
    }];
  });

  const watchlist: WatchRow[] = listOf(record?.watchlist).filter(isRecord).flatMap((entry, index) => {
    const ticker = textOf(entry.ticker);
    return ticker ? [{ key: `${index}-${ticker}`, ticker, condition: textOf(entry.condition) ?? EMPTY }] : [];
  });

  const target = isNumber(source.targetExposurePct) ? source.targetExposurePct : numberOf(record?.targetEquityExposurePct);
  const mismatch = source.exposureMismatch === true || record?.exposureMismatch === true;

  const usageCells: DecisionMetaCell[] = [];
  const model = source.model ?? textOf(usage?.model);
  if (model) usageCells.push({ key: "model", label: "모델", value: model });
  const tokenCells: [string, string, string[]][] = [
    ["inputTokens", "입력 토큰", ["inputTokens", "input_tokens"]],
    ["outputTokens", "출력 토큰", ["outputTokens", "output_tokens"]],
    ["cacheReadTokens", "캐시 읽기 토큰", ["cacheReadTokens", "cacheReadInputTokens", "cache_read_input_tokens"]],
    ["cacheWriteTokens", "캐시 쓰기 토큰", ["cacheWriteTokens", "cacheCreationInputTokens", "cache_creation_input_tokens"]],
  ];
  if (usage) {
    for (const [key, label, names] of tokenCells) {
      usageCells.push({ key, label, value: formatNumber(tokensOf(usage, ...names), 0) });
    }
    const stop = textOf(usage.stopReason) ?? textOf(usage.stop_reason);
    if (stop) usageCells.push({ key: "stopReason", label: "멈춘 이유", value: stop });
  }

  return {
    recognized,
    hasResponse,
    noResponse: hasResponse ? null : claudeNoResponseText(status, skipped, skippedKey !== null),
    skipped,
    stance: stanceBadge(record?.stance),
    targetExposure: formatWithUnit(target, 1, "%"),
    confidence: formatRatioPercent(numberOf(record?.confidence)),
    mismatch: mismatch
      ? {
        key: "exposureMismatch", label: "목표 노출 ≠ 주문", className: TONE.warn,
        title: "Claude가 정한 목표 주식 노출과 주문 반영 뒤 예상 주식 비중이 15%p 넘게 다릅니다. 집행은 주문 기준이고, 숫자를 맞추지 "
          + "않고 그대로 기록합니다(설계 §5-3).",
      }
      : null,
    summary: textOf(record?.summary),
    exposureRationale: textOf(record?.exposureRationale),
    noTradeReason: textOf(record?.noTradeReason),
    orders,
    validation,
    watchlist,
    usage: usageCells,
  };
}

/** 개요의 "Claude 계좌 시작" 카드. */
export interface ClaudeStartPrompt {
  /** 초기 결정을 보낼 책 코드(본문 `{book}`). */
  bookCode: string;
  bookLabel: string;
  title: string;
  body: string;
  /** 지금 프레임 판 안내와 권고 — 임시 판이면 OS 원문으로 사용자 판을 만든 뒤 시작을 권합니다(경고색). */
  framework: { tone: "warn" | "info"; text: string };
  cost: string;
  confirmPreview: string;
  confirmStart: string;
}

/**
 * 지금 판 안내(보충 계약 §7). 임시 v0이면 계약 문장 그대로("OS 원문으로 v1을 만든 뒤"), 승인으로 임시 상태를 이어받은 판(임시 v1 이후)이면
 * 그 번호로 같은 권고를, 사용자 판이면 그 판 번호를 적습니다. 판을 아직 읽지 못했으면(읽는 중·실패) 단정하지 않고 프레임 탭을 보라고 합니다.
 */
function startFrameworkNote(framework: FrameworkInfo | null): ClaudeStartPrompt["framework"] {
  const version = framework?.version ?? null;
  if (version === null) {
    return {
      tone: "warn",
      text: "지금 프레임 판을 아직 읽지 못했습니다 — 프레임 탭에서 판과 상태(임시·사용자 판)를 확인한 뒤 시작하세요. 시작은 한 번뿐이라 "
        + "임시 판이면 OS 원문으로 사용자 판을 만든 뒤 시작하기를 권합니다.",
    };
  }
  // 사용자 판을 만드는 길은 '직접 고치기'의 저장 — 'OS 원문으로 새 판 만들기'의 제안 승인은 임시 상태를 이어받습니다(F1).
  const tail = " 시작은 한 번뿐입니다(되돌리려면 계좌 초기화). 프레임 탭의 '직접 고치기'(수동 편집 — 저장하면 사용자 판)로 OS 원문의 원칙·"
    + "규칙을 옮길 수 있습니다('OS 원문으로 새 판 만들기'의 Claude 제안을 승인한 판은 임시 상태를 이어받음). 미리보기로 지금 판의 판단을 먼저 "
    + "볼 수 있습니다.";
  if (framework?.status === "INTERIM") {
    const head = version === 0
      ? "지금 프레임은 임시 v0입니다 — OS 원문으로 v1을 만든 뒤 시작을 권합니다."
      : `지금 프레임은 임시 v${version}입니다 — OS 원문으로 사용자 판을 만든 뒤 시작을 권합니다.`;
    return { tone: "warn", text: `${head} 임시 판은 사용자 OS 원문을 받기 전, 명세·설계의 지침으로 만든 판입니다.${tail}` };
  }
  const title = framework?.title ? ` (${framework.title})` : "";
  return {
    tone: "info",
    text: `지금 프레임은 ${frameworkVersionLabel(version, framework?.status ?? null)}${title}입니다 — Claude는 이 판으로 판단합니다. `
      + "시작은 한 번뿐이니 미리보기로 이 판의 판단을 먼저 볼 수 있습니다.",
  };
}

/**
 * Claude 책 시작 카드 — Claude 책이 시작 전(NOT_STARTED)일 때만, 아니면 null.
 *
 * 시작은 한 번뿐이고 되돌리려면 책 초기화로 장부를 지워야 해서, 버튼은 확인 단계를 한 번 거칩니다. 미리보기도 Claude를 부르므로(비용·
 * 하루 상한) 같은 확인을 거칩니다. 지금 판이 임시면 카드는 OS 원문으로 사용자 판을 만든 뒤 시작하기를 권합니다(막지는 않음 — 사용자가
 * 정함, 명세 L2).
 *
 * @param framework 지금 판(GET /api/paper/framework의 current). 아직 읽지 못했으면 null — 안내가 판을 단정하지 않습니다.
 */
export function claudeStartPrompt(
  overview: Pick<PaperOverviewResponse, "initialized" | "startDate" | "books">,
  framework: FrameworkInfo | null = null,
): ClaudeStartPrompt | null {
  if (overview.initialized === false) return null;
  const claude = (overview.books ?? []).find((book) => book.kind === "CLAUDE");
  if (!claude || claude.status !== "NOT_STARTED") return null;
  const start = overview.startDate ?? EMPTY;
  const label = claude.label;
  const object = withParticle(label, "을");
  const version = framework?.version ?? null;
  const frameworkTail = version === null
    ? ""
    : framework?.status === "INTERIM"
      ? ` 프레임은 아직 임시 v${version}입니다.`
      : ` 판단 프레임은 ${frameworkVersionLabel(version, framework?.status ?? null)}입니다.`;
  return {
    bookCode: claude.code,
    bookLabel: label,
    title: `${label} 시작`,
    body: `${withParticle(label, "은")} 아직 현금만 들고 있습니다. 시작하면 출발일(${start}) 기준 입력 패킷 — 그날 이전의 가격·FRED·13F·트랙레코드만, `
      + "매크로 카드는 그날 이력이 없어 지금 수집본을 참고로 — 을 Claude에 한 번 보내 주문 목록과 목표 주식 노출을 받고, 검증기(하드 규칙)를 "
      + "통과한 주문만 출발일 종가에 사후 체결합니다. 현금 비중은 Claude가 정합니다 — 노출 0%도 100%도 거절 사유가 아닙니다. 응답 형식 "
      + "오류·모델 거절·API 오류면 주문 없이 결정 기록에 사유가 남습니다.",
    framework: startFrameworkNote(framework),
    cost: CLAUDE_COST_NOTE,
    confirmPreview: `미리보기를 부를까요? ${CLAUDE_COST_NOTE} 출발일 기준 패킷으로 호출·검증까지 하고, 장부·결정·주문 기록은 바꾸지 않습니다`
      + "(사용량과, 없을 때만 출발일 기관 선정·제안 종목의 출발일 종가를 남김 — 시작이 같은 값을 씀).",
    confirmStart: `정말 시작할까요? ${CLAUDE_COST_NOTE} 검증을 통과한 주문을 출발일(${start}) 종가로 사후 체결하고 ${object} '운용 중'으로 `
      + "바꿉니다. 미리보기와 같은 답이 나온다는 보장은 없습니다(다시 부름). 되돌리려면 보유·체결 탭의 '계좌 초기화'로 이 계좌의 장부를 모두 "
      + `지워야 합니다.${frameworkTail}`,
  };
}

/**
 * 미리보기 결과 — 배너 색과 한 줄. ok:false면 서버 문구를, 응답을 쓰지 못했으면(형식 오류·거절·API 오류·상한) 경고색으로 사유를.
 * 어느 쪽이든 장부·결정·주문 기록은 바꾸지 않았다는 것(남긴 것도 함께)과, 시작하면 Claude를 다시 부르므로 답이 달라질 수 있다는 것을 적습니다
 * (명세 §6 — Claude 책은 같은 입력에도 답이 달라질 수 있음).
 */
export function claudePreviewResultView(result: PaperClaudePreviewResult): { tone: "warn" | "info"; text: string } {
  if (result.ok === false) return { tone: "warn", text: result.message ?? "미리보기를 하지 못했습니다." };
  const status = textOf(result.status);
  const failed = textOf(result.error) !== null || (status !== null && status !== "OK" && status !== "NO_TRADE");
  const untouched = "장부·결정·주문 기록은 바꾸지 않았습니다(남긴 것: 사용량, 없을 때만 출발일 기관 선정·제안 종목의 출발일 종가).";
  if (failed) {
    const label = status ? decisionStatusBadge(status).label : "응답 없음";
    return { tone: "warn", text: `미리보기 — ${label}${result.error ? `: ${result.error}` : ""}. ${untouched}` };
  }
  return {
    tone: "info",
    text: `미리보기 — ${result.model ?? "모델 미상"}의 응답을 검증까지 했습니다. ${untouched} 시작하면 Claude를 다시 부르므로 답이 `
      + "달라질 수 있습니다.",
  };
}

/** Claude 노출 추이 차트 — 행·계열과 마지막 날 한 줄. */
export interface ClaudeExposureChart {
  rows: Record<string, string | number | null>[];
  series: NavSeriesLine[];
  /** 마지막 거래일 한 줄("2026-10-27 — 목표 60.0% · 실제 58.2%"). 기록이 없으면 null. */
  latest: string | null;
}

/**
 * Claude 노출 추이(개요 claudeExposureSeries)를 차트 행으로 — 서버 순서(거래일 오름차순) 그대로. 모르는 값은 null로 두어 선을
 * 끊습니다(0이나 앞 값으로 채우면 없는 노출이 생김). 목표는 Claude가 적은 값, 실제는 장부 값이고 화면은 둘의 차를 계산하지 않습니다.
 */
export function claudeExposureChart(series: unknown): ClaudeExposureChart {
  const rows = listOf(series).filter(isRecord).flatMap((point) => {
    const date = textOf(point.tradingDate);
    return date ? [{ date, target: numberOf(point.targetExposurePct), actual: numberOf(point.actualExposurePct) }] : [];
  });
  const last = rows.at(-1) ?? null;
  return {
    rows,
    series: [
      { key: "target", name: "목표 노출(Claude가 정함)" },
      { key: "actual", name: "실제 노출(장부)" },
    ],
    latest: last
      ? `${last.date} — 목표 ${formatWithUnit(last.target, 1, "%")} · 실제 ${formatWithUnit(last.actual, 1, "%")}`
      : null,
  };
}

/** Claude 호출 사용량 카드(명세 C8) — 오늘·이달 칸과 안내. */
export interface ApiUsageView {
  /** "오늘(KST 2026-10-27)". */
  todayLabel: string;
  today: DecisionMetaCell[];
  /** "이달(KST 2026-10)". */
  monthLabel: string;
  month: DecisionMetaCell[];
  /** 오늘 호출이 상한에 닿았나 — 그날 남은 결정·미리보기·시작·프레임 제안은 Claude를 부르지 않습니다. */
  capReached: boolean;
  /** 서버 안내(호출 수의 뜻·토큰 출처). 보내지 않으면 null. */
  note: string | null;
  /** 추정 비용의 뜻과, 추정에서 빠진 호출이 있으면 그 사실. */
  costNote: string;
}

/** 추정 비용의 뜻 — 설정 단가 × 토큰의 어림이고 청구액이 아닙니다(명세 C8, 보충 계약 §3). */
export const API_COST_ESTIMATE_NOTE = "추정 비용은 설정 단가(pricing.* — 공식 가격표 기준 기본값)에 응답이 알려 준 토큰을 곱한 어림이고 "
  + "청구액이 아닙니다. 단가가 있는 모델(Sonnet·Haiku)이고 토큰을 아는 호출만 셉니다(추정 n/m회).";

/** 서버가 추정 비용 필드를 보내지 않을 때(단계 3b 전 백엔드) — 숫자를 지어내지 않고 토큰만 보입니다. */
export const API_COST_NOT_SENT = "이 서버는 추정 비용을 보내지 않습니다 — 호출 수와 토큰만 셉니다.";

/**
 * 추정 금액 — 1센트 이상은 소수 2자리("$0.09"), 그보다 작으면 4자리("$0.0045" — Haiku 한 번이 "$0.00"으로 보이면 공짜로 읽힘).
 * 모르면 "—".
 */
export function formatUsdEstimate(value: number | null | undefined): string {
  if (!isNumber(value)) return EMPTY;
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
  return `$${formatNumber(value, digits)}`;
}

/**
 * 추정 비용 칸 — "추정 $0.09 · 추정 1/2회"(추정한 호출 수 / 전체 호출 수). 서버가 추정한 호출이 없어 금액이 null이면 "—"(0으로 채우지
 * 않음). 금액은 서버 값 그대로이고 화면이 토큰으로 다시 계산하지 않습니다.
 */
function usageCostText(row: Record<string, unknown> | null): string {
  const cost = numberOf(row?.estCostUsd);
  if (cost === null) return EMPTY;
  return `추정 ${formatUsdEstimate(cost)} · 추정 ${formatNumber(numberOf(row?.estimatedCalls), 0)}/${formatNumber(numberOf(row?.calls), 0)}회`;
}

/**
 * 상태 응답의 apiUsage → 사용량 카드. 숫자는 서버 값 그대로(호출 수·토큰 합·추정 비용)이고, 모르는 값은 "—"입니다(0으로 채우지 않음).
 * 응답에 사용량이 없으면(구 서버·테이블 없음) null — 화면은 카드를 그리지 않습니다.
 */
export function apiUsageView(usage: unknown): ApiUsageView | null {
  if (!isRecord(usage)) return null;
  const today = isRecord(usage.today) ? usage.today : null;
  const month = isRecord(usage.month) ? usage.month : null;
  if (!today && !month) return null;
  const count = (value: unknown) => formatNumber(numberOf(value), 0);
  const tokens = (row: Record<string, unknown> | null): DecisionMetaCell[] => [
    { key: "inputTokens", label: "입력 토큰", value: count(row?.inputTokens) },
    { key: "outputTokens", label: "출력 토큰", value: count(row?.outputTokens) },
    { key: "cacheReadTokens", label: "캐시 읽기 토큰", value: count(row?.cacheReadTokens) },
    { key: "cacheWriteTokens", label: "캐시 쓰기 토큰", value: count(row?.cacheWriteTokens) },
  ];
  const cost = (row: Record<string, unknown> | null): DecisionMetaCell => ({ key: "estCost", label: "추정 비용", value: usageCostText(row) });
  const calls = numberOf(today?.calls);
  const cap = numberOf(today?.cap);
  // 추정 필드를 하나라도 보내면 3b 백엔드입니다. 그때 추정에서 빠진 호출(단가 도입 전·토큰 모름)이 있으면 그 사실을 적습니다.
  const rows = [today, month].filter((row): row is Record<string, unknown> => row !== null);
  const sent = rows.some((row) => "estCostUsd" in row || "estimatedCalls" in row);
  const partial = rows.some((row) => {
    const estimated = numberOf(row.estimatedCalls);
    const total = numberOf(row.calls);
    return estimated !== null && total !== null && estimated < total;
  });
  const costNote = !sent
    ? API_COST_NOT_SENT
    : partial
      ? `${API_COST_ESTIMATE_NOTE} 추정에서 빠진 호출이 있습니다 — 단가 도입 전 호출이나 토큰을 모르는 호출입니다.`
      : API_COST_ESTIMATE_NOTE;
  return {
    todayLabel: `오늘(KST ${textOf(today?.day) ?? EMPTY})`,
    today: [
      { key: "calls", label: "호출 / 하루 상한", value: `${count(calls)} / ${count(cap)}회` },
      ...(sent ? [cost(today)] : []),
      ...tokens(today),
    ],
    monthLabel: `이달(KST ${textOf(month?.month) ?? EMPTY})`,
    month: [
      { key: "calls", label: "호출", value: `${count(month?.calls)}회` },
      ...(sent ? [cost(month)] : []),
      ...tokens(month),
    ],
    capReached: calls !== null && cap !== null && calls >= cap,
    note: textOf(usage.note),
    costNote,
  };
}

// ---------------------------------------------------------------- 설정(명세 S1~S3, 설계 §4-4)

/**
 * 설정 입력의 종류. json은 이 화면에서 바꾸지 않는 값입니다(서버 형 이름도 값 모양도 알 수 없음 — 원문만 보임).
 * 서버가 보낸 형 이름(keys[].type)을 먼저 보고, 모르는 이름이면 지금 값의 모양으로 정합니다.
 * 2단계(C1b, 명세 K38)의 한국 키 형: date(yyyy-MM-dd 하나 — kr.tax.effectiveFrom) · dates(날짜 목록 — kr.calendar.extraClosures) ·
 * dateTimeMap(날짜 → 개장·마감 — kr.calendar.openTimeOverrides) · aliasMap(종목 코드 → 별칭 목록 — kr.news.aliases).
 */
export type SettingKind =
  | "number" | "integer" | "boolean" | "list" | "phrases" | "text" | "choice" | "json"
  | "date" | "dates" | "dateTimeMap" | "aliasMap";

/** 설정 키 묶음(점 경로의 첫 마디) 이름. 모르는 묶음은 이름 그대로. */
const SETTING_GROUP: Record<string, string> = {
  "": "일반 — Claude 계좌 · 장부 · 검증기 · 규칙 계좌 · 메모",
  trackRecord: "기관 선정 — 트랙레코드(그룹 A)",
  blend: "두 기관 그룹 섞기(D27)",
  rules: "규칙 계좌",
  gate: "OS 게이트 지표 — 참고 임계치(구속하지 않음)",
  news: "사건 뉴스 — Claude 계좌 패킷 11b(2단계 B, 규칙 계좌 영향 없음)",
  calendar: "발표 일정 — 캘린더 컨센서스(3단계 스위치, 두 책 공통)",
  claude: "Claude 계좌 3단계 스위치 — 두 책 공통(규칙 계좌 영향 없음)",
  kr: "한국 책 — 비용 · 장부 · 검증기 · 규칙 계좌 · 결정 시각(kr.*)",
  "kr.tax": "한국 책 — 매도 세금(세율 · 시행일)",
  "kr.rules": "한국 책 — 규칙 계좌(수급 신호 · 재선정)",
  "kr.calendar": "한국 책 — 거래일 달력(임시휴장 · 장 시간 변경일)",
  "kr.news": "한국 책 — 사건 뉴스(Claude 계좌 패킷 11b, 규칙 계좌 영향 없음)",
};

/** 한국 키는 둘째 마디까지 묶습니다(kr.tax.kospi.sttBp → kr.tax) — 서른 개 넘는 kr.* 키가 한 묶음에 몰리지 않게. 나머지는 첫 마디. */
function settingGroupKey(key: string): string {
  const parts = key.split(".");
  if (parts[0] === "kr" && parts.length >= 3) return `kr.${parts[1]}`;
  return parts.length > 1 ? parts[0] : "";
}

/** 설정 한 줄(표시·입력용). */
export interface SettingRow {
  key: string;
  /** 묶음 키(점 경로의 첫 마디, 점이 없으면 ""). */
  group: string;
  kind: SettingKind;
  /**
   * 지금 값 — 입력이 바뀌었는지 이 값과 맞춰 봅니다. 설정 본문에 키가 없으면(missing) 서버가 읽는 기본값입니다.
   */
  value: unknown;
  /**
   * 설정 본문에 이 키가 없어 서버가 기본값으로 읽는 중(2단계 B 전에 만든 설정 행의 news.* 등). 입력 상자·지금 값 표기는 그 기본값입니다.
   */
  missing: boolean;
  /** 입력 상자의 처음 글자. */
  initial: string;
  /** 지금 값 표기. */
  current: string;
  /** 기본값 표기. 기본값을 모르면 "—". */
  defaultText: string;
  /** 지금 값이 기본값과 같은가. 기본값을 모르면 null. */
  isDefault: boolean | null;
  /** 범위 표기("0~20", "1 이상"). 범위가 없으면 null. */
  range: string | null;
  min: number | null;
  max: number | null;
  affectsRules: boolean;
  /** 그 키를 읽는 책(서버 keys[].market — US·KR, 두 책 공통이면 null). 규칙 계좌 영향 경고를 이 시장의 규칙 계좌로 적습니다. */
  market: string | null;
  description: string | null;
  /** 선택 상자의 선택지(choice만). 지금 값이 목록에 없으면 뒤에 붙입니다(선택 상자가 다른 값을 가리키지 않게). */
  options: string[];
}

/** 설정 묶음 하나 — 서버가 보낸 키 순서대로 처음 나온 묶음 순. */
export interface SettingGroup {
  key: string;
  title: string;
  rows: SettingRow[];
}

/**
 * 설정 본문에서 점 경로 하나의 값. 본문 맨 위에 점 이름 그대로 든 키가 있으면 그것, 아니면 묶음을 따라 내려갑니다. 없으면 undefined.
 */
export function settingValueAt(body: unknown, key: string): unknown {
  if (!isRecord(body)) return undefined;
  if (Object.hasOwn(body, key)) return body[key];
  let node: unknown = body;
  for (const part of key.split(".")) {
    if (!isRecord(node) || !Object.hasOwn(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

/** 날짜 → {open, close} 표의 줄들("2026-11-19 10:00~16:30") — 그 모양이 아니면 null. */
function dateTimeMapLines(value: unknown): string[] | null {
  if (!isRecord(value)) return null;
  const lines: string[] = [];
  for (const [date, pair] of Object.entries(value)) {
    if (!isRecord(pair) || typeof pair.open !== "string" || typeof pair.close !== "string") return null;
    lines.push(`${date} ${pair.open}~${pair.close}`);
  }
  return lines;
}

/** 종목 코드 → 별칭 목록 표의 줄들("000660: 하이닉스, SK 하이닉스") — 그 모양이 아니면 null. */
function aliasMapLines(value: unknown): string[] | null {
  if (!isRecord(value)) return null;
  const lines: string[] = [];
  for (const [code, aliases] of Object.entries(value)) {
    if (!Array.isArray(aliases) || !aliases.every((alias) => typeof alias === "string")) return null;
    lines.push(`${code}: ${aliases.join(", ")}`);
  }
  return lines;
}

/**
 * 설정 값 표기 — 참·거짓은 "예"·"아니오", 목록은 쉼표로, 빈 목록·빈 표는 "(없음)", 모르면 "—". 숫자는 입력 상자와 같은 글자(천 단위 쉼표 없음).
 * 날짜별 개장·마감 표는 "날짜 개장~마감"을 쉼표로, 별칭 표는 "코드: 별칭, 별칭"을 " · "로(한국 키, C1b) — 그 밖의 객체는 원문.
 */
export function settingText(value: unknown): string {
  if (value === null || value === undefined) return EMPTY;
  if (typeof value === "boolean") return value ? "예" : "아니오";
  if (Array.isArray(value)) return value.length > 0 ? value.map((entry) => settingText(entry)).join(", ") : "(없음)";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : EMPTY;
  if (typeof value === "string") return value || "(빈 글자)";
  if (isRecord(value) && Object.keys(value).length === 0) return "(없음)";
  const times = dateTimeMapLines(value);
  if (times) return times.join(", ");
  const aliases = aliasMapLines(value);
  if (aliases) return aliases.join(" · ");
  return jsonTitle(value) ?? EMPTY;
}

/** 입력 상자에 넣을 글자 — 참·거짓은 "true"·"false"(선택용), 목록은 쉼표로, 표(한국 키)는 한 줄에 한 항목, 없으면 빈 글자. */
function settingInputText(value: unknown, kind: SettingKind): string {
  if (value === null || value === undefined) return "";
  if (kind === "boolean") return value === true ? "true" : value === false ? "false" : "";
  if (kind === "dateTimeMap") return (dateTimeMapLines(value) ?? []).join("\n");
  if (kind === "aliasMap") return (aliasMapLines(value) ?? []).join("\n");
  if (Array.isArray(value)) return value.map((entry) => (typeof entry === "string" ? entry : String(entry))).join(", ");
  if (typeof value === "number" || typeof value === "string") return String(value);
  return jsonTitle(value) ?? "";
}

function settingKind(type: unknown, options: readonly string[], value: unknown): SettingKind {
  if (options.length > 0) return "choice";
  const name = (textOf(type) ?? "").trim().toLowerCase();
  if (["integer", "int", "long", "short"].includes(name)) return "integer";
  if (["number", "double", "float", "decimal"].includes(name)) return "number";
  if (["boolean", "bool"].includes(name)) return "boolean";
  // 구절 목록(사건 뉴스 키워드) — 항목 안에 공백이 있어("rate decision") 공백으로 나누면 안 됩니다.
  if (name === "phrases") return "phrases";
  // 한국 키의 형(C1b) — 서버 이름 date·dates·dateTimeMap·aliasMap(소문자로 비교).
  if (name === "date") return "date";
  if (name === "dates") return "dates";
  if (name === "datetimemap") return "dateTimeMap";
  if (name === "aliasmap") return "aliasMap";
  if (name.startsWith("list") || name.startsWith("array") || name.endsWith("[]")) return "list";
  if (["string", "text", "time", "enum"].includes(name)) return "text";
  // 서버 형 이름을 모르면 지금 값의 모양으로 — 정수인지 소수인지는 값 하나로 알 수 없어 숫자는 모두 number입니다.
  if (Array.isArray(value)) return "list";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "text";
  return "json";
}

/** 범위 표기 — "0~20", "1 이상", "100 이하". 둘 다 없으면 null. 서버가 보낸 숫자 그대로입니다. */
export function settingRangeText(min: number | null | undefined, max: number | null | undefined): string | null {
  const low = isNumber(min) ? String(min) : null;
  const high = isNumber(max) ? String(max) : null;
  if (low !== null && high !== null) return `${low}~${high}`;
  if (low !== null) return `${low} 이상`;
  if (high !== null) return `${high} 이하`;
  return null;
}

const sameSettingValue = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/**
 * 설정 응답을 묶음별 줄로 — 키 순서는 서버가 보낸 keys 순서 그대로이고, 값은 본문(body)·기본값(defaults)에서 점 경로로 찾습니다.
 * 범위는 서버 값 그대로 적기만 하고 화면이 검사하지 않습니다(서버가 저장할 때 검사하고, 틀리면 400 문구를 그대로 보임).
 */
export function settingGroups(response: PaperSettingsResponse | null | undefined): SettingGroup[] {
  const groups: SettingGroup[] = [];
  for (const meta of response?.keys ?? []) {
    if (!isRecord(meta)) continue;
    const key = textOf(meta.key);
    if (!key) continue;
    const stored = settingValueAt(response?.body, key);
    const fallback = settingValueAt(response?.defaults, key);
    // 본문에 없는 키는 서버가 기본값으로 읽습니다 — 빈 칸·'아니오'로 그리면 실제로 쓰는 값과 반대로 보이고(켜진 news.enabled가 꺼짐으로),
    // 빈 칸으로 보이는 목록에 하나만 넣어 저장하면 보이지 않던 기본값(키워드 사전 등)이 통째로 바뀝니다. 그래서 기본값을 지금 값으로 둡니다.
    const missing = stored === undefined && fallback !== undefined;
    const value = missing ? fallback : stored;
    const options = listOf(meta.options).filter((option): option is string => typeof option === "string" && option.length > 0);
    const kind = settingKind(meta.type, options, value);
    const choices = typeof value === "string" && kind === "choice" && value && !options.includes(value) ? [...options, value] : options;
    const groupKey = settingGroupKey(key);
    const row: SettingRow = {
      key,
      group: groupKey,
      kind,
      value,
      missing,
      initial: settingInputText(value, kind),
      current: missing ? `${settingText(value)} (설정 행에 없음 — 기본값으로 읽음)` : settingText(value),
      defaultText: settingText(fallback),
      isDefault: fallback === undefined ? null : sameSettingValue(value, fallback),
      range: settingRangeText(numberOf(meta.min), numberOf(meta.max)),
      min: numberOf(meta.min),
      max: numberOf(meta.max),
      affectsRules: meta.affectsRules === true,
      market: textOf(meta.market),
      description: textOf(meta.description),
      options: choices,
    };
    const group = groups.find((entry) => entry.key === groupKey);
    if (group) group.rows.push(row);
    else groups.push({ key: groupKey, title: SETTING_GROUP[groupKey] ?? groupKey, rows: [row] });
  }
  return groups;
}

/** 입력 글자를 설정 값으로 읽은 결과. */
export type SettingParse = { ok: true; value: unknown } | { ok: false; error: string };

/** 한 줄에 한 항목인 표 입력(한국 키, C1b)의 줄들 — 앞뒤 공백을 빼고 빈 줄은 건너뜁니다. */
function tableLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** 키 순서를 맞춘 객체 — 서버가 키 오름차순으로 저장하므로, 줄 순서만 바꾼 입력이 '바뀐 값'으로 잡히지 않게. */
function sortedRecord<T>(entries: Array<[string, T]>): Record<string, T> {
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** 날짜별 개장·마감 표 입력 — 줄마다 "2026-11-19 10:00~16:30". 날짜·시각이 맞는지는 서버가 봅니다(줄 모양만 읽음). */
function parseDateTimeMap(text: string): SettingParse {
  const entries: Array<[string, { open: string; close: string }]> = [];
  for (const line of tableLines(text)) {
    const match = /^(\S+)\s+(\S+?)\s*~\s*(\S+)$/.exec(line);
    if (!match) return { ok: false, error: `한 줄에 '날짜 개장~마감'(예: 2026-11-19 10:00~16:30)으로 적으세요 — ${line}` };
    if (entries.some(([date]) => date === match[1])) return { ok: false, error: `같은 날짜가 두 줄에 있습니다 — ${match[1]}` };
    entries.push([match[1], { open: match[2], close: match[3] }]);
  }
  return { ok: true, value: sortedRecord(entries) };
}

/** 별칭 표 입력 — 줄마다 "000660: 하이닉스, SK하이닉스". 별칭은 쉼표로 나누고 안의 공백은 한 칸으로(구절 목록과 같음). */
function parseAliasMap(text: string): SettingParse {
  const entries: Array<[string, string[]]> = [];
  for (const line of tableLines(text)) {
    const match = /^([^:]+?)\s*:\s*(.*)$/.exec(line);
    if (!match) return { ok: false, error: `한 줄에 '종목 코드: 별칭, 별칭'(예: 000660: 하이닉스)으로 적으세요 — ${line}` };
    if (entries.some(([code]) => code === match[1])) return { ok: false, error: `같은 종목 코드가 두 줄에 있습니다 — ${match[1]}` };
    entries.push([match[1], match[2].split(",").map((alias) => alias.replace(/\s+/g, " ").trim()).filter(Boolean)]);
  }
  return { ok: true, value: sortedRecord(entries) };
}

/**
 * 입력 글자를 그 키의 형으로 읽습니다 — 숫자는 숫자로(정수 키는 정수만), 참·거짓은 그대로, 목록·날짜 목록은 쉼표·공백·줄바꿈으로 나눠
 * 빈 칸을 빼고, 구절 목록(phrases)은 쉼표·줄바꿈으로만 나누고, 표(날짜별 개장·마감·별칭)는 한 줄에 한 항목으로 읽습니다. 범위·날짜
 * 형식은 검사하지 않습니다(서버 몫 — 같은 규칙을 두 곳에 두면 갈라집니다). 형으로 읽을 수 없으면 오류 문구.
 */
export function parseSettingInput(row: Pick<SettingRow, "kind">, text: string): SettingParse {
  const trimmed = text.trim();
  switch (row.kind) {
    case "integer":
    case "number": {
      if (!trimmed) return { ok: false, error: "값을 넣으세요." };
      const value = Number(trimmed);
      if (!Number.isFinite(value)) return { ok: false, error: "숫자가 아닙니다." };
      if (row.kind === "integer" && !Number.isInteger(value)) return { ok: false, error: "정수를 넣으세요." };
      return { ok: true, value };
    }
    case "boolean":
      return trimmed === "true" || trimmed === "false"
        ? { ok: true, value: trimmed === "true" }
        : { ok: false, error: "예·아니오를 고르세요." };
    case "list":
      return { ok: true, value: trimmed.split(/[\s,]+/).filter(Boolean) };
    case "dates":
      // 서버가 날짜 묶음을 중복 없이 오름차순으로 저장하므로 같은 모양으로 — 순서만 바꾼 입력이 '바뀐 값'으로 잡히지 않게.
      return { ok: true, value: [...new Set(trimmed.split(/[\s,]+/).filter(Boolean))].sort() };
    case "dateTimeMap":
      return parseDateTimeMap(text);
    case "aliasMap":
      return parseAliasMap(text);
    case "phrases":
      // 쉼표·줄바꿈으로만 나누고 항목 안의 공백은 한 칸으로 — 정규화·중복 제거는 서버가 다시 합니다(같은 규칙을 두 곳에 두지 않음).
      return { ok: true, value: trimmed.split(/[,\n]+/).map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean) };
    case "choice":
    case "text":
    case "date":
      return trimmed ? { ok: true, value: trimmed } : { ok: false, error: "값을 넣으세요." };
    default:
      return { ok: false, error: "이 화면에서 바꾸지 않는 값입니다." };
  }
}

/** 저장할 바뀐 값 하나. */
export interface SettingChange {
  key: string;
  from: string;
  to: string;
  value: unknown;
  affectsRules: boolean;
  /** 그 키를 읽는 책(US·KR, 공통이면 null) — 규칙 계좌 영향 경고의 시장. */
  market: string | null;
}

/** 입력 중인 값의 상태 — 바뀐 값(저장할 것)과 형으로 읽지 못한 키의 오류 문구. */
export interface SettingsDraftView {
  changes: SettingChange[];
  errors: Record<string, string>;
}

/**
 * 입력 중인 글자(draft — 손댄 키만)를 바뀐 값 목록으로. 형으로 읽은 값이 지금 값과 같으면(되돌렸거나 "SHY,TLT"처럼 표기만 다르면)
 * 바뀐 것이 아닙니다. 순서는 설정 줄 순서(서버 keys 순서)입니다.
 */
export function settingsDraftView(
  groups: readonly SettingGroup[],
  draft: Readonly<Record<string, string>>,
): SettingsDraftView {
  const changes: SettingChange[] = [];
  const errors: Record<string, string> = {};
  for (const row of groups.flatMap((group) => group.rows)) {
    const text = draft[row.key];
    if (text === undefined) continue;
    const parsed = parseSettingInput(row, text);
    if (!parsed.ok) {
      errors[row.key] = parsed.error;
      continue;
    }
    if (sameSettingValue(parsed.value, row.value)) continue;
    changes.push({
      key: row.key, from: row.current, to: settingText(parsed.value), value: parsed.value, affectsRules: row.affectsRules,
      market: row.market,
    });
  }
  return { changes, errors };
}

/** 저장 본문(patch) — 바뀐 키만, 키는 keys[].key(점 경로) 그대로: `{"trackRecord.windowYears": 5}`. */
export function settingsPatch(changes: readonly SettingChange[]): Record<string, unknown> {
  return Object.fromEntries(changes.map((change) => [change.key, change.value]));
}

/** 규칙 책 영향 키를 바꿀 때의 경고 — 서버 warning과 같은 문장(명세 S3). 미국 규칙 계좌. */
export const RULES_FROZEN_WARNING = "규칙 계좌는 동결된 대조군입니다 — 이 변경은 실험 조건을 바꿉니다";

/** 한국 규칙 계좌(kr_rules) 영향 키(market KR)를 바꿀 때의 경고 — 서버 warning과 같은 문장(2단계 명세 §4-13, C1b). */
export const KR_RULES_FROZEN_WARNING = "한국 규칙 계좌(kr_rules)는 동결된 대조군입니다 — 이 변경은 한국 책의 실험 조건을 바꿉니다";

/**
 * 저장 전 확인 문구 — 바뀐 값에 규칙 책 영향 키(서버 keys[].affectsRules)가 있을 때만, 없으면 null(바로 저장).
 * 규칙 책은 대조군이라 조건을 바꾸면 그 앞뒤 기록이 다른 실험이 됩니다 — 그래서 한 번 더 묻습니다(S3).
 * 경고 문장은 그 키 시장의 규칙 계좌(미국 키만이면 예전 문장 그대로, 한국 키는 한국 문장, 둘 다면 미국 · 한국 — 서버 warning과 같은 순서).
 */
export function settingsConfirmText(changes: readonly SettingChange[]): string | null {
  const affected = changes.filter((change) => change.affectsRules);
  if (affected.length === 0) return null;
  const warnings = [
    ...(affected.some((change) => change.market !== "KR") ? [RULES_FROZEN_WARNING] : []),
    ...(affected.some((change) => change.market === "KR") ? [KR_RULES_FROZEN_WARNING] : []),
  ];
  const keys = affected.map((change) => change.key);
  return `${warnings.join(" · ")}. 바꾸는 규칙 계좌 영향 키: ${keys.join(", ")}. 이 뒤의 규칙 계좌 결정은 다른 조건으로 낸 것이 됩니다`
    + "(결정 기록마다 설정 버전이 남습니다). 그래도 저장할까요?";
}

/**
 * 저장 결과 — 배너 색과 한 줄, 서버 경고(규칙 책 영향 키). 바뀐 키가 없으면 버전이 그대로라고 적습니다.
 * 반영 시점은 서버 계약대로(재기동 없이 다음 작업부터 — 명세 S1) 적습니다.
 */
export function settingsSaveResultView(
  result: PaperSettingsSaveResult,
): { tone: "warn" | "info"; text: string; warning: string | null } {
  if (result.ok === false) return { tone: "warn", text: result.message ?? "설정을 저장하지 못했습니다.", warning: null };
  const keys = listOf(result.changedKeys).filter((key): key is string => typeof key === "string");
  const version = isNumber(result.version) ? `v${result.version}` : EMPTY;
  const warning = textOf(result.warning);
  if (keys.length === 0) return { tone: "info", text: `바뀐 값이 없습니다 — 설정 ${version} 그대로입니다.`, warning };
  return {
    tone: "info",
    text: `설정 ${version}(으)로 저장했습니다 — 바뀐 키 ${keys.join(", ")}. 재기동 없이 다음 작업부터 씁니다.`,
    warning,
  };
}

/** 설정 이력 한 줄(표시 문자열). */
export interface SettingsHistoryRow {
  key: string;
  version: string;
  createdAt: string;
  /** 바뀐 키와 그 버전의 값("trackRecord.windowYears = 5 · slippageBp = 10"). 처음 버전은 "처음 값(초기화)". */
  changes: string;
  /** 규칙 책 영향 키를 바꾼 버전인가. */
  rulesAffected: boolean;
}

/**
 * 설정 이력(최근 순, 서버 순서 그대로)을 표 줄로. 바뀐 키의 값은 그 버전의 본문에서 찾아 붙이고(본문을 보내지 않으면 키 이름만),
 * 규칙 책 영향 여부는 지금 키 설명(affectsRules)으로 표시합니다 — 그 버전 때의 판정이 아니라 지금 기준입니다.
 */
export function settingsHistoryRows(history: unknown, keys: readonly PaperSettingKey[] | null | undefined): SettingsHistoryRow[] {
  const affects = new Set((keys ?? []).filter((meta) => meta.affectsRules === true).map((meta) => meta.key));
  return listOf(history).filter(isRecord).flatMap((entry, index) => {
    const version = numberOf(entry.version);
    const changed = listOf(entry.changedKeys).filter((key): key is string => typeof key === "string" && key.length > 0);
    const body = isRecord(entry.body) ? entry.body : null;
    const changes = changed.length === 0
      ? "처음 값(초기화)"
      : changed.map((key) => {
        const value = settingValueAt(body, key);
        return value === undefined ? key : `${key} = ${settingText(value)}`;
      }).join(" · ");
    return [{
      key: `${index}-${version ?? "unknown"}`,
      version: version === null ? EMPTY : `v${formatNumber(version, 0)}`,
      createdAt: formatKst(textOf(entry.createdAtKst)),
      changes,
      rulesAffected: changed.some((key) => affects.has(key)),
    }];
  });
}

// ---------------------------------------------------------------- 프레임(투자 OS)·메모(단계 3b, 명세 F1~F7·D14·D15)

/**
 * 판 길이 한도(계약 A·E) — 원칙·규칙 300자, 지침 2,000자, 시황 메모 본문 4,000자, 엔진 8개. 서버가 저장할 때 다시 검사하고(틀리면 400 문구를
 * 그대로 보임), 화면은 입력 중에 글자 수를 보이고 넘으면 저장 버튼을 막으려고만 씁니다. 글자 수는 서버(FrameworkService.codePoints)와 같은
 * 코드 포인트 단위입니다 — .length(UTF-16)로 세면 이모지 하나가 2자가 되어 서버보다 먼저 막습니다.
 */
export const FRAMEWORK_TEXT_LIMIT = 300;
export const FRAMEWORK_GUIDANCE_LIMIT = 2000;
export const FRAMEWORK_ENGINE_COUNT = 8;
export const NOTE_MARKET_BODY_LIMIT = 4000;

/** 글자 수(코드 포인트) — 서버의 String.codePointCount와 같은 셈. */
export function textLength(text: string): number {
  return Array.from(text).length;
}

/** 글자 수 표기 — "123/300자"와 넘었는지. */
export function charCount(text: string, limit: number): { text: string; over: boolean } {
  const length = textLength(text);
  return { text: `${formatNumber(length, 0)}/${formatNumber(limit, 0)}자`, over: length > limit };
}

/** 프레임 판 표시에 쓰는 세 값 — 판 번호·상태(INTERIM·USER)·제목. 모르면 null. */
export interface FrameworkInfo {
  version: number | null;
  status: string | null;
  title: string | null;
}

/**
 * 판 정보 읽기 — 지금 판(current)·결정 기록의 response.framework·판 경계 어느 것이든 `{version, status, title}`. 단계 3a 결정 기록은
 * `{version:null, interim:true, label}` 모양이라 interim을 INTERIM으로, label을 제목으로 읽습니다. 객체가 아니면 null.
 */
export function frameworkInfoOf(value: unknown): FrameworkInfo | null {
  if (!isRecord(value)) return null;
  return {
    version: numberOf(value.version),
    status: textOf(value.status) ?? (value.interim === true ? "INTERIM" : null),
    title: textOf(value.title) ?? textOf(value.label),
  };
}

/** 판 이름 — 임시 판은 "임시 v0", 그 밖은 "v1". 번호를 모르면 "—". */
export function frameworkVersionLabel(version: number | null | undefined, status: string | null | undefined): string {
  if (!isNumber(version)) return EMPTY;
  return status === "INTERIM" ? `임시 v${version}` : `v${version}`;
}

/** 임시 판의 뜻(배지 설명·안내). */
export const INTERIM_FRAMEWORK_NOTE = "임시 판 — 사용자 OS 원문을 받기 전, 명세·설계의 지침으로 만든 판입니다.";

/** 판 상태 배지 — "임시 v0"(경고색) · "v1 · 사용자 판". 모르는 상태는 받은 글자 그대로. */
export function frameworkStatusBadge(status: string | null | undefined, version: number | null | undefined): Badge {
  const name = frameworkVersionLabel(version, status);
  if (status === "INTERIM") return { key: "framework-INTERIM", label: name, className: TONE.warn, title: INTERIM_FRAMEWORK_NOTE };
  if (status === "USER") {
    return { key: "framework-USER", label: `${name} · 사용자 판`, className: TONE.ok, title: "사용자가 만든 판(OS 원문·수동 편집·그 뒤 승인)입니다." };
  }
  return { key: `framework-${status ?? "unknown"}`, label: status ? `${name} · ${status}` : name, className: TONE.muted };
}

/** 지금 판 카드에 적을 값(표시 문자열). */
export interface FrameworkCurrentView {
  version: number | null;
  title: string;
  badge: Badge;
  /** 임시 판 안내와 권고. 임시 판이 아니면 null. */
  interimNote: string | null;
  createdAt: string;
  changelog: string;
  /** "추정 7,812토큰 / 예산 8,000토큰". 어림을 모르면 "—". */
  tokens: string;
  /** 예산 초과 경고(서버 판정 overBudget). 넘지 않았거나 모르면 null. */
  overBudget: string | null;
  rendered: string | null;
  /** "원칙 5 · 엔진 8 · 규칙 17". 본문이 없으면 null. */
  counts: string | null;
}

/**
 * 렌더링 예산(설정 frameworkTokenBudget, F4) — 판 응답 맨 위의 tokenBudget(서버가 지금 설정에서 읽은 값)이 있으면 그것, 없으면 설정 본문.
 * 둘 다 모르면 null(예산 없이 어림만 보임).
 */
export function frameworkBudgetFrom(response: { tokenBudget?: unknown } | null | undefined, settingsBody: unknown): number | null {
  return numberOf(response?.tokenBudget) ?? numberOf(settingValueAt(settingsBody, "frameworkTokenBudget"));
}

/**
 * 지금 판 카드. 토큰은 서버의 문자 수 어림(tokensEst) 그대로, 예산은 판 응답에 있으면 그것, 없으면 설정의 frameworkTokenBudget —
 * 화면이 렌더링 글자를 다시 세지 않습니다. 예산을 넘었는지도 서버 판정(overBudget)만 씁니다(F4 — 막지는 않음).
 */
export function frameworkCurrentView(
  current: PaperFrameworkVersion | null | undefined,
  budgetFallback: number | null = null,
): FrameworkCurrentView | null {
  if (!current || !isRecord(current)) return null;
  const version = numberOf(current.version);
  const status = textOf(current.status);
  const body = isRecord(current.body) ? current.body : null;
  const budget = isNumber(current.tokenBudget) ? current.tokenBudget : budgetFallback;
  const estimate = numberOf(current.tokensEst);
  const tokens = estimate === null
    ? EMPTY
    : `추정 ${formatNumber(estimate, 0)}토큰${budget === null ? "" : ` / 예산 ${formatNumber(budget, 0)}토큰`}`;
  const engines = listOf(body?.engines).filter(isRecord);
  const rules = engines.reduce((sum, engine) => sum + listOf(engine.rules).length, 0);
  return {
    version,
    title: textOf(current.title) ?? textOf(body?.title) ?? EMPTY,
    badge: frameworkStatusBadge(status, version),
    // 사용자 판(v1)을 만드는 길은 '직접 고치기'의 저장뿐이라 그것을 먼저 적습니다 — 제안 승인은 기준 판의 상태(임시)를 이어받습니다(F1).
    interimNote: status === "INTERIM"
      ? `지금 판은 ${frameworkVersionLabel(version, status)}입니다 — 사용자 OS 원문을 받기 전, 명세·설계의 지침으로 만든 판입니다. 아래 '직접 `
        + "고치기'로 OS 원문의 원칙·규칙을 옮겨 저장하면 사용자 판(v1)이 됩니다 — 그 뒤 Claude 계좌를 시작하기를 권합니다. 'OS 원문으로 새 판 "
        + "만들기'(원문 → 방법론 메모 → Claude 제안 → 승인)는 원문과 지금 판을 대조한 제안을 받는 길이고, 제안을 승인한 판은 기준 판의 상태를 "
        + "이어받아 임시로 남습니다."
      : null,
    createdAt: formatKst(textOf(current.createdAtKst)),
    changelog: textOf(current.changelog) ?? EMPTY,
    tokens,
    overBudget: current.overBudget === true
      ? `렌더링이 예산을 넘습니다(${tokens}) — 막지는 않지만 시스템 프롬프트가 길어져 비용·캐시에 부담이 됩니다. 규칙을 줄이거나 합치세요`
        + "(예산은 설정 frameworkTokenBudget, 명세 F4)."
      : null,
    rendered: typeof current.rendered === "string" && current.rendered ? current.rendered : null,
    counts: body
      ? `원칙 ${formatNumber(listOf(body.principles).length, 0)} · 엔진 ${formatNumber(engines.length, 0)} · 규칙 ${formatNumber(rules, 0)}`
      : null,
  };
}

/** 판 목록 한 줄(표시 문자열). */
export interface FrameworkVersionRow {
  key: string;
  versionNumber: number;
  version: string;
  title: string;
  changelog: string;
  createdAt: string;
  /** 어떻게 생긴 판인가 — "제안 #3 승인" · "처음 시드(임시)" · "수동 편집". */
  source: string;
  current: boolean;
}

/**
 * 판 목록(서버 순서 그대로)을 표 줄로. 출처는 sourceProposalId가 있으면 그 제안의 승인, 없으면 수동 편집 — v0만은 테이블이 비었을 때
 * 서버가 시드한 임시 판입니다(보충 계약 §1).
 */
export function frameworkVersionRows(versions: unknown, currentVersion: number | null | undefined): FrameworkVersionRow[] {
  return listOf(versions).filter(isRecord).flatMap((entry, index) => {
    const version = numberOf(entry.version);
    if (version === null) return [];
    const proposal = numberOf(entry.sourceProposalId);
    const status = textOf(entry.status);
    return [{
      key: `${index}-${version}`,
      versionNumber: version,
      version: status ? frameworkVersionLabel(version, status) : `v${version}`,
      title: textOf(entry.title) ?? EMPTY,
      changelog: textOf(entry.changelog) ?? EMPTY,
      createdAt: formatKst(textOf(entry.createdAtKst)),
      source: proposal !== null ? `제안 #${proposal} 승인` : version === 0 ? "처음 시드(임시)" : "수동 편집",
      current: isNumber(currentVersion) && version === currentVersion,
    }];
  });
}

/** 비교할 두 판의 선택지 — "v1 — 제목"(서버 순서). */
export function frameworkCompareOptions(versions: readonly PaperFrameworkVersionSummary[] | null | undefined) {
  return (versions ?? []).filter((entry) => isNumber(entry.version)).map((entry) => ({
    value: String(entry.version),
    label: `v${entry.version}${entry.title ? ` — ${entry.title}` : ""}`,
  }));
}

/** 비교 기본값 — 오른쪽은 지금 판(없으면 가장 큰 번호), 왼쪽은 그 바로 앞 판. 판이 하나뿐이면 왼쪽은 null. */
export function frameworkCompareDefaults(
  versions: readonly PaperFrameworkVersionSummary[] | null | undefined,
  currentVersion: number | null | undefined,
): { left: number | null; right: number | null } {
  const numbers = (versions ?? []).map((entry) => entry.version).filter(isNumber);
  const right = isNumber(currentVersion) ? currentVersion : numbers.length > 0 ? Math.max(...numbers) : null;
  const earlier = right === null ? [] : numbers.filter((version) => version < right);
  return { left: earlier.length > 0 ? Math.max(...earlier) : null, right };
}

/** 나란히 비교의 한 줄 — 다른 쪽 렌더링에 같은 줄이 없으면 changed. */
export interface CompareLine {
  key: string;
  text: string;
  changed: boolean;
}

/**
 * 두 판의 렌더링(서버가 준 글 그대로)을 줄로 나눠 나란히 — 다른 쪽에 똑같은 줄이 없는 줄에 표시만 합니다(빈 줄은 표시하지 않음). 줄 순서를
 * 맞추는 diff가 아니라 "이 줄은 저쪽에 없다"는 표시라, 순서만 바뀐 줄은 표시되지 않습니다.
 */
export function renderedCompare(left: string | null | undefined, right: string | null | undefined): {
  left: CompareLine[];
  right: CompareLine[];
  changedLeft: number;
  changedRight: number;
} {
  const leftLines = typeof left === "string" ? left.split("\n") : [];
  const rightLines = typeof right === "string" ? right.split("\n") : [];
  const mark = (lines: string[], other: Set<string>) =>
    lines.map((text, index) => ({ key: `${index}`, text, changed: text.trim() !== "" && !other.has(text) }));
  const leftRows = mark(leftLines, new Set(rightLines));
  const rightRows = mark(rightLines, new Set(leftLines));
  return {
    left: leftRows,
    right: rightRows,
    changedLeft: leftRows.filter((line) => line.changed).length,
    changedRight: rightRows.filter((line) => line.changed).length,
  };
}

// ---- 수동 편집(F3)

/**
 * 편집 중인 판. 기준 판 본문을 복사해 시작하고, 저장하면 새 판(사용자 판)이 됩니다. usedIds는 새 번호가 넘어야 할 id — 기준 판에 있던
 * 원칙·규칙 id와, 서버가 알려 준 모든 판의 가장 큰 번호(maxIdNumbers를 "P7"·"E2-R5" 꼴로)입니다. 새 원칙·규칙의 번호가 지운 id를 다시
 * 쓰지 않게 합니다(같은 id가 판마다 다른 글이면 addedIn·근거 메모 이력을 읽기 어려움). 기준 판만 보면 그 전 판에서 지운 id를 다시
 * 씁니다(FW-2).
 */
export interface FrameworkDraft {
  baseVersion: number | null;
  baseStatus: string | null;
  schemaVersion: number;
  title: string;
  principles: PaperFrameworkPrinciple[];
  engines: PaperFrameworkEngine[];
  guidance: string;
  changelog: string;
  usedIds: string[];
}

/** 편집 동작 하나 — 엔진은 8개로 고정이라(F1) 엔진 추가·삭제는 없습니다. */
export type FrameworkDraftEdit =
  | { type: "title"; value: string }
  | { type: "principle"; index: number; text: string }
  | { type: "addPrinciple" }
  | { type: "removePrinciple"; index: number }
  | { type: "engineName"; engine: number; value: string }
  | { type: "rule"; engine: number; index: number; text: string }
  | { type: "addRule"; engine: number }
  | { type: "removeRule"; engine: number; index: number }
  | { type: "guidance"; value: string }
  | { type: "changelog"; value: string };

const stringOf = (value: unknown): string => (typeof value === "string" ? value : "");

/** 판 본문의 원칙·엔진을 편집할 수 있는 모양으로 — 모양이 다른 줄은 빈 글자로(서버가 저장할 때 다시 검사). */
function bodyParts(body: Record<string, unknown> | null) {
  const principles = listOf(body?.principles).filter(isRecord).map((entry) => ({ id: stringOf(entry.id), text: stringOf(entry.text) }));
  const engines = listOf(body?.engines).filter(isRecord).map((engine) => ({
    id: stringOf(engine.id),
    name: stringOf(engine.name),
    rules: listOf(engine.rules).filter(isRecord).map((rule) => ({
      id: stringOf(rule.id),
      text: stringOf(rule.text),
      addedIn: numberOf(rule.addedIn),
      sourceNoteId: numberOf(rule.sourceNoteId),
    })),
  }));
  return { principles, engines, guidance: stringOf(body?.guidance) };
}

/** 서버의 maxIdNumbers를 id 꼴로 — {principles:7, rules:{E2:5}} → ["P7", "E2-R5"]. 모르는 값·0은 뺍니다. */
function maxIdsAsIds(maxIds: PaperFrameworkMaxIds | null | undefined): string[] {
  if (!isRecord(maxIds)) return [];
  const out: string[] = [];
  const principles = numberOf(maxIds.principles);
  if (principles !== null && principles > 0 && Number.isInteger(principles)) out.push(`P${principles}`);
  const rules = isRecord(maxIds.rules) ? maxIds.rules : {};
  for (const [engine, value] of Object.entries(rules)) {
    const number = numberOf(value);
    if (number !== null && number > 0 && Number.isInteger(number) && /^E\d+$/.test(engine)) out.push(`${engine}-R${number}`);
  }
  return out;
}

/**
 * 지금 판에서 편집을 시작합니다. 본문이 없으면(모양이 다름) null — 화면은 편집 버튼을 막습니다. maxIds는 판 응답의 maxIdNumbers(모든
 * 판에서 쓴 가장 큰 번호) — 새 번호를 그보다 크게 매깁니다.
 */
export function frameworkDraftFrom(
  current: PaperFrameworkVersion | null | undefined,
  maxIds: PaperFrameworkMaxIds | null = null,
): FrameworkDraft | null {
  if (!current || !isRecord(current.body)) return null;
  const body = current.body as unknown as Record<string, unknown>;
  const parts = bodyParts(body);
  return {
    baseVersion: numberOf(current.version),
    baseStatus: textOf(current.status) ?? textOf(body.status),
    schemaVersion: numberOf(body.schemaVersion) ?? 1,
    title: textOf(body.title) ?? textOf(current.title) ?? "",
    ...parts,
    changelog: "",
    usedIds: [
      ...parts.principles.map((entry) => entry.id),
      ...parts.engines.flatMap((engine) => engine.rules.map((rule) => rule.id)),
      ...maxIdsAsIds(maxIds),
    ],
  };
}

/** prefix 뒤 번호의 최댓값(예: "E2-R" → E2-R3이면 3). 없으면 0. */
function maxSuffix(ids: readonly string[], prefix: string): number {
  return ids.reduce((max, id) => {
    if (!id.startsWith(prefix)) return max;
    const rest = id.slice(prefix.length);
    return /^\d+$/.test(rest) ? Math.max(max, Number(rest)) : max;
  }, 0);
}

/**
 * 편집 동작을 적용한 새 판(불변 — 원래 객체는 그대로). 새 원칙은 "P{다음 번호}", 새 규칙은 "{엔진}-R{다음 번호}"(지금 편집본과 기준 판의
 * id 모두에서 다음 번호)입니다. 새 규칙의 addedIn은 비워 보냅니다(null) — 판 번호는 저장할 때 서버가 정하고, 비운 addedIn을 그 새 판
 * 번호로 채웁니다(화면이 "기준 판 + 1"을 짐작해 넣지 않음).
 */
export function editFrameworkDraft(draft: FrameworkDraft, edit: FrameworkDraftEdit): FrameworkDraft {
  const engineAt = (index: number, change: (engine: PaperFrameworkEngine) => PaperFrameworkEngine) =>
    draft.engines.map((engine, position) => (position === index ? change(engine) : engine));
  switch (edit.type) {
    case "title":
      return { ...draft, title: edit.value };
    case "guidance":
      return { ...draft, guidance: edit.value };
    case "changelog":
      return { ...draft, changelog: edit.value };
    case "principle":
      return {
        ...draft,
        principles: draft.principles.map((entry, index) => (index === edit.index ? { ...entry, text: edit.text } : entry)),
      };
    case "addPrinciple": {
      const ids = [...draft.usedIds, ...draft.principles.map((entry) => entry.id)];
      return { ...draft, principles: [...draft.principles, { id: `P${maxSuffix(ids, "P") + 1}`, text: "" }] };
    }
    case "removePrinciple":
      return { ...draft, principles: draft.principles.filter((_, index) => index !== edit.index) };
    case "engineName":
      return { ...draft, engines: engineAt(edit.engine, (engine) => ({ ...engine, name: edit.value })) };
    case "rule":
      return {
        ...draft,
        engines: engineAt(edit.engine, (engine) => ({
          ...engine,
          rules: engine.rules.map((rule, index) => (index === edit.index ? { ...rule, text: edit.text } : rule)),
        })),
      };
    case "addRule":
      return {
        ...draft,
        engines: engineAt(edit.engine, (engine) => {
          const prefix = `${engine.id}-R`;
          const ids = [...draft.usedIds, ...engine.rules.map((rule) => rule.id)];
          return {
            ...engine,
            rules: [...engine.rules, { id: `${prefix}${maxSuffix(ids, prefix) + 1}`, text: "", addedIn: null, sourceNoteId: null }],
          };
        }),
      };
    case "removeRule":
      return {
        ...draft,
        engines: engineAt(edit.engine, (engine) => ({ ...engine, rules: engine.rules.filter((_, index) => index !== edit.index) })),
      };
    default:
      return draft;
  }
}

/** 저장할 본문의 내용 부분(비교용) — 앞뒤 공백을 뗀 값. */
function draftContent(draft: Pick<FrameworkDraft, "title" | "principles" | "engines" | "guidance">) {
  return {
    title: draft.title.trim(),
    principles: draft.principles.map((entry) => ({ id: entry.id, text: entry.text.trim() })),
    engines: draft.engines.map((engine) => ({
      id: engine.id,
      name: engine.name.trim(),
      rules: engine.rules.map((rule) => ({ id: rule.id, text: rule.text.trim(), addedIn: rule.addedIn, sourceNoteId: rule.sourceNoteId })),
    })),
    guidance: draft.guidance.trim(),
  };
}

/** 편집본 검사 결과 — 저장을 막는 사유(서버 검사와 같은 항목)와 바뀐 것이 있는지. */
export interface FrameworkDraftCheck {
  errors: string[];
  /** 기준 판과 내용이 다르거나, 기준 판이 사용자 판이 아닌가(임시 판을 그대로 사용자 판으로 확정하는 저장도 새 판). */
  changed: boolean;
  canSave: boolean;
}

/**
 * 저장 전 검사 — 제목·원칙·엔진 이름·규칙이 비었는지, 300자·지침 2,000자를 넘는지, 엔진이 8개인지, id가 겹치는지, 바꾼 내용(changelog)을
 * 적었는지. 서버가 같은 검사를 다시 하고(틀리면 400 문구를 그대로 보임), 화면은 저장 버튼을 막고 이유를 보이려고만 씁니다.
 */
export function frameworkDraftCheck(draft: FrameworkDraft, current: PaperFrameworkVersion | null | undefined): FrameworkDraftCheck {
  const errors: string[] = [];
  const content = draftContent(draft);
  if (!content.title) errors.push("제목을 넣으세요.");
  if (content.engines.length !== FRAMEWORK_ENGINE_COUNT) {
    errors.push(`엔진은 ${FRAMEWORK_ENGINE_COUNT}개여야 합니다(지금 ${content.engines.length}개).`);
  }
  if (content.principles.length === 0) errors.push("원칙이 하나도 없습니다.");
  for (const entry of content.principles) {
    if (!entry.text) errors.push(`원칙 ${entry.id}: 본문이 비었습니다.`);
    else if (textLength(entry.text) > FRAMEWORK_TEXT_LIMIT) {
      errors.push(`원칙 ${entry.id}: ${FRAMEWORK_TEXT_LIMIT}자를 넘습니다(${textLength(entry.text)}자).`);
    }
  }
  for (const engine of content.engines) {
    if (!engine.name) errors.push(`엔진 ${engine.id}: 이름이 비었습니다.`);
    for (const rule of engine.rules) {
      if (!rule.text) errors.push(`규칙 ${rule.id}: 본문이 비었습니다.`);
      else if (textLength(rule.text) > FRAMEWORK_TEXT_LIMIT) {
        errors.push(`규칙 ${rule.id}: ${FRAMEWORK_TEXT_LIMIT}자를 넘습니다(${textLength(rule.text)}자).`);
      }
    }
  }
  if (textLength(content.guidance) > FRAMEWORK_GUIDANCE_LIMIT) {
    errors.push(`지침이 ${formatNumber(FRAMEWORK_GUIDANCE_LIMIT, 0)}자를 넘습니다(${formatNumber(textLength(content.guidance), 0)}자).`);
  }
  const ids = [...content.principles.map((entry) => entry.id), ...content.engines.flatMap((engine) => [engine.id, ...engine.rules.map((rule) => rule.id)])];
  const duplicated = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicated.length > 0) errors.push(`id가 겹칩니다: ${duplicated.join(", ")}`);
  if (!draft.changelog.trim()) errors.push("바꾼 내용(changelog)을 적으세요 — 판 목록에 남습니다.");

  const base = current && isRecord(current.body) ? bodyParts(current.body as unknown as Record<string, unknown>) : null;
  const baseTitle = current && isRecord(current.body) ? textOf((current.body as unknown as Record<string, unknown>).title) ?? "" : "";
  const sameContent = base !== null
    && JSON.stringify(content) === JSON.stringify(draftContent({ title: baseTitle, ...base }));
  const changed = !sameContent || draft.baseStatus !== "USER";
  if (!changed) errors.push("기준 판과 바뀐 내용이 없습니다.");
  return { errors, changed, canSave: errors.length === 0 };
}

/**
 * 저장 본문 `{body, changelog, baseVersion}` — 수동 편집으로 저장한 판은 사용자 판(status USER, 보충 계약 §1 — OS 원문을 옮긴 판이
 * v1)입니다. 글은 앞뒤 공백을 뗍니다(렌더링이 끝 공백을 남기지 않음 — 같은 글이 공백 하나로 다른 판이 되지 않게). baseVersion은 편집을
 * 시작한 판 — 서버가 지금 판과 대조해 다르면 400으로 막습니다(FW-1). 화면의 "판이 바뀌었습니다" 검사는 이 화면이 읽은 판만 보므로, 다른
 * 창·탭에서 승인해 생긴 판은 서버만 압니다.
 */
export function frameworkSavePayload(
  draft: FrameworkDraft,
): { body: Record<string, unknown>; changelog: string; baseVersion: number | null } {
  const content = draftContent(draft);
  return {
    body: {
      schemaVersion: draft.schemaVersion,
      title: content.title,
      status: "USER",
      principles: content.principles,
      engines: content.engines,
      guidance: content.guidance,
    },
    changelog: draft.changelog.trim(),
    baseVersion: draft.baseVersion,
  };
}

/** 수동 편집 저장 결과 — 배너 색과 한 줄, 서버 경고(렌더링 예산 초과 — 저장은 함, F4). */
export function frameworkSaveResultView(
  result: PaperFrameworkSaveResult,
): { tone: "warn" | "info"; text: string; warning: string | null } {
  if (result.ok === false) return { tone: "warn", text: result.message ?? "판을 저장하지 못했습니다.", warning: null };
  const version = isNumber(result.version) ? `v${result.version}` : EMPTY;
  return {
    tone: "info",
    text: `새 판 ${version}(사용자 판)을 저장했습니다 — 다음 Claude 결정부터 이 판으로 판단합니다(규칙 계좌는 프레임을 쓰지 않음).`,
    warning: textOf(result.warning),
  };
}

// ---- 제안 → 승인(F2·F7)

/**
 * 제안 요청의 비용 안내 — 기본 모델(Sonnet 5.5) 한 번. 입력은 붙인 글과 지금 판 렌더링이라 글 길이에 따라 다르고, 화면이 단가로 다시
 * 계산하지 않아 결정 1회 어림(설계 §5-9 약 $0.1)과 같은 규모라고만 적습니다. 결정·미리보기와 같은 하루 상한을 씁니다(F7).
 */
export const PROPOSAL_COST_NOTE = "Sonnet 5.5 호출 1회 — 기본 모델 기준(설정 탭에서 모델을 바꿨으면 그 모델). 비용은 붙인 글 길이에 따라 "
  + "다르고 결정 1회(약 $0.1)와 같은 규모로 어림합니다. 하루 호출 상한(설정 apiDailyCallCap)을 결정·미리보기와 함께 씁니다.";

/** 승인·거절은 Claude를 부르지 않습니다. */
export const APPROVE_COST_NOTE = "승인·거절은 Claude를 부르지 않습니다(비용 없음) — 서버가 제안의 변경을 지금 판에 적용할 뿐입니다.";

const PROPOSAL_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  PENDING: { label: "승인 대기", tone: "info" },
  APPROVED: { label: "승인", tone: "ok" },
  REJECTED: { label: "거절", tone: "muted" },
  FAILED: { label: "실패", tone: "warn" },
};

/** 제안 상태 배지. 모르는 상태는 받은 글자 그대로. */
export function proposalStatusBadge(status: string | null | undefined): Badge {
  const known = status ? PROPOSAL_STATUS[status] : undefined;
  return { key: `proposal-${status ?? "unknown"}`, label: known?.label ?? status ?? EMPTY, className: TONE[known?.tone ?? "muted"] };
}

/** OS 절차 B 평가의 색 — 일치는 그대로, 보완은 더할 것, 수정 필요·모순은 고칠 것. */
const VERDICT: Record<string, BadgeTone> = { 일치: "ok", 보완: "info", "수정 필요": "warn", 모순: "warn" };

export function verdictBadge(verdict: unknown): Badge {
  const label = textOf(verdict) ?? EMPTY;
  return { key: `verdict-${label}`, label, className: TONE[VERDICT[label] ?? "muted"] };
}

const PROPOSAL_OP: Record<string, string> = {
  ADD_RULE: "규칙 추가",
  UPDATE_RULE: "규칙 수정",
  DELETE_RULE: "규칙 삭제",
  ADD_PRINCIPLE: "원칙 추가",
  UPDATE_PRINCIPLE: "원칙 수정",
  DELETE_PRINCIPLE: "원칙 삭제",
};

export const proposalOpLabel = (op: string | null | undefined) => labelOf(PROPOSAL_OP, op);

/** 평가 표 한 줄. */
export interface ProposalAssessmentRow {
  key: string;
  point: string;
  verdict: Badge;
  reason: string;
}

/** 변경 표 한 줄 — 지금 판의 글(before)과 바꿀 글(after). */
export interface ProposalOperationRow {
  key: string;
  op: string;
  target: string;
  before: string;
  after: string;
  why: string;
  /** 승인하면 서버가 거절할 모양(대상 없음·본문 없음·300자 초과). 없으면 null. */
  warning: string | null;
}

/** 제안 한 건을 그릴 모양. */
export interface ProposalView {
  id: number;
  title: string;
  status: Badge;
  /** 승인·거절할 수 있는가(대기 중). */
  pending: boolean;
  /**
   * 승인 버튼을 열어도 되는가 — 대기 중이고, 변경이 하나 이상이고, 기준 판이 지금 판과 같을 때만. 변경 0건(평가만 있는 제안)은 서버가 늘
   * 400으로 거절하므로("거절로 닫으세요") 버튼을 막습니다(FW-3·F2).
   */
  approvable: boolean;
  meta: DecisionMetaCell[];
  summary: string | null;
  assessment: ProposalAssessmentRow[];
  operations: ProposalOperationRow[];
  /** 변경 표의 설명 — 대기 중이면 "승인하면 …", 결정된 제안이면 그 결과(승인·거절·실패). */
  operationsNote: string;
  /** 변경 표의 '글' 칸 머리 — 대기 중이면 "지금 글", 결정된 제안이면 기준 판의 글("기준 판 글(v0)"). */
  beforeHeader: string;
  /** 변경이 없을 때 표의 문구. */
  emptyMessage: string;
  beforeAfter: string | null;
  error: string | null;
  /** 기준 판이 지금 판과 다르면 그 안내(승인하면 서버가 거절 — 다시 제안). 같거나 모르면 null. */
  staleBase: string | null;
  confirmApprove: string;
  confirmReject: string;
}

/**
 * 결정된(승인·거절·실패) 제안의 변경 표를 대조할 기준 판 번호 — 지금 판이 아니면 그 판을 따로 읽어야 합니다(GET …/versions/{v}). 대기 중인
 * 제안·기준 판이 지금 판·기준 판을 모르면 null(읽지 않음).
 */
export function proposalBaseToFetch(
  proposal: Pick<PaperFrameworkProposal, "status" | "baseVersion">,
  current: PaperFrameworkVersion | null | undefined,
): number | null {
  const base = numberOf(proposal.baseVersion);
  if (textOf(proposal.status) === "PENDING" || base === null) return null;
  return isNumber(current?.version) && current.version === base ? null : base;
}

/** 지금 판 본문에서 원칙·규칙·엔진 찾기(제안 변경의 '지금 글' 칸). */
function frameworkLookup(body: unknown) {
  const parts = bodyParts(isRecord(body) ? body : null);
  return {
    principle: (id: string) => parts.principles.find((entry) => entry.id === id) ?? null,
    rule: (id: string) => parts.engines.flatMap((engine) => engine.rules).find((rule) => rule.id === id) ?? null,
    engine: (id: string) => parts.engines.find((engine) => engine.id === id) ?? null,
  };
}

/**
 * 제안 한 건 — 평가(OS 절차 B)·변경·전후 비교는 Claude 응답 그대로, 변경마다 대조할 판의 글을 옆에 붙입니다(대상 id로 찾기만 하고
 * 적용하지 않음 — 적용은 승인할 때 서버가 함).
 *
 * 대기 중인 제안은 지금 판과 대조합니다. 대상이 지금 판에 없거나 새 본문이 없거나 300자를 넘으면 그 줄에 경고를 붙이고(승인하면 서버가
 * 400으로 거절하고 아무것도 바꾸지 않음), 기준 판이 지금 판과 다르면 승인할 수 없다고 적습니다(다른 판이 먼저 승인됨). 변경이 0건이면
 * 승인할 수 없다고 적습니다(서버가 거절 — 거절로 닫음).
 *
 * 결정된 제안(승인·거절·실패)은 <b>기준 판</b>(baseFrame — 화면이 GET …/versions/{기준 판}으로 읽은 것, 기준 판이 지금 판이면 지금 판)과
 * 대조하고 경고·"승인하면 …" 문구를 붙이지 않습니다. 지금 판과 대조하면 승인해 지운 대상에 "승인하면 서버가 거절합니다"가 붙고, 고친 글은
 * '지금 글'과 '바꿀 글'이 같아 보입니다(FW-4). 기준 판을 아직 못 읽었으면 그 칸은 "—"입니다.
 */
export function proposalView(
  proposal: PaperFrameworkProposal,
  current: PaperFrameworkVersion | null | undefined,
  baseFrame: PaperFrameworkVersion | null = null,
): ProposalView {
  const status = textOf(proposal.status);
  const pending = status === "PENDING";
  const currentVersion = isNumber(current?.version) ? current.version : null;
  const currentStatus = textOf(current?.status);
  const base = numberOf(proposal.baseVersion);
  const reference = pending
    ? current
    : base !== null && isNumber(baseFrame?.version) && baseFrame.version === base
      ? baseFrame
      : base !== null && currentVersion === base
        ? current
        : null;
  const lookup = frameworkLookup(reference?.body);

  const meta: DecisionMetaCell[] = [
    { key: "createdAt", label: "요청 시각", value: formatKst(textOf(proposal.createdAtKst)) },
  ];
  if (proposal.decidedAtKst) meta.push({ key: "decidedAt", label: "승인·거절 시각", value: formatKst(proposal.decidedAtKst) });
  if (proposal.model) meta.push({ key: "model", label: "모델", value: proposal.model });
  if (isNumber(proposal.noteId)) meta.push({ key: "noteId", label: "근거 메모", value: `#${proposal.noteId}` });
  // 주간 복기가 낸 제안 — 근거는 메모가 아니라 그 주 복기(결정 로그 탭의 주간 복기)입니다.
  if (textOf(proposal.reviewWeekEnding)) {
    meta.push({ key: "review", label: "근거", value: `주간 복기 ${proposal.reviewWeekEnding}` });
  }
  meta.push({ key: "baseVersion", label: "기준 판", value: base === null ? EMPTY : `v${base}` });
  if (isNumber(proposal.resultVersion)) meta.push({ key: "resultVersion", label: "만든 판", value: `v${proposal.resultVersion}` });

  const assessment = listOf(proposal.assessment).filter(isRecord).map((entry, index) => ({
    key: `${index}`,
    point: textOf(entry.point) ?? EMPTY,
    verdict: verdictBadge(entry.verdict),
    reason: textOf(entry.reason) ?? EMPTY,
  }));

  const operations = listOf(proposal.operations).filter(isRecord).map((entry, index) => {
    const op = textOf(entry.op) ?? "";
    const target = textOf(entry.target) ?? "";
    const text = textOf(entry.text);
    const deleting = op === "DELETE_RULE" || op === "DELETE_PRINCIPLE";
    let before: string = EMPTY;
    let missing = false;
    if (op === "ADD_RULE") {
      const engine = lookup.engine(target);
      before = engine ? `${engine.id}. ${engine.name} — 새 규칙` : EMPTY;
      missing = engine === null;
    } else if (op === "UPDATE_RULE" || op === "DELETE_RULE") {
      const rule = lookup.rule(target);
      before = rule?.text || EMPTY;
      missing = rule === null;
    } else if (op === "UPDATE_PRINCIPLE" || op === "DELETE_PRINCIPLE") {
      const principle = lookup.principle(target);
      before = principle?.text || EMPTY;
      missing = principle === null;
    } else if (op === "ADD_PRINCIPLE") {
      before = "(새 원칙)";
    }
    // 경고는 승인 전 안내라 대기 중인 제안에만 — 결정된 제안에 "승인하면 서버가 거절합니다"는 사실이 아닙니다.
    const warnings = !pending ? [] : [
      // 지금 판 본문을 모르면(읽기 실패) 대상이 없다고 단정하지 않습니다.
      missing && current?.body ? "지금 판에 대상이 없습니다" : null,
      !deleting && !text ? "새 본문이 없습니다" : null,
      text && textLength(text) > FRAMEWORK_TEXT_LIMIT ? `${FRAMEWORK_TEXT_LIMIT}자를 넘습니다(${textLength(text)}자)` : null,
    ].filter((warning): warning is string => warning !== null);
    return {
      key: `${index}`,
      op: proposalOpLabel(op || null),
      target: op === "ADD_PRINCIPLE" ? "(새 번호)" : target || EMPTY,
      before,
      after: deleting ? "(삭제)" : text ?? EMPTY,
      why: textOf(entry.why) ?? EMPTY,
      warning: warnings.length > 0 ? `${warnings.join(" · ")} — 승인하면 서버가 거절합니다(아무것도 바꾸지 않음).` : null,
    };
  });

  const staleBase = pending && base !== null && currentVersion !== null && base !== currentVersion
    ? `이 제안의 기준 판(v${base})이 지금 판(${frameworkVersionLabel(currentVersion, currentStatus)})과 다릅니다 — 다른 판이 먼저 생겼습니다. `
      + "승인하면 서버가 거절하니 다시 제안하세요."
    : null;
  const currentName = currentVersion === null ? "지금 판" : `지금 판(${frameworkVersionLabel(currentVersion, currentStatus)})`;
  const inherit = currentStatus === "INTERIM"
    ? " 새 판은 기준 판의 상태(임시)를 이어받습니다 — 사용자 판으로 확정하려면 승인 뒤 '직접 고치기'에서 저장하세요."
    : "";
  const baseName = base === null ? "기준 판" : `기준 판(v${base})`;
  const result = numberOf(proposal.resultVersion);
  const operationsNote = pending
    ? "승인하면 서버가 이 변경을 지금 판에 적용해 새 판을 만듭니다. 지금 글은 지금 판에서 찾은 것입니다."
    : `${status === "APPROVED"
      ? `승인한 제안입니다 — 이 변경을 ${baseName}에 적용해 ${result === null ? "새 판" : `v${result}`}을 만들었습니다.`
      : status === "REJECTED"
        ? "거절한 제안입니다 — 판에 적용하지 않았습니다."
        : "실패한 제안입니다 — 판에 적용하지 않았고 승인할 수 없습니다."} 왼쪽 글은 ${baseName}의 글입니다`
      + (reference ? "." : " — 그 판을 아직 읽지 못해 비어 있습니다(—).");
  return {
    id: proposal.id,
    title: `제안 #${proposal.id}`,
    status: proposalStatusBadge(status),
    pending,
    approvable: pending && operations.length > 0 && staleBase === null,
    meta,
    summary: textOf(proposal.summary),
    assessment,
    operations,
    operationsNote,
    beforeHeader: pending ? "지금 글" : base === null ? "기준 판 글" : `기준 판 글(v${base})`,
    emptyMessage: pending
      ? "평가만 있는 제안입니다 — 바꿀 것이 없어 승인할 수 없습니다(서버가 새 판을 만들지 않음). 거절로 닫으세요."
      : "변경이 없는 제안입니다.",
    beforeAfter: textOf(proposal.beforeAfter),
    error: textOf(proposal.error),
    staleBase,
    confirmApprove: `이 제안(#${proposal.id})을 승인할까요? 변경 ${formatNumber(operations.length, 0)}건을 ${currentName}에 적용해 새 판을 `
      + `만들고, 다음 Claude 결정부터 새 판으로 판단합니다. ${APPROVE_COST_NOTE}${inherit}`,
    confirmReject: `이 제안(#${proposal.id})을 거절할까요? 판은 바뀌지 않고 제안은 거절로 남습니다. ${APPROVE_COST_NOTE}`,
  };
}

/** 제안 요청 결과 — 실패(FAILED 행)는 경고색과 서버 사유, 대기 제안은 승인·거절 안내. */
export function proposeResultView(result: PaperProposeResult): { tone: "warn" | "info"; text: string } {
  // 실패한 호출도 FAILED 행으로 남아 ok:false와 함께 그 행이 옵니다 — 행이 있으면 행의 사유를, 없으면 서버 문구를 씁니다.
  const proposal = result.proposal ?? null;
  if (!proposal) {
    return { tone: "warn", text: result.message ?? (result.ok === false ? "제안을 받지 못했습니다." : "제안 기록을 받지 못했습니다.") };
  }
  if (proposal.status === "FAILED" || result.ok === false) {
    return {
      tone: "warn",
      text: `제안 요청이 실패했습니다(#${proposal.id}) — ${proposal.error ?? "서버가 사유를 남기지 않았습니다"}. 판은 바뀌지 않았습니다. `
        + "다시 요청하면 Claude를 한 번 더 부릅니다.",
    };
  }
  return {
    tone: "info",
    text: `제안(#${proposal.id})을 받았습니다 — 평가와 변경을 보고 승인하거나 거절하세요. 자동 반영은 없습니다(승인해야 새 판).`,
  };
}

/** 승인 결과 — 새 판 번호와 서버 경고(새 판 렌더링이 예산을 넘음 — 승인은 함, F4. 수동 편집 저장과 같은 문구). */
export function approveResultView(
  result: PaperProposalApproveResult,
): { tone: "warn" | "info"; text: string; warning: string | null } {
  if (result.ok === false) return { tone: "warn", text: result.message ?? "승인하지 못했습니다.", warning: null };
  const version = isNumber(result.version) ? `v${result.version}` : EMPTY;
  return {
    tone: "info",
    text: `승인했습니다 — 새 판 ${version}. 다음 Claude 결정부터 이 판으로 판단합니다.`,
    warning: textOf(result.warning),
  };
}

/** 거절 결과. */
export function rejectResultView(result: PaperOkResult): { tone: "warn" | "info"; text: string } {
  if (result.ok === false) return { tone: "warn", text: result.message ?? "거절하지 못했습니다." };
  return { tone: "info", text: "거절했습니다 — 판은 그대로입니다." };
}

/**
 * 글을 방법론 메모로 저장할 본문 — 제목을 비우면 defaultTitle(카드가 정함: 임시 판이면 "투자 OS 원문", 사용자 판이면 "방법론 글").
 * 사용자 판 뒤에 붙이는 글을 "투자 OS 원문"으로 채우면 진짜 원문 메모와 목록에서 구분되지 않습니다(F1).
 */
export function insightNotePayload(
  title: string,
  body: string,
  defaultTitle = "투자 OS 원문",
): { kind: "INSIGHT"; title: string; body: string } {
  return { kind: "INSIGHT", title: title.trim() || defaultTitle, body: body.trim() };
}

/** 제안 요청 카드의 문구 — 지금 판이 임시인가(OS 원문을 옮길 차례) 사용자 판인가(방법론 글로 갱신)에 따라. */
export interface FrameworkSourceCardView {
  title: string;
  subtitle: string;
  /** 제목을 비웠을 때 메모 제목. */
  defaultTitle: string;
  /** 글 칸 이름. */
  bodyLabel: string;
  intro: string;
}

/**
 * 제안 요청 카드(F1·F2). 임시 판(또는 판을 모름)이면 "OS 원문으로 새 판 만들기" — 원문을 붙여 메모로 저장해 제안을 받습니다. 사용자 판
 * (OS 원문을 옮긴 v1 뒤)이면 "방법론 글로 갱신 제안 받기" — 같은 OS 원문을 다시 붙이면 그 원문을 옮긴 판과 대조하게 되어 바꿀 것이 없다는
 * 답이 나오기 쉽습니다. 두 경우 모두 이미 있는 방법론 메모(OS 원문 메모 포함)를 골라 제안을 받을 수 있습니다(글을 다시 붙이지 않게).
 */
export function frameworkSourceCardView(status: string | null | undefined): FrameworkSourceCardView {
  const pick = "이미 있는 방법론 메모(메모 탭에서 쓴 글·OS 원문 메모)를 골라 바로 제안을 받을 수도 있습니다 — 같은 글의 메모를 또 만들지 않습니다.";
  if (status === "USER") {
    return {
      title: "방법론 글로 갱신 제안 받기",
      subtitle: "① 방법론 글 붙여넣기(또는 있는 메모 고르기) → ② 방법론 메모(INSIGHT)로 저장 → ③ Claude 제안 요청 → ④ 제안을 보고 승인(새 판)",
      defaultTitle: "방법론 글",
      bodyLabel: "방법론 글",
      intro: "지금 판은 사용자 판입니다 — 남의 방법론 글·새로 정리한 원칙을 붙이면 Claude가 글의 주장을 하나씩 지금 판과 대조해 [일치·보완·"
        + "수정 필요·모순]으로 평가하고, 필요한 원칙·규칙 추가·수정·삭제와 전후 비교만 냅니다. 자동 반영은 없습니다. OS 원문은 이미 판에 옮겼으니 "
        + `다시 붙일 필요가 없습니다. ${pick}`,
    };
  }
  return {
    title: "OS 원문으로 새 판 만들기",
    subtitle: "① 원문 붙여넣기(또는 있는 메모 고르기) → ② 방법론 메모(INSIGHT)로 저장 → ③ Claude 제안 요청 → ④ 제안을 보고 승인(새 판)",
    defaultTitle: "투자 OS 원문",
    bodyLabel: "OS 원문",
    intro: "원문은 메모에만 둡니다 — 프레임에는 승인한 원칙·규칙만 들어갑니다(규칙 300자, 렌더링 약 8,000토큰 예산). Claude는 원문의 주장을 하나씩 "
      + "지금 판과 대조해 [일치·보완·수정 필요·모순]으로 평가하고, 필요한 원칙·규칙 추가·수정·삭제와 전후 비교만 냅니다. 자동 반영은 없습니다. "
      + "제안을 승인한 판은 기준 판의 상태를 이어받아 임시로 남습니다 — 사용자 판(v1)은 아래 '직접 고치기'로 원칙·규칙을 옮겨 저장하면 됩니다. "
      + pick,
  };
}

/** 제안에 쓸 수 있는 방법론 메모(보관 안 한 INSIGHT, 서버 순서 그대로)를 고르기 목록으로. 서버가 보관 메모를 거절하므로 빼고 보입니다. */
export function insightNoteOptions(notes: readonly PaperNote[] | null | undefined): { value: string; label: string }[] {
  return listOf(notes).filter(isRecord).flatMap((note) => {
    const id = numberOf(note.id);
    if (id === null || note.kind !== "INSIGHT" || note.archived === true) return [];
    const body = stringOf(note.body);
    return [{ value: String(id), label: `#${id} ${textOf(note.title) ?? EMPTY} (${formatNumber(textLength(body), 0)}자)` }];
  });
}

// ---- 시황·방법론 메모(F6·D14)

const NOTE_KIND: Record<string, { label: string; tone: BadgeTone; title: string }> = {
  MARKET: { label: "시황", tone: "info", title: "시황 메모 — 기준일~만료일 사이 Claude 결정 패킷(섹션 11)에 자료로 실립니다." },
  INSIGHT: { label: "방법론", tone: "muted", title: "방법론 메모(INSIGHT) — 결정 패킷에 싣지 않고 프레임 제안에만 씁니다." },
};

/** 메모 종류 배지. 모르는 종류는 받은 글자 그대로. */
export function noteKindBadge(kind: string | null | undefined): Badge {
  const known = kind ? NOTE_KIND[kind] : undefined;
  return { key: `note-kind-${kind ?? "unknown"}`, label: known?.label ?? kind ?? EMPTY, className: TONE[known?.tone ?? "muted"], title: known?.title };
}

/**
 * 메모 상태 배지 — 보관 · 프레임 제안용(방법론) · 유효(패킷에 실음) · 패킷 밖(만료·기준일 전). 유효한지는 서버 판정(active)이고 화면이 날짜를
 * 다시 비교하지 않습니다. 유효해도 패킷에는 최신부터 합계 글자 수 상한(설정 notesMaxCharsInPacket)까지만 실립니다.
 */
export function noteStateBadge(note: { kind?: unknown; archived?: unknown; active?: unknown }): Badge {
  if (note.archived === true) {
    return { key: "note-archived", label: "보관", className: TONE.muted, title: "지우지 않고 보관했습니다 — 패킷에 싣지 않습니다." };
  }
  if (note.kind === "INSIGHT") {
    return { key: "note-insight", label: "프레임 제안용", className: TONE.muted, title: NOTE_KIND.INSIGHT.title };
  }
  if (note.active === true) {
    return {
      key: "note-active", label: "유효 — 패킷에 실음", className: TONE.ok,
      title: "기준일~만료일 안이라 다음 Claude 결정 패킷에 자료로 실립니다(최신부터 합계 글자 수 상한 — 설정 notesMaxCharsInPacket — 까지).",
    };
  }
  return { key: "note-inactive", label: "패킷 밖 — 만료·기준일 전", className: TONE.muted };
}

/** 메모 목록 한 줄(표시 문자열). */
export interface NoteRow {
  key: string;
  id: number;
  idText: string;
  kind: Badge;
  state: Badge;
  asOf: string;
  expires: string;
  title: string;
  body: string;
  /** "1,234자". */
  length: string;
  createdAt: string;
  archived: boolean;
}

/** 메모 목록(서버 순서 그대로)을 표 줄로. 방법론 메모는 만료가 없습니다. 번호가 없는 줄은 뺍니다(보관할 수 없음). */
export function noteRows(notes: unknown): NoteRow[] {
  return listOf(notes).filter(isRecord).flatMap((note, index) => {
    const id = numberOf(note.id);
    if (id === null) return [];
    const body = stringOf(note.body);
    return [{
      key: `${index}-${id}`,
      id,
      idText: `#${id}`,
      kind: noteKindBadge(textOf(note.kind)),
      state: noteStateBadge(note),
      asOf: textOf(note.asOfDate) ?? EMPTY,
      expires: note.kind === "INSIGHT" ? "만료 없음" : textOf(note.expiresOn) ?? EMPTY,
      title: textOf(note.title) ?? EMPTY,
      body,
      length: `${formatNumber(textLength(body), 0)}자`,
      createdAt: formatKst(textOf(note.createdAtKst)),
      archived: note.archived === true,
    }];
  });
}

/** 메모 쓰기 입력(날짜는 YYYY-MM-DD, 비우면 서버 기본값). */
export interface NoteDraft {
  kind: PaperNoteKind;
  asOfDate: string;
  expiresOn: string;
  title: string;
  body: string;
}

export const EMPTY_NOTE_DRAFT: NoteDraft = { kind: "MARKET", asOfDate: "", expiresOn: "", title: "", body: "" };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 메모 입력 검사 — 제목·본문이 있는지, 시황 메모 본문이 4,000자 이내인지, 날짜 형식(YYYY-MM-DD)과 만료일 ≥ 기준일. 서버가 다시 검사합니다.
 * 방법론 메모 본문은 화면이 한도를 두지 않습니다(계약의 4,000자는 시황 메모 — OS 원문은 더 길 수 있음; 서버 한도에 걸리면 그 400 문구를 보임).
 */
export function noteDraftCheck(draft: NoteDraft): { errors: string[]; canSave: boolean; bodyCount: { text: string; over: boolean } } {
  const errors: string[] = [];
  const market = draft.kind === "MARKET";
  const body = draft.body.trim();
  const bodyCount = market
    ? charCount(body, NOTE_MARKET_BODY_LIMIT)
    : { text: `${formatNumber(textLength(body), 0)}자`, over: false };
  if (!draft.title.trim()) errors.push("제목을 넣으세요.");
  if (!body) errors.push("본문을 넣으세요.");
  if (bodyCount.over) {
    errors.push(`시황 메모 본문은 ${formatNumber(NOTE_MARKET_BODY_LIMIT, 0)}자 이내입니다(지금 ${formatNumber(textLength(body), 0)}자).`);
  }
  const asOf = draft.asOfDate.trim();
  const expires = market ? draft.expiresOn.trim() : "";
  if (asOf && !DATE_PATTERN.test(asOf)) errors.push("기준일은 YYYY-MM-DD 형식입니다.");
  if (expires && !DATE_PATTERN.test(expires)) errors.push("만료일은 YYYY-MM-DD 형식입니다.");
  // ISO 날짜는 글자 순서가 날짜 순서입니다.
  if (asOf && expires && DATE_PATTERN.test(asOf) && DATE_PATTERN.test(expires) && expires < asOf) {
    errors.push("만료일이 기준일보다 이릅니다.");
  }
  return { errors, canSave: errors.length === 0, bodyCount };
}

/** 저장 본문 — 비운 날짜는 보내지 않습니다(서버 기본값). 방법론 메모는 만료일을 보내지 않습니다(만료 없음). */
export function notePayload(draft: NoteDraft): Record<string, unknown> {
  const payload: Record<string, unknown> = { kind: draft.kind, title: draft.title.trim(), body: draft.body.trim() };
  if (draft.asOfDate.trim()) payload.asOfDate = draft.asOfDate.trim();
  if (draft.kind === "MARKET" && draft.expiresOn.trim()) payload.expiresOn = draft.expiresOn.trim();
  return payload;
}

/**
 * 만료일 칸의 안내 — 비우면 기준일 + 설정 notesDefaultExpiryTradingDays 거래일(기본 3). 설정을 읽었으면 지금 값, 못 읽었으면 기본값이라고
 * 적습니다(지금 설정과 다를 수 있음).
 */
export function noteExpiryHint(settingsBody: unknown): string {
  const days = numberOf(settingValueAt(settingsBody, "notesDefaultExpiryTradingDays"));
  return days === null
    ? "비우면 기본 +3거래일(기준일부터 — 설정 notesDefaultExpiryTradingDays의 기본값)"
    : `비우면 기본 +${formatNumber(days, 0)}거래일(기준일부터 — 설정 notesDefaultExpiryTradingDays)`;
}

/** 메모 탭 머리의 설명 — 메모는 자료일 뿐 지시가 아니고, 시작(초기 결정) 패킷에는 출발일 이하 기준일 메모만 실립니다(PIT). */
export function notesIntro(startDate: string | null | undefined): string {
  return "시황 메모(MARKET)는 기준일~만료일 사이 Claude 결정 패킷(섹션 11)에 구분자로 감싼 자료로 실립니다 — 지시가 아니고, 메모의 숫자보다 "
    + "패킷의 숫자가 우선합니다. 유효한 메모는 최신부터 합계 글자 수 상한(설정 notesMaxCharsInPacket)까지 싣습니다. 방법론 메모(INSIGHT)는 "
    + "패킷에 싣지 않고 프레임 제안에만 씁니다. "
    + `Claude 계좌 시작(초기 결정) 패킷에는 기준일이 출발일(${startDate ?? EMPTY}) 이하인 메모만 실립니다. 규칙 계좌는 메모를 읽지 않습니다.`;
}

/**
 * 기준일 칸의 안내(F4) — 비우면 서버가 채우는 날(GET 응답의 referenceDate = 마지막으로 끝난 미국 세션). 아침 결정은 그 거래일을 보므로,
 * 결정 전 아침에 오늘(KST) 날짜를 고르면 그날 결정에서 빠지고 하루 늦게 실립니다. 화면은 날짜를 다시 비교하지 않고 기본값의 뜻만 적습니다
 * (실리는지는 저장 결과의 서버 판정 active).
 */
export function noteAsOfHint(referenceDate: string | null | undefined): string {
  const day = textOf(referenceDate);
  const where = day ? `${day}(마지막으로 끝난 미국 세션 — Claude 결정이 보는 거래일)` : "마지막으로 끝난 미국 세션(Claude 결정이 보는 거래일)";
  return `비우면 ${where}. 그보다 뒤 날짜(예: 오늘 KST)를 고르면 그 거래일의 결정부터 실려, 결정 전 아침에 쓴 메모가 그날 결정에서 빠집니다.`;
}

/**
 * 메모 저장 결과 — 서버가 채운 기준일·만료일을 그대로 적고, 시황 메모가 실리는지는 서버 판정(active — referenceDate 기준)을 씁니다(화면이
 * 날짜를 다시 비교하지 않음). active:false면 "지금 기준 거래일의 결정 패킷에는 실리지 않습니다"로 알립니다 — 목록의 배지가 바뀌어서야 알게
 * 되지 않게(F4).
 */
export function noteCreateResultView(
  result: PaperNoteCreateResult,
  referenceDate: string | null = null,
): { tone: "warn" | "info"; text: string } {
  if (result.ok === false) return { tone: "warn", text: result.message ?? "메모를 저장하지 못했습니다." };
  const note = result.note ?? null;
  if (!note) return { tone: "warn", text: result.message ?? "저장한 메모를 받지 못했습니다." };
  if (note.kind === "INSIGHT") {
    return {
      tone: "info",
      text: `방법론 메모(#${note.id})를 저장했습니다 — 결정 패킷에는 싣지 않고 프레임 제안에만 씁니다. 프레임 탭의 제안 카드에서 이 메모를 `
        + "골라 제안을 요청하세요.",
    };
  }
  const head = `시황 메모(#${note.id})를 저장했습니다 — 기준일 ${note.asOfDate ?? EMPTY} · 만료 ${note.expiresOn ?? EMPTY}. `;
  if (note.active === false) {
    const reference = textOf(referenceDate);
    return {
      tone: "warn",
      text: `${head}${reference ? `${reference} 거래일` : "지금 기준 거래일"}의 Claude 결정 패킷에는 실리지 않습니다(서버 판정 — 기준일이 `
        + "그보다 뒤이거나 이미 만료). 기준일~만료일 사이 거래일의 결정부터 실립니다.",
    };
  }
  return { tone: "info", text: `${head}유효한 동안 Claude 결정 패킷에 자료로 실립니다.` };
}

/** 메모 보관 확인 문구. */
export function noteArchiveConfirm(row: Pick<NoteRow, "id" | "title">): string {
  return `이 메모(#${row.id} ${row.title})를 보관할까요? 지우지 않고 보관으로 표시해 더는 패킷·제안에 쓰지 않습니다. 이미 이 메모를 쓴 결정 `
    + "기록(참조 메모)은 그대로 남습니다.";
}

// ---- 성과 화면의 판 경계(F5)

/** 순자산 곡선의 판 경계 — 세로 기준선과 한 줄. */
export interface FrameworkBoundaryView {
  /** 차트 세로선(x = 거래일). 순자산 기록이 있는 날만 — 범주 축이라 없는 날은 그릴 자리가 없습니다. */
  markers: { x: string; label: string }[];
  /** "프레임 경계 — 2026-10-23부터 임시 v0 · 2026-11-03부터 v1". 경계가 없으면 null. */
  text: string | null;
}

/**
 * 개요 frameworkBoundaries(서버 순서 — 날짜 순)를 차트 세로선과 한 줄로. 선 이름은 "프레임 vN"(보충 계약 §4), 한 줄에는 임시 여부까지
 * 적습니다. 순자산 기록이 없는 날의 경계는 선 없이 글에만 남기고 그렇다고 적습니다.
 */
export function frameworkBoundaryView(boundaries: unknown, dates: readonly string[]): FrameworkBoundaryView {
  const known = new Set(dates);
  const entries = listOf(boundaries).filter(isRecord).flatMap((entry) => {
    const date = textOf(entry.tradingDate);
    const version = numberOf(entry.version);
    return date && version !== null ? [{ date, version, status: textOf(entry.status) }] : [];
  });
  if (entries.length === 0) return { markers: [], text: null };
  const parts = entries.map((entry) => `${entry.date}부터 ${frameworkVersionLabel(entry.version, entry.status)}`
    + (known.has(entry.date) ? "" : "(그날 순자산 기록 없음 — 선 없음)"));
  return {
    markers: entries.filter((entry) => known.has(entry.date)).map((entry) => ({ x: entry.date, label: `프레임 v${entry.version}` })),
    text: `프레임 경계(Claude 계좌 결정이 그 판을 처음 쓴 거래일) — ${parts.join(" · ")}`,
  };
}

// ---------------------------------------------------------------- 주간 복기(2단계 명세 §3 D1~D6)

/** 결정 로그 탭 안의 보기 — 거래일마다의 결정 기록과 주마다의 복기(Claude 계좌). */
export const DECISION_VIEWS = [
  { key: "decisions", label: "결정 기록" },
  { key: "reviews", label: "주간 복기" },
] as const;

export type DecisionViewKey = (typeof DECISION_VIEWS)[number]["key"];

/**
 * 수동 복기의 비용 안내 — 기본 모델(Sonnet 5.5) 한 번. 입력은 지난 4주 결정의 사실(코드가 계산)이라 결정 1회(약 $0.1)와 같은 규모로
 * 어림합니다(화면이 단가로 다시 계산하지 않음). 결정·제안과 같은 하루 상한을 씁니다(D4).
 */
export const REVIEW_COST_NOTE = "Sonnet 5.5 호출 1회(약 $0.1), 하루 호출 상한에 포함 — 기본 모델 기준(설정 탭에서 모델을 바꿨으면 그 "
  + "모델). 이 주 복기가 이미 있으면 부르지 않고 그 기록을 보여 줍니다.";

/** 복기가 언제 생기는지 한 문단 — 정기 작업의 조건(서버 PaperReviewJob)을 사람이 읽는 말로. */
export const REVIEW_SCHEDULE_NOTE = "매주 토요일 09:00(KST) 뒤 그 주 마지막 거래일(금요일, 휴장이면 목요일)의 확정 종가가 들어오면 한 번 "
  + "— 지난 4주(입력이 크면 2주) Claude 계좌 결정을 그 뒤 가격과 대조합니다. 수익률·낙폭·스탑·200일선·무효화 평가는 서버가 계산하고 "
  + "Claude는 판정만 합니다. 제안은 프레임 탭에 '승인 대기'로 들어가고 자동 반영은 없습니다. 규칙 계좌는 바꾸지 않습니다.";

const REVIEW_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  OK: { label: "복기 완료", tone: "ok" },
  FORMAT_ERROR: { label: "응답 형식 오류", tone: "warn" },
  API_ERROR: { label: "API 오류", tone: "warn" },
  REFUSED: { label: "모델 거절", tone: "warn" },
  SKIPPED: { label: "건너뜀 · 결정 없음", tone: "muted" },
};

/** 복기 상태 배지. 모르는 상태는 받은 글자 그대로(지어내지 않음). */
export function reviewStatusBadge(status: string | null | undefined): Badge {
  const known = status ? REVIEW_STATUS[status] : undefined;
  return { key: `review-${status ?? "unknown"}`, label: known?.label ?? status ?? EMPTY, className: TONE[known?.tone ?? "muted"] };
}

/** 논거 판정의 색 — 유지는 그대로, 반증은 고칠 것, 판단불가는 회색. */
const THESIS_HELD: Record<string, BadgeTone> = { 유지: "ok", 반증: "warn", 판단불가: "muted" };

export function thesisHeldBadge(value: unknown): Badge {
  const label = textOf(value) ?? EMPTY;
  return { key: `thesis-${label}`, label, className: TONE[THESIS_HELD[label] ?? "muted"] };
}

/** 판정 수 — "유지 2 · 반증 1 · 판단불가 0". 서버가 null(형식을 지난 복기가 아님)이면 "—"(0으로 채우지 않음). */
export function verdictCountsText(counts: PaperReviewVerdictCounts | null | undefined): string {
  if (!counts) return EMPTY;
  return (["유지", "반증", "판단불가"] as const)
    .map((key) => `${key} ${formatNumber(numberOf(counts[key]), 0)}`)
    .join(" · ");
}

/** 창 — "4주", 줄였으면 "2주(입력이 커서 줄임)". 모르면 "—". */
export function reviewWindowText(weeks: number | null | undefined, trimmed = false): string {
  if (!isNumber(weeks)) return EMPTY;
  return `${formatNumber(weeks, 0)}주${trimmed ? "(입력이 커서 줄임)" : ""}`;
}

/** 연결된 제안 — "제안 #12 · 승인 대기". 없으면 "—". */
export function reviewProposalText(id: number | null | undefined, status: string | null | undefined): string {
  if (!isNumber(id)) return EMPTY;
  return status ? `제안 #${id} · ${proposalStatusBadge(status).label}` : `제안 #${id}`;
}

export interface ReviewRow {
  key: string;
  weekEnding: string;
  status: Badge;
  window: string;
  counts: string;
  proposalId: number | null;
  proposal: string;
  createdAt: string;
  model: string;
  /** 오류·재시도 안내(없으면 null). */
  note: string | null;
}

/** 복기 목록 → 표 행(서버 순서 — 주 최근 순). 숫자는 서버 값 그대로. */
export function reviewRows(reviews: readonly PaperReviewSummary[]): ReviewRow[] {
  return reviews.map((review) => ({
    key: review.weekEnding,
    weekEnding: review.weekEnding,
    status: reviewStatusBadge(review.status),
    window: reviewWindowText(review.windowWeeks, review.windowWeeks === 2),
    counts: verdictCountsText(review.verdictCounts),
    proposalId: numberOf(review.proposalId),
    proposal: reviewProposalText(review.proposalId, review.proposalStatus),
    createdAt: formatKst(textOf(review.createdAtKst)),
    model: textOf(review.model) ?? EMPTY,
    note: review.retryable
      ? "API 오류 — 다음 실행(정기 30분 주기 또는 수동)이 같은 주를 한 번 더 부릅니다."
      : textOf(review.error),
  }));
}

/** 목록에서 펼쳐 볼 주 — 고른 주가 목록에 있으면 그것, 아니면 가장 최근 주. 목록이 비면 null. */
export function resolveReviewWeek(picked: string | null, reviews: readonly PaperReviewSummary[]): string | null {
  if (picked && reviews.some((review) => review.weekEnding === picked)) return picked;
  return reviews[0]?.weekEnding ?? null;
}

/** 펼친 주와 그 주 목록 행의 서명({@link reviewRowSignature}). */
export interface ReviewDetailKey {
  week: string | null;
  signature: string | null;
}

/**
 * 목록 행의 서명 — 상태·남긴 시각·재시도 수·연결된 제안(번호·상태). 상세는 입력·응답 원본까지 실어 커서 주기 갱신하지 않고, 60초마다
 * 갱신되는 목록에서 이 값이 바뀔 때만 다시 읽습니다(정기 재시도가 API 오류를 OK로 바꿈·프레임 탭에서 제안을 승인). 그 주가 목록에
 * 없으면 null.
 */
export function reviewRowSignature(reviews: readonly PaperReviewSummary[], week: string | null): string | null {
  if (!week) return null;
  const row = reviews.find((review) => review.weekEnding === week);
  if (!row) return null;
  return [row.status, row.createdAtKst, row.retryCount, row.proposalId, row.proposalStatus]
    .map((value) => String(value ?? ""))
    .join("|");
}

/**
 * 상세를 다시 읽을지 — 같은 주의 서명이 바뀌었을 때만. 주가 바뀌면 상세 경로가 바뀌어 이미 새로 읽고, 처음 본 서명(이전이 없음)도
 * 그렇습니다. 예전에는 펼친 상세를 한 번만 읽어, 목록 행이 '복기 완료 · 제안 #n'으로 바뀐 뒤에도 상세가 'API 오류'로 남았습니다.
 */
export function shouldReloadReviewDetail(previous: ReviewDetailKey | null, next: ReviewDetailKey): boolean {
  return previous !== null && previous.week !== null && previous.week === next.week
    && previous.signature !== null && next.signature !== null && previous.signature !== next.signature;
}

/**
 * 수동 실행 카드의 한 줄 — 가장 최근 복기 주와 정기 복기 시각, 그 주 행이 이미 있는지. 이미 끝난 행이면 실행해도 부르지 않는다고 적습니다
 * (서버가 그 행을 돌려줌). 최근 주를 모르면 null.
 */
export function latestReviewNote(latestWeekEnding: string | null | undefined, opensAtKst: string | null | undefined,
  reviews: readonly PaperReviewSummary[]): string | null {
  const week = textOf(latestWeekEnding);
  if (!week) return null;
  const head = `가장 최근 복기 주 ${week} · 정기 복기 ${formatKst(textOf(opensAtKst))}`;
  const existing = reviews.find((review) => review.weekEnding === week);
  if (!existing) return `${head} — 아직 복기 없음.`;
  if (existing.retryable) return `${head} — API 오류로 끝나 한 번 더 부를 수 있습니다.`;
  return `${head} — 이미 남김(${reviewStatusBadge(existing.status).label}). 실행해도 부르지 않고 그 기록을 보여 줍니다.`;
}

export interface ReviewVerdictRow {
  key: string;
  decision: string;
  asOf: string;
  kind: string;
  thesisHeld: Badge;
  note: string;
}

export interface ReviewDetailView {
  title: string;
  status: Badge;
  meta: DecisionMetaCell[];
  /** 상태 안내(오류·건너뜀·재시도·줄인 창). 없으면 빈 목록. */
  notices: string[];
  counts: string;
  verdicts: ReviewVerdictRow[];
  /** 입력에 있는데 판정이 없는 결정 — "판정 없음: #3 · #5". 없으면 null. */
  missing: string | null;
  recurringErrors: string[];
  keep: string[];
  proposal: { id: number; label: string; summary: string | null; detail: string } | null;
  /** 형식을 지난 응답인데 제안이 없음 — "제안 없음"을 보일지. */
  noProposal: boolean;
  usage: DecisionMetaCell[];
  input: string | null;
  response: string | null;
}

/**
 * 복기 한 건 → 화면. 판정 표의 날짜·종류는 서버가 입력의 결정에서 찾아 붙인 값이고, 화면은 이름만 붙입니다. 판정·반복 오류·지킬 것은
 * 형식을 지난(OK) 복기에만 있습니다(서버가 그 밖에는 빈 목록).
 */
export function reviewDetailView(review: PaperReviewDetail): ReviewDetailView {
  const status = textOf(review.status);
  const notices: string[] = [];
  const error = textOf(review.error);
  if (error) notices.push(status === "SKIPPED" ? error : `오류 — ${error}`);
  if (review.retryable) notices.push("API 오류로 끝났습니다 — 다음 실행(정기 또는 수동)이 같은 주를 한 번 더 부릅니다.");
  if (textOf(review.trimmedReason)) notices.push(`입력을 줄였습니다 — ${review.trimmedReason}`);
  if (status === "FORMAT_ERROR" || status === "REFUSED") {
    notices.push("이 주 복기는 이것으로 끝입니다(같은 입력이면 같은 답일 가능성이 커 다시 부르지 않음).");
  }
  const meta: DecisionMetaCell[] = [
    { key: "weekEnding", label: "복기 주", value: review.weekEnding },
    { key: "window", label: "창", value: reviewWindowText(review.windowWeeks, textOf(review.trimmedReason) !== null) },
    { key: "model", label: "모델", value: textOf(review.model) ?? EMPTY },
    { key: "framework", label: "기준 프레임", value: isNumber(review.frameworkVersion) ? `v${review.frameworkVersion}` : EMPTY },
    { key: "createdAt", label: "남긴 시각", value: formatKst(textOf(review.createdAtKst)) },
  ];
  if (isNumber(review.retryCount) && review.retryCount > 0) {
    meta.push({ key: "retry", label: "재시도", value: `${formatNumber(review.retryCount, 0)}회` });
  }
  const verdicts = listOf(review.verdicts).filter(isRecord).map((entry, index) => {
    const id = numberOf(entry.decisionId);
    return {
      key: `${index}`,
      decision: id === null ? EMPTY : `#${id}`,
      asOf: textOf(entry.asOf) ?? EMPTY,
      kind: decisionKindLabel(textOf(entry.kind)),
      thesisHeld: thesisHeldBadge(entry.thesisHeld),
      note: textOf(entry.note) ?? EMPTY,
    };
  });
  const missingIds = listOf(review.missingDecisionIds).filter(isNumber);
  const proposal = review.proposal && isNumber(review.proposal.id)
    ? {
      id: review.proposal.id,
      label: reviewProposalText(review.proposal.id, review.proposal.status),
      summary: textOf(review.proposal.summary),
      detail: [
        isNumber(review.proposal.operationsCount) ? `변경 ${formatNumber(review.proposal.operationsCount, 0)}건` : null,
        isNumber(review.proposal.baseVersion) ? `기준 판 v${review.proposal.baseVersion}` : null,
        isNumber(review.proposal.resultVersion) ? `만든 판 v${review.proposal.resultVersion}` : null,
        textOf(review.proposal.error) ? `오류 — ${review.proposal.error}` : null,
      ].filter((part): part is string => part !== null).join(" · ") || EMPTY,
    }
    : null;
  const usage = isRecord(review.usage) ? review.usage : null;
  const count = (value: unknown) => formatNumber(numberOf(value), 0);
  return {
    title: `${review.weekEnding} 주 복기`,
    status: reviewStatusBadge(status),
    meta,
    notices,
    counts: verdictCountsText(review.verdictCounts),
    verdicts,
    missing: missingIds.length > 0 ? `판정 없음: ${missingIds.map((id) => `#${id}`).join(" · ")}` : null,
    recurringErrors: listOf(review.recurringErrors).filter((entry): entry is string => typeof entry === "string"),
    keep: listOf(review.keep).filter((entry): entry is string => typeof entry === "string"),
    proposal,
    noProposal: status === "OK" && proposal === null,
    usage: usage === null ? [] : [
      { key: "inputTokens", label: "입력 토큰", value: count(usage.inputTokens) },
      { key: "inputTokensEst", label: "입력 어림", value: count(usage.inputTokensEst) },
      { key: "outputTokens", label: "출력 토큰", value: count(usage.outputTokens) },
      { key: "estCost", label: "추정 비용", value: formatUsdEstimate(numberOf(usage.estCostUsd)) },
      { key: "latency", label: "소요", value: isNumber(usage.latencyMs) ? formatLatency(usage.latencyMs) : EMPTY },
    ],
    input: prettyJson(review.input),
    response: prettyJson(review.response),
  };
}

/** 수동 복기 결과 한 줄. 이미 있던 행이면 부르지 않았다고 적습니다. */
export function reviewRunResultView(result: PaperRunReviewResult): { tone: "info" | "warn"; text: string } {
  if (!result.ok) return { tone: "warn", text: result.message ?? "복기를 실행하지 못했습니다." };
  const week = result.review?.weekEnding ?? EMPTY;
  const status = reviewStatusBadge(result.review?.status).label;
  if (result.outcome === "ALREADY_REVIEWED") {
    return { tone: "info", text: `${week} 주 복기가 이미 있습니다(${status}) — Claude를 부르지 않았습니다.` };
  }
  if (result.outcome === "SKIPPED") {
    return { tone: "info", text: `${week} 주: 창 안에 복기할 Claude 결정이 없어 부르지 않고 '건너뜀'으로 남겼습니다.` };
  }
  const ok = result.review?.status === "OK";
  return { tone: ok ? "info" : "warn", text: `${week} 주 복기를 남겼습니다 — ${status}.` };
}

/**
 * 프레임 탭에서 찾을 제안 — 결정 로그의 주간 복기에서 "제안으로 이동"을 누르면 그 번호를 강조합니다. 목록(최근 50건)에 없으면 그렇다고
 * 적습니다. 찾을 번호가 없으면 note가 null.
 */
export function proposalFocusView(proposals: readonly PaperFrameworkProposal[], id: number | null | undefined):
  { found: boolean; note: string | null } {
  if (!isNumber(id)) return { found: false, note: null };
  if (proposals.some((proposal) => proposal.id === id)) return { found: true, note: null };
  return { found: false, note: `제안 #${id}가 최근 제안 목록(50건)에 없습니다 — 오래된 제안이면 목록에서 빠졌을 수 있습니다.` };
}
