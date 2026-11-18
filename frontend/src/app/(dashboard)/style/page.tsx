"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { HorizontalBars } from "@/components/charts";
import { DataTable, Empty, HeatmapTable, InspectorFrame, InspectorTrigger, KpiStrip, PropertyList } from "@/components/patterns";
import {
  Button,
  buttonClasses,
  Callout,
  ErrorState,
  Freshness,
  inputClasses,
  LINK_CLASSES,
  Loading,
  PageHeader,
  Panel,
  Select,
  SKELETON_BAR,
} from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { firstLoadPending, useApi } from "@/hooks/useApi";
import { ReadingGuide } from "./ReadingGuide";
import { useUsdKrw } from "@/hooks/useUsdKrw";
import { holdersNoMatch, institutionHref } from "@/lib/detail";
import { EMPTY, formatCurrency, formatNumber, formatWeightPercent, formatWithUnit } from "@/lib/format";
import { filerName } from "@/lib/holdings";
import type {
  GuruHoldersResponse,
  GuruProfile,
  GuruProfilesResponse,
  GuruRiskResponse,
  GuruSimilarityResponse,
} from "@/lib/types";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";
import {
  profileItems,
  profileName,
  profileTitle,
  riskInstitutionName,
  riskKpis,
  signedUnitText,
  similarityBelowText,
  similarityHeatmap,
  similarityMax,
  similarityPairs,
  similarityStepLabel,
  similarityText,
  TURNOVER_EMPTY_REASON,
  TURNOVER_EMPTY_SHORT,
} from "@/lib/styleScreen";

/**
 * 기관 13F 스타일·위험 (옛 이름: 구루 포트폴리오 분석, 주소 /guru → /style).
 *
 * <p>13F 화면은 "누가 무엇을 들고 있나"를 보여 줍니다. 이 화면은 한 발 더
 * 들어가 <b>어떤 식으로</b> 들고 있는지를 봅니다 — 몇 종목에 쏠려 있는지,
 * 누구와 닮았는지, 그 포트폴리오가 얼마나 흔들렸는지.
 *
 * 배치(작업대 화면 언어 — 명세 §7 4행): 머리(동작 '성격 새로고침' = 기관별 성격 다시 읽기) → 13F 공시의 한계(중립 안내 상자 — 늘 보임) → '기관별 성격' →
 * '기관 간 유사도' → '포트폴리오 위험' → '이 종목을 누가 들고 있나'. 패널 아래의 긴 설명 문단은 '읽는 법' 접기입니다(글 그대로).
 */
export default function GuruPage() {
  // 기관별 성격 — 머리의 '새로고침'이 이 읽기를 다시 부릅니다(예전 성격 카드 머리의 단추를 화면 머리 동작으로 — 명세 §7 4행). 위험 패널의 기관 고르기는
  // 같은 경로를 따로 읽는 훅 그대로입니다(요청 수 그대로 — 실제 브라우저에서는 동시 요청이 하나로 합쳐짐, lib/sharedRequest).
  const profiles = useApi<GuruProfilesResponse>(endpoints.institution.guruProfiles);
  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
      <PageHeader
        title="기관 13F 스타일·위험"
        description="집중도 · 회전율 · 기관 간 유사도 · 포트폴리오 위험 (13F 공시 기준)"
        actions={
          // 다시 읽는 것은 '기관별 성격' 응답 하나라 보이는 글에도 범위를 적습니다('성격 새로고침' — 예전 '새로고침'만으로는 화면 전체를 새로 읽는 것처럼
          // 읽혔음), 이름은 '기관별 성격 새로고침'(보이는 글을 담음 — WCAG 2.5.3). 읽는 동안은 aria-busy(포커스를 빼앗지 않게 비활성으로 두지 않음).
          // 공용 단추(Button)와 같은 모양입니다.
          <button
            type="button"
            onClick={profiles.reload}
            aria-label="기관별 성격 새로고침"
            aria-busy={profiles.loading || undefined}
            className={buttonClasses("default", "md")}
          >
            성격 새로고침
          </button>
        }
      />

      <Callout tone="neutral" title="13F 공시의 한계">
        13F는 <b>미국 상장 롱 포지션만</b> 공시 대상입니다. 채권·현금·해외 상장분·
        공매도는 이 숫자에 들어 있지 않습니다. 분기말 기준이며 제출까지 최대{" "}
        <b>45일 지연</b>됩니다 — 지금의 포지션이 아닙니다.
      </Callout>

      <ProfilesCard profiles={profiles} />
      <SimilarityCard />
      <RiskCard />
      <HoldersCard />
    </div>
  );
}

/**
 * 기관별 성격 요약.
 *
 * <p><b>유효 종목 수</b>를 함께 적는 이유 — 종목 수만 세면 인덱스 펀드와 집중
 * 투자자가 같은 칸에 놓입니다. 3,000종목을 들고 있어도 상위 몇 개에 쏠려 있으면
 * 이 값은 수십으로 나옵니다.
 */
function ProfilesCard({ profiles }: { profiles: ReturnType<typeof useApi<GuruProfilesResponse>> }) {
  const { data, loading, error, reload } = profiles;
  const usdKrw = useUsdKrw();
  const rows = data?.rows ?? [];
  const firstLoad = firstLoadPending(profiles);

  return (
    <Panel
      title="기관별 성격" source={SOURCES.sec13f}
      count={rows.length > 0 ? `${rows.length.toLocaleString("ko-KR")}곳` : undefined}
      // 부제는 표 안내 한 줄 — 처음 읽는 동안에도 같은 글이라 값이 와도 머리 높이가 같습니다. 응답 글(note)은 표 아래에 둡니다(예전에는 부제 앞에 붙어 값이 온 뒤에야
      // 머리가 두 줄 이상으로 자라 아래를 밀었음 — QA-715). 표가 없으면(저장본 없음) 응답 글이 부제입니다.
      subtitle={rows.length > 0 || firstLoad ? PROFILES_HINT : data?.note}
    >
      {firstLoad ? <ProfilesTablePending /> : loading && !data && <Loading label="13F 저장본을 읽는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && <Callout tone="warn">{data.message}</Callout>}

      {rows.length > 0 && (
        <InspectorFrame
          label="기관 성격"
          layout="lg"
          titleOf={(cik) => profileTitle(rows, cik)}
          defaultKey={rows[0].cik}
          renderDetail={(cik) => {
            const row = rows.find((entry) => entry.cik === cik);
            return row ? <ProfileDetail row={row} krw={usdKrw} /> : null;
          }}
        >
          {(inspector) => (
            <DataTable
              caption="기관별 성격"
              rows={rows}
              rowKey={(row) => row.cik}
              selectedKey={inspector.shownKey}
              scrollHint="overflow"
              columns={[
                {
                  key: "name",
                  header: "기관",
                  rowHeader: true,
                  className: "break-keep",
                  cell: (row) => (
                    <InspectorTrigger inspector={inspector} itemKey={row.cik}>
                      {profileName(row)}
                    </InspectorTrigger>
                  ),
                },
                { key: "totalValue", header: "포트폴리오 총액", align: "right", cell: (row) => moneyCell(row.totalValue, usdKrw) },
                { key: "holdingCount", header: "종목 수", align: "right", cell: (row) => formatNumber(row.holdingCount, 0) },
                {
                  key: "effectiveHoldings",
                  header: "유효 종목 수",
                  align: "right",
                  cell: (row) =>
                    row.effectiveHoldings === null ? null : (
                      <span className="flex flex-col items-end">
                        <span className="font-semibold">{formatNumber(row.effectiveHoldings, 1)}</span>
                        <span className="text-xs text-text-3">1 ÷ HHI</span>
                      </span>
                    ),
                },
                { key: "top10Weight", header: "상위 10종목", align: "right", cell: (row) => formatWithUnit(row.top10Weight, 1, "%") },
                {
                  key: "turnover",
                  header: "분기 회전율",
                  align: "right",
                  // 모르면 '—' 옆에 짧은 까닭을 늘 보이게(긴 글은 마우스 설명) — 예전에는 마우스 설명에만 있었고 표 아래 설명 문단은 '읽는 법' 접기 안이었음(QA-719).
                  cell: (row) =>
                    row.turnover === null ? (
                      <span className="text-text-3" title={TURNOVER_EMPTY_REASON}>
                        <Empty align="end" reason={TURNOVER_EMPTY_SHORT} />
                      </span>
                    ) : (
                      formatWithUnit(row.turnover, 1, "%")
                    ),
                },
                // 날짜 글 그대로(배지 없음 — 고른 행 바탕 surface-2 위에서 같은 바탕의 배지가 묻힘, 표 hover 결함과 같은 까닭). 날짜는 접지 않습니다 —
                // 좁은 표에서 '2026-06- / 30'처럼 하이픈에서 끊겼습니다.
                { key: "reportDate", header: "기준 분기", className: "whitespace-nowrap", cell: (row) => row.reportDate },
              ]}
            />
          )}
        </InspectorFrame>
      )}
      {rows.length > 0 && data?.note ? <p className="mt-2 text-xs text-text-3">{data.note}</p> : null}

      <ReadingGuide topic="유효 종목 수·회전율">
        <b>유효 종목 수</b> = 1 ÷ 허핀달 지수. 한 종목에 몰아넣었으면 1에 가깝고, 고르게
        나눴으면 실제 종목 수에 가까워집니다. <b>회전율</b>은 분기 사이에 갈아탄 비중이며,
        100%면 포트폴리오가 통째로 바뀐 것입니다. 직전 분기가 없으면 {EMPTY}입니다 — 0으로
        두면 &ldquo;한 주도 안 바꿨다&rdquo;로 읽힙니다.
      </ReadingGuide>
    </Panel>
  );
}

/** '기관별 성격' 부제 — 표 안내(읽는 중과 값이 온 뒤가 같은 글). */
const PROFILES_HINT = "기관 이름을 누르면 소개·HHI·수집 분기 수와 기관 상세 링크를 봅니다.";

/**
 * '기관별 성격'을 처음 읽는 동안의 표 꼴 자리 — 넘김 안내 줄(폰) + 머리 줄 32px + 줄 12(추적 기관 수). 줄 높이는 QA 스택 자료 12곳의 표를 자기 빌드(dc898d5d)로
 * 잰 평균입니다(390 1,195px → 97px, 1024 856px → 69px, 1440 640px → 51px, 1920 620px → 49px — 머리 32px 뺌). 1280(옆 검사 칸이 좁아 이름이 더 꺾임 — 1,036px)은
 * xl 값보다 크지만, 그 폭에서도 자리 끝이 첫 화면(900px) 아래라 아래 패널이 첫 화면 안에서 밀리지 않습니다. 자리일 뿐 보이는 수가 아닙니다 — 글·숫자 없이 막대만,
 * 막대는 읽기에서 뺍니다(이름 있는 읽는 중 상태 하나). 예전에는 '13F 저장본을 읽는 중…' 한 줄(68px)이라 값이 오면 표가 아래 패널을 밀었습니다(QA-715).
 */
function ProfilesTablePending() {
  return (
    <div role="status" aria-busy="true" aria-label="기관별 성격 불러오는 중" className="min-w-0">
      <span className="sr-only">기관별 성격 불러오는 중</span>
      <div aria-hidden="true">
        {/* 공용 표의 넘김 안내 줄 자리(폰에서만 보임 — 12/16 글 + 아래 4px). */}
        <div className="mb-1 h-4 sm:hidden" />
        <div className="flex h-8 items-center border-b border-border px-3">
          <span className={`block h-3 w-1/3 ${SKELETON_BAR}`} />
        </div>
        <ul>
          {Array.from({ length: 12 }, (_, index) => (
            <li
              key={index}
              className={`flex h-[97px] items-center px-3 lg:h-[69px] xl:h-[51px] 2xl:h-[49px] ${index < 11 ? "border-b border-border-subtle" : ""}`}
            >
              <span className={`block h-3.5 w-full ${SKELETON_BAR}`} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** 원/달러 병기 — 공용 환율 훅(useUsdKrw)이 돌려주는 것. */
type UsdKrw = ReturnType<typeof useUsdKrw>;

/** 포트폴리오 총액 칸 — 달러(조·억 단위)와 그 아래 원화(환율을 알 때만). 값을 모르면 null(표가 '—'). */
function moneyCell(value: number | null, krw: UsdKrw) {
  const usd = formatCurrency(value);
  if (usd === EMPTY) return null;
  const won = krw.toKrw(value);
  return won ? (
    <span className="flex flex-col items-end">
      <span>{usd}</span>
      <span className="text-xs text-text-3">{won}</span>
    </span>
  ) : (
    usd
  );
}

/**
 * 기관 성격 검사 칸 — 속성 목록(lib/styleScreen profileItems — 표에서 뺀 기관 소개, 표에 없는 HHI·수집 분기 수 포함)과 그 기관의 상세 화면 링크
 * (요청 없음 — 목록 → 검사 칸 → 대상 화면, 명세 W5). 받은 값만 보입니다(새로 읽지 않음).
 */
function ProfileDetail({ row, krw }: { row: GuruProfile; krw: UsdKrw }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <PropertyList items={profileItems(row, krw)} source={SOURCES.sec13f} />
      {/* 링크는 자기 줄에서 글 폭만(self-start) — flex-col 상자의 늘림을 받으면 검사 칸 폭 전체가 누르는 자리였습니다(QA-582). */}
      <Link href={institutionHref(row.cik)} className={`${LINK_CLASSES} self-start text-sm`}>
        기관 상세 열기
      </Link>
    </div>
  );
}

/** 기관 간 유사도. 머리기사는 겹침 비중입니다 — 코사인보다 그대로 읽힙니다. */
function SimilarityCard() {
  const { data, loading, error, reload } = useApi<GuruSimilarityResponse>(endpoints.institution.guruSimilarity);
  const [mode, setMode] = useState<"overlap" | "cosine">("overlap");

  const matrix = mode === "overlap" ? data?.overlap : data?.cosine;
  const names = useMemo(() => data?.institutions ?? [], [data]);
  const max = similarityMax(mode);

  // 짝 순위는 행렬에서 직접 만듭니다(lib/styleScreen similarityPairs — 서버의 topPairs는 겹침 순이라 코사인을 고르면 목록과 기준이 어긋남).
  // 표에는 짧은 이름, 마우스 설명에는 국기를 뗀 전체 이름(행렬 머리와 같은 규칙 — QA-153).
  const pairs = useMemo(() => similarityPairs(names, matrix, 8), [matrix, names]);
  const pairsCaption = `가장 닮은 짝 — ${mode === "overlap" ? "겹침 비중" : "코사인 유사도"} 순 상위 ${pairs.length}`;

  return (
    <Panel
      title="기관 간 유사도" source={SOURCES.sec13f}
      subtitle={data?.note}
      actions={
        <Select
          label="기준"
          value={mode}
          onChange={(value) => setMode(value === "cosine" ? "cosine" : "overlap")}
          options={[
            { value: "overlap", label: "겹침 비중 (%)" },
            { value: "cosine", label: "코사인 유사도" },
          ]}
        />
      }
    >
      {loading && !data && <Loading label="유사도를 계산하는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && <Callout tone="warn">{data.message}</Callout>}

      {pairs.length > 0 && (
        <>
          <h3 className="mb-2 text-xs font-semibold text-text-2">{pairsCaption}</h3>
          {/* 막대 차트 축 라벨은 폭이 좁아 두 기관 이름이 "블랙… ↔ 뱅가…"로 잘렸습니다. 짝 비교는 이름을 읽는 것이 먼저라 이름이 보이는 표입니다.
              공용 표(가로 스크롤 상자 안)의 세 칸 — 순위 · 짝(두 기관을 위아래 두 줄, 낱말 사이에서 줄바꿈) · 값(숫자 + 크기 감만 주는 막대). 예전 네 칸 표는
              두 이름 칸이 줄을 바꾸지 않고 스크롤 상자도 없어 390에서 패널 밖으로 넘쳐 값 끝이 잘리고 막대가 0폭이 됐습니다(QA-706). 막대는 고정 폭
              (64px)이라 줄지 않고, 색은 중립색입니다(빨강 = 매수·상승 약속과 섞이지 않게). */}
          <DataTable
            dense
            caption={pairsCaption}
            rows={pairs}
            rowKey={(pair) => pair.key}
            columns={[
              // 보이는 머리는 기호 '#'(장식 — 읽기에서 뺌), 낭독기에는 열 이름 '순위'(칸마다 머리로 읽힘 — 섹터 표의 순위 기준 열 QA-649와 같은 꼴).
              {
                key: "rank",
                header: (
                  <>
                    <span aria-hidden="true">#</span>
                    <span className="sr-only">순위</span>
                  </>
                ),
                align: "right",
                className: "w-8 text-text-3",
                cell: (pair) => pair.rank,
              },
              {
                key: "pair",
                header: "짝",
                rowHeader: true,
                className: "break-keep",
                cell: (pair) => (
                  <span className="flex min-w-0 flex-col text-text-2">
                    <span title={pair.leftTitle}>{pair.left}</span>
                    <span title={pair.rightTitle}>{pair.right}</span>
                  </span>
                ),
              },
              {
                key: "value",
                header: mode === "overlap" ? "겹침 비중 (%)" : "코사인 유사도",
                align: "right",
                cell: (pair) => (
                  <span className="inline-flex items-center justify-end gap-2">
                    {/* 막대는 바탕색으로만 그린 모양이라 고대비(forced-colors)에서 바탕이 지워지면 사라졌습니다 — 색을 지킵니다(forced-color-adjust는
                        상속되어 채움도 같음, QA-708 — 국면 띠 QA-635와 같은 규칙). 값은 옆 숫자 글이 나릅니다. */}
                    <span aria-hidden="true" className="h-2 w-16 shrink-0 rounded-sm bg-surface-2 forced-color-adjust-none">
                      <span className="block h-2 rounded-sm bg-text-3" style={{ width: `${Math.min(100, (pair.value / max) * 100)}%` }} />
                    </span>
                    <span className="min-w-12 text-text-2">{similarityText(mode, pair.value)}</span>
                  </span>
                ),
              },
            ]}
          />
        </>
      )}

      {matrix && names.length > 0 && (
        <div className="mt-5">
          {/* 표 히트맵(패턴 HeatmapTable — 순차 팔레트 다섯 단계, 칸마다 숫자): 예전에는 칸을 계열 파랑(#3987e5)의 rgba 농도로, 대각선을 토큰 밖
              회색 rgba로 칠했고 0도 옅게 칠했습니다(QA-707). 대각선은 자기 자신이라 늘 최대 — 칠하면 그 줄만 눈에 띄어 정작 읽어야 할 곳에서 시선을
              뺏으므로 중립 면(selfIndex), 0(겹치는 종목 없음)은 칠하지 않습니다. 행·열은 짧은 이름, 마우스 설명은 국기를 뗀 전체 이름(QA-153). */}
          <HeatmapTable
            caption="기관 간 유사도 행렬"
            rowHeader="기관"
            {...similarityHeatmap(names, matrix)}
            max={max}
            format={(value) => similarityText(mode, value)}
            minWidth={720}
            legend={{
              stepLabel: (step) => similarityStepLabel(mode, step),
              // 0으로 반올림되는 양수는 '<' 글로 적고 칠합니다(QA-718) — 칠한 칸과 칠하지 않은 칸의 글이 같지 않게.
              note: `대각선(자기 자신과 견준 칸)과 0(겹치는 종목 없음)은 칠하지 않습니다. '${similarityBelowText(mode)}'는 0보다 크지만 이 자릿수에서 0으로 반올림되는 값입니다.`,
            }}
          />
        </div>
      )}

      <ReadingGuide topic="겹침 비중·코사인">
        <b>겹침 비중</b>은 각 종목에서 작은 쪽 비중을 더한 값입니다 — 애플을 한쪽이 10%,
        다른 쪽이 3% 들고 있으면 겹치는 것은 3%입니다. <b>코사인</b>은 비중의 모양만 봅니다.
        종목 수가 크게 다른 두 곳에서는 두 값이 엇갈릴 수 있고, 그 엇갈림 자체가 정보입니다.
      </ReadingGuide>
    </Panel>
  );
}

/** 기관 포트폴리오의 위험. 커버리지를 항상 먼저 보여 줍니다. */
function RiskCard() {
  const profiles = useApi<GuruProfilesResponse>(endpoints.institution.guruProfiles);
  const [cik, setCik] = useState("0001067983");
  const [benchmark, setBenchmark] = useState("SPY");
  const [years, setYears] = useState("1");

  const { data, loading, error, reload, refreshError } = useApi<GuruRiskResponse>(
    endpoints.institution.guruRisk(cik, benchmark, years),
  );

  const coverage = data?.coverage;
  const metrics = data?.metrics;

  return (
    <Panel
      title="포트폴리오 위험" source={SOURCES.sec13fWithPrices}
      subtitle="13F 비중으로 수익률을 재구성해 변동성·VaR·베타·추적오차를 잽니다."
      actions={
        <Freshness
          collectedAt={data?.collectedAtKst}
          ageSeconds={data?.ageSeconds}
          stale={data?.stale}
          refreshError={refreshError}
        />
      }
    >
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label="기관"
          value={cik}
          onChange={setCik}
          options={(profiles.data?.rows ?? []).map((row) => ({
            value: row.cik,
            label: filerName(row.name) ?? `CIK ${row.cik}`,
          }))}
        />
        <Select
          label="벤치마크"
          value={benchmark}
          onChange={setBenchmark}
          options={[
            { value: "SPY", label: "S&P 500 (SPY)" },
            { value: "QQQ", label: "나스닥 100 (QQQ)" },
            { value: "ACWI", label: "글로벌 주식 (ACWI)" },
          ]}
        />
        <Select
          label="측정 구간"
          value={years}
          onChange={setYears}
          options={["1", "2", "3", "5"].map((value) => ({ value, label: `최근 ${value}년` }))}
        />
        <Button onClick={reload}>다시 계산</Button>
      </div>

      {loading && !data && <Loading label="포트폴리오 위험을 계산하는 중…" />}
      {error && (
        <div className="mt-3">
          <ErrorState message={error} onRetry={reload} />
        </div>
      )}
      {data && !data.available && (
        <div className="mt-3">
          <Callout tone="warn">{data.message}</Callout>
        </div>
      )}

      {/*
        커버리지를 결과보다 **먼저** 보여 줍니다. 13F에는 티커가 없어 이름으로
        가격을 찾는데, 매핑표에 없는 종목은 빠집니다. 덮인 것만으로 계산한 값을
        전체인 것처럼 보여 주면 안 됩니다.
      */}
      {/* 조건 줄과 붙지 않게 12px 띄웁니다(예전 카드 안에서는 바로 붙어 있었음). */}
      {coverage && (
        <div className="mt-3">
          <Callout tone={coverage.weight >= 70 ? "neutral" : "warn"}>
            <div>
              커버리지 <b>{formatWithUnit(coverage.weight, 1, "%")}</b> — 보유 {coverage.totalHoldings}종목
              중 <b>{coverage.holdings}종목</b>의 가격을 찾았습니다. 아래 값은 이 비중만으로 낸
              것이며, 나머지 {formatWithUnit(coverage.totalWeight - coverage.weight, 1, "%")}의 위험은
              반영되지 않았습니다.
            </div>
            {coverage.uncovered.length > 0 && (
              <details className="mt-2">
                <summary className="min-h-11 cursor-pointer py-3.5 text-xs lg:min-h-0 lg:py-0">
                  미커버 {coverage.uncoveredCount}종목 보기
                </summary>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {/* 같은 회사의 보통주·우선주·사채가 같은 공시 이름으로 여러 줄 옵니다. 응답에 증권을 가르는 필드가 없고
                      목록은 응답마다 통째로 바뀌므로 순서를 키에 넣습니다(QA-135). */}
                  {coverage.uncovered.map((row, index) => (
                    <li key={`${index}:${row.name}`}>
                      {row.name} — {formatWeightPercent(row.weight)}
                      {row.reason && <span className="text-text-3"> · {row.reason}</span>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Callout>
        </div>
      )}

      {/* 위험 지표 KPI 띠(lib/styleScreen riskKpis) — 값은 위험의 크기라 등락색 없이 본문 잉크, 음수(VaR·ES는 손실이라 음수)는 −(U+2212)(QA-709),
          단위는 값 옆 작은 글. 첫 타일 보조 글의 날짜는 꺾지 않습니다(keepDates). 출처는 이 패널 머리가 적습니다. */}
      {metrics && (
        <div className="mt-4">
          <KpiStrip label="위험 지표" items={riskKpis(metrics, data!.benchmark)} keepDates />
        </div>
      )}

      {(data?.sectors?.length ?? 0) > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-xs font-semibold text-text-2">
            섹터 노출 <span className="font-normal text-text-3">(커버된 종목만으로 100%)</span>
          </h3>
          <HorizontalBars
            data={data!.sectors!.map((row) => ({ name: row.sector, value: row.weight }))}
            unit="%"
            digits={1}
            valueName="비중"
            neutral
            ariaLabel={`${riskInstitutionName(profiles.data?.rows, cik)} 섹터 노출 비중`}
            height={Math.max(200, data!.sectors!.length * 28)}
          />
        </div>
      )}

      {(data?.contributions?.length ?? 0) > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-xs font-semibold text-text-2">종목별 위험 기여</h3>
          <DataTable
            caption="종목별 위험 기여"
            rows={data!.contributions!}
            rowKey={(row) => row.ticker}
            scrollHint="overflow"
            columns={[
              {
                key: "name",
                header: "종목",
                rowHeader: true,
                className: "break-keep",
                cell: (row) => (
                  <span className="flex flex-col">
                    <span className="text-text-2">{row.name}</span>
                    <span className="text-xs text-text-3">
                      {row.ticker}
                      {row.sector ? ` · ${row.sector}` : ""}
                    </span>
                  </span>
                ),
              },
              { key: "weight", header: "비중", align: "right", cell: (row) => formatWeightPercent(row.weight) },
              { key: "volatility", header: "개별 변동성", align: "right", cell: (row) => formatWithUnit(row.volatility, 1, "%") },
              {
                key: "contribution",
                header: "위험 기여",
                align: "right",
                // 포트폴리오 변동성에 보탠 몫이라 오르내린 값이 아닙니다 — 등락색 없이 본문 잉크, 음수(분산 효과로 줄인 몫)는 −(U+2212)(QA-704).
                cell: (row) =>
                  row.contribution === null ? null : <span className="font-semibold">{signedUnitText(row.contribution, 2, "%p")}</span>,
              },
              { key: "share", header: "기여 비중", align: "right", cell: (row) => signedUnitText(row.share, 1, "%") },
            ]}
          />
          <ReadingGuide topic="위험 기여">
            <b>기여의 합 = 포트폴리오 변동성</b>입니다. 개별 변동성을 그냥 더하면 분산 효과가
            사라져 합이 맞지 않습니다. 비중이 큰 종목이 곧 위험이 큰 종목은 아닙니다 — 조용한
            대형주 20%와 널뛰는 종목 5%의 기여가 뒤집히는 일이 흔합니다.
          </ReadingGuide>
        </div>
      )}

      {data?.note && (
        <p className="mt-3 text-xs leading-relaxed text-text-3">
          <StatusText tone="warn" colorText={false} iconSize={12}>{data.note}</StatusText>
        </p>
      )}
    </Panel>
  );
}

/**
 * 이 종목을 누가 들고 있나. 공시 이름에 검색어가 들어간 줄과, 앞부분만 남기고 잘린 공시 이름의 앞부분으로 검색어가 시작하는 줄을 함께 찾습니다
 * (GET /api/guru/holders — QA-436). 그래서 다른 종목이 섞일 수 있다고 적고, 0건이면 정보 검색 보유 탭·종목 상세와 같은 글(lib/detail holdersNoMatch)로
 * 찾은 이름과 그 한계를 적어 없다고 단정하지 않습니다 — 백엔드 글('그 이름을 포함한 보유 종목이 없습니다')은 넓힌 규칙과 맞지 않습니다.
 */
function HoldersCard() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const { data, loading, error, reload } = useApi<GuruHoldersResponse>(
    query ? endpoints.institution.guruHolders(query) : null,
  );
  const noMatch = data && (data.rows?.length ?? 0) === 0 ? holdersNoMatch(data.query || query) : null;

  return (
    <Panel
      title="이 종목을 누가 들고 있나" source={SOURCES.sec13f}
      subtitle="13F 공시 이름은 대문자 영문입니다 (예: APPLE, NVIDIA, BERKSHIRE)."
    >
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(input.trim());
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-3">종목명(일부 또는 전체)</span>
          {/* 셸의 거르기 칸 표지(data-shell-filter — '/'로 이 칸에 포커스, 단축키 도움말의 '/' 줄) — 이 화면에 하나입니다. */}
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="NVIDIA"
            data-shell-filter=""
            className={inputClasses("sm")}
          />
        </label>
        <Button type="submit">찾기</Button>
      </form>

      {loading && query && <Loading />}
      {/* 검색 칸 줄과 붙지 않게 12px 띄웁니다(위험 패널의 오류·안내와 같은 간격 — 공용 오류 상자에는 바깥 여백이 없음). 읽는 중 줄은 제 위아래 여백(24px)이 있어 그대로. */}
      {error && (
        <div className="mt-3">
          <ErrorState message={error} onRetry={reload} />
        </div>
      )}
      {noMatch && (
        <div role="status" className="mt-4 flex flex-col gap-1 rounded-control bg-surface-2/60 px-4 py-6 text-sm">
          <p className="font-medium text-text">{noMatch.title}</p>
          <p className="text-text-2">{noMatch.note}</p>
        </div>
      )}

      {(data?.rows?.length ?? 0) > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs leading-relaxed text-text-3">
            공시 이름에 검색어가 들어간 줄과 앞부분만 남기고 잘린 공시 이름(검색어가 그 앞부분으로 시작)을 함께 찾아 다른 종목이 섞일 수 있습니다 —
            공시 이름과 CUSIP으로 가려 보세요.
          </p>
          {/* 백엔드는 비중 상위 200행까지만 보냅니다(QA-133). 말하지 않으면 잘린 목록이 전부처럼 읽힙니다. */}
          {data!.truncated && (
            <p className="mb-2 text-xs leading-relaxed text-text-3">
              일치 {formatNumber(data!.totalMatches, 0)}건 중 비중 상위 {data!.rows.length}건만 보입니다 — 종목명을
              더 길게 적어 좁히세요.
            </p>
          )}
          {/* 같은 기관·CUSIP 줄이 둘 이상일 수 있어(응답에 줄을 가르는 칸이 없음) 받은 차례를 키에 넣습니다(옛 표와 같은 키). */}
          <DataTable
            caption="이 종목을 누가 들고 있나 — 찾은 보유 줄"
            rows={data!.rows.map((row, index) => ({ ...row, key: `${row.cik}-${row.cusip}-${index}` }))}
            rowKey={(row) => row.key}
            count
            scrollHint="overflow"
            columns={[
              { key: "institution", header: "기관", rowHeader: true, className: "break-keep", cell: (row) => filerName(row.institution) ?? `CIK ${row.cik}` },
              {
                key: "name",
                header: "종목",
                className: "break-keep",
                cell: (row) => (
                  <span className="flex flex-col">
                    <span className="text-text-2">{row.name}</span>
                    <span className="text-xs text-text-3">CUSIP {row.cusip}</span>
                  </span>
                ),
              },
              { key: "weight", header: "비중", align: "right", cell: (row) => <span className="font-semibold">{formatWeightPercent(row.weight)}</span> },
              { key: "value", header: "평가액", align: "right", cell: (row) => formatCurrency(row.value) },
              // 날짜는 접지 않습니다 — 좁은 표에서 '2026-06- / 30'처럼 하이픈에서 끊겼습니다.
              { key: "reportDate", header: "기준 분기", className: "whitespace-nowrap", cell: (row) => row.reportDate },
            ]}
          />
        </div>
      )}
    </Panel>
  );
}
