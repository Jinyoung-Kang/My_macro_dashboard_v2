"use client";

import { useState } from "react";
import { LineSeries, SERIES_COLORS } from "@/components/charts";
import {
  Banner,
  Card,
  ErrorState,
  Freshness,
  Loading,
  Metric,
  PageHeader,
  Select,
} from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { liquidityChartSeries } from "@/lib/liquidity";
import { useUsdKrw } from "@/hooks/useUsdKrw";
import {
  formatBillionUsd,
  formatTrillionDelta,
  formatTrillionUsd,
} from "@/lib/format";
import type { LiquidityResponse } from "@/lib/types";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";

const PERIODS = [
  { value: "1", label: "최근 1년" },
  { value: "2", label: "최근 2년" },
  { value: "3", label: "최근 3년" },
  { value: "5", label: "최근 5년" },
  { value: "10", label: "최근 10년" },
];

/**
 * 연준 순유동성 트래커.
 *
 * 순유동성 = WALCL(연준 총자산) − TGA(재무부 일반계정) − ON RRP(역레포)
 * 시장에 실제로 남아 있는 달러 유동성의 근사치로, 위험자산 방향과 상관이
 * 높다고 알려진 지표입니다.
 */
export default function LiquidityPage() {
  const [years, setYears] = useState("3");
  const { data, loading, error, reload, refreshError } = useApi<LiquidityResponse>(
    endpoints.macro.liquidity(years),
    300_000,
  );
  // 달러 금액에 원화를 함께 적습니다. 매크로 화면이 이미 수집한 같은 환율을
  // 쓰므로, 두 화면을 나란히 놓아도 환산액이 어긋나지 않습니다.
  const usdKrw = useUsdKrw();


  const rows = data?.rows ?? [];
  const latest = data?.latest;

  // 기간은 머리말의 '조회 기간' 하나가 두 차트를 함께 좁힙니다.
  // 카드마다 따로 두면 화면에 기간 컨트롤이 셋이 되고, 어느 것이 무엇에
  // 걸리는지 읽는 사람이 추적해야 합니다.
  // 단위는 위 KPI 타일과 같게(총자산 = 조 달러 / TGA·RRP = 억 달러) — 규칙은 lib/liquidity.ts.
  const { netLiquidity, components: componentSeries } = liquidityChartSeries(rows);

  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      <PageHeader
        title="연준 순유동성 트래커"
        description="WALCL − TGA − ON RRP · 출처: FRED 공식 시계열 (주간 갱신)"
        actions={
          // 선택 상자는 위에 이름표가 있어, 가운데 정렬이면 수집 시각 배지가 상자보다 위로 뜹니다(이름표+상자의 가운데).
          // 아래 끝을 맞추고 배지를 상자와 같은 높이(lg 미만 44px·lg 40px) 칸의 가운데에 두어 두 가운데를 한 줄에 둡니다.
          <div className="flex flex-wrap items-end gap-3">
            <Select label="조회 기간" value={years} onChange={setYears} options={PERIODS} />
            <div className="flex min-h-11 items-center lg:min-h-10">
              <Freshness
                collectedAt={data?.collectedAtKst}
                ageSeconds={data?.ageSeconds}
                stale={data?.stale}
                refreshError={refreshError}
              />
            </div>
          </div>
        }
      />

      {/* 컨트롤(머리말·첫 카드)은 늘 그리고 본문만 로딩·오류로 바꿉니다 — 페이지 전체를 바꾸면 방금 조작한
          선택 상자가 사라지고 키보드 포커스를 잃었습니다(QA-047). */}
      {loading && !data && <Loading label="순유동성 데이터를 불러오는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && (
        <>

        {!data?.available && (
          <Banner tone="warn">
            {data?.message ?? "순유동성 데이터가 없습니다. 수집기를 실행하세요."}
          </Banner>
        )}

        {data?.isEstimated && (
          <Banner tone="danger">
            추정치 모드입니다. FRED 확정치가 아니므로 수치를 그대로 신뢰하지 마세요.
          </Banner>
        )}

        {latest && (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              label="순유동성 (Net Liquidity)"
              value={formatTrillionUsd(latest.netLiquidityT)}
              delta={latest.deltaT}
              deltaText={formatTrillionDelta(latest.deltaT)}
              caption={usdKrw.trillionToKrw(latest.netLiquidityT) ?? undefined}
              note={latest.date ? `기준일 ${latest.date} · ${usdKrw.note}` : usdKrw.note}
            />
            <Metric
              label="연준 총자산 (WALCL)"
              value={formatTrillionUsd(latest.walclT)}
              caption={usdKrw.trillionToKrw(latest.walclT) ?? undefined}
            />
            <Metric
              label="재무부 일반계정 (TGA)"
              value={formatBillionUsd(latest.tgaB)}
              caption={usdKrw.billionToKrw(latest.tgaB) ?? undefined}
              note="TGA 증가 = 시장에서 자금 흡수"
            />
            <Metric
              label="역레포 (ON RRP)"
              value={formatBillionUsd(latest.rrpB)}
              caption={usdKrw.billionToKrw(latest.rrpB) ?? undefined}
              note="RRP 감소 = 시장으로 유동성 환류"
            />
          </div>
        )}

        {data?.momentum && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Metric
              label="4주 변화"
              value={formatTrillionDelta(data.momentum.change4w)}
              delta={data.momentum.change4w}
              deltaText=""
              caption={krwDelta(usdKrw.trillionToKrw, data.momentum.change4w)}
              note="유동성은 방향과 속도가 함께 중요합니다."
            />
            <Metric
              label="12주 변화"
              value={formatTrillionDelta(data.momentum.change12w)}
              delta={data.momentum.change12w}
              deltaText=""
              caption={krwDelta(usdKrw.trillionToKrw, data.momentum.change12w)}
            />
          </div>
        )}

        <Card
          title="순유동성 추이" source={SOURCES.fredLiquidity}
          subtitle="단위: 조 달러 · 축은 데이터 범위에 맞춥니다 (0부터 그리면 변동이 보이지 않습니다)"
        >
          <LineSeries
            data={netLiquidity}
            unit="조"
            color={SERIES_COLORS.green}
            height={320}
          />
        </Card>

        {/*
          구성 항목은 자릿수가 다릅니다 — 총자산 약 6.7조, 재무부 계정 약 0.88조,
          역레포 약 0.005조. 한 축에 겹쳐 그리면 아래 둘이 바닥에 눌려 직선이
          됩니다(예전 화면이 그랬습니다). 축을 둘로 나누는 것은 두 축의 정렬이
          임의라 없는 상관을 만들어 냅니다. 그래서 **패널을 나눕니다** —
          각자 제 범위를 갖고, 시간축은 공유합니다.
        */}
        <Card
          title="구성 항목 분해" source={SOURCES.fredLiquidity}
          subtitle="총자산이 늘어도 TGA·RRP가 더 늘면 시장 유동성은 줄어듭니다. 자릿수가 달라 패널과 단위를 나눕니다 (단위는 각 패널 제목 옆)."
        >
          <div className="grid gap-4 lg:grid-cols-3">
            {COMPONENTS.map((component) => (
              <div key={component.key}>
                <div className="mb-1 flex items-baseline gap-2">
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: component.color }}
                  />
                  <h3 className="text-xs font-semibold text-body">{component.name}</h3>
                  <span className="text-xs text-muted">{component.unit}</span>
                </div>
                <p className="mb-2 text-xs leading-relaxed text-muted">
                  {component.note}
                </p>
                <LineSeries
                  data={componentSeries[component.key]}
                  unit={component.suffix}
                  precision={component.precision}
                  color={component.color}
                  height={200}
                />
              </div>
            ))}
          </div>
        </Card>
        </>
      )}
    </div>
  );
}

/**
 * 변화량의 원화 환산.
 *
 * <p>환율을 모르면 undefined를 돌려 <b>줄 자체를 없앱니다</b>. 빈 문자열을
 * 돌려주면 자리는 차지하면서 아무 말도 하지 않는 줄이 남습니다.
 */
function krwDelta(
  convert: (value: number | null | undefined) => string | null,
  value: number | null | undefined,
): string | undefined {
  return convert(value) ?? undefined;
}

/**
 * 구성 항목 패널.
 *
 * 색은 dataviz 검증기를 통과한 조합입니다. 패널마다 계열이 하나뿐이라
 * 색이 의미를 나르지는 않지만, 제목 옆 점과 선 색을 맞춰 두면 눈이 덜
 * 헤맵니다.
 */
const COMPONENTS = [
  {
    key: "walcl" as const,
    name: "연준 총자산 (WALCL)",
    unit: "조 달러",
    suffix: "조",
    precision: 2,
    color: SERIES_COLORS.blue,
    note: "자산 매입은 유동성을 늘리고, 축소(QT)는 줄입니다.",
  },
  {
    key: "tga" as const,
    name: "재무부 일반계정 (TGA)",
    unit: "억 달러",
    suffix: "억",
    precision: 0,
    color: SERIES_COLORS.orange,
    note: "TGA 증가 = 시장에서 자금 흡수.",
  },
  {
    key: "rrp" as const,
    name: "역레포 (ON RRP)",
    unit: "억 달러",
    suffix: "억",
    precision: 0,
    color: SERIES_COLORS.green,
    note: "RRP 감소 = 시장으로 유동성 환류.",
  },
];
