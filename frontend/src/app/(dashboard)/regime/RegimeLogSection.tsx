"use client";

import { Banner, Card, ErrorState, Freshness, Loading, Table } from "@/components/ui";
import { LineIcon, LockIcon } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { EMPTY } from "@/lib/format";
import { regimeInputCells } from "@/lib/regime";
import { SOURCES } from "@/lib/sources";
import type { RegimeLogEntry, RegimeLogResponse } from "@/lib/types";

/**
 * 📒 판정 기록 — 그날 화면에 보인 판정을 하루 한 건씩 남긴 것(추가만, 고치지 않음).
 *
 * 아래 "국면 이력"은 같은 규칙을 과거에 다시 적용한 재현이고, 이 표는 **실제로 낸 판정**입니다.
 * 판정 성과를 말할 때 "나중에 맞춰 고친 것 아니냐"에 답하는 근거가 이 기록입니다.
 */
export function RegimeLogSection({ tone }: { tone: Record<string, string> }) {
  const { data, loading, error, reload, refreshError } = useApi<RegimeLogResponse>(endpoints.insight.regimeLog(60), 600_000);

  return (
    <Card
      title="판정 기록"
      source={SOURCES.regimeLog}
      subtitle={
        data?.available
          ? `${data.startedOn ?? EMPTY}부터 ${data.count ?? 0}건 · 매일 KST ${data.recordHourKst ?? 18}시 이후 한 건`
          : "그날 화면에 보인 판정을 하루 한 건씩 남깁니다"
      }
      // 자동 갱신이 실패하면 앞서 받은 값을 그대로 보이므로 '새로 읽지 못함'을 붙입니다(QA-104, QA-067과 같음).
      actions={<Freshness refreshError={refreshError} />}
    >
      {loading && !data && <Loading label="판정 기록을 읽는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && <Banner tone="warn">{data.message}</Banner>}
      {data?.available && (
        <>
          <Table<RegimeLogEntry>
            rows={data.entries ?? []}
            rowKey={(row) => row.date}
            emptyMessage={`아직 기록이 없습니다. 첫 기록은 KST ${data.recordHourKst ?? 18}시 이후에 생깁니다.`}
            columns={[
              { key: "date", header: "날짜", render: (row) => row.date },
              {
                key: "label",
                header: "판정",
                render: (row) => (
                  <span className="flex items-center gap-2">
                    <span className={`h-2 w-4 rounded-xs ${tone[row.code] ?? "bg-border"}`} />
                    {row.label}
                  </span>
                ),
              },
              {
                key: "inputs",
                header: "근거 (기준일)",
                render: (row) => (
                  <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                    {regimeInputCells(row.inputs).map((cell) => (
                      <span key={cell.key} className="whitespace-nowrap">
                        <span className="text-muted">{cell.label}</span> {cell.value}
                        <span className="text-muted"> ({cell.asOf})</span>
                      </span>
                    ))}
                  </span>
                ),
              },
              {
                key: "missing",
                header: "판정 불가 사유",
                render: (row) => (row.missing.length > 0 ? row.missing.join(" · ") : EMPTY),
              },
            ]}
          />
          {data.note && <p className="mt-2 text-xs text-muted">{data.note}</p>}
          {data.limitedTo && (
            <p className="mt-1 flex items-start gap-1 text-xs text-muted">
              {/* 장식 — 뜻은 옆의 글이 나릅니다. */}
              <LineIcon>
                <LockIcon size={12} />
              </LineIcon>
              <span>무료 등급은 최근 {data.limitedTo}건만 보입니다. 유료 등급은 기록 전체를 봅니다.</span>
            </p>
          )}
        </>
      )}
    </Card>
  );
}
