"use client";

import { LineSeries, MultiLineSeries, SERIES_COLORS, SignedBars } from "@/components/charts";
import { DataTable, KpiStrip, type KpiItem } from "@/components/patterns";
import { Callout, ErrorState, Freshness, Loading, PageHeader, Panel, SourceBadge } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { stanceText } from "@/lib/flows";
import { EMPTY, formatKrw, formatNumber, formatPercent, formatSigned, formatSignedMinus, withMinusSign } from "@/lib/format";
import type { InvestorTrendResponse, KrMarketTotalsResponse, KrxFuturesResponse } from "@/lib/types";
import { SpotFuturesCard } from "./SpotFuturesCard";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";
import { mergeByDate } from "@/lib/chartData";

/**
 * 국내 파생 & 투기세력 (KRX).
 *
 * 화면이 지켜야 할 것
 *  - 등락률을 모르면 국면은 "판정 불가"입니다. 강세로 기울여 표시하지 않습니다.
 *  - 추정치 모드면 경고를 띄웁니다.
 *  - Daum 선물 수급은 계약수 기준입니다(금액 기준은 제공되지 않습니다).
 *
 * 작업대 P7(실행 명세 §7 7행 'KRX: KPI 넘침 고침'): 옛 지표 칸(Metric) 격자 셋 → KPI 띠 셋(선물 요약·장중 수급 가속도·증시 규모 — 값 20/24px, 넘치는 칸은 띠가
 * 칸 수를 정함), 표는 공용 조밀 표. 순매수 계약·누적(오르내린 값이 아님)은 본문 잉크 + 부호(음수 − U+2212), 등락·증감은 공용 변화 칩. 이중 축 그림 둘은
 * 그대로입니다(명세 §7 끝 — 나누면 화면 뜻이 바뀌어 따로 승인).
 */

/** 부호 있는 수(계약 등 — 오르내린 값이 아님): 본문 잉크 + 부호(음수 −). 모르면 null(공용 표·타일이 '—'). */
const signed = (value: number | null | undefined, digits = 0): string | null =>
  value === null || value === undefined || Number.isNaN(value) ? null : formatSignedMinus(value, digits).text;
const MEASURE_LABELS: Record<string, string> = { CONTRACT: "계약 수 기준", AMOUNT: "금액 기준" };

export default function KrxPage() {
  const futures = useApi<KrxFuturesResponse>(endpoints.positioning.krxFutures(60), 300_000);
  const trend = useApi<InvestorTrendResponse>(endpoints.positioning.krxInvestorTrend, 300_000);
  const intraday = useApi<{
    available: boolean;
    skipped?: boolean;
    message?: string;
    dataDate?: string;
    latestTime?: string;
    referenceTime?: string;
    lookbackMinutes?: number;
    foreignCurrent?: number;
    foreignChange?: number;
    institutionCurrent?: number;
    institutionChange?: number;
    flowStatus?: string;
    source?: string;
  }>(endpoints.positioning.krxIntraday(30), 60_000);

  if (futures.loading && !futures.data) {
    return <Loading label="KRX 파생 데이터를 불러오는 중…" />;
  }
  if (futures.error) {
    return <ErrorState message={futures.error} onRetry={futures.reload} />;
  }

  const data = futures.data;
  // 수집이 실패해 KODEX 200 추정치로 대체됐으면 출처도 그렇게 적습니다.
  const krxSource = data?.isEstimated ? "KODEX 200(Yahoo Finance) 기반 추정치" : "KRX Open API (공식)";
  const latest = data?.latest;
  const rows = data?.rows ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
      <PageHeader
        title="국내 파생 & 투기세력 (KRX)"
        description="KOSPI200 선물 종가·미결제약정·베이시스 · 한국판 COT Index (계약수 기준)"
        actions={
          <Freshness
            collectedAt={data?.collectedAtKst}
            ageSeconds={data?.ageSeconds}
            stale={data?.stale}
            refreshError={futures.refreshError}
          />
        }
      />

      {!data?.available && (
        <Callout tone="warn">
          {data?.message ?? "KRX 선물 데이터가 없습니다. 수집기를 실행하세요."}
        </Callout>
      )}

      {data?.isEstimated && <Callout tone="danger">{data.estimateNotice}</Callout>}

      {latest && (
        <>
          <KpiStrip label="선물 요약" items={futuresTiles(latest, krxSource, Boolean(data?.isEstimated))} keepDates />

          {latest.changePctReported !== null &&
            latest.changePct !== null &&
            Math.abs((latest.changePctReported ?? 0) - (latest.changePct ?? 0)) > 0.05 && (
              <Callout tone="warn">
                KRX 보고 등락률({withMinusSign(formatPercent(latest.changePctReported))})과 종가 기반
                계산값({withMinusSign(formatPercent(latest.changePct))})이 다릅니다. 화면은 종가 계산값을
                사용합니다 — 데이터 저장소 상태 화면에서 교차 검증을 실행해 보세요.
              </Callout>
            )}
        </>
      )}

      {/*
        두 계열은 자릿수가 다릅니다 — 종가는 1,100 내외, 미결제약정은 30만 내외.
        한 축에 겹쳐 그리면 종가 선이 0에 눌려 완전히 납작해집니다(실제로 그렇게
        보였습니다). 축을 나누고, 어느 선이 어느 축인지 부제에 적습니다.
      */}
      <Panel
        title="선물 종가 및 미결제약정 추이" source={krxSource}
        subtitle="왼쪽 축: 선물 종가 · 오른쪽 축: 미결제약정(계약) — 자릿수가 달라 축을 나눠 그립니다."
      >
        <MultiLineSeries
          data={rows.map((row) => ({
            date: row.date,
            종가: row.futuresClose,
            미결제약정: row.openInterest,
          }))}
          series={[
            { key: "종가", name: "선물 종가 (좌)", color: SERIES_COLORS.blue, axis: "left" },
            {
              key: "미결제약정",
              name: "미결제약정(계약, 우)",
              color: SERIES_COLORS.orange,
              axis: "right",
            },
          ]}
          precision={1}
          rightPrecision={0}
          rightUnit=" 계약"
          height={300}
          ariaLabel="선물 종가(왼쪽 축)와 미결제약정(오른쪽 축, 계약) 추이"
        />
      </Panel>

      <Panel
        title="한국판 COT OI Index" source={SOURCES.krxDerived}
        subtitle="최근 20거래일 미결제약정 범위 내 위치(0~100). 100에 가까울수록 포지션이 역사적 최대 수준입니다."
      >
        <LineSeries
          data={rows.map((row) => ({ date: row.date, value: row.cotOiIndex }))}
          unit="%"
          color="#A371F7"
          height={240}
          ariaLabel="한국판 COT OI Index 추이(0~100)"
        />
      </Panel>

      <Panel
        title="투자주체별 선물 수급"
        source={trend.data?.source ?? "Daum 금융 투자주체별 매매동향 (비공식)"}
        subtitle={
          trend.data?.available
            ? `${trend.data.unit} 기준 · 기준일 ${trend.data.dataDate ?? EMPTY}`
            : undefined
        }
        actions={
          <span className="flex items-center gap-2">
            <Freshness refreshError={trend.refreshError} />
            {trend.data?.measure && (
              // measure는 소스의 코드값(CONTRACT·AMOUNT)입니다. 화면에는 뜻을 적습니다(QA-005).
              <SourceBadge>{MEASURE_LABELS[trend.data.measure] ?? trend.data.measure}</SourceBadge>
            )}
          </span>
        }
      >
        {trend.loading && !trend.data && <Loading />}
        {trend.error && <ErrorState message={trend.error} onRetry={trend.reload} />}
        {trend.data && !trend.data.available && (
          <Callout tone="warn">{trend.data.message ?? "투자주체별 수급 데이터가 없습니다."}</Callout>
        )}
        {trend.data?.available && (
          <>
            <SignedBars
              data={trend.data.rows.map((row) => ({
                name: row.investor.split(" ")[0],
                value: row.net20d,
              }))}
              unit="계약"
              ariaLabel={`투자주체별 KOSPI200 선물 20일 누적 순매수(${trend.data.unit ?? "계약"})`}
              height={300}
            />
            <div className="mt-4">
              <DataTable
                dense
                scrollHint="overflow"
                caption="투자주체별 선물 수급"
                rows={trend.data.rows}
                rowKey={(row) => row.investor}
                columns={[
                  { key: "investor", header: "투자 주체", rowHeader: true, className: "break-keep", cell: (row) => row.investor },
                  { key: "today", header: "당일 순매수", align: "right", cell: (row) => signed(row.netToday) },
                  { key: "d5", header: "5일 누적", align: "right", cell: (row) => signed(row.net5d) },
                  { key: "d20", header: "20일 누적", align: "right", cell: (row) => signed(row.net20d) },
                  { key: "stance", header: "포지션 성향", className: "break-keep", cell: (row) => stanceText(row.stance) },
                ]}
              />
            </div>
          </>
        )}
      </Panel>

      {/* 선물 수급만 보면 "헤지인지 방향성 베팅인지"를 알 수 없습니다. 같은 투자자의 현물 수급과 나란히 */}
      <SpotFuturesCard />

      <Panel
        title="장중 수급 가속도 (최근 30분)"
        subtitle="장중에만 값이 있습니다."
        source="Daum 금융 시간별 선물 수급 (비공식)"
        // 1분마다 다시 읽습니다. 실패하면 마지막 값이 '최근 30분'으로 남으므로 '새로 읽지 못함'을 붙입니다(QA-104).
        actions={<Freshness refreshError={intraday.refreshError} />}
      >
        {intraday.error && <ErrorState message={intraday.error} onRetry={intraday.reload} />}
        {intraday.data?.skipped && (
          <Callout>{intraday.data.message}</Callout>
        )}
        {intraday.data && !intraday.data.available && !intraday.data.skipped && (
          <Callout tone="warn">
            {intraday.data.message ?? "장중 수급 데이터를 받지 못했습니다(장 시간이 아닐 수 있습니다)."}
          </Callout>
        )}
        {intraday.data?.available && (
          <KpiStrip
            label="장중 수급 가속도"
            keepDates
            items={[
              {
                key: "foreign",
                label: "외국인 누적 순매수",
                value: signed(intraday.data.foreignCurrent),
                change: { change: intraday.data.foreignChange ?? null, digits: 0, caption: "최근 30분" },
              },
              {
                key: "institution",
                label: "기관계 누적 순매수",
                value: signed(intraday.data.institutionCurrent),
                change: { change: intraday.data.institutionChange ?? null, digits: 0, caption: "최근 30분" },
              },
              {
                key: "flow",
                label: "수급 방향",
                value: intraday.data.flowStatus ?? null,
                valueKind: "label",
                note: `${intraday.data.referenceTime ?? EMPTY} → ${intraday.data.latestTime ?? EMPTY} (${intraday.data.dataDate ?? EMPTY})`,
              },
            ]}
          />
        )}
      </Panel>

      <MarketTotalsCard />
    </div>
  );
}

/**
 * 증시 규모 — 시장별 시가총액·거래대금 합계 (금융위 공식 시세, 조 원).
 *
 * 지수는 가격만 보여 줍니다. 시가총액 합계는 신규 상장·증자까지 반영한 시장의
 * 크기이고, 거래대금은 참여 강도입니다. 거래소 확정치라 기준일 다음 영업일
 * 오후에 갱신됩니다(오늘 값은 없습니다).
 */
function MarketTotalsCard() {
  const { data, loading, error, reload } = useApi<KrMarketTotalsResponse>(endpoints.publicData.marketTotals(180));
  const markets = data?.markets ?? [];

  // 두 시장의 날짜를 합쳐 한 표로 만듭니다(날짜별로 값을 짝지음 — 배열 순서에 기대지 않음). 단위: 조 원.
  const chart = mergeByDate(markets.map((market) => ({
    key: `${market.market}_cap`,
    points: market.marketCap.map((point) => ({ date: point.date, value: point.value / 1e12 })),
  })));
  const latest = (market: string, key: "marketCap" | "tradingValue") =>
    markets.find((m) => m.market === market)?.[key].at(-1)?.value ?? null;

  return (
    <Panel
      title="증시 규모 — 시가총액 추이·거래대금 (금융위 공식)"
      source={data?.source ?? "금융위원회 주식시세정보 (공식)"}
      subtitle={data?.latestBasDt ? `기준일 ${data.latestBasDt} · 거래소 확정치, 다음 영업일 13시 이후 갱신` : undefined}
      actions={<Freshness collectedAt={data?.collectedAtKst} ageSeconds={data?.ageSeconds} stale={data?.stale} />}
    >
      {loading && !data && <Loading label="공식 시세를 불러오는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && <Callout>{data.message}</Callout>}
      {data?.available && (
        <>
          <div className="mb-3">
            <KpiStrip
              label="증시 규모"
              items={[
                { key: "kospiCap", label: "KOSPI 시가총액", value: krw(latest("KOSPI", "marketCap")) },
                { key: "kosdaqCap", label: "KOSDAQ 시가총액", value: krw(latest("KOSDAQ", "marketCap")) },
                { key: "kospiValue", label: "KOSPI 거래대금", value: krw(latest("KOSPI", "tradingValue")) },
                { key: "kosdaqValue", label: "KOSDAQ 거래대금", value: krw(latest("KOSDAQ", "tradingValue")) },
              ]}
            />
          </div>
          {chart.length > 1 ? (
            // 한 차트에는 한 가지 이야기만: 시장 크기(시가총액). 거래대금은 위 수치로 봅니다.
            // 두 시장의 규모 차이가 커서(약 5배) 코스닥을 오른쪽 축에 둡니다.
            <MultiLineSeries
              data={chart}
              unit="조"
              rightUnit="조"
              precision={0}
              rightPrecision={0}
              series={[
                { key: "KOSPI_cap", name: "KOSPI 시가총액", color: SERIES_COLORS.blue },
                { key: "KOSDAQ_cap", name: "KOSDAQ 시가총액 (오른쪽)", color: SERIES_COLORS.orange, axis: "right" },
              ]}
              ariaLabel="KOSPI(왼쪽 축)·KOSDAQ(오른쪽 축) 시가총액 추이(조 원)"
            />
          ) : (
            <p className="text-xs text-text-3">기준일이 하루뿐이라 추이는 이틀째부터 그려집니다.</p>
          )}
        </>
      )}
    </Panel>
  );
}

/** 원화 금액(조·억) — 모르면 null(타일이 '—'). */
const krw = (value: number | null) => (value === null ? null : formatKrw(value));

type FuturesLatest = NonNullable<KrxFuturesResponse["latest"]>;

/**
 * KPI 띠 '선물 요약' — 선물 종가(등락률 변화 칩)·미결제약정(증감 변화 칩, 단위 계약)·시장 베이시스·4대 국면 판정. 모르는 값은 '—'와 사유(베이시스 '데이터 미제공'),
 * 판정 불가는 중립 잉크(어느 쪽으로도 기울이지 않음). 추정치 모드면 타일마다 추정 배지(출처 글도 추정치로).
 */
function futuresTiles(latest: FuturesLatest, source: string, estimated: boolean): KpiItem[] {
  const undecided = latest.marketPhase?.includes("판정 불가") ?? false;
  return [
    {
      key: "close",
      label: "선물 종가",
      value: latest.futuresClose,
      format: (value) => formatNumber(value, 2),
      change: { changePct: latest.changePct, pctDigits: 2 },
      note: `${latest.contractName ?? EMPTY} · 기준일 ${latest.date ?? EMPTY}`,
      source,
      isEstimated: estimated,
    },
    {
      key: "oi",
      label: "미결제약정 (OI)",
      value: latest.openInterest,
      format: (value) => formatNumber(value, 0),
      change: { change: latest.oiChange, digits: 0, unit: "계약" },
      note: latest.oiChange5dAvg === null ? null : `5일 평균 증감 ${withMinusSign(formatSigned(latest.oiChange5dAvg, 0))}`,
      source,
      isEstimated: estimated,
    },
    {
      key: "basis",
      label: "시장 베이시스",
      value: latest.marketBasis,
      format: (value) => withMinusSign(formatNumber(value, 2)),
      emptyReason: "데이터 미제공",
      note: [latest.basisState, latest.basisNote].filter(Boolean).join(" · ") || null,
      source: `${source} — 선물 종가 − KOSPI200 지수`,
      isEstimated: estimated,
    },
    {
      key: "phase",
      label: "4대 국면 판정",
      value: latest.marketPhase ?? null,
      valueKind: "label",
      neutral: undecided,
      note: undecided ? "등락률을 모르면 어느 쪽으로도 기울이지 않습니다." : "가격 방향 × 미결제약정 증감",
      source: "대시보드 판정 — 선물 가격 방향 × 미결제약정 증감",
      // 추정치 선물로 낸 판정이면 판정도 추정치입니다.
      isEstimated: estimated,
    },
  ];
}
