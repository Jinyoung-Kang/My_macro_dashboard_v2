"use client";

import { useId, useMemo, useRef, useState } from "react";
import { type Column, DataTable } from "@/components/patterns";
import {
  EmptyState,
  ErrorState,
  Freshness,
  Loading,
  Panel,
  SourceBadge,
  tabId,
  Tabs,
} from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useMinuteClock } from "@/hooks/useMinuteClock";
import { useWideShell } from "@/hooks/useWideShell";
import { EMPTY, formatNumber } from "@/lib/format";
import { endpoints } from "@/lib/endpoints";
import {
  type EconCalendarResponse,
  type EconEvent,
  bypassBadge,
  econCalendarView,
  econDayChip,
  econDayCountText,
  econDayTitle,
  econEventTime,
  econHiddenText,
  econToday,
  importanceLabel,
  pickEconDay,
  valueText,
} from "@/lib/econCalendar";

/** 표의 줄 — 일정 하나와 줄 키(출처 id가 없으면 시각·나라·차례). */
type EventRow = EconEvent & { rowKey: string };

/**
 * 표의 칸 — 시각(KST, 날짜는 날짜 띠·표 머리에 있어 HH:MM)·나라·지표(행 머리)·중요도·실제·예상·이전. 없는 값은 '—'(공용 표).
 * '나라' 칸(두 자)은 줄을 바꾸지 않습니다 — 공용 표는 오른쪽 정렬(숫자) 열만 nowrap이라, 표가 조금만 눌려도 자동 배치가 이 열을 머리 '나라'(13px) 폭까지
 * 줄여 '미/국'·'한/국'으로 꺾고 조밀 행을 28 → 48px로 늘였습니다(QA-683).
 */
const COLUMNS: readonly Column<EventRow>[] = [
  { key: "at", header: "시각(KST)", cell: (row) => econEventTime(row) ?? EMPTY },
  { key: "country", header: "나라", className: "whitespace-nowrap", cell: (row) => (row.country === "KR" ? "한국" : "미국") },
  {
    key: "title",
    header: "지표",
    rowHeader: true,
    cell: (row) => (
      <span>
        {row.title}
        {row.period ? <span className="text-xs text-text-3"> · {row.period}</span> : null}
      </span>
    ),
  },
  { key: "importance", header: "중요도", cell: (row) => importanceLabel(row.importance) },
  { key: "actual", header: "실제", align: "right", cell: (row) => valueText(row.actual, row, formatNumber) },
  { key: "forecast", header: "예상", align: "right", cell: (row) => valueText(row.forecast, row, formatNumber) },
  { key: "previous", header: "이전", align: "right", cell: (row) => valueText(row.previous, row, formatNumber) },
];

/**
 * 경제 캘린더 — 미국·한국 지표 일정과 예상치·이전치·실제치·중요도(운영자 전용, ADR 0026).
 *
 * 차단 통과 수집 계층으로 받은 비공식 자료라 출처·수집 시각과 '우회 수집' 표기를 늘 함께 보입니다. 백엔드는 저장본만 읽으므로
 * 화면을 열어도 수집이 일어나지 않습니다 — 받은 지 오래됐으면 수집 시각이 그대로 그렇게 보입니다. 없는 값은 '—'입니다.
 *
 * 날짜 띠 + 그날 표(2026-11-18 사용자 결정 — 창 안 일정을 세로 한 줄로 쭉 늘어놓지 않음): 중요도 보통·높음만 보이고(낮음·모름은 숨긴 건수를 한 줄로),
 * 보일 일정이 있는 KST 날짜마다 공용 탭 줄(밑줄 탭 — 넘치면 가로로 넘김, ←·→·Home·End로 옮기고 Enter·Space로 고름)의 탭 하나('11/18 (수)' + 건수,
 * 높음이 있으면 높음 건수를 글로), 그 아래 고른 날의 조밀 표(행 28px — 공용 표 dense) 하나. 처음 고른 날은 오늘(KST)·오늘 뒤 첫 날·오늘 앞 마지막 날
 * 차례(lib/econCalendar pickEconDay)이고, 새 자료에서 고른 날이 사라지면 같은 규칙으로 다시 고릅니다.
 */
export function EconCalendarSection() {
  const { data, loading, error, reload, refreshError } = useApi<EconCalendarResponse>(
    endpoints.macro.econCalendar,
    600_000,
  );
  const badge = bypassBadge(data?.fetchTier);
  const view = useMemo(() => econCalendarView(data?.events ?? []), [data?.events]);
  const hiddenText = econHiddenText(view.hidden);
  // 오늘(KST) — 1분마다 다시 봅니다(자정을 넘기면 아직 고르지 않은 띠가 새 오늘로). 마운트 전에는 모름(첫 날).
  const now = useMinuteClock();
  const today = now ? econToday(now.getTime()) : null;
  const [chosen, setChosen] = useState<string | null>(null);
  const dates = view.days.map((day) => day.date);
  const current = chosen !== null && dates.includes(chosen) ? chosen : pickEconDay(dates, today);
  const day = view.days.find((entry) => entry.date === current) ?? null;
  const baseId = useId();
  const idPrefix = `${baseId}-day`;
  const panelId = `${baseId}-panel`;
  // 표 영역 높이의 하한 — 날짜를 고르는 그 순간의 표 영역 높이를 늘어나기만 하게 남깁니다. 이 카드는 매크로 화면의 마지막 절이라, 일정이 적은 날로
  // 바꿔 문서가 짧아지면 맨 아래까지 내린 스크롤이 눌려 방금 누른 날짜 띠가 포인터 밑에서 수백 px 아래로 튀었습니다(2026-11-18 검토 지적). 행 높이가 바뀌는
  // 경계(lg — 넓은 화면 28px·좁은 화면 44px)를 넘으면 잰 값을 버립니다(다른 폭의 높이를 남기지 않음). 첫 그리기·새 자료에는 하한을 새로 두지 않습니다.
  const wide = useWideShell();
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelFloor, setPanelFloor] = useState<{ wide: boolean; px: number } | null>(null);
  const floorPx = panelFloor !== null && panelFloor.wide === wide && panelFloor.px > 0 ? panelFloor.px : null;
  const chooseDay = (date: string) => {
    const height = Math.ceil(panelRef.current?.getBoundingClientRect().height ?? 0);
    setPanelFloor({ wide, px: Math.max(floorPx ?? 0, height) });
    setChosen(date);
  };
  const rows: EventRow[] = (day?.events ?? []).map((event, index) => ({
    ...event,
    rowKey: event.id ?? `${event.at}-${event.country}-${index}`,
  }));
  const title = day ? econDayTitle(day.date) : "";
  // 창 안의 보이는 건수(거른 뒤) — 제목 옆 개수. 저장본이 없거나 아직 모르면 적지 않습니다('0건'과 다름).
  const shownTotal = view.days.reduce((sum, entry) => sum + entry.events.length, 0);

  return (
    <Panel
      title="경제 캘린더"
      count={data?.available ? `${shownTotal.toLocaleString("ko-KR")}건` : undefined}
      source={data?.source ? `${data.source} (비공식)` : "TradingView 경제 캘린더 (비공식)"}
      subtitle="미국·한국 지표 발표 일정과 예상치입니다. 중요도 보통 이상만 보이고, 날짜를 고르면 그날 일정이 나옵니다. 차단 통과 수집으로 받은 참고 자료이고 공식 확정치가 아닙니다. 운영자에게만 보입니다."
      actions={
        <span className="flex flex-wrap items-center gap-2">
          {badge && <SourceBadge>{badge}</SourceBadge>}
          <Freshness collectedAt={data?.collectedAtKst} ageSeconds={data?.ageSeconds} refreshError={refreshError} />
        </span>
      }
    >
      {loading && !data && <Loading />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && (
        <p className="text-sm text-text-2">
          아직 받은 일정이 없습니다. 수집은 몇 시간에 한 번 불규칙한 시각에 돌고, 출처가 거부하면 상태 화면의
          econ_calendar_tradingview 기록에 사유가 남습니다.
        </p>
      )}
      {data?.available && day === null && (
        <EmptyState message={(data.events ?? []).length === 0 ? "창 안에 일정이 없습니다." : "창 안에 중요도 보통 이상인 일정이 없습니다."} />
      )}
      {data?.available && day !== null && (
        <div className="min-w-0">
          <Tabs
            label="경제 캘린더 날짜"
            items={view.days.map((entry) => ({
              key: entry.date,
              label: econDayChip(entry.date),
              // 이름 뒤 빈칸 글 마디 — 읽어 주기에서 '11/18 (수) 14건'으로 띄웁니다(flex 줄 안이라 보이지 않음 — 간격은 탭의 gap).
              suffix: (
                <>
                  {" "}
                  <span className="text-xs font-normal tabular-nums text-text-3">{econDayCountText(entry)}</span>
                </>
              ),
            }))}
            value={day.date}
            onChange={chooseDay}
            idPrefix={idPrefix}
            panelId={panelId}
            size="sm"
          />
          <div
            ref={panelRef}
            role="tabpanel"
            id={panelId}
            aria-labelledby={tabId(idPrefix, day.date)}
            className="mt-3 min-w-0"
            style={floorPx !== null ? { minHeight: floorPx } : undefined}
          >
            <DataTable
              columns={COLUMNS}
              rows={rows}
              rowKey={(row) => row.rowKey}
              caption={`경제 캘린더 일정 — ${title}`}
              emptyText="이날 일정이 없습니다."
              count={(count) => `${title} — ${count.toLocaleString("ko-KR")}건`}
              scrollHint="overflow"
              dense
            />
          </div>
        </div>
      )}
      {data?.available && hiddenText && <p className="mt-2 text-xs text-text-3">{hiddenText}</p>}
    </Panel>
  );
}
