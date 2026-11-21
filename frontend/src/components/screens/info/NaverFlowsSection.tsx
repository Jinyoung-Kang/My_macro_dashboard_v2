"use client";

import { useState } from "react";
import { Pager } from "@/components/Pager";
import { ChangeCell, DataTable, StaleBadge } from "@/components/patterns";
import { Callout, Card, ErrorState, FIELD_LABEL, Freshness, LINK_CLASSES, Loading, NativeSelect, SourceBadge } from "@/components/ui";
import { FOCUS_RING, TEXT_TARGET_SHORT } from "@/components/ui/classes";
import { useApi } from "@/hooks/useApi";
import { bypassBadge } from "@/lib/econCalendar";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, formatNumber, formatSignedMinus } from "@/lib/format";
import {
  NAVER_INVESTORS,
  NAVER_MARKETS,
  type NaverFlowsResponse,
  type NaverInvestor,
  type NaverMarket,
  PAGE_SIZE,
  type RankRow,
  TREND_COLUMNS,
  type TrendRow,
  eokText,
  pageSlice,
  rankingBasis,
  sharesText,
} from "@/lib/info";

/**
 * 짧은 출처 링크 — 짧은 글 단추 누름 자리(ui/classes TEXT_TARGET_SHORT — 좁은 화면 높이·폭 44px, 글 가운데, 넓은 화면은 글 크기)에 공용 링크와 같은
 * 색·밑줄·포커스 링(LINK_CLASSES의 TEXT_TARGET 뒤 조각). 예전에는 LINK_CLASSES + 같은 폭 조각을 손으로 붙였습니다(클래스 묶음은 같음 — P7 검토).
 */
const SHORT_LINK = `${TEXT_TARGET_SHORT} rounded-sm text-accent underline-offset-2 hover:text-accent-hover hover:underline ${FOCUS_RING}`;

/**
 * 네이버 투자자별 매매동향(코스피·코스닥 최근 10거래일, 억 원)과 외국인·기관 순매수·순매도 상위(당일). 장중 순위는 네이버의 추정이라 금액이 없고
 * 주식 수만 보입니다('—'는 0이 아니라 출처가 주지 않은 값). 시장·투자주체를 골라 한 쌍씩 보이고 순위는 10줄씩 넘깁니다.
 * 표는 공용 조밀 표(DataTable dense)이고, 순매수 금액·수량은 부호 있는 값이라 본문 잉크 + 부호(−는 U+2212 — 오르내림이 아님), 등락률만 오르내림 칩(▲▼).
 */
export function NaverFlowsSection() {
  const { data, loading, error, reload, refreshError } = useApi<NaverFlowsResponse>(endpoints.info.flows, 300_000);
  const [market, setMarket] = useState<NaverMarket>("KOSPI");
  const [investor, setInvestor] = useState<NaverInvestor>("FOREIGNER");
  const marketLabel = NAVER_MARKETS.find((entry) => entry.key === market)?.label ?? market;
  const investorLabel = NAVER_INVESTORS.find((entry) => entry.key === investor)?.label ?? investor;
  const badge = bypassBadge(data?.fetchTier);
  return (
    <Card
      title="네이버 투자자별 매매동향·매매상위"
      source={
        // 출처 글과 링크 셋을 '출처 ·' 뒤 한 글 흐름으로(QA-836 — 예전에는 블록 flex 상자라 '출처 ·'만 윗줄에 남았음). 링크는 공용 링크 모양(좁은 화면 44px),
        // 두세 글자 링크('외국인'·'기관')는 좁은 화면 폭도 44px(SHORT_LINK — 짧은 글 단추 규칙, ui/classes TEXT_TARGET_SHORT).
        <>
          {data?.source ?? "네이버 증권"} (비공식) ·{" "}
          <a href={data?.sourceUrls?.trader ?? "https://stock.naver.com/market/stock/kr/trend/trader"} target="_blank" rel="noopener noreferrer" className={LINK_CLASSES}>
            매매동향
          </a>
          {" · "}
          <a href={data?.sourceUrls?.foreigner ?? "https://stock.naver.com/market/stock/kr/trend/foreigner"} target="_blank" rel="noopener noreferrer" className={SHORT_LINK}>
            외국인
          </a>
          {" · "}
          <a href={data?.sourceUrls?.organization ?? "https://stock.naver.com/market/stock/kr/trend/organization"} target="_blank" rel="noopener noreferrer" className={SHORT_LINK}>
            기관
          </a>
        </>
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
            <Callout tone="warn" title="일부를 받지 못함">
              이번 수집에서 {data.failed?.length}개 부분을 받지 못해 이전 값을 보입니다: {data.failed?.join(", ")}
            </Callout>
          )}
          {/* 고르기 둘 — 공용 기본 조작 크기(md — 넓은 화면 30px, 좁은 화면 44px), 이름표 13px 보조 글. 좁은 화면은 한 칸씩. */}
          <div className="grid gap-2 sm:flex sm:flex-wrap sm:items-end">
            <label className={FIELD_LABEL}>
              시장
              <NativeSelect value={market} onChange={(event) => setMarket(event.target.value as NaverMarket)}>
                {NAVER_MARKETS.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className={FIELD_LABEL}>
              매매상위 투자주체
              <NativeSelect value={investor} onChange={(event) => setInvestor(event.target.value as NaverInvestor)}>
                {NAVER_INVESTORS.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label}
                  </option>
                ))}
              </NativeSelect>
            </label>
          </div>
          <section>
            <h3 className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-text">
              {marketLabel} 투자자별 순매수(억 원)
              <StaleBadge stale={data.trend?.[market]?.isStale} reason="이번에 받지 못함" />
            </h3>
            <DataTable<TrendRow>
              dense
              caption={`${marketLabel} 투자자별 순매수`}
              rows={data.trend?.[market]?.rows ?? []}
              rowKey={(row) => row.date}
              emptyText="받은 날짜가 없습니다."
              scrollHint="overflow"
              columns={[
                { key: "date", header: "날짜", className: "whitespace-nowrap", cell: (row) => row.date },
                ...TREND_COLUMNS.map((column) => ({
                  key: column.key,
                  header: column.label,
                  align: "right" as const,
                  cell: (row: TrendRow) => {
                    const value = row[column.key];
                    return value === null ? null : formatSignedMinus(value, 1).text;
                  },
                })),
              ]}
            />
          </section>
          <section>
            <h3 className="text-sm font-semibold text-text">
              {investorLabel} 매매상위 · {marketLabel}
            </h3>
            <p className="mb-2 text-xs text-text-2">{rankingBasis(data.rankings?.[investor]?.[market])}</p>
            {/* 순매수·순매도 두 표는 위아래로 — 나란히 두면 1440에서도 칸이 553px라 여섯 칸 표(최소 640px)가 넘쳤음(머리 없는 크롬으로 잼). */}
            <div className="grid gap-4">
              <RankTable key={`${investor}-${market}-buy`} title={`${investorLabel} 순매수 상위 · ${marketLabel}`} rows={data.rankings?.[investor]?.[market]?.buy ?? []} />
              <RankTable key={`${investor}-${market}-sell`} title={`${investorLabel} 순매도 상위 · ${marketLabel}`} rows={data.rankings?.[investor]?.[market]?.sell ?? []} />
            </div>
          </section>
        </div>
      )}
    </Card>
  );
}

function RankTable({ title, rows }: { title: string; rows: RankRow[] }) {
  const [page, setPage] = useState(1);
  const slice = pageSlice(rows, page, PAGE_SIZE);
  return (
    <div className="min-w-0">
      <h4 className="mb-1 text-xs font-semibold text-text-2">{title.split(" · ")[0].replace(/^(외국인|기관) /, "")}</h4>
      <DataTable<RankRow>
        dense
        caption={title}
        rows={slice.rows}
        rowKey={(row) => `${row.code ?? "?"}-${row.rank}`}
        emptyText="순위가 없습니다."
        scrollHint="overflow"
        columns={[
          { key: "rank", header: "순위", align: "right", cell: (row) => row.rank },
          { key: "name", header: "종목", className: "min-w-[6rem] break-keep", cell: (row) => row.name ?? EMPTY },
          { key: "price", header: "현재가", align: "right", cell: (row) => (row.price === null ? null : formatNumber(row.price, 0)) },
          { key: "change", header: "등락률", align: "right", cell: (row) => <ChangeCell changePct={row.changePct} /> },
          { key: "amount", header: "순매수 금액", align: "right", cell: (row) => eokText(row.netAmountEok) },
          { key: "volume", header: "순매수 수량", align: "right", cell: (row) => sharesText(row.netVolume) },
        ]}
      />
      <Pager page={slice.page} pages={slice.pages} onChange={setPage} label={title} />
    </div>
  );
}
