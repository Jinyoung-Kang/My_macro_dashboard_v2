"use client";

import { useMemo } from "react";
import {
  AutoRefreshControl,
  LIVE_THRESHOLD_SECONDS,
  useAutoRefreshSeconds,
} from "@/components/AutoRefresh";
import { type Column, DataTable, SectionAnchor, SectionIndex } from "@/components/patterns";
import { RawSnapshotActions } from "@/components/RawSnapshotCard";
import { EmptyState, Freshness, Loading, PageHeader, Panel } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { useKrOfficialHolidays } from "@/hooks/useKrOfficialHolidays";
import { useLivePrices } from "@/hooks/useLivePrices";
import { useMinuteClock } from "@/hooks/useMinuteClock";
import { useSessionUser } from "@/hooks/useSessionUser";
import { isOwner } from "@/lib/access";
import { SOURCES } from "@/lib/sources";
import { macroCardView, macroLiveItems, macroLiveNotice } from "@/lib/macroLive";
import { macroIndexItems, macroIndicatorGroups } from "@/lib/macroScreen";
import { MACRO_SECTIONS } from "@/lib/marketSections";
import type {
  AdvancedIndicators,
  MacroOverview,
  RiskIndicators,
} from "@/lib/types";
import { FxCompareSection } from "./FxCompareSection";
import { IndicatorsSection } from "./IndicatorsSection";
import { SpreadSection } from "./SpreadSection";
import { RiskSection } from "./RiskSection";
import { AdvancedSection } from "./AdvancedSection";
import { SingleChartSection } from "./SingleChartSection";
import { ScrapedSection } from "./ScrapedSection";
import { EconCalendarSection } from "./EconCalendarSection";
import { CriteriaDetails } from "./CriteriaDetails";
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

/** 해석 기준표의 칸 — 시장 상태(행 머리, 역전은 경고 상태 글)·스프레드·해석·귀결. */
const SPREAD_COLUMNS: readonly Column<(typeof SPREAD_TABLE)[number]>[] = [
  {
    key: "state",
    header: "시장 상태",
    rowHeader: true,
    cell: (row) => (row.warn ? <StatusText tone="warn">{row.state}</StatusText> : row.state),
  },
  { key: "value", header: "스프레드", cell: (row) => row.value },
  { key: "reading", header: "시장의 심리 및 해석", cell: (row) => row.reading },
  { key: "outcome", header: "경제적 귀결", cell: (row) => row.outcome },
];

export default function MacroPage() {
  // 운영자 전용 카드(경제 캘린더)를 그릴지 — 사용자를 아직 모르면(세션 응답 전) 그리지 않습니다.
  const owner = isOwner(useSessionUser());
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
  // 저장본(위 overview)은 그대로 읽어 카드의 틀·전일값 출처·실시간이 없는 카드와, 마지막 응답에서 빠진 종목·닫힌 연결의 카드에 씁니다(QA-184).
  const liveItems = useMemo(() => macroLiveItems(data?.categories), [data?.categories]);
  const livePrices = useLivePrices(liveItems, refreshSeconds);
  const categories = useMemo(
    () => data?.categories?.map((category) => ({
      ...category,
      items: category.items.map((item) => macroCardView(item, livePrices)),
    })),
    [data?.categories, livePrices],
  );
  // 일부만 받았어도 출처별 사유를 적습니다(QA-184) — 연결·응답 문제(error)가 있으면 그것을 먼저.
  const liveNotice = macroLiveNotice(livePrices.error ?? livePrices.sourceError, categories);
  // 지표 표의 줄 — 홈 시장 표와 같은 규칙에 미리보기 칸을 덧붙인 것(lib/macroScreen). 장 상태는 보는 시각(1분마다)·공휴일·저장본 수집 시각으로.
  const groups = useMemo(
    () => (categories ? macroIndicatorGroups(categories, { now, krOfficial, collectedAt: data?.collectedAtKst ?? null }) : null),
    [categories, now, krOfficial, data?.collectedAtKst],
  );
  // 목차 — 회원 일곱·운영자 여덟(경제 캘린더), 지표 칸의 하위 칸은 범주(개수는 카드 수 — 개요를 받기 전에는 모름, 처음 읽는 동안은 자리 줄).
  const indexLoading = overview.loading && !data;
  const indexItems = useMemo(() => macroIndexItems(groups, owner, indexLoading), [groups, owner, indexLoading]);

  return (
    <div className="flex flex-col gap-4 lg:gap-6">
      <PageHeader
        title="거시경제 매크로 지표"
        description="환율·국채·원자재·지수, 장단기 금리차, 신용 리스크, 심화 지표 6종"
        actions={
          <>
            {/* 머리 동작 — "지금 이 대시보드가 들고 있는 값 전부"를 스크롤 없이 먼저 꺼낼 수 있게 화면 머리에 둡니다(보기는 대화상자, 복사는 바로).
                맨 앞에 둡니다 — 뒤의 갱신 시각·신선도 글은 자료가 온 뒤에 생기거나 폭이 바뀌어, 그 뒤에 두면 두 단추가 옆·아래로 밀렸습니다(P5a 검토 CLS). */}
            <RawSnapshotActions />
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
          <p className="mt-1 text-xs text-text-3">
            지표 시세는 고른 간격마다 서버가 바로 받아 밀어 줍니다(TradingView·네이버, 저장하지 않음). 출처가 지연 시세인
            지표(선물·상하이)는 기준 칸(좁은 화면은 지표 미리보기)에 그 지연을 적습니다.
          </p>
        )}
        {liveNotice && <p className="mt-1 text-xs text-text-3">{liveNotice}</p>}
      </PageHeader>

      {/* 목차(2xl 이상 왼쪽 13rem 세로 목록, 그 아래 본문 위 가로 줄)와 절 닻. 1280~1535에서도 목차 칸을 두면 지표 패널이 좁아 미리보기가 옆 칸이 되지
          못했습니다(메뉴 220에서 1280·1366은 대화상자 — 2026-11-17 결정 7, 사용자 위임 — 권장안 가). 1024는 목차 칸을 두면 표·차트가 눌립니다.
          닻은 자료와 상관없이 늘 그립니다(해시 주소의 이동이 첫 그림에서 닿게). 절 id는 lib/marketSections(다른 화면이 매크로 절로 잇는 정본). */}
      <SectionIndex label="매크로 지표 목차" items={indexItems} columnFrom="2xl">
        {/* 자동 갱신 간격(머리말)은 늘 그리고 본문만 로딩·오류로 바꿉니다 — 1분 경계를 넘으면 경로(live)가 바뀌어
            페이지 전체가 로딩으로 바뀌고 방금 조작한 선택 상자가 사라졌습니다(QA-047). */}
        <SectionAnchor id={MACRO_SECTIONS.indicators} columnFrom="2xl">
          <IndicatorsSection
            groups={groups}
            loading={overview.loading}
            error={overview.error}
            onRetry={overview.reload}
            unavailableMessage={data && !data.available ? (data.message ?? "매크로 데이터가 없습니다. 수집기를 실행하세요.") : null}
          />
        </SectionAnchor>

        {/* 스스로 데이터를 읽는 섹션은 개요(overview)를 다시 읽는 동안에도 그대로 둡니다 — `data &&` 안에 두면
            간격이 1분 경계를 넘을 때 함께 내려가 고른 계열·지표가 처음으로 돌아갔습니다(QA-066).
            지표 표 바로 아래에 둡니다 — 위에서 "지금 얼마인지"를 보고, 여기서 "어디서 왔는지"를 봅니다. */}
        <SectionAnchor id={MACRO_SECTIONS.fx} columnFrom="2xl">
          <FxCompareSection />
        </SectionAnchor>

        <SectionAnchor id={MACRO_SECTIONS.spreads} columnFrom="2xl">
          {data?.spreads ? (
            <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
              <SpreadSection
                title="10Y−2Y 장단기 금리차"
                block={data.spreads.official10y2y}
              />
              <SpreadSection
                title="30Y−2Y 장단기 금리차"
                block={data.spreads.official30y2y}
              />
              <Panel
                title="장단기 금리차 해석 기준"
                subtitle="역사적 분포에 근거한 참고치이며 투자 판단의 근거가 아닙니다."
                source={SOURCES.internalRules}
              >
                {/* 참고 표라 처음에는 접어 둡니다(긴 화면 — 실행 명세 §9-10). */}
                <CriteriaDetails summary="해석 기준 보기">
                  <DataTable
                    columns={SPREAD_COLUMNS}
                    rows={SPREAD_TABLE}
                    rowKey={(row) => row.state}
                    caption="장단기 금리차 해석 기준"
                    scrollHint="overflow"
                  />
                </CriteriaDetails>
              </Panel>
            </div>
          ) : (
            // 금리차는 개요 응답에 실려 옵니다 — 받기 전에는 읽는 중, 받았는데 없으면 그 사실(목차가 가리키는 절이 비지 않게).
            <Panel title="장단기 금리차">
              {overview.loading && !data ? (
                <Loading label="장단기 금리차를 불러오는 중…" />
              ) : (
                <EmptyState message={data ? "이번 개요 응답에 장단기 금리차가 없습니다." : "매크로 개요를 읽지 못했습니다 — 위 지표 패널에서 다시 시도하세요."} />
              )}
            </Panel>
          )}
        </SectionAnchor>

        <SectionAnchor id={MACRO_SECTIONS.risk} columnFrom="2xl">
          <RiskSection risk={risk.data} loading={risk.loading} refreshError={risk.refreshError} />
        </SectionAnchor>
        <SectionAnchor id={MACRO_SECTIONS.advanced} columnFrom="2xl">
          <AdvancedSection
            data={advanced.data}
            loading={advanced.loading}
            error={advanced.error}
            onRetry={advanced.reload}
            refreshError={advanced.refreshError}
          />
        </SectionAnchor>
        <SectionAnchor id={MACRO_SECTIONS.single} columnFrom="2xl">
          <SingleChartSection />
        </SectionAnchor>
        <SectionAnchor id={MACRO_SECTIONS.scraped} columnFrom="2xl">
          <ScrapedSection />
        </SectionAnchor>
        {/* 경제 캘린더는 운영자 전용 경로입니다(ADR 0026 — 차단 통과 수집으로 받은 자료). 회원·데모 방문자에게는 절도 목차 칸도 그리지 않습니다. */}
        {owner && (
          <SectionAnchor id={MACRO_SECTIONS.calendar} columnFrom="2xl">
            <EconCalendarSection />
          </SectionAnchor>
        )}
      </SectionIndex>
    </div>
  );
}
