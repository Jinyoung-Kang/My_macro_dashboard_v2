"use client";

import { stableCodesKey } from "@/lib/transforms";
import { streakText } from "@/lib/flows";
import { SignedBars } from "@/components/charts";
import { Banner, Card, Freshness, Loading, SourceBadge, Table } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { deltaColor, EMPTY, formatKst, formatNumber, formatShares, formatSignedKrw } from "@/lib/format";
import type { FlowRow, FlowWindow, MarketFlowsResponse, StockFlowsResponse } from "@/lib/types";
import { endpoints } from "@/lib/endpoints";

/**
 * 토스증권 공식 투자자별 매매 — 레이더 화면의 두 패널.
 *
 * 레이더 랭킹(KIS·Daum 등)은 "오늘 누가 많이 샀나"를 말합니다. 여기서는 두 가지를 보탭니다.
 *   1. 시장 전체 — 외국인·기관·개인이 코스피/코스닥 전체에서 얼마를 샀나(원), 기관 중 누구였나
 *   2. 종목 지속성 — 랭킹에 오른 종목을 며칠째 사고 있나(주), 연기금도 샀나, 외국인 보유율이 늘었나
 *
 * 값이 없는 날(당일 잠정치의 개인·기관 세부)은 0이 아니라 "—"입니다. 누적이 모자란 날수로
 * 계산됐으면 "(n일)"을 붙입니다.
 */

/** 누적값 + 일수가 모자라면 "(n일)". */
function WindowCell({ value, format }: { value: FlowWindow; format: (n: number | null) => string }) {
  return (
    <span className={deltaColor(value.sum, 0)}>
      {format(value.sum)}
      {value.sum !== null && value.days < value.window && (
        <span className="ml-1 text-[10px] text-muted">({value.days}일)</span>
      )}
    </span>
  );
}

// ------------------------------------------------------------------ 시장 전체
export function MarketFlowsPanel({ market }: { market: string }) {
  const { data, loading, error, refreshError } = useApi<MarketFlowsResponse>(endpoints.positioning.investorFlows, 300_000);
  const symbol = market === "KOSDAQ" ? "KOSDAQ" : "KOSPI";
  const summary = data?.markets?.[symbol];

  return (
    <Card
      title={`${symbol === "KOSPI" ? "코스피" : "코스닥"} 전체 투자자별 매매대금`}
      source={data?.source ?? "토스증권 Open API (공식)"}
      subtitle={
        summary?.latestDate
          ? `기준일 ${summary.latestDate} · 갱신 ${formatKst(summary.latestUpdatedAt)}`
          : undefined
      }
      actions={
        <span className="flex items-center gap-2">
          {summary?.provisional && <SourceBadge>장중 잠정치</SourceBadge>}
          <Freshness collectedAt={data?.collectedAtKst} ageSeconds={data?.ageSeconds} refreshError={refreshError} />
        </span>
      }
    >
      {loading && !data && <Loading />}
      {error && <Banner tone="warn">{error}</Banner>}
      {data && !summary && <Banner tone="warn">{data.message ?? `${symbol} 투자자별 매매대금이 없습니다.`}</Banner>}
      {summary?.isStale && (
        // 이어받은 시장은 위 수집 시각(다른 시장을 받은 때)과 달리 예전 값입니다(QA-076).
        <Banner tone="warn">
          이전 값 — 이번 수집 실패: {summary.staleReason ?? "사유 모름"}
          {summary.fetchedAt ? ` · ${formatKst(summary.fetchedAt)}에 받은 값` : ""}
        </Banner>
      )}
      {summary && (
        <div className="flex flex-col gap-4">
          <Table<FlowRow>
            rows={summary.investors ?? []}
            rowKey={(row) => row.key}
            columns={[
              { key: "label", header: "투자자", render: (row) => row.label },
              {
                key: "latest",
                header: `최근일 순매수`,
                align: "right",
                render: (row) => <span className={deltaColor(row.latest, 0)}>{formatSignedKrw(row.latest)}</span>,
              },
              { key: "net5", header: "5일 누적", align: "right", render: (row) => <WindowCell value={row.net5} format={formatSignedKrw} /> },
              { key: "net20", header: "20일 누적", align: "right", render: (row) => <WindowCell value={row.net20} format={formatSignedKrw} /> },
              { key: "streak", header: "연속", align: "right", render: (row) => streakText(row.streak, summary.records) },
            ]}
          />
          <div>
            <p className="mb-1 text-xs text-muted">기관 세부 — 20일 누적 순매수 (억 원)</p>
            <SignedBars
              data={(summary.breakdown ?? [])
                .filter((row) => row.net20.sum !== null)
                .map((row) => ({ name: row.label, value: (row.net20.sum as number) / 1e8 }))}
              unit="억"
              valueName="20일 누적 순매수"
              height={240}
            />
          </div>
          <p className="text-[11px] text-muted">{data?.note}</p>
        </div>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ 종목 지속성
export function StockFlowsPanel({ rows }: { rows: { code: string; name: string }[] }) {
  const codes = stableCodesKey(rows.map((row) => row.code));
  const { data, loading, error, refreshError } = useApi<StockFlowsResponse>(
    codes ? endpoints.positioning.stockFlows(codes) : null,
    300_000,
  );
  const names = new Map(rows.map((row) => [row.code, row.name]));
  const stocks = (data?.stocks ?? []).filter((stock) => stock.available);
  const investor = (stock: StockFlowsResponse["stocks"][number], key: string) =>
    stock.investors?.find((row) => row.key === key);
  const pension = (stock: StockFlowsResponse["stocks"][number]) =>
    stock.breakdown?.find((row) => row.key === "pensionFund");

  return (
    <Card
      title="수급 지속성 — 며칠째 사고 있나 (종목별 20거래일)"
      source={data?.source ?? "토스증권 Open API (공식)"}
      actions={
        <span className="flex items-center gap-2">
          {/* 자동 갱신이 실패하면 앞서 받은 값을 그대로 보이므로 '새로 읽지 못함'을 붙입니다(QA-104, QA-067과 같음). */}
          <Freshness refreshError={refreshError} />
          <SourceBadge>단위: 주</SourceBadge>
        </span>
      }
    >
      {loading && !data && <Loading />}
      {error && <Banner tone="warn">{error}</Banner>}
      {data && stocks.length === 0 && (
        <Banner tone="warn">{data.message ?? "이 종목들의 투자자별 매매동향이 아직 수집되지 않았습니다 (1시간 주기)."}</Banner>
      )}
      {stocks.length > 0 && (
        <>
          <Table
            rows={stocks}
            rowKey={(stock) => stock.code}
            columns={[
              {
                key: "name",
                header: "종목",
                render: (stock) => (
                  <span className="flex flex-col">
                    <span className="text-body">{names.get(stock.code) ?? stock.code}</span>
                    <span className="text-[11px] text-muted">
                      {stock.code} · {stock.latestDate}
                      {stock.provisional ? " 잠정" : ""}
                    </span>
                  </span>
                ),
              },
              {
                key: "f5",
                header: "외국인 5일",
                align: "right",
                render: (stock) => { const row = investor(stock, "foreigner"); return row ? <WindowCell value={row.net5} format={formatShares} /> : EMPTY; },
              },
              {
                key: "f20",
                header: "외국인 20일",
                align: "right",
                render: (stock) => { const row = investor(stock, "foreigner"); return row ? <WindowCell value={row.net20} format={formatShares} /> : EMPTY; },
              },
              {
                key: "fs",
                header: "외국인 연속",
                align: "right",
                render: (stock) => streakText(investor(stock, "foreigner")?.streak, stock.records),
              },
              {
                key: "i20",
                header: "기관 20일",
                align: "right",
                render: (stock) => { const row = investor(stock, "institution"); return row ? <WindowCell value={row.net20} format={formatShares} /> : EMPTY; },
              },
              {
                key: "is",
                header: "기관 연속",
                align: "right",
                render: (stock) => streakText(investor(stock, "institution")?.streak, stock.records),
              },
              {
                key: "p20",
                header: "연기금 20일",
                align: "right",
                render: (stock) => { const row = pension(stock); return row ? <WindowCell value={row.net20} format={formatShares} /> : EMPTY; },
              },
              {
                key: "hold",
                header: "외국인 보유율",
                align: "right",
                render: (stock) => {
                  const holding = stock.foreignerHolding;
                  if (!holding) return EMPTY;
                  return (
                    <span className="flex flex-col items-end">
                      <span>{formatNumber(holding.ratePct, 2)}%</span>
                      {holding.changePp !== null && (
                        <span className={`text-[11px] ${deltaColor(holding.changePp, 2)}`}>
                          {holding.changePp > 0 ? "+" : ""}
                          {formatNumber(holding.changePp, 2)}%p
                        </span>
                      )}
                    </span>
                  );
                },
              },
            ]}
          />
          <p className="mt-2 text-[11px] text-muted">{data?.note} “(n일)”은 값이 있는 날만 더했다는 뜻입니다.</p>
        </>
      )}
    </Card>
  );
}
