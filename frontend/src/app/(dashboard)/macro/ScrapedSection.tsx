"use client";

import {
  Card,
  ErrorState,
  Freshness,
  Loading,
  SourceBadge,
  Table,
} from "@/components/ui";
import { ChangeChip } from "@/components/patterns";
import { StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import {
  delayLabel,
  EMPTY,
  formatKst,
  formatNumber,
} from "@/lib/format";
import { endpoints } from "@/lib/endpoints";

export function ScrapedSection() {
  const { data, loading, error, reload, refreshError } = useApi<{
    available: boolean;
    updatedAt?: string;
    items: {
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
    }[];
  }>(endpoints.macro.scraped, 120_000);

  return (
    <Card
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
        <Table
          rows={data.items ?? []}
          rowKey={(row) => row.key}
          columns={[
            { key: "name", header: "항목", render: (row) => row.name },
            {
              key: "provider",
              header: "출처",
              // 머리의 수집 시각만 보면 모든 행이 그 시각 값으로 읽힙니다. 늦게 오는 시세는 행마다 지연을 적습니다(QA-137).
              render: (row) => (
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
              render: (row) =>
                row.status === "ok" ? `${formatNumber(row.price, 3)} ${row.unit}` : "수집 실패",
            },
            {
              key: "prev",
              header: "전일 종가",
              align: "right",
              render: (row) => (row.previousClose === null ? EMPTY : formatNumber(row.previousClose, 3)),
            },
            {
              key: "changePct",
              header: "등락률",
              align: "right",
              // 색만이 아니라 ▲▼·−(U+2212)·낭독 글 '상승/하락'과 함께(공용 변화 칩 — QA-621). 모르면 '—'(0.00%를 만들지 않음), 칸 안에서 꺾지 않습니다.
              render: (row) =>
                typeof row.changePct === "number" && Number.isFinite(row.changePct) ? (
                  <ChangeChip changePct={row.changePct} size="sm" nowrap />
                ) : (
                  EMPTY
                ),
            },
            {
              key: "error",
              header: "비고",
              render: (row) => (
                <span className="text-xs text-text-3">
                  {row.isStale ? (
                    <StatusText tone="warn" iconSize={12}>이전 값 — {row.staleReason ?? "수집 실패"}</StatusText>
                  ) : (row.error ?? "")}
                </span>
              ),
            },
          ]}
        />
      )}
    </Card>
  );
}
