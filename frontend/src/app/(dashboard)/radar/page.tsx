"use client";

import { stableCodesKey } from "@/lib/transforms";
import { historySelection, sortBySourceOrder, sourceLabel, splitFundamentals } from "@/lib/radar";
import { useState } from "react";
import { HorizontalBars } from "@/components/charts";
import { knownBars } from "@/lib/chartData";
import {
  Banner,
  Button,
  Card,
  ErrorState,
  Freshness,
  Loading,
  Metric,
  Select,
  SourceBadge,
  Table,
} from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useSessionUser } from "@/hooks/useSessionUser";
import { isOwner } from "@/lib/access";
import { MarketFlowsPanel, StockFlowsPanel } from "./FlowPanels";
import { deltaColor, EMPTY, formatKrw, formatNumber, formatPercent, formatWithUnit } from "@/lib/format";
import type {
  DiagnosticsResponse,
  KrFundamentalsResponse,
  RadarConsensusResponse,
  RadarResponse,
} from "@/lib/types";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";

/**
 * 📡 외국인/기관 수급 레이더.
 *
 * 수집 순서(KIS → Daum → Naver → LS → PyKrx → 누적 이력)는 수집기가 관리하고,
 * 화면은 <b>어느 출처가 실제로 성공했는지</b>를 반드시 표시합니다. 누적 이력으로
 * 대체된 경우에는 "지금 시점의 수급이 아니다"라는 경고가 함께 떠야 합니다.
 */
export default function RadarPage() {
  const options = useApi<{
    markets: string[];
    investors: string[];
    /** 지금 실제로 받을 수 있는 투자주체. 나머지는 고를 수 없게 막습니다. */
    supportedInvestors?: string[];
    unsupportedInvestorNote?: string;
    tradeTypes: string[];
    intervals: string[];
    /** 수집기의 실제 체인 순서 (백엔드가 내려줌 — 화면에 따로 적어 두면 어긋납니다) */
    fallbackChain?: string[];
  }>(endpoints.positioning.radarOptions);

  const [market, setMarket] = useState("KOSPI");
  const [investor, setInvestor] = useState("외국인");
  const [tradeType, setTradeType] = useState("순매수");
  const [interval, setInterval] = useState("TODAY");
  const [topN, setTopN] = useState("30");
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  // 연결 진단은 운영자 전용 경로입니다(백엔드 403). 회원·데모 방문자가 눌러 봐야 빈 카드만 남았으므로(QA-098)
  // 셸(왼쪽 내비·더보기)의 수동 새로고침처럼 운영자에게만 버튼을 보입니다. 사용자를 아직 모르면(세션 응답 전) 숨깁니다.
  const owner = isOwner(useSessionUser());

  const query = endpoints.positioning.radarRanking({ market, investor, tradeType, intervalType: interval, topN });

  const { data, loading, error, reload, refreshError } = useApi<RadarResponse>(query, 60_000);

  const unsupportedInvestors = (options.data?.investors ?? []).filter(
    (value) => options.data?.supportedInvestors && !options.data.supportedInvestors.includes(value),
  );

  // 사용자가 "상위 30개"를 골랐는데 차트만 15개를 그리면, 표와 개수가 어긋나
  // 무엇이 빠졌는지 알 수 없습니다. 고른 만큼 그립니다(차트 높이가 늘어납니다).
  // 금액을 모르는 종목은 0억 막대로 그리지 않고 빼며, 뺀 개수를 차트 아래에 적습니다.
  const chart = knownBars(
    data?.rows ?? [],
    (row) => row.name,
    (row) => row.netAmountEok,
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-bright">외국인/기관 수급 레이더 (KRX)</h1>
          <p className="mt-1 text-xs text-muted">
            폴백 체인: {(options.data?.fallbackChain ?? ["KIS(장중)", "Daum", "Naver", "LS", "토스(공식)", "PyKrx", "누적 이력"]).join(" → ")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Freshness
            collectedAt={data?.collectedAtKst}
            ageSeconds={data?.ageSeconds}
            stale={data?.stale}
            refreshError={refreshError}
          />
          <Button onClick={reload}>새로고침</Button>
          {owner && (
            <Button onClick={() => setShowDiagnostics((value) => !value)}>
              {showDiagnostics ? "진단 닫기" : "데이터 소스 연결 테스트"}
            </Button>
          )}
        </div>
      </header>

      {owner && showDiagnostics && <DiagnosticsPanel />}

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label="시장"
            value={market}
            onChange={setMarket}
            options={(options.data?.markets ?? ["KOSPI"]).map((value) => ({ value, label: value }))}
          />
          <Select
            label="투자 주체"
            value={investor}
            onChange={setInvestor}
            options={(options.data?.investors ?? ["외국인"]).map((value) => {
              // 목록에는 남기고 고를 수만 없게 합니다. 조용히 사라지면
              // "원래 있던 항목이 왜 없지?"가 되고, 고를 수 있게 두면
              // "수급 데이터를 얻지 못했습니다"만 보게 됩니다.
              const supported =
                !options.data?.supportedInvestors ||
                options.data.supportedInvestors.includes(value);
              return {
                value,
                label: supported ? value : `${value} (지원 안 함)`,
                disabled: !supported,
              };
            })}
          />
          <Select
            label="매매 구분"
            value={tradeType}
            onChange={setTradeType}
            options={(options.data?.tradeTypes ?? ["순매수"]).map((value) => ({
              value,
              label: value,
            }))}
          />
          <Select
            label="조회 기간"
            value={interval}
            onChange={setInterval}
            options={(options.data?.intervals ?? ["TODAY"]).map((value) => ({
              value,
              label: { TODAY: "당일", DAYS_5: "5거래일", DAYS_20: "20거래일" }[value] ?? value,
            }))}
          />
          <Select
            label="표시 종목 수"
            value={topN}
            onChange={setTopN}
            options={["10", "20", "30", "50"].map((value) => ({ value, label: `상위 ${value}개` }))}
          />
        </div>

        {unsupportedInvestors.length > 0 && (
          <p className="mt-3 text-[11px] text-muted">
            ⓘ {unsupportedInvestors.join(" · ")}는 <b>지원 안 함</b>입니다.{" "}
            {options.data?.unsupportedInvestorNote}
          </p>
        )}
        {/* 토스 폴백으로 여섯 모두 고를 수 있을 때도, 넷은 한계가 있는 순위라 적어 둡니다 */}
        {unsupportedInvestors.length === 0 && TOSS_ONLY.includes(investor) && options.data?.unsupportedInvestorNote && (
          <p className="mt-3 text-[11px] text-muted">ⓘ {options.data.unsupportedInvestorNote}</p>
        )}
      </Card>

      {/* 종목 랭킹을 보기 전에 시장 전체의 방향부터 — 선택한 시장을 따릅니다 */}
      <MarketFlowsPanel market={market} />

      {loading && !data && <Loading label="수급 데이터를 불러오는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}

      {data?.warning && <Banner tone="warn">⚠️ {data.warning}</Banner>}

      {data && !data.available && !data.warning && (
        <Banner tone="warn">
          <div>{data.message ?? "수급 데이터를 얻지 못했습니다."}</div>
          {/* 소스별 사유를 함께 보여 줍니다.
              "수집기 상태를 확인하세요" 한 줄만 있으면, 수집기가 멀쩡한
              경우(다른 조합은 잘 나오는 경우) 엉뚱한 곳을 보게 됩니다. */}
          {data.reasons && data.reasons.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs">
              {data.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </Banner>
      )}

      {data?.available && (
        <>
          <Card
            title={`${investor} ${tradeType} 상위 ${data.rows?.length ?? 0}개`}
            source={data.source ?? undefined}
            actions={
              data.sourceKind ? <SourceBadge>출처: {data.sourceKind}</SourceBadge> : undefined
            }
          >
            <HorizontalBars
              data={chart.bars}
              unit="억"
              digits={0}
              valueName={`${investor} ${tradeType} 금액`}
              height={Math.max(260, chart.bars.length * 26)}
            />
            <OmittedNote count={chart.omitted} />
          </Card>

          <Card title="상세 목록" source={data.source ?? undefined}>
            <Table
              rows={data.rows}
              rowKey={(row) => `${row.code}-${row.rank}`}
              columns={[
                { key: "rank", header: "순위", render: (row) => row.rank },
                {
                  key: "name",
                  header: "종목",
                  render: (row) => (
                    <span className="flex flex-col">
                      <span className="text-body">{row.name}</span>
                      {/* 종목코드는 앞자리 0을 포함한 문자열 그대로 표시합니다. */}
                      <span className="text-[11px] text-muted">{row.code}</span>
                    </span>
                  ),
                },
                {
                  key: "price",
                  header: "현재가",
                  align: "right",
                  render: (row) => formatNumber(row.price, 0),
                },
                {
                  key: "changePct",
                  header: "등락률",
                  align: "right",
                  render: (row) => (
                    <span className={deltaColor(row.changePct)}>
                      {formatPercent(row.changePct)}
                    </span>
                  ),
                },
                {
                  key: "net",
                  header: "순매수대금(억)",
                  align: "right",
                  render: (row) => (
                    <span className={deltaColor(row.netAmountEok, 1)}>
                      {formatNumber(row.netAmountEok, 1)}
                    </span>
                  ),
                },
              ]}
            />
          </Card>
        </>
      )}

      {/* 랭킹 종목이 "오늘만" 산 것인지 며칠째인지 — 토스증권 공식 종목별 매매동향 */}
      {data?.available && (data.rows?.length ?? 0) > 0 && (
        <StockFlowsPanel rows={(data.rows ?? []).map((row) => ({ code: row.code, name: row.name }))} />
      )}

      {data?.available && (data.rows?.length ?? 0) > 0 && (
        <FundamentalsPanel codes={(data.rows ?? []).map((row) => row.code)} />
      )}

      {/* 표 둘을 눈으로 대조하지 않아도 되게, 겹치는 종목만 따로 모읍니다.
          위 선택(시장·매매 구분·기간·표시 종목 수)을 그대로 따릅니다 —
          여기만 다른 조건으로 계산하면 같은 화면에서 숫자가 어긋납니다. */}
      <ConsensusPanel
        market={market}
        tradeType={tradeType}
        interval={interval}
        topN={topN}
      />

      <HistoryPanel market={market} investor={investor} tradeType={tradeType} />
    </div>
  );
}

/** Daum이 주지 않아 토스 공식 폴백으로만 받는 투자주체. */
const TOSS_ONLY = ["개인", "연기금", "금융투자", "투신"];


/** 금액을 몰라 차트에서 뺀 종목 수. 표에는 그대로 "—"로 남아 있습니다. */
function OmittedNote({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <p className="mt-2 text-xs text-muted">
      금액을 모르는 {count}개 종목은 차트에서 뺐습니다(아래 표에 &quot;{EMPTY}&quot;로 표시).
    </p>
  );
}

function DiagnosticsPanel() {
  const { data, loading, error, reload } = useApi<DiagnosticsResponse>(endpoints.positioning.radarDiagnostics);

  return (
    <Card
      title="데이터 소스 연결 진단" source="각 소스를 화면이 쓰는 경로 그대로 실제 호출 (수집기)"
      subtitle="화면이 실제로 쓰는 경로를 그대로 호출합니다."
      actions={<Button onClick={reload}>다시 검사</Button>}
    >
      {loading && !data && <Loading />}
      {/* 진단 자체가 실패하면(백엔드 5xx·연결 끊김) 빈 카드가 아니라 이유와 다시 시도를 보입니다(QA-098). */}
      {error && !data && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && <Banner tone="warn">{data.message}</Banner>}
      {data?.sources && (
        <Table
          rows={sortBySourceOrder(data.sources)}
          rowKey={(row) => row.name}
          columns={[
            { key: "name", header: "소스 (체인 순서)", render: (row) => sourceLabel(row.name) },
            {
              key: "status",
              header: "상태",
              render: (row) => (
                <span className={row.ok ? "text-ok" : "text-danger"}>
                  {row.ok ? "✅ 정상" : "❌ 실패"}
                </span>
              ),
            },
            { key: "stage", header: "단계", render: (row) => <SourceBadge>{row.stage}</SourceBadge> },
            { key: "message", header: "메시지", render: (row) => row.message },
          ]}
        />
      )}
    </Card>
  );
}

/**
 * 📡 외국인·기관이 <b>같은 방향</b>으로 움직인 종목.
 *
 * <p>한쪽만 사는 종목과 둘이 함께 사는 종목은 뜻이 다릅니다. 예전에는 투자
 * 주체를 바꿔 가며 표 둘을 띄워 놓고 눈으로 겹치는 종목을 찾아야 했습니다.
 *
 * <p><b>이 표가 볼 수 없는 것</b> — 두 <b>상위 N개 목록의 교집합</b>입니다.
 * 소스(Daum)가 상위 목록만 주고 전체 종목의 수급은 주지 않기 때문에, 외국인
 * 상위 N 밖에서 사들인 종목은 기관이 1위로 샀더라도 여기 나오지 않습니다.
 * 표시 종목 수를 늘리면 그만큼 넓게 봅니다. 이 한계는 카드에도 적습니다.
 */
/**
 * 📑 순매수 종목의 재무 체크 (DART 사업보고서).
 *
 * 수급은 "누가 샀나"만 말합니다. 같은 순매수라도 부채가 많거나 이익이 줄고
 * 있는 회사라면 해석이 달라지므로 공시 재무를 옆에 둡니다. 비율은 백엔드가
 * 계산하고(analytics/KrFundamentals), 화면은 그대로 보여 주기만 합니다.
 */
function FundamentalsPanel({ codes }: { codes: string[] }) {
  // 순서를 정렬해 키를 고정합니다. 랭킹 순서만 바뀌어도 다시 요청하지 않게.
  const key = stableCodesKey(codes);
  const { data, loading, error, reload } = useApi<KrFundamentalsResponse>(
    key ? endpoints.publicData.fundamentals(key) : null,
  );
  const { all, rows, empty, covered } = splitFundamentals(codes, data?.companies ?? []);

  const percent = (value: number | null | undefined) =>
    value === null || value === undefined ? EMPTY : `${formatNumber(value, 1)}%`;
  const multiple = (value: number | null | undefined) =>
    value === null || value === undefined ? EMPTY : `${formatNumber(value, 1)}배`;

  return (
    <Card
      title="재무·밸류에이션 체크 (DART 사업보고서 + 금융위 공식 시세)"
      source="금융감독원 Open DART 사업보고서 주요계정 (공식) · 금융위원회 주식시세정보 (공식, 시가총액)"
      subtitle="부채비율 = 부채총계÷자본총계 · 증가율은 전년 대비 · ROE = 순이익÷기말 자본 · PER·PBR = 시가총액÷직전 사업연도 순이익·자본"
      actions={
        <Freshness collectedAt={data?.collectedAtKst} ageSeconds={data?.ageSeconds} stale={data?.stale} />
      }
    >
      {loading && !data && <Loading label="공시 재무를 불러오는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && <Banner tone="info">{data.message}</Banner>}

      {(data?.available || data?.priceDate) && (
        <>
          <p className="mb-2 text-xs text-muted">
            {covered}/{all.length}개 종목 재무 확보 · ETF·ETN·스팩은 DART 재무 대상이 아닙니다 ·
            이자보상배율은 주요계정에 이자비용이 없어 표시하지 않습니다
            {data.priceDate ? ` · 시가총액 기준일 ${data.priceDate} (재무와 시점이 다름)` : " · 공식 시세 없음 → PER·PBR 생략"}
          </p>
          {empty.length > 0 && (
            <p className="mb-2 text-xs text-muted">
              재무·시세 모두 없음 {empty.length}개 (ETF·신규 상장·수집 전):{" "}
              {empty.slice(0, 10).map((row) => row.name ?? row.code).join(", ")}
              {empty.length > 10 ? " 외" : ""}
            </p>
          )}
          {rows.length > 0 && (
            <Table
              rows={rows}
              rowKey={(row) => row.code}
              columns={[
                {
                  key: "name",
                  header: "종목",
                  render: (row) => (
                    <span className="flex flex-col">
                      <span className="text-body">{row.name ?? row.code}</span>
                      <span className="text-[11px] text-muted">
                        {row.available ? `${row.bsnsYear} ${row.fsLabel}` : "재무 없음"}
                      </span>
                    </span>
                  ),
                },
                {
                  key: "debt",
                  header: "부채비율",
                  align: "right",
                  render: (row) =>
                    row.capitalImpaired ? <span className="text-down">자본잠식</span> : percent(row.debtRatio),
                },
                { key: "rev", header: "매출 증가", align: "right", render: (row) => (
                  <span className={deltaColor(row.revenueGrowth)}>{percent(row.revenueGrowth)}</span>
                ) },
                { key: "op", header: "영업이익 증가", align: "right", render: (row) =>
                  row.operatingTurn ? (
                    <span className={row.operatingTurn === "흑자전환" ? "text-up" : "text-down"}>{row.operatingTurn}</span>
                  ) : (
                    <span className={deltaColor(row.operatingIncomeGrowth)}>{percent(row.operatingIncomeGrowth)}</span>
                  ),
                },
                { key: "margin", header: "영업이익률", align: "right", render: (row) => percent(row.operatingMargin) },
                { key: "roe", header: "ROE", align: "right", render: (row) => percent(row.roe) },
                { key: "cap", header: "시가총액", align: "right", render: (row) => formatKrw(row.marketCap) },
                { key: "per", header: "PER", align: "right", render: (row) => multiple(row.per) },
                { key: "pbr", header: "PBR", align: "right", render: (row) => multiple(row.pbr) },
                {
                  key: "link",
                  header: "공시",
                  align: "right",
                  render: (row) =>
                    row.dartUrl ? (
                      <a href={row.dartUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-6 min-w-6 items-center justify-center px-1 text-accent underline">
                        원문
                      </a>
                    ) : (
                      EMPTY
                    ),
                },
              ]}
            />
          )}
        </>
      )}
    </Card>
  );
}

function ConsensusPanel({
  market,
  tradeType,
  interval,
  topN,
}: {
  market: string;
  tradeType: string;
  interval: string;
  topN: string;
}) {
  const { data, loading, error, reload, refreshError } = useApi<RadarConsensusResponse>(
    endpoints.positioning.radarConsensus({ market, tradeType, intervalType: interval, topN }),
    60_000,
  );

  const buying = tradeType === "순매수";
  const rows = data?.rows ?? [];
  const top = knownBars(
    rows.slice(0, 15),
    (row) => row.name,
    (row) => row.totalEok,
  );

  return (
    <Card
      title={`외국인·기관 공통 ${tradeType}`} source={data?.sources?.length ? data.sources.join(" · ") : "외국인·기관 순위와 같은 출처 (위 순위 카드 참고)"}
      subtitle={data?.note}
      actions={
        <Freshness
          collectedAt={data?.collectedAtKst}
          ageSeconds={data?.ageSeconds}
          stale={data?.stale}
          refreshError={refreshError}
        />
      }
    >
      {loading && !data && <Loading label="교집합을 계산하는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}

      {data?.warning && <Banner tone="warn">⚠️ {data.warning}</Banner>}

      {data && !data.available && (
        <Banner tone="warn">
          <div>{data.message ?? "공통 종목이 없습니다."}</div>
          {data.reasons && data.reasons.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs">
              {data.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </Banner>
      )}

      {rows.length > 0 && (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <Metric
              label={`공통 ${tradeType} 종목`}
              value={`${rows.length}개`}
              caption={`외국인 ${data?.foreignCount ?? EMPTY}개 · 기관 ${
                data?.institutionCount ?? EMPTY
              }개 목록의 교집합`}
            />
            <Metric
              label="합산 금액 1위"
              value={rows[0]?.name ?? EMPTY}
              caption={formatWithUnit(rows[0]?.totalEok, 1, "억 원")}
            />
            <Metric
              label="집중도"
              value={`${formatNumber((rows.length / Number(topN)) * 100, 0)}%`}
              caption={`상위 ${topN}개 중 겹친 비율 — 높을수록 두 주체가 같은 종목을 봅니다.`}
            />
          </div>

          <HorizontalBars
            data={top.bars}
            unit="억"
            digits={0}
            valueName={`외국인+기관 합산 ${tradeType} 금액`}
            height={Math.max(260, top.bars.length * 26)}
          />
          <OmittedNote count={top.omitted} />

          <div className="mt-4">
            <Table
              rows={rows}
              rowKey={(row) => row.code}
              columns={[
                {
                  key: "name",
                  header: "종목",
                  render: (row) => (
                    <span className="flex flex-col">
                      <span className="text-body">{row.name}</span>
                      <span className="text-[11px] text-muted">{row.code}</span>
                    </span>
                  ),
                },
                {
                  key: "changePct",
                  header: "등락률",
                  align: "right",
                  render: (row) => (
                    <span className={deltaColor(row.changePct)}>
                      {formatPercent(row.changePct)}
                    </span>
                  ),
                },
                {
                  key: "foreign",
                  header: "외국인(억)",
                  align: "right",
                  render: (row) => (
                    <span className="flex flex-col items-end">
                      <span className={deltaColor(row.foreignEok, 1)}>
                        {formatNumber(row.foreignEok, 1)}
                      </span>
                      <span className="text-[11px] text-muted">
                        {row.foreignRank === null ? EMPTY : `${row.foreignRank}위`}
                      </span>
                    </span>
                  ),
                },
                {
                  key: "institution",
                  header: "기관(억)",
                  align: "right",
                  render: (row) => (
                    <span className="flex flex-col items-end">
                      <span className={deltaColor(row.institutionEok, 1)}>
                        {formatNumber(row.institutionEok, 1)}
                      </span>
                      <span className="text-[11px] text-muted">
                        {row.institutionRank === null ? EMPTY : `${row.institutionRank}위`}
                      </span>
                    </span>
                  ),
                },
                {
                  key: "total",
                  header: "합산(억)",
                  align: "right",
                  render: (row) => (
                    <span className={`font-semibold ${deltaColor(row.totalEok, 1)}`}>
                      {formatNumber(row.totalEok, 1)}
                    </span>
                  ),
                },
              ]}
            />
          </div>

          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            {buying
              ? "두 주체가 함께 담은 종목입니다. 한쪽만 사는 종목보다 수급의 방향이 뚜렷하지만, 그것이 수익을 뜻하지는 않습니다."
              : "두 주체가 함께 던진 종목입니다. 금액이 음수인 것은 순매도라는 뜻이며, 표기를 바꾸지 않았습니다."}{" "}
            출처: {(data?.sources ?? []).join(" · ") || "출처 미상"}
          </p>
        </>
      )}
    </Card>
  );
}

function HistoryPanel({
  market,
  investor,
  tradeType,
}: {
  market: string;
  investor: string;
  tradeType: string;
}) {
  const [date, setDate] = useState("");
  // 고른 거래일 하루치만 받습니다(latest=true — 날짜를 안 골랐으면 이 조건의 가장 최근 거래일).
  // 예전에는 전 기간을 받아 화면에서 30행만 골랐습니다(1년치 합성 데이터: 7,800행·2.3MB).
  const { data, loading, error, reload } = useApi<{
    dates: string[];
    obsDate?: string | null;
    note: string;
    rows: { obsDate: string; code: string; name: string; netAmountEok: number }[];
  }>(
    endpoints.positioning.radarHistory({ market, investor, tradeType, obsDate: date }),
  );

  const { dates, selectedDate, dateOptions, rows } = historySelection(date, data);

  return (
    <Card
      title="누적 수급 이력" source={SOURCES.radarHistory}
      subtitle={data?.note}
      actions={
        dates.length > 0 ? (
          <Select
            label="거래일"
            value={selectedDate}
            onChange={setDate}
            options={dateOptions.map((value) => ({ value, label: value }))}
          />
        ) : undefined
      }
    >
      {loading && !data && <Loading />}
      {/* 조회가 실패했으면 '이력 없음'이 아니라 실패입니다(QA-046). */}
      {error && <ErrorState message={error} onRetry={reload} />}
      {!loading && !error && dates.length === 0 && (
        <Banner tone="info">
          아직 누적된 이력이 없습니다. 수집기를 꾸준히 돌리면 거래일별로 쌓입니다 —
          Naver·Daum·KRX는 과거 날짜 조회를 지원하지 않으므로 이 이력이 곧 백업입니다.
        </Banner>
      )}
      {rows.length > 0 && (
        <Table
          rows={rows}
          rowKey={(row, index) => `${row.code}-${index}`}
          columns={[
            { key: "code", header: "종목코드", render: (row) => row.code },
            { key: "name", header: "종목명", render: (row) => row.name },
            {
              key: "net",
              header: "순매수대금(억)",
              align: "right",
              render: (row) => (
                <span className={deltaColor(row.netAmountEok, 1)}>
                  {formatNumber(row.netAmountEok, 1)}
                </span>
              ),
            },
          ]}
        />
      )}
      {!loading && dates.length > 0 && rows.length === 0 && (
        <p className="text-xs text-muted">{EMPTY} 해당 조건의 이력이 없습니다.</p>
      )}
    </Card>
  );
}
