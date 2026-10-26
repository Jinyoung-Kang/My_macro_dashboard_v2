"use client";

import { Fragment, type ReactNode, useState } from "react";
import { Banner, Button, Card, ErrorState, Freshness, Loading, Table } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useElapsedSeconds } from "@/hooks/useElapsedSeconds";
import { apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { deltaColor, EMPTY, formatNumber, formatPercent, formatWithUnit } from "@/lib/format";
import {
  type Badge,
  collectionView,
  criteriaText,
  eligibilityBadge,
  filingSpanText,
  formatCoverage,
  formatExcessPoints,
  groupBCriteria,
  PAPER_SOURCES,
  periodCoverageText,
  periodsText,
  type PoolRow,
  poolWeightNote,
  quartersText,
  rerankResultView,
  selectedBadge,
  type SelectionHistoryRow,
  selectionHistoryRows,
  signalPoolRows,
  trackMetricLabel,
  trackRecordLimits,
  trackRecordRows,
  trackSourceText,
  windowLabel,
} from "@/lib/paper";
import type {
  PaperRerankResult,
  PaperTrackRecordCandidate,
  PaperTrackRecordCollection,
  PaperTrackRecordGroupB,
  PaperTrackRecordPeriod,
  PaperTrackRecordResponse,
} from "@/lib/types";

/** 후보 표의 칸 하나. ui의 Table과 같은 모양이지만, 행 아래에 구간 표를 펼쳐야 해서 표를 이 파일이 그립니다. */
interface Column {
  key: string;
  header: ReactNode;
  align?: "left" | "right";
  /** 마우스를 올리면 보이는 칸 설명. */
  title?: string;
  render: (row: PaperTrackRecordCandidate) => ReactNode;
}

/**
 * 기관 선정 탭 — 두 기관 그룹(D27)의 13F 트랙레코드(공시일 기준 복제 수익률)와 순위·자격·선정, 신호 풀(기관 가중), 선정 이력,
 * 수집 진행률. 그룹 A는 후보 기관의 7년 롤링, 그룹 B는 기존 13F 메뉴 기관의 최근 2년 창이고 표 모양은 같습니다(그룹 B는 출처 칸).
 *
 * 숫자는 전부 백엔드(TrackRecord13F·PaperSelectionService)가 계산한 값이고, 이 화면은 고르고 이름 붙여 그리기만 합니다(ADR 0004).
 * 커버리지를 수익률보다 먼저(왼쪽) 둡니다 — 복제 수익률은 티커가 붙은 보유분만으로 낸 값이라, 커버리지를 보지 않고 수익률부터 읽으면
 * 그 기관의 수익률로 오해합니다(명세 §2 "커버리지를 결과보다 먼저").
 *
 * 계산이 아직 없으면(computed:false) 수집 진행률만 보입니다. "지금 재계산"은 같은 기준일의 순위만 다시 내고 선정은 바꾸지 않습니다.
 */
export function SelectionSection() {
  const { data, loading, error, reload, refreshError } = useApi<PaperTrackRecordResponse>(endpoints.paper.trackRecord(), 300_000);
  // 본문은 늘 보냅니다 — asOf가 없으면 서버가 마지막 완료 세션으로 계산합니다(본문을 아예 빼면 서버의 본문 처리에 기대게 됨).
  const rerank = useAsyncAction(
    () => apiPost<PaperRerankResult>(endpoints.paper.runRerank, {}),
    "트랙레코드를 다시 계산하지 못했습니다.",
  );
  const elapsed = useElapsedSeconds(rerank.busy);
  const [open, setOpen] = useState<string[]>([]);

  const runRerank = async () => {
    if (await rerank.run()) void reload();
  };
  // 펼친 행은 "그룹:CIK"로 기억합니다 — 두 그룹에 모두 든 기관(예: 듀케인)을 한쪽에서 펼치면 다른 쪽까지 펼쳐지지 않게.
  const toggle = (key: string) =>
    setOpen((current) => (current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]));

  if (loading && !data) return <Loading label="트랙레코드를 읽는 중…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;
  if (!data.available) return <Banner tone="warn">{data.message ?? "트랙레코드를 읽을 수 없습니다."}</Banner>;

  const progress = collectionView(data.collection);
  const rerankButton = (
    <Button onClick={() => void runRerank()} disabled={rerank.busy}>
      {rerank.busy ? `계산 중… ${elapsed}초` : "지금 재계산"}
    </Button>
  );
  // 결과·오류가 없으면 null — 빈 조각을 넘기면 카드에 빈 여백 칸이 생깁니다.
  const rerankFeedback = rerank.error || rerank.result ? (
    <>
      {rerank.error && <Banner tone="warn">{rerank.error}</Banner>}
      {rerank.result && <RerankResult result={rerank.result} />}
    </>
  ) : null;

  if (data.computed === false) {
    return (
      <>
        <Banner tone="info">
          트랙레코드를 아직 계산하지 않았습니다. 후보 기관의 13F 분기 공시를 모으는 중이며, 다 모이면 초기 선정 때 계산합니다.
          <p className="mt-1 text-xs">
            지금 계산해 보려면 &quot;지금 재계산&quot;을 누르세요 — 수집이 덜 끝난 기관은 &quot;수집 중&quot;으로 자격에서 빠지고, 선정은 바꾸지 않습니다.
          </p>
        </Banner>
        <CollectionCard collection={data.collection} line={progress.line} actions={rerankButton} refreshError={refreshError}>
          {rerankFeedback}
        </CollectionCard>
      </>
    );
  }

  const candidates = trackRecordRows(data.candidates);
  const criteria = criteriaText(data.criteria);
  const groupB = data.groupB ?? null;
  // 선정 이력은 신호 풀(A 뒤에 B에만 있는 기관)이라 두 그룹 후보 모두에서 이름을 찾습니다(그룹 A 이름이 먼저).
  const history = selectionHistoryRows(data.selectionHistory, [...(data.candidates ?? []), ...(groupB?.candidates ?? [])]);
  const limits = trackRecordLimits(data.limits, groupB, data.windowYears);

  return (
    <>
      <Card
        title={`그룹 A — 후보 기관 트랙레코드 (${windowLabel(data.windowYears)})`}
        subtitle={[
          `${data.asOfDate ?? EMPTY} 기준`,
          `순위 기준 ${trackMetricLabel(data.metric)}`,
          criteria ? `자격: ${criteria}` : null,
        ].filter(Boolean).join(" · ")}
        source={PAPER_SOURCES.trackRecord}
        actions={
          <>
            <Freshness refreshError={refreshError} />
            {rerankButton}
          </>
        }
      >
        {rerankFeedback && <div className="mb-3 flex flex-col gap-2">{rerankFeedback}</div>}
        <p className="mb-3 text-xs leading-relaxed text-muted">
          수익률은 공시를 본 다음 거래일 종가에 사서 다음 공시의 다음 거래일까지 든 <strong>복제 수익률</strong>이고, 티커가 붙은
          보유(커버 보유분)만으로 냅니다 — 커버리지가 100% 미만이면 &quot;커버 보유분 기준&quot;입니다. 행의 &quot;구간 펼치기&quot;로 분기마다의
          값을 봅니다.
        </p>
        <CandidateTable
          group="A"
          rows={candidates}
          windowYears={data.windowYears ?? null}
          targetQuarters={progress.targetQuarters}
          open={open}
          onToggle={toggle}
        />
      </Card>

      {groupB && (
        <GroupBCard
          groupB={groupB}
          asOfDate={data.asOfDate ?? null}
          criteria={criteriaText(groupBCriteria(groupB, data.criteria))}
          open={open}
          onToggle={toggle}
        />
      )}

      {(groupB || (data.pool ?? []).length > 0) && (
        <PoolCard
          rows={signalPoolRows(data.pool)}
          asOfDate={data.selectedAsOfDate ?? null}
          groupWeightA={data.groupWeightA ?? null}
        />
      )}

      {limits.length > 0 && (
        <Card title="트랙레코드의 한계" source={PAPER_SOURCES.trackRecord}>
          <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed text-body">
            {limits.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ol>
        </Card>
      )}

      <Card
        title="선정 이력"
        subtitle="선정은 재선정일(분기 13F 공시 기한 다음 거래일)과 초기 선정 때 한 번씩 남깁니다. 수동 재계산은 선정을 바꾸지 않습니다."
        source={PAPER_SOURCES.selection}
      >
        <Table<SelectionHistoryRow>
          rows={history}
          rowKey={(row) => row.asOfDate}
          emptyMessage="아직 선정 기록이 없습니다 — 초기 선정은 규칙 계좌 초기화 때, 그 뒤는 재선정일마다 남습니다."
          columns={[
            { key: "asOf", header: "기준일", render: (row) => row.asOfDate },
            { key: "names", header: "선정 기관", render: (row) => <span className="text-xs text-body">{row.names}</span> },
          ]}
        />
      </Card>

      <CollectionCard collection={data.collection} line={progress.line} />
    </>
  );
}

/**
 * 그룹 B 카드 — 기존 13F 메뉴 기관을 그룹 A와 같은 방법으로 짧은 창에서 잰 트랙레코드. 표 모양은 그룹 A와 같고, 수집 칸 대신
 * 출처(q30·q8) 칸입니다 — 그룹 B는 30분기 수집이 끝났는지와 상관없이 있는 저장본으로 재므로 "수집 중"이 뜻이 없습니다.
 */
function GroupBCard({
  groupB,
  asOfDate,
  criteria,
  open,
  onToggle,
}: {
  groupB: PaperTrackRecordGroupB;
  asOfDate: string | null;
  criteria: string | null;
  open: readonly string[];
  onToggle: (key: string) => void;
}) {
  const span = windowLabel(groupB.windowYears);
  return (
    <Card
      title={`그룹 B — 기존 13F 메뉴 기관 트랙레코드 (${span})`}
      subtitle={[
        `${asOfDate ?? EMPTY} 기준`,
        `순위 기준 ${trackMetricLabel(groupB.metric ?? null)}`,
        criteria ? `자격: ${criteria}` : null,
        typeof groupB.topN === "number" ? `상위 ${groupB.topN}곳 선정` : null,
      ].filter(Boolean).join(" · ")}
      source={PAPER_SOURCES.groupB}
    >
      <p className="mb-3 text-xs leading-relaxed text-muted">
        이미 지켜보던 &quot;기관 13F 포트폴리오 분석&quot; 메뉴의 기관을 그룹 A와 같은 방법(공시 다음 거래일 복제, 수정주가)으로
        잽니다. 출처 q30은 후보 수집 저장본(CUSIP 매핑 티커), q8은 기존 메뉴 저장본(이름 매핑 티커)입니다. 인덱스·연기금은 덮인
        대형주 쪽만 보여 복제 수익률이 부풀기 쉬워, 수익률이 높아도 커버리지 기준에서 빠질 수 있습니다.{" "}
        <strong className="text-warn">그룹 B는 {typeof groupB.windowYears === "number" ? span : "짧은 창"} — 표본이 짧다</strong>
        (아래 한계 참고).
      </p>
      <CandidateTable
        group="B"
        rows={trackRecordRows(groupB.candidates)}
        windowYears={groupB.windowYears ?? null}
        targetQuarters={null}
        open={open}
        onToggle={onToggle}
      />
    </Card>
  );
}

/** 신호 풀 카드 — 선정 기준일의 그룹 A ∪ B와 기관 가중(선정 때 값). 화면은 가중을 다시 계산하지 않습니다. */
function PoolCard({ rows, asOfDate, groupWeightA }: { rows: PoolRow[]; asOfDate: string | null; groupWeightA: number | null }) {
  return (
    <Card
      title="신호 풀"
      subtitle={asOfDate
        ? `${asOfDate} 선정 — 규칙 계좌가 이 기관들의 13F 변화를 신호로 씁니다(다음 재선정일까지)`
        : "규칙 계좌가 13F 신호를 읽는 기관(두 그룹의 선정)"}
      source={PAPER_SOURCES.pool}
    >
      <p className="mb-3 text-xs leading-relaxed text-muted">{poolWeightNote(groupWeightA)}</p>
      <section aria-label="신호 풀 표">
        <Table<PoolRow>
          rows={rows}
          rowKey={(row) => row.key}
          emptyMessage="신호 풀이 없습니다 — 이 기준일에 유효한 선정이 아직 없거나, 선정 때 자격 있는 기관이 없었습니다."
          columns={[
            {
              key: "name",
              header: "기관",
              render: (row) => (
                <div className="flex flex-col">
                  <span className="font-semibold text-bright">{row.name}</span>
                  <span className="text-[11px] text-muted">CIK {row.cik}</span>
                </div>
              ),
            },
            {
              key: "group",
              header: "그룹",
              render: (row) => (row.group ? <Badges badges={[row.group]} /> : <span className="text-muted">{EMPTY}</span>),
            },
            { key: "rankA", header: "그룹 A 순위", align: "right", render: (row) => row.rankA },
            { key: "rankB", header: "그룹 B 순위", align: "right", render: (row) => row.rankB },
            { key: "weight", header: "기관 가중", align: "right", render: (row) => row.weight },
          ]}
        />
      </section>
    </Card>
  );
}

/** 수집 진행률 카드. 계산 전 화면에서는 재계산 버튼과 그 결과를 이 카드에 둡니다. */
function CollectionCard({
  collection,
  line,
  actions,
  refreshError,
  children,
}: {
  collection: PaperTrackRecordCollection | null | undefined;
  line: string;
  actions?: ReactNode;
  refreshError?: string | null;
  children?: ReactNode;
}) {
  return (
    <Card
      title="수집 진행률"
      subtitle="후보 기관마다 13F 분기 공시를 7년 창 + 공시 지연 여유만큼 받습니다. 수집기가 실행마다 정해진 공시 수만큼 받아 이어 채웁니다."
      source={PAPER_SOURCES.collection}
      actions={(actions || refreshError) && (
        <>
          <Freshness refreshError={refreshError} />
          {actions}
        </>
      )}
    >
      <p className={`text-sm ${collection ? "text-body" : "text-muted"}`}>{line}</p>
      {children && <div className="mt-3 flex flex-col gap-2">{children}</div>}
    </Card>
  );
}

function RerankResult({ result }: { result: PaperRerankResult }) {
  const view = rerankResultView(result);
  return <Banner tone={view.tone}>{view.text}</Banner>;
}

/**
 * 후보 표. 칸 순서: 순위 · 기관 · 자격 · 선정 · 수집(그룹 B는 출처) · 구간 · 커버리지(최소·평균) · 수익률·통계 —
 * 커버리지가 수익률보다 왼쪽입니다. 행의 "구간 펼치기"는 그 행 바로 아래에 구간 표를 엽니다.
 * 그룹 B 행은 기관 칸에 기존 13F 메뉴의 설명을 적습니다(없으면 분류).
 */
function CandidateTable({
  group,
  rows,
  windowYears,
  targetQuarters,
  open,
  onToggle,
}: {
  group: "A" | "B";
  rows: PaperTrackRecordCandidate[];
  windowYears: number | null;
  targetQuarters: number | null;
  open: readonly string[];
  onToggle: (key: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted">
        {group === "A"
          ? "후보 기관이 없습니다 — 수집기의 후보 목록(sec.13f.track_record_index)이 비어 있습니다."
          : "그룹 B 후보가 없습니다 — 기존 13F 메뉴 기관의 저장본(q30·q8)이 아직 없거나 이 기준일에 계산하지 않았습니다."}
      </p>
    );
  }
  const openKey = (row: PaperTrackRecordCandidate) => `${group}:${row.cik}`;
  const span = windowLabel(windowYears);

  const columns: Column[] = [
    { key: "rank", header: "순위", align: "right", render: (row) => (row.rank === null ? EMPTY : formatNumber(row.rank, 0)) },
    {
      key: "name",
      header: "기관",
      render: (row) => {
        const expanded = open.includes(openKey(row));
        const about = group === "B" ? (row.desc ?? row.style) : row.style;
        return (
          <div className="flex min-w-[12rem] flex-col items-start gap-1">
            <span className="font-semibold text-bright">{row.name}</span>
            <span className="text-[11px] text-muted">{about ?? EMPTY} · CIK {row.cik}</span>
            <Button variant="ghost" expanded={expanded} onClick={() => onToggle(openKey(row))}>
              {expanded ? "구간 접기" : "구간 펼치기"}
            </Button>
          </div>
        );
      },
    },
    {
      key: "eligible",
      header: "자격",
      render: (row) => (
        <div className="flex min-w-[9rem] flex-col items-start gap-1">
          <Badges badges={[eligibilityBadge(row, group)]} />
          {!row.eligible && row.ineligibleReason && <span className="text-[11px] leading-snug text-warn">{row.ineligibleReason}</span>}
        </div>
      ),
    },
    {
      key: "selected",
      header: "선정",
      render: (row) => {
        const badge = selectedBadge(row);
        return badge ? <Badges badges={[badge]} /> : <span className="text-muted">{EMPTY}</span>;
      },
    },
    group === "A"
      ? { key: "quarters", header: "수집", render: (row) => <span className="whitespace-nowrap">{quartersText(row, targetQuarters)}</span> }
      : {
        key: "source",
        header: "출처",
        title: "q30 = 후보 수집 저장본(CUSIP 매핑 티커), q8 = 기존 13F 메뉴 저장본(8분기, 이름 매핑 티커)",
        render: (row) => {
          const source = trackSourceText(row);
          return <span className="whitespace-nowrap" title={source.title}>{source.label}</span>;
        },
      },
    {
      key: "periods",
      header: "구간",
      align: "right",
      title: `수익률이 있는 구간 / ${span} 안의 구간`,
      render: (row) => (
        <div className="flex flex-col items-end">
          <span>{periodsText(row)}</span>
          <span className="whitespace-nowrap text-[11px] text-muted">{filingSpanText(row)}</span>
        </div>
      ),
    },
    {
      key: "coverageMin",
      header: "커버리지 최소",
      align: "right",
      title: "창 안 구간 중 가장 낮은 커버리지(티커·가격이 있는 평가액 / 총평가액)",
      render: (row) => formatCoverage(row.coverageMin),
    },
    { key: "coverageAvg", header: "커버리지 평균", align: "right", render: (row) => formatCoverage(row.coverageAvg) },
    {
      key: "cagr",
      header: "CAGR",
      align: "right",
      render: (row) => <span className={deltaColor(row.cagrPct)}>{formatPercent(row.cagrPct)}</span>,
    },
    { key: "cum", header: "누적", align: "right", render: (row) => formatPercent(row.cumReturnPct) },
    { key: "spyCum", header: "SPY 누적", align: "right", render: (row) => formatPercent(row.spyCumReturnPct) },
    {
      key: "excess",
      header: "초과(SPY 대비)",
      align: "right",
      render: (row) => <span className={deltaColor(row.excessVsSpyPct)}>{formatExcessPoints(row.excessVsSpyPct)}</span>,
    },
    { key: "vol", header: "변동성(연율)", align: "right", render: (row) => formatWithUnit(row.volPct, 2, "%") },
    { key: "mdd", header: "MDD", align: "right", render: (row) => formatPercent(row.mddPct) },
    { key: "sharpe", header: "샤프", align: "right", render: (row) => formatNumber(row.sharpe, 2) },
  ];
  const align = (column: Column) => (column.align === "right" ? "text-right" : "text-left");

  return (
    <>
      <p className="mb-1 text-[11px] text-muted sm:hidden">← 표를 좌우로 넘겨 보세요</p>
      <div
        className="overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label={group === "A" ? "후보 기관 트랙레코드 표 (좌우 스크롤)" : "그룹 B 기관 트랙레코드 표 (좌우 스크롤)"}
      >
        <table className="w-full min-w-[1100px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
              {columns.map((column) => (
                <th key={column.key} title={column.title} className={`px-3 py-2 font-medium ${align(column)}`}>
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Fragment key={row.cik}>
                <tr className="border-b border-border/50 align-top hover:bg-surface-hover/60" aria-label={`${row.name}${group === "B" ? " (그룹 B)" : ""}`}>
                  {columns.map((column) => (
                    <td key={column.key} className={`px-3 py-2 tabular-nums ${align(column)}`}>
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
                {open.includes(openKey(row)) && (
                  <tr className="border-b border-border/50 bg-canvas">
                    <td colSpan={columns.length} className="px-3 py-3">
                      <PeriodTable name={`${row.name}${group === "B" ? " (그룹 B)" : ""}`} span={span} periods={row.periods ?? []} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** 한 기관의 구간 표 — 공시마다 언제 사서 언제 팔았는지, 커버리지, 복제 수익률과 같은 기간의 SPY. */
function PeriodTable({ name, span, periods }: { name: string; span: string; periods: PaperTrackRecordPeriod[] }) {
  return (
    <section aria-label={`${name} 구간`} className="flex flex-col gap-2">
      <p className="text-xs text-muted">
        {name} — 공시 다음 거래일 종가에 사서 다음 공시의 다음 거래일 종가까지(마지막 구간은 기준일까지). 첫 구간은 {span} 시작으로
        자릅니다. 수익률이 &quot;—&quot;인 구간은 커버된 보유가 없어 누적·통계에서 뺐습니다.
      </p>
      <Table<PaperTrackRecordPeriod>
        rows={periods}
        rowKey={(period, index) => `${period.filingDate}-${index}`}
        emptyMessage={`${span} 안의 구간이 없습니다.`}
        columns={[
          { key: "filingDate", header: "공시일", render: (period) => period.filingDate },
          { key: "reportDate", header: "보고 분기", render: (period) => period.reportDate },
          { key: "start", header: "시작", render: (period) => period.start },
          { key: "end", header: "끝", render: (period) => period.end },
          { key: "coverage", header: "커버리지", align: "right", render: (period) => periodCoverageText(period) },
          {
            key: "return",
            header: "수익률",
            align: "right",
            render: (period) => <span className={deltaColor(period.returnPct)}>{formatPercent(period.returnPct)}</span>,
          },
          { key: "spy", header: "SPY", align: "right", render: (period) => formatPercent(period.spyReturnPct) },
        ]}
      />
    </section>
  );
}

function Badges({ badges }: { badges: Badge[] }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {badges.map((badge) => (
        <span
          key={badge.key}
          title={badge.title}
          className={`whitespace-nowrap rounded-sm border px-1.5 py-px text-[10px] ${badge.className}`}
        >
          {badge.label}
        </span>
      ))}
    </span>
  );
}
