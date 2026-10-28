/**
 * 🧪 모의매매(한국) 화면의 표기 — 출발 상태·실행 결과·작업 기록 줄. React를 모르는 순수 함수(ADR 0004).
 *
 * 숫자·판정은 전부 백엔드가 보냅니다(출발 결과·작업 기록 상세·쉬는 사유). 여기서는 받은 값을 고르고 이름을 붙여 문장으로 늘어놓기만 하고,
 * 모르는 값은 "—"로 둡니다(0이나 다른 날로 채우지 않음). 한국만의 표기라 lib/paper(미국과 공용)를 크게 만들지 않고 따로 둡니다 —
 * 이 파일이 lib/paper를 가져오고 lib/paper는 이 파일을 가져오지 않습니다(순환 방지).
 */
import { EMPTY, formatKst, formatNumber } from "./format";
import { jsonSummary, type RiskResultView, riskResultView, settingValueAt } from "./paper";
import type { PaperMarketCode } from "./paperMarket";
import type {
  PaperBookSummary,
  PaperJobRun,
  PaperKrCollection,
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
      key: "news", item: "사건 뉴스", source: "RSS(한국은행·재정경제부·국가데이터처·연합뉴스) · kr_news_headlines",
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
