"use client";

import { Card, ErrorState, Loading } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { type CatalogResponse, type SourceTab, toneSummary } from "@/lib/info";
import { SourceTable } from "./SourceTable";

/**
 * 한 탭(큰 분류)에 속한 출처 — 출처 상태와 같은 조밀 표(SourceTable — 상태·접근·주기·실행 시각·받은 글·기관, 10줄씩)이고 이름을 누르면 검사 칸에
 * 사유 전체·실행 시각 차례·출처 링크·자료 화면이 나옵니다. 패널 머리에 출처 수, 부제에 색별 수.
 */
export function CatalogSection({ tab }: { tab: SourceTab }) {
  const { data, loading, error, reload } = useApi<CatalogResponse>(endpoints.info.catalog, 120_000);
  const rows = data?.sources.filter((source) => source.tab === tab) ?? [];
  const summary = data?.tabs.find((entry) => entry.key === tab);
  return (
    <Card
      title="출처"
      count={data ? `${rows.length.toLocaleString("ko-KR")}곳` : undefined}
      subtitle={summary ? toneSummary(summary.tones) : "이 분류의 출처와 지금 상태"}
      source={data ? `상태 확인 ${data.checkedAt}${data.collectorReachable ? "" : " · 수집기에 닿지 못해 마지막 실행을 모름"}` : undefined}
    >
      {loading && !data && <Loading />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && <SourceTable sources={rows} variant="tab" caption="출처" pagerLabel="출처" emptyText="이 분류의 출처가 없습니다." count={false} />}
    </Card>
  );
}
