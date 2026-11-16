"use client";

import { type Column, DataTable } from "@/components/patterns";
import {
  ErrorState,
  Freshness,
  Loading,
  Panel,
  SourceBadge,
} from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { EMPTY, formatNumber } from "@/lib/format";
import { endpoints } from "@/lib/endpoints";
import {
  type EconCalendarResponse,
  type EconEvent,
  bypassBadge,
  importanceLabel,
  valueText,
} from "@/lib/econCalendar";

/** 표의 줄 — 일정 하나와 줄 키(출처 id가 없으면 시각·나라·차례). */
type EventRow = EconEvent & { rowKey: string };

/** 표의 칸 — 시각(KST)·나라·지표(행 머리)·중요도·실제·예상·이전. 없는 값은 '—'(공용 표). */
const COLUMNS: readonly Column<EventRow>[] = [
  { key: "at", header: "시각(KST)", cell: (row) => row.atKst?.replace(" KST", "") ?? EMPTY },
  { key: "country", header: "나라", cell: (row) => (row.country === "KR" ? "한국" : "미국") },
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
 * 표는 일정 기록이라 조밀 표(행 28px — 공용 표 dense)입니다.
 */
export function EconCalendarSection() {
  const { data, loading, error, reload, refreshError } = useApi<EconCalendarResponse>(
    endpoints.macro.econCalendar,
    600_000,
  );
  const badge = bypassBadge(data?.fetchTier);
  const rows: EventRow[] = (data?.events ?? []).map((event, index) => ({
    ...event,
    rowKey: event.id ?? `${event.at}-${event.country}-${index}`,
  }));

  return (
    <Panel
      title="경제 캘린더"
      source={data?.source ? `${data.source} (비공식)` : "TradingView 경제 캘린더 (비공식)"}
      subtitle="미국·한국 지표 발표 일정과 예상치입니다. 차단 통과 수집으로 받은 참고 자료이고 공식 확정치가 아닙니다. 운영자에게만 보입니다."
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
      {data?.available && (
        <DataTable
          columns={COLUMNS}
          rows={rows}
          rowKey={(row) => row.rowKey}
          caption="경제 캘린더 일정"
          emptyText="창 안에 일정이 없습니다."
          count
          scrollHint="overflow"
          dense
        />
      )}
    </Panel>
  );
}
