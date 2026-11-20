"use client";

import { DataTable } from "@/components/patterns";
import { Button, Callout, ErrorState, Loading, Panel, Tag } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { sortBySourceOrder, sourceLabel } from "@/lib/radar";
import type { DiagnosticsResponse } from "@/lib/types";
import { endpoints } from "@/lib/endpoints";

export function DiagnosticsPanel() {
  const { data, loading, error, reload } = useApi<DiagnosticsResponse>(endpoints.positioning.radarDiagnostics);

  return (
    <Panel
      title="데이터 소스 연결 진단" source="각 소스를 화면이 쓰는 경로 그대로 실제 호출 (수집기)"
      subtitle="화면이 실제로 쓰는 경로를 그대로 호출합니다."
      actions={<Button onClick={reload}>다시 검사</Button>}
    >
      {loading && !data && <Loading />}
      {/* 진단 자체가 실패하면(백엔드 5xx·연결 끊김) 빈 카드가 아니라 이유와 다시 시도를 보입니다(QA-098). */}
      {error && !data && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && <Callout tone="warn">{data.message}</Callout>}
      {data?.sources && (
        <DataTable
          dense
          caption="데이터 소스 연결 진단"
          rows={sortBySourceOrder(data.sources)}
          rowKey={(row) => row.name}
          scrollHint="overflow"
          columns={[
            { key: "name", header: "소스 (체인 순서)", rowHeader: true, className: "whitespace-nowrap", cell: (row) => sourceLabel(row.name) },
            {
              key: "status",
              header: "상태",
              className: "whitespace-nowrap",
              cell: (row) => <StatusText tone={row.ok ? "ok" : "danger"}>{row.ok ? "정상" : "실패"}</StatusText>,
            },
            { key: "stage", header: "단계", className: "whitespace-nowrap", cell: (row) => <Tag>{row.stage}</Tag> },
            { key: "message", header: "메시지", className: "min-w-[16rem] break-keep wrap-anywhere", cell: (row) => row.message },
          ]}
        />
      )}
    </Panel>
  );
}
