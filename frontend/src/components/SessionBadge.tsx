"use client";

import { delayLabel } from "@/lib/format";
import { sessionStatus, tradeDayFrom, tradeTimeFrom, type SessionState } from "@/lib/marketSessions";

/**
 * 지표 카드의 "개장/마감" 배지 — 시세 지연을 함께 적습니다("개장 · 실시간", "개장 · 10분 지연").
 *
 * 지연은 장이 열려 있을 때만 뜻이 있어(닫힌 장의 값은 마지막 거래 값 — 시각 줄이 말해 줌) 개장일 때만 배지에 적고,
 * 그 밖에는 툴팁에만 둡니다. 예전에는 '실시간' 배지와 '마감' 배지가 나란히 떠 서로 어긋나게 읽혔습니다.
 *
 * 판정은 `lib/marketSessions`(순수 함수)가 하고, 여기서는 시각을 1분마다 갱신해
 * 다시 그리기만 합니다. 데이터를 다시 받지 않으므로 서버 부하가 없습니다.
 *
 * 색 — 초록(개장)만 눈에 띄게 하고 나머지는 회색 계열입니다. 이 화면의 빨강·파랑은
 * 상승·하락 전용이라 상태 표시에 쓰지 않습니다.
 */
const STYLES: Record<SessionState, string> = {
  open: "border-ok/40 bg-ok/10 text-ok",
  break: "border-warn/40 bg-warn/10 text-warn",
  closed: "border-border bg-surface-hover text-muted",
  holiday: "border-border bg-surface-hover text-muted",
  idle: "border-border bg-surface-hover text-muted",
};

import { useMinuteClock } from "@/hooks/useMinuteClock";
import { useKrOfficialHolidays } from "@/hooks/useKrOfficialHolidays";

export { useMinuteClock, useKrOfficialHolidays };

export function SessionBadge({
  market,
  now,
  krOfficial,
  lastTs,
  collectedAt,
  delayMinutes,
  stale,
}: {
  market?: string | null;
  now: Date | null;
  krOfficial: string[] | null;
  /** 카드의 lastTs. 체결 시각이거나 거래일("… 거래일 기준"·"… 일봉 기준")일 때 휴장 추정에 씁니다 */
  lastTs?: string | null;
  /** 이 카드를 받은 수집 시각 ("YYYY-MM-DD HH:mm KST") */
  collectedAt?: string | null;
  /** 출처의 시세 지연(분, 0=실시간). 없으면 개장 상태만 적습니다 */
  delayMinutes?: number | null;
  /** 이번 수집 실패로 이어받은 예전 값 — 지연은 적지 않습니다(값 자체가 지금 것이 아님) */
  stale?: boolean;
}) {
  if (!now) return null;
  const status = sessionStatus(
    market, now, krOfficial, tradeTimeFrom(lastTs), tradeTimeFrom(collectedAt), tradeDayFrom(lastTs),
  );
  const delay = stale ? null : delayLabel(delayMinutes);
  if (!status) {
    // 시간표를 모르는 시장이면 지연만 적습니다.
    return delay ? (
      <span className={`rounded-sm border px-2 py-0.5 text-xs ${STYLES.idle}`} title="시세 지연(출처 기준)">
        {delay}
      </span>
    ) : null;
  }
  return (
    <span
      className={`rounded-sm border px-2 py-0.5 text-xs ${STYLES[status.state]}`}
      title={delay ? `${status.detail} · 시세 ${delay}(출처 기준)` : status.detail}
    >
      {status.state === "open" && delay ? `${status.label} · ${delay}` : status.label}
    </span>
  );
}
