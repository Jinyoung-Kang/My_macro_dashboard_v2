"use client";

import Link from "next/link";
import { useState } from "react";
import { Pager } from "@/components/Pager";
import { Card, ErrorState, Loading, Table, filterChipClasses } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { EMPTY } from "@/lib/format";
import { type CatalogResponse, type CatalogSource, type InfoTone, PAGE_SIZE, accessLabel, catalogStatus, pageSlice, speedLabel } from "@/lib/info";

const TONES: readonly { key: InfoTone | "all"; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "danger", label: "위험" },
  { key: "warn", label: "주의" },
  { key: "ok", label: "정상" },
  { key: "neutral", label: "기록 없음" },
];

/** 출처 상태 — 모든 출처를 한 표에(분류·색으로 거름), 10줄씩. 위험·주의가 먼저 오게 늘어놓습니다. */
export function StatusSection() {
  const { data, loading, error, reload } = useApi<CatalogResponse>(endpoints.info.catalog, 120_000);
  const [tab, setTab] = useState("all");
  const [tone, setTone] = useState<InfoTone | "all">("all");
  const [page, setPage] = useState(1);
  const order: Record<InfoTone, number> = { danger: 0, warn: 1, neutral: 2, ok: 3 };
  const rows = (data?.sources ?? [])
    .filter((row) => (tab === "all" || row.tab === tab) && (tone === "all" || row.tone === tone))
    .sort((a, b) => order[a.tone] - order[b.tone]);
  const slice = pageSlice(rows, page, PAGE_SIZE);
  return (
    <Card
      title="출처 상태"
      subtitle="수집기 실행 기록과 차단 통과 계층의 판정을 함께 봅니다. 차단은 바로, 형식 바뀜은 연속 2회, 받지 못함은 연속 3회부터 끊김으로 알립니다."
      source={data ? `상태 확인 ${data.checkedAt}` : undefined}
    >
      {loading && !data && <Loading />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && (
        <>
          <div className="mb-2 flex flex-wrap gap-2" role="group" aria-label="분류">
            {[{ key: "all", label: "전체 분류" }, ...data.tabs].map((entry) => (
              <button key={entry.key} type="button" aria-pressed={tab === entry.key} className={filterChipClasses(tab === entry.key)} onClick={() => { setTab(entry.key); setPage(1); }}>
                {entry.label}
              </button>
            ))}
          </div>
          <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="상태">
            {TONES.map((entry) => (
              <button key={entry.key} type="button" aria-pressed={tone === entry.key} className={filterChipClasses(tone === entry.key)} onClick={() => { setTone(entry.key); setPage(1); }}>
                {entry.label}
              </button>
            ))}
          </div>
          <p className="mb-1 text-xs text-text-3">{rows.length}곳</p>
          <Table<CatalogSource>
            label="출처 상태"
            rows={slice.rows}
            rowKey={(row) => row.task}
            emptyMessage="고른 조건에 맞는 출처가 없습니다."
            columns={[
              {
                key: "label",
                header: "출처",
                render: (row) =>
                  row.screen ? (
                    <Link href={row.screen} className="font-semibold hover:underline">
                      {row.label}
                    </Link>
                  ) : (
                    <span className="font-semibold">{row.label}</span>
                  ),
              },
              { key: "status", header: "상태", render: (row) => <StatusText tone={row.tone}>{catalogStatus(row)}</StatusText> },
              { key: "access", header: "접근", render: (row) => <span className="text-xs">{accessLabel(row.access)}</span> },
              { key: "speed", header: "주기", render: (row) => <span className="text-xs">{speedLabel(row.speed)}</span> },
              { key: "last", header: "마지막 실행", render: (row) => <span className="tabular-nums text-xs">{row.lastRunAt ?? EMPTY}</span> },
              { key: "next", header: "다음 실행", render: (row) => <span className="tabular-nums text-xs">{row.nextDueAt ?? EMPTY}</span> },
              {
                key: "detail",
                header: "사유·기록",
                className: "min-w-[20rem]",
                // 자르지 않습니다(2026-11-12 사용자 지적 — 두 줄에서 '…'으로 잘려 사유·실행 기록의 뒤가 보이지 않았음). 긴 글은 칸 안에서 줄을 바꿉니다.
                render: (row) => (
                  <span className="block whitespace-normal break-words text-xs leading-5 text-text-2">{row.incident?.reason ?? row.lastDetail ?? EMPTY}</span>
                ),
              },
            ]}
          />
          <Pager page={slice.page} pages={slice.pages} onChange={setPage} label="출처 상태" />
        </>
      )}
    </Card>
  );
}
