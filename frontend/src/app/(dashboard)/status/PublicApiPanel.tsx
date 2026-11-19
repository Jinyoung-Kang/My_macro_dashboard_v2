"use client";

import { useState } from "react";
import { DataTable } from "@/components/patterns";
import { Button, Callout, ErrorState, Panel } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { formatNumber } from "@/lib/format";
import type { PublicApiDiagnosticsResponse } from "@/lib/types";
import { endpoints } from "@/lib/endpoints";

/**
 * 국내 공공 API 연결 진단.
 *
 * 공공데이터포털은 키 하나로 여러 서비스를 쓰지만 활용신청·승인은 서비스마다
 * 따로입니다. 키는 맞는데 한 서비스만 승인 전인 경우가 흔해서, 어느 것이 되는지
 * 한 번에 봅니다. 누를 때마다 실제로 API당 1회씩 호출하므로 자동으로 돌리지 않습니다.
 */
export function PublicApiPanel() {
  const [runId, setRunId] = useState<number | null>(null);
  const { data, loading, error } = useApi<PublicApiDiagnosticsResponse>(
    runId === null ? null : endpoints.publicData.apiStatus(runId),
  );

  return (
    <Panel
      title="국내 공공 API 연결 진단" source="공공데이터포털(천문연·금융위) · 금융감독원 Open DART — 실제 호출"
      subtitle="공공데이터포털(특일정보·주식시세) · Open DART — 누를 때마다 API당 1회 호출"
      actions={
        <Button onClick={() => setRunId(Date.now())} disabled={loading}>
          {loading ? "확인 중…" : "진단 실행"}
        </Button>
      }
    >
      {runId === null && (
        <p className="text-sm text-text-3">
          .env에 키를 넣고 수집기를 다시 띄운 뒤 눌러 보세요. 결과에 키 값은 표시되지 않습니다.
        </p>
      )}
      {error && <ErrorState message={error} />}
      {data && !data.available && <Callout tone="warn">{data.message}</Callout>}
      {data?.available && data.apis && (
        <DataTable
          dense
          count
          caption="국내 공공 API 연결 진단"
          rows={data.apis}
          rowKey={(row) => row.label}
          columns={[
            { key: "label", header: "API", className: "break-keep", cell: (row) => row.label },
            {
              key: "state",
              header: "상태",
              className: "whitespace-nowrap",
              cell: (row) =>
                row.ok ? (
                  <StatusText tone="ok">정상</StatusText>
                ) : row.configured ? (
                  <StatusText tone="danger">실패</StatusText>
                ) : (
                  <StatusText tone="neutral">키 없음</StatusText>
                ),
            },
            { key: "detail", header: "내용", className: "min-w-[14rem] break-keep wrap-anywhere text-caption", cell: (row) => row.detail },
            {
              key: "ms",
              header: "응답",
              align: "right",
              cell: (row) => (row.elapsedMs === null ? null : `${formatNumber(row.elapsedMs, 0)}ms`),
            },
          ]}
        />
      )}
    </Panel>
  );
}
