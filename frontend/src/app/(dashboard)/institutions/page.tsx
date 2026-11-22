"use client";

import Link from "@/components/ui/IntentLink";
import { useState } from "react";
import { FilterList, type FilterListPendingRow, KpiStrip, Skeleton, SplitPane } from "@/components/patterns";
import {
  Callout,
  EmptyState,
  ErrorState,
  FOCUS_RING,
  Freshness,
  Loading,
  PageHeader,
  Panel,
  Select,
  TEXT_TARGET,
} from "@/components/ui";
import { firstLoadPending, useApi } from "@/hooks/useApi";
import { useUsdKrw } from "@/hooks/useUsdKrw";
import { institutionHref } from "@/lib/detail";
import {
  institutionItems,
  type InstitutionsResponse,
  institutionSubtitle,
  institutionTitle,
  portfolioKpis,
  portfolioKpisPending,
  PORTFOLIO_SOURCE,
} from "@/lib/institutionsScreen";
import type { PortfolioResponse } from "@/lib/types";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";
import { PortfolioHoldingsPanel } from "@/components/screens/institutions/PortfolioHoldingsPanel";
import { WeightHistoryPanels } from "@/components/screens/institutions/WeightHistoryPanels";
import { FavoritesPanel } from "@/components/screens/institutions/FavoritesPanel";

/**
 * 기관 13F 포트폴리오 분석.
 *
 * 주의: 13F는 분기 공시이며 **45일 지연**입니다. 지금의 포지션이 아니라 지난
 * 분기말 스냅샷이라는 점을 화면이 계속 상기시켜야 합니다.
 */
export default function InstitutionsPage() {
  const institutions = useApi<InstitutionsResponse>(endpoints.institution.institutions);
  const [cik, setCik] = useState("0001067983");   // 버크셔 해서웨이
  const [quarters, setQuarters] = useState("8");
  const [topN, setTopN] = useState("30");

  const { data, loading, error, reload, refreshError, failedAt } = useApi<PortfolioResponse>(
    endpoints.institution.portfolio(cik, quarters, topN),
  );
  // 매크로 화면이 이미 수집하는 원/달러를 그대로 씁니다. 여기서 따로 받아 오면
  // 같은 포트폴리오가 메뉴마다 다른 원화 금액으로 보입니다.
  const usdKrw = useUsdKrw();

  const items = institutionItems(institutions.data?.institutions);
  // 13F 즐겨찾기(ADR 0048) — 같은 목록 응답의 favorites. 제목·부제는 두 목록에서 찾습니다(고른 기관 하나를 함께 씀).
  const favorites = institutions.data?.favorites ?? [];
  const namedItems = [...items, ...institutionItems(favorites)];
  // 기관 목록을 아직 못 받았거나 읽지 못했으면 목록 대신 — 실패면 오류(다시 시도는 누를 때만 읽음), 실패 뒤 다시 읽는 중이면 짧은 자리표시.
  // 처음 읽는 동안은 거르기 목록의 목록 꼴 자리(pending — 아래 PENDING_INSTITUTIONS)입니다.
  const institutionsPlaceholder =
    institutions.data === null ? (
      institutions.error ? (
        <ErrorState message={institutions.error} onRetry={institutions.reload} />
      ) : institutions.loading && !firstLoadPending(institutions) ? (
        <Skeleton lines={2} label="기관 목록을 불러오는 중" />
      ) : undefined
    ) : undefined;
  // 고른 기관 패널 — 제목(목록 이름, 없으면 포트폴리오 응답의 이름·'CIK …')과 요약 KPI(예전 지표 칸 셋과 같은 값·글).
  const title = institutionTitle(namedItems, cik, data);
  // 부제 — 목록의 설명(없으면 포트폴리오 응답의 같은 글). 둘 다 읽는 중이면 한 줄을 비워 두어, 늦게 온 설명이 끼어들며 아래 KPI 띠를 밀지 않게 합니다.
  const subtitleText = institutionSubtitle(namedItems, cik, data);
  const subtitle =
    subtitleText ?? (institutions.loading || loading ? <span aria-hidden="true">{"\u00a0"}</span> : undefined);
  const kpis = portfolioKpis(data?.available ? data : null, usdKrw, PORTFOLIO_SOURCE);
  // 포트폴리오를 처음 읽는 동안(값도 앞선 실패도 없음)은 값 꼴의 KPI 자리, 실패 뒤 다시 읽는 동안은 '불러오는 중' 한 줄(QA-655와 같은 규칙).
  const portfolioFirstLoad = firstLoadPending({ data, loading, failedAt });

  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
      <PageHeader
        title="기관 13F 포트폴리오 분석"
        description="SEC EDGAR 공식 공시 · 분기 공시, 공시 마감 45일 지연"
        actions={<Freshness collectedAt={data?.collectedAtKst} ageSeconds={data?.ageSeconds} refreshError={refreshError} />}
      />

      <SplitPane
        columns={2}
        left={
          <>
            {/*
              조회 조건을 기관 목록 위에 둡니다 — 목록(넓은 화면 약 664px) 아래에 두면 화면을 열었을 때 첫 화면 밖이었습니다(2026-11-18 결정(사용자 위임 — 권장안 가),
              진행 기록 결정 거리 lg-conditions-below-list). 조건은 두 칸뿐이라 목록을 거의 밀지 않습니다.
            */}
            <Panel title="조회 조건">
              <div className="flex flex-wrap items-end gap-3">
                <Select
                  label="조회 분기 수"
                  value={quarters}
                  onChange={setQuarters}
                  options={["1", "2", "4", "8"].map((value) => ({
                    value,
                    label: `최근 ${value}개 분기`,
                  }))}
                />
                <Select
                  label="표시 종목 수"
                  value={topN}
                  onChange={setTopN}
                  options={["10", "20", "30", "50"].map((value) => ({
                    value,
                    label: `상위 ${value}개`,
                  }))}
                />
              </div>
            </Panel>
            {/*
              기관 목록 — 고르면 그 기관의 포트폴리오를 읽습니다(예전 '분석할 기관' 고르기 상자와 같은 상태·요청). 넓은 화면은 세로 목록(줄 32px),
              좁은 화면은 44px 태그가 줄을 바꾸며 늘어섭니다(접지 않음 — 조작이 첫 화면에 바로 보이게).
            */}
            <Panel title="기관" count={items.length > 0 ? `${items.length.toLocaleString("ko-KR")}곳` : undefined}>
              <FilterList
                label="분석할 기관"
                items={items.map((item) => ({ key: item.key, label: item.label }))}
                selected={[cik]}
                onToggle={setCik}
                selection="single"
                narrow="wrap"
                placeholder={institutionsPlaceholder}
                pending={firstLoadPending(institutions) ? { label: "기관 목록을 불러오는 중", rows: PENDING_INSTITUTIONS } : null}
              />
            </Panel>
            {institutions.data ? (
              <FavoritesPanel
                favorites={favorites}
                defaultCiks={items.map((item) => item.key)}
                limit={institutions.data.favoriteLimit ?? null}
                selected={cik}
                onSelect={setCik}
                reload={institutions.reload}
              />
            ) : null}
          </>
        }
      >
        {/*
          고른 기관 패널 — 제목 = 기관 이름, 부제 = 기관 목록의 설명, 머리 동작 = 기관 상세 링크(요청 없음).
          본문은 포트폴리오 읽기 상태 — 읽는 중·오류(다시 시도)·저장본 없음 안내, 값이 오면 요약 KPI 띠.
        */}
        <Panel
          title={title}
          subtitle={subtitle}
          actions={
            // 따로 선 링크라 좁은 화면(lg 미만) 누르는 자리 44px(TEXT_TARGET)와 포커스 링 — 기관 상세 '13F 포트폴리오에서 자세히'와 같은 꼴(중립 잉크·밑줄).
            <Link href={institutionHref(cik)} className={`${TEXT_TARGET} rounded-sm text-xs font-medium text-text underline-offset-2 hover:underline ${FOCUS_RING}`}>
              기관 상세 열기
            </Link>
          }
        >
          {loading && !data &&
            (portfolioFirstLoad ? (
              // 이름은 값이 온 뒤의 띠('포트폴리오 요약')와 다르게 — 읽는 중인 영역임을 이름이 말합니다.
              <KpiStrip label="포트폴리오 요약 불러오는 중" items={portfolioKpisPending(PORTFOLIO_SOURCE)} pendingMatchesValue keepDates />
            ) : (
              <Loading label="13F 공시를 불러오는 중…" />
            ))}
          {error && <ErrorState message={error} onRetry={reload} />}
          {data && !data.available && (
            <Callout tone="warn">{data.error ?? data.message ?? "13F 데이터가 없습니다. 수집기의 weekly 작업을 실행하세요."}</Callout>
          )}
          {kpis.length > 0 && <KpiStrip label="포트폴리오 요약" items={kpis} keepDates />}
        </Panel>

        {data?.available && (
          <>
            <WeightHistoryPanels history={data.weightHistory} title={title} />

            <PortfolioHoldingsPanel data={data} krw={usdKrw} />
          </>
        )}
      </SplitPane>
    </div>
  );
}

/**
 * 기관 목록을 처음 읽는 동안의 자리 줄(공용 거르기 목록의 `pending` — 값이 온 뒤의 목록 꼴: 좁은 화면 44px 태그 줄바꿈, 넓은 화면 세로 목록 줄). 예전에는 글 줄
 * 자리표시(Skeleton 6줄 약 140px)라, 목록(390 약 630px·lg 약 664px)이 오면 좁은 화면에서는 아래 조회 조건·고른 기관 패널 전체가, 넓은 화면에서는 왼쪽 조회 조건이
 * 밀렸습니다(자기 빌드 CLS 390 0.436 — `25b75a15`, 그때는 조회 조건이 목록 아래). 좁은 화면 태그 폭(px — 390 목록 칸 332px에서 잘린 값)·태그 줄 수와 넓은 화면(왼쪽
 * 13rem 칸) 이름 줄 수는 QA 스택 자료 12곳(목록 차례)을 자기 빌드로 잰 값입니다(390 태그 폭 147~332px, 두 줄 태그 하나 — 합 630px, lg 줄 1~3줄 — 합 664px — 교집합
 * 화면과 같은 규약). 목록이 바뀌면 조금 어긋날 수 있습니다 — 자리일 뿐 보이는 수·이름이 아닙니다.
 */
const PENDING_INSTITUTIONS: readonly FilterListPendingRow[] = [
  { tag: 252, lines: 2 },
  { tag: 287, lines: 2 },
  { tag: 225, lines: 2 },
  { tag: 332, tagLines: 2, lines: 3 },
  { tag: 322, lines: 2 },
  { tag: 147, lines: 1 },
  { tag: 184, lines: 2 },
  { tag: 275, lines: 2 },
  { tag: 322, lines: 3 },
  { tag: 290, lines: 2 },
  { tag: 272, lines: 3 },
  { tag: 300, lines: 2 },
];
