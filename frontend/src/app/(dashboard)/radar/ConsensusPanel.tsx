"use client";

import { HorizontalBars } from "@/components/charts";
import { knownBars } from "@/lib/chartData";
import { Banner, Card, ErrorState, Freshness, Loading, Metric, Table } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { deltaColor, EMPTY, formatNumber, formatPercent, formatWithUnit } from "@/lib/format";
import type { RadarConsensusResponse } from "@/lib/types";
import { endpoints } from "@/lib/endpoints";
import { OmittedNote } from "./OmittedNote";

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
 * `consensus`(화면이 useConsensus로 이미 읽은 것)를 주면 스스로 읽지 않습니다.
 */
export function ConsensusPanel({
  market,
  tradeType,
  interval,
  topN,
  consensus,
}: {
  market: string;
  tradeType: string;
  interval: string;
  topN: string;
  consensus?: ConsensusRead;
}) {
  const own = useConsensus(consensus ? null : { market, tradeType, interval, topN });
  const { data, loading, error, reload, refreshError } = consensus ?? own;

  const buying = tradeType === "순매수";
  const rows = data?.rows ?? [];
  const top = knownBars(
    rows.slice(0, 15),
    (row) => row.name,
    (row) => row.totalEok,
  );

  return (
    <Card
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
      {loading && !data && <Loading label="교집합을 계산하는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}

      {data?.warning && <Banner tone="warn">{data.warning}</Banner>}

      {data && !data.available && (
        <Banner tone="warn">
          <div>{data.message ?? "공통 종목이 없습니다."}</div>
          {data.reasons && data.reasons.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs">
              {data.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </Banner>
      )}

      {rows.length > 0 && (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <Metric
              label={`공통 ${tradeType} 종목`}
              value={`${rows.length}개`}
              caption={`외국인 ${data?.foreignCount ?? EMPTY}개 · 기관 ${
                data?.institutionCount ?? EMPTY
              }개 목록의 교집합`}
            />
            <Metric
              label="합산 금액 1위"
              value={rows[0]?.name ?? EMPTY}
              caption={formatWithUnit(rows[0]?.totalEok, 1, "억 원")}
            />
            <Metric
              label="집중도"
              value={`${formatNumber((rows.length / Number(topN)) * 100, 0)}%`}
              caption={`상위 ${topN}개 중 겹친 비율 — 높을수록 두 주체가 같은 종목을 봅니다.`}
            />
          </div>

          <HorizontalBars
            data={top.bars}
            unit="억"
            digits={0}
            valueName={`외국인+기관 합산 ${tradeType} 금액`}
            height={Math.max(260, top.bars.length * 26)}
          />
          <OmittedNote count={top.omitted} />

          <div className="mt-4">
            <Table
              rows={rows}
              rowKey={(row) => row.code}
              columns={[
                {
                  key: "name",
                  header: "종목",
                  render: (row) => (
                    <span className="flex flex-col">
                      <span className="text-text-2">{row.name}</span>
                      <span className="text-xs text-text-3">{row.code}</span>
                    </span>
                  ),
                },
                {
                  key: "changePct",
                  header: "등락률",
                  align: "right",
                  render: (row) => (
                    <span className={deltaColor(row.changePct)}>
                      {formatPercent(row.changePct)}
                    </span>
                  ),
                },
                {
                  key: "foreign",
                  header: "외국인(억)",
                  align: "right",
                  render: (row) => (
                    <span className="flex flex-col items-end">
                      <span className={deltaColor(row.foreignEok, 1)}>
                        {formatNumber(row.foreignEok, 1)}
                      </span>
                      <span className="text-xs text-text-3">
                        {row.foreignRank === null ? EMPTY : `${row.foreignRank}위`}
                      </span>
                    </span>
                  ),
                },
                {
                  key: "institution",
                  header: "기관(억)",
                  align: "right",
                  render: (row) => (
                    <span className="flex flex-col items-end">
                      <span className={deltaColor(row.institutionEok, 1)}>
                        {formatNumber(row.institutionEok, 1)}
                      </span>
                      <span className="text-xs text-text-3">
                        {row.institutionRank === null ? EMPTY : `${row.institutionRank}위`}
                      </span>
                    </span>
                  ),
                },
                {
                  key: "total",
                  header: "합산(억)",
                  align: "right",
                  render: (row) => (
                    <span className={`font-semibold ${deltaColor(row.totalEok, 1)}`}>
                      {formatNumber(row.totalEok, 1)}
                    </span>
                  ),
                },
              ]}
            />
          </div>

          <p className="mt-2 text-xs leading-relaxed text-text-3">
            {buying
              ? "두 주체가 함께 담은 종목입니다. 한쪽만 사는 종목보다 수급의 방향이 뚜렷하지만, 그것이 수익을 뜻하지는 않습니다."
              : "두 주체가 함께 던진 종목입니다. 금액이 음수인 것은 순매도라는 뜻이며, 표기를 바꾸지 않았습니다."}{" "}
            출처: {(data?.sources ?? []).join(" · ") || "출처 미상"}
          </p>
        </>
      )}
    </Card>
  );
}
