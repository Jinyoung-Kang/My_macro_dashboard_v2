"use client";

import { useMemo } from "react";
import {
  AutoRefreshControl,
  LIVE_THRESHOLD_SECONDS,
  useAutoRefreshSeconds,
} from "@/components/AutoRefresh";
import { RawSnapshotCard } from "@/components/RawSnapshotCard";
import { SessionBadge, useKrOfficialHolidays, useMinuteClock } from "@/components/SessionBadge";
import {
  Banner,
  Card,
  ErrorState,
  Freshness,
  Loading,
  Metric,
  PageHeader,
  SourceBadge,
  Table,
} from "@/components/ui";
import { AlertTriangleIcon, StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { useLivePrices } from "@/hooks/useLivePrices";
import { SOURCES, uniqueSources } from "@/lib/sources";
import { EMPTY, formatKst, withoutLeadingIcon } from "@/lib/format";
import { cardNotices, categoryDelay } from "@/lib/macroCards";
import { macroLiveItem, macroLiveItems, withLive, type MacroCardView } from "@/lib/macroLive";
import type {
  AdvancedIndicators,
  MacroItem,
  MacroOverview,
  RiskIndicators,
} from "@/lib/types";
import { FxCompareSection } from "./FxCompareSection";
import { SpreadSection } from "./SpreadSection";
import { RiskSection } from "./RiskSection";
import { AdvancedSection } from "./AdvancedSection";
import { SingleChartSection } from "./SingleChartSection";
import { ScrapedSection } from "./ScrapedSection";
import { endpoints } from "@/lib/endpoints";

/** warn이면 그 상태를 경고 아이콘과 함께 그립니다(글에는 기호를 넣지 않음). */
const SPREAD_TABLE: { state: string; warn?: boolean; value: string; reading: string; outcome: string }[] = [
  {
    state: "정상 (Normal)",
    value: "양수 (+)",
    reading: "장기 미래의 불확실성(프리미엄)으로 장기 금리가 더 높습니다.",
    outcome: "경제의 점진적인 성장 및 확장",
  },
  {
    state: "평탄화 (Flattening)",
    value: "0에 수렴",
    reading: "미래 경기 성장이 둔화될 것이라는 우려가 커지기 시작합니다.",
    outcome: "경기 정점 통과 및 둔화 신호",
  },
  {
    state: "역전 (Inversion)",
    warn: true,
    value: "음수 (−)",
    reading: "현재 인플레이션을 잡기 위해 금리를 올렸으나 미래 경기 침체를 확신합니다.",
    outcome: "역사적으로 1~2년 내 경기 침체 도래",
  },
];

export default function MacroPage() {
  const [refreshSeconds, setRefreshSeconds] = useAutoRefreshSeconds();
  const refreshMs = refreshSeconds * 1000;

  // 1분 이하를 고르면 백엔드에 live로 요청합니다. 저장본을 다시 받을 기준이
  // 15분에서 60초로 내려가, 카드 숫자가 실제로 움직입니다.
  // (60초보다 더 줄이지 않는 이유 — Yahoo 429. Datasets.MAX_AGE_LIVE 참고)
  const live = refreshSeconds > 0 && refreshSeconds <= LIVE_THRESHOLD_SECONDS;

  // 카드 시세만 빠르게 읽습니다.
  //
  // 리스크 지표는 일별 확정치(FRED·변동성 저장본)이고 심화 지표 6종은 대부분
  // 주·월 단위로 갱신됩니다. 10초마다 다시 읽어 봐야 같은 값이라, 기존 주기
  // (2분·5분)보다 빨라지지 않게 막아 둡니다. 느리게 고르는 것은 그대로 따릅니다.
  const slower = (floorMs: number) =>
    refreshMs === 0 ? 0 : Math.max(refreshMs, floorMs);

  const overview = useApi<MacroOverview>(
    endpoints.macro.overview(live),
    refreshMs,
  );
  const risk = useApi<RiskIndicators>(endpoints.macro.risk, slower(120_000));
  const advanced = useApi<AdvancedIndicators>(endpoints.macro.advanced, slower(300_000));
  // 개장/마감 배지는 보는 시각 기준이라 1분마다 다시 판정합니다(데이터는 다시 받지 않음).
  const now = useMinuteClock();
  const krOfficial = useKrOfficialHolidays(now);


  const data = overview.data;

  // 카드 값은 고른 간격마다 서버가 밀어 주는 실시간 시세로 덮습니다(ADR 0024 — 저장하지 않는 표시 전용, 끄기면 화면을 열 때 한 번).
  // 저장본(위 overview)은 그대로 읽어 카드의 틀·전일값 출처·실시간이 없는 카드에 씁니다.
  const liveItems = useMemo(() => macroLiveItems(data?.categories), [data?.categories]);
  const livePrices = useLivePrices(liveItems, refreshSeconds);
  const categories = useMemo(
    () => data?.categories?.map((category) => ({
      ...category,
      items: category.items.map((item): MacroCardView => {
        const code = macroLiveItem(item);
        return code ? withLive(item, livePrices.prices[code], livePrices.receivedAt) : item;
      }),
    })),
    [data?.categories, livePrices.prices, livePrices.receivedAt],
  );

  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      <PageHeader
        title="거시경제 매크로 지표"
        description="환율·국채·원자재·지수, 장단기 금리차, 신용 리스크, 심화 지표 6종"
        actions={
          <>
            <AutoRefreshControl
              seconds={refreshSeconds}
              onChange={setRefreshSeconds}
              loadedAt={overview.loadedAt}
              loading={overview.loading}
            />
            <Freshness
              collectedAt={data?.collectedAtKst}
              ageSeconds={data?.ageSeconds}
              stale={data?.stale}
              refreshError={overview.refreshError}
            />
          </>
        }
      >
        {/* 고른 간격보다 값이 늦게 바뀌는 이유를 화면에서 바로 알 수 있게 적습니다.
            적지 않으면 "10초로 해 뒀는데 숫자가 그대로"로 읽힙니다. */}
        {refreshSeconds > 0 && (
          <p className="mt-1 text-xs text-muted">
            카드 시세는 고른 간격마다 서버가 바로 받아 밀어 줍니다(TradingView·네이버, 저장하지 않음). 출처가 지연 시세인
            카드(선물·상하이)는 배지에 그 지연을 적습니다.
          </p>
        )}
        {livePrices.error && (
          <p className="mt-1 text-xs text-muted">실시간 시세: {livePrices.error} — 카드는 저장본 값입니다.</p>
        )}
      </PageHeader>

      {/* 자동 갱신 간격(머리말)은 늘 그리고 본문만 로딩·오류로 바꿉니다 — 1분 경계를 넘으면 경로(live)가 바뀌어
          페이지 전체가 로딩으로 바뀌고 방금 조작한 선택 상자가 사라졌습니다(QA-047). */}
      {/* 상단에 둡니다 — 화면을 스크롤하며 눈으로 옮겨 적지 않아도 되도록,
          "지금 이 대시보드가 들고 있는 값 전부"를 먼저 꺼낼 수 있게 합니다. */}
      <RawSnapshotCard />

      {overview.loading && !data && <Loading label="매크로 지표를 불러오는 중…" />}
      {overview.error && <ErrorState message={overview.error} onRetry={overview.reload} />}
      {data && (
        <>
        {!data?.available && (
          <Banner tone="warn">
            {data?.message ?? "매크로 데이터가 없습니다. 수집기를 실행하세요."}
          </Banner>
        )}

        {categories?.map((category) => (
          <Card
            key={category.id}
            title={category.title}
            subtitle={categoryDelay(category)}
            source={uniqueSources(category.items.map((item) => itemSource(item))) || undefined}
          >
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {category.items.map((item) => (
                <Metric
                  key={item.key}
                  label={
                    // 이름과 배지를 한 줄에 두면 이름이 긴 카드(엔/원 100엔당)만 배지가
                    // 다음 줄로 밀려, 같은 줄 카드끼리 값의 높이가 어긋났습니다.
                    // 모든 카드를 "이름 줄 + 배지 줄"로 같은 구조로 둡니다.
                    <span className="flex flex-col gap-1">
                      <span>{item.name}</span>
                      <span className="flex min-h-5 flex-wrap items-center gap-1">
                        {/* 개장 상태와 시세 지연은 배지 하나("개장 · 10분 지연")로, 지연이 아닌 알림만 따로 둡니다.
                            예전 저장본(delayMinutes 없음)은 예전처럼 note 배지를 씁니다. */}
                        {item.delayMinutes === undefined && item.note && <SourceBadge>{withoutLeadingIcon(item.note)}</SourceBadge>}
                        <SessionBadge
                          market={item.market}
                          now={now}
                          krOfficial={krOfficial}
                          lastTs={item.lastTs}
                          collectedAt={data?.collectedAtKst}
                          delayMinutes={item.delayMinutes}
                          stale={item.isStale}
                        />
                        {item.delayMinutes !== undefined && cardNotices(item).map((notice) => (
                          <NoticeBadge key={notice.text} title={notice.title} tone={notice.tone}>{notice.text}</NoticeBadge>
                        ))}
                      </span>
                    </span>
                  }
                  value={item.status === "fail" ? "수집 실패" : item.priceStr ?? EMPTY}
                  delta={item.delta}
                  deltaText={item.deltaStr ?? EMPTY}
                  tone={item.status === "fail" ? "text-muted" : undefined}
                  source={itemSource(item)}
                  caption={
                    <span className="flex flex-col gap-0.5">
                      <span>전일: {item.prevStr ?? EMPTY}</span>
                      {item.live ? (
                        <span>
                          실시간 {item.live.at} {item.live.received ? "수신" : "거래"}
                          {item.live.session ? ` · ${item.live.session}` : ""}
                        </span>
                      ) : item.lastTs && <span>{formatKst(item.lastTs)}</span>}
                      {item.prevSource && <span>전일값 출처: {item.prevSource}</span>}
                    </span>
                  }
                />
              ))}
            </div>
          </Card>
        ))}
        </>
      )}

      {/* 스스로 데이터를 읽는 섹션은 개요(overview)를 다시 읽는 동안에도 그대로 둡니다 — `data &&` 안에 두면
          간격이 1분 경계를 넘을 때 함께 내려가 고른 계열·지표가 처음으로 돌아갔습니다(QA-066).
          환율 카드 바로 아래에 둡니다 — 위에서 "지금 얼마인지"를 보고, 여기서 "어디서 왔는지"를 봅니다. */}
      <FxCompareSection />

      {data?.spreads && (
        <>
          <SpreadSection
            title="10Y−2Y 장단기 금리차"
            block={data.spreads.official10y2y}
          />
          <SpreadSection
            title="30Y−2Y 장단기 금리차"
            block={data.spreads.official30y2y}
          />
          <Card
            title="장단기 금리차 해석 기준"
            subtitle="역사적 분포에 근거한 참고치이며 투자 판단의 근거가 아닙니다."
            source={SOURCES.internalRules}
          >
            <Table
              rows={SPREAD_TABLE}
              rowKey={(row) => row.state}
              columns={[
                {
                  key: "state",
                  header: "시장 상태",
                  render: (row) => (row.warn ? <StatusText tone="warn">{row.state}</StatusText> : row.state),
                },
                { key: "value", header: "스프레드", render: (row) => row.value },
                { key: "reading", header: "시장의 심리 및 해석", render: (row) => row.reading },
                { key: "outcome", header: "경제적 귀결", render: (row) => row.outcome },
              ]}
            />
          </Card>
        </>
      )}

      <RiskSection risk={risk.data} loading={risk.loading} refreshError={risk.refreshError} />
      <AdvancedSection
        data={advanced.data}
        loading={advanced.loading}
        error={advanced.error}
        onRetry={advanced.reload}
        refreshError={advanced.refreshError}
      />
      <SingleChartSection />
      <ScrapedSection />
    </div>
  );
}

/**
 * 카드 한 장의 출처. 수집기가 붙인 값이 우선이고, 예전 저장본(출처 필드 없음)은 티커로 채웁니다.
 * 비공식 참고 시세(TradingView)는 출처 줄에 그 성격을 적습니다 — 예전에는 지연 배지에 섞여 있었습니다.
 */
function itemSource(item: MacroItem): string | undefined {
  const source = item.source ?? (item.ticker ? `Yahoo Finance (${item.ticker})` : undefined);
  return source && item.isReference ? `${source} · 참고 시세` : source;
}

/** 지연이 아닌 알림 배지 — 이 화면의 빨강·파랑은 상승·하락 전용이라 경고는 노랑입니다. */
function NoticeBadge({ children, title, tone }: { children: string; title?: string; tone?: "warn" }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-warn/40 bg-warn-tint px-2 py-0.5 text-xs text-warn" title={title}>
      {tone === "warn" ? (
        <>
          <AlertTriangleIcon size={12} />
          <span className="sr-only">주의: </span>
        </>
      ) : null}
      {children}
    </span>
  );
}
