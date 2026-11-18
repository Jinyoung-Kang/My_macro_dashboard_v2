"use client";

import { HeatmapTable } from "@/components/patterns/HeatmapTable";
import { EMPTY, formatNumber, formatWeightPercent } from "@/lib/format";
import { heatmapStepRange } from "@/lib/heatmap";

/**
 * 비중 히트맵 — 분기마다 어느 종목의 비중이 커지고 줄었는지(13F 포트폴리오 화면). 표 히트맵(`HeatmapTable`)의 감싸개입니다.
 *
 * <p>선 차트로 15개 종목을 겹쳐 그리면 색이 모자라고 선이 엉킵니다. 값의 크기를
 * 색 단계로 칠하면 "어느 칸이 밝아지는가"만 보면 됩니다(단계는 표 안 최댓값에 견준 크기).
 *
 * <p>색만으로 값을 나르지 않도록 <b>칸 안에 숫자도 함께</b> 적습니다.
 */
export function WeightHeatmap({
  dates,
  series,
  unit = "%",
}: {
  dates: string[];
  series: Record<string, (number | null)[]>;
  unit?: string;
}) {
  const names = Object.keys(series);
  if (names.length === 0 || dates.length === 0) {
    return <div className="py-10 text-center text-sm text-text-3">표시할 비중 이력이 없습니다.</div>;
  }

  const values = names.flatMap((name) => series[name] ?? []);
  const max = Math.max(...values.filter((v): v is number => typeof v === "number"), 0);
  // 들고 있었지만 0.05% 미만인 칸은 '<0.1%' — '0.0%'면 미보유('·')처럼 없는 값으로 읽힙니다(QA-454).
  const formatWeight = (value: number) => (unit === "%" ? formatWeightPercent(value, 1) : `${formatNumber(value, 1)}${unit}`);

  return (
    <HeatmapTable
      caption="비중 히트맵"
      rowHeader="종목"
      // 날짜 머리는 줄바꿈하지 않습니다 — 표 최소 폭에 눌린 열(1024 가운데 칸 등)에서 하이픈 뒤로 '24-09-' / '30'처럼 꺾였습니다.
      columns={dates.map((date) => ({ key: date, label: date.slice(2), title: date, nowrap: true }))}
      rows={names.map((name) => ({
        key: name,
        label: name,
        // 13F 비중에는 0보다 작은 값이 없습니다 — 혹시 음수가 오면 예전처럼 0과 같은 '·'(그 분기에 보유하지 않음)로 적습니다. 유한하지 않은 수는 표가 모름('—')으로 봅니다.
        values: (series[name] ?? []).map((value) => (typeof value === "number" && Number.isFinite(value) && value < 0 ? 0 : value)),
      }))}
      max={max}
      format={formatWeight}
      // 열은 분기 차례(오래된 것 → 최근) — 상자보다 넓으면 가장 최근 분기가 먼저 보이게 오른쪽 끝에서 시작합니다(QA-713).
      initialScroll="end"
      // 0%는 "미보유"입니다. 값을 모르는 것(EMPTY)과 같은 기호를 쓰면 둘을 구분할 수 없습니다.
      zeroText={{ text: "·", sr: "보유하지 않음" }}
      legend={{
        stepLabel: (step) => {
          const [low, high] = heatmapStepRange(step);
          return `최댓값의 ${Math.round(low * 100)}~${Math.round(high * 100)}%`;
        },
        note: (
          <>
            {max > 0 ? <>최댓값은 이 표에서 가장 큰 비중({formatWeight(max)})입니다. </> : null}
            &quot;·&quot;는 그 분기에 <b>보유하지 않았다</b>는 뜻이고, &quot;{EMPTY}&quot;는 <b>값을 모른다</b>는 뜻입니다 — 둘은 다르고, 둘 다 칠하지 않습니다.
          </>
        ),
      }}
    />
  );
}
