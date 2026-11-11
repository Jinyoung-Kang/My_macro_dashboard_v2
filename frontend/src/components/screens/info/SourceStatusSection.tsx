"use client";

import { Card, ErrorState, Loading, Table } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { EMPTY } from "@/lib/format";
import { type InfoSourceRow, type InfoSourcesResponse, statusLabel, statusTone } from "@/lib/info";

const CATEGORY: Record<InfoSourceRow["category"], string> = { blog: "해외 블로그", waedge: "waedge", naver: "네이버", calendar: "경제 캘린더" };

/**
 * 출처 상태 — 차단 통과 수집 계층(polite)의 출처마다 마지막 판정·마지막 성공·글 수. 끊긴 출처(차단·형식 바뀜·받지 못함·오래 못 받음)는
 * 텔레그램과 화면 위 안내 띠로도 알립니다(백엔드가 같은 판정을 씀).
 */
export function SourceStatusSection() {
  const { data, loading, error, reload } = useApi<InfoSourcesResponse>(endpoints.info.sources, 120_000);
  return (
    <Card
      title="출처 상태"
      subtitle="서버 IP가 막히면 그 출처만 잠시 멈추고(개인 IP로 돌리지 않음) 정해진 시각 뒤 스스로 다시 시도합니다. 형식이 바뀌면 직전 저장본을 그대로 둡니다."
      source={data ? `판정 확인 ${data.checkedAt}` : undefined}
    >
      {loading && !data && <Loading />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && <p className="text-sm text-text-2">정보 수집 표가 아직 없습니다.</p>}
      {data?.available && data.recorded === false && (
        <p className="mb-3 text-sm text-text-2">
          판정 기록이 없습니다. 이 수집은 운영 서버에서만 돌기 때문에(로컬 PC의 IP를 쓰지 않음) 로컬 화면에는 기록이 없는 것이 정상입니다.
        </p>
      )}
      {data?.available && (
        <Table<InfoSourceRow>
          label="정보 수집 출처 상태"
          rows={data.sources}
          rowKey={(row) => row.task}
          columns={[
            {
              key: "label",
              header: "출처",
              render: (row) => (
                <a href={row.siteUrl} target="_blank" rel="noopener noreferrer" className="font-semibold hover:underline">
                  {row.label}
                </a>
              ),
            },
            { key: "category", header: "분류", render: (row) => CATEGORY[row.category] ?? row.category },
            {
              key: "status",
              header: "상태",
              render: (row) => (
                <StatusText tone={statusTone(row)}>
                  {statusLabel(row)}
                  {row.streak && row.streak > 1 && row.status !== "ok" ? ` (연속 ${row.streak}회)` : ""}
                </StatusText>
              ),
            },
            { key: "lastOk", header: "마지막 성공", render: (row) => <span className="tabular-nums">{row.lastOkAt ?? EMPTY}</span> },
            { key: "items", header: "글", align: "right", render: (row) => (row.category === "blog" || row.category === "waedge" ? row.items : EMPTY) },
            {
              key: "reason",
              header: "사유",
              className: "min-w-[16rem]",
              render: (row) => <span className="text-xs leading-5 text-text-2">{row.incident?.reason ?? row.reason ?? EMPTY}</span>,
            },
          ]}
        />
      )}
    </Card>
  );
}
