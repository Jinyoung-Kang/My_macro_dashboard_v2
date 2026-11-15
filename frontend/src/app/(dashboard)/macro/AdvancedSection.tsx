"use client";

import { useState } from "react";
import { LineSeries, SERIES_COLORS } from "@/components/charts";
import { RangeTabs, sliceByRange, type RangeValue } from "@/components/RangeTabs";
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
import { SOURCES } from "@/lib/sources";
import {
  EMPTY,
  formatNumber,
  formatSampleWindow,
  formatSigned,
  statusColor, formatWithUnit } from "@/lib/format";
import type { AdvancedEntry, AdvancedIndicators } from "@/lib/types";
import { endpoints } from "@/lib/endpoints";

export function AdvancedSection({
  data,
  loading,
  error,
  onRetry,
  refreshError,
}: {
  data: AdvancedIndicators | null;
  loading: boolean;
  /** 첫 조회가 실패했으면 그 문구(useApi의 error). 값이 있는 동안의 실패는 refreshError입니다. */
  error?: string | null;
  onRetry?: () => void;
  /** 새로 읽기가 실패했으면 그 문구 — 앞서 받은 값을 보이는 중이라고 알립니다(QA-067). */
  refreshError?: string | null;
}) {
  const [selected, setSelected] = useState("T10Y3M");
  const [range, setRange] = useState<RangeValue>("10y");

  // 0선을 긋는 지표와, 0을 넘었을 때 무슨 뜻인지.
  //
  // 차트에는 0선만 그립니다. 선 하나로는 "지금 역전 상태"라는 판정까지
  // 전달되지 않으므로(색·선만으로 의미를 나르지 않습니다) 판정 문구는
  // 차트 위 배너가 맡습니다. 위 금리차 카드와 같은 방식입니다.
  const zeroLineNote = ZERO_LINE_NOTES[selected];

  // 10년치를 한 번 받아 두고 기간은 화면에서 자릅니다. 기간을 바꿀 때마다
  // 다시 부르면 FRED 호출만 늘고 반응도 느립니다.
  const series = useApi<{ available: boolean; points: { date: string; value: number }[] }>(
    endpoints.macro.fred(selected, 10),
  );

  if (loading && !data) {
    return (
      <Card title="심화 매크로 지표">
        <Loading />
      </Card>
    );
  }
  // 첫 조회가 실패하면 지표 칸 없는 빈 카드(선택지 없는 추이 선택 상자)가 아니라 이유와 다시 시도를 보입니다(QA-103).
  // 위험 지표 카드(RiskSection)처럼 값이 없으면 일찍 돌려줍니다.
  if (!data && error) {
    return (
      <Card title="심화 매크로 지표">
        <ErrorState message={error} onRetry={onRetry} />
      </Card>
    );
  }

  const entries = data ? data.order.map((id) => data.latest[id]).filter(Boolean) : [];

  return (
    <Card
      title="심화 매크로 지표"
      source={SOURCES.fred}
      subtitle="명목금리·하이일드만으로는 보이지 않는 구조를 메우는 6종 (30Y-3M은 DGS30−DGS3MO로 계산, 나머지는 FRED 공식 시계열)"
      actions={
        <span className="flex items-center gap-2">
          <Freshness refreshError={refreshError} />
          <RangeTabs value={range} onChange={setRange} />
        </span>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {entries.map((entry) => (
          <Metric
            key={entry.id}
            label={entry.label}
            value={
              entry.available
                ? formatWithUnit(entry.value, entry.digits, entry.unit)
                : "수집 실패"
            }
            delta={entry.delta}
            deltaText={
              entry.delta === null || entry.delta === undefined
                ? EMPTY
                : formatSigned(entry.delta, entry.digits)
            }
            deltaDigits={entry.digits}
            tone={entry.available ? statusColor(entry.color) : "text-text-3"}
            caption={
              entry.available ? (
                <span className="flex flex-col gap-0.5">
                  {entry.status && <span>상태: {entry.status}</span>}
                  {entry.percentile !== null && entry.percentile !== undefined && (
                    <span>표본 백분위 {formatNumber(entry.percentile, 1)}%</span>
                  )}
                  {entry.percentile !== null && entry.percentile !== undefined && (
                    <SampleWindow entry={entry} />
                  )}
                  {entry.asOf && <span>기준일 {entry.asOf}</span>}
                </span>
              ) : undefined
            }
            note={entry.note}
            source={entry.source}
          />
        ))}
      </div>

      {data?.derived?.decomposition && (
        <p className="mt-4 rounded-sm border border-border bg-bg px-3 py-2 text-xs text-text-3">
          {data.derived.decomposition}
          <span className="ml-2">
            (세 값의 기준 시점이 다르면 오차가 생기므로 참고용입니다.)
          </span>
        </p>
      )}

      <div className="mt-5">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Select
            label="추이 차트 지표"
            value={selected}
            onChange={setSelected}
            options={entries.map((entry) => ({ value: entry.id, label: entry.label }))}
          />
          <p className="text-xs text-text-3">
            {data?.latest[selected]?.why} · 출처: {data?.latest[selected]?.source}
          </p>
        </div>
        {zeroLineNote && crossedZero(zeroLineNote, data?.latest[selected]?.value) && (
          <div className="mb-3">
            <Banner tone={zeroLineNote.tone}>{zeroLineNote.message}</Banner>
          </div>
        )}
        <LineSeries
          data={sliceByRange(
            (series.data?.points ?? []).map((point) => ({
              date: point.date,
              value: point.value,
            })),
            range,
          )}
          unit={data?.latest[selected]?.unit ?? ""}
          zeroLine={Boolean(zeroLineNote)}
          precision={data?.latest[selected]?.digits ?? 2}
          color={SERIES_COLORS.blue}
          height={280}
        />
      </div>
    </Card>
  );
}

/**
 * 0선이 의미를 갖는 심화 지표와, 선을 넘었을 때의 판정 문구.
 *
 * `side`는 "어느 쪽으로 넘어갔을 때 경고인가"입니다.
 *   T10Y3M — 음수면 장단기 금리 역전
 *   NFCI   — 양수면 금융상황이 평균보다 긴축적
 * 여기 없는 지표는 0선도, 배너도 그리지 않습니다.
 */
const ZERO_LINE_NOTES: Record<
  string,
  { side: "below" | "above"; tone: "danger" | "warn"; message: string }
> = {
  T10Y3M: {
    side: "below",
    tone: "danger",
    message:
      "10년−3개월 스프레드가 역전(음수) 상태입니다. 역사적으로 1~2년 내 침체가 뒤따른 구간입니다.",
  },
  T30Y3M: {
    side: "below",
    tone: "danger",
    message:
      "30년−3개월 스프레드가 역전(음수) 상태입니다. 만기 축 전체가 눌려 있다는 뜻으로, "
      + "10Y-3M보다 늦게 역전되고 늦게 풀립니다.",
  },
  NFCI: {
    side: "above",
    tone: "warn",
    message:
      "금융상황지수가 0을 넘었습니다. 0이 장기 평균이므로, 지금은 평균보다 긴축적인 상태입니다.",
  },
};

/**
 * 백분위의 표본 — 지표마다 길이가 다릅니다(IG 스프레드는 FRED가 최근 3년만 제공, 나머지는 약 10년).
 * 표본을 함께 적지 않으면 "3년 안의 중간"이 "역사적 중간"처럼 읽혀, "과열" 판정과 어긋나 보였습니다.
 */
function SampleWindow({ entry }: { entry: AdvancedEntry }) {
  const text = formatSampleWindow(entry.percentileFrom, entry.percentileCount, entry.percentileYears);
  return text ? <span>표본 {text}</span> : null;
}

/** 최신값이 경고 방향으로 0선을 넘었는지. 값이 없으면 판정하지 않습니다. */
function crossedZero(
  note: (typeof ZERO_LINE_NOTES)[string],
  value: number | null | undefined,
): boolean {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return false;
  }
  return note.side === "below" ? value < 0 : value > 0;
}
