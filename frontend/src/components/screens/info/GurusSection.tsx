"use client";

import { Card, ErrorState, Freshness, Loading, SourceBadge, Table } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { bypassBadge } from "@/lib/econCalendar";
import { endpoints } from "@/lib/endpoints";
import { EMPTY } from "@/lib/format";
import { type Guru, type GurusResponse, scoreText, splitText, stanceTone } from "@/lib/info";

/** waedge 거장 — 이름난 투자자들의 최근 시장 견해(강세·중립·약세 점수와 요약). waedge가 기사로 매긴 점수이고 우리 계산이 아닙니다. */
export function GurusSection() {
  const { data, loading, error, reload, refreshError } = useApi<GurusResponse>(endpoints.info.gurus, 600_000);
  const badge = bypassBadge(data?.fetchTier);
  const counts = data?.counts;
  return (
    <Card
      title="거장 시장 견해"
      source={
        data?.sourceUrl ? (
          <a href={data.sourceUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">
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
          <Table<Guru>
            label="거장 견해"
            rows={data.gurus ?? []}
            rowKey={(row) => row.name}
            emptyMessage="견해가 없습니다."
            columns={[
              { key: "name", header: "이름", render: (row) => <span className="font-semibold">{row.name}</span> },
              {
                key: "stance",
                header: "견해",
                render: (row) => (
                  <StatusText tone={stanceTone(row.stance)} icon={false}>
                    {row.stance ?? EMPTY} {scoreText(row.score)}
                  </StatusText>
                ),
              },
              { key: "split", header: "나눔", render: (row) => <span className="whitespace-nowrap text-xs">{splitText(row)}</span> },
              { key: "basis", header: "기사", align: "right", render: (row) => (row.basisArticles === null ? EMPTY : `${row.basisArticles}건`) },
              { key: "summary", header: "요약", className: "min-w-[18rem]", render: (row) => <span className="text-[13px] leading-5">{row.summary ?? EMPTY}</span> },
            ]}
          />
        </>
      )}
    </Card>
  );
}
