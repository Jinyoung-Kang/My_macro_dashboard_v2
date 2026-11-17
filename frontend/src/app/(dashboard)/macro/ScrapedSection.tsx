"use client";

import { ChangeCell, type Column, DataTable, Empty } from "@/components/patterns";
import {
  ErrorState,
  Freshness,
  Loading,
  Panel,
  SourceBadge,
} from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import {
  delayLabel,
  formatKst,
  formatNumber,
} from "@/lib/format";
import { endpoints } from "@/lib/endpoints";

type ScrapedItem = {
  key: string;
  name: string;
  provider: string;
  unit: string;
  status: string;
  price: number | null;
  previousClose: number | null;
  changePct: number | null;
  error: string | null;
  /** 시세 지연(분). 0이면 실시간, 없으면 모름 — 선물은 15~20분 늦습니다 (QA-137) */
  delayMinutes?: number | null;
  /** 이번 수집이 실패해 직전 저장본의 값을 그대로 보여 주는 행 (QA-001) */
  isStale?: boolean;
  staleReason?: string | null;
};

/** 표의 칸 — 항목(행 머리)·출처(지연)·현재가·전일 종가·등락률(변화 칩)·비고. */
const COLUMNS: readonly Column<ScrapedItem>[] = [
  { key: "name", header: "항목", rowHeader: true, cell: (row) => <span className="break-keep">{row.name}</span> },
  {
    key: "provider",
    header: "출처",
    // 머리의 수집 시각만 보면 모든 행이 그 시각 값으로 읽힙니다. 늦게 오는 시세는 행마다 지연을 적습니다(QA-137).
    cell: (row) => (
      <span className="flex flex-wrap items-center gap-1">
        <SourceBadge>{row.provider}</SourceBadge>
        {row.status === "ok" && delayLabel(row.delayMinutes) && (
          <span className="text-xs text-text-3">{delayLabel(row.delayMinutes)}</span>
        )}
      </span>
    ),
  },
  {
    key: "price",
    header: "현재가",
    align: "right",
    // 받지 못한 시세는 '—'와 사유(0이나 빈 칸으로 두지 않음).
    cell: (row) =>
      row.status === "ok" ? (
        `${formatNumber(row.price, 3)} ${row.unit}`
      ) : (
        <span className="text-text-3">
          <Empty reason="수집 실패" />
        </span>
      ),
  },
  { key: "prev", header: "전일 종가", align: "right", cell: (row) => (row.previousClose === null ? null : formatNumber(row.previousClose, 3)) },
  {
    key: "changePct",
    header: "등락률",
    align: "right",
    // 색만이 아니라 ▲▼·−(U+2212)·낭독 글 '상승/하락'과 함께(공용 변화 칩 — QA-621). 모르면 '—'(0.00%를 만들지 않음), 칸 안에서 꺾지 않습니다.
    cell: (row) => <ChangeCell changePct={row.changePct} />,
  },
  {
    key: "error",
    header: "비고",
    cell: (row) =>
      row.isStale ? (
        <StatusText tone="warn" iconSize={12} className="text-xs">
          이전 값 — {row.staleReason ?? "수집 실패"}
        </StatusText>
      ) : (
        // 비고가 없는 줄은 빈 칸 — '—'(값 없음)로 읽히지 않게 빈 글 대신 빈 요소를 돌려줍니다(공용 표는 빈 글을 '—'로 그림).
        <span className="text-xs text-text-3">{row.error ?? ""}</span>
      ),
  },
];

export function ScrapedSection() {
  const { data, loading, error, reload, refreshError } = useApi<{
    available: boolean;
    updatedAt?: string;
    items: ScrapedItem[];
  }>(endpoints.macro.scraped, 120_000);

  return (
    <Panel
      title="비공식 스크래핑 시세 비교"
      source="TradingView Scanner · Yahoo Finance 공개 엔드포인트 (비공식)"
      subtitle="TradingView·Yahoo 공개 엔드포인트에서 받은 참고 시세입니다. 공식 확정치가 아닙니다."
      actions={
        <span className="flex items-center gap-2">
          <Freshness refreshError={refreshError} />
          {data?.updatedAt && <SourceBadge>{formatKst(data.updatedAt)}</SourceBadge>}
        </span>
      }
    >
      {loading && !data && <Loading />}
      {/* 첫 조회가 실패하면 제목만 남은 빈 카드가 아니라 이유와 다시 시도를 보입니다(QA-103). */}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && (
        <DataTable
          columns={COLUMNS}
          rows={data.items ?? []}
          rowKey={(row) => row.key}
          caption="비공식 스크래핑 시세"
          // 개수는 표 위 줄에(명세 §3-7 — 머리의 개수는 값이 올 때 머리 구조가 바뀌어 제목을 다시 그림).
          count={(count) => `${count.toLocaleString("ko-KR")}개`}
          scrollHint="overflow"
        />
      )}
    </Panel>
  );
}
