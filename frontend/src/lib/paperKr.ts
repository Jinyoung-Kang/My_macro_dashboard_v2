/**
 * 🧪 모의매매(한국) 화면의 표기 — 출발 상태·실행 결과·작업 기록 줄. React를 모르는 순수 함수(ADR 0004).
 *
 * 숫자·판정은 전부 백엔드가 보냅니다(출발 결과·작업 기록 상세·쉬는 사유). 여기서는 받은 값을 고르고 이름을 붙여 문장으로 늘어놓기만 하고,
 * 모르는 값은 "—"로 둡니다(0이나 다른 날로 채우지 않음). 한국만의 표기라 lib/paper(미국과 공용)를 크게 만들지 않고 따로 둡니다 —
 * 이 파일이 lib/paper를 가져오고 lib/paper는 이 파일을 가져오지 않습니다(순환 방지).
 */
import { EMPTY, formatKst, formatNumber, formatPercent, formatSigned, formatWithUnit } from "./format";
import {
  type Badge,
  decisionKindLabel,
  jsonSummary,
  positionBadges,
  rejectReasonText,
  type RiskResultView,
  riskResultView,
  settingValueAt,
  sideLabel,
  toneClass,
} from "./paper";
import { formatMoney, type PaperMarketCode } from "./paperMarket";
import type {
  PaperBookSummary,
  PaperConfirmationTotal,
  PaperDecisionDetail,
  PaperDecisionSummary,
  PaperExposureReference,
  PaperFill,
  PaperJobRun,
  PaperKrCollection,
  PaperNavRow,
  PaperPosition,
  PaperQuotesSummary,
  PaperKrInitResult,
  PaperKrRiskResult,
  PaperKrStartResult,
  PaperOverviewResponse,
} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const textOf = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const numberOf = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

// ---------------------------------------------------------------- 출발 상태(2단계 명세 §4-8 — 네 계좌가 S 밤 결정으로 S+1 시가에 함께 출발)

/**
 * 한국 출발 상태 넷.
 *
 * - `dormant`: 출발일이 비어 정기 작업이 쉼 — 사유만(단추 없음, 한국 초기화는 출발일이 있어야 받음)
 * - `init`: 출발일은 있고 한국 계좌가 아직 없음 — '한국 초기화' 단추
 * - `waiting`: 네 계좌가 모두 시작 전 — 결정 창과 '출발 지금 실행' 단추
 * - `started`: 한 계좌라도 운용·일시정지(출발함) — 카드 없음
 */
export type KrStartState =
  | { kind: "dormant"; reason: string }
  | { kind: "init"; startDate: string }
  | { kind: "waiting"; startDate: string }
  | { kind: "started" };

/**
 * 개요 응답 → 출발 상태. 출발한 계좌가 있으면 출발일 설정과 상관없이 `started`(출발일을 비워도 출발한 한국 책은 돎 — API.md
 * `dormantReason`), 아니면 출발일이 없으면 `dormant`, 한국 계좌가 다 있지 않으면 `init`, 다 있으면 `waiting`입니다.
 */
export function krStartState(
  overview: Pick<PaperOverviewResponse, "startDate" | "initialized" | "books" | "dormantReason">,
): KrStartState {
  const books: readonly PaperBookSummary[] = overview.books ?? [];
  if (books.some((book) => book.status !== "NOT_STARTED")) return { kind: "started" };
  if (!overview.startDate) {
    return { kind: "dormant", reason: overview.dormantReason ?? "한국 책 출발일이 정해지지 않았습니다" };
  }
  if (overview.initialized === false || books.length === 0) return { kind: "init", startDate: overview.startDate };
  return { kind: "waiting", startDate: overview.startDate };
}

/**
 * 한국 결정 창 — 설정 본문의 `kr.decisionTimeKst`~`kr.decisionDeadlineKst`(HH:mm, KST). 기한이 결정 시각보다 이르거나 같으면 다음 날로 읽는
 * 서버 규칙 그대로 "(다음 날)"을 붙입니다. 설정을 읽지 못했거나 키가 없으면 그 자리는 "—"(기본값 22:30·01:00으로 채우지 않음 — 지금 설정과
 * 다를 수 있음).
 */
export function krDecisionWindowText(settingsBody: unknown): string {
  const opens = textOf(settingValueAt(settingsBody, "kr.decisionTimeKst"));
  const deadline = textOf(settingValueAt(settingsBody, "kr.decisionDeadlineKst"));
  const nextDay = opens !== null && deadline !== null && deadline <= opens ? "(다음 날)" : "";
  return `${opens ?? EMPTY} ~ ${deadline ?? EMPTY}${nextDay} KST`;
}

/** 한국 초기화 결과 한 줄 — 만든 계좌·채운 kr.* 키 수·설정 판. */
export function krInitResultText(result: PaperKrInitResult): string {
  if (result.ok === false) return result.message ?? "한국 초기화를 하지 못했습니다.";
  const created = result.created ?? [];
  const written = result.settingsKeysWritten ?? [];
  return [
    created.length > 0 ? `만든 계좌 ${created.join(", ")}` : "새로 만든 계좌 없음(이미 있음)",
    written.length > 0
      ? `설정 v${result.settingsVersion ?? EMPTY} — 비어 있던 kr.* 키 ${formatNumber(written.length, 0)}개를 기본값으로 채움`
      : `설정 그대로(v${result.settingsVersion ?? EMPTY})`,
    result.startDate ? `출발일 ${result.startDate}` : null,
  ].filter(Boolean).join(" · ");
}

/** 출발·결정 작업 기록 상세에서 아는 칸만 고른 짧은 글(세션·설정 출발일·미룸·사유·과금 호출·이어진 주기·오류). 모르는 칸은 건너뜁니다. */
export function krStartRecordParts(detail: unknown): string[] {
  if (!isRecord(detail)) return [];
  const parts: string[] = [];
  const session = textOf(detail.tradingDate);
  const configured = textOf(detail.configuredStartDate);
  if (session) parts.push(`세션 ${session}`);
  if (configured && detail.postponed === true) parts.push(`설정 출발일 ${configured}에서 미뤄짐`);
  const postponedTo = textOf(detail.postponedTo);
  if (postponedTo) parts.push(`다음 KR 거래일 ${postponedTo}로 미룸`);
  const checks = numberOf(detail.checks);
  if (checks !== null) parts.push(`이어진 주기 ${formatNumber(checks, 0)}번`);
  const reason = textOf(detail.reason);
  if (reason) parts.push(`사유 ${reason}`);
  const calls = chargedCalls(detail.calls);
  if (calls) parts.push(calls);
  const attempt = numberOf(detail.attempt);
  if (attempt !== null) parts.push(`시도 ${formatNumber(attempt, 0)}번째`);
  const error = textOf(detail.error);
  if (error) parts.push(`오류 ${error}`);
  return parts;
}

/**
 * 미룸·오류 기록의 과금 호출 — `{계좌: {calls, attempts, isEstimated}}`(결정 행 없이 과금된 Claude 호출, 2단계 명세 §4-10). 호출 수를 모르면
 * "—"로 적고(0으로 채우지 않음), 기록이 없으면 null.
 */
export function chargedCalls(calls: unknown): string | null {
  if (!isRecord(calls)) return null;
  const entries = Object.entries(calls).map(([book, record]) => {
    const count = isRecord(record) ? numberOf(record.calls) : null;
    return `${book} ${count === null ? EMPTY : formatNumber(count, 0)}회`;
  });
  return entries.length > 0 ? `과금 호출 ${entries.join(" · ")}(결정 행 없음 — 사용량에 셈)` : null;
}

/** 그 세션의 가장 최근 출발 작업 기록(`kr.decision` 중 상세 `start:true`) — 작업 기록은 최근 순으로 옵니다. 없으면 null. */
export function latestStartRecord(jobs: readonly PaperJobRun[] | null | undefined): PaperJobRun | null {
  return (jobs ?? []).find((job) => job.job === "kr.decision" && isRecord(job.detail) && job.detail.start === true) ?? null;
}

/** 출발 작업 기록 한 줄 — "2026-10-29 22:40 START_WAITING · 세션 … · 사유 …". */
export function krStartRecordLine(job: PaperJobRun): string {
  return [`${formatKst(job.startedAtKst)} ${job.outcome || EMPTY}`, ...krStartRecordParts(job.detail)].join(" · ");
}

/** 출발 단추 결과의 표시 — 배너 색과 문장. */
export interface KrStartResultView {
  tone: "warn" | "info";
  text: string;
  /** 그 출발 기록의 아는 칸(세션·미룸·과금 호출 등). */
  detail: string[];
}

/**
 * 출발 단추 결과 → 배너. `STARTED`·`ALREADY_STARTED`는 정보색, `START_POSTPONED`·`ERROR`·모르는 결과는 경고색입니다. 문장은 서버 `message`를
 * 그대로 붙입니다(무엇이 막았는지 서버가 적어 보냄).
 */
export function krStartResultView(result: PaperKrStartResult): KrStartResultView {
  const outcome = result.outcome ?? null;
  const message = result.message ? ` — ${result.message}` : "";
  const session = result.tradingDate ?? EMPTY;
  const detail = krStartRecordParts(result.record);
  switch (outcome) {
    case "STARTED":
      return { tone: "info", text: `한국 출발 — ${session} 결정, 네 계좌가 다음 KR 거래일 시가에 함께 체결합니다${message}`, detail };
    case "ALREADY_STARTED":
      return { tone: "info", text: `이미 출발했습니다(${session}) — 아무것도 하지 않았습니다${message}`, detail };
    case "START_POSTPONED":
      return { tone: "warn", text: `출발을 다음 KR 거래일로 미뤘습니다(${session})${message}`, detail };
    case "ERROR":
      return { tone: "warn", text: `출발 오류(${session}) — 다음 주기에 다시 시도합니다${message}`, detail };
    default:
      return { tone: "warn", text: `출발 결과 ${outcome ?? EMPTY}${message}`, detail };
  }
}

/**
 * 한국 리스크 점검 결과 — 미국 표시({@link riskResultView})에 쉬는 사유를 더합니다. 쉬면 `ok:false`라 미국 문구('리스크 작업이 돌지 않았습니다')
 * 대신 그 사유를 경고로 적습니다.
 */
export function krRiskResultView(result: PaperKrRiskResult): RiskResultView {
  const view = riskResultView(result);
  if (result.ok === false && result.dormantReason) {
    return { ...view, warning: `한국 책이 쉬고 있어 리스크 점검을 하지 않았습니다 — ${result.dormantReason}` };
  }
  return view;
}

/** 한국 '리스크 지금 실행' 단추의 뜻(2단계 명세 §4-16 F1b — 장부 실패 기억 복구 경로). */
export const KR_RISK_RUN_NOTE =
  "'리스크 지금 실행'은 한국 장부의 실패 기억을 지우고 같은 관측치를 다시 처리합니다 — 장부 오류 원인을 고친 뒤 결정 게이트 ①을 푸는 창 안의 "
  + "복구 경로(재기동 대신)";

// ---------------------------------------------------------------- 작업 기록 카드(2단계 명세 §9 x3·E0 메모)

/** 한국 작업 기록 이름의 접두어(백엔드 PaperMarket.jobPrefix). */
const KR_JOB_PREFIX = "kr.";

/**
 * 그 개요 시장의 작업 기록만. 미국 개요 응답의 작업 기록은 모든 작업(한국 `kr.*` 포함 — 미국 응답 글자를 지키려고 서버는 거르지 않음, 사용자
 * 결정 2026-10-29 x3)이라 미국 카드는 화면에서 `kr.` 줄을 뺍니다. 한국 응답은 서버가 이미 `kr.`만 주지만 같은 규칙으로 한 번 더 거릅니다.
 */
export function marketJobs(jobs: readonly PaperJobRun[] | null | undefined, market: PaperMarketCode): PaperJobRun[] {
  const korean = (job: PaperJobRun) => typeof job.job === "string" && job.job.startsWith(KR_JOB_PREFIX);
  return (jobs ?? []).filter((job) => (market === "KR" ? korean(job) : !korean(job)));
}

/**
 * 한국 작업 기록 상세의 아는 칸 — 기한 지남·세션·설정 출발일/미룸·이어진 주기·사유·과금 호출·시도·오류({@link krStartRecordParts})에 기다림 문구
 * (`waiting`)·미달 게이트(`gates`의 FAIL)·판정 근거(`gatesBasis`)를 더합니다. 순서는 읽는 순서(무엇이 → 왜).
 */
export function krJobDetailParts(detail: unknown): string[] {
  if (!isRecord(detail)) return [];
  const parts: string[] = [];
  if (detail.pastDeadline === true) parts.push("기한 지남");
  parts.push(...krStartRecordParts(detail));
  const waiting = textOf(detail.waiting);
  if (waiting) parts.push(waiting);
  const failed = (Array.isArray(detail.gates) ? detail.gates : [])
    .filter((gate): gate is Record<string, unknown> => isRecord(gate) && gate.status === "FAIL")
    .map((gate) => textOf(gate.gate) ?? EMPTY);
  if (failed.length > 0 && !waiting) parts.push(`미달 게이트 ${failed.join("·")}`);
  const basis = textOf(detail.gatesBasis);
  if (basis) parts.push(`판정 ${basis}`);
  return parts;
}

/**
 * 한국 작업 기록 상세 한 줄 — 아는 칸이 있으면 그것을 앞에(자르지 않음), 없으면(리스크 점검의 체결 수 등) 미국 카드와 같은 키: 값 요약. 전체
 * JSON은 마우스를 올려 봅니다(lib/paper jsonTitle).
 */
export function krJobDetailText(job: Pick<PaperJobRun, "detail">): string {
  const parts = krJobDetailParts(job.detail);
  return parts.length > 0 ? parts.join(" · ") : jsonSummary(job.detail);
}

/** 작업 기록 카드의 부제 — 무엇을 남기는지(시장마다 다름). */
export function jobsCardSubtitle(market: PaperMarketCode): string {
  return market === "KR"
    ? "일했을 때·오류일 때, 그리고 한국 결정·출발이 자료를 기다린 세션마다 한 줄(이어진 주기 수 — 이어진 기다림은 그 줄만 늘림)을 "
      + "남깁니다(최근 10건). 상세에는 세션·사유·미달 게이트·미룬 날·과금 호출이 앞에 있고, 전체는 마우스를 올려 봅니다."
    : "정기·수동 작업이 일했을 때·오류일 때만 남깁니다(최근 10건 중 미국 작업 — 한국 작업 kr.*은 한국 개요). 상세에는 처리한 관측치의 "
      + "수집 시각·봉 날짜·티커 수가 있습니다.";
}

/** 작업 기록 카드가 비었을 때 — 미국 카드는 서버가 준 최근 10건이 모두 한국 작업이면 그렇다고 적습니다(빈 표를 '기록 없음'으로 읽지 않게). */
export function jobsEmptyMessage(market: PaperMarketCode, all: readonly PaperJobRun[] | null | undefined): string {
  if (market === "US" && (all ?? []).length > 0) return "최근 10건 가운데 미국 작업이 없습니다 — 한국 작업은 한국 개요에 있습니다.";
  return market === "KR"
    ? "아직 한국 작업 기록이 없습니다. 한국 리스크 점검이 새 관측치를 처리하거나 결정·출발이 자료를 기다리면 생깁니다."
    : "아직 작업 기록이 없습니다. 리스크 작업이 새 관측치를 처리하면 생깁니다.";
}

// ---------------------------------------------------------------- 한국 수집 상태 카드(2단계 명세 §9 x4)

/** 수집 상태 한 줄의 판정 — 정상·늦음·뒤처짐·없음·모름. 색만으로 뜻을 나르지 않게 글로 적습니다. */
export type KrCollectionState = "정상" | "늦음" | "뒤처짐" | "없음" | "모름";

/** 한국 수집 상태 표의 한 줄(항목 하나). 모르는 칸은 "—". */
export interface KrCollectionRow {
  key: string;
  item: string;
  /** 출처·수집기 태스크(작은 글). */
  source: string;
  basis: string;
  collectedAt: string;
  scope: string;
  state: KrCollectionState;
  /** 판정의 까닭(늦음·뒤처짐·없음·실패 피드) — 없으면 null. */
  reason: string | null;
}

const count = (value: number | null | undefined) => formatNumber(value, 0);
const dateOr = (value: string | null | undefined) => value ?? EMPTY;

/** 늦음 칸 → 판정. 저장본이 없으면 '없음', 늦음 true면 '늦음'(사유), false면 '정상', null이면 '모름'(서버가 준 사유). */
function lateState(
  available: boolean | undefined,
  stale: boolean | null | undefined,
  staleReason: string | null | undefined,
  lateText: string,
): Pick<KrCollectionRow, "state" | "reason"> {
  if (!available) return { state: "없음", reason: "저장본이 아직 없습니다" };
  if (stale === true) return { state: "늦음", reason: lateText };
  if (stale === false) return { state: "정상", reason: null };
  return { state: "모름", reason: staleReason ?? null };
}

/**
 * 상태 응답의 한국 수집 상태(`collection`) → 표의 줄(관측치·수급·유니버스·DART·사건 뉴스·거시 일정·금융위). 관측치 줄에는 개요의 관측치 요약
 * (`quotes` — 받은 종목·이어받은 종목)을 함께 적습니다(한국 개요는 미국의 '장부 관측치' 카드 대신 이 표). 숫자는 서버 값 그대로이고 모르는 칸은
 * "—"(0으로 채우지 않음). `collection`이 없으면(이 칸을 보내지 않는 서버) 빈 목록.
 */
export function krCollectionRows(
  collection: PaperKrCollection | null | undefined,
  quotes: PaperQuotesSummary | null | undefined,
): KrCollectionRow[] {
  if (!collection) return [];
  const rows: KrCollectionRow[] = [];
  const q = collection.quotes;
  if (q) {
    const received = quotes
      ? ` · 받은 ${count(quotes.tickers)}종목 · 이어받음 ${count(quotes.staleTickers.length)}${quotes.barDate ? ` · 봉 ${quotes.barDate}` : ""}`
      : "";
    rows.push({
      key: "quotes", item: "관측치", source: "토스증권 · kr_paper_quotes",
      basis: `세션 ${dateOr(q.session)} · U 기준일 ${dateOr(q.universeDate)}`,
      collectedAt: formatKst(q.collectedAtKst), scope: `범위 ${count(q.scope)}종목${received}`,
      ...lateState(q.available, q.stale, q.staleReason, "다음 수집 예정(다음 KR 거래일 서버 창) + 2시간 5분을 넘김"),
    });
  }
  const f = collection.flows;
  if (f) {
    rows.push({
      key: "flows", item: "수급", source: "토스증권 · kr_paper_flows",
      basis: `세션 ${dateOr(f.session)} · U 기준일 ${dateOr(f.universeDate)}`,
      collectedAt: formatKst(f.collectedAtKst),
      scope: `범위 ${count(f.scope)} · 정상 ${count(f.ok)}(세션 기록 없음 ${count(f.sessionMiss)}) · 기록 없음 ${count(f.noRecords)} · `
        + `이어받음 ${count(f.carried)} · 항목 없음 ${count(f.missing)}`,
      ...lateState(f.available, f.stale, f.staleReason, "다음 수집 예정(다음 KR 거래일 서버 창) + 2시간 5분을 넘김"),
    });
  }
  const u = collection.universe;
  if (u) {
    rows.push({
      key: "universe", item: "유니버스", source: "금융위원회(공공데이터포털) · kr_paper_universe",
      basis: `기준일 ${dateOr(u.baseDate)}`, collectedAt: EMPTY, scope: `${count(u.size)}종목`,
      ...(!u.available ? { state: "없음" as const, reason: "저장된 기준일이 아직 없습니다" }
        : u.behind === true ? { state: "뒤처짐" as const, reason: u.behindReason ?? "금융위 주식시세보다 이른 기준일" }
          : u.behind === false ? { state: "정상" as const, reason: null }
            : { state: "모름" as const, reason: "금융위 주식시세 기준일을 몰라 비교하지 못함" }),
    });
  }
  const d = collection.dart;
  if (d) {
    rows.push({
      key: "dart", item: "재무(DART)", source: "금융감독원 Open DART · dart_fundamentals",
      basis: EMPTY, collectedAt: formatKst(d.collectedAtKst),
      scope: `대상 ${count(d.universe)}(한국 범위 ${count(d.krScope)}) · 고유번호 없음 ${count(d.unmapped)}`,
      ...lateState(d.available, d.stale, null, "7일 넘게 새 저장본이 없음"),
    });
  }
  const n = collection.news;
  if (n) {
    const failed = (n.failedFeeds ?? []).map((feed) => `${feed.feed ?? EMPTY}(${feed.reason ?? EMPTY})`);
    const late = lateState(n.available, n.stale, null, "24시간 넘게 피드를 받지 못함");
    rows.push({
      key: "news", item: "사건 뉴스", source: "RSS 4곳 · kr_news_headlines",
      basis: `7일 ${count(n.stored7d)}건`, collectedAt: formatKst(n.lastFetchKst),
      scope: `피드 ${count(n.feedsOk)}/${count(n.feedsTotal)}`,
      state: late.state,
      reason: [late.reason, failed.length > 0 ? `실패 피드 ${failed.join(" · ")}` : null].filter(Boolean).join(" · ") || null,
    });
  }
  const c = collection.calendar;
  if (c) {
    rows.push({
      key: "calendar", item: "거시 일정", source: "상수(금통위·주요 발표) · kr_calendar",
      basis: `창 끝 ${dateOr(c.horizonTo)}`, collectedAt: formatKst(c.generatedAtKst),
      scope: `일정 ${count(c.macroCount)}건 · 날짜 미확인 발표 ${count(c.unconfirmed)}`,
      ...lateState(c.available, c.stale, null, "7일 넘게 새 저장본이 없음"),
    });
  }
  const s = collection.fsc;
  if (s) {
    rows.push({
      key: "fsc", item: "확정 시세", source: "금융위원회(공공데이터포털) · fsc_prices·fsc_etf_prices",
      basis: `주식 ${dateOr(s.stocksLatestBasDt)} · ETF ${dateOr(s.etfsLatestBasDt)}`, collectedAt: formatKst(s.metaCollectedAtKst),
      scope: "확정가·확정 조정의 자료(다음 영업일 13시 뒤 공개)",
      ...(!s.available ? { state: "없음" as const, reason: "받은 기준일이 아직 없습니다" }
        : s.etfBehind === true ? { state: "뒤처짐" as const, reason: "증권상품시세(ETF) 기준일이 주식시세보다 이릅니다" }
          : s.etfBehind === false ? { state: "정상" as const, reason: null }
            : { state: "모름" as const, reason: "주식·ETF 중 한쪽 기준일을 몰라 비교하지 못함" }),
    });
  }
  return rows;
}

// ---------------------------------------------------------------- 노출 맞춘 참고선(2단계 명세 §3·K40)

/** 참고선 계열의 키(순자산 곡선 행의 칸 이름 — 계좌 코드와 겹치지 않게). */
export const KR_REFERENCE_KEY = "kr_exposure_reference";
/** 참고선 계열 이름(범례·툴팁) — 계좌가 아니라는 것을 이름이 함께 말합니다. */
export const KR_REFERENCE_NAME = "노출 맞춘 참고선(계좌 아님)";

/**
 * 순자산 곡선 행에 참고선 칸을 더합니다 — 참고선의 `dates`·`values`(순자산 곡선과 같은 날짜 줄)를 날짜로 맞춰 넣고(기간을 골라 줄인 행에도
 * 맞음), 모르는 날은 null 그대로(선이 끊김 — 앞 값으로 채우지 않음). 참고선이 없거나(출발 전·F2 전 서버) 모양이 다르면 받은 행 그대로·계열 없음.
 */
export function withKrReference(
  rows: readonly Record<string, string | number | null>[],
  reference: PaperExposureReference | null | undefined,
): { rows: Record<string, string | number | null>[]; series: { key: string; name: string }[] } {
  const dates = Array.isArray(reference?.dates) ? reference.dates : null;
  const values = Array.isArray(reference?.values) ? reference.values : null;
  if (!dates || !values || dates.length !== values.length) {
    return { rows: rows.map((row) => ({ ...row })), series: [] };
  }
  const byDate = new Map<string, number | null>();
  dates.forEach((date, index) => byDate.set(date, numberOf(values[index])));
  return {
    rows: rows.map((row) => ({ ...row, [KR_REFERENCE_KEY]: byDate.get(String(row.date)) ?? null })),
    series: [{ key: KR_REFERENCE_KEY, name: KR_REFERENCE_NAME }],
  };
}

/**
 * 곡선 아래 참고선 설명 — 정의 한 줄과 마지막 값의 날·그날 쓴 규칙 계좌 주식 비중, 멈췄으면 그 사유. 참고선이 없으면 null(글 없음).
 */
export function krReferenceNotes(reference: PaperExposureReference | null | undefined): string[] | null {
  if (!reference) return null;
  const weights = Array.isArray(reference.stockWeightPct) ? reference.stockWeightPct : [];
  const lastIndex = reference.asOfDate ? reference.dates.indexOf(reference.asOfDate) : -1;
  const weight = lastIndex >= 0 ? numberOf(weights[lastIndex]) : null;
  const notes = [
    // 왜 보는지(규칙 계좌 결과의 노출 혼합)는 곡선 아래 노출 문구(lib/paper exposureNote)가 한 줄로 적습니다 — 여기서는 정의만.
    "점선 = 노출 맞춘 참고선 — 전날 규칙 계좌 주식 비중 x%를 069500 x% + 153130 (100−x)%로 맞춰 이은 선입니다(계산만 하고 계좌가 아님, "
      + "비용 없음, 금융위원회 증권상품시세 확정 종가).",
    reference.asOfDate
      ? `마지막 값 ${reference.asOfDate}(그날 쓴 전날 규칙 계좌 주식 비중 ${weight === null ? EMPTY : `${formatNumber(weight, 2)}%`}) — `
        + "금융위 확정 종가가 들어온 날까지라 보통 하루 늦습니다."
      : "아직 값이 없습니다 — 금융위 확정 종가가 들어온 날부터 그립니다(보통 하루 늦음).",
  ];
  if (reference.stoppedReason) notes.push(`멈춤: ${reference.stoppedReason}`);
  notes.push("규칙 계좌의 후보 수·'자료 없음' 사유는 종목 선정 탭에 있습니다.");
  return notes;
}

// ---------------------------------------------------------------- 보유·체결(2단계 명세 §4-16 F2 — 잠정·확정·확정 조정·실효 비용 bp·세 배지)

/** 원 금액·주당 가격(원 단위 정수) — "71,300원". 모르면 "—". */
const won = (value: number | null | undefined) => formatMoney(value, "KR");
/** 부호 있는 원 금액 — "+1,000원"·"−100원"이 아니라 "-100원"(lib/format formatSigned 그대로). 모르면 "—". */
const signedWon = (value: number | null | undefined) => formatSigned(value, 0, "원");

/** 한국 체결가·관측가 출처 이름표(paper_fills.price_source — 백엔드 KrQuotes). 모르는 값은 받은 글자 그대로. */
const KR_PRICE_SOURCE: Readonly<Record<string, string>> = {
  TOSS_1M_OPEN: "KRX 시가 단일가(1분봉)",
  TOSS_DAILY: "KRX 일봉 시가",
  TOSS_INTEGRATED: "KRX+NXT 통합가",
};

export function krPriceSourceLabel(source: string | null | undefined): string {
  return source ? (KR_PRICE_SOURCE[source] ?? source) : EMPTY;
}

/**
 * 한국 보유 한 줄의 배지 — '기업행위 확인 필요'(미처리 기업행위 보류 — 사유는 마우스를 올려 봄)를 맨 앞에, 그 뒤로 미국과 같은 '가격 없음'·
 * 분할 조정·현금성(한국에는 사후 체결이 없어 그 배지는 뺌).
 */
export function krPositionBadges(position: PaperPosition): Badge[] {
  const badges: Badge[] = [];
  const hold = textOf(position.corpActionHold);
  if (hold) {
    badges.push({
      key: "corpAction", label: "기업행위 확인 필요", className: toneClass("warn"),
      title: `${hold} — 평가는 묶인 값 그대로이고 스탑·주문은 보류됩니다(사람이 확인한 뒤 풂). 그동안 이 계좌 순자산 줄은 잠정입니다.`,
    });
  }
  return [...badges, ...positionBadges(position).filter((badge) => badge.key !== "backfill")];
}

/**
 * 한국 보유 가격 칸의 툴팁 — 보통은 '{시각} 관측(토스증권 잠정)'. 미처리 기업행위 보류 보유는 장부가 평가를 묶은 값이라(PaperLedgerService
 * holdUnprocessed) 관측이라 적지 않고 묶인 평가의 출처(`heldValuation` — §9 F3)를 적습니다: 금융위 확정 종가(시각 = 장부가 묶은 때), 마지막
 * 평가 가격(시각 = 그 가격을 관측한 때), 평단. 출처 칸이 없는 응답(F3 전 백엔드)은 둘 중 어느 쪽인지 가리지 않는 문구. 시각이 없으면
 * undefined(툴팁 없음).
 */
export function krPositionPriceTitle(
  position: Pick<PaperPosition, "lastPriceAtKst" | "corpActionHold" | "heldValuation">,
): string | undefined {
  if (!position.lastPriceAtKst) return undefined;
  const at = formatKst(position.lastPriceAtKst);
  if (!textOf(position.corpActionHold)) return `${at} 관측(토스증권 잠정)`;
  const held = position.heldValuation;
  const day = textOf(held?.date) ?? EMPTY;
  switch (held?.source) {
    case "FSC_CONFIRMED":
      return `묶인 평가 — 금융위 ${day} 확정 종가 · ${at} 장부가 묶음`;
    case "LAST_VALUATION":
      return `묶인 평가 — 마지막 평가 가격(${at} 관측, 토스증권 잠정) · 금융위 ${day} 확정 종가로는 아직 묶지 않음`;
    case "AVG_COST":
      return "묶인 평가 — 가격을 받은 적이 없어 평단으로 평가";
    default:
      return `묶인 평가 — 금융위 확정 종가(없으면 마지막 평가 가격) · ${at} 기록(장부가 묶은 때이거나 그 가격을 받은 때)`;
  }
}

/** 확정 조정 출처 이름(FSC·FSC_ETF). */
function fscDatasetLabel(source: string | null | undefined): string {
  return source === "FSC_ETF" ? "금융위 증권상품시세" : source === "FSC" ? "금융위 주식시세" : (source ?? EMPTY);
}

/**
 * 한국 체결 한 줄의 배지 — 확정 상태(확정 · 확정 대기 · 금융위 확정 미보정(ETF) · 금융위 확정 못 함)와, 잠정가가 KRX+NXT 통합가(`TOSS_INTEGRATED`)면
 * 그 표시 — 아직 확정되지 않은 행은 경고색 '잠정', 확정 행은 무채색 '확정 조정됨'(이미 금융위 확정가로 맞춤). 상태를 모르면(이 칸을 보내지 않는
 * 서버) 상태 배지는 없고 통합가 표시는 '잠정'입니다.
 */
export function krFillBadges(fill: Pick<PaperFill, "confirmationState" | "confirmationNote" | "confirmation" | "priceSource">): Badge[] {
  const badges: Badge[] = [];
  const state = fill.confirmationState ?? null;
  if (state === "CONFIRMED") {
    const c = fill.confirmation;
    badges.push({
      key: "confirmed", label: "확정", className: toneClass("ok"),
      title: c ? `${fscDatasetLabel(c.source)} 확정가 ${won(c.confirmedPrice)} — ${formatKst(c.reconciledAtKst)}에 확정 조정` : undefined,
    });
  } else if (state === "WAITING") {
    badges.push({
      key: "waiting", label: "확정 대기", className: toneClass("muted"),
      title: fill.confirmationNote ?? "금융위 그날 값이 아직 없습니다 — 들어오면 확정 조정 행으로 맞춥니다(보통 다음 영업일 13시 뒤).",
    });
  } else if (state === "UNCORRECTED") {
    badges.push({
      key: "uncorrected", label: fill.confirmationNote ?? "금융위 확정 못 함", className: toneClass("warn"),
      title: "금융위가 그날 값을 냈지만 이 체결의 확정 조정 행이 없습니다 — 잠정가 그대로이고, 그날까지의 이 계좌 순자산 줄은 확정되지 "
        + "않습니다. 까닭(그 종목 행 없음·시가 칸 없음 등)은 작업 기록 kr.risk에 있습니다.",
    });
  } else if (state) {
    badges.push({ key: "state", label: state, className: toneClass("muted"), title: fill.confirmationNote ?? undefined });
  }
  if (fill.priceSource === "TOSS_INTEGRATED") {
    const integrated = "NXT 시간외 체결을 포함한 통합 일봉 시가";
    badges.push(state === "CONFIRMED"
      ? {
        key: "integrated", label: "KRX+NXT 통합가 · 확정 조정됨", className: toneClass("muted"),
        title: `잠정 체결가는 ${integrated}였고(KRX 시가 단일가가 아닐 수 있음), 금융위 확정가로 확정 조정했습니다 — 현금·평단은 확정 기준입니다.`,
      }
      : {
        key: "integrated", label: "KRX+NXT 통합가 · 잠정", className: toneClass("warn"),
        title: state === "UNCORRECTED"
          ? `${integrated}입니다 — KRX 시가 단일가가 아닐 수 있는데, 이 체결은 확정 조정 행이 없어 잠정가 그대로입니다.`
          : `${integrated}입니다 — KRX 시가 단일가가 아닐 수 있어, 금융위 그날 값이 들어오면 금융위 확정가로 맞춥니다.`,
      });
  }
  return badges;
}

/**
 * 체결 표 위의 확정 조정 합계 — "확정 조정 합계 +1,000원 · 확정 2건 · 남음 1건". 확정 조정 행이 없으면 합계는 "—"(0원으로 적지 않음 — 아직 맞춘
 * 것이 없음). 이 칸을 보내지 않는 서버면 null(줄 없음).
 */
export function krConfirmationTotalText(total: PaperConfirmationTotal | null | undefined): string | null {
  if (!total) return null;
  const sum = total.rows > 0 ? signedWon(total.cashDelta) : `${EMPTY}(확정 조정 행 없음)`;
  return `확정 조정 합계 ${sum} · 확정 ${formatNumber(total.rows, 0)}건 · 남음 ${formatNumber(total.unconfirmed, 0)}건`;
}

/** 비용 세 칸(수수료 · 세금 · 슬리피지, 원 정수) — "106 · 0 · 356". 모르는 칸은 "—". */
export function krCostText(fee: number | null | undefined, tax: number | null | undefined, slippage: number | null | undefined): string {
  return `${formatNumber(fee, 0)} · ${formatNumber(tax, 0)} · ${formatNumber(slippage, 0)}`;
}

/**
 * 한국 체결 표의 확정 칸 — 확정가·차이·현금 차이, 그리고 확정가로 다시 센 비용 세 칸·실효 비용 bp(장부가 현금을 맞춘 값 — 잠정 체결의 비용 칸과
 * 나란히 '확정'으로). 확정 조정 행이 없으면 다섯 모두 "—".
 */
export function krConfirmationCells(fill: Pick<PaperFill, "confirmation">): {
  price: string; diff: string; cash: string; costs: string; costBp: string;
} {
  const c = fill.confirmation;
  return {
    price: won(c?.confirmedPrice),
    diff: signedWon(c?.priceDiff),
    cash: signedWon(c?.cashDelta),
    costs: c ? krCostText(c.fee, c.tax, c.slippageCost) : EMPTY,
    costBp: c ? formatWithUnit(c.costBp, 2, "bp") : EMPTY,
  };
}

/**
 * 한국 STOP 주문 근거 한 줄 — 감지(잠정 종가·출처·봉 날짜·스탑가·최고가) · 확정값으로 낮춘 최고가(`confirmedHighWatermark`) · 재판정 근거
 * (`stopBasis` — FSC·FSC_ETF는 금융위 확정 종가, PROVISIONAL은 잠정 판정대로) · `stopBasisNote`. 트레일링 스탑 근거가 아니면 null(호출한 쪽이
 * 미국과 같은 근거 문장으로).
 */
export function krStopBasisText(reason: unknown): string | null {
  if (!isRecord(reason) || reason.trigger !== "TRAILING_STOP") return null;
  const pct = numberOf(reason.stopPct);
  const parts = [
    `감지 ${textOf(reason.barDate) ?? EMPTY} 잠정 종가 ${won(numberOf(reason.observedPrice))}(${krPriceSourceLabel(textOf(reason.observedSource))}) `
      + `≤ 스탑가 ${won(numberOf(reason.stopPrice))}(최고가 ${won(numberOf(reason.highWatermark))} −${pct === null ? EMPTY : formatNumber(pct, 1)}%)`,
  ];
  const corrected = numberOf(reason.confirmedHighWatermark);
  if (corrected !== null) parts.push(`확정값으로 낮춘 최고가 ${won(corrected)}`);
  const basis = textOf(reason.stopBasis);
  if (basis === "PROVISIONAL") parts.push("재판정: 금융위 확정 종가 없음 — 잠정 판정대로");
  else if (basis) parts.push(`재판정: ${fscDatasetLabel(basis)} 확정 종가 ${won(numberOf(reason.confirmedClose))}`);
  else parts.push("재판정 전 — 체결 때 금융위 확정 종가로 다시 판정");
  const note = textOf(reason.stopBasisNote);
  if (note) parts.push(note);
  return parts.join(" · ");
}

/** 한국 주문 거절·취소 사유 — 스탑 재판정 취소(`STOP_NOT_CONFIRMED — …`)는 이름표와 나머지 문장으로 나눕니다. 그 밖은 받은 글 그대로. */
export function krOrderRejectText(text: string | null | undefined): { label: string | null; detail: string | null } {
  if (!text) return { label: null, detail: null };
  const head = "STOP_NOT_CONFIRMED";
  if (!text.startsWith(head)) return { label: null, detail: text };
  const rest = text.slice(head.length).replace(/^\s*—\s*/, "");
  return { label: "스탑 취소 — 확정 종가가 뒷받침하지 않음", detail: rest || null };
}

/** 그 계좌의 리스크 점검 기록 메모(`kr.risk` 상세 `notes` — 줄마다 "계좌 코드: …"), 최근 기록부터. */
function riskNotes(jobs: readonly PaperJobRun[] | null | undefined, code: string): string[] {
  const prefix = `${code}: `;
  const out: string[] = [];
  for (const job of jobs ?? []) {
    if (job.job !== "kr.risk" || !isRecord(job.detail) || !Array.isArray(job.detail.notes)) continue;
    for (const note of job.detail.notes) {
      if (typeof note === "string" && note.startsWith(prefix)) out.push(note.slice(prefix.length));
    }
  }
  return out;
}

/**
 * 잠정으로 남은 순자산 줄의 사유 — 그 계좌 리스크 점검 기록(상태 응답 작업 기록, 최근 30건)의 확정 조정 메모 '순자산 {날} 잠정으로 다시 씀(…) —
 * 사유'(금융위 종가 없음·체결 확정 전·'주문 … 대기 — D 이하 봉으로 체결될 수 있음'·미처리 기업행위)나 '순자산 {날} 줄은 다시 쓰지 않음 — 까닭' 가운데
 * 가장 최근 것. 장부가 그 줄을 다시 쓰지 않은 주기에는 메모가 없어 null입니다(화면은 '—'과 '최근 작업 기록에 사유 없음').
 */
export function krNavProvisionalReason(jobs: readonly PaperJobRun[] | null | undefined, code: string, tradingDate: string): string | null {
  const head = `순자산 ${tradingDate} `;
  for (const note of riskNotes(jobs, code)) {
    if (!note.startsWith(head)) continue;
    const rest = note.slice(head.length);
    const cut = rest.indexOf(" — ");
    if (rest.startsWith("잠정으로 다시 씀")) return cut >= 0 ? rest.slice(cut + 3) : rest;
    if (rest.startsWith("줄은 다시 쓰지 않음")) return `줄을 다시 쓰지 않음 — ${cut >= 0 ? rest.slice(cut + 3) : rest}`;
  }
  return null;
}

/**
 * 확정 조정의 '주의' 줄 — 잠정 체결의 비용 칸이 그 판의 요율로 다시 센 값과 다름(체결 처리 중에 설정이 저장됨 등). 그 계좌 리스크 점검 기록의
 * 확정 메모 가운데 '— 주의:'가 붙은 것, 같은 글은 한 번(최근 기록부터).
 */
export function krConfirmationCautions(jobs: readonly PaperJobRun[] | null | undefined, code: string): string[] {
  return [...new Set(riskNotes(jobs, code).filter((note) => note.includes("— 주의:")))];
}

/** 한국 순자산 기록 표의 한 줄. */
export interface KrNavRow {
  tradingDate: string;
  nav: string;
  cash: string;
  exposure: string;
  pricesFinal: boolean;
  /** 잠정 줄의 사유(확정 줄은 null, 잠정인데 최근 기록에 없으면 "—"). */
  reason: string | null;
}

/** 순자산 기록 → 표의 줄(최근 거래일부터). 숫자는 서버 값 그대로(원 정수·노출 %), 잠정 줄은 사유를 붙입니다({@link krNavProvisionalReason}). */
export function krNavRows(series: readonly PaperNavRow[] | null | undefined, jobs: readonly PaperJobRun[] | null | undefined,
  code: string): KrNavRow[] {
  return [...(series ?? [])].reverse().map((row) => ({
    tradingDate: row.tradingDate,
    nav: won(row.nav),
    cash: won(row.cash),
    exposure: row.exposurePct === null || row.exposurePct === undefined ? EMPTY : `${formatNumber(row.exposurePct, 1)}%`,
    pricesFinal: row.pricesFinal === true,
    reason: row.pricesFinal === true ? null : (krNavProvisionalReason(jobs, code, row.tradingDate) ?? EMPTY),
  }));
}

/**
 * 시작 전인 한국 계좌에 버튼 대신 적는 안내 — 한국은 계좌별 시작이 없고(K28) 네 계좌가 출발일 밤 결정으로 함께 다음 KR 거래일 시가에 출발합니다.
 */
export function krNotStartedNote(): string {
  return "시작 전인 한국 계좌는 따로 시작하지 않습니다 — 네 계좌가 출발일 밤 결정(정기 작업 또는 개요의 '출발 지금 실행')으로 함께 다음 KR "
    + "거래일 시가에 출발합니다(사후 체결 없음). 지금은 현금만 듭니다.";
}

/**
 * 한국 계좌 초기화(리셋)의 뜻(2단계 명세 §4-8 'C1c') — 사후 체결이 없고, 한 계좌만 지우면 그 계좌는 '시작 전'으로 남아 다시 출발하지 않으며, 네
 * 계좌를 모두 지우면 다음 KR 거래일 결정 창에서 넷이 함께 다시 출발합니다.
 */
export const KR_RESET_NOTE =
  "한국 계좌에는 사후 체결이 없습니다 — 이 계좌만 지우면 현금만 든 '시작 전'으로 남고 다시 출발하지 않습니다(한 계좌만 늦게 출발하는 길 없음). "
  + "네 계좌를 모두 지우면 다음 KR 거래일 결정 창에서 네 계좌가 함께 다시 출발합니다.";

// ---------------------------------------------------------------- 결정 로그(2단계 명세 §4-6·§4-9·§4-16 F2 — 여섯 게이트·기한 지남·출발)

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const stringsOf = (value: unknown): string[] => listOf(value).filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
const pct = (value: number | null, digits = 1) => (value === null ? EMPTY : `${formatNumber(value, digits)}%`);

/** 결정 종류 이름 — 한국 출발 결정(INITIAL)은 '출발(초기 결정)', 그 밖은 미국과 같은 이름. */
export function krDecisionKindLabel(kind: string | null | undefined): string {
  return kind === "INITIAL" ? "출발(초기 결정)" : decisionKindLabel(kind);
}

/**
 * 결정 목록의 가격 칸(한국) — 한국 결정은 늘 금융위 확정 전 토스 잠정가로 냅니다(`pricesFinal:false`가 정상 — 미국의 '확정 전 값' 경고색이
 * 아님). true면 받은 그대로 '확정', 모르면 "—".
 */
export function krPricesFinalText(value: boolean | null | undefined): { label: string; className: string; title?: string } {
  if (value === false) {
    return { label: "잠정(토스)", className: "text-text-3", title: "한국 결정은 늘 금융위 확정 전 — 토스 잠정 관측치로 냅니다(확정은 체결 뒤 확정 조정)." };
  }
  if (value === true) return { label: "확정", className: "text-body" };
  return { label: EMPTY, className: "text-muted" };
}

/** 결정 탭 계좌 소개(한국) — 결정 창은 설정 값이라 숫자를 박지 않습니다. */
export function krDecisionBookNote(kind: string | null | undefined): string {
  if (kind === "CLAUDE") {
    return "한국 Claude 계좌는 KR 거래일마다 결정 창(설정 kr.decisionTimeKst~kr.decisionDeadlineKst) 안에서 자료 게이트 ①~⑥이 모두 통과하면 한국 "
      + "패킷을 Claude에 보내 주문과 목표 주식 노출을 받습니다. 검증기(하드 규칙 — 체결할 수 없는 종목 매수 UNFILLABLE·1주 미만 증가분 "
      + "BUY_BELOW_ONE_SHARE 포함)가 통과시킨 주문만 다음 KR 거래일 시가에 체결합니다. 기한이 지나면 그 세션은 부르지 않고 '건너뜀'(기한 지남)으로 "
      + "남깁니다. '지금 결정 실행'은 같은 창·같은 게이트 안에서만 받고, 수동 호출 문턱(상한 − 정기 몫 예약)까지입니다.";
  }
  return "한국 규칙 계좌는 KR 거래일마다 결정 창 안에서 자료 게이트 ①~⑥이 모두 통과하면 한 번 결정합니다 — 재선정일(설정 주기)과 출발 때만 "
    + "사고, 그 밖의 날은 보유의 매도 판정(20일 누적 순매도·후보 밖)과 남는 현금만 봅니다. 기한이 지나면 그 세션은 '주문 없음'(기한 지남)이고 "
    + "재선정은 다음 KR 결정일에 따라잡습니다. 동결된 대조군이라 수동 결정 단추는 없습니다.";
}

/**
 * 한국 수동 결정을 막는 이유 — 규칙 계좌(수동 결정 없음)·시작 전(네 계좌가 함께 출발하기 전)·일시정지 중인 Claude 계좌. 아니면 null. 창 밖·게이트
 * 미달·수동 문턱은 서버가 400으로 답하고 그 문구가 그대로 보입니다.
 */
export function krDecisionRunBlocked(book: Pick<PaperBookSummary, "status" | "kind"> | null | undefined): string | null {
  if (!book) return "계좌가 없습니다.";
  if (book.kind !== "CLAUDE") return "한국 규칙 계좌는 수동 결정이 없습니다(동결된 대조군 — 정기 결정만).";
  if (book.status === "NOT_STARTED") {
    return "시작 전인 한국 계좌는 결정을 내지 않습니다 — 네 계좌가 함께 출발한 뒤(개요의 '출발 지금 실행' 또는 출발일 밤 정기 출발) 누르세요.";
  }
  if (book.status === "PAUSED") return "일시정지 중인 계좌는 결정을 내지 않습니다(Claude를 부르지 않음) — 보유·체결 탭에서 재개한 뒤 누르세요.";
  return null;
}

/** 한국 수동 결정 확인 창의 문턱 문장 — 수동 문턱(상태 응답 manualLimit)과 결정 창(설정)을 그대로 적습니다(모르면 "—"). */
export function krManualDecisionNote(manualLimit: number | null | undefined, windowText: string): string {
  const limit = typeof manualLimit === "number" ? `${formatNumber(manualLimit, 0)}회` : EMPTY;
  return `수동 호출은 그날 호출이 수동 문턱(${limit} — 하루 상한 − 정기 몫 예약) 미만일 때만, 결정 창(${windowText}) 안에서 같은 자료 게이트를 `
    + "통과해야 부릅니다 — 아니면 서버가 거절하고 그 문구가 아래에 보입니다.";
}

/** 자료 게이트 한 줄(①~⑥ — 서버 판정 그대로). */
export interface KrGateRow {
  key: string;
  gate: string;
  /** PASS·FAIL(모르는 값은 받은 글자). */
  status: string;
  badge: Badge;
  note: string;
  /** ③의 창 구멍 문구('kr.calendar.extraClosures에 더함')가 있나 — 화면이 설정 탭 링크를 붙입니다. */
  extraClosures: boolean;
}

/** 게이트 판정 목록(`[{gate, status, note}]`) → 줄. 모양이 틀린 항목은 건너뜁니다. */
export function krGateRows(value: unknown): KrGateRow[] {
  return listOf(value).filter(isRecord).flatMap((gate, index) => {
    const id = textOf(gate.gate);
    if (!id) return [];
    const status = textOf(gate.status) ?? EMPTY;
    const note = textOf(gate.note) ?? EMPTY;
    return [{
      key: `${index}-${id}`,
      gate: id,
      status,
      badge: status === "PASS"
        ? { key: "pass", label: "통과", className: toneClass("ok") }
        : status === "FAIL"
          ? { key: "fail", label: "미달", className: toneClass("warn") }
          : { key: "unknown", label: status, className: toneClass("muted") },
      note,
      extraClosures: note.includes("kr.calendar.extraClosures"),
    }];
  });
}

/** 한국 결정 응답의 공통 칸 — 자료 게이트·기한 지남·출발(규칙·Claude 계좌가 같은 이름으로 남김). */
export interface KrDecisionExtras {
  gates: KrGateRow[];
  /** 기한이 지난 세션의 행(`pastDeadline:true`) — 아니면 null. */
  pastDeadline: {
    deadline: string;
    /** 그 판정이 무엇이었나(gatesBasis — '기한 전 마지막 판정' 등). 일시정지 SKIPPED처럼 없으면 null. */
    basis: string | null;
    judgedAt: string | null;
    /** 기다린 게이트(미달 게이트의 '번호 사유'). */
    waitedFor: string[];
    /** 규칙 계좌 noTradeReason · Claude skippedReason. */
    reason: string | null;
  } | null;
  /** 출발 결정(INITIAL)의 칸 — 설정 출발일·미룸·출발 호출 수(Claude). 출발이 아니면 null. */
  start: { configuredStartDate: string; postponed: boolean | null; startCalls: number | null } | null;
}

/** 한국 결정 응답 → 공통 칸. 모르는 값은 "—"(0·다른 날로 채우지 않음). */
export function krDecisionExtras(response: unknown): KrDecisionExtras {
  const record = isRecord(response) ? response : {};
  const past = record.pastDeadline === true;
  const configured = textOf(record.configuredStartDate);
  return {
    gates: krGateRows(record.gates),
    pastDeadline: past
      ? {
        deadline: formatKst(textOf(record.deadlineKst)),
        basis: textOf(record.gatesBasis),
        judgedAt: textOf(record.gatesJudgedAtKst) ? formatKst(textOf(record.gatesJudgedAtKst)) : null,
        waitedFor: stringsOf(record.waitedFor),
        reason: textOf(record.noTradeReason) ?? textOf(record.skippedReason),
      }
      : null,
    start: configured !== null || typeof record.postponed === "boolean"
      ? {
        configuredStartDate: configured ?? EMPTY,
        postponed: typeof record.postponed === "boolean" ? record.postponed : null,
        startCalls: numberOf(record.startCalls),
      }
      : null,
  };
}

/** 한국 규칙 계좌 결정의 선정 요약 칸 하나. */
export interface KrCell {
  key: string;
  label: string;
  value: string;
}

/** 한국 규칙 계좌 결정 상세. */
export interface KrRuleDecisionView {
  recognized: boolean;
  extras: KrDecisionExtras;
  /** 선정 요약 칸(재선정일·주기·선정 기준일·따라잡기·주식/153130 비중·후보 수) — 선정 칸이 없으면 빈 목록. */
  selection: KrCell[];
  /** 선정 칸의 안내(재선정일이 아닌 날 — '후보·점수는 참고'). */
  selectionNote: string | null;
  targets: { key: string; code: string; rank: string; score: string; weight: string }[];
  candidates: { key: string; code: string; rank: string; score: string }[];
  /** 후보를 다 보이지 않을 때 뺀 수. */
  candidatesMore: number;
  exclusions: { key: string; reason: string; count: string }[];
  holdings: { key: string; code: string; qty: string; weight: string; sell: string; reasons: string }[];
  skipped: { key: string; ticker: string; reason: string }[];
  /** 처리 메모 — 서버 문장 그대로('지금은 체결할 수 없음' 등). */
  notes: string[];
  /** 입력 요약(세션·읽은 시각·U 기준일·수급 창·금융업 표 판). 입력 칸이 없으면 빈 목록. */
  input: KrCell[];
}

/** 결정 시각 뒤에 알 수 있던 수급 기록(입력 동결에서 뺀 것)의 갈래 이름 — 서버 키(excludedFlowRecords)를 사람이 읽는 말로. 모르는 키는 그대로. */
const EXCLUDED_FLOW_LABELS: Readonly<Record<string, string>> = {
  afterSession: "기준 세션 뒤 날짜",
  fetchedAfterRead: "읽은 순간 뒤에 받음",
  unknownFetchedAt: "받은 시각 모름",
};

/** 결정 상세에 보일 후보 수(점수 순 앞부분 — 나머지는 수만, 전체는 종목 선정 탭). */
const KR_CANDIDATES_SHOWN = 10;

/**
 * 한국 규칙 계좌(`kr_rules`) 결정 응답 → 상세(docs/API.md 결정 한 건의 '한국 규칙 계좌'). 숫자·판정은 서버 값 그대로이고 모양이 틀린 칸은 "—"·빈
 * 목록입니다. 책 코드가 kr_rules가 아니면 recognized:false.
 */
export function krRuleDecisionView(book: string | null | undefined, response: unknown): KrRuleDecisionView {
  const record = isRecord(response) ? response : {};
  const selection = isRecord(record.selection) ? record.selection : null;
  const input = isRecord(record.input) ? record.input : null;
  const candidatesAll = listOf(selection?.candidates).filter(isRecord);
  const selectionDay = record.selectionDay === true;

  const cells: KrCell[] = [];
  // 선정 칸이 없는 행(기한 지남·일시정지)은 그날이 재선정일이었을 때만 그 사실을 적습니다(아니면 '재선정일 아니오'만 남아 선정이 있었던 듯 읽힘).
  if (selection || selectionDay) {
    cells.push({ key: "selectionDay", label: "재선정일", value: selectionDay ? "예" : "아니오" });
    if (selectionDay) {
      cells.push({ key: "cycleDate", label: "재선정 주기 예정일", value: textOf(record.cycleDate) ?? EMPTY });
      cells.push({ key: "selectionAsOf", label: "선정 기준일", value: textOf(record.selectionAsOf) ?? EMPTY });
      cells.push({ key: "catchUp", label: "따라잡기", value: record.catchUp === true ? "예(놓친 재선정을 이 결정일에)" : "아니오" });
    }
    if (selection) {
      cells.push({ key: "candidates", label: "후보 수", value: `${formatNumber(candidatesAll.length, 0)}종목` });
      const maxNames = numberOf(selection.maxNames);
      cells.push({ key: "maxNames", label: "매수 종목 수 상한", value: maxNames === null ? EMPTY : `${formatNumber(maxNames, 0)}종목` });
      cells.push({ key: "weighting", label: "배분", value: textOf(selection.weighting) ?? EMPTY });
      if (selectionDay) {
        cells.push({ key: "stockWeight", label: "주식 비중", value: pct(numberOf(selection.stockWeightPct), 2) });
        cells.push({ key: "parkingWeight", label: "153130 비중", value: pct(numberOf(selection.parkingWeightPct), 2) });
      }
    }
  }

  const exclusions = isRecord(selection?.exclusionCounts)
    ? Object.entries(selection.exclusionCounts).map(([reason, count], index) => ({
      key: `${index}-${reason}`, reason, count: `${formatNumber(numberOf(count), 0)}종목`,
    }))
    : [];

  const inputCells: KrCell[] = [];
  if (input) {
    const universe = isRecord(input.universe) ? input.universe : null;
    const window = isRecord(input.flowsWindow) ? input.flowsWindow : null;
    const excluded = isRecord(input.excludedFlowRecords) ? input.excludedFlowRecords : null;
    inputCells.push({ key: "session", label: "세션", value: textOf(input.session) ?? EMPTY });
    inputCells.push({ key: "readAt", label: "입력을 읽은 순간", value: formatKst(textOf(input.readAtKst)) });
    inputCells.push({
      key: "universe", label: "유니버스 U",
      value: `기준일 ${textOf(universe?.baseDate) ?? EMPTY} · ${formatNumber(numberOf(universe?.size), 0)}종목`,
    });
    inputCells.push({
      key: "flowsWindow", label: "수급 창",
      value: `${textOf(window?.from) ?? EMPTY} ~ ${textOf(window?.to) ?? EMPTY}(${formatNumber(numberOf(window?.tradingDays), 0)} KR 거래일)`,
    });
    inputCells.push({ key: "financialSectorTable", label: "금융업 코드 표 판", value: textOf(input.financialSectorTable) ?? EMPTY });
    if (excluded) {
      const parts = Object.entries(excluded).map(([name, count]) => `${EXCLUDED_FLOW_LABELS[name] ?? name} ${formatNumber(numberOf(count), 0)}`);
      inputCells.push({ key: "excluded", label: "결정 뒤에 알 수 있던 수급 기록(뺌)", value: parts.length > 0 ? parts.join(" · ") : EMPTY });
    }
    const suspended = stringsOf(input.suspended);
    inputCells.push({ key: "suspended", label: "거래정지", value: suspended.length > 0 ? suspended.join(", ") : "없음" });
  }

  return {
    recognized: book === "kr_rules",
    extras: krDecisionExtras(record),
    selection: cells,
    selectionNote: textOf(selection?.note)
      ?? (!selection && selectionDay ? "이 세션은 선정하지 않음 — 재선정은 다음 KR 결정일에 그날 자료로(따라잡기)" : null),
    targets: listOf(selection?.targets).filter(isRecord).map((target, index) => ({
      key: `${index}-${textOf(target.code) ?? ""}`,
      code: textOf(target.code) ?? EMPTY,
      rank: formatNumber(numberOf(target.rankInPlan), 0),
      score: formatNumber(numberOf(target.score), 4),
      weight: pct(numberOf(target.weightPct), 2),
    })),
    candidates: candidatesAll.slice(0, KR_CANDIDATES_SHOWN).map((candidate, index) => ({
      key: `${index}-${textOf(candidate.code) ?? ""}`,
      code: textOf(candidate.code) ?? EMPTY,
      rank: formatNumber(numberOf(candidate.universeRank), 0),
      score: formatNumber(numberOf(candidate.score), 4),
    })),
    candidatesMore: Math.max(0, candidatesAll.length - KR_CANDIDATES_SHOWN),
    exclusions,
    holdings: listOf(record.holdings).filter(isRecord).map((holding, index) => ({
      key: `${index}-${textOf(holding.code) ?? ""}`,
      code: textOf(holding.code) ?? EMPTY,
      qty: formatNumber(numberOf(holding.qty), 0),
      weight: pct(numberOf(holding.weightPct), 2),
      sell: holding.sell === true ? "매도" : holding.sell === false ? "보유" : EMPTY,
      reasons: stringsOf(holding.reasons).join(" · ") || EMPTY,
    })),
    skipped: listOf(record.skipped).filter(isRecord).map((entry, index) => ({
      key: `${index}-${textOf(entry.ticker) ?? ""}`,
      ticker: textOf(entry.ticker) ?? EMPTY,
      reason: textOf(entry.reason) ?? EMPTY,
    })),
    notes: stringsOf(record.notes),
    input: inputCells,
  };
}

/** 한국 사건 줄(패킷 11b_events.items) 하나. 제목은 패킷 글(`text`)에만 있어 여기에는 없습니다. */
export interface KrEventRow {
  key: string;
  k: string;
  source: string;
  /** 알 수 있는 시각(KST) 또는 발행 날짜(날짜만 주는 피드). */
  when: string;
  matched: string;
  /** 시각이 창 시작보다 앞인 줄 — 결정 순간 뒤에 받아 이번 창에 든 제목(블록 시각은 발행 시각이라 창 앞일 수 있음). */
  beforeWindow: boolean;
}

/** 문자열 JSON — 읽지 못하면 null. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 한국 Claude 결정 패킷(객체 또는 보낸 문자열)의 사건 섹션(11b_events) → 창·시각 문구·줄. 섹션이 없으면 null. */
export function krEventsView(packet: unknown): {
  window: string; timeNote: string | null; text: string | null; rows: KrEventRow[];
} | null {
  const parsed = typeof packet === "string" ? parseJson(packet) : packet;
  const section = isRecord(parsed) && isRecord(parsed["11b_events"]) ? parsed["11b_events"] : null;
  if (!section) return null;
  const window = isRecord(section.window) ? section.window : null;
  const from = textOf(window?.from);
  const fromTime = from ? Date.parse(from) : Number.NaN;
  return {
    window: `${from ? formatKst(from) : EMPTY} ~ ${textOf(window?.to) ? formatKst(textOf(window?.to)) : EMPTY}`,
    timeNote: textOf(section.timeNote),
    text: textOf(section.text),
    rows: listOf(section.items).filter(isRecord).map((item, index) => {
      const known = textOf(item.knownAtKst);
      const published = textOf(item.publishedDate);
      const knownTime = known ? Date.parse(known) : Number.NaN;
      const matched = stringsOf(item.matched);
      const more = numberOf(item.matchedMore);
      return {
        key: `${index}-${textOf(item.entity) ?? ""}`,
        k: `#${formatNumber(numberOf(item.k), 0)}`,
        source: textOf(item.source) ?? EMPTY,
        when: known ? formatKst(known) : published ? `${published}(날짜만)` : EMPTY,
        matched: matched.length > 0 ? `${matched.join(", ")}${more !== null && more > 0 ? ` 외 ${formatNumber(more, 0)}` : ""}` : EMPTY,
        beforeWindow: Number.isFinite(knownTime) && Number.isFinite(fromTime) && knownTime < fromTime,
      };
    }),
  };
}

/** 출발·게이트 기록 카드의 한 줄. */
export interface KrStartRecordRow {
  key: string;
  at: string;
  outcome: string;
  parts: string[];
}

/**
 * 출발 작업 기록(`kr.decision` 중 상세 `start:true` — 기다림 START_WAITING·미룸 START_POSTPONED·오류 ERROR·출발 STARTED)을 최근 순으로 —
 * 미룬 날·사유·과금 호출(결정 행 없이 과금된 호출)·시도 번호({@link krStartRecordParts}).
 */
export function krStartRecords(jobs: readonly PaperJobRun[] | null | undefined): KrStartRecordRow[] {
  return (jobs ?? []).filter((job) => job.job === "kr.decision" && isRecord(job.detail) && job.detail.start === true)
    .map((job, index) => ({
      key: `${index}-${job.startedAtKst ?? ""}`,
      at: formatKst(job.startedAtKst),
      outcome: job.outcome || EMPTY,
      parts: krStartRecordParts(job.detail),
    }));
}

/** 작업 기록에 남은 그 세션 마지막 게이트 판정(규칙 계좌 몫 rulesGates·Claude 계좌 몫 claudeGates — 기한 지남 행이 다시 읽는 칸). */
export interface KrJudgedGates {
  label: string;
  session: string;
  judgedAt: string;
  rows: KrGateRow[];
}

/** 가장 최근 kr.decision 기록의 rulesGates·claudeGates(각각 있는 것 중 가장 최근). 없으면 빈 목록. */
export function krLatestJudgedGates(jobs: readonly PaperJobRun[] | null | undefined): KrJudgedGates[] {
  const out: KrJudgedGates[] = [];
  for (const [key, label] of [["rulesGates", "규칙 계좌 몫"], ["claudeGates", "Claude 계좌 몫"]] as const) {
    const job = (jobs ?? []).find((entry) => entry.job === "kr.decision" && isRecord(entry.detail) && isRecord(entry.detail[key]));
    if (!job || !isRecord(job.detail)) continue;
    const judged = job.detail[key] as Record<string, unknown>;
    out.push({
      label,
      session: textOf(job.detail.tradingDate) ?? EMPTY,
      judgedAt: formatKst(textOf(judged.judgedAtKst)),
      rows: krGateRows(judged.gates),
    });
  }
  return out;
}

// ---------------------------------------------------------------- 주간 복기(2단계 명세 §3 D1~D6 한국 판 — E3, F2)

/** 한국 복기가 언제 생기는지(서버 PaperReviewJob의 한국 조건). 미국 문구(lib/paper REVIEW_SCHEDULE_NOTE)는 그대로입니다. */
export const KR_REVIEW_SCHEDULE_NOTE =
  "토요일 22:30 KST — 그 주 마지막 KR 거래일(금요일, 휴장이면 목요일)의 잠정 종가 순자산 줄로 열리고, 놓치면 다음 기동 첫 주기에 한 번 — "
  + "지난 4주(입력이 크면 2주) 한국 Claude 계좌 결정을 그 뒤 가격과 대조합니다. 수익률·낙폭·스탑·가정 진입은 서버가 계산하고 Claude는 "
  + "판정만 합니다. 제안은 프레임 탭에 '승인 대기'로 들어가고 자동 반영은 없습니다. 규칙 계좌는 바꾸지 않습니다.";

/** 한국 수동 복기 확인 창의 문턱 문장 — 수동 문턱(상태 응답 manualLimit)을 그대로(모르면 "—"). */
export function krManualReviewNote(manualLimit: number | null | undefined): string {
  const limit = typeof manualLimit === "number" ? `${formatNumber(manualLimit, 0)}회` : EMPTY;
  return `수동 복기는 그날 호출이 수동 문턱(${limit} — 하루 상한 − 정기 몫 예약) 미만일 때만 부릅니다(토요일 22:30 시각 조건 없음 — 나머지 조건은 `
    + "정기 복기와 같음). 아니면 서버가 거절하고 그 문구가 아래에 보입니다.";
}

/** 한국 복기 목록이 비었을 때. */
export const KR_REVIEW_EMPTY =
  "아직 한국 복기가 없습니다 — 한국 Claude 계좌가 출발한 다음 토요일 22:30(KST) 뒤에 첫 복기가 생깁니다.";

/** 가장 최근 복기 주를 셀 수 없을 때(달력 없음)의 한 줄 — 사유가 없으면 null. */
export function krLatestWeekReasonText(latestWeekEnding: string | null | undefined, reason: string | null | undefined): string | null {
  if (latestWeekEnding || !reason) return null;
  return `가장 최근 복기 주 ${EMPTY} — ${reason}`;
}

/** 가정 진입 출처 배지 — 금융위 확정 시가(FSC·FSC_ETF)·토스 잠정 시가(TOSS_*), 모르면 없음. */
function entrySourceBadge(source: string | null): Badge | null {
  if (source === "FSC" || source === "FSC_ETF") {
    return { key: "fsc", label: "금융위 확정 시가", className: toneClass("ok"),
      title: `${source === "FSC_ETF" ? "금융위 증권상품시세" : "금융위 주식시세"} 시가(확정)` };
  }
  if (source && source.startsWith("TOSS_")) {
    return { key: "toss", label: "토스 잠정 시가", className: toneClass("info"),
      title: `${krPriceSourceLabel(source)} — 금융위 확정 전 값(확정가와 조금 다를 수 있음)` };
  }
  return null;
}

/** 거절된 매도의 판 뒤 변화 표시(서버 ReviewFacts.AVOIDED·MISSED·FLAT — 반올림한 값의 부호). 모르는 값은 받은 글자 그대로. */
const AFTER_SELL_LABEL: Readonly<Record<string, string>> = {
  avoided: "피한 하락",
  missed: "놓친 상승",
  flat: "변화 없음",
};

/** 가정 진입 표의 안내 — 매수·매도 모두 '체결됐다고 가정'이고, 매도의 값은 판 뒤 변화(음수 = 피한 하락)입니다. */
export const KR_REVIEW_ENTRY_NOTE =
  "거절된 주문(매수·매도)이 결정 다음 세션 시가에 체결됐다고 가정한 값입니다(비용 제외) — 변화는 기준일 종가 ÷ 진입가 − 1로, 매수면 가정 "
  + "수익률, 매도면 판 뒤 변화(음수 = 피한 하락, 양수 = 놓친 상승)입니다. 진입가는 금융위 확정 시가, 없으면 토스 잠정 시가, 그 세션 시가가 "
  + "없으면 종가 근사.";

/** 복기 입력의 가정 진입 한 줄(거절 주문이 결정 다음 세션 시가에 체결됐다고 가정한 값 — 비용 제외, 매수·매도 모두). */
export interface KrReviewEntryRow {
  key: string;
  decision: string;
  ticker: string;
  /** 방향 이름(매수·매도). */
  side: string;
  /** 방향 코드(BUY·SELL — 글자색), 모르면 null. */
  sideCode: string | null;
  status: string;
  rejectReason: string;
  entryDate: string;
  entryPrice: string;
  /** 기준일 종가 ÷ 진입가 − 1(서버 값) — 매수면 가정 수익률, 매도면 판 뒤 변화. */
  returnPct: string;
  /** 매도만 — 판 뒤 변화의 뜻(피한 하락·놓친 상승·변화 없음, 서버 afterSellLabel). 매수·값 없음은 null. */
  afterSell: string | null;
  /** 진입가나 변화가 없을 때 그 이유(주문 notes — {@link krHypotheticalReason}). 둘 다 있으면 null. */
  reason: string | null;
  badges: Badge[];
}

/**
 * 가정 진입 값(진입가·변화)이 없는 이유 — 서버가 null을 돌려주기 전에 주문 `notes`에 남긴 '가정 수익률: …'(머리 떼고, 근사(isProxy) 안내는
 * 값이 있는 갈래라 뺌)과 기준일 종가가 없을 때의 '복기 기준일(…) 종가 없음 — …'·'가격 이력 없음 — …'(ReviewFacts). 값이 다 있거나 이유가 없으면 null.
 */
function krHypotheticalReason(order: Record<string, unknown>, entryPrice: number | null, returnPct: number | null): string | null {
  if (entryPrice !== null && returnPct !== null) return null;
  const head = "가정 수익률: ";
  const notes = stringsOf(order.notes);
  const reasons = [
    ...notes.filter((note) => note.startsWith(head) && !note.includes("(isProxy)")).map((note) => note.slice(head.length)),
    ...notes.filter((note) => note.startsWith("복기 기준일(") || note.startsWith("가격 이력 없음")),
  ];
  return reasons.length > 0 ? reasons.join(" · ") : null;
}

/**
 * 한국 복기 입력(`review.input`)의 결정별 주문 가운데 가정 진입(`hypothetical` — 거절 주문, 매수·매도)이 있는 것 → 표의 줄. 진입가는 원, 변화는
 * 서버 값 그대로이고(매도면 판 뒤 변화 — 뜻은 `afterSell`), 출처 배지(금융위 확정 시가·토스 잠정 시가)와 '종가 근사'(isProxy — 그 세션 시가가
 * 없어 종가로 근사)를 붙입니다. 모양이 틀리면 빈 목록.
 */
export function krReviewInputRows(input: unknown): KrReviewEntryRow[] {
  if (!isRecord(input)) return [];
  const rows: KrReviewEntryRow[] = [];
  listOf(input.decisions).filter(isRecord).forEach((decision) => {
    listOf(decision.orders).filter(isRecord).forEach((order) => {
      const hypo = isRecord(order.hypothetical) ? order.hypothetical : null;
      if (!hypo) return;
      const badges: Badge[] = [];
      const source = entrySourceBadge(textOf(hypo.entrySource));
      if (source) badges.push(source);
      if (hypo.isProxy === true) {
        badges.push({ key: "proxy", label: "종가 근사", className: toneClass("warn"),
          title: "결정 다음 세션 시가가 없어 그 세션 종가로 근사했습니다(isProxy)." });
      }
      const side = textOf(order.side);
      const afterSell = side === "SELL" ? textOf(hypo.afterSellLabel) : null;
      const entryPrice = numberOf(hypo.entryPrice);
      const returnPct = numberOf(hypo.returnPct);
      rows.push({
        key: `${numberOf(decision.id) ?? "?"}-${numberOf(order.id) ?? rows.length}`,
        decision: `#${numberOf(decision.id) ?? EMPTY} (${textOf(decision.asOf) ?? EMPTY})`,
        ticker: textOf(order.ticker) ?? EMPTY,
        side: sideLabel(side),
        sideCode: side,
        status: textOf(order.status) ?? EMPTY,
        rejectReason: rejectReasonText(textOf(order.rejectReason)).label,
        entryDate: textOf(hypo.entryDate) ?? EMPTY,
        entryPrice: won(entryPrice),
        returnPct: formatPercent(returnPct),
        afterSell: afterSell === null ? null : (AFTER_SELL_LABEL[afterSell] ?? afterSell),
        reason: krHypotheticalReason(order, entryPrice, returnPct),
        badges,
      });
    });
  });
  return rows;
}

/**
 * 복기 입력의 계좌 수익률 비교(`comparison`) — 구간·설명·계좌별 수익률과 '잠정 줄 포함'(isEstimated) 배지, 수익률이 없으면 서버 사유(`reason` —
 * '순자산 기록 없음'·'복기 기준일(…) 순자산 없음'·'공통 시작일 순자산 없음'). 계좌는 이름(`labels` — 개요의 계좌 이름, 모르면 코드)이고 코드는 `code`.
 * 없으면 null.
 */
export function krReviewComparison(input: unknown, labels?: ReadonlyMap<string, string>): {
  range: string; note: string | null;
  rows: { key: string; book: string; code: string; returnPct: string; reason: string | null; badges: Badge[] }[];
} | null {
  const comparison = isRecord(input) && isRecord(input.comparison) ? input.comparison : null;
  if (!comparison) return null;
  return {
    range: `${textOf(comparison.from) ?? EMPTY} → ${textOf(comparison.to) ?? EMPTY}`,
    note: textOf(comparison.note),
    rows: listOf(comparison.books).filter(isRecord).map((row, index) => ({
      key: `${index}-${textOf(row.book) ?? ""}`,
      book: labels?.get(textOf(row.book) ?? "") ?? textOf(row.book) ?? EMPTY,
      code: textOf(row.book) ?? EMPTY,
      returnPct: formatPercent(numberOf(row.returnPct)),
      reason: numberOf(row.returnPct) === null ? textOf(row.reason) : null,
      badges: row.isEstimated === true
        ? [{ key: "estimated", label: "잠정 줄 포함", className: toneClass("warn"),
          title: "금융위 확정 종가가 아닌(토스 잠정) 순자산 줄을 썼습니다 — 확정되면 값이 조금 바뀔 수 있습니다." }]
        : [],
    })),
  };
}

// ---------------------------------------------------------------- 종목 선정 탭(2단계 명세 §4-6·§5·§6 — 한국 규칙 계좌 재선정)

/** 종목 선정 탭이 읽는 결정 기록 수(최근 순) — 재선정은 한 달에 한두 번이라 50건이면 가장 최근 선정이 들어 있습니다. */
export const KR_SELECTION_LIMIT = 50;

/** '자료 없음' 사유 이름(백엔드 KrRules.Reason.NO_DATA의 이름표). */
const NO_DATA_REASON = "자료 없음";
/** 부채비율로 빠진 표 밖 회사에 '유동자산' 계정이 없을 때 사유에 붙는 경고(백엔드 KrRules.FINANCIAL_TABLE_CHECK). */
export const KR_FINANCIAL_TABLE_CHECK = "금융업 코드 표 확인 필요";

/** 종목 선정 탭이 읽는 두 결정 — 선정한 가장 최근 결정(재선정·출발)과 가장 최근 결정(목록 첫 줄). */
export interface KrSelectionPicks {
  selection: PaperDecisionSummary | null;
  latest: PaperDecisionSummary | null;
}

/**
 * 한국 규칙 계좌 결정 목록(최근 순) → 선정한 가장 최근 결정과 가장 최근 결정. 선정한 결정은 결정 행의 `selectionAsOf`가 있는 것입니다(서버가 선정한
 * 결정 — 재선정 REBALANCE·출발 INITIAL — 에만 채움, docs/API.md 결정 목록). 번호가 없는 줄은 건너뜁니다.
 */
export function krSelectionPicks(decisions: readonly PaperDecisionSummary[] | null | undefined): KrSelectionPicks {
  const list = listOf(decisions).filter(isRecord).filter((row) => numberOf(row.id) !== null) as unknown as PaperDecisionSummary[];
  return {
    selection: list.find((row) => textOf(row.selectionAsOf) !== null) ?? null,
    latest: list[0] ?? null,
  };
}

/** 구성원의 빠진 사유 하나(서버 문장 그대로). */
export interface KrMemberReason {
  reason: string;
  sub: string;
  detail: string;
}

/** 유니버스 구성원 한 줄 — 정렬용 원래 값과 화면 글(`text`). 모르는 값은 null·"—". */
export interface KrMemberRow {
  key: string;
  rank: number | null;
  code: string;
  name: string;
  marketCap: number | null;
  foreign20: number | null;
  institution20: number | null;
  foreign5: number | null;
  institution5: number | null;
  streak: number | null;
  /** 20거래일 창에서 수급 기록이 있는 날 수. */
  flowDays: number | null;
  roePct: number | null;
  debtRatioPct: number | null;
  /** 금융업 코드 표의 회사인가(부채비율 상한을 보지 않음). DART 칸이 없으면 null. */
  financialSector: boolean | null;
  score: number | null;
  candidate: boolean | null;
  /** 이번 선정의 목표(산 종목)인가. */
  target: boolean;
  reasons: KrMemberReason[];
  /** 사유에 '금융업 코드 표 확인 필요'가 든 줄. */
  financialCheck: boolean;
  text: {
    rank: string;
    marketCap: string;
    foreign20: string;
    institution20: string;
    foreign5: string;
    institution5: string;
    streak: string;
    roe: string;
    debtRatio: string;
    financial: string;
    score: string;
    candidate: string;
    reasons: string;
  };
}

/** 값 ÷ 단위(모르면 null). */
const scaled = (value: number | null, unit: number) => (value === null ? null : value / unit);

/** 구성원 사유 한 줄 — "수급 미달 — 문장"(세부 사유는 문장 앞머리에 이미 있음). */
function memberReasonText(reason: KrMemberReason): string {
  return reason.detail ? `${reason.reason} — ${reason.detail}` : reason.reason;
}

/** 한 종목의 짧은 이름표("005930 삼성전자", 이름을 모르면 코드만). */
function codeName(code: string, names: ReadonlyMap<string, string>): string {
  const name = names.get(code);
  return name ? `${code} ${name}` : code;
}

/** 결정 입력의 구성원(`input.members`) → 줄. 모양이 틀린 줄은 건너뜁니다. 목표 종목은 `targets`의 코드로 표시합니다. */
function krMemberRows(members: unknown, targetCodes: ReadonlySet<string>): KrMemberRow[] {
  return listOf(members).filter(isRecord).flatMap((member, index) => {
    const code = textOf(member.code);
    if (!code) return [];
    const flows = isRecord(member.flows) ? member.flows : {};
    const dart = isRecord(member.dart) ? member.dart : null;
    const reasons: KrMemberReason[] = listOf(member.reasons).filter(isRecord).map((entry) => ({
      reason: textOf(entry.reason) ?? EMPTY,
      sub: textOf(entry.sub) ?? "",
      detail: textOf(entry.detail) ?? "",
    }));
    const rank = numberOf(member.rank);
    const streak = numberOf(flows.streak);
    const roePct = numberOf(dart?.roePct);
    const debtRatioPct = numberOf(dart?.debtRatioPct);
    const financialSector = dart && typeof dart.financialSector === "boolean" ? dart.financialSector : null;
    const score = numberOf(member.score);
    const candidate = typeof member.candidate === "boolean" ? member.candidate : null;
    const row: KrMemberRow = {
      key: `${index}-${code}`,
      rank,
      code,
      name: textOf(member.name) ?? EMPTY,
      marketCap: numberOf(member.marketCap),
      foreign20: numberOf(flows.foreign20),
      institution20: numberOf(flows.institution20),
      foreign5: numberOf(flows.foreign5),
      institution5: numberOf(flows.institution5),
      streak,
      flowDays: numberOf(flows.days),
      roePct,
      debtRatioPct,
      financialSector,
      score,
      candidate,
      target: targetCodes.has(code),
      reasons,
      financialCheck: reasons.some((entry) => entry.detail.includes(KR_FINANCIAL_TABLE_CHECK)),
      text: {
        rank: formatNumber(rank, 0),
        // 한 열은 한 단위(PRINCIPLES — 같은 화면은 같은 단위): 시총은 조 원 소수 둘째, 순매수는 주 정수에 부호(만 주로 줄이면 작은 값의 부호가
        // 사라져 '둘 다 0보다 큼' 판정을 읽을 수 없음).
        marketCap: formatNumber(scaled(numberOf(member.marketCap), 1e12), 2),
        foreign20: formatSigned(numberOf(flows.foreign20), 0),
        institution20: formatSigned(numberOf(flows.institution20), 0),
        foreign5: formatSigned(numberOf(flows.foreign5), 0),
        institution5: formatSigned(numberOf(flows.institution5), 0),
        streak: streak === null ? EMPTY : `${formatNumber(streak, 0)}일`,
        roe: pct(roePct, 1),
        debtRatio: pct(debtRatioPct, 1),
        financial: financialSector === true ? "금융업 표" : financialSector === false ? "표 밖" : EMPTY,
        score: formatNumber(score, 4),
        candidate: targetCodes.has(code) ? "매수 목표" : candidate === true ? "후보" : candidate === false ? "제외" : EMPTY,
        reasons: reasons.length > 0 ? reasons.map(memberReasonText).join(" · ") : EMPTY,
      },
    };
    return [row];
  });
}

/** 종목 하나에 붙는 사유 줄(경고·자료 없음 목록). */
export interface KrMemberNote {
  key: string;
  label: string;
  detail: string;
}

/** 종목 선정 탭 본문. */
export interface KrSelectionView {
  /** 한국 규칙 계좌 결정이고 입력 구성원(`input.members`)이 있나 — 아니면 화면은 '모양이 다름'만 적습니다. */
  recognized: boolean;
  /** 머리 칸 — 결정 번호·기준 거래일·종류·선정 기준일·결정 시각. */
  head: KrCell[];
  /** 결정 행 요약(서버 문장). */
  summary: string | null;
  /** 선정 요약 칸(재선정일·주기·선정 기준일·따라잡기·후보 수·상한·배분·주식/153130 비중 — krRuleDecisionView 그대로). */
  cells: KrCell[];
  /** 선정 안내(재선정일이 아닌 날 — '후보·점수는 참고'). */
  cellsNote: string | null;
  targets: { key: string; rank: string; code: string; name: string; score: string; weight: string }[];
  /** 후보였지만 고르지 않은 종목(상한·배분 밖). */
  notChosen: string[];
  exclusions: { key: string; reason: string; count: string }[];
  /** 입력 칸(유니버스·수급 창·수급 저장본·DART·금융업 표 판·뺀 수급 기록·거래정지·재진입 금지). */
  input: KrCell[];
  members: KrMemberRow[];
  /** 사유에 '금융업 코드 표 확인 필요'가 든 종목 — 위에 경고로 모읍니다. */
  financialChecks: KrMemberNote[];
  /** '자료 없음'(DART·접수일·ROE·부채비율·상장주식수)으로 빠진 종목과 사유. */
  noData: KrMemberNote[];
  /** 처리 메모(서버 문장 그대로). */
  notes: string[];
}

const EMPTY_SELECTION: Omit<KrSelectionView, "recognized" | "head" | "summary"> = {
  cells: [], cellsNote: null, targets: [], notChosen: [], exclusions: [], input: [], members: [], financialChecks: [], noData: [], notes: [],
};

/**
 * 한국 규칙 계좌의 선정한 결정(재선정·출발) 한 건 → 종목 선정 탭 본문(docs/API.md 결정 한 건의 '한국 규칙 계좌' — 입력 동결본
 * `input.members`·선정 `selection`). 숫자·판정은 서버 값 그대로이고, 화면은 고르고 이름을 붙여 늘어놓기만 합니다. 모양이 틀린 칸은 "—"·빈 목록.
 */
export function krSelectionView(decision: PaperDecisionDetail | null | undefined): KrSelectionView {
  const record = isRecord(decision?.response) ? (decision?.response as Record<string, unknown>) : {};
  const input = isRecord(record.input) ? record.input : null;
  const selection = isRecord(record.selection) ? record.selection : null;
  const head: KrCell[] = decision
    ? [
      { key: "id", label: "결정", value: `#${formatNumber(numberOf(decision.id), 0)}` },
      { key: "asOf", label: "기준 거래일", value: textOf(decision.asOfTradingDate) ?? EMPTY },
      { key: "kind", label: "종류", value: krDecisionKindLabel(textOf(decision.kind)) },
      { key: "selectionAsOf", label: "선정 기준일", value: textOf(decision.selectionAsOf) ?? EMPTY },
      { key: "decidedAt", label: "결정 시각", value: formatKst(textOf(decision.decidedAtKst)) },
    ]
    : [];
  const summary = textOf(decision?.summary);
  const recognized = decision?.book === "kr_rules" && input !== null && Array.isArray(input.members);
  if (!recognized) return { recognized: false, head, summary, ...EMPTY_SELECTION };

  const rules = krRuleDecisionView("kr_rules", record);
  const targetCodes = new Set(listOf(selection?.targets).filter(isRecord).map((target) => textOf(target.code)).filter(
    (code): code is string => code !== null,
  ));
  const members = krMemberRows(input.members, targetCodes);
  const names = new Map(members.filter((row) => row.name !== EMPTY).map((row) => [row.code, row.name]));

  const inputCells: KrCell[] = [...rules.input];
  const flowsStatus = isRecord(input.flowsStatus) ? input.flowsStatus : null;
  inputCells.push({
    key: "flowsStatus",
    label: "수급 저장본",
    value: flowsStatus
      ? `수집 ${formatKst(textOf(flowsStatus.collectedAtKst))} · 세션 ${textOf(flowsStatus.session) ?? EMPTY} · U 기준일 `
        + `${textOf(flowsStatus.universeDate) ?? EMPTY}`
      : EMPTY,
  });
  const dart = isRecord(input.dart) ? input.dart : null;
  inputCells.push({
    key: "dart",
    label: "DART 저장본",
    value: dart
      ? `수집 ${formatKst(textOf(dart.collectedAtKst))} · ${formatNumber(numberOf(dart.companies), 0)}개사`
        + `${textOf(dart.receiptRule) ? ` · ${textOf(dart.receiptRule)}` : ""}`
      : EMPTY,
  });
  const rule = isRecord(input.universe) ? textOf(input.universe.rule) : null;
  if (rule) inputCells.push({ key: "universeRule", label: "U 규칙 판", value: rule });
  const lockedOut = listOf(input.lockedOut).filter(isRecord).map((entry) => {
    const code = textOf(entry.code) ?? EMPTY;
    return `${codeName(code, names)}(~${textOf(entry.until) ?? EMPTY})`;
  });
  inputCells.push({ key: "lockedOut", label: "재진입 금지", value: lockedOut.length > 0 ? lockedOut.join(", ") : "없음" });

  return {
    recognized: true,
    head,
    summary,
    cells: rules.selection,
    cellsNote: rules.selectionNote,
    targets: listOf(selection?.targets).filter(isRecord).map((target, index) => {
      const code = textOf(target.code) ?? EMPTY;
      return {
        key: `${index}-${code}`,
        rank: formatNumber(numberOf(target.rankInPlan), 0),
        code,
        name: names.get(code) ?? EMPTY,
        score: formatNumber(numberOf(target.score), 4),
        weight: pct(numberOf(target.weightPct), 2),
      };
    }),
    notChosen: stringsOf(selection?.notChosen).map((code) => codeName(code, names)),
    exclusions: rules.exclusions,
    input: inputCells,
    members,
    financialChecks: members.filter((row) => row.financialCheck).map((row) => ({
      key: row.key,
      label: codeName(row.code, names),
      detail: row.reasons.filter((entry) => entry.detail.includes(KR_FINANCIAL_TABLE_CHECK)).map(memberReasonText).join(" · "),
    })),
    noData: members.flatMap((row) => {
      const missing = row.reasons.filter((entry) => entry.reason === NO_DATA_REASON);
      return missing.length > 0
        ? [{ key: row.key, label: codeName(row.code, names), detail: missing.map((entry) => entry.detail || entry.sub || NO_DATA_REASON).join(" · ") }]
        : [];
    }),
    notes: rules.notes,
  };
}

/**
 * 가장 최근 결정이 선정한 결정이 아닐 때의 참고 한 줄 — 그 결정의 후보(점수 순, 매일 셈)는 '참고 — 매수하지 않음'입니다(재선정일·출발 때만 삼).
 * 선정 칸이 없는 결정(기한 지남·일시정지)은 그 사실과 서버 요약을. 결정이 없으면 null.
 */
export function krSelectionReference(decision: PaperDecisionDetail | null | undefined): string | null {
  if (!decision) return null;
  const record = isRecord(decision.response) ? (decision.response as Record<string, unknown>) : {};
  const selection = isRecord(record.selection) ? record.selection : null;
  const input = isRecord(record.input) ? record.input : null;
  const head = `가장 최근 결정 ${textOf(decision.asOfTradingDate) ?? EMPTY}(#${formatNumber(numberOf(decision.id), 0)})`;
  if (!selection) {
    return `${head}은 선정 칸이 없습니다(기한 지남·일시정지 등) — ${textOf(decision.summary) ?? EMPTY}`;
  }
  const names = new Map(
    listOf(input?.members).filter(isRecord).flatMap((member) => {
      const code = textOf(member.code);
      const name = textOf(member.name);
      return code && name ? [[code, name] as [string, string]] : [];
    }),
  );
  const candidates = listOf(selection.candidates).filter(isRecord).map((entry) => textOf(entry.code)).filter(
    (code): code is string => code !== null,
  );
  const shown = candidates.slice(0, KR_CANDIDATES_SHOWN).map((code) => codeName(code, names));
  const more = candidates.length - shown.length;
  const list = candidates.length === 0 ? "후보 없음" : `${shown.join(", ")}${more > 0 ? ` 외 ${formatNumber(more, 0)}` : ""}`;
  return `참고 — 매수하지 않음: ${head}의 후보 ${formatNumber(candidates.length, 0)}종목(점수 순, 매일 셈 — 재선정일·출발 때만 삼) — ${list}`;
}
