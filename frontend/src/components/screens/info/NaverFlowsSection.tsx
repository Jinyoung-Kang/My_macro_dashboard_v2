"use client";

import { Banner, Card, ErrorState, Freshness, Loading, SourceBadge, Table } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { bypassBadge } from "@/lib/econCalendar";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, formatNumber, formatSigned } from "@/lib/format";
import {
  NAVER_INVESTORS,
  NAVER_MARKETS,
  type NaverFlowsResponse,
  type RankRow,
  TREND_COLUMNS,
  type TrendRow,
  eokText,
  rankingBasis,
  sharesText,
} from "@/lib/info";

/**
 * 네이버 투자자별 매매동향(코스피·코스닥 최근 10거래일, 억 원)과 외국인·기관 순매수·순매도 상위(당일). 장중 순위는 네이버의 추정이라 금액이 없고
 * 주식 수만 보입니다('—'는 0이 아니라 출처가 주지 않은 값).
 */
export function NaverFlowsSection() {
  const { data, loading, error, reload, refreshError } = useApi<NaverFlowsResponse>(endpoints.info.flows, 300_000);
  const badge = bypassBadge(data?.fetchTier);
  return (
    <Card
      title="네이버 투자자별 매매동향·매매상위"
      source={
        <span className="flex flex-wrap gap-x-2">
          <span>{data?.source ?? "네이버 증권"} (비공식) ·</span>
          <a href={data?.sourceUrls?.trader ?? "https://stock.naver.com/market/stock/kr/trend/trader"} target="_blank" rel="noopener noreferrer" className="hover:underline">
            매매동향
          </a>
          <a href={data?.sourceUrls?.foreigner ?? "https://stock.naver.com/market/stock/kr/trend/foreigner"} target="_blank" rel="noopener noreferrer" className="hover:underline">
            외국인
          </a>
          <a href={data?.sourceUrls?.organization ?? "https://stock.naver.com/market/stock/kr/trend/organization"} target="_blank" rel="noopener noreferrer" className="hover:underline">
            기관
          </a>
        </span>
      }
      subtitle="정규장에는 40~90분, 장 밖에는 몇 시간에 한 번 불규칙하게 받습니다. 수급 레이더·모의매매 판단과는 따로 보는 참고 자료입니다."
      actions={
        <span className="flex flex-wrap items-center gap-2">
          {badge && <SourceBadge>{badge}</SourceBadge>}
          <Freshness collectedAt={data?.collectedAtKst} ageSeconds={data?.ageSeconds} refreshError={refreshError} />
        </span>
      }
    >
      {loading && !data && <Loading />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && <p className="text-sm text-text-2">아직 받은 자료가 없습니다. 운영 서버에서만 수집합니다.</p>}
      {data?.available && (
        <div className="space-y-6">
          {(data.failed?.length ?? 0) > 0 && (
            <Banner tone="warn">이번 수집에서 {data.failed?.length}개 부분을 받지 못해 이전 값을 보입니다: {data.failed?.join(", ")}</Banner>
          )}
          {NAVER_MARKETS.map((market) => {
            const trend = data.trend?.[market.key];
            return (
              <section key={market.key}>
                <h3 className="mb-2 text-sm font-semibold text-text">
                  {market.label} 투자자별 순매수(억 원){trend?.isStale ? " · 이전 값" : ""}
                </h3>
                <Table<TrendRow>
                  label={`${market.label} 투자자별 순매수`}
                  rows={trend?.rows ?? []}
                  rowKey={(row) => row.date}
                  emptyMessage="받은 날짜가 없습니다."
                  columns={[
                    { key: "date", header: "날짜", render: (row) => <span className="tabular-nums">{row.date}</span> },
                    ...TREND_COLUMNS.map((column) => ({
                      key: column.key,
                      header: column.label,
                      align: "right" as const,
                      render: (row: TrendRow) => <span className="tabular-nums">{row[column.key] === null ? EMPTY : formatSigned(row[column.key], 1)}</span>,
                    })),
                  ]}
                />
              </section>
            );
          })}
          {NAVER_INVESTORS.map((investor) =>
            NAVER_MARKETS.map((market) => {
              const part = data.rankings?.[investor.key]?.[market.key];
              return (
                <section key={`${investor.key}-${market.key}`}>
                  <h3 className="text-sm font-semibold text-text">
                    {investor.label} 매매상위 · {market.label}
                  </h3>
                  <p className="mb-2 text-xs text-text-2">{rankingBasis(part)}</p>
                  <div className="grid gap-4 lg:grid-cols-2">
                    <RankTable title={`${investor.label} 순매수 상위 · ${market.label}`} rows={part?.buy ?? []} />
                    <RankTable title={`${investor.label} 순매도 상위 · ${market.label}`} rows={part?.sell ?? []} />
                  </div>
                </section>
              );
            }),
          )}
        </div>
      )}
    </Card>
  );
}

function RankTable({ title, rows }: { title: string; rows: RankRow[] }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold text-text-2">{title.split(" · ")[0].replace(/^(외국인|기관) /, "")}</h4>
      <Table<RankRow>
        label={title}
        rows={rows.slice(0, 20)}
        rowKey={(row, index) => `${row.code ?? "?"}-${index}`}
        emptyMessage="순위가 없습니다."
        columns={[
          { key: "rank", header: "순위", align: "right", render: (row) => row.rank },
          { key: "name", header: "종목", render: (row) => row.name ?? EMPTY },
          { key: "price", header: "현재가", align: "right", render: (row) => <span className="tabular-nums">{formatNumber(row.price, 0)}</span> },
          { key: "change", header: "등락률", align: "right", render: (row) => <span className="tabular-nums">{row.changePct === null ? EMPTY : formatSigned(row.changePct, 2, "%")}</span> },
          { key: "amount", header: "순매수 금액", align: "right", render: (row) => <span className="tabular-nums">{eokText(row.netAmountEok)}</span> },
          { key: "volume", header: "순매수 수량", align: "right", render: (row) => <span className="tabular-nums">{sharesText(row.netVolume)}</span> },
        ]}
      />
    </div>
  );
}
