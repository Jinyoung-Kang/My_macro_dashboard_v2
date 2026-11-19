"use client";

import { radarBasis, radarIntervalLabel } from "@/lib/radar";
import { useState } from "react";
import { HorizontalBars } from "@/components/charts";
import { knownBars } from "@/lib/chartData";
import { ChangeCell, DataTable, InspectorFrame, InspectorTrigger } from "@/components/patterns";
import {
  Banner,
  Button,
  Card,
  ErrorState,
  Freshness,
  Loading,
  PageHeader,
  Panel,
  Select,
  SourceBadge,
} from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useSessionUser } from "@/hooks/useSessionUser";
import { isOwner } from "@/lib/access";
import { MarketFlowsPanel, StockFlowsPanel, useStockFlows } from "./FlowPanels";
import { ConsensusPanel, useConsensus } from "./ConsensusPanel";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { FundamentalsPanel, useFundamentals } from "./FundamentalsPanel";
import { HistoryPanel } from "./HistoryPanel";
import { OmittedNote } from "./OmittedNote";
import { RankingDetail, signedAmount } from "./RankingDetail";
import { formatNumber } from "@/lib/format";
import type { RadarResponse, RadarRow } from "@/lib/types";
import { endpoints } from "@/lib/endpoints";

/**
 * 외국인/기관 수급 레이더.
 *
 * 수집 순서(KIS → Daum → Naver → KRX 확정 저장본 → 토스 → 누적 이력)는 수집기가 관리하고,
 * 화면은 <b>어느 출처가 실제로 성공했는지</b>를 반드시 표시합니다. 누적 이력으로
 * 대체된 경우에는 "지금 시점의 수급이 아니다"라는 경고가 함께 떠야 합니다.
 *
 * 작업대 P7(실행 명세 §7 7행 '레이더: 조밀 표와 검사'): 순위는 막대 + 조밀 표 + 검사 칸 틀(InspectorFrame lg — 틀 52rem부터 옆 18rem, 그 아래는 위쪽 대화상자).
 * 검사 칸은 이 화면이 이미 읽는 응답 셋(수급 지속성·재무·공통 — 아래 패널들과 같은 응답)만 씁니다 — 세 읽기를 화면이 한 번씩 하고 패널과 검사 칸에 함께
 * 넘깁니다(요청 경로·횟수·간격 그대로 — moreWritesKeep, 검사 칸을 열어도 새 요청 0 — radarInspector).
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
  // 순위 종목의 수급 지속성·재무는 순위를 받았을 때만(예전처럼 패널이 그때만 그려져 읽던 것과 같음), 공통 순위는 늘 읽습니다.
  const rankedCodes = data?.available ? (data.rows ?? []).map((row) => row.code) : [];
  const flows = useStockFlows(rankedCodes);
  const fundamentals = useFundamentals(rankedCodes);
  const consensus = useConsensus({ market, tradeType, interval, topN });

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
    <div className="flex flex-col gap-6 lg:gap-8">
      <PageHeader
        title="외국인/기관 수급 레이더 (KRX)"
        description={<>폴백 체인: {(options.data?.fallbackChain ?? ["KIS(장중)", "Daum", "Naver", "KRX(확정 저장본)", "토스(공식)", "누적 이력"]).join(" → ")}</>}
        actions={
          <>
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
          </>
        }
      />

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
              label: radarIntervalLabel(value),
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
          <p className="mt-3 text-xs text-text-3">
            ⓘ {unsupportedInvestors.join(" · ")}는 <b>지원 안 함</b>입니다.{" "}
            {options.data?.unsupportedInvestorNote}
          </p>
        )}
        {/* 토스 폴백으로 여섯 모두 고를 수 있을 때도, 넷은 한계가 있는 순위라 적어 둡니다 */}
        {unsupportedInvestors.length === 0 && TOSS_ONLY.includes(investor) && options.data?.unsupportedInvestorNote && (
          <p className="mt-3 text-xs text-text-3">ⓘ {options.data.unsupportedInvestorNote}</p>
        )}
      </Card>

      {/* 종목 랭킹을 보기 전에 시장 전체의 방향부터 — 선택한 시장을 따릅니다 */}
      <MarketFlowsPanel market={market} />

      {loading && !data && <Loading label="수급 데이터를 불러오는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}

      {data?.warning && <Banner tone="warn">{data.warning}</Banner>}

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
        <Panel
          title={`${investor} ${tradeType} 상위 ${data.rows?.length ?? 0}개`}
          // 고른 기간이 아니라 응답이 밝힌 실제 기간·기준일을 적습니다(QA-396·397).
          subtitle={radarBasis(data)}
          source={data.source ?? undefined}
          actions={data.sourceKind ? <SourceBadge>출처: {data.sourceKind}</SourceBadge> : undefined}
        >
          <HorizontalBars
            data={chart.bars}
            unit="억"
            digits={0}
            valueName={`${investor} ${tradeType} 금액`}
            ariaLabel={`${market} ${investor} ${tradeType} 상위 종목 금액(억 원)`}
            height={Math.max(260, chart.bars.length * 26)}
          />
          <OmittedNote count={chart.omitted} />
          <div className="mt-3">
            <RankingTable
              rows={data.rows ?? []}
              tradeType={tradeType}
              source={data.source}
              flows={flows}
              fundamentals={fundamentals}
              consensus={consensus}
            />
          </div>
        </Panel>
      )}

      {/* 랭킹 종목이 "오늘만" 산 것인지 며칠째인지 — 토스증권 공식 종목별 매매동향 */}
      {data?.available && (data.rows?.length ?? 0) > 0 && (
        <StockFlowsPanel rows={(data.rows ?? []).map((row) => ({ code: row.code, name: row.name }))} flows={flows} />
      )}

      {data?.available && (data.rows?.length ?? 0) > 0 && (
        <FundamentalsPanel codes={(data.rows ?? []).map((row) => row.code)} fundamentals={fundamentals} />
      )}

      {/* 표 둘을 눈으로 대조하지 않아도 되게, 겹치는 종목만 따로 모읍니다.
          위 선택(시장·매매 구분·기간·표시 종목 수)을 그대로 따릅니다 —
          여기만 다른 조건으로 계산하면 같은 화면에서 숫자가 어긋납니다. */}
      <ConsensusPanel market={market} tradeType={tradeType} interval={interval} topN={topN} consensus={consensus} />

      <HistoryPanel market={market} investor={investor} tradeType={tradeType} />
    </div>
  );
}

/** Daum이 주지 않아 토스 공식 폴백으로만 받는 투자주체. */
const TOSS_ONLY = ["개인", "연기금", "금융투자", "투신"];

/** 순위 줄의 키 — 같은 종목이 두 번 오더라도 갈리게 순위를 붙입니다. */
const rankKey = (row: RadarRow) => `${row.code}-${row.rank}`;

/**
 * 순위 조밀 표 + 검사 칸. 줄 단추는 종목 이름(공용 줄 단추 — 중립 잉크, 좁은 화면 44px), 옆에 고정폭 코드(앞자리 0을 포함한 글 그대로).
 * 등락률은 오르내린 값이라 공용 변화 칸(▲▼·부호·sr 글), 순매수대금은 오르내린 값이 아니라 본문 잉크 + 부호(음수 −). 넓은 화면 옆 칸 배치에서는 첫 줄을
 * 처음에 보입니다(defaultKey — 새 요청 없음).
 */
function RankingTable({
  rows,
  tradeType,
  source,
  flows,
  fundamentals,
  consensus,
}: {
  rows: readonly RadarRow[];
  tradeType: string;
  source: string | null | undefined;
  flows: ReturnType<typeof useStockFlows>;
  fundamentals: ReturnType<typeof useFundamentals>;
  consensus: ReturnType<typeof useConsensus>;
}) {
  const byKey = new Map(rows.map((row) => [rankKey(row), row]));
  return (
    <InspectorFrame
      label="순위 종목"
      layout="lg"
      titleOf={(key) => byKey.get(key)?.name ?? null}
      defaultKey={rows.length > 0 ? rankKey(rows[0]) : null}
      inspectorHint="종목 이름을 고르면 이 칸에 수급 지속성·재무·공통 순위가 나옵니다."
      renderDetail={(key) => {
        const row = byKey.get(key);
        return row ? (
          <RankingDetail row={row} tradeType={tradeType} source={source} flows={flows} fundamentals={fundamentals} consensus={consensus} />
        ) : null;
      }}
    >
      {(inspector) => (
        <DataTable
          dense
          count
          caption="순위 상세"
          rows={rows}
          rowKey={rankKey}
          selectedKey={inspector.shownKey}
          scrollHint="overflow"
          columns={[
            { key: "rank", header: "순위", align: "right", cell: (row) => row.rank },
            {
              key: "name",
              header: "종목",
              rowHeader: true,
              className: "break-keep",
              cell: (row) => (
                <span className="inline-flex flex-wrap items-baseline gap-x-2">
                  <InspectorTrigger inspector={inspector} itemKey={rankKey(row)}>
                    {row.name}
                  </InspectorTrigger>
                  <span className="font-mono text-caption text-text-3">{row.code}</span>
                </span>
              ),
            },
            { key: "price", header: "현재가", align: "right", cell: (row) => (row.price === null ? null : formatNumber(row.price, 0)) },
            { key: "changePct", header: "등락률", align: "right", cell: (row) => <ChangeCell changePct={row.changePct} /> },
            { key: "net", header: "순매수대금(억)", align: "right", cell: (row) => signedAmount(row.netAmountEok, 1) },
          ]}
        />
      )}
    </InspectorFrame>
  );
}
