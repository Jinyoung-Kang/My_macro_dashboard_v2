"use client";

import { useState } from "react";
import { MultiLineSeries } from "@/components/charts";
import {
  Banner,
  Card,
  ErrorState,
  Freshness,
  Loading,
  Metric,
  Select,
} from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useRemembered } from "@/hooks/useRemembered";
import { SOURCES } from "@/lib/sources";
import { EMPTY, formatNumber, formatPercent } from "@/lib/format";
import type { FxSeriesResponse } from "@/lib/types";
import { endpoints } from "@/lib/endpoints";
import { mergeByDate } from "@/lib/chartData";

/**
 * 💱 환율·달러인덱스 비교.
 *
 * <p><b>왜 기본이 "기준일 = 100"인가</b> — 원/달러(약 1,380)·달러/엔(약 150)·
 * 엔/원(약 930)·달러 인덱스(약 100)를 원래 단위로 한 축에 겹치면 축이
 * 0~1,400이 되고, 아래 둘은 바닥에 눌려 직선이 됩니다. 기준일을 100으로
 * 맞추면 축이 "기준일 대비 %"가 되어 <b>무엇이 더 많이 움직였는지</b>를
 * 비교할 수 있습니다. 원래 단위도 고를 수 있지만, 단위가 섞이면 무슨 일이
 * 일어나는지 화면이 먼저 말해 줍니다.
 */
export function FxCompareSection() {
  // 기본은 원/달러 + 달러 인덱스입니다. 넷을 다 켜 두면 처음 보는 사람에게
  // 선이 너무 많고, 무엇을 비교하려던 것인지 화면이 말해 주지 못합니다.
  const [selected, setSelected] = useState<string[]>(["usdkrw", "dxy"]);
  const [period, setPeriod] = useState("1y");
  const [mode, setMode] = useState<"index" | "raw">("index");

  const { data, loading, error, reload, refreshError } = useApi<FxSeriesResponse>(
    endpoints.macro.fx(selected, period, mode),
    600_000,
  );

  // 계열 버튼은 응답의 카탈로그로 그립니다. 새 선택을 기다리는 동안에도 버튼이 사라지지 않게 마지막 카탈로그를 씁니다(QA-047).
  const catalog = useRemembered(data?.catalog) ?? [];
  const series = (data?.series ?? []).filter((entry) => entry.available);

  const toggle = (id: string) => {
    setSelected((previous) =>
      previous.includes(id)
        ? // 마지막 하나는 끄지 않습니다. 전부 끄면 백엔드가 기본 선택으로
          // 되돌리는데, 화면의 버튼은 전부 꺼진 상태라 선택과 차트가 어긋납니다.
          previous.length <= 1
          ? previous
          : previous.filter((entry) => entry !== id)
        : [...previous, id],
    );
  };

  // 계열마다 거래일이 다릅니다(시장별 휴일). 날짜를 합집합으로 모으고, 값이
  // 없는 날은 비워 둡니다 — 없는 거래를 선으로 이으면 실제로는 없던 흐름이
  // 생깁니다.
  const chartData = mergeByDate(series.map((entry) => ({ key: entry.id, points: entry.points })));

  const chartSeries = series.map((entry, index) => ({
    key: entry.id,
    name: entry.label,
    color: FX_COLORS[index % FX_COLORS.length],
  }));

  // 축 단위는 **모든 계열이 같은 단위일 때만** 붙입니다. 원과 엔이 섞인 축에
  // "원"을 달면 엔 계열까지 원으로 읽히게 됩니다. 기준일=100 모드의 축은
  // 어느 통화도 아니므로 단위가 없습니다.
  const units = [...new Set(series.map((entry) => entry.unit ?? ""))];
  const axisUnit = mode === "raw" && units.length === 1 ? units[0] : "";

  return (
    <Card
      title="환율·달러인덱스 비교"
      // 카드의 Yahoo 티커로 그립니다. 달러 인덱스·엔/원 카드는 TradingView 실시간 값이 먼저라(QA-138) 끝값이 조금 다를 수 있습니다.
      source={`${SOURCES.yahoo} — 매크로 카드의 Yahoo 티커(달러 인덱스·엔/원 카드는 TradingView 실시간 우선)`}
      subtitle={
        mode === "index"
          ? "기준일을 100으로 맞춰 겹칩니다 — 단위가 달라도 '무엇이 더 움직였는지'를 비교할 수 있습니다."
          : "원래 단위 그대로 그립니다 — 자릿수가 비슷한 계열끼리만 의미가 있습니다."
      }
      actions={
        <Freshness
          collectedAt={data?.collectedAtKst}
          ageSeconds={data?.ageSeconds}
          stale={data?.stale}
          refreshError={refreshError}
        />
      }
    >
      <div className="flex flex-wrap gap-2">
        {catalog.map((entry) => {
          const active = selected.includes(entry.id);
          return (
            <button
              key={entry.id}
              type="button"
              aria-pressed={active}
              onClick={() => toggle(entry.id)}
              className={`rounded-md border px-3 py-1.5 text-xs transition ${
                active
                  ? "border-accent/60 bg-accent/15 text-accent"
                  : "border-border bg-surface-hover text-muted hover:text-bright"
              }`}
            >
              {entry.label}
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <Select
          label="조회 기간"
          value={period}
          onChange={setPeriod}
          options={FX_PERIODS}
        />
        <Select
          label="표시 방식"
          value={mode}
          onChange={(value) => setMode(value === "raw" ? "raw" : "index")}
          options={[
            { value: "index", label: "기준일 = 100 (비교)" },
            { value: "raw", label: "원래 단위" },
          ]}
        />
      </div>

      {/* 고른 대로 그리되, 무슨 일이 일어나는지는 숨기지 않습니다. */}
      {mode === "raw" && data?.mixedUnits && (
        <Banner tone="warn">
          ⚠️ 단위가 섞였습니다(원·엔·pt). 한 축에 겹치면 값이 작은 계열은 바닥에
          눌려 직선처럼 보입니다. 비교가 목적이라면 <b>기준일 = 100</b>을 쓰세요.
        </Banner>
      )}

      {loading && !data && <Loading label="환율 시계열을 불러오는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && (
        <Banner tone="warn">
          {data.message ?? "표시할 환율 시계열이 없습니다."}
        </Banner>
      )}

      {series.length > 0 && (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {series.map((entry) => (
              <Metric
                key={entry.id}
                label={entry.label}
                // 자릿수는 위 환율 카드와 맞춥니다. 같은 값이 카드에서는
                // 100.11, 여기서는 100.110으로 보이면 둘 중 하나를 의심하게 됩니다.
                value={`${formatNumber(entry.latest, 2)}${
                  entry.unit ? ` ${entry.unit}` : ""
                }`}
                delta={entry.changePct}
                deltaText={`기간 ${formatPercent(entry.changePct)}`}
                caption={
                  entry.baseDate
                    ? `기준일 ${entry.baseDate} · 최근 ${entry.latestDate ?? EMPTY}`
                    : undefined
                }
              />
            ))}
          </div>

          <div className="mt-4">
            <MultiLineSeries
              data={chartData}
              series={chartSeries}
              unit={axisUnit}
              precision={mode === "index" ? 1 : 2}
              height={320}
            />
          </div>

          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            {mode === "index"
              ? "축은 기준일 = 100입니다. 110이면 기준일보다 10% 높다는 뜻이고, 계열별 기준일은 위 카드에 적혀 있습니다 — 시장마다 휴일이 달라 하루씩 어긋날 수 있습니다."
              : "축은 원래 단위입니다. 계열마다 단위가 다르면(원·엔·pt) 같은 눈금으로 읽으면 안 됩니다."}{" "}
            출처: Yahoo Finance 일별 종가 (매크로 카드와 같은 티커). 엔/원은
            100엔당으로 환산한 값입니다.
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * 4개 계열이 서로 구분되는 색. dataviz 검증기로 라이트(#ffffff)·다크(#1a1a19) 표면 모두 통과한 조합입니다(이웃 쌍 색약 ΔE 최소 8.1·정상 22.0).
 * 예전 값(#58A6FF·#D29922·#3FB950)은 초록↔노랑 색약 5.1과 다크 밝기 띠 이탈로 실패해 가장 가까운 통과 값으로 옮겼습니다.
 */
const FX_COLORS = ["#4798ee", "#d47d0d", "#1caa5e", "#a371f7"];

const FX_PERIODS = [
  { value: "1mo", label: "최근 1개월" },
  { value: "3mo", label: "최근 3개월" },
  { value: "6mo", label: "최근 6개월" },
  { value: "1y", label: "최근 1년" },
  { value: "2y", label: "최근 2년" },
  { value: "5y", label: "최근 5년" },
];
