"use client";

import { useState } from "react";
import { FilterList } from "@/components/patterns";
import { Card, ErrorState, Loading } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { type CatalogResponse, type InfoTone } from "@/lib/info";
import { SourceTable } from "./SourceTable";

const TONES: readonly { key: InfoTone | "all"; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "danger", label: "위험" },
  { key: "warn", label: "주의" },
  { key: "ok", label: "정상" },
  { key: "neutral", label: "기록 없음" },
];

const ORDER: Record<InfoTone, number> = { danger: 0, warn: 1, neutral: 2, ok: 3 };

/**
 * 출처 상태 — 모든 출처를 한 표에(분류·상태로 거름), 10줄씩. 위험·주의가 먼저 오게 늘어놓습니다. 출처 이름을 누르면 검사 칸(SourceTable).
 * 거르기는 하나만 고르는 태그 줄 둘(공용 FilterList — 라디오 묶음, 강조 파랑 없는 잉크 고름)이고, 바꾸면 첫 쪽으로 갑니다.
 */
export function StatusSection() {
  const { data, loading, error, reload } = useApi<CatalogResponse>(endpoints.info.catalog, 120_000);
  const [tab, setTab] = useState("all");
  const [tone, setTone] = useState<InfoTone | "all">("all");
  const rows = (data?.sources ?? [])
    .filter((row) => (tab === "all" || row.tab === tab) && (tone === "all" || row.tone === tone))
    .sort((a, b) => ORDER[a.tone] - ORDER[b.tone]);
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
          <div className="mb-3 flex flex-col gap-2">
            <FilterList
              label="분류"
              selection="single"
              wide="wrap"
              items={[{ key: "all", label: "전체 분류" }, ...data.tabs.map((entry) => ({ key: entry.key, label: entry.label }))]}
              selected={[tab]}
              onToggle={setTab}
            />
            <FilterList label="상태" selection="single" wide="wrap" items={TONES} selected={[tone]} onToggle={(key) => setTone(key as InfoTone | "all")} />
          </div>
          {/* 거르기를 바꾸면 표를 새로 그립니다 — 첫 쪽으로, 고른 줄도 풂(지금처럼 쪽 1). */}
          <SourceTable
            key={`${tab}:${tone}`}
            sources={rows}
            variant="status"
            caption="출처 상태"
            pagerLabel="출처 상태"
            emptyText="고른 조건에 맞는 출처가 없습니다."
          />
        </>
      )}
    </Card>
  );
}
