"use client";

import { useState } from "react";
import { Pager } from "@/components/Pager";
import { Card, ErrorState, Freshness, Loading, NativeSelect, SourceBadge, Table } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, formatNumber, formatSigned } from "@/lib/format";
import {
  type KrxForeign,
  type KrxRank,
  type KrxResponse,
  type KrxShortBalance,
  type KrxShortTrade,
  type KrxTotal,
  NAVER_MARKETS,
  type NaverMarket,
  PAGE_SIZE,
  eokText,
  pageSlice,
  partBasis,
  sharesText,
} from "@/lib/info";

const INVESTORS = ["외국인", "기관", "개인", "연기금", "금융투자", "투신"];

/**
 * KRX 정보데이터시스템(로그인, ADR 0036) — 거래일 저녁(18:30 뒤) 서버가 한 번 받는 공식 확정 자료: 투자자별 순매수 상위(수급 레이더의 확정
 * 순위와 같은 저장본), 투자자별 거래실적(시장 합계), 외국인 보유 비중 상위, 공매도 거래·잔고 상위(잔고는 2~3거래일 늦게 공개). 표는 10줄씩.
 */
export function KrxSection() {
  const [market, setMarket] = useState<NaverMarket>("KOSPI");
  const [investor, setInvestor] = useState("외국인");
  const [tradeType, setTradeType] = useState<"순매수" | "순매도">("순매수");
  const { data, loading, error, reload, refreshError } = useApi<KrxResponse>(endpoints.info.krx(market, investor, tradeType), 600_000);
  return (
    <Card
      title="KRX 정보데이터시스템"
      source={
        <a href="https://data.krx.co.kr/" target="_blank" rel="noopener noreferrer" className="hover:underline">
          한국거래소 정보데이터시스템(계정 로그인) · 확정치
        </a>
      }
      subtitle="거래일 18:30 뒤 운영 서버가 그날 확정 자료를 한 번 받습니다. 수급 레이더의 과거 날짜·여섯 투자주체 확정 순위도 이 자료입니다."
      actions={
        <span className="flex flex-wrap items-center gap-2">
          {data?.asOf && <SourceBadge>기준일 {data.asOf}</SourceBadge>}
          <Freshness collectedAt={data?.collectedAtKst} ageSeconds={data?.ageSeconds} refreshError={refreshError} />
        </span>
      }
    >
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Choice label="시장" value={market} onChange={(v) => setMarket(v as NaverMarket)} options={NAVER_MARKETS.map((m) => [m.key, m.label])} />
        <Choice label="투자주체" value={investor} onChange={setInvestor} options={INVESTORS.map((v) => [v, v])} />
        <Choice label="방향" value={tradeType} onChange={(v) => setTradeType(v as "순매수" | "순매도")} options={[["순매수", "순매수"], ["순매도", "순매도"]]} />
      </div>
      {loading && !data && <Loading />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && (
        <div className="space-y-6">
          <Paged<KrxRank>
            title={`${investor} ${tradeType} 상위 · ${market === "KOSPI" ? "코스피" : "코스닥"}`}
            basis={data.ranking.date ? `기준일 ${data.ranking.date}` : "받은 순위 없음 — 운영 서버의 첫 수집 뒤 보입니다"}
            rows={data.ranking.rows}
            columns={[
              { key: "rank", header: "순위", align: "right", render: (r) => r.rank },
              { key: "name", header: "종목", render: (r) => `${r.name} (${r.code})` },
              { key: "net", header: "순매수 금액", align: "right", render: (r) => <span className="tabular-nums">{eokText(r.netAmountEok)}</span> },
              { key: "vol", header: "순매수 수량", align: "right", render: (r) => <span className="tabular-nums">{sharesText(r.netVolume)}</span> },
              { key: "buy", header: "매수", align: "right", render: (r) => <span className="tabular-nums">{r.buyEok === null ? EMPTY : `${formatNumber(r.buyEok, 1)}억`}</span> },
              { key: "sell", header: "매도", align: "right", render: (r) => <span className="tabular-nums">{r.sellEok === null ? EMPTY : `${formatNumber(r.sellEok, 1)}억`}</span> },
            ]}
          />
          {data.available ? (
            <>
              <Paged<KrxTotal>
                title={`투자자별 거래실적(시장 합계) · ${market === "KOSPI" ? "코스피" : "코스닥"}`}
                basis={partBasis(data.totals?.[market])}
                rows={data.totals?.[market]?.rows ?? []}
                columns={[
                  { key: "inv", header: "투자자", render: (r) => r.investor },
                  { key: "net", header: "순매수", align: "right", render: (r) => <span className="tabular-nums">{eokText(r.netEok)}</span> },
                  { key: "buy", header: "매수", align: "right", render: (r) => <span className="tabular-nums">{r.buyEok === null ? EMPTY : `${formatNumber(r.buyEok, 1)}억`}</span> },
                  { key: "sell", header: "매도", align: "right", render: (r) => <span className="tabular-nums">{r.sellEok === null ? EMPTY : `${formatNumber(r.sellEok, 1)}억`}</span> },
                ]}
              />
              <Paged<KrxForeign>
                title={`외국인 보유 비중 상위 · ${market === "KOSPI" ? "코스피" : "코스닥"}`}
                basis={partBasis(data.foreign?.[market])}
                rows={data.foreign?.[market]?.rows ?? []}
                columns={[
                  { key: "name", header: "종목", render: (r) => `${r.name ?? EMPTY} (${r.code})` },
                  { key: "pct", header: "보유 비중", align: "right", render: (r) => <span className="tabular-nums">{r.holdPct === null ? EMPTY : `${formatNumber(r.holdPct, 2)}%`}</span> },
                  { key: "lmt", header: "한도소진율", align: "right", render: (r) => <span className="tabular-nums">{r.limitExhaustPct === null ? EMPTY : `${formatNumber(r.limitExhaustPct, 2)}%`}</span> },
                  { key: "close", header: "종가", align: "right", render: (r) => <span className="tabular-nums">{formatNumber(r.close, 0)}</span> },
                  { key: "chg", header: "등락률", align: "right", render: (r) => <span className="tabular-nums">{r.changePct === null ? EMPTY : formatSigned(r.changePct, 2, "%")}</span> },
                ]}
              />
              <Paged<KrxShortTrade>
                title={`공매도 거래대금 상위 · ${market === "KOSPI" ? "코스피" : "코스닥"}`}
                basis={partBasis(data.shortTrades?.[market])}
                rows={data.shortTrades?.[market]?.rows ?? []}
                columns={[
                  { key: "name", header: "종목", render: (r) => `${r.name ?? EMPTY} (${r.code})` },
                  { key: "amt", header: "공매도 거래대금", align: "right", render: (r) => <span className="tabular-nums">{r.shortEok === null ? EMPTY : `${formatNumber(r.shortEok, 1)}억`}</span> },
                  { key: "wt", header: "거래대금 비중", align: "right", render: (r) => <span className="tabular-nums">{r.tradeValueWeightPct === null ? EMPTY : `${formatNumber(r.tradeValueWeightPct, 2)}%`}</span> },
                ]}
              />
              <Paged<KrxShortBalance>
                title={`공매도 잔고 상위 · ${market === "KOSPI" ? "코스피" : "코스닥"}`}
                basis={`${partBasis(data.shortBalances?.[market])} (잔고는 2~3거래일 늦게 공개)`}
                rows={data.shortBalances?.[market]?.rows ?? []}
                columns={[
                  { key: "name", header: "종목", render: (r) => `${r.name ?? EMPTY} (${r.code})` },
                  { key: "amt", header: "잔고 금액", align: "right", render: (r) => <span className="tabular-nums">{r.balanceEok === null ? EMPTY : `${formatNumber(r.balanceEok, 1)}억`}</span> },
                  { key: "pct", header: "잔고 비율", align: "right", render: (r) => <span className="tabular-nums">{r.balancePct === null ? EMPTY : `${formatNumber(r.balancePct, 2)}%`}</span> },
                ]}
              />
            </>
          ) : (
            <p className="text-sm text-text-2">시장 합계·외국인 보유·공매도 저장본이 아직 없습니다(운영 서버에서 거래일 저녁에 받음).</p>
          )}
        </div>
      )}
    </Card>
  );
}

function Choice({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[][] }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-text-2">
      {label}
      <NativeSelect inputSize="sm" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </NativeSelect>
    </label>
  );
}

function Paged<T>({ title, basis, rows, columns }: { title: string; basis: string; rows: T[]; columns: React.ComponentProps<typeof Table<T>>["columns"] }) {
  const [page, setPage] = useState(1);
  const slice = pageSlice(rows, page, PAGE_SIZE);
  return (
    <section>
      <h3 className="text-sm font-semibold text-text">{title}</h3>
      <p className="mb-2 text-xs text-text-2">{basis}</p>
      <Table<T> label={`KRX ${title}`} rows={slice.rows} rowKey={(_, index) => `${title}-${slice.page}-${index}`} emptyMessage="자료가 없습니다." columns={columns} />
      <Pager page={slice.page} pages={slice.pages} onChange={setPage} label={`KRX ${title}`} />
    </section>
  );
}
