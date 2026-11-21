"use client";

import { memo, useMemo } from "react";
import {
  AutoRefreshControl,
  LIVE_THRESHOLD_SECONDS,
  useAutoRefreshSeconds,
} from "@/components/AutoRefresh";
import { type Column, DataTable, SectionAnchor, SectionIndex } from "@/components/patterns";
import { RawSnapshotActions } from "@/components/RawSnapshotCard";
import { ScrollTopButton } from "@/components/ScrollTopButton";
import { EmptyState, Freshness, Loading, PageHeader, Panel } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { firstLoadPending, useApi } from "@/hooks/useApi";
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
import { FxCompareSection as FxCompareSectionBody } from "./FxCompareSection";
import { IndicatorsSection as IndicatorsSectionBody } from "./IndicatorsSection";
import { SpreadSection as SpreadSectionBody } from "./SpreadSection";
import { RiskSection as RiskSectionBody } from "./RiskSection";
import { AdvancedSection as AdvancedSectionBody } from "./AdvancedSection";
import { SingleChartSection as SingleChartSectionBody } from "./SingleChartSection";
import { ScrapedSection as ScrapedSectionBody } from "./ScrapedSection";
import { EconCalendarSection as EconCalendarSectionBody } from "./EconCalendarSection";
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

/*
 * 구역은 memo로 감쌉니다(ADR 0047 결정 8, 성능 개선 작업 B2). 화면 꼭대기 상태(실시간 시세·1분 시계·자동 갱신 간격·세 응답) 가운데 하나가 바뀌면
 * 예전에는 여덟 구역이 모두 다시 그려졌고, 차트 구역은 그때마다 Recharts가 선 경로를 다시 계산했습니다(CPU 4배에서 한 번에 0.4초 안팎). 받는 값이
 * 같은 구역은 다시 그리지 않습니다 — 스스로 자료를 읽는 구역(환율 비교·개별 차트·참고 시세·경제 캘린더)은 받는 값이 없고, 나머지는 응답 객체와
 * useApi의 reload(useCallback)만 받습니다. 보이는 내용·순서·구조는 그대로입니다.
 */
const FxCompareSection = memo(FxCompareSectionBody);
const IndicatorsSection = memo(IndicatorsSectionBody);
const SpreadSection = memo(SpreadSectionBody);
const RiskSection = memo(RiskSectionBody);
const AdvancedSection = memo(AdvancedSectionBody);
const SingleChartSection = memo(SingleChartSectionBody);
const ScrapedSection = memo(ScrapedSectionBody);
const EconCalendarSection = memo(EconCalendarSectionBody);

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
  // 자리 줄·개수 자리와 지표 패널의 표 꼴 자리는 처음 읽는 동안만 — 실패 뒤 다시 읽는 동안 그리면 갱신마다 오류 상태와 번갈아 그려졌습니다(QA-655).
  // 저장본이 없으면(available=false — 범주는 빈 목록) 개수도 모르는 것이라 받기 전과 같이 개수 없이 둡니다('지표 (0)'으로 적지 않음 — QA-668).
  const firstLoad = firstLoadPending(overview);
  const unavailable = data?.available === false;
  const indexItems = useMemo(
    () => macroIndexItems(unavailable ? null : groups, owner, firstLoad),
    [unavailable, groups, owner, firstLoad],
  );

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
            {/* 신선도 칸 — lg 미만에서는 남은 폭을 채우고(flex-1) 칸 안 글은 줄을 바꾸지 않아(whitespace-nowrap), 칸이 줄에 놓일 폭이 수집 배지 폭이 됩니다.
                자동 갱신이 실패해 '새로 읽지 못함' 알약이 붙어도 칸째 다음 줄로 넘어가지 않고 그 안에서 알약을 배지 위에 둡니다 — 예전에는 390·768에서
                동작 줄이 28px 자라 아래 전체가 밀렸습니다(QA-669, 갱신이 성공하면 되돌아오며 한 번 더 밀림). min-w-0은 두지 않습니다(좁은 폭에서 배지가 눌려
                줄 바뀜 자리가 달라짐). 신선도가 아직 없으면(첫 읽기 전) 칸을 접어 빈 칸의 사이 간격이 생기지 않게 합니다.
                알약이 배지 위에 놓여 44px 줄 안에 드는 것은 칸이 조작과 한 줄에 있을 때입니다. 칸이 둘째 줄에 혼자 놓이는 폭(잰 폭 360·495~655)에서는
                알약과 배지가 나란히 놓여 그 줄 높이가 알약(20px)과 배지(16px)의 차이만큼 4px 바뀌었으므로, lg 미만에서 칸의 최소 높이를 20px로 두고
                가운데 맞춥니다(max-lg:min-h-5 items-center). 배지가 알약 폭만큼 오른쪽으로 옮겨지는 것은 공용 Freshness의 차례라 그대로입니다. */}
            <div className="flex items-center whitespace-nowrap empty:hidden max-lg:min-h-5 max-lg:flex-1">
              <Freshness
                collectedAt={data?.collectedAtKst}
                ageSeconds={data?.ageSeconds}
                stale={data?.stale}
                refreshError={overview.refreshError}
              />
            </div>
          </>
        }
      >
        {/* 머리 글 칸 — 늘 그리고(글이 없으면 높이 0) 글 폭과 상관없이 머리 줄 전체를 씁니다(w-screen max-w-full — 칸의 글 폭 기여가 화면 폭이라
            제목 묶음이 혼자 한 줄을 차지하고, 실제 폭은 그 줄 폭으로 줄어듦). 그래서 동작 줄은 간격·자료와 상관없이 늘 제목 묶음 아래 따로 놓입니다.
            예전에는 자동 갱신을 끄면(아래 설명 글 없음) 제목 묶음이 제목·설명 폭뿐이라 넓은 폭에서 동작 줄이 제목 옆에 놓였다가, 개요가 와 신선도 배지가
            붙거나(동작 줄이 넓어짐 — 메뉴 220의 1280) 실시간 시세 안내가 붙으면(제목 묶음이 줄 전체로 — 1440·1920) 동작 줄이 다음 줄로 꺾여 아래 전체가
            38~74px 밀렸습니다(QA-679, 첫 읽기 CLS 0.18~0.31). 켜 둔 간격에서는 설명 글이 이미 줄 전체 폭이라 그 배치와 같습니다. 안내 글이 붙으면 그 높이만큼
            밀리는 것은 그대로입니다(알려진 한계 — 글을 숨기거나 늘 빈 줄을 두지 않음). */}
        <div data-macro-header-lines className="w-screen max-w-full">
          {/* 고른 간격보다 값이 늦게 바뀌는 이유를 화면에서 바로 알 수 있게 적습니다.
              적지 않으면 "10초로 해 뒀는데 숫자가 그대로"로 읽힙니다. */}
          {refreshSeconds > 0 && (
            <p className="mt-1 text-xs text-text-3">
              지표 시세는 고른 간격마다 서버가 바로 받아 밀어 줍니다(TradingView·네이버, 저장하지 않음). 출처가 지연 시세인
              지표(선물·상하이)는 기준 칸(없으면 지표 미리보기)에 그 지연을 적습니다.
            </p>
          )}
          {liveNotice && <p className="mt-1 text-xs text-text-3">{liveNotice}</p>}
        </div>
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
            firstLoad={firstLoad}
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
          <RiskSection risk={risk.data} loading={risk.loading} error={risk.error} onRetry={risk.reload} refreshError={risk.refreshError} />
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
      {/* 맨 위로(TOP) — 사용자 요구 2026-11-18(모의 매매·정보 검색·정보 수집과 같은 공용 단추). 400px 넘게 내려가면 오른쪽 아래에 나타납니다(고정 위치라
          세로 묶음의 간격·흐름에 들지 않음). 층은 기본 z-40: 목차 가로 줄(위쪽에 붙음, z-20)과는 자리가 다르고, 미리보기·원자료 대화상자(z-50)는 덮개가
          단추를 가리며, 휴대폰 아래 탭 막대(z-40) 위에 놓입니다. 이 화면에는 아래에 붙는 시트가 없어(--bottom-sheet 0) 자리를 옮기지 않습니다. */}
      <ScrollTopButton />
    </div>
  );
}
