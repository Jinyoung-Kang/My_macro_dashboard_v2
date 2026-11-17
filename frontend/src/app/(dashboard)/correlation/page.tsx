"use client";

import { useState } from "react";
import { LineSeries, ScatterPlot, SERIES_COLORS } from "@/components/charts";
import { type KpiItem, KpiStrip, type PropertyItem, PropertyList, Skeleton, SplitPane } from "@/components/patterns";
import {
  Callout,
  EmptyState,
  ErrorState,
  Freshness,
  Loading,
  PageHeader,
  Panel,
  Select,
  SourceBadge,
} from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { firstLoadPending, useApi } from "@/hooks/useApi";
import { EMPTY, formatNumber, withMinusSign } from "@/lib/format";
import { correlationEstimated, correlationStrength } from "@/lib/correlation";
import type { CorrelationResponse, SeriesRef } from "@/lib/types";
import { endpoints } from "@/lib/endpoints";

/** 비교 방식 고르기의 선택지 — 고른 쌍 속성의 '방식' 글도 이 이름을 씁니다. */
const MODES = [
  { value: "change", label: "변화끼리 (권장)" },
  { value: "level", label: "수준끼리 (허위 상관 주의)" },
];

/** 롤링·산점도 패널의 부제 — 읽는 동안의 자리표시 패널과 값이 온 뒤의 패널이 같은 글(높이가 같게). */
const ROLLING_SUBTITLE = "한 숫자로 요약한 상관은 시기에 따라 크게 달라집니다. 언제 함께 움직였는지를 봅니다.";
function scatterSubtitle(mode: string): string {
  return mode === "change"
    ? "점 하나가 하루(또는 한 관측)의 변화입니다. 오른쪽 위·왼쪽 아래에 몰리면 같이 움직인 것입니다."
    : "수준끼리 뿌린 점입니다. 시간에 따라 이동한 궤적이 대각선으로 보이면 추세 때문입니다.";
}
const ROLLING_HEIGHT = 260;
const SCATTER_HEIGHT = 360;

/**
 * 상관을 처음 읽는 동안(또는 고르기를 바꿔 다시 읽는 동안 — 앞선 실패가 없을 때, QA-655)의 가운데 칸 — 값이 온 뒤의 KPI 띠 둘·롤링·산점도 패널과 같은 자리(차트 높이와 같은 Skeleton).
 * lg(1024~1279)에서는 '고른 쌍'이 가운데 칸 아래에 놓여, 읽는 중 글 한 줄뿐이면 그 패널이 위에 먼저 그려졌다가 값이 오며 화면 밖으로 밀렸습니다
 * (P5a 검토 — CLS 1024 0.25, 기준 0.02).
 */
function CorrelationPending({ mode, window }: { mode: string; window: string }) {
  return (
    <>
      {/* 이름은 값이 온 뒤의 띠('상관 요약')와 다르게 — 읽는 중인 영역임을 이름이 말합니다. */}
      <KpiStrip
        label="상관 요약 불러오는 중"
        items={[
          { key: "overall", label: `상관계수 (${mode === "change" ? "변화" : "수준"})`, value: null, pending: true, pendingLines: 1 },
          { key: "samples", label: "표본 수", value: null, pending: true, pendingLines: 1 },
        ]}
      />
      <Panel title={`롤링 상관계수 (${window} 관측)`} subtitle={ROLLING_SUBTITLE}>
        <Skeleton height={ROLLING_HEIGHT} label="상관을 계산하는 중" />
      </Panel>
      <Panel title="산점도" subtitle={scatterSubtitle(mode)}>
        <Skeleton height={SCATTER_HEIGHT} label="산점도를 그리는 중" />
      </Panel>
    </>
  );
}

/** 고른 쌍의 계열 속성 — 이름·묶음·단위·출처, 추정 계열이면 이름 옆에 '추정' 배지(QA-634). 단위가 빈 글이면 단위 없는 계열입니다. */
function seriesItems(ref: SeriesRef | null): PropertyItem[] {
  return [
    { label: "이름", value: ref?.label ?? null, isEstimated: ref?.isEstimated },
    { label: "묶음", value: ref?.group ?? null },
    { label: "단위", value: ref?.unit || null, emptyReason: ref ? "단위 없음" : null },
    { label: "출처", value: ref?.source ?? null },
  ];
}

/**
 * 지표 상관관계.
 *
 * <p>두 지표가 <b>같이 움직이는지</b> 봅니다. 기본값은 "변화(Δ)"입니다 — 수준
 * 끼리 비교하면 둘 다 추세만 가져도 상관이 0.9를 넘습니다(허위 상관).
 *
 * <p>상관은 <b>인과가 아닙니다.</b> 화면은 계산 결과와 함께 표본 수와 주의
 * 문구를 항상 같이 보여 줍니다.
 *
 * <p>칸 틀(작업대 실행 명세 §7 — 고른 쌍 검사): 왼쪽 '비교할 지표'(고르기 다섯), 가운데 KPI 띠(상관계수·표본 수)·주의 글·롤링 상관·산점도, 오른쪽 '고른 쌍' 속성.
 * 넓은 화면(xl)은 세 칸, lg는 '고른 쌍'이 가운데 아래, 좁은 화면은 한 칸(고르기 → 결과 → 고른 쌍). 상관 행렬(발산 팔레트)은 두지 않습니다 —
 * 상관 API가 한 쌍씩만 계산해(계열 20개면 190번 요청) 행렬 경로가 없습니다(새 API는 별도 결정).
 */
export default function CorrelationPage() {
  const catalog = useApi<{ series: SeriesRef[] }>(endpoints.insight.series);

  const [x, setX] = useState("liquidity:net");
  const [y, setY] = useState("etf:QQQ");
  const [window, setWindow] = useState("60");
  const [years, setYears] = useState("3");
  const [mode, setMode] = useState("change");

  const { data, loading, error, reload, refreshError, failedAt } = useApi<CorrelationResponse>(
    endpoints.insight.correlation({ x, y, window, years, mode }),
    300_000,
  );

  const series = catalog.data?.series ?? [];
  // 계열 고르기의 선택지 — 묶음(금리·신용 등)은 optgroup으로 빼 고른 값의 글이 이름만 남습니다(예전 '연준 순유동성 · 유동성'은 왼쪽 칸 고르기에서
  // 잘렸음 — P5a 검토). 묶음은 고른 쌍 속성의 '묶음' 줄에도 있습니다.
  const options = series.map((entry) => ({
    value: entry.id,
    label: entry.label,
    group: entry.group,
  }));
  // 고른 쌍 — 상관 응답의 계열 설명(추정 여부·추정 출처 포함)이 먼저이고, 응답이 없거나 계산하지 못했으면 계열 목록의 정의를 씁니다.
  const xRef = data?.x ?? series.find((entry) => entry.id === x) ?? null;
  const yRef = data?.y ?? series.find((entry) => entry.id === y) ?? null;
  const pairPending = !xRef && !yRef && (catalog.loading || loading);
  const modeLabel = MODES.find((entry) => entry.value === mode)?.label ?? mode;

  // 계산 기간 — 두 계열이 모두 값을 가진 첫날 ~ 마지막 날(응답). 둘 다 모르면 없음.
  const period = data?.available && (data.firstDate || data.lastDate) ? `${data.firstDate ?? EMPTY} ~ ${data.lastDate ?? EMPTY}` : null;
  const kpis: KpiItem[] = data?.available
    ? [
        {
          key: "overall",
          label: `상관계수 (${mode === "change" ? "변화" : "수준"})`,
          // 소수 셋째 자리, 음수는 −(U+2212). 등락이 아니라 계수라 + 부호·등락 색을 붙이지 않습니다.
          value: data.overall === null ? null : withMinusSign(formatNumber(data.overall, 3)),
          note: correlationStrength(data.overall),
          // 두 계열 가운데 하나라도 추정치면 상관계수도 추정치입니다 — 배지를 늘 보입니다(QA-634).
          isEstimated: correlationEstimated(data),
        },
        // 계산 기간은 표본 수의 보조 글로 — 날짜를 타일 값(20·24px)으로 두면 타일이 좁은 배치(lg 네 칸 115~123px — 1024~약 1400)에서 날짜 안에서
        // '2024-11-|05'로 꺾였습니다. 표본을 세는 규칙은 '고른 쌍 > 비교'의 계산 기간 줄에 둡니다.
        {
          key: "samples",
          label: "표본 수",
          value: data.samples,
          format: (value) => value.toLocaleString("ko-KR"),
          unit: "개",
          note: period,
        },
      ]
    : [];
  const pairSource = data?.available ? `${data.x?.label}: ${data.x?.source} · ${data.y?.label}: ${data.y?.source}` : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
      <PageHeader title="지표 상관관계" description="이미 수집한 지표끼리 엮어 봅니다 · 롤링 상관계수 + 산점도 · 상관은 인과가 아닙니다" />

      <SplitPane
        // 왼쪽 칸 15rem — 계열 이름 가장 긴 것(152px)이 고르기 안쪽(13rem 칸 130px)에서 잘리지 않게(15rem 칸 162px).
        leftWidth="wide"
        left={
          // 자동 갱신이 실패하면 앞서 받은 값을 그대로 보이므로 '새로 읽지 못함'을 붙입니다(QA-104, QA-067과 같음).
          <Panel title="비교할 지표" actions={<Freshness refreshError={refreshError} />}>
            <div className="flex flex-col gap-3">
              {/* 왼쪽 칸(lg 이상 15rem)에서는 한 줄에 하나, 좁은 칸 틀(sm~lg)에서는 두 줄씩. */}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
                <Select label="지표 X" value={x} onChange={setX} options={options} />
                <Select label="지표 Y" value={y} onChange={setY} options={options} />
                <Select label="비교 방식" value={mode} onChange={setMode} options={MODES} />
                <Select
                  label="롤링 창"
                  value={window}
                  onChange={setWindow}
                  options={["20", "60", "120", "250"].map((value) => ({
                    value,
                    label: `${value} 관측`,
                  }))}
                />
                <Select
                  label="조회 기간"
                  value={years}
                  onChange={setYears}
                  options={["1", "3", "5", "10"].map((value) => ({ value, label: `최근 ${value}년` }))}
                />
              </div>
              {/*
                계열 목록을 읽지 못하면 지표 X·Y 고르기는 선택지 없는 빈 상자입니다 — 까닭과 목록만 다시 읽는 단추를 고르기 아래에 둡니다(QA-664).
                고르기는 막지 않고(disabled 아님), 가운데 상관 오류 상자의 다시 시도와 묶지 않습니다(상자마다 자기 다시 시도).
              */}
              {catalog.error && <ErrorState message={`지표 목록을 읽지 못했습니다 — ${catalog.error}`} onRetry={catalog.reload} />}
            </div>
          </Panel>
        }
        right={
          // 고른 쌍 검사 — 두 계열의 정의와 비교 조건. 링크는 두지 않습니다(명세 범위 — 쌍 검사).
          <Panel title="고른 쌍">
            <div className="flex flex-col gap-3">
              {/* 제목은 고르기 이름('지표 X')과 겹치지 않게 'X 계열' — 같은 이름의 고르기 상자와 영역이 둘이면 낭독기 목록에서 헷갈립니다. */}
              <PropertyList title="X 계열" items={seriesItems(xRef)} placeholder={pairPending ? <Skeleton lines={3} label="X 계열 불러오는 중" /> : undefined} />
              <PropertyList title="Y 계열" items={seriesItems(yRef)} placeholder={pairPending ? <Skeleton lines={3} label="Y 계열 불러오는 중" /> : undefined} />
              <PropertyList
                title="비교"
                items={[
                  { label: "방식", value: modeLabel },
                  // 롤링 창은 응답이 쓴 값(백엔드가 표본에 맞춰 줄였으면 그 값) — 응답 전에는 고른 값.
                  { label: "롤링 창", value: `${data?.window ?? window} 관측` },
                  { label: "조회 기간", value: `최근 ${years}년` },
                  { label: "계산 기간", value: period, note: "두 지표가 모두 값을 가진 날짜만 표본으로 셉니다." },
                ]}
              />
            </div>
          </Panel>
        }
      >
        {/* 값 꼴 자리는 처음 읽는 동안(과 고르기를 바꿔 다시 읽는 동안)만 — 실패 뒤 다시 읽는 동안은 한 줄(오류 상자와 이 자리가 갱신마다 번갈아 그려지지 않게 — QA-655). */}
        {loading && !data && (firstLoadPending({ data, loading, failedAt }) ? <CorrelationPending mode={mode} window={window} /> : <Loading label="상관을 계산하는 중…" />)}
        {error && <ErrorState message={error} onRetry={reload} />}

        {data && !data.available && <Callout tone="warn">{data.message ?? "계산할 수 없습니다."}</Callout>}

        {data?.available && (
          <>
            {/* 보조 글의 계산 기간('2024-11-05 ~ 2026-11-03')은 날짜 마디 사이에서만 꺾습니다(keepDates — 시장 화면 띠와 같음, QA-663). */}
            <KpiStrip label="상관 요약" items={kpis} keepDates />

            {(data.notes ?? []).map((note) => (
              <p key={note} className="rounded-sm border border-border bg-bg px-3 py-2 text-xs text-text-3">
                <StatusText tone="warn" colorText={false} iconSize={12}>{note}</StatusText>
              </p>
            ))}

            <Panel
              title={`롤링 상관계수 (${window} 관측)`}
              source={pairSource}
              subtitle={ROLLING_SUBTITLE}
              actions={
                <SourceBadge>
                  {data.x?.label} ↔ {data.y?.label}
                </SourceBadge>
              }
            >
              <LineSeries
                data={(data.rolling ?? []).map((point) => ({
                  date: point.date,
                  value: point.value,
                }))}
                zeroLine
                grid
                ariaLabel={`${data.x?.label ?? "X"} ↔ ${data.y?.label ?? "Y"} 롤링 상관계수 (${window} 관측)`}
                precision={2}
                color={SERIES_COLORS.green}
                height={ROLLING_HEIGHT}
              />
            </Panel>

            <Panel
              title="산점도"
              source={pairSource}
              subtitle={scatterSubtitle(mode)}
            >
              <ScatterPlot
                data={data.scatter ?? []}
                xLabel={data.x?.label ?? "X"}
                yLabel={data.y?.label ?? "Y"}
                xUnit={data.x?.unit ?? ""}
                yUnit={data.y?.unit ?? ""}
                height={SCATTER_HEIGHT}
              />
            </Panel>
          </>
        )}

        {!loading && !data && <EmptyState message="지표를 고르면 계산합니다." />}
      </SplitPane>
    </div>
  );
}
