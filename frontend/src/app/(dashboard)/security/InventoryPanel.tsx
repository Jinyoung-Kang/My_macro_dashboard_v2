"use client";

import { useState } from "react";
import { DataTable, FilterList, PropertyList } from "@/components/patterns";
import { Callout, EmptyState, ErrorState, FIELD_LABEL, Loading, Panel, inputClasses } from "@/components/ui";
import { AlertTriangleIcon, StatusText } from "@/components/ui/icons";
import { firstLoadPending } from "@/hooks/useApi";
import { EMPTY, formatAge, formatKst } from "@/lib/format";
import { ALL, NO_INVENTORY_NOTE, filterComponents, sectionLabel, sectionStatusView } from "@/lib/security";
import type { SecurityComponent, SecurityInventoryResponse, SecurityInventorySection, SecurityPending } from "@/lib/types";

type InventoryRead = { data: SecurityInventoryResponse | null; loading: boolean; error: string | null; reload: () => void; failedAt: Date | null };

/** 구성 요소 표의 세로 한도(px) — 수백 줄이라 표 안에서 스크롤하고 머리가 위에 남습니다. */
const COMPONENTS_MAX_HEIGHT = 480;

/**
 * 버전 목록 탭 — 서버의 inventory.sh가 모아 넘긴 한 벌(GET /api/security/inventory, 이 탭을 열 때만 읽음). 받은 적이 없으면 '버전 목록 없음' 안내, 2일 넘게
 * 오래됐으면 경고. 모은 시각·호스트 구역 포함·apt 목록 시각(속성 목록), 구역 상태 표, apt 보류 업데이트 표, 구성 요소 표(구역·이름으로 화면 안에서 거름 — 요청 없음).
 */
export function InventoryPanel({ read }: { read: InventoryRead }) {
  const [section, setSection] = useState(ALL);
  const [query, setQuery] = useState("");
  if (firstLoadPending(read)) return <Loading label="버전 목록을 불러오는 중…" />;
  if (read.error) return <ErrorState message={read.error} onRetry={read.reload} />;
  const data = read.data;
  if (!data) return null;
  if (!data.available) return <EmptyState message="버전 목록 표가 아직 없습니다 — 수집기가 새 스키마를 적용한 뒤 보입니다." />;
  if (!data.present) {
    return (
      <Callout tone="warn" title={NO_INVENTORY_NOTE}>
        그때까지 제품이 맞는 공지는 모두 확인 필요(버전 목록 없음)입니다.
      </Callout>
    );
  }
  // 같은 이름·버전이 두 번 올 수 있어(아키텍처가 다른 패키지 등) 줄 키에 차례를 붙입니다 — 읽기만 하는 표라 고른 줄이 없습니다.
  const components = filterComponents(data.components, { section, query }).map((row, index) => ({ ...row, rowId: `${index}:${row.source}:${row.name}` }));
  const sectionItems = [
    { key: ALL, label: "전체", note: `${data.components.length}개` },
    ...data.sections.map((row) => ({
      key: row.name,
      label: sectionLabel(row.name),
      note: `${data.components.filter((component) => component.source === row.name).length}개`,
    })),
  ];
  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
      {data.stale ? (
        <Callout tone="warn">
          버전 목록이 2일 넘게 오래됐습니다(기준 {formatKst(data.collectedAt)} — {formatAge(data.ageSeconds)}). 서버의 inventory.sh가 돌고 있는지 확인하세요.
        </Callout>
      ) : null}
      <Panel title="버전 목록" subtitle="서버 호스트와 컨테이너 안에서 모은 마지막 한 벌입니다. 실제 버전은 이 화면과 운영 DB에만 있습니다.">
        <PropertyList
          dense
          items={[
            { label: "모은 시각", value: formatKst(data.collectedAt), note: data.ageSeconds !== null ? formatAge(data.ageSeconds) : null },
            { label: "받은 시각", value: formatKst(data.receivedAt) },
            { label: "서버 호스트 구역", value: data.hostIncluded === null ? null : data.hostIncluded ? "포함" : "빠짐(서버 밖에서 모음)" },
            { label: "apt 목록 시각", value: data.aptListsAt ? formatKst(data.aptListsAt) : null, emptyReason: "모름" },
            { label: "구성 요소", value: data.counts ? `${data.counts.components}개` : null },
            {
              label: "apt 보류 업데이트",
              value: data.counts ? `${data.counts.pending}건(보안 ${data.counts.pendingSecurity}건)` : null,
            },
          ]}
        />
      </Panel>

      <Panel title="구역" count={`${data.sections.length}개`}>
        <DataTable<SecurityInventorySection>
          dense
          caption="구역"
          rows={data.sections}
          rowKey={(row) => row.name}
          scrollHint="overflow"
          emptyText="구역 기록이 없습니다."
          columns={[
            { key: "name", header: "구역", rowHeader: true, className: "whitespace-nowrap", cell: (row) => sectionLabel(row.name) },
            {
              key: "status",
              header: "상태",
              className: "whitespace-nowrap",
              cell: (row) => {
                const view = sectionStatusView(row.status);
                return <StatusText tone={view.tone}>{view.label}</StatusText>;
              },
            },
            { key: "count", header: "개수", align: "right", className: "tabular-nums", cell: (row) => (row.count === null ? EMPTY : String(row.count)) },
            { key: "reason", header: "사유", className: "min-w-[12rem] break-keep wrap-anywhere text-text-2", cell: (row) => row.reason ?? EMPTY },
          ]}
        />
      </Panel>

      <Panel title="apt 보류 업데이트" count={`${data.pending.length}건`} subtitle="서버 호스트의 apt 보류 목록 — 저장소 이름이 -security로 끝나면 보안 업데이트입니다.">
        <DataTable<SecurityPending>
          dense
          caption="apt 보류 업데이트"
          rows={data.pending}
          rowKey={(row) => `${row.package}:${row.arch ?? ""}`}
          scrollHint="overflow"
          emptyText="보류 업데이트가 없습니다."
          columns={[
            { key: "package", header: "패키지", rowHeader: true, className: "font-mono text-caption", cell: (row) => row.package },
            { key: "installed", header: "설치", className: "font-mono text-caption", cell: (row) => row.installed ?? EMPTY },
            { key: "candidate", header: "후보", className: "font-mono text-caption", cell: (row) => row.candidate ?? EMPTY },
            { key: "repos", header: "저장소", className: "break-keep wrap-anywhere text-caption text-text-2", cell: (row) => row.repos ?? EMPTY },
            {
              key: "security",
              header: "보안",
              className: "whitespace-nowrap",
              cell: (row) =>
                row.security ? (
                  <StatusText tone="warn" icon={<AlertTriangleIcon size={14} />}>
                    보안
                  </StatusText>
                ) : (
                  <StatusText tone="neutral" icon={false}>
                    아님
                  </StatusText>
                ),
            },
          ]}
        />
      </Panel>

      <Panel title="구성 요소" count={`${components.length}개`} subtitle="구역과 이름으로 거릅니다(화면 안에서 — 새로 읽지 않음).">
        <div className="flex min-w-0 flex-col gap-3">
          <FilterList label="구역" selection="single" wide="wrap" items={sectionItems} selected={[section]} onToggle={setSection} />
          <label className={FIELD_LABEL}>
            이름·버전 찾기
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} className={inputClasses("md")} maxLength={100} />
          </label>
          <DataTable<SecurityComponent & { rowId: string }>
            dense
            caption="구성 요소"
            rows={components}
            rowKey={(row) => row.rowId}
            scrollHint="overflow"
            maxHeight={COMPONENTS_MAX_HEIGHT}
            emptyText="조건에 맞는 구성 요소가 없습니다."
            columns={[
              { key: "name", header: "이름", rowHeader: true, className: "font-mono text-caption break-all", cell: (row) => row.name },
              { key: "version", header: "버전", className: "font-mono text-caption break-all", cell: (row) => row.version ?? EMPTY },
              { key: "source", header: "구역", className: "whitespace-nowrap", cell: (row) => sectionLabel(row.source) },
              { key: "ecosystem", header: "종류", className: "whitespace-nowrap text-text-2", cell: (row) => row.ecosystem },
              { key: "sourcePackage", header: "원본 패키지", className: "font-mono text-caption text-text-2 break-all", cell: (row) => row.sourcePackage ?? EMPTY },
            ]}
          />
        </div>
      </Panel>
    </div>
  );
}
