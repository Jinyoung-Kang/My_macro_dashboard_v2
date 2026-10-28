/**
 * 🧪 모의매매(한국) 화면의 표기 — 출발 상태·실행 결과·작업 기록 줄. React를 모르는 순수 함수(ADR 0004).
 *
 * 숫자·판정은 전부 백엔드가 보냅니다(출발 결과·작업 기록 상세·쉬는 사유). 여기서는 받은 값을 고르고 이름을 붙여 문장으로 늘어놓기만 하고,
 * 모르는 값은 "—"로 둡니다(0이나 다른 날로 채우지 않음). 한국만의 표기라 lib/paper(미국과 공용)를 크게 만들지 않고 따로 둡니다 —
 * 이 파일이 lib/paper를 가져오고 lib/paper는 이 파일을 가져오지 않습니다(순환 방지).
 */
import { EMPTY, formatKst, formatNumber } from "./format";
import { type RiskResultView, riskResultView, settingValueAt } from "./paper";
import type {
  PaperBookSummary,
  PaperJobRun,
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
