"use client";

import { stableCodesKey } from "@/lib/transforms";
import { streakText } from "@/lib/flows";
import { SignedBars } from "@/components/charts";
import { ChangeChip, DataTable } from "@/components/patterns";
import { Callout, Freshness, Loading, Panel, SourceBadge } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { formatKst, formatNumber, formatShares, formatSignedKrw, withMinusSign } from "@/lib/format";
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
 *
 * 작업대 P7: 표는 공용 조밀 표, 순매수 금액·주식 수는 오르내린 값이 아니라 본문 잉크 + 부호(음수 −, U+2212 — 예전에는 등락색만), 외국인 보유율의 변화는
 * 오르내린 값이라 공용 변화 칩(▲▼·부호·sr 글).
 */

/** 누적값 + 일수가 모자라면 "(n일)" — 본문 잉크, 음수 부호 −. 모르면 null(공용 표가 '—'를 그림 — 칸 함수가 null을 돌려줘야 함). */
function windowCell(value: FlowWindow | undefined, format: (n: number | null) => string) {
  if (!value || value.sum === null) return null;
  return (
    <span>
      {withMinusSign(format(value.sum))}
      {value.days < value.window && <span className="ml-1 text-xs text-text-3">({value.days}일)</span>}
    </span>
  );
}

/** 부호 있는 원화 금액(본문 잉크, 음수 −). 모르면 null. */
const signedKrw = (value: number | null) => (value === null ? null : withMinusSign(formatSignedKrw(value)));

// ------------------------------------------------------------------ 시장 전체
export function MarketFlowsPanel({ market }: { market: string }) {
  const { data, loading, error, refreshError } = useApi<MarketFlowsResponse>(endpoints.positioning.investorFlows, 300_000);
  const symbol = market === "KOSDAQ" ? "KOSDAQ" : "KOSPI";
  const summary = data?.markets?.[symbol];

  const marketName = symbol === "KOSPI" ? "코스피" : "코스닥";

  return (
    <Panel
      title={`${marketName} 전체 투자자별 매매대금`}
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
      {error && <Callout tone="warn">{error}</Callout>}
      {data && !summary && <Callout tone="warn">{data.message ?? `${symbol} 투자자별 매매대금이 없습니다.`}</Callout>}
      {summary?.isStale && (
        // 이어받은 시장은 위 수집 시각(다른 시장을 받은 때)과 달리 예전 값입니다(QA-076).
        <Callout tone="warn">
          이전 값 — 이번 수집 실패: {summary.staleReason ?? "사유 모름"}
          {summary.fetchedAt ? ` · ${formatKst(summary.fetchedAt)}에 받은 값` : ""}
        </Callout>
      )}
      {summary && (
        <div className="flex flex-col gap-4">
          <DataTable<FlowRow>
            dense
            scrollHint="overflow"
            caption={`${marketName} 투자자별 순매수`}
            rows={summary.investors ?? []}
            rowKey={(row) => row.key}
            columns={[
              { key: "label", header: "투자자", rowHeader: true, className: "whitespace-nowrap", cell: (row) => row.label },
              { key: "latest", header: "최근일 순매수", align: "right", cell: (row) => signedKrw(row.latest) },
              { key: "net5", header: "5일 누적", align: "right", cell: (row) => windowCell(row.net5, formatSignedKrw) },
              { key: "net20", header: "20일 누적", align: "right", cell: (row) => windowCell(row.net20, formatSignedKrw) },
              { key: "streak", header: "연속", align: "right", cell: (row) => streakText(row.streak, summary.records) },
            ]}
          />
          <div>
            <p className="mb-1 text-xs text-text-3">기관 세부 — 20일 누적 순매수 (억 원)</p>
            <SignedBars
              data={(summary.breakdown ?? [])
                .filter((row) => row.net20.sum !== null)
                .map((row) => ({ name: row.label, value: (row.net20.sum as number) / 1e8 }))}
              unit="억"
              valueName="20일 누적 순매수"
              ariaLabel={`${marketName} 기관 세부 20일 누적 순매수(억 원)`}
              height={240}
            />
          </div>
          <p className="text-xs text-text-3">{data?.note}</p>
        </div>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ 종목 지속성
/** 종목들의 투자자별 매매동향(토스 공식, 300초) — 코드가 없으면 읽지 않습니다. 순위 검사 칸이 같은 응답을 쓰도록 화면이 한 번 읽어 패널에 넘깁니다. */
export function useStockFlows(codes: readonly string[]) {
  const key = stableCodesKey([...codes]);
  return useApi<StockFlowsResponse>(key ? endpoints.positioning.stockFlows(key) : null, 300_000);
}

export type StockFlowsRead = ReturnType<typeof useStockFlows>;

/**
 * 수급 지속성 패널. `flows`(화면이 useStockFlows로 이미 읽은 것)를 주면 그것을 그리고 스스로 읽지 않습니다 — 순위 검사 칸과 같은 응답 하나(요청 그대로).
 * 주지 않으면(패널만 쓰는 곳) 스스로 읽습니다.
 */
export function StockFlowsPanel({ rows, flows }: { rows: { code: string; name: string }[]; flows?: StockFlowsRead }) {
  const own = useStockFlows(flows ? [] : rows.map((row) => row.code));
  const { data, loading, error, refreshError } = flows ?? own;
  const names = new Map(rows.map((row) => [row.code, row.name]));
  const stocks = (data?.stocks ?? []).filter((stock) => stock.available);
  const investor = (stock: StockFlowsResponse["stocks"][number], key: string) =>
    stock.investors?.find((row) => row.key === key);
  const pension = (stock: StockFlowsResponse["stocks"][number]) =>
    stock.breakdown?.find((row) => row.key === "pensionFund");

  return (
    <Panel
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
      {error && <Callout tone="warn">{error}</Callout>}
      {data && stocks.length === 0 && (
        <Callout tone="warn">{data.message ?? "이 종목들의 투자자별 매매동향이 아직 수집되지 않았습니다 (1시간 주기)."}</Callout>
      )}
      {stocks.length > 0 && (
        <>
          <DataTable
            dense
            count
            scrollHint="overflow"
            caption="수급 지속성"
            rows={stocks}
            rowKey={(stock) => stock.code}
            columns={[
              {
                key: "name",
                header: "종목",
                rowHeader: true,
                className: "break-keep",
                cell: (stock) => (
                  <span className="flex flex-col">
                    <span>{names.get(stock.code) ?? stock.code}</span>
                    <span className="text-xs text-text-3">
                      <span className="font-mono">{stock.code}</span> · {stock.latestDate}
                      {stock.provisional ? " 잠정" : ""}
                    </span>
                  </span>
                ),
              },
              {
                key: "f5",
                header: "외국인 5일",
                align: "right",
                cell: (stock) => windowCell(investor(stock, "foreigner")?.net5, formatShares),
              },
              {
                key: "f20",
                header: "외국인 20일",
                align: "right",
                cell: (stock) => windowCell(investor(stock, "foreigner")?.net20, formatShares),
              },
              {
                key: "fs",
                header: "외국인 연속",
                align: "right",
                cell: (stock) => streakText(investor(stock, "foreigner")?.streak, stock.records),
              },
              {
                key: "i20",
                header: "기관 20일",
                align: "right",
                cell: (stock) => windowCell(investor(stock, "institution")?.net20, formatShares),
              },
              {
                key: "is",
                header: "기관 연속",
                align: "right",
                cell: (stock) => streakText(investor(stock, "institution")?.streak, stock.records),
              },
              {
                key: "p20",
                header: "연기금 20일",
                align: "right",
                cell: (stock) => windowCell(pension(stock)?.net20, formatShares),
              },
              {
                key: "hold",
                header: "외국인 보유율",
                align: "right",
                cell: (stock) => {
                  const holding = stock.foreignerHolding;
                  if (!holding) return null;
                  return (
                    <span className="flex flex-col items-end">
                      <span>{formatNumber(holding.ratePct, 2)}%</span>
                      {holding.changePp !== null && <ChangeChip size="sm" nowrap change={holding.changePp} digits={2} unit="%p" />}
                    </span>
                  );
                },
              },
            ]}
          />
          <p className="mt-2 text-xs text-text-3">{data?.note} “(n일)”은 값이 있는 날만 더했다는 뜻입니다.</p>
        </>
      )}
    </Panel>
  );
}
