"use client";

import { LineSeries, MultiLineSeries, SERIES_COLORS, SignedBars } from "@/components/charts";
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
import { useApi } from "@/hooks/useApi";
import { stanceText } from "@/lib/flows";
import { deltaColor, EMPTY, formatKrw, formatNumber, formatPercent, formatSigned } from "@/lib/format";
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
 */
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
    <div className="flex flex-col gap-6 lg:gap-8">
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
        <Banner tone="warn">
          {data?.message ?? "KRX 선물 데이터가 없습니다. 수집기를 실행하세요."}
        </Banner>
      )}

      {data?.isEstimated && <Banner tone="danger">{data.estimateNotice}</Banner>}

      {latest && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              label="선물 종가"
              source={krxSource}
              value={formatNumber(latest.futuresClose, 2)}
              delta={latest.changePct}
              deltaText={formatPercent(latest.changePct)}
              caption={
                <span className="flex flex-col gap-0.5">
                  <span>{latest.contractName}</span>
                  <span>기준일 {latest.date ?? EMPTY}</span>
                </span>
              }
            />
            <Metric
              label="미결제약정 (OI)"
              source={krxSource}
              value={formatNumber(latest.openInterest, 0)}
              delta={latest.oiChange}
              deltaText={
                latest.oiChange === null ? EMPTY : `${formatSigned(latest.oiChange, 0)} 계약`
              }
              caption={
                latest.oiChange5dAvg === null
                  ? undefined
                  : `5일 평균 증감 ${formatSigned(latest.oiChange5dAvg, 0)}`
              }
            />
            <Metric
              label="시장 베이시스"
              source={`${krxSource} — 선물 종가 − KOSPI200 지수`}
              value={latest.marketBasis === null ? "데이터 미제공" : formatNumber(latest.marketBasis, 2)}
              caption={latest.basisState}
              note={latest.basisNote}
              tone={latest.marketBasis === null ? "text-muted" : undefined}
            />
            <Metric
              label="4대 국면 판정"
              source="대시보드 판정 — 선물 가격 방향 × 미결제약정 증감"
              value={latest.marketPhase ?? EMPTY}
              tone={
                latest.marketPhase?.includes("판정 불가") ? "text-muted" : "text-bright"
              }
              caption={
                latest.marketPhase?.includes("판정 불가")
                  ? "등락률을 모르면 어느 쪽으로도 기울이지 않습니다."
                  : "가격 방향 × 미결제약정 증감"
              }
            />
          </div>

          {latest.changePctReported !== null &&
            latest.changePct !== null &&
            Math.abs((latest.changePctReported ?? 0) - (latest.changePct ?? 0)) > 0.05 && (
              <Banner tone="warn">
                KRX 보고 등락률({formatPercent(latest.changePctReported)})과 종가 기반
                계산값({formatPercent(latest.changePct)})이 다릅니다. 화면은 종가 계산값을
                사용합니다 — 데이터 저장소 상태 화면에서 교차 검증을 실행해 보세요.
              </Banner>
            )}
        </>
      )}

      {/*
        두 계열은 자릿수가 다릅니다 — 종가는 1,100 내외, 미결제약정은 30만 내외.
        한 축에 겹쳐 그리면 종가 선이 0에 눌려 완전히 납작해집니다(실제로 그렇게
        보였습니다). 축을 나누고, 어느 선이 어느 축인지 부제에 적습니다.
      */}
      <Card
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
        />
      </Card>

      <Card
        title="한국판 COT OI Index" source={SOURCES.krxDerived}
        subtitle="최근 20거래일 미결제약정 범위 내 위치(0~100). 100에 가까울수록 포지션이 역사적 최대 수준입니다."
      >
        <LineSeries
          data={rows.map((row) => ({ date: row.date, value: row.cotOiIndex }))}
          unit="%"
          color="#A371F7"
          height={240}
        />
      </Card>

      <Card
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
          <Banner tone="warn">{trend.data.message ?? "투자주체별 수급 데이터가 없습니다."}</Banner>
        )}
        {trend.data?.available && (
          <>
            <SignedBars
              data={trend.data.rows.map((row) => ({
                name: row.investor.split(" ")[0],
                value: row.net20d,
              }))}
              unit="계약"
              height={300}
            />
            <div className="mt-4">
              <Table
                rows={trend.data.rows}
                rowKey={(row) => row.investor}
                columns={[
                  { key: "investor", header: "투자 주체", render: (row) => row.investor },
                  {
                    key: "today",
                    header: "당일 순매수",
                    align: "right",
                    render: (row) => (
                      <span className={deltaColor(row.netToday, 0)}>
                        {formatSigned(row.netToday, 0)}
                      </span>
                    ),
                  },
                  {
                    key: "d5",
                    header: "5일 누적",
                    align: "right",
                    render: (row) => (
                      <span className={deltaColor(row.net5d, 0)}>{formatSigned(row.net5d, 0)}</span>
                    ),
                  },
                  {
                    key: "d20",
                    header: "20일 누적",
                    align: "right",
                    render: (row) => (
                      <span className={deltaColor(row.net20d, 0)}>{formatSigned(row.net20d, 0)}</span>
                    ),
                  },
                  { key: "stance", header: "포지션 성향", render: (row) => stanceText(row.stance) },
                ]}
              />
            </div>
          </>
        )}
      </Card>

      {/* 선물 수급만 보면 "헤지인지 방향성 베팅인지"를 알 수 없습니다. 같은 투자자의 현물 수급과 나란히 */}
      <SpotFuturesCard />

      <Card
        title="장중 수급 가속도 (최근 30분)"
        subtitle="장중에만 값이 있습니다."
        source="Daum 금융 시간별 선물 수급 (비공식)"
        // 1분마다 다시 읽습니다. 실패하면 마지막 값이 '최근 30분'으로 남으므로 '새로 읽지 못함'을 붙입니다(QA-104).
        actions={<Freshness refreshError={intraday.refreshError} />}
      >
        {intraday.error && <ErrorState message={intraday.error} onRetry={intraday.reload} />}
        {intraday.data?.skipped && (
          <Banner tone="info">{intraday.data.message}</Banner>
        )}
        {intraday.data && !intraday.data.available && !intraday.data.skipped && (
          <Banner tone="warn">
            {intraday.data.message ?? "장중 수급 데이터를 받지 못했습니다(장 시간이 아닐 수 있습니다)."}
          </Banner>
        )}
        {intraday.data?.available && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric
              label="외국인 누적 순매수"
              value={formatSigned(intraday.data.foreignCurrent ?? null, 0)}
              delta={intraday.data.foreignChange ?? null}
              deltaText={`최근 30분 ${formatSigned(intraday.data.foreignChange ?? null, 0)}`}
            />
            <Metric
              label="기관계 누적 순매수"
              value={formatSigned(intraday.data.institutionCurrent ?? null, 0)}
              delta={intraday.data.institutionChange ?? null}
              deltaText={`최근 30분 ${formatSigned(intraday.data.institutionChange ?? null, 0)}`}
            />
            <Metric
              label="수급 방향"
              value={intraday.data.flowStatus ?? EMPTY}
              caption={`${intraday.data.referenceTime ?? EMPTY} → ${
                intraday.data.latestTime ?? EMPTY
              } (${intraday.data.dataDate ?? EMPTY})`}
            />
          </div>
        )}
      </Card>

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
    <Card
      title="증시 규모 — 시가총액 추이·거래대금 (금융위 공식)"
      source={data?.source ?? "금융위원회 주식시세정보 (공식)"}
      subtitle={data?.latestBasDt ? `기준일 ${data.latestBasDt} · 거래소 확정치, 다음 영업일 13시 이후 갱신` : undefined}
      actions={<Freshness collectedAt={data?.collectedAtKst} ageSeconds={data?.ageSeconds} stale={data?.stale} />}
    >
      {loading && !data && <Loading label="공식 시세를 불러오는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && <Banner tone="info">{data.message}</Banner>}
      {data?.available && (
        <>
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="KOSPI 시가총액" value={formatKrw(latest("KOSPI", "marketCap"))} />
            <Metric label="KOSDAQ 시가총액" value={formatKrw(latest("KOSDAQ", "marketCap"))} />
            <Metric label="KOSPI 거래대금" value={formatKrw(latest("KOSPI", "tradingValue"))} />
            <Metric label="KOSDAQ 거래대금" value={formatKrw(latest("KOSDAQ", "tradingValue"))} />
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
            />
          ) : (
            <p className="text-xs text-muted">기준일이 하루뿐이라 추이는 이틀째부터 그려집니다.</p>
          )}
        </>
      )}
    </Card>
  );
}
