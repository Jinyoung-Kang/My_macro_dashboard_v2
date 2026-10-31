"use client";

import { useState } from "react";
import { MultiLineSeries, SERIES_COLORS } from "@/components/charts";
import {
  Banner,
  Card,
  ErrorState,
  Freshness,
  Loading,
  Metric,
  PageHeader,
  Select,
  SourceBadge,
  Table,
} from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { deltaColor, EMPTY, formatNumber, formatPercent, formatSigned, formatWithUnit } from "@/lib/format";
import type { CotAssetResponse, CotExtremesResponse, CotSummary } from "@/lib/types";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";

/**
 * 🏛️ 글로벌 투기세력 (CFTC COT).
 *
 * ⚠️ CFTC는 화요일 기준 포지션을 금요일에 공시합니다. 항상 며칠 지난
 * 데이터이므로 지연 일수를 함께 표시합니다.
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

  return (
    <div className="flex flex-col gap-6 lg:gap-8">
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
        <Banner tone="warn">COT 저장본이 없습니다. 수집기의 slow 작업을 실행하세요.</Banner>
      )}

      <Card title="자산별 요약" source={SOURCES.cftc} subtitle="스마트머니(비상업) 순포지션과 최근 변화">
        {overview.loading && !overview.data && <Loading />}
        {overview.error && <ErrorState message={overview.error} onRetry={overview.reload} />}
        {overview.data && (
          <Table
            rows={overview.data.assets ?? []}
            rowKey={(row) => row.asset}
            columns={[
              {
                key: "asset",
                header: "자산",
                render: (row) => (
                  <span className="flex flex-col">
                    <span className="text-body">{row.asset}</span>
                    <span className="text-xs text-muted">{row.category}</span>
                  </span>
                ),
              },
              {
                key: "date",
                header: "기준일",
                render: (row) =>
                  row.available ? (
                    <span className="flex flex-col">
                      <span>{row.date}</span>
                      <span className="text-xs text-muted">{formatWithUnit(row.ageDays, 0, "일 전 공시")}</span>
                    </span>
                  ) : (
                    <span className="text-muted">{row.error ?? "데이터 없음"}</span>
                  ),
              },
              {
                key: "ncNet",
                header: "스마트머니 순포지션",
                align: "right",
                render: (row) => (
                  <span className={deltaColor(row.ncNet ?? null, 0)}>
                    {row.ncNet === null || row.ncNet === undefined
                      ? EMPTY
                      : formatSigned(row.ncNet, 0)}
                  </span>
                ),
              },
              {
                key: "commNet",
                header: "상업 헤저",
                align: "right",
                render: (row) =>
                  row.commNet === null || row.commNet === undefined
                    ? EMPTY
                    : formatSigned(row.commNet, 0),
              },
              {
                key: "change1w",
                header: "1주 변화",
                align: "right",
                render: (row) => (
                  <span className={deltaColor(row.change1w ?? null, 0)}>
                    {row.change1w === null || row.change1w === undefined
                      ? EMPTY
                      : formatSigned(row.change1w, 0)}
                  </span>
                ),
              },
              {
                key: "change4w",
                header: "4주 변화",
                align: "right",
                render: (row) => (
                  <span className={deltaColor(row.change4w ?? null, 0)}>
                    {row.change4w === null || row.change4w === undefined
                      ? EMPTY
                      : formatSigned(row.change4w, 0)}
                  </span>
                ),
              },
              {
                key: "percentile",
                header: "3년 백분위",
                align: "right",
                render: (row) =>
                  row.percentile === null || row.percentile === undefined
                    ? EMPTY
                    : `${formatNumber(row.percentile, 1)}%`,
              },
            ]}
          />
        )}
      </Card>

      <Card
        title="포지셔닝 추이" source={SOURCES.cftc}
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
          <Banner tone="warn">
            {overview.data?.available
              ? `이 자산의 주간 추이 저장본만 아직 없습니다 (위 요약은 다른 저장본에서 온 값입니다).
                 데이터 저장소 상태에서 cot_history를 다시 실행해 보세요.`
              : (detail.data.message ?? "해당 자산의 데이터가 없습니다.")}
          </Banner>
        )}
        {detail.data?.available && (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-4">
              <Metric
                label="스마트머니 순포지션"
                value={formatSigned(detail.data.summary?.ncNet ?? null, 0)}
                delta={detail.data.summary?.change1w ?? null}
                deltaText={`1주 ${formatSigned(detail.data.summary?.change1w ?? null, 0)}`}
                deltaDigits={0}
                caption={`기준일 ${detail.data.summary?.date ?? EMPTY}`}
              />
              <Metric
                label="상업 헤저 순포지션"
                value={formatSigned(detail.data.summary?.commNet ?? null, 0)}
              />
              <Metric
                label="소액/비보고"
                value={formatSigned(detail.data.summary?.nrNet ?? null, 0)}
              />
              <Metric
                label="3년 표본 백분위"
                value={
                  detail.data.summary?.percentile === null ||
                  detail.data.summary?.percentile === undefined
                    ? EMPTY
                    : `${formatNumber(detail.data.summary.percentile, 1)}%`
                }
                caption="100%에 가까울수록 역사적 최대 롱"
              />
            </div>

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
            />
            <p className="mt-3 text-xs text-muted">
              <SourceBadge>계약 코드 {detail.data.code}</SourceBadge> 비상업과 상업은 구조적으로
              반대 방향입니다. 비상업이 역사적 극단에 도달하면 되돌림 위험이 커집니다.
            </p>
          </>
        )}
      </Card>

      <ExtremesPanel asset={asset} />
    </div>
  );
}

/**
 * 📉 극단 포지션 이후 무슨 일이 있었나.
 *
 * <p>"3년 백분위 96%"는 지금이 역사적 극단이라고 알려 주지만, <b>그래서 어땠는지</b>는
 * 말해 주지 않았습니다. 과거 같은 극단 이후의 4주·13주 수익률을, <b>아무 때나
 * 들어갔을 때</b>와 나란히 놓습니다. 비교 대상이 없으면 좋은 숫자인지 알 수 없습니다.
 *
 * <p>⚠️ COT에는 가격이 없어 ETF 종가를 대용으로 씁니다. 화면이 그 사실을 감추면
 * 선물 수익률로 오해합니다.
 */
function ExtremesPanel({ asset }: { asset: string }) {
  const [percentile, setPercentile] = useState("95");
  const [lookback, setLookback] = useState("52");

  const { data, loading, error, reload } = useApi<CotExtremesResponse>(
    endpoints.positioning.cotExtremes(asset, percentile, lookback),
  );

  return (
    <Card
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
      {data && !data.available && <Banner tone="warn">{data.message}</Banner>}

      {data?.available && (
        <>
          <Banner tone="info">
            가격은 <strong>{data.priceProxyLabel ?? data.priceProxy}</strong> 종가를 대용으로
            씁니다 ({data.priceFrom} ~ {data.priceTo}). {data.proxyNotice}
          </Banner>

          <div className="mt-4 flex flex-col gap-4">
            {(data.sides ?? []).map((side) => (
              <div key={side.side} className="rounded-lg border border-border bg-canvas p-3">
                <p className="text-sm font-semibold text-bright">{side.side}</p>
                <p className="mt-0.5 text-xs text-muted">{side.rule}</p>
                <div className="mt-3">
                  <Table
                    rows={[
                      { horizon: "4주 뒤", signal: side.h4, base: side.baseline4 },
                      { horizon: "13주 뒤", signal: side.h13, base: side.baseline13 },
                    ]}
                    rowKey={(row) => `${side.side}-${row.horizon}`}
                    columns={[
                      { key: "horizon", header: "기간", render: (row) => row.horizon },
                      {
                        key: "count",
                        header: "표본",
                        align: "right",
                        render: (row) => `${row.signal.count}건`,
                      },
                      {
                        key: "mean",
                        header: "평균 수익률",
                        align: "right",
                        render: (row) => (
                          <span className={deltaColor(row.signal.mean)}>
                            {formatPercent(row.signal.mean)}
                          </span>
                        ),
                      },
                      {
                        key: "median",
                        header: "중앙값",
                        align: "right",
                        render: (row) => formatPercent(row.signal.median),
                      },
                      {
                        key: "winRate",
                        header: "상승 비율",
                        align: "right",
                        render: (row) =>
                          row.signal.winRate === null
                            ? EMPTY
                            : `${formatNumber(row.signal.winRate, 0)}%`,
                      },
                      {
                        key: "baseline",
                        header: "비교: 아무 때나",
                        align: "right",
                        render: (row) => (
                          <span className="text-muted">
                            {formatPercent(row.base.mean)} ·{" "}
                            {row.base.winRate === null
                              ? EMPTY
                              : `${formatNumber(row.base.winRate, 0)}% 상승`}
                          </span>
                        ),
                      },
                    ]}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-5">
            <h3 className="mb-2 text-sm font-semibold text-bright">최근 극단 신호</h3>
            <Table
              rows={data.recentEvents ?? []}
              rowKey={(row) => `${row.date}-${row.side}`}
              emptyMessage="이 조건에 걸린 시점이 없습니다."
              columns={[
                { key: "date", header: "기준일", render: (row) => row.date },
                { key: "side", header: "구분", render: (row) => row.side },
                {
                  key: "percentile",
                  header: "백분위",
                  align: "right",
                  render: (row) => formatWithUnit(row.percentile, 1, "%"),
                },
                {
                  key: "net",
                  header: "순포지션",
                  align: "right",
                  render: (row) => formatSigned(row.net, 0),
                },
                {
                  key: "return4w",
                  header: "이후 4주",
                  align: "right",
                  render: (row) => (
                    <span className={deltaColor(row.return4w)}>{formatPercent(row.return4w)}</span>
                  ),
                },
                {
                  key: "return13w",
                  header: "이후 13주",
                  align: "right",
                  render: (row) => (
                    <span className={deltaColor(row.return13w)}>{formatPercent(row.return13w)}</span>
                  ),
                },
              ]}
            />
            <p className="mt-2 text-xs text-muted">
              아직 4·13주가 지나지 않은 최근 신호는 수익률을 {EMPTY}로 둡니다 — 없는 미래를
              0으로 채우지 않습니다.
            </p>
          </div>
        </>
      )}
    </Card>
  );
}
