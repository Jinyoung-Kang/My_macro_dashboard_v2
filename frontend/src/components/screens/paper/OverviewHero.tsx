"use client";

import { LiveIntervalSelect } from "@/components/LiveIntervalSelect";
import { LineChart } from "@/components/charts";
import { ChangeChip, EstimateBadge, Hero, ProvenanceBadge, RangeTabs, StaleBadge } from "@/components/patterns";
import { NativeSelect } from "@/components/ui";
import { AlertTriangleIcon, StatusText } from "@/components/ui/icons";
import { useChartScrub } from "@/hooks/useChartScrub";
import { formatNumber } from "@/lib/format";
import { hasLineValues, scrubModel } from "@/lib/lineChart";
import { HERO_NAV_KEY, NAV_RANGES, type NavRangeKey, type OverviewHeroModel } from "@/lib/paperOverview";

/**
 * 모의매매 개요 히어로(포트폴리오식 — 장중 명세 §4-1, Coinbase식 개편 명세 D1) — 고른 계좌 하나의 지금 값과 그 계좌 곡선.
 *
 * - 값은 계좌 행과 같은 지금 값(`lib/paperOverview` `overviewHeroModel` — 장중 추정이면 추정 배지와 단계 표기, 옛 응답이면 장부 값과 마지막 관측).
 *   큰 칩은 '출발 이후'(계좌 행·비교 표와 같은 뜻), 그 아래 변화 한 줄('오늘'·'MM-DD 변화' — 서버 값, 모르면 줄 없음). 서버의 긴 글(섞임·체결 대기)은 맨 아래 한 줄.
 * - 곡선은 고른 계좌 한 줄(`LineChart` hero — 중립 잉크 선, 격자 없음, 문지르면 큰 숫자가 그 날 값). 기간 알약은 차트 아래이고, 아래 '순자산 곡선'
 *   카드와 같은 기간 상태입니다(그 카드의 탭은 없음 — aria-label '순자산 곡선 기간'은 이 탭). 고를 기간이 '전체' 하나뿐이면 탭을 그리지 않습니다.
 * - 오늘 추정 점이 있으면(개요 `navEstimate`) 마지막 줄 → 그 점의 점선 꼬리 — 문지르면 '추정 HH:MM'(현금뿐 계좌는 '장부', 장중 명세 §4).
 * - 문지르는 동안 큰 숫자는 그 점의 값이고, 단계 표기·추정 배지·서버 글은 지금 값의 것이라 앞에 '지금 값 …'을 붙입니다(배지는 그대로 보임 — A3).
 * - 제목 줄 오른쪽에 실시간 주기 고르기(사용자 요청 2026-11-03 — 장중 카드·보유 표와 같은 값, 그 주기로 순자산을 실시간 시세로 다시 셈 — '실시간 추정').
 * - 제목 줄 오른쪽의 고르기 상자로 계좌를 바꿉니다(사용자 요청 2026-11-02 — 계좌 행을 눌러 고르는 것과 같은 상태, 계좌가 둘 이상일 때만). 계좌를
 *   바꿔도 이 컴포넌트를 다시 마운트하지 않아(고르기 상자가 초점을 잃지 않음) 문지르기 상태는 계좌 코드로 지웁니다(`useChartScrub`의 scope).
 * - 그리기만 합니다 — 값·글은 lib, 문지르기 상태는 `hooks/useChartScrub`.
 */
export function OverviewHero({
  model,
  range,
  ranges,
  onRange,
  accounts = [],
  onPick,
}: {
  model: OverviewHeroModel;
  range: NavRangeKey;
  /** 고를 수 있는 기간(저장 구간 안). */
  ranges: readonly NavRangeKey[];
  onRange: (range: NavRangeKey) => void;
  /** 고르기 상자의 계좌(계좌 행과 같은 순서 — 서버 이름). 둘 이상이고 onPick이 있을 때만 상자를 그립니다. */
  accounts?: readonly { code: string; label: string }[];
  onPick?: (code: string) => void;
}) {
  const { chart } = model;
  const { index, onScrub } = useChartScrub(chart.rows.length, model.code);
  const format = (value: number) => formatNumber(value, chart.valueDigits);
  // 그릴 값이 있을 때만 문지를 수 있는 히어로(알림 영역을 미리 둠 — 문지르지 않을 때 null). 값이 없으면 차트가 빈 상태 문구만 그립니다.
  const scrubbable = hasLineValues(chart.rows, chart.series);
  // 오늘 추정 점(꼬리)을 문지르면 꼬리 값과 '추정 HH:MM'(현금뿐 계좌는 배지 없이 '장부') — 배지와 낭독 알림 둘 다(Hero).
  const point = scrubbable ? scrubModel(chart.rows, HERO_NAV_KEY, index, format, { estimate: chart.estimate }) : null;
  const scrub = scrubbable ? (point ? { ...point, changeDigits: chart.valueDigits } : null) : undefined;
  // 문지르는 중 — 큰 숫자가 그 점의 값으로 바뀐 동안(아래 단계 표기·배지·서버 글은 지금 값의 것).
  const scrubbing = point !== null;

  return (
    <Hero
      label={model.label}
      value={model.valueText}
      unit={model.unit}
      change={
        model.returnPct !== null || model.day ? (
          <span className="flex flex-col items-start gap-1">
            {model.returnPct !== null ? (
              <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
                <ChangeChip changePct={model.returnPct} />
                <span className="text-xs text-text-3">출발 이후</span>
              </span>
            ) : null}
            {/* 변화 한 줄 — 서버의 dayChangePct와 그 기준(앞의 마지막 순자산 줄, 잠정 포함 — 바로 전 거래일이 아닐 수 있어 '하루'라 적지 않음).
                navSeries로 계산하지 않습니다. */}
            {model.day ? (
              <span className="inline-flex flex-wrap items-baseline gap-x-1.5 text-[13px] text-text-2">
                <span>{model.day.label}</span>
                <ChangeChip changePct={model.day.pct} size="sm" />
                {model.day.base ? <span className="text-text-3">· {model.day.base}</span> : null}
              </span>
            ) : null}
          </span>
        ) : undefined
      }
      meta={
        <>
          {/* 값의 기준(단계 표기)이 먼저 — 추정 배지가 그 뒤에 와 '추정 장중 추정'으로 겹쳐 읽히지 않게(계좌 행과 같은 순서). 문지르는 동안에는
              '지금 값 …'을 앞에 붙여, 그 점의 값(위 큰 숫자)이 '장중 추정 HH:MM'인 것처럼 읽히지 않게 합니다. 지금 값 글은 눈으로만 — 낭독기는
              Hero가 값 자리에 남긴 '지금 값 …'을 이미 읽습니다. */}
          {model.stageLabel || scrubbing ? (
            <span className="text-xs tabular-nums text-text-2">
              {scrubbing ? <span aria-hidden="true">{model.stageLabel ? `${model.nowText} · ` : model.nowText}</span> : null}
              {model.stageLabel}
            </span>
          ) : null}
          <EstimateBadge estimated={model.isEstimated} />
          <StaleBadge stale={model.isStale} reason={model.staleReason} />
          {model.warning ? (
            <span className="text-xs text-warn">
              <StatusText tone="warn" icon={<AlertTriangleIcon size={12} />}>{model.warning}</StatusText>
            </span>
          ) : null}
          <ProvenanceBadge source={model.source} />
          {model.note ? <span className="basis-full text-xs text-text-3">{scrubbing ? `지금 값: ${model.note}` : model.note}</span> : null}
        </>
      }
      tabs={
        ranges.length > 1 ? (
          <RangeTabs ranges={NAV_RANGES} allowed={ranges} value={range} onChange={onRange} label="순자산 곡선 기간" />
        ) : undefined
      }
      tabsPlacement="below"
      actions={
        <span className="flex flex-wrap items-center justify-end gap-2">
          {onPick && accounts.length > 1 ? (
            <NativeSelect
              value={model.code}
              onChange={(event) => onPick(event.target.value)}
              inputSize="sm"
              aria-label="순자산을 볼 계좌"
              wrapperClassName="inline-block max-w-full"
            >
              {accounts.map((account) => (
                <option key={account.code} value={account.code}>
                  {account.label}
                </option>
              ))}
            </NativeSelect>
          ) : null}
          {/* 실시간 주기(사용자 요청 2026-11-03) — 장중 카드·보유 표와 같은 값. 그 주기로 순자산이 실시간 시세로 다시 셈해집니다. */}
          <LiveIntervalSelect label="새로고침" />
        </span>
      }
      scrub={scrub}
    >
      <LineChart
        data={chart.rows}
        series={chart.series}
        variant="hero"
        nonNegative
        valueFormat={format}
        ariaLabel={`${model.name} 순자산 곡선`}
        onScrub={onScrub}
      />
    </Hero>
  );
}
