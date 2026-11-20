"use client";

import { HorizontalBars } from "@/components/charts";
import { knownBars } from "@/lib/chartData";
import { ChangeCell, DataTable, KpiStrip } from "@/components/patterns";
import { Callout, ErrorState, Freshness, Loading, Panel } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { EMPTY, formatNumber } from "@/lib/format";
import type { RadarConsensusResponse } from "@/lib/types";
import { endpoints } from "@/lib/endpoints";
import { OmittedNote } from "./OmittedNote";
import { signedAmount } from "./RankingDetail";

/**
 * 외국인·기관 공통 순위(60초) — 위 조건(시장·매매 구분·기간·표시 종목 수)을 그대로 따릅니다. null이면 읽지 않습니다. 순위 검사 칸이 같은 응답을 쓰도록
 * 화면이 한 번 읽어 패널에 넘깁니다.
 */
export function useConsensus(params: { market: string; tradeType: string; interval: string; topN: string } | null) {
  return useApi<RadarConsensusResponse>(
    params
      ? endpoints.positioning.radarConsensus({ market: params.market, tradeType: params.tradeType, intervalType: params.interval, topN: params.topN })
      : null,
    60_000,
  );
}

export type ConsensusRead = ReturnType<typeof useConsensus>;

/**
 * 외국인·기관이 <b>같은 방향</b>으로 움직인 종목.
 *
 * <p>한쪽만 사는 종목과 둘이 함께 사는 종목은 뜻이 다릅니다. 예전에는 투자
 * 주체를 바꿔 가며 표 둘을 띄워 놓고 눈으로 겹치는 종목을 찾아야 했습니다.
 *
 * <p><b>이 표가 볼 수 없는 것</b> — 두 <b>상위 N개 목록의 교집합</b>입니다.
 * 소스(Daum)가 상위 목록만 주고 전체 종목의 수급은 주지 않기 때문에, 외국인
 * 상위 N 밖에서 사들인 종목은 기관이 1위로 샀더라도 여기 나오지 않습니다.
 * 표시 종목 수를 늘리면 그만큼 넓게 봅니다. 이 한계는 카드에도 적습니다.
 *
 * `consensus`는 화면이 useConsensus로 한 번 읽은 것(순위 검사 칸과 같은 응답) — 패널은 스스로 읽지 않습니다(예전 대체 길은 쓰는 화면이 없어 뗌 — P7 검토).
 */
export function ConsensusPanel({
  tradeType,
  topN,
  consensus,
}: {
  tradeType: string;
  topN: string;
  consensus: ConsensusRead;
}) {
  const { data, loading, error, reload, refreshError } = consensus;

  const buying = tradeType === "순매수";
  const rows = data?.rows ?? [];
  const top = knownBars(
    rows.slice(0, 15),
    (row) => row.name,
    (row) => row.totalEok,
  );

  return (
    <Panel
      title={`외국인·기관 공통 ${tradeType}`} source={data?.sources?.length ? data.sources.join(" · ") : "외국인·기관 순위와 같은 출처 (위 순위 카드 참고)"}
      subtitle={data?.note}
      actions={
        <Freshness
          collectedAt={data?.collectedAtKst}
          ageSeconds={data?.ageSeconds}
          stale={data?.stale}
          refreshError={refreshError}
        />
      }
    >
      {/* 안내 상자·KPI 띠·막대·표 사이는 12px(예전에는 주의 상자와 지표 칸 사이가 0px — D1 radar-banner-tiles-gap-zero). */}
      <div className="flex flex-col gap-3">
        {loading && !data && <Loading label="교집합을 계산하는 중…" />}
        {error && <ErrorState message={error} onRetry={reload} />}

        {data?.warning && <Callout tone="warn">{data.warning}</Callout>}

        {data && !data.available && (
          <Callout tone="warn">
            <div>{data.message ?? "공통 종목이 없습니다."}</div>
            {data.reasons && data.reasons.length > 0 && (
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs">
                {data.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
          </Callout>
        )}

        {rows.length > 0 && (
          <>
            <KpiStrip
              label={`공통 ${tradeType}`}
              items={[
                {
                  key: "count",
                  label: `공통 ${tradeType} 종목`,
                  value: rows.length,
                  format: (value) => formatNumber(value, 0),
                  unit: "개",
                  note: `외국인 ${data?.foreignCount ?? EMPTY}개 · 기관 ${data?.institutionCount ?? EMPTY}개 목록의 교집합`,
                },
                {
                  key: "top",
                  label: "합산 금액 1위",
                  value: rows[0]?.name ?? null,
                  valueKind: "label",
                  note: rows[0]?.totalEok === null || rows[0]?.totalEok === undefined ? null : `${signedAmount(rows[0].totalEok, 1)}억 원`,
                },
                {
                  key: "share",
                  label: "집중도",
                  value: (rows.length / Number(topN)) * 100,
                  format: (value) => formatNumber(value, 0),
                  unit: "%",
                  note: `상위 ${topN}개 중 겹친 비율 — 높을수록 두 주체가 같은 종목을 봅니다.`,
                },
              ]}
            />

            <div>
              <HorizontalBars
                data={top.bars}
                unit="억"
                digits={0}
                valueName={`외국인+기관 합산 ${tradeType} 금액`}
                ariaLabel={`외국인·기관 공통 ${tradeType} 상위 종목 합산 금액(억 원)`}
                height={Math.max(260, top.bars.length * 26)}
              />
              <OmittedNote count={top.omitted} />
            </div>

            <DataTable
              dense
              count
              scrollHint="overflow"
              caption={`외국인·기관 공통 ${tradeType}`}
              rows={rows}
              rowKey={(row) => row.code}
              columns={[
                {
                  key: "name",
                  header: "종목",
                  rowHeader: true,
                  className: "break-keep",
                  cell: (row) => (
                    <span className="flex flex-col">
                      <span>{row.name}</span>
                      <span className="font-mono text-xs text-text-3">{row.code}</span>
                    </span>
                  ),
                },
                { key: "changePct", header: "등락률", align: "right", cell: (row) => <ChangeCell changePct={row.changePct} /> },
                {
                  key: "foreign",
                  header: "외국인(억)",
                  align: "right",
                  cell: (row) => <AmountWithRank amount={row.foreignEok} rank={row.foreignRank} />,
                },
                {
                  key: "institution",
                  header: "기관(억)",
                  align: "right",
                  cell: (row) => <AmountWithRank amount={row.institutionEok} rank={row.institutionRank} />,
                },
                {
                  key: "total",
                  header: "합산(억)",
                  align: "right",
                  cell: (row) => (row.totalEok === null ? null : <span className="font-semibold">{signedAmount(row.totalEok, 1)}</span>),
                },
              ]}
            />

            <p className="text-xs leading-relaxed text-text-3">
              {buying
                ? "두 주체가 함께 담은 종목입니다. 한쪽만 사는 종목보다 수급의 방향이 뚜렷하지만, 그것이 수익을 뜻하지는 않습니다."
                : "두 주체가 함께 던진 종목입니다. 금액이 음수인 것은 순매도라는 뜻이며, 표기를 바꾸지 않았습니다."}{" "}
              출처: {(data?.sources ?? []).join(" · ") || "출처 미상"}
            </p>
          </>
        )}
      </div>
    </Panel>
  );
}

/** 금액(본문 잉크 + 부호, 음수 −) 아래 순위 보조 줄 — 순위를 모르면 '—'. */
function AmountWithRank({ amount, rank }: { amount: number | null; rank: number | null }) {
  return (
    <span className="flex flex-col items-end">
      <span>{signedAmount(amount, 1) ?? EMPTY}</span>
      <span className="text-xs text-text-3">{rank === null ? EMPTY : `${rank}위`}</span>
    </span>
  );
}
