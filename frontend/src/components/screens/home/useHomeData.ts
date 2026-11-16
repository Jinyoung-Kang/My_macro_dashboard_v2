"use client";

import { useApi } from "@/hooks/useApi";
import { useKrOfficialHolidays } from "@/hooks/useKrOfficialHolidays";
import { useMinuteClock } from "@/hooks/useMinuteClock";
import { useSessionUser } from "@/hooks/useSessionUser";
import { isOwner } from "@/lib/access";
import { endpoints } from "@/lib/endpoints";
import { HOME_ALERT_LIMIT, HOME_REFRESH_MS, HOME_REGIME_YEARS, type MarketClock } from "@/lib/home";
import type { InfoSourcesResponse } from "@/lib/info";
import type { InboxResponse, MacroOverview, RegimeResponse, StatusIssuesResponse } from "@/lib/types";

/** 경로 하나를 읽은 결과(useApi가 돌려주는 것 그대로 — 값·오류·다시 읽기 실패·다시 읽기). */
export type ApiRead<T> = ReturnType<typeof useApi<T>>;

/** 알림 두 경로 — 읽지 않은 수(셸 레이아웃과 같은 경로라 동시에 나가면 요청 하나)와 최근 알림 세 건. */
export type HomeAlertsRead = {
  unread: ApiRead<{ unread: number }>;
  inbox: ApiRead<InboxResponse>;
};

/** 홈이 읽는 것 — 구역 부품과 위 요약이 같은 응답을 나눠 씁니다(같은 경로를 두 번 읽지 않음). */
export type HomeData = {
  /** 운영자인가 — 아니면 운영자 전용 경로(/api/status*)를 요청하지 않습니다(null 경로). */
  owner: boolean;
  regime: ApiRead<RegimeResponse>;
  /** 매크로 개요 — live 없이(5분, Yahoo 429 이력 — lib/home HOME_REFRESH_MS). */
  macro: ApiRead<MacroOverview>;
  /** 장 상태 판정의 시계 — 보는 시각(1분마다)과 그해 한국 공휴일(천문연, /macro와 같은 훅). */
  clock: Omit<MarketClock, "collectedAt">;
  alerts: HomeAlertsRead;
  /** 수집 오류·경고·누락 데이터셋 수 — 운영자만(아니면 요청 없이 값이 늘 null). */
  issues: ApiRead<StatusIssuesResponse>;
  /** 끊긴 출처(셸의 수집 끊김 안내 띠와 같은 경로·간격 — 홈에서는 셸이 띠를 그리지 않고 알림 패널이 대신 적음, QA-613) — 운영자만(아니면 요청 없이 값이 늘 null). */
  sources: ApiRead<InfoSourcesResponse>;
};

/**
 * 알림 두 경로를 읽습니다. `enabled`가 false면 요청하지 않습니다(null 경로) — 홈 밖에서 알림 구역만 그릴 때(알림 화면 시험) 구역이 스스로 읽고,
 * 홈 안에서는 화면 훅이 읽은 것을 받아 같은 경로를 두 번 읽지 않게.
 */
export function useHomeAlerts(enabled = true): HomeAlertsRead {
  const unread = useApi<{ unread: number }>(enabled ? endpoints.alerts.unreadCount : null, HOME_REFRESH_MS.alerts);
  const inbox = useApi<InboxResponse>(enabled ? endpoints.alerts.inbox(HOME_ALERT_LIMIT) : null, HOME_REFRESH_MS.alerts);
  return { unread, inbox };
}

/**
 * 홈(/) 화면 훅 — 홈이 읽는 경로를 한 곳에서 한 번씩 읽습니다(간격은 lib/home HOME_REFRESH_MS — 기존 화면과 같음).
 *
 * - 국면(5분)·매크로 개요(live 없이 5분)·알림 읽지 않은 수와 최근 세 건(5분), 운영자만 수집 오류·경고 수(1분)와 끊긴 출처(5분).
 * - 경로마다 따로 읽으므로 한 경로가 실패해도 그 구역만 오류이고 나머지는 그대로 그립니다(일부 실패).
 * - 모의매매(/api/paper/*)는 여기서 읽지 않습니다 — 계좌 구역이 시장을 고른 뒤 그 시장만 읽습니다(한국은 처음 고를 때부터).
 */
export function useHomeData(): HomeData {
  const owner = isOwner(useSessionUser());
  const regime = useApi<RegimeResponse>(endpoints.insight.regime(HOME_REGIME_YEARS), HOME_REFRESH_MS.regime);
  const macro = useApi<MacroOverview>(endpoints.macro.overview(false), HOME_REFRESH_MS.macro);
  const now = useMinuteClock();
  const krOfficial = useKrOfficialHolidays(now);
  const alerts = useHomeAlerts();
  const issues = useApi<StatusIssuesResponse>(owner ? endpoints.status.issues : null, HOME_REFRESH_MS.storeStatus);
  const sources = useApi<InfoSourcesResponse>(owner ? endpoints.info.sources : null, HOME_REFRESH_MS.sources);
  return { owner, regime, macro, clock: { now, krOfficial }, alerts, issues, sources };
}
