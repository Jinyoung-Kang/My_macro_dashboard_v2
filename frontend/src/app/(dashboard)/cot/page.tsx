"use client";

import { useId, useState } from "react";
import { MultiLineSeries, SERIES_COLORS } from "@/components/charts";
import { ChangeCell, type Column, DataTable, KpiStrip } from "@/components/patterns";
import {
  Callout,
  ErrorState,
  Freshness,
  Loading,
  PageHeader,
  Panel,
  Select,
  ROW_TRIGGER,
  SKELETON_BAR,
  SourceBadge,
} from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { cotKpis, formatSignedCount } from "@/lib/cotScreen";
import { deltaColor, EMPTY, formatNumber, formatPercent, formatWithUnit, withMinusSign } from "@/lib/format";
import type { CotAssetResponse, CotExtremeSummary, CotExtremesResponse, CotSummary } from "@/lib/types";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";


/** 자리표시 막대(공용 ui/classes SKELETON_BAR — 공용 Skeleton 막대와 같은 모양). */
const BAR = `block ${SKELETON_BAR}`;

/** 요약을 읽는 동안 잡아 두는 자산 줄 수 — 수집기 COT 자산(collector/app/indicators.py COT_ASSETS) 여섯. 자리일 뿐 보이는 수가 아닙니다. */
const COT_PENDING_ROWS = 6;

/**
 * 자산별 요약을 읽는 동안의 표 꼴 자리(QA-654) — 표 머리 줄(32px)과 자산 줄 자리(공용 표 줄과 같은 여백·구분선, 자산 이름 단추 줄 좁은 화면 44px·넓은 화면
 * 24px + 묶음 줄 16px — 줄 높이 좁은 화면 85px·lg 이상 53px로 값이 온 뒤와 같음). 예전에는 '불러오는 중' 한 줄(패널 189px)이라 값이 오면 표로 자라 화면 안의
 * 추이 패널을 밀었습니다(첫 적재 CLS 1440 0.24 — 기준 0.21). 글·숫자는 없고 막대는 읽기에서 뺍니다(이름 있는 읽는 중 상태 하나).
 */
function SummaryPending() {
  return (
    <div role="status" aria-busy="true" aria-label="자산별 요약을 불러오는 중" className="min-w-0">
      <span className="sr-only">자산별 요약을 불러오는 중</span>
      <div aria-hidden="true" className="min-w-0">
        <div className="flex h-8 items-center justify-between gap-3 border-b border-border px-3">
          <span className={`h-3 w-10 ${BAR}`} />
          <span className={`h-3 w-24 ${BAR}`} />
        </div>
        {Array.from({ length: COT_PENDING_ROWS }, (_, row) => (
          <div
            key={row}
            data-cot-pending-row=""
            className={`flex items-start justify-between gap-3 px-3 ${row < COT_PENDING_ROWS - 1 ? "border-b border-border-subtle py-3 lg:pt-1.5 lg:pb-[5px]" : "py-3 lg:py-1.5"}`}
          >
            <span className="flex flex-col">
              <span className="flex h-11 items-center lg:h-6">
                <span className={`h-3.5 w-28 ${BAR}`} />
              </span>
              <span className="flex h-4 items-center">
                <span className={`h-3 w-12 ${BAR}`} />
              </span>
            </span>
            <span className="flex h-11 items-center gap-6 lg:h-6">
              <span className={`h-3.5 w-16 ${BAR}`} />
              <span className={`hidden h-3.5 w-16 sm:block ${BAR}`} />
              <span className={`hidden h-3.5 w-16 md:block ${BAR}`} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 글로벌 투기세력 (CFTC COT).
 *
 * 주의: CFTC는 화요일 기준 포지션을 금요일에 공시합니다. 항상 며칠 지난
 * 데이터이므로 지연 일수를 함께 표시합니다.
 *
 * 배치(작업대 화면 언어 — 명세 §7 3행 '가벼운 재배치'): 머리 → '자산별 요약' 공용 표(자산 이름 단추 = '자산' 고르기와 같은 상태 — 같은 두 요청,
 * 고른 자산 행은 잉크 막대) → '포지셔닝 추이 — {자산}'(머리 '자산' 고르기 그대로, KPI 띠 넷, 순포지션 선 차트, 계약 코드) → 극단 포지션 이후 성적.
 * 아래 추이 패널이 고른 자산의 검사 자리라 따로 검사 칸을 두지 않습니다(요약 행과 자산 상세는 다른 저장본·다른 요청).
 */
export default function CotPage() {
  const assets = useApi<{ assets: { name: string; code: string; category: string }[] }>(
    endpoints.positioning.cotAssets,
  );
  const overview = useApi<{
    available: boolean;
    collectedAtKst?: string;
    ageSeconds?: number;
    assets: CotSummary[];
  }>(
    endpoints.positioning.cotOverview,
    600_000,
  );
  const [asset, setAsset] = useState("S&P 500 E-Mini");

  const detail = useApi<CotAssetResponse>(
    endpoints.positioning.cotAsset(asset),
  );
  const trendId = useId();
  // 표의 자산 단추로 고른 자산 — 아래 추이 패널이 바뀌었다는 상태 글(낭독기)에만 씁니다. 처음 그릴 때는 알리지 않습니다.
  const [picked, setPicked] = useState<string | null>(null);

  const summaryColumns: Column<CotSummary>[] = [
    {
      key: "asset",
      header: "자산",
      rowHeader: true,
      // 자산 이름은 그 자산을 고르는 단추(공용 줄 단추 모양 ROW_TRIGGER — 중립 잉크, 좁은 화면 높이·폭 44px) — 머리 '자산' 고르기와 같은 상태라 같은 두
      // 요청(추이·극단 성적)이 나갑니다. 고른 자산은 아래 추이 패널이 보이고, 그 단추 자신이 aria-current입니다(포커스 때 읽힘 — 행에도 있음).
      // 누르면 아래 패널이 바뀐 것을 상태 글로 알립니다(좁은 화면은 패널이 화면 밖).
      cell: (row) => (
        <span className="flex min-w-0 flex-col items-start">
          <button
            type="button"
            className={ROW_TRIGGER}
            aria-controls={trendId}
            aria-current={row.asset === asset ? "true" : undefined}
            onClick={() => {
              setAsset(row.asset);
              setPicked(row.asset);
            }}
          >
            {row.asset}
          </button>
          <span className="break-keep text-xs text-text-3">{row.category}</span>
        </span>
      ),
    },
    {
      key: "date",
      header: "기준일",
      className: "break-keep",
      // 날짜와 'n일 전 공시'는 각자 한 줄 — 칸이 눌리면 '2026-10-' / '27'처럼 하이픈 뒤에서 꺾였습니다(1024·390 브라우저 확인). 실패 사유 글만 낱말 사이에서 꺾습니다.
      cell: (row) =>
        row.available ? (
          <span className="flex flex-col whitespace-nowrap">
            <span>{row.date}</span>
            <span className="text-xs text-text-3">{formatWithUnit(row.ageDays, 0, "일 전 공시")}</span>
          </span>
        ) : (
          <span className="text-text-3">{row.error ?? "데이터 없음"}</span>
        ),
    },
    {
      key: "ncNet",
      header: "스마트머니 순포지션",
      align: "right",
      // 순포지션의 색(롱 빨강·숏 파랑)은 뜻이라 그대로 두고, 부호(+·−)가 함께 방향을 나릅니다(QA-629).
      cell: (row) => <span className={deltaColor(row.ncNet ?? null, 0)}>{formatSignedCount(row.ncNet)}</span>,
    },
    { key: "commNet", header: "상업 헤저", align: "right", cell: (row) => formatSignedCount(row.commNet) },
    { key: "change1w", header: "1주 변화", align: "right", cell: (row) => <ChangeCell change={row.change1w} digits={0} /> },
    { key: "change4w", header: "4주 변화", align: "right", cell: (row) => <ChangeCell change={row.change4w} digits={0} /> },
    {
      key: "percentile",
      header: "3년 백분위",
      align: "right",
      cell: (row) =>
        row.percentile === null || row.percentile === undefined ? null : `${formatNumber(row.percentile, 1)}%`,
    },
  ];

  const kpis = cotKpis(detail.data?.available ? detail.data.summary : null, SOURCES.cftc);

  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
      <PageHeader
        title="글로벌 투기세력 (COT)"
        description="CFTC 공개 데이터 · 비상업(투기) / 상업(헤저) / 비보고(소액) 순포지션"
        actions={
          <Freshness
            collectedAt={overview.data?.collectedAtKst}
            ageSeconds={overview.data?.ageSeconds}
            refreshError={overview.refreshError}
          />
        }
      />

      {overview.data && !overview.data.available && (
        <Callout tone="warn">COT 저장본이 없습니다. 수집기의 slow 작업을 실행하세요.</Callout>
      )}

      <Panel
        title="자산별 요약" source={SOURCES.cftc}
        count={overview.data ? `${(overview.data.assets ?? []).length.toLocaleString("ko-KR")}개` : undefined}
        subtitle="스마트머니(비상업) 순포지션과 최근 변화 · 자산 이름을 누르면 아래 추이와 극단 성적이 그 자산으로 바뀝니다."
      >
        {/* 읽는 동안은 표 꼴 자리(줄 여섯 — 값이 온 뒤 아래 추이 패널이 밀리지 않게, QA-654). */}
        {overview.loading && !overview.data && <SummaryPending />}
        {overview.error && <ErrorState message={overview.error} onRetry={overview.reload} />}
        {overview.data && (
          <DataTable
            caption="자산별 요약"
            columns={summaryColumns}
            rows={overview.data.assets ?? []}
            rowKey={(row) => row.asset}
            selectedKey={asset}
            emptyText="표시할 자산이 없습니다."
            scrollHint="overflow"
          />
        )}
      </Panel>

      {/* 표의 자산 단추를 누르면 아래 패널이 그 자산으로 바뀐 것을 알립니다(좁은 화면은 패널이 화면 밖 — 단추를 눌러도 들리는 변화가 없었음). */}
      <p role="status" className="sr-only">
        {picked ? `아래 포지셔닝 추이 패널을 ${picked} 자산으로 바꿨습니다.` : ""}
      </p>
      <div id={trendId} className="min-w-0">
        <Panel
          title={`포지셔닝 추이 — ${asset}`} source={SOURCES.cftc}
          actions={
            <Select
              label="자산"
              value={asset}
              onChange={setAsset}
              options={(assets.data?.assets ?? []).map((entry) => ({
                value: entry.name,
                label: entry.name,
              }))}
            />
          }
        >
          {detail.loading && !detail.data && <Loading />}
          {detail.error && <ErrorState message={detail.error} onRetry={detail.reload} />}
          {detail.data && !detail.data.available && (
            // 위 요약표에는 값이 있는데 여기만 비는 경우가 있습니다(요약은 묶음
            // 저장본, 추이는 계약별 저장본에서 옵니다). 그때 "저장본이 없습니다"만
            // 띄우면 화면이 고장난 것처럼 보이므로, 무엇이 없는지 구분해 말합니다.
            <Callout tone="warn">
              {overview.data?.available
                ? `이 자산의 주간 추이 저장본만 아직 없습니다 (위 요약은 다른 저장본에서 온 값입니다).
                   데이터 저장소 상태에서 cot_history를 다시 실행해 보세요.`
                : (detail.data.message ?? "해당 자산의 데이터가 없습니다.")}
            </Callout>
          )}
          {detail.data?.available && (
            <>
              {/* KPI 띠 넷 — 넓은 화면 한 줄(띠 폭이 모자라면 네 칸), 좁은 화면 두 칸. 순포지션은 부호 −, 백분위는 '%'(lib/cotScreen cotKpis). */}
              {kpis.length > 0 && (
                <div className="mb-4">
                  <KpiStrip label={`${asset} 포지셔닝 요약`} items={kpis} />
                </div>
              )}

              <MultiLineSeries
                data={detail.data.rows.map((row) => ({
                  date: row.date,
                  스마트머니: row.ncNet,
                  상업헤저: row.commNet,
                  소액: row.nrNet,
                }))}
                series={[
                  { key: "스마트머니", name: "비상업 (투기)", color: SERIES_COLORS.blue },
                  { key: "상업헤저", name: "상업 (헤저)", color: SERIES_COLORS.orange },
                  { key: "소액", name: "비보고 (소액)", color: "#8B949E" },
                ]}
                // 순포지션은 부호가 곧 방향(롱/숏)입니다. 0선을 그려 언제 뒤집혔는지
                // 눈으로 좇을 수 있게 합니다.
                zeroLine
                unit=" 계약"
                precision={0}
                height={320}
                grid
                ariaLabel={`${asset} 순포지션 추이`}
              />
              <p className="mt-3 text-xs text-text-3">
                <SourceBadge>계약 코드 {detail.data.code}</SourceBadge> 비상업과 상업은 구조적으로
                반대 방향입니다. 비상업이 역사적 극단에 도달하면 되돌림 위험이 커집니다.
              </p>
            </>
          )}
        </Panel>
      </div>

      <ExtremesPanel asset={asset} />
    </div>
  );
}

/** 극단 성적 표 한 줄 — 기간(4주·13주 뒤)마다 신호 뒤 성적과 아무 때나 들어갔을 때의 성적. */
type HorizonRow = { horizon: string; signal: CotExtremeSummary; base: CotExtremeSummary };

const HORIZON_COLUMNS: readonly Column<HorizonRow>[] = [
  { key: "horizon", header: "기간", className: "break-keep", cell: (row) => row.horizon },
  { key: "count", header: "표본", align: "right", cell: (row) => `${row.signal.count}건` },
  { key: "mean", header: "평균 수익률", align: "right", cell: (row) => <ChangeCell changePct={row.signal.mean} /> },
  { key: "median", header: "중앙값", align: "right", cell: (row) => withMinusSign(formatPercent(row.signal.median)) },
  {
    key: "winRate",
    header: "상승 비율",
    align: "right",
    cell: (row) => (row.signal.winRate === null ? null : `${formatNumber(row.signal.winRate, 0)}%`),
  },
  {
    key: "baseline",
    header: "비교: 아무 때나",
    align: "right",
    cell: (row) => (
      <span className="text-text-3">
        {withMinusSign(formatPercent(row.base.mean))} ·{" "}
        {row.base.winRate === null ? EMPTY : `${formatNumber(row.base.winRate, 0)}% 상승`}
      </span>
    ),
  },
];

type RecentEvent = NonNullable<CotExtremesResponse["recentEvents"]>[number];

const RECENT_COLUMNS: readonly Column<RecentEvent>[] = [
  { key: "date", header: "기준일", cell: (row) => row.date },
  { key: "side", header: "구분", className: "break-keep", cell: (row) => row.side },
  { key: "percentile", header: "백분위", align: "right", cell: (row) => formatWithUnit(row.percentile, 1, "%") },
  { key: "net", header: "순포지션", align: "right", cell: (row) => formatSignedCount(row.net) },
  { key: "return4w", header: "이후 4주", align: "right", cell: (row) => <ChangeCell changePct={row.return4w} /> },
  { key: "return13w", header: "이후 13주", align: "right", cell: (row) => <ChangeCell changePct={row.return13w} /> },
];

/**
 * 극단 포지션 이후 무슨 일이 있었나.
 *
 * <p>"3년 백분위 96%"는 지금이 역사적 극단이라고 알려 주지만, <b>그래서 어땠는지</b>는
 * 말해 주지 않았습니다. 과거 같은 극단 이후의 4주·13주 수익률을, <b>아무 때나
 * 들어갔을 때</b>와 나란히 놓습니다. 비교 대상이 없으면 좋은 숫자인지 알 수 없습니다.
 *
 * <p>주의: COT에는 가격이 없어 ETF 종가를 대용으로 씁니다. 화면이 그 사실을 감추면
 * 선물 수익률로 오해합니다.
 */
function ExtremesPanel({ asset }: { asset: string }) {
  const [percentile, setPercentile] = useState("95");
  const [lookback, setLookback] = useState("52");

  const { data, loading, error, reload } = useApi<CotExtremesResponse>(
    endpoints.positioning.cotExtremes(asset, percentile, lookback),
  );

  return (
    <Panel
      title="극단 포지션 이후 성적 (백테스트)" source={SOURCES.cftcBacktest}
      subtitle={
        data?.available
          ? `백분위는 그 시점까지의 최근 ${data.lookbackWeeks}주로만 계산합니다 (미래를 보지 않습니다).`
          : "과거에 같은 극단이 나왔을 때 이후 수익률이 어땠는지 셉니다."
      }
      actions={
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label="극단 기준"
            value={percentile}
            onChange={setPercentile}
            options={["90", "95", "98"].map((value) => ({
              value,
              label: `상·하위 ${100 - Number(value)}%`,
            }))}
          />
          <Select
            label="백분위 구간"
            value={lookback}
            onChange={setLookback}
            options={["26", "52", "104"].map((value) => ({ value, label: `${value}주` }))}
          />
        </div>
      }
    >
      {loading && !data && <Loading />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && <Callout tone="warn">{data.message}</Callout>}

      {data?.available && (
        <>
          <Callout tone="neutral">
            가격은 <strong>{data.priceProxyLabel ?? data.priceProxy}</strong> 종가를 대용으로
            씁니다 ({data.priceFrom} ~ {data.priceTo}). {data.proxyNotice}
          </Callout>

          <div className="mt-4 flex flex-col gap-4">
            {(data.sides ?? []).map((side) => (
              <div key={side.side} className="rounded-control border border-border bg-surface p-3 lg:p-4">
                <h3 className="text-sm font-semibold text-text">{side.side}</h3>
                <p className="mt-0.5 break-keep text-xs text-text-3">{side.rule}</p>
                <div className="mt-3">
                  <DataTable
                    caption={`${side.side} 이후 성적`}
                    columns={HORIZON_COLUMNS}
                    rows={[
                      { horizon: "4주 뒤", signal: side.h4, base: side.baseline4 },
                      { horizon: "13주 뒤", signal: side.h13, base: side.baseline13 },
                    ]}
                    rowKey={(row) => `${side.side}-${row.horizon}`}
                    scrollHint="overflow"
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-5">
            <h3 className="mb-2 text-sm font-semibold text-text">최근 극단 신호</h3>
            <DataTable
              caption="최근 극단 신호"
              columns={RECENT_COLUMNS}
              rows={data.recentEvents ?? []}
              rowKey={(row) => `${row.date}-${row.side}`}
              emptyText="이 조건에 걸린 시점이 없습니다."
              scrollHint="overflow"
              dense
            />
            <p className="mt-2 text-xs text-text-3">
              아직 4·13주가 지나지 않은 최근 신호는 수익률을 {EMPTY}로 둡니다 — 없는 미래를
              0으로 채우지 않습니다.
            </p>
          </div>
        </>
      )}
    </Panel>
  );
}

