"use client";

import { useState } from "react";
import { type Column, DataTable } from "@/components/patterns";
import { Callout, ErrorState, Freshness, Loading, Panel, Select } from "@/components/ui";
import { LockIcon } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { useRemembered } from "@/hooks/useRemembered";
import { endpoints } from "@/lib/endpoints";
import { EMPTY } from "@/lib/format";
import { trackRecordRow } from "@/lib/regime";
import { SOURCES } from "@/lib/sources";
import type { TrackRecordResponse } from "@/lib/types";
import { RegimeTag } from "./RegimeTag";

const VIEWS = [
  { value: "start", label: "국면이 시작된 주에 들어갔다면" },
  { value: "all", label: "그 국면에 머문 모든 주" },
] as const;

/** 첫 응답 전의 자산 선택지. */
const DEFAULT_ASSETS = [{ ticker: "SPY", label: "S&P 500 (SPY)" }];

type TrackRow = ReturnType<typeof trackRecordRow>;

/**
 * 국면별 성과 표의 열(공용 표 — 행 32px·낱말 사이 줄바꿈). 표본이 부족한 줄의 '표본 부족'과 비교 기준(아무 때나)은 보조 글색입니다.
 * 일곱 칸이라 좁은 칸(가운데 칸 448~560px)에서는 표가 넘쳐 좌우로 넘깁니다(넘치면 안내). 짧은 글 열(기간 '13주 뒤'·표본 '42건 · 독립 4')도 숫자 열처럼
 * 줄을 바꾸지 않습니다 — 최소 폭 표에서 이 두 열만 눌려 '13주 / 뒤'·'42건 · / 독립 4'로 꺾였습니다(자기 빌드 1440).
 */
const COLUMNS: readonly Column<TrackRow>[] = [
  { key: "horizon", header: "기간", cell: (row) => row.horizon, className: "whitespace-nowrap" },
  { key: "samples", header: "표본", cell: (row) => row.samples, className: "whitespace-nowrap" },
  {
    key: "mean",
    header: "평균",
    align: "right",
    cell: (row) => <span className={row.sufficient ? "" : "text-text-3"}>{row.mean}</span>,
  },
  { key: "median", header: "중앙값", align: "right", cell: (row) => row.median },
  { key: "winRate", header: "상승 비율", align: "right", cell: (row) => row.winRate },
  { key: "excess", header: "기준 대비(평균)", align: "right", cell: (row) => row.excess },
  {
    key: "baseline",
    header: "비교: 아무 때나",
    align: "right",
    cell: (row) => <span className="text-text-3">{row.baseline}</span>,
  },
];

/**
 * 판정 성과 — 판정을 과거에 그대로 적용했을 때 그 뒤 수익률.
 *
 * COT 백테스트와 같은 읽는 법(표본·평균·중앙값·상승 비율·"아무 때나")에 두 가지를 더합니다:
 * 겹치지 않는 표본 수와 표본 부족 표시. 한계 문구는 고정이며 늘 보입니다(명세 §2-5).
 */
export function TrackRecordSection() {
  const [asset, setAsset] = useState("SPY");
  const [view, setView] = useState<"start" | "all">("start");
  const { data, loading, error, reload, refreshError } = useApi<TrackRecordResponse>(
    endpoints.insight.regimeTrackRecord(asset),
    600_000,
  );

  // 선택지는 마지막으로 받은 목록을 이어 씁니다. 자산을 바꾸면 useApi가 새 응답이 올 때까지 data를 비우는데, 그동안
  // 선택지가 SPY 하나로 줄어 선택 상자가 고른 자산과 어긋났고, 그 읽기가 실패하면 SPY로 돌아갈 수 없었습니다(QA-101).
  const assets = useRemembered(data?.assets) ?? DEFAULT_ASSETS;
  const regimes = (view === "start" ? data?.start : data?.all) ?? [];
  const baseline = data?.baseline ?? [];

  return (
    <Panel
      title="판정 성과"
      source={SOURCES.regimeTrackRecord}
      subtitle={
        data?.available
          ? `${data.assetLabel} · 판정 ${data.evaluatedFrom ?? EMPTY} ~ ${data.evaluatedTo ?? EMPTY} (매주 목요일 ${data.knownWeeks ?? 0}주 판정)`
          : "판정을 과거에 그대로 적용했을 때 그 뒤 수익률"
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {/* 자동 갱신이 실패하면 앞서 받은 값을 그대로 보이므로 '새로 읽지 못함'을 붙입니다(QA-104, QA-067과 같음). */}
          <Freshness refreshError={refreshError} />
          <Select
            label="자산"
            value={asset}
            onChange={setAsset}
            options={assets.map((a) => ({
              value: a.ticker,
              label: a.label,
            }))}
          />
          <Select
            label="관점"
            value={view}
            onChange={(value) => setView(value as "start" | "all")}
            options={VIEWS.map((v) => ({ value: v.value, label: v.label }))}
          />
        </div>
      }
    >
      {loading && !data && <Loading label="판정 성과를 계산하는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && (
        // 유료 등급에서만 보이는 기능이면 안내 톤 + 잠금 아이콘(이름 있는 그림 — 잠금이라는 뜻을 아이콘이 나름)
        <Callout
          tone={data.locked ? "info" : "warn"}
          icon={data.locked ? <LockIcon size={16} label="유료 등급 기능" /> : undefined}
        >
          {data.message}
        </Callout>
      )}
      {data?.available && (
        <>
          <Callout tone="info">
            {data.rule} 표본이 {data.minSamples}건 미만이거나 겹치지 않는 표본이 {data.minIndependent}개 미만이면
            수익률을 내지 않고 <strong>표본 부족</strong>으로 둡니다.
          </Callout>
          <div className="mt-4 flex flex-col gap-4">
            {regimes.map((regime) => (
              // 국면별 상자 — 안쪽 12px(lg 16px, 명세 §3-7 패널 안쪽과 같음 — P2 남은 어긋남). 머리는 국면 태그(톤 + 아이콘 + 이름)를 담은 h3.
              <div key={regime.code} className="rounded-control border border-border bg-surface p-3 lg:p-4">
                <h3 className="text-sm font-semibold text-text">
                  <RegimeTag code={regime.code} label={regime.label} />
                </h3>
                <p className="mt-1 text-xs text-text-3">
                  {view === "start"
                    ? `시작 ${regime.weeks}번`
                    : `${regime.weeks}주 · ${regime.episodes}개 구간`}
                </p>
                <div className="mt-3">
                  <DataTable
                    caption={`${regime.label} — 판정 뒤 수익률`}
                    rows={regime.cells.map((cell, index) => trackRecordRow(cell, baseline[index]))}
                    rowKey={(row) => `${regime.code}-${row.horizon}`}
                    columns={COLUMNS}
                    scrollHint="overflow"
                  />
                </div>
              </div>
            ))}
          </div>
          <ul className="mt-4 list-disc space-y-1 pl-5 text-xs text-text-3">
            {data.limits.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-text-3">
            가격 {data.priceFrom} ~ {data.priceTo}. 아직 기간이 끝나지 않은 최근 판정은 표본에서 빠집니다.
          </p>
        </>
      )}
    </Panel>
  );
}
