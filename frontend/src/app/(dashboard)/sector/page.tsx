"use client";

import { useState } from "react";
import { HorizontalBars } from "@/components/charts";
import {
  Banner,
  Card,
  ErrorState,
  Freshness,
  Loading,
  PageHeader,
  Select,
  SourceBadge,
  Table,
} from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { deltaColor, EMPTY, formatNumber, formatPercent } from "@/lib/format";
import type { SectorResponse, SectorRow } from "@/lib/types";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";
import { knownBars } from "@/lib/chartData";
import { sortDescUnknownLast } from "@/lib/transforms";

/**
 * 🔄 섹터 & 자산군 로테이션.
 *
 * 표본이 부족한 기간은 "—"로 표시합니다. 0.00%로 채우면 '보합'으로 읽혀
 * 신규 상장 ETF가 실제로 보합인 것처럼 보이고 순위까지 오염됩니다.
 */
export default function SectorPage() {
  const [period, setPeriod] = useState("1M");
  const [mode, setMode] = useState<"return" | "alpha">("return");

  const { data, loading, error, reload, refreshError } = useApi<SectorResponse>(
    endpoints.macro.sectorRotation(period),
    300_000,
  );

  const sectors = data?.sectors ?? [];
  const assets = data?.assetClasses ?? [];

  // 값을 모르는 섹터는 막대에서 뺍니다(0으로 그리지 않음).
  const chartData = knownBars(
    sectors,
    (row) => row.name.split(" ")[0],
    (row) => (mode === "alpha" ? row.alpha?.[period] : row.returns?.[period]),
  ).bars.sort((a, b) => b.value - a.value);

  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      <PageHeader
        title="섹터 & 자산군 로테이션 맵"
        description={<>S&amp;P 11개 섹터 + 글로벌 자산군 모멘텀 · 벤치마크 {data?.benchmark ?? "SPY"}</>}
        actions={
          <Freshness
            collectedAt={data?.collectedAtKst}
            ageSeconds={data?.ageSeconds}
            stale={data?.stale}
            refreshError={refreshError}
          />
        }
      />

      {/* 선택 상자가 있는 첫 카드는 늘 그리고 본문만 로딩·오류로 바꿉니다 — 페이지 전체를 바꾸면 방금 조작한
          선택 상자가 사라지고 키보드 포커스를 잃었습니다(QA-047). */}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && (
        <Banner tone="warn">
          {data.message ?? "섹터 데이터가 없습니다. 수집기를 실행하세요."}
        </Banner>
      )}

      <Card
        title="섹터 모멘텀" source={SOURCES.yahooEtf}
        actions={
          <div className="flex flex-wrap items-end gap-3">
            <Select
              label="조회 기간"
              value={period}
              onChange={setPeriod}
              options={(data?.periods ?? ["1W", "1M", "3M", "6M", "YTD", "1Y"]).map((value) => ({
                value,
                label: value,
              }))}
            />
            <Select
              label="표시 기준"
              value={mode}
              onChange={(value) => setMode(value as "return" | "alpha")}
              options={[
                { value: "return", label: "단순 수익률 (%)" },
                { value: "alpha", label: "S&P 500 대비 초과성과 (%p)" },
              ]}
            />
          </div>
        }
      >
        {loading && !data ? (
          <Loading label="섹터 데이터를 불러오는 중…" />
        ) : (
          <HorizontalBars
            data={chartData}
            unit={mode === "alpha" ? "%p" : "%"}
            digits={2}
            valueName={mode === "alpha" ? `${period} 초과성과` : `${period} 수익률`}
            height={Math.max(260, chartData.length * 28)}
          />
        )}
      </Card>

      {data && (
        <>
          <Card
            title="섹터 상세" source={SOURCES.yahooEtf}
            subtitle={`표본이 부족한 기간은 —로 표시합니다. 순위는 위에서 고른 ${period} 기준입니다.`}
          >
            <ReturnsTable rows={sectors} period={period} kindLabel="유형" />
          </Card>

          <Card title="자산군 상세" source={SOURCES.yahooEtf} subtitle="주식·채권·원자재·통화 전반의 상대 성과">
            {/* 초과성과(α)는 S&P 500 대비 지표라 자산군에는 의미가 없습니다.
                전부 "—"인 열을 남겨 두면 "계산이 실패했나?"로 읽힙니다. */}
            <ReturnsTable rows={assets} period={period} kindLabel="자산군" showAlpha={false} />
          </Card>
        </>
      )}
    </div>
  );
}

function ReturnsTable({
  rows,
  period,
  kindLabel,
  showAlpha = true,
}: {
  rows: SectorRow[];
  period: string;
  kindLabel: string;
  showAlpha?: boolean;
}) {
  const sorted = sortDescUnknownLast(rows, (row) => row.returns?.[period]);

  return (
    <Table
      rows={sorted}
      rowKey={(row) => row.ticker}
      emptyMessage="수집된 종목이 없습니다."
      columns={[
        {
          key: "rank",
          header: "순위",
          render: (row) => row.ranks?.[period] ?? EMPTY,
        },
        {
          key: "name",
          header: "이름",
          render: (row) => (
            <span className="flex flex-col">
              <span className="text-body">{row.name}</span>
              <span className="text-xs text-muted">{row.ticker}</span>
              {row.isStale && (
                <span className="text-xs" title={row.staleReason ?? undefined}>
                  <StatusText tone="warn" iconSize={12}>이전 값(수집 실패)</StatusText>
                </span>
              )}
            </span>
          ),
        },
        { key: "kind", header: kindLabel, render: (row) => <SourceBadge>{row.kind}</SourceBadge> },
        {
          key: "price",
          header: "현재가",
          align: "right",
          render: (row) => formatNumber(row.price, 2),
        },
        // 순위를 매긴 기간 열을 밝게 둡니다. 어떤 기준으로 1위가 됐는지
        // 표 안에서 바로 보이지 않으면 위쪽 선택값을 기억해야 합니다.
        ...["1W", "1M", "3M", "6M", "YTD", "1Y"].map((window) => ({
          key: window,
          header: window === period ? `${window} ▪` : window,
          align: "right" as const,
          className: window === period ? "bg-surface-hover/50" : undefined,
          render: (row: SectorRow) => (
            <span
              className={`${deltaColor(row.returns?.[window] ?? null)} ${
                window === period ? "font-semibold" : ""
              }`}
            >
              {formatPercent(row.returns?.[window] ?? null)}
            </span>
          ),
        })),
        ...(showAlpha
          ? [
              {
                key: "alpha",
                header: `α (${period})`,
                align: "right" as const,
                render: (row: SectorRow) =>
                  row.alpha ? (
                    <span className={deltaColor(row.alpha[period] ?? null)}>
                      {row.alpha[period] === null || row.alpha[period] === undefined
                        ? EMPTY
                        : `${formatNumber(row.alpha[period], 2)}%p`}
                    </span>
                  ) : (
                    EMPTY
                  ),
              },
            ]
          : []),
      ]}
    />
  );
}
