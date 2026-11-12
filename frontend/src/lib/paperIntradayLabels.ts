/**
 * 장중 판단 계획 행의 출처·사건 이름표(ADR 0031) — 상태 응답의 계획 줄(lib/paperIntraday)과 장중 판단 결정 상세(lib/paper)가 함께 씁니다.
 * 다른 lib 모듈을 부르지 않는 잎 모듈입니다(lib/paperIntraday가 lib/paper를 부르므로, 둘이 함께 쓰는 표는 여기에 둡니다).
 */
import type { PaperIntradayTrigger } from "@/lib/types/paper";

/** 계획 행을 누가 만들었나(ADR 0031) — 결정의 예약(RESERVED)은 따로 적지 않고, 운영자 행(MANUAL)은 '수동' 표시로 보입니다. */
const ORIGIN: Record<string, string | null> = {
  RESERVED: null,
  MANUAL: null,
  NEXT: "다음 예약",
  GUARANTEE: "코드 보장",
  EVENT: "사건",
};

/** 고정 일정 판(ADR 0039)의 고정 시각 행의 질문 머리 — 그 행은 보장과 같은 출처(GUARANTEE)로 들어오고 질문만 다릅니다(백엔드 IntradayScheduler). */
const FIXED_QUESTION_PREFIX = "코드가 정한 고정 시각의 판단";

/**
 * 출처 이름 — 따로 적지 않는 출처(결정의 예약·운영자)와 값이 없으면 null, 모르는 출처는 받은 글자 그대로. 질문을 함께 주면 고정 일정 판의 고정 시각
 * 행(출처 GUARANTEE + 그 질문)을 '고정 시각'으로 가릅니다.
 */
export function intradayOriginLabel(origin: string | null | undefined, question?: string | null): string | null {
  if (origin === "GUARANTEE" && typeof question === "string" && question.startsWith(FIXED_QUESTION_PREFIX)) return "고정 시각";
  return origin ? (origin in ORIGIN ? ORIGIN[origin] : origin) : null;
}

/** 사건 종류(ADR 0031 — 보유 종목 ±4%·지수 ±1.5%·트레일링 스탑 2% 안). 모르는 종류는 받은 글자 그대로. */
const EVENT_TYPE: Record<string, string> = {
  HELD_MOVE: "보유 종목 변동",
  INDEX_MOVE: "지수 변동",
  NEAR_STOP: "스탑 근접",
};

/** 사건 한 줄 — 사건 종류·티커와 당기기 전 원래 시각. 사건이 없으면 null. */
export function intradayTriggerText(trigger: PaperIntradayTrigger | null | undefined): string | null {
  if (!trigger) return null;
  const events = (trigger.events ?? [])
    .map((event) => [event?.type ? (EVENT_TYPE[event.type] ?? event.type) : null, event?.ticker ?? null].filter(Boolean).join(" "))
    .filter((text) => text.length > 0);
  const parts = events.length > 0 ? [`사건: ${events.join(", ")}`] : [];
  if (trigger.originalAt) parts.push(`원래 ${trigger.originalAt}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
