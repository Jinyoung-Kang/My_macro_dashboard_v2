"use client";

import { useState } from "react";
import { Pager } from "@/components/Pager";
import { DataTable } from "@/components/patterns";
import { Card, ErrorState, Freshness, LINK_CLASSES, Loading, SourceBadge, Tag } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { bypassBadge } from "@/lib/econCalendar";
import { endpoints } from "@/lib/endpoints";
import { EMPTY } from "@/lib/format";
import { type Guru, type GurusResponse, PAGE_SIZE, pageSlice, scoreText, splitText } from "@/lib/info";

/**
 * waedge 거장 — 이름난 투자자들의 최근 시장 견해(강세·중립·약세 점수와 요약). waedge가 기사로 매긴 점수이고 우리 계산이 아닙니다. 10명씩 쪽을
 * 나눕니다. ``embedded``면 다른 카드 안에 그립니다(뉴스·글). 표는 공용 조밀 표이고, 견해는 중립 태그('강세 +95' — 강세·약세는 오르내림이 아니라
 * 색으로 나르지 않음, 글이 뜻을 나름).
 */
export function GurusSection({ embedded = false }: { embedded?: boolean }) {
  const { data, loading, error, reload, refreshError } = useApi<GurusResponse>(endpoints.info.gurus, 600_000);
  const [page, setPage] = useState(1);
  const slice = pageSlice(data?.gurus ?? [], page, PAGE_SIZE);
  const Wrapper = embedded ? EmbeddedCard : Card;
  const badge = bypassBadge(data?.fetchTier);
  const counts = data?.counts;
  return (
    <Wrapper
      title="거장 시장 견해"
      source={
        data?.sourceUrl ? (
          <a href={data.sourceUrl} target="_blank" rel="noopener noreferrer" className={LINK_CLASSES}>
            {data.source ?? "WAEDGE NEWS 거장"} (비공식)
          </a>
        ) : (
          "WAEDGE NEWS 거장 (비공식)"
        )
      }
      subtitle="최근 기사에서 밝힌 시장 견해를 강세·중립·약세로 나누고 강세에서 약세를 뺀 점수(-100~+100)입니다. 점수는 waedge가 매긴 것입니다."
      actions={
        <span className="flex flex-wrap items-center gap-2">
          {badge && <SourceBadge>{badge}</SourceBadge>}
          <Freshness collectedAt={data?.collectedAtKst} ageSeconds={data?.ageSeconds} refreshError={refreshError} />
        </span>
      }
    >
      {loading && !data && <Loading />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && <p className="text-sm text-text-2">아직 받은 견해가 없습니다. 운영 서버가 8~16시간에 한 번 받습니다.</p>}
      {data?.available && (
        <>
          <p className="mb-3 text-sm text-text-2">
            {counts?.total ?? EMPTY}명 · 강세 {counts?.bull ?? EMPTY} · 중립 {counts?.neutral ?? EMPTY} · 약세 {counts?.bear ?? EMPTY}
            {data.asOf ? ` · 기준일 ${data.asOf}` : ""}
          </p>
          <DataTable<Guru>
            dense
            caption="거장 견해"
            rows={slice.rows}
            rowKey={(row) => row.name}
            emptyText="견해가 없습니다."
            scrollHint="overflow"
            columns={[
              { key: "name", header: "이름", className: "min-w-[7rem] break-keep", cell: (row) => <span className="font-semibold">{row.name}</span> },
              {
                key: "stance",
                header: "견해",
                className: "whitespace-nowrap",
                cell: (row) => (row.stance === null && (row.score === null || row.score === undefined) ? null : <Tag>{`${row.stance ?? EMPTY} ${scoreText(row.score)}`}</Tag>),
              },
              { key: "split", header: "나눔", className: "whitespace-nowrap", cell: (row) => <span className="text-caption">{splitText(row)}</span> },
              { key: "basis", header: "기사", align: "right", cell: (row) => (row.basisArticles === null ? null : `${row.basisArticles}건`) },
              {
                key: "summary",
                header: "요약",
                className: "min-w-[18rem]",
                cell: (row) => (row.summary ? <span className="block break-keep wrap-anywhere text-caption leading-5 text-text-2">{row.summary}</span> : null),
              },
            ]}
          />
          <Pager page={slice.page} pages={slice.pages} onChange={setPage} label="거장 견해" />
        </>
      )}
    </Wrapper>
  );
}

/** 다른 카드 안에 그릴 때 — 머리(제목·출처·신선도)만 작게. */
function EmbeddedCard({ title, source, subtitle, actions, children }: React.ComponentProps<typeof Card>) {
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text">{title}</h3>
          {subtitle && <p className="break-keep text-xs text-text-2">{subtitle}</p>}
          {source && <p className="text-xs text-text-3">{source}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
