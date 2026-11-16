"use client";

import { KpiStrip } from "@/components/patterns";
import { homeKpiItems } from "@/lib/home";
import type { HomeData } from "./useHomeData";

/** KPI 띠의 영역 이름(section aria-label). */
export const HOME_KPI_LABEL = "오늘 요약";

/**
 * 홈 맨 위 KPI 띠 — 국면 · S&P 500 · 코스피 · 원/달러 · 미국채 10년물 · 읽지 않은 알림 · 수집 오류(운영자만). 타일마다 그 대상 화면 링크입니다
 * (lib/home `homeKpiItems`). 화면 훅이 읽은 응답을 아래 패널과 함께 쓰므로 요청이 늘지 않습니다.
 *
 * 모의매매 값은 두지 않습니다(모의 자료는 계좌 손익 표 패널 하나만 읽음). 읽는 중이면 타일마다 자리표시, 읽지 못한 타일은 "—" + '읽지 못함'이고
 * 오류 글과 다시 시도는 그 패널이 보입니다(같은 실패를 두 번 알리지 않음).
 */
export function HomeKpis({ data }: { data: HomeData }) {
  const items = homeKpiItems(
    { regime: data.regime, macro: data.macro, unread: data.alerts.unread, issues: data.issues },
    { owner: data.owner, clock: data.clock },
  );
  return <KpiStrip label={HOME_KPI_LABEL} items={items} />;
}
