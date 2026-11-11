"use client";

import Link from "next/link";
import { useState } from "react";
import { Pager } from "@/components/Pager";
import { Card, ErrorState, Loading, SourceBadge } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { EMPTY } from "@/lib/format";
import {
  CARD_PAGE_SIZE,
  type CatalogResponse,
  type CatalogSource,
  type SourceTab,
  accessLabel,
  catalogStatus,
  pageSlice,
  speedLabel,
  toneSummary,
} from "@/lib/info";

/** 한 탭(큰 분류)에 속한 출처 카드 — 접근 방식·기관·상태·마지막 실행·다음 실행·출처 링크·자료 화면. 8장씩 쪽을 나눕니다. */
export function CatalogSection({ tab }: { tab: SourceTab }) {
  const { data, loading, error, reload } = useApi<CatalogResponse>(endpoints.info.catalog, 120_000);
  const [page, setPage] = useState(1);
  const rows = data?.sources.filter((source) => source.tab === tab) ?? [];
  const slice = pageSlice(rows, page, CARD_PAGE_SIZE);
  const summary = data?.tabs.find((entry) => entry.key === tab);
  return (
    <Card
      title="출처"
      subtitle={summary ? `${summary.sources}곳 · ${toneSummary(summary.tones)}` : "이 분류의 출처와 지금 상태"}
      source={data ? `상태 확인 ${data.checkedAt}${data.collectorReachable ? "" : " · 수집기에 닿지 못해 마지막 실행을 모름"}` : undefined}
    >
      {loading && !data && <Loading />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && (
        <>
          <ul className="grid gap-3 md:grid-cols-2">
            {slice.rows.map((source) => (
              <SourceCard key={source.task} source={source} />
            ))}
          </ul>
          <Pager page={slice.page} pages={slice.pages} onChange={setPage} label="출처 카드" />
        </>
      )}
    </Card>
  );
}

export function SourceCard({ source }: { source: CatalogSource }) {
  return (
    <li className="flex flex-col gap-1.5 rounded-control border border-border bg-surface p-3 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-text">{source.label}</span>
        <SourceBadge>{accessLabel(source.access)}</SourceBadge>
      </div>
      <StatusText tone={source.tone}>
        {catalogStatus(source)}
        {source.streak && source.streak > 1 && source.politeStatus !== "ok" ? ` (연속 ${source.streak}회)` : ""}
      </StatusText>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-text-2">
        <dt>기관</dt>
        <dd>{source.origin}</dd>
        <dt>주기</dt>
        <dd>{speedLabel(source.speed)}</dd>
        <dt>마지막 실행</dt>
        <dd className="tabular-nums">{source.lastRunAt ?? EMPTY}</dd>
        {source.nextDueAt && (
          <>
            <dt>다음 실행</dt>
            <dd className="tabular-nums">{source.nextDueAt}</dd>
          </>
        )}
        {source.items !== null && (
          <>
            <dt>받은 글</dt>
            <dd className="tabular-nums">{source.items}편</dd>
          </>
        )}
      </dl>
      {(source.incident?.reason ?? source.lastDetail) && (
        <p className="line-clamp-2 text-xs leading-5 text-text-3">{source.incident?.reason ?? source.lastDetail}</p>
      )}
      <div className="flex flex-wrap gap-3 text-xs">
        {source.siteUrl && (
          <a href={source.siteUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
            출처 사이트
          </a>
        )}
        {source.screen && (
          <Link href={source.screen} className="text-accent hover:underline">
            자료 보기
          </Link>
        )}
      </div>
    </li>
  );
}
