"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Pager } from "@/components/Pager";
import { ChangeCell, type Column, DataTable, StaleBadge } from "@/components/patterns";
import { Card, ErrorState, Freshness, LINK_CLASSES, Loading, NativeSelect, Tag } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, formatNumber } from "@/lib/format";
import {
  type KrxForeign,
  type KrxPart,
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
  sharesText,
} from "@/lib/info";

const INVESTORS = ["외국인", "기관", "개인", "연기금", "금융투자", "투신"];

/** 억 원(부호 없는 금액 — 매수·매도·잔고·거래대금). 모르면 null(표가 '—'). */
const eok = (value: number | null) => (value === null ? null : `${formatNumber(value, 1)}억`);
/** 비율(%). 모르면 null. */
const pct = (value: number | null) => (value === null ? null : `${formatNumber(value, 2)}%`);

/**
 * KRX 정보데이터시스템(로그인, ADR 0036) — 거래일 저녁(18:30 뒤) 서버가 한 번 받는 공식 확정 자료: 투자자별 순매수 상위(수급 레이더의 확정
 * 순위와 같은 저장본), 투자자별 거래실적(시장 합계), 외국인 보유 비중 상위, 공매도 거래·잔고 상위(잔고는 2~3거래일 늦게 공개). 표는 10줄씩.
 * 표는 공용 조밀 표(DataTable dense — 넓은 화면 28px 행)이고, 순매수 금액·수량은 부호 있는 값이라 본문 잉크 + 부호(−는 U+2212 — 오르내림이 아님),
 * 등락률만 오르내림 칩(▲▼·색 + 부호). 이번에 받지 못해 이어받은 부분은 공용 '이전 값' 배지.
 */
export function KrxSection({ onSettled }: { onSettled?: () => void } = {}) {
  const [market, setMarket] = useState<NaverMarket>("KOSPI");
  const [investor, setInvestor] = useState("외국인");
  const [tradeType, setTradeType] = useState<"순매수" | "순매도">("순매수");
  const { data, loading, error, reload, refreshError } = useApi<KrxResponse>(endpoints.info.krx(market, investor, tradeType), 600_000);
  // 첫 응답(값이든 오류든)이 오면 알립니다 — 정보 수집 국내 탭이 그때까지 아래 패널을 보이지 않게 둡니다(QA-893).
  const settled = !!data || !!error;
  useEffect(() => {
    if (settled) onSettled?.();
  }, [settled, onSettled]);
  const marketName = market === "KOSPI" ? "코스피" : "코스닥";
  return (
    <Card
      title="KRX 정보데이터시스템"
      source={
        <a href="https://data.krx.co.kr/" target="_blank" rel="noopener noreferrer" className={LINK_CLASSES}>
          한국거래소 정보데이터시스템(계정 로그인) · 확정치
        </a>
      }
      subtitle="거래일 18:30 뒤 운영 서버가 그날 확정 자료를 한 번 받습니다. 수급 레이더의 과거 날짜·여섯 투자주체 확정 순위도 이 자료입니다."
      actions={
        <span className="flex flex-wrap items-center gap-2">
          {data?.asOf && <Tag>기준일 {data.asOf}</Tag>}
          <Freshness collectedAt={data?.collectedAtKst} ageSeconds={data?.ageSeconds} refreshError={refreshError} />
        </span>
      }
    >
      <div className="mb-4 grid gap-2 sm:flex sm:flex-wrap sm:items-end">
        <Choice label="시장" value={market} onChange={(v) => setMarket(v as NaverMarket)} options={NAVER_MARKETS.map((m) => [m.key, m.label])} />
        <Choice label="투자주체" value={investor} onChange={setInvestor} options={INVESTORS.map((v) => [v, v])} />
        <Choice label="방향" value={tradeType} onChange={(v) => setTradeType(v as "순매수" | "순매도")} options={[["순매수", "순매수"], ["순매도", "순매도"]]} />
      </div>
      {loading && !data && <Loading />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && (
        <div className="space-y-6">
          <Paged<KrxRank>
            title={`${investor} ${tradeType} 상위 · ${marketName}`}
            basis={data.ranking.date ? `기준일 ${data.ranking.date}` : "받은 순위 없음 — 운영 서버의 첫 수집 뒤 보입니다"}
            rows={data.ranking.rows}
            columns={[
              { key: "rank", header: "순위", align: "right", cell: (r) => r.rank },
              { key: "name", header: "종목", className: "min-w-[8rem] break-keep", cell: (r) => `${r.name} (${r.code})` },
              { key: "net", header: "순매수 금액", align: "right", cell: (r) => eokText(r.netAmountEok) },
              { key: "vol", header: "순매수 수량", align: "right", cell: (r) => sharesText(r.netVolume) },
              { key: "buy", header: "매수", align: "right", cell: (r) => eok(r.buyEok) },
              { key: "sell", header: "매도", align: "right", cell: (r) => eok(r.sellEok) },
            ]}
          />
          {data.available ? (
            <>
              <Paged<KrxTotal>
                title={`투자자별 거래실적(시장 합계) · ${marketName}`}
                part={data.totals?.[market]}
                rows={data.totals?.[market]?.rows ?? []}
                columns={[
                  { key: "inv", header: "투자자", className: "break-keep", cell: (r) => r.investor },
                  { key: "net", header: "순매수", align: "right", cell: (r) => eokText(r.netEok) },
                  { key: "buy", header: "매수", align: "right", cell: (r) => eok(r.buyEok) },
                  { key: "sell", header: "매도", align: "right", cell: (r) => eok(r.sellEok) },
                ]}
              />
              <Paged<KrxForeign>
                title={`외국인 보유 비중 상위 · ${marketName}`}
                part={data.foreign?.[market]}
                rows={data.foreign?.[market]?.rows ?? []}
                columns={[
                  { key: "name", header: "종목", className: "min-w-[8rem] break-keep", cell: (r) => `${r.name ?? EMPTY} (${r.code})` },
                  { key: "pct", header: "보유 비중", align: "right", cell: (r) => pct(r.holdPct) },
                  { key: "lmt", header: "한도소진율", align: "right", cell: (r) => pct(r.limitExhaustPct) },
                  { key: "close", header: "종가", align: "right", cell: (r) => (r.close === null ? null : formatNumber(r.close, 0)) },
                  { key: "chg", header: "등락률", align: "right", cell: (r) => <ChangeCell changePct={r.changePct} /> },
                ]}
              />
              <Paged<KrxShortTrade>
                title={`공매도 거래대금 상위 · ${marketName}`}
                part={data.shortTrades?.[market]}
                rows={data.shortTrades?.[market]?.rows ?? []}
                columns={[
                  { key: "name", header: "종목", className: "min-w-[8rem] break-keep", cell: (r) => `${r.name ?? EMPTY} (${r.code})` },
                  { key: "amt", header: "공매도 거래대금", align: "right", cell: (r) => eok(r.shortEok) },
                  { key: "wt", header: "거래대금 비중", align: "right", cell: (r) => pct(r.tradeValueWeightPct) },
                ]}
              />
              <Paged<KrxShortBalance>
                title={`공매도 잔고 상위 · ${marketName}`}
                part={data.shortBalances?.[market]}
                note="잔고는 2~3거래일 늦게 공개"
                rows={data.shortBalances?.[market]?.rows ?? []}
                columns={[
                  { key: "name", header: "종목", className: "min-w-[8rem] break-keep", cell: (r) => `${r.name ?? EMPTY} (${r.code})` },
                  { key: "amt", header: "잔고 금액", align: "right", cell: (r) => eok(r.balanceEok) },
                  { key: "pct", header: "잔고 비율", align: "right", cell: (r) => pct(r.balancePct) },
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

/** 고르기 하나 — 공용 기본 조작 크기(md — 넓은 화면 30px, 좁은 화면 44px), 이름표 13px 보조 글(공용 Select와 같음). 좁은 화면은 한 칸 전체. */
function Choice({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[][] }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[13px] text-text-2">
      {label}
      <NativeSelect value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </NativeSelect>
    </label>
  );
}

/** 절 하나 — 제목(h3)·기준 줄(기준일 + 이어받았으면 '이전 값' 배지)·조밀 표(개수)·쪽 넘기기(10줄), 행이 없으면 표 대신 빈 상태 한 줄(QA-877). */
function Paged<T>({
  title,
  basis,
  part,
  note,
  rows,
  columns,
}: {
  title: string;
  /** 기준 글(순위 — 기준일 또는 받지 못한 사유). 주지 않으면 `part`의 기준일. */
  basis?: string;
  part?: KrxPart<unknown> | null;
  /** 기준 줄 끝 덧붙임(괄호). */
  note?: string;
  rows: T[];
  columns: Column<T>[];
}) {
  const [page, setPage] = useState(1);
  const slice = pageSlice(rows, page, PAGE_SIZE);
  let line: ReactNode = basis;
  if (basis === undefined) line = part ? `기준일 ${part.asOf}` : "받은 자료 없음";
  return (
    <section>
      <h3 className="text-sm font-semibold text-text">{title}</h3>
      <p className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-2">
        <span>
          {line}
          {note ? ` (${note})` : ""}
        </span>
        <StaleBadge stale={part?.isStale} reason="이번에 받지 못함" />
      </p>
      {/* 행이 없으면 표 대신 빈 상태 한 줄 — 공용 표는 행이 있을 때만 최소 폭·넘김 안내를 두어, 빈 표의 머리 칸이 390에서 상자를 안내 없이 넘쳤습니다(QA-877). */}
      {rows.length === 0 ? (
        <p className="py-2 text-sm text-text-3">자료가 없습니다.</p>
      ) : (
        <>
          <DataTable<T>
            dense
            caption={`KRX ${title}`}
            rows={slice.rows}
            rowKey={(row) => `${title}-${slice.page}-${slice.rows.indexOf(row)}`}
            emptyText="자료가 없습니다."
            columns={columns}
            count={() => `${rows.length.toLocaleString("ko-KR")}건`}
            scrollHint="overflow"
          />
          <Pager page={slice.page} pages={slice.pages} onChange={setPage} label={`KRX ${title}`} />
        </>
      )}
    </section>
  );
}
