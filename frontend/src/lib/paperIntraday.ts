/**
 * 자유 시점 판의 장중 판단(ADR 0027 결정 3) — 상태 응답 `intraday`를 화면 줄로. 계좌의 스위치가 켜져 있거나 그 세션의 계획 행이 있을 때만
 * 묶음이 오고, 없으면 화면에 아무것도 그리지 않습니다. 값은 응답 그대로이고 모르는 값은 "—"입니다(지어내지 않음).
 */
import { EMPTY } from "@/lib/format";
import { type Badge, checkpointReasonText, checkpointStatusBadge } from "@/lib/paper";
import type {
  PaperIntradayPlan,
  PaperIntradayStatus,
  PaperMarketCode,
  PaperRunIntradayResult,
} from "@/lib/types/paper";

/** 장중 판단 계획 행의 상태 — 장중 확인과 같은 낱말에 '대신함'(뒤 결정이 닫은 예약)을 더합니다. */
export function intradayStatusBadge(status: string | null | undefined): Badge {
  const badge = checkpointStatusBadge(status);
  return status === "SUPERSEDED" ? { ...badge, label: "대신함" } : badge;
}

const FEED: Record<string, string> = {
  MINUTE: "감시 1분봉",
  HOURLY: "시간별 관측치",
};

/** 장중 판단 사유 코드 가운데 장중 확인과 뜻이 다른 것. */
const INTRADAY_REASON: Record<string, string> = {
  INTRADAY_OFF: "세션당 장중 판단 횟수 설정이 0이거나 그 계좌가 꺼져 있음",
  OUT_OF_RANGE: "확인 시각이 그 세션의 받는 범위 밖",
  NO_PIPELINE: "그 계좌의 자유 시점 판 설정을 찾지 못함",
};

/** 사유 — 장중 판단만의 코드는 여기서, 나머지는 장중 확인과 같은 표로. 없으면 "—". */
export function intradayReasonText(reason: string | null | undefined, market: PaperMarketCode = "US"): string {
  if (!reason) return EMPTY;
  const cut = reason.indexOf(" — ");
  const code = (cut >= 0 ? reason.slice(0, cut) : reason).trim();
  const known = INTRADAY_REASON[code];
  return known ? `${known} (${code})` : checkpointReasonText(reason, market);
}

export interface IntradayPlanRow {
  key: string;
  /** '1번째 · 10:15 ET · 감시 1분봉 · AAA, SHY' */
  text: string;
  badge: Badge;
  /** 사유(없으면 null) — 놓침·건너뜀·대신함의 까닭. */
  reason: string | null;
  question: string | null;
}

export interface IntradayBookView {
  /** '2026-11-02 세션 · 세션당 2번까지' */
  summary: string;
  /** 그 계좌의 스위치가 켜져 있나(꺼져 있으면 남은 계획만 보이는 상태). */
  on: boolean;
  rows: IntradayPlanRow[];
  /** 수동 요청 단추를 누를 수 없는 까닭(누를 수 있으면 null). */
  blocked: string | null;
}

function planRow(plan: PaperIntradayPlan, market: PaperMarketCode): IntradayPlanRow {
  const zone = market === "KR" ? "KST" : "ET";
  const parts = [
    typeof plan.slot === "number" ? `${plan.slot}번째` : EMPTY,
    plan.at ? `${plan.at} ${zone}` : EMPTY,
    plan.feed ? (FEED[plan.feed] ?? plan.feed) : EMPTY,
  ];
  const watch = (plan.watch ?? []).filter((ticker) => typeof ticker === "string" && ticker.length > 0);
  if (watch.length > 0) parts.push(watch.join(", "));
  if (plan.manual) parts.push("수동");
  return {
    key: `${plan.slot ?? "?"}`,
    text: parts.join(" · "),
    badge: intradayStatusBadge(plan.status),
    reason: plan.reason ? intradayReasonText(plan.reason, market) : null,
    question: plan.question ?? null,
  };
}

/**
 * 그 계좌의 장중 판단 묶음 — 응답에 그 계좌가 없으면 null(아무것도 그리지 않음). 수동 요청은 스위치가 켜져 있고 세션당 횟수가 1 이상일 때만
 * 누를 수 있습니다(나머지 거절 — 받는 시간 밖·순번 소진 등 — 은 서버가 사유와 함께 돌려줍니다).
 */
export function intradayBookView(
  intraday: PaperIntradayStatus | null | undefined,
  book: string,
  market: PaperMarketCode = "US",
): IntradayBookView | null {
  const entry = (intraday?.books ?? []).find((candidate) => candidate.book === book);
  if (!intraday || !entry) return null;
  const max = typeof intraday.maxPerSession === "number" ? intraday.maxPerSession : null;
  const on = entry.freeTiming === true;
  const blocked = !on
    ? "이 계좌의 자유 시점 판 스위치가 꺼져 있습니다 — 남은 계획만 보입니다."
    : max !== null && max <= 0
      ? "세션당 장중 판단 횟수 설정이 0입니다."
      : null;
  return {
    summary: `${intraday.session ?? EMPTY} 세션 · 세션당 ${max === null ? EMPTY : `${max}번`}까지`,
    on,
    rows: (entry.plans ?? []).map((plan) => planRow(plan, market)),
    blocked,
  };
}

/** 수동 요청 결과 한 줄 — 예약만 했음을 그대로(호출은 작업이 그 창에서). */
export function runIntradayResultText(result: PaperRunIntradayResult, market: PaperMarketCode = "US"): string {
  if (result.available === false || result.ok === false) {
    return result.message ?? "장중 판단을 예약하지 못했습니다.";
  }
  const planned = result.planned;
  const at = market === "KR" ? planned?.atKst : planned?.atEt;
  const head = planned
    ? `${typeof planned.slot === "number" ? `${planned.slot}번째 ` : ""}장중 판단을 ${at ?? EMPTY} ${market === "KR" ? "KST" : "ET"}로 ${planned.created ? "예약했습니다" : "당겼습니다"}.`
    : "장중 판단을 예약했습니다.";
  return result.note ? `${head} ${result.note}` : head;
}
