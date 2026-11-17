"use client";

import Link from "next/link";
import { useState } from "react";
import { HorizontalBars } from "@/components/charts";
import { LiveIntervalSelect } from "@/components/LiveIntervalSelect";
import {
  ChangeCell,
  type Column,
  DataTable,
  type InspectorContext,
  InspectorFrame,
  InspectorTrigger,
  KpiStrip,
  type PropertyItem,
  PropertyList,
} from "@/components/patterns";
import {
  Callout,
  ErrorState,
  Freshness,
  LINK_CLASSES,
  Loading,
  PageHeader,
  Panel,
  Select,
  SourceBadge,
} from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { useLivePrices } from "@/hooks/useLivePrices";
import { useLiveSeconds } from "@/hooks/useLiveSeconds";
import { stockHref } from "@/lib/detail";
import { formatNumber } from "@/lib/format";
import { liveKey, livePriceTitle, liveShown } from "@/lib/livePrices";
import { SECTOR_PERIODS, sectorKpis, sectorKpisPending, sectorRowTitle } from "@/lib/sectorScreen";
import type { LivePrice, SectorResponse, SectorRow } from "@/lib/types";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";
import { knownBars } from "@/lib/chartData";
import { sortDescUnknownLast } from "@/lib/transforms";

/**
 * 섹터 & 자산군 로테이션.
 *
 * 표본이 부족한 기간은 "—"로 표시합니다. 0.00%로 채우면 '보합'으로 읽혀
 * 신규 상장 ETF가 실제로 보합인 것처럼 보이고 순위까지 오염됩니다.
 *
 * 배치(작업대 화면 언어 — 명세 §7 3행 '가벼운 재배치'): 머리(실시간 주기·신선도) → KPI 띠(S&P 500 기간별 수익률 — 응답의 benchmarkReturns, 새 요청 없음)
 * → '섹터 모멘텀' 막대 → '섹터 상세'·'자산군 상세' 공용 표. 표의 이름 단추가 그 종목의 검사 대화상자(속성·종목 상세 링크)를 엽니다 — 열이 열 개라
 * 옆 검사 칸을 두면 표가 눌려 늘 대화상자입니다(검사 칸 틀 layout="dialog"). 검사는 받은 값만 보이고 새로 읽지 않습니다.
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

  // 현재가는 고른 주기마다 서버가 밀어 주는 실시간 시세(ADR 0024 — 저장하지 않는 표시 전용, 주기는 모의 매매 화면과 같은 설정).
  // 수익률·순위는 저장본(종가) 기준 그대로입니다.
  const [liveSeconds] = useLiveSeconds();
  const live = useLivePrices([...sectors, ...assets].map((row) => liveKey("US", row.ticker)), liveSeconds);

  // 값을 모르는 섹터는 막대에서 뺍니다(0으로 그리지 않음).
  const chartData = knownBars(
    sectors,
    (row) => row.name.split(" ")[0],
    (row) => (mode === "alpha" ? row.alpha?.[period] : row.returns?.[period]),
  ).bars.sort((a, b) => b.value - a.value);
  const valueName = mode === "alpha" ? `${period} 초과성과` : `${period} 수익률`;

  // 검사 대화상자 — 두 표의 종목을 함께 찾습니다(티커가 키). 자산군에는 α가 없습니다(S&P 500 대비 지표라 뜻이 없음).
  const allRows = [...sectors, ...assets];
  const sectorTickers = new Set(sectors.map((row) => row.ticker));
  // KPI 띠 — 처음 읽는 동안은 자리표시 타일(값이 온 뒤 띠가 끼어들어 아래가 밀리지 않게), 저장본이 없거나 읽지 못하면 두지 않습니다.
  const kpis = data ? (data.available ? sectorKpis(data, SOURCES.yahooEtf) : []) : loading && !error ? sectorKpisPending(SOURCES.yahooEtf) : [];

  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
      <PageHeader
        title="섹터 & 자산군 로테이션 맵"
        description={<>S&amp;P 11개 섹터 + 글로벌 자산군 모멘텀 · 벤치마크 {data?.benchmark ?? "SPY"}</>}
        actions={
          <>
            <LiveIntervalSelect label="현재가 실시간" />
            <Freshness
              collectedAt={data?.collectedAtKst}
              ageSeconds={data?.ageSeconds}
              stale={data?.stale}
              refreshError={refreshError}
            />
          </>
        }
      >
        {/* 머리 글 칸 — 늘 그리고(글이 없으면 높이 0) 글 폭과 상관없이 머리 줄 전체를 씁니다(w-screen max-w-full — 칸의 글 폭 기여가 화면 폭이라 제목
            묶음이 혼자 한 줄을 차지하고, 실제 폭은 그 줄 폭으로 줄어듦. 매크로 머리와 같은 배치 — QA-679). 그래서 동작 줄(현재가 실시간 주기·신선도)은 자료와
            안내에 상관없이 늘 제목 묶음 아래 따로 놓입니다. 예전에는 넓은 폭에서 동작 줄이 제목 옆에 놓였다가, 실시간 시세 안내가 붙어 제목 묶음이 줄 전체가
            되거나(메뉴 220의 1024·1280) 신선도 배지가 붙어 동작 줄이 넓어지면(1024의 메뉴 272·320) 동작 줄이 다음 줄로 꺾여 아래 전체가 32~68px
            밀렸습니다(첫 읽기 CLS 0.22~0.32). 대가로 넓은 폭의 머리가 약 32px(동작 줄 24 + 줄 간격 8) 높습니다. 안내가 붙으면 그 높이만큼 밀리는 것은
            그대로입니다(알려진 한계 — 글을 숨기거나 늘 빈 줄을 두지 않음). */}
        <div data-sector-header-lines className="w-screen max-w-full">
          {live.error && <p className="mt-1 text-xs text-text-3">실시간 시세: {live.error} — 현재가는 저장본 값입니다.</p>}
        </div>
      </PageHeader>

      {/* 선택 상자가 있는 첫 카드는 늘 그리고 본문만 로딩·오류로 바꿉니다 — 페이지 전체를 바꾸면 방금 조작한
          선택 상자가 사라지고 키보드 포커스를 잃었습니다(QA-047). */}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && (
        <Callout tone="warn">
          {data.message ?? "섹터 데이터가 없습니다. 수집기를 실행하세요."}
        </Callout>
      )}

      {/* 벤치마크 기간별 수익률 — α(초과성과)를 읽는 기준. */}
      {/* 읽는 중 타일은 값이 온 뒤의 꼴(값 줄 높이·첫 타일 출처 줄)로 — 값이 와도 아래 패널이 밀리지 않게. */}
      {kpis.length > 0 ? <KpiStrip label={`S&P 500 (${data?.benchmark ?? "SPY"}) 기간별 수익률`} items={kpis} pendingMatchesValue /> : null}

      <Panel
        title="섹터 모멘텀" source={SOURCES.yahooEtf}
        actions={
          <div className="flex flex-wrap items-end gap-3">
            <Select
              label="조회 기간"
              value={period}
              onChange={setPeriod}
              options={(data?.periods ?? [...SECTOR_PERIODS]).map((value) => ({
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
            valueName={valueName}
            ariaLabel={`섹터 ${valueName}`}
            height={Math.max(260, chartData.length * 28)}
          />
        )}
      </Panel>

      {data && (
        <InspectorFrame
          label="종목 상세"
          layout="dialog"
          titleOf={(ticker) => sectorRowTitle(allRows, ticker)}
          renderDetail={(ticker) => {
            const row = allRows.find((entry) => entry.ticker === ticker);
            return row ? (
              <SectorInspector row={row} period={period} showAlpha={sectorTickers.has(row.ticker)} realtime={live.prices[liveKey("US", row.ticker)]} />
            ) : null;
          }}
        >
          {(inspector) => (
            <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
              <Panel
                // 개수는 저장본이 있을 때만 — 없으면(available=false — 빈 목록) 모르는 수라 '0개'로 적지 않습니다(QA-668).
                title="섹터 상세" source={SOURCES.yahooEtf} count={data.available ? `${sectors.length.toLocaleString("ko-KR")}개` : undefined}
                subtitle={`표본이 부족한 기간은 —로 표시합니다. 순위는 위에서 고른 ${period} 기준입니다. 현재가는 실시간 시세(아래 줄은 오늘 등락), 수익률은 저장본입니다. 이름을 누르면 그 종목의 값을 모아 봅니다.`}
              >
                <ReturnsTable caption="섹터 상세" rows={sectors} period={period} kindLabel="유형" realtime={live.prices} inspector={inspector} />
              </Panel>

              <Panel
                title="자산군 상세" source={SOURCES.yahooEtf} count={data.available ? `${assets.length.toLocaleString("ko-KR")}개` : undefined}
                subtitle="주식·채권·원자재·통화 전반의 상대 성과"
              >
                {/* 초과성과(α)는 S&P 500 대비 지표라 자산군에는 의미가 없습니다.
                    전부 "—"인 열을 남겨 두면 "계산이 실패했나?"로 읽힙니다. */}
                <ReturnsTable
                  caption="자산군 상세" rows={assets} period={period} kindLabel="자산군" showAlpha={false} realtime={live.prices} inspector={inspector}
                />
              </Panel>
            </div>
          )}
        </InspectorFrame>
      )}
    </div>
  );
}

function ReturnsTable({
  caption,
  rows,
  period,
  kindLabel,
  showAlpha = true,
  realtime = {},
  inspector,
}: {
  caption: string;
  rows: SectorRow[];
  period: string;
  kindLabel: string;
  showAlpha?: boolean;
  /** 'US:XLK' → 실시간 가격(없으면 저장본 현재가) */
  realtime?: Readonly<Record<string, LivePrice>>;
  inspector: InspectorContext;
}) {
  const sorted = sortDescUnknownLast(rows, (row) => row.returns?.[period]);

  const columns: Column<SectorRow>[] = [
    { key: "rank", header: "순위", cell: (row) => row.ranks?.[period] ?? null },
    {
      key: "name",
      header: "이름",
      rowHeader: true,
      className: "break-keep",
      // 이름은 검사 대화상자를 여는 줄 단추(중립 잉크 — 데이터 칸이라 강조 파랑이 아님, lg 미만 44px), 아래 줄은 티커와 유형(자산군) 배지, 그 아래 이전 값 표시.
      // 유형을 따로 열(88px)로 두면 열한 칸 표의 최소 폭이 1280 기본 메뉴의 상자보다 넓어 'α' 열이 잘렸습니다(QA-678) — 배지를 티커 옆으로 모으고(칸이 좁으면
      // 티커 아래로 꺾임), 열 머리가 하던 '유형'·'자산군' 이름은 배지 안의 읽기 전용 글로 둡니다.
      cell: (row) => (
        <span className="flex min-w-0 flex-col items-start">
          <InspectorTrigger inspector={inspector} itemKey={row.ticker}>
            {row.name}
          </InspectorTrigger>
          <span className="flex flex-wrap items-center gap-1">
            <span className="text-xs text-text-3">{row.ticker}</span>
            <SourceBadge>
              <span className="sr-only">{kindLabel} </span>
              {row.kind}
            </SourceBadge>
          </span>
          {row.isStale && (
            <span className="text-xs" title={row.staleReason ?? undefined}>
              <StatusText tone="warn" iconSize={12}>이전 값(수집 실패)</StatusText>
            </span>
          )}
        </span>
      ),
    },
    {
      key: "price",
      header: "현재가",
      align: "right",
      cell: (row) => <PriceCell stored={row.price} realtime={realtime[liveKey("US", row.ticker)]} />,
    },
    // 순위를 매긴 기간 열을 밝게 둡니다. 어떤 기준으로 1위가 됐는지
    // 표 안에서 바로 보이지 않으면 위쪽 선택값을 기억해야 합니다. 표지 '▪'는 장식이라 읽기에서 빼고 뜻을 글로 읽힙니다('1M (순위 기준)' — 고대비에서
    // 바탕이 지워져도 기호와 글이 남음, QA-649).
    ...SECTOR_PERIODS.map((window) => ({
      key: window,
      header:
        window === period ? (
          <>
            {window} <span aria-hidden="true">▪</span>
            <span className="sr-only">(순위 기준)</span>
          </>
        ) : (
          window
        ),
      align: "right" as const,
      className: window === period ? "bg-surface-2/50" : undefined,
      cell: (row: SectorRow) => <ChangeCell changePct={row.returns?.[window]} />,
    })),
    ...(showAlpha
      ? [
          {
            key: "alpha",
            header: `α (${period})`,
            align: "right" as const,
            cell: (row: SectorRow) => <ChangeCell change={row.alpha?.[period]} unit="%p" />,
          },
        ]
      : []),
  ];

  return (
    <DataTable
      caption={caption}
      columns={columns}
      rows={sorted}
      rowKey={(row) => row.ticker}
      emptyText="수집된 종목이 없습니다."
      scrollHint="overflow"
    />
  );
}

/**
 * 현재가 칸 — 실시간 값이 있으면 그 가격과 오늘 등락(시간 외면 그 이름), 설명에 출처·거래 시각. 없으면 저장본 현재가.
 * 오늘 등락 줄은 꺾일 수 있는 줄입니다 — 칸이 좁으면 시간 외 이름('· 애프터장' 한 덩어리)이 칩 다음 줄로 내려가고, 칩은 칸 안에서 꺾지 않습니다(공용 ChangeCell).
 * 한 줄로 묶어 두면 실시간이 올 때 현재가 칸이 91~148px로 넓어져 섹터 표가 1280 기본 메뉴의 상자를 넘었습니다(QA-678 — 합성 응답으로 잰 추정).
 */
function PriceCell({ stored, realtime }: { stored: number | null; realtime?: LivePrice }) {
  if (!realtime) return <>{formatNumber(stored, 2)}</>;
  const shown = liveShown(realtime);
  return (
    <span className="flex flex-col items-end" title={livePriceTitle(realtime, (value) => formatNumber(value, 2))}>
      <span>{formatNumber(shown.price, 2)}</span>
      <span className="flex flex-wrap items-baseline justify-end gap-x-1 text-xs text-text-3">
        <ChangeCell changePct={shown.changePct} />
        {shown.session ? <span className="whitespace-nowrap">· {shown.session}</span> : null}
      </span>
    </span>
  );
}

/**
 * 검사 대화상자 내용 — 티커·유형·현재가(실시간이면 출처·기준 시각·오늘 등락, 아니면 저장본)·기간별 수익률·α(섹터만)·순위(고른 기간)와 이전 값 사유,
 * 그 종목의 상세 화면 링크. 받은 값만 보입니다(새로 읽지 않음). 수익률이 이어받은 값(isStale)이면 수익률 줄마다 '이전 값' 배지와 사유.
 */
function SectorInspector({
  row,
  period,
  showAlpha,
  realtime,
}: {
  row: SectorRow;
  period: string;
  showAlpha: boolean;
  realtime?: LivePrice;
}) {
  const shown = realtime ? liveShown(realtime) : null;
  const chip = (value: number | null | undefined, unit?: string) =>
    // 모르는 값은 null — 속성 목록이 '—'와 사유('표본 부족')를 그립니다. 아는 값은 표 칸과 같은 변화 칩(공용 ChangeCell — ▲▼·부호 −·읽는 방향 글, QA-628).
    value === null || value === undefined || Number.isNaN(value) ? null : unit ? <ChangeCell change={value} unit={unit} /> : <ChangeCell changePct={value} />;
  const items: PropertyItem[] = [
    { label: "티커", value: row.ticker, mono: true },
    { label: "유형", value: row.kind },
    // 수집 실패로 직전 저장본에서 이어받은 행 — 수익률·순위가 그만큼 멈춰 있다는 것을 사유와 함께 한 줄로(표의 '이전 값(수집 실패)'과 같은 뜻).
    ...(row.isStale ? [{ label: "수집", value: "직전 저장본에서 이어받은 값", isStale: true, staleReason: row.staleReason ?? null }] : []),
    {
      label: "현재가",
      value: shown ? formatNumber(shown.price, 2) : formatNumber(row.price, 2),
      note: realtime ? livePriceTitle(realtime, (value) => formatNumber(value, 2)) : "저장본 값(실시간 시세 없음)",
    },
    ...(shown ? [{ label: "오늘 등락", value: chip(shown.changePct), note: shown.session ?? undefined }] : []),
    ...SECTOR_PERIODS.map((window) => ({ key: `return-${window}`, label: `${window} 수익률`, value: chip(row.returns?.[window]), emptyReason: "표본 부족" })),
    ...(showAlpha ? [{ label: `α (${period}) — S&P 500 대비`, value: chip(row.alpha?.[period], "%p"), emptyReason: "표본 부족" }] : []),
    { label: `순위 (${period})`, value: row.ranks?.[period] ?? null, format: (rank) => `${formatNumber(rank, 0)}위` },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <PropertyList items={items} source={SOURCES.yahooEtf} />
      <p>
        <Link href={stockHref("us", row.ticker)} className={LINK_CLASSES}>
          종목 상세 열기
        </Link>
      </p>
    </div>
  );
}
