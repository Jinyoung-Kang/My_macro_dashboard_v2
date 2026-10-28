/**
 * 🧪 모의매매(한국) 화면의 표기 — 출발 상태·실행 결과·작업 기록 줄. React를 모르는 순수 함수(ADR 0004).
 *
 * 숫자·판정은 전부 백엔드가 보냅니다(출발 결과·작업 기록 상세·쉬는 사유). 여기서는 받은 값을 고르고 이름을 붙여 문장으로 늘어놓기만 하고,
 * 모르는 값은 "—"로 둡니다(0이나 다른 날로 채우지 않음). 한국만의 표기라 lib/paper(미국과 공용)를 크게 만들지 않고 따로 둡니다 —
 * 이 파일이 lib/paper를 가져오고 lib/paper는 이 파일을 가져오지 않습니다(순환 방지).
 */
import { EMPTY, formatKst, formatNumber, formatSigned } from "./format";
import {
  type Badge,
  jsonSummary,
  positionBadges,
  type RiskResultView,
  riskResultView,
  settingValueAt,
  toneClass,
} from "./paper";
import { formatMoney, type PaperMarketCode } from "./paperMarket";
import type {
  PaperBookSummary,
  PaperConfirmationTotal,
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
    "점선 = 노출 맞춘 참고선 — 전날 규칙 계좌 주식 비중 x%를 069500 x% + 153130 (100−x)%로 맞춰 이은 선입니다(계산만 하고 계좌가 아님, "
      + "비용 없음, 금융위원회 증권상품시세 확정 종가). 규칙 계좌 결과에서 주식 노출 몫을 떼어 종목 신호 몫을 보려는 선입니다.",
    reference.asOfDate
      ? `마지막 값 ${reference.asOfDate}(그날 쓴 전날 규칙 계좌 주식 비중 ${weight === null ? EMPTY : `${formatNumber(weight, 2)}%`}) — `
        + "금융위 확정 종가가 들어온 날까지라 보통 하루 늦습니다."
      : "아직 값이 없습니다 — 금융위 확정 종가가 들어온 날부터 그립니다(보통 하루 늦음).",
  ];
  if (reference.stoppedReason) notes.push(`멈춤: ${reference.stoppedReason}`);
  notes.push("규칙 계좌의 후보 수·'자료 없음' 사유는 종목 선정 탭(한국 몫은 다음 단계)에 있습니다.");
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

/** 확정 조정 출처 이름(FSC·FSC_ETF). */
function fscDatasetLabel(source: string | null | undefined): string {
  return source === "FSC_ETF" ? "금융위 증권상품시세" : source === "FSC" ? "금융위 주식시세" : (source ?? EMPTY);
}

/**
 * 한국 체결 한 줄의 배지 — 확정 상태(확정 · 확정 대기 · 금융위 확정 미보정(ETF) · 금융위 확정 못 함)와, 잠정가가 KRX+NXT 통합가(`TOSS_INTEGRATED`)면
 * '잠정' 배지. 상태를 모르면(이 칸을 보내지 않는 서버) 상태 배지는 없습니다.
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
    badges.push({
      key: "integrated", label: "KRX+NXT 통합가 · 잠정", className: toneClass("warn"),
      title: "NXT 시간외 체결을 포함한 통합 일봉 시가입니다 — KRX 시가 단일가가 아닐 수 있어 금융위 확정가로 맞춥니다.",
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

/** 한국 체결 표의 확정 칸 — 확정가·차이·현금 차이(확정 조정 행이 없으면 셋 다 "—"). */
export function krConfirmationCells(fill: Pick<PaperFill, "confirmation">): { price: string; diff: string; cash: string } {
  const c = fill.confirmation;
  return {
    price: won(c?.confirmedPrice),
    diff: signedWon(c?.priceDiff),
    cash: signedWon(c?.cashDelta),
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
