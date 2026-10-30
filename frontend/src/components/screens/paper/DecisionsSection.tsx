"use client";

import { Fragment, type ReactNode, useState } from "react";
import { Banner, Button, Card, ErrorState, Freshness, Loading, Select, Table } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useElapsedSeconds } from "@/hooks/useElapsedSeconds";
import { useMinuteClock } from "@/hooks/useMinuteClock";
import { apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, formatKst, formatWithUnit } from "@/lib/format";
import {
  type Badge,
  bookOptions,
  candidatesNote,
  claude2CheckpointLine,
  claude2WindowLines,
  CLAUDE_COST_NOTE,
  claudeDecisionView,
  type ClosedSignalRow,
  type ContributionRow,
  decisionBookNote,
  decisionBooks,
  decisionKindLabel,
  decisionMeta,
  decisionOrdersText,
  decisionRunBlocked,
  decisionStatusBadge,
  DECISION_VIEWS,
  type DecisionViewKey,
  formatRatioPercent,
  isTimedBook,
  jsonTitle,
  orderReasonText,
  orderSizeText,
  orderStatusBadge,
  PAPER_SOURCES,
  type PoolRow,
  prettyJson,
  pricesFinalText,
  type RankingRow,
  resolveDecisionBook,
  ruleDecisionView,
  runDecisionResultView,
  selectedBadge,
  sideClass,
  sideLabel,
  type SignalCandidateRow,
  type SignalEventRow,
  type SkippedRow,
  timingLabel,
} from "@/lib/paper";
import {
  krDecisionBookNote,
  krDecisionExtras,
  krDecisionKindLabel,
  krDecisionRunBlocked,
  krDecisionWindowText,
  krLatestJudgedGates,
  krManualDecisionNote,
  krPricesFinalText,
  krRuleDecisionView,
  krStartRecords,
} from "@/lib/paperKr";
import type { PaperMarketCode } from "@/lib/paperMarket";
import type {
  PaperBookSummary,
  PaperDecisionDetailResponse,
  PaperDecisionsResponse,
  PaperDecisionSummary,
  PaperJobRun,
  PaperOrder,
  PaperRunDecisionResult,
  PaperSettingsResponse,
  PaperStatusResponse,
} from "@/lib/types";
import { Claude2CheckpointLine, Claude2WindowList } from "./Claude2StartSection";
import { ClaudeDecisionBody } from "./ClaudeDecisionBody";
import { GateIndicatorBody } from "./GateIndicatorBody";
import { KrGateTable, KrRuleDecisionBody } from "./KrRuleDecisionBody";
import { ReviewsSection } from "./ReviewsSection";

/** 결정 목록에 보일 최근 건수. */
const RECENT_LIMIT = 50;

/**
 * 결정 로그 탭 — 책(규칙·Claude)을 골라 거래일마다의 결정 기록을 봅니다. 행을 펼치면 그 결정의 상세(규칙 책: 선정·신호 풀·13F 신호
 * 이벤트·매수 후보와 점수 기여·매도 신호·주문·고르지 못한 후보·게이트 참고, Claude 책: 판단·제안 주문·검증·사용량·입력 패킷)를 그때
 * 읽습니다 — 목록 50건의 상세를 미리 다 읽으면 신호 이벤트·패킷이 수백 줄씩 붙어 탭이 무거워집니다.
 *
 * Claude 책의 '지금 결정 실행'은 Claude를 한 번 부르므로(비용·하루 호출 상한) 확인 단계를 한 번 거칩니다.
 *
 * 숫자는 결정 기록(서버 계산) 그대로이고, 화면은 기관 이름을 붙이고 표로 늘어놓기만 합니다(ADR 0004). 책 목록은 개요 응답에서
 * 받습니다(page.tsx) — 수동 결정이 성공하면 이 탭의 목록과 개요(onChanged)를 함께 다시 읽습니다(결정이 주문을 내면 책 카드가 바뀜).
 *
 * 탭 맨 위의 '결정 기록 · 주간 복기'로 Claude 계좌의 주간 복기({@link ReviewsSection}, 2단계 D)를 봅니다 — 복기는 계좌를 고르지 않습니다
 * (Claude 계좌만). 복기가 낸 제안을 누르면 프레임 탭으로 옮겨 그 제안을 강조합니다(onOpenProposal, page.tsx).
 *
 * <b>한국</b>(`market` "KR", 2단계 명세 §4-16 F2): 계좌는 kr_rules·kr_claude, 수동 결정은 kr_claude만(확인 창에 수동 호출 문턱·결정 창 —
 * POST run/decision?market=KR). 상세는 한국 규칙 계좌 본문(KrRuleDecisionBody — 여섯 게이트·기한 지남·선정·보유 매도 판정)과 Claude 본문에 한국
 * 칸(게이트·기한 지남 건너뜀·출발·사건 줄)을 더하고, 결정 목록 아래 '출발·게이트 기록'(상태 응답 작업 기록)을 둡니다.
 */
export function DecisionsSection({
  books,
  onChanged,
  initialBook = "",
  onOpenProposal,
  market = "US",
}: {
  books: PaperBookSummary[];
  onChanged: () => void;
  /** 처음 고를 계좌 코드(개요의 계좌 상세에서 넘어올 때). 목록에 없으면 기본 계좌로 엽니다. */
  initialBook?: string;
  /** 주간 복기의 제안 링크 — 프레임 탭으로 옮겨 그 제안을 강조합니다. */
  onOpenProposal?: (id: number) => void;
  /** 화면의 시장 — 한국은 한국 계좌·수동 결정 경로(?market=KR)·한국 상세. 미국 화면은 예전 그대로. */
  market?: PaperMarketCode;
}) {
  const korea = market === "KR";
  const [view, setView] = useState<DecisionViewKey>("decisions");
  const [picked, setPicked] = useState(initialBook);
  const code = resolveDecisionBook(picked, books);
  const list = useApi<PaperDecisionsResponse>(code ? endpoints.paper.decisions(code, RECENT_LIMIT) : null, 60_000);

  const run = useAsyncAction(
    (book: string) => apiPost<PaperRunDecisionResult>(
      korea ? endpoints.paper.market("KR").runDecision : endpoints.paper.runDecision, { book },
    ),
    "결정을 내지 못했습니다.",
  );
  const elapsed = useElapsedSeconds(run.busy);
  // 버튼 결과는 그 책을 보고 있을 때만 — 다른 책으로 바꾼 뒤 옛 책의 결과가 새 책 이름 아래 남지 않게(보유 탭과 같음).
  const [ranFor, setRanFor] = useState<string | null>(null);
  const [open, setOpen] = useState<number[]>([]);
  // Claude 책 수동 결정의 확인 단계 — 어느 책에서 열었는지(책을 바꾸면 닫힌 것으로 봄).
  const [confirmingFor, setConfirmingFor] = useState<string | null>(null);
  // 한국 — 출발·게이트 기록(작업 기록)과 수동 호출 문턱(호출 사용량), 확인 창의 결정 창(설정). 🧪 미국 Claude 계좌2를 고르면 — 결정 창 세 줄(상태 응답
  // claude2 묶음: 다음 결정·개장 전 컷오프·이번 결정 주기 호출 / 상한 — 출발 뒤에는 출발 카드가 없어 여기서 봄, 화면 점검 권장 ⓐ).
  const timed = !korea && isTimedBook(code);
  const status = useApi<PaperStatusResponse>(
    korea ? endpoints.paper.market("KR").status : timed ? endpoints.paper.status : null, 60_000,
  );
  // 분 시계 — 다음 결정 시각이 지났으면 '결정 창 열림'(출발 카드와 같은 줄, lib/paper claude2WindowLines).
  const now = useMinuteClock();
  const settings = useApi<PaperSettingsResponse>(korea && confirmingFor !== null && confirmingFor === code
    ? endpoints.paper.settings : null);

  if (!code) {
    return (
      <Banner tone="info">
        {korea
          ? "결정을 내는 한국 계좌가 아직 없습니다 — 출발일이 정해지면 개요 탭의 '한국 초기화'로 규칙·Claude 계좌가 생깁니다(쉬는 사유는 위 경고)."
          : "결정을 내는 계좌가 아직 없습니다 — 개요 탭에서 초기화하면 규칙 계좌·Claude 계좌가 생깁니다."}
      </Banner>
    );
  }

  const views = (
    <div role="group" aria-label="결정 로그 보기" className="inline-flex w-fit overflow-hidden rounded-md border border-border">
      {DECISION_VIEWS.map((entry) => {
        const active = entry.key === view;
        return (
          <button
            key={entry.key}
            type="button"
            aria-pressed={active}
            onClick={() => setView(entry.key)}
            // 7탭 바와 같은 모양 — 고른 것은 surface-2 바탕 + 굵게(색만으로 고름을 전하지 않음, aria-pressed가 읽어 줌).
            className={`px-3 py-1.5 text-xs transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ${
              active ? "bg-surface-2 font-semibold text-text" : "text-text-2 hover:bg-surface-2 hover:text-text"
            }`}
          >
            {entry.label}
          </button>
        );
      })}
    </div>
  );
  if (view === "reviews") {
    return (
      <>
        {views}
        <ReviewsSection onOpenProposal={onOpenProposal} market={market} books={books} />
      </>
    );
  }

  const book = books.find((entry) => entry.code === code) ?? null;
  const blocked = korea ? krDecisionRunBlocked(book) : decisionRunBlocked(book);
  const runView = run.result && ranFor === code ? runDecisionResultView(run.result) : null;
  const runError = run.error && ranFor === code ? run.error : null;
  const claude = book?.kind === "CLAUDE";
  const confirming = claude && confirmingFor === code;
  // 한국 규칙 계좌는 수동 결정이 없어 단추를 그리지 않습니다(막힌 까닭은 아래 안내).
  const showRun = !korea || claude;
  const statusJobs = status.data?.available ? (status.data.jobs ?? []) : null;
  const manualLimit = status.data?.available ? (status.data.apiUsage?.today?.manualLimit ?? null) : null;
  const windowLines = timed && status.data?.available && status.data.claude2 ? claude2WindowLines(status.data.claude2, now) : null;

  const runNow = async () => {
    setRanFor(code);
    const ok = await run.run(code);
    setConfirmingFor(null);
    if (ok) {
      void list.reload();
      onChanged();
    }
  };
  const toggle = (id: number) =>
    setOpen((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));

  return (
    <>
      {views}
      <Card
        title="결정"
        source={korea ? PAPER_SOURCES.krDecisions : PAPER_SOURCES.decisions}
        actions={<Freshness refreshError={list.refreshError} />}
      >
        <div className="flex flex-wrap items-end gap-4">
          <Select
            label="계좌 고르기"
            value={code}
            onChange={(value) => {
              setPicked(value);
              setOpen([]);
            }}
            options={bookOptions(decisionBooks(books))}
          />
          {showRun && (
            <Button
              onClick={() => (claude ? setConfirmingFor(code) : void runNow())}
              disabled={run.busy || blocked !== null || confirming}
            >
              {run.busy ? `결정 중… ${elapsed}초` : "지금 결정 실행"}
            </Button>
          )}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted">{korea ? krDecisionBookNote(book?.kind) : decisionBookNote(book?.kind, book?.code)}</p>
        {windowLines && <Claude2WindowList lines={windowLines} className="mt-3" />}
        {windowLines && <Claude2CheckpointLine line={claude2CheckpointLine(status.data?.available ? status.data.claude2 : null)} />}
        {timed && status.error && <p className="mt-2 text-xs text-warn">계좌2 결정 창을 읽지 못했습니다 — {status.error}</p>}
        {blocked && showRun && <p className="mt-2 text-xs text-warn">{blocked}</p>}
        {confirming && (
          <div className="mt-3 flex flex-col gap-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-3">
            <p className="text-sm leading-relaxed text-warn">Claude를 지금 부를까요? {CLAUDE_COST_NOTE}</p>
            {korea && (
              <p className="text-xs leading-relaxed text-warn">
                {krManualDecisionNote(manualLimit, krDecisionWindowText(settings.data?.available ? settings.data.body : null))}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={() => void runNow()} disabled={run.busy}>
                {run.busy ? `결정 중… ${elapsed}초` : "결정 실행 확인"}
              </Button>
              <Button onClick={() => setConfirmingFor(null)} disabled={run.busy}>취소</Button>
            </div>
          </div>
        )}
        {runError && <div className="mt-3"><Banner tone="warn">{runError}</Banner></div>}
        {runView && <div className="mt-3"><Banner tone={runView.tone}>{runView.text}</Banner></div>}
      </Card>

      <Card
        title={`결정 기록 (최근 ${RECENT_LIMIT}건)`}
        subtitle={korea
          ? "KR 거래일마다 종류별로 한 건(같은 세션 다시 돌아도 새로 만들지 않음). 행의 '상세 펼치기'로 자료 게이트·기한 지남·선정·주문을 봅니다."
          : "거래일마다 종류별로 한 건(같은 날 다시 돌아도 새로 만들지 않음). 행의 '상세 펼치기'로 선정·신호·주문·게이트(참고)를 봅니다."}
        source={korea ? PAPER_SOURCES.krDecisions : PAPER_SOURCES.decisions}
      >
        {list.loading && !list.data && <Loading label="결정 기록을 읽는 중…" />}
        {list.error && <ErrorState message={list.error} onRetry={list.reload} />}
        {list.data && !list.data.available && <Banner tone="warn">{list.data.message ?? "결정 기록을 읽을 수 없습니다."}</Banner>}
        {list.data?.available && (
          <DecisionTable rows={list.data.decisions ?? []} open={open} onToggle={toggle} showExposure={claude} market={market} />
        )}
      </Card>

      {korea && (
        <KrStartRecordsCard
          jobs={statusJobs}
          loading={status.loading && !status.data}
          error={status.error}
          onRetry={status.reload}
        />
      )}
    </>
  );
}

/**
 * 한국 출발·게이트 기록(작업 기록 — 상태 응답 최근 30건): 출발 기록(`kr.decision` 상세 `start:true` — 기다림·미룸·오류·출발)의 미룬 날·사유·과금
 * 호출(결정 행 없이 과금된 Claude 호출)·시도 번호와, 그 세션 마지막 게이트 판정(규칙 계좌 몫 rulesGates·Claude 계좌 몫 claudeGates — 기한 지남 행이
 * 다시 읽는 칸). 값은 기록 그대로입니다.
 */
function KrStartRecordsCard({
  jobs,
  loading,
  error,
  onRetry,
}: {
  jobs: readonly PaperJobRun[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const records = krStartRecords(jobs);
  const judged = krLatestJudgedGates(jobs);
  return (
    <Card
      title="출발·게이트 기록"
      subtitle="작업 기록(최근 30건)의 출발 기록 — 출발이 자료를 기다리거나 미뤄진 세션·사유·과금 호출(결정 행 없이 과금된 호출 — 사용량에 셈)과, 그 세션 마지막 자료 게이트 판정입니다."
      source={`${PAPER_SOURCES.krDecisions} · ${PAPER_SOURCES.jobs}`}
    >
      {loading && <Loading label="작업 기록을 읽는 중…" />}
      {error && <ErrorState message={error} onRetry={onRetry} />}
      {jobs && (
        <div className="flex flex-col gap-4">
          {records.length === 0 ? (
            <p className="text-sm text-text-3">출발 기록이 없습니다 — 출발일 밤 결정 창에서 출발이 자료를 기다리거나 미뤄지면 여기에 남습니다.</p>
          ) : (
            <ul aria-label="출발 기록" className="flex flex-col gap-1.5 text-xs">
              {records.map((record) => (
                <li key={record.key} className="leading-relaxed text-body">
                  <span className="whitespace-nowrap font-semibold text-bright">{record.at} {record.outcome}</span>
                  {record.parts.length > 0 && <span> · {record.parts.join(" · ")}</span>}
                </li>
              ))}
            </ul>
          )}
          {judged.map((entry) => (
            <section key={entry.label} aria-label={`${entry.label} 마지막 게이트 판정`} className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold text-bright">
                {entry.label} 마지막 게이트 판정 — 세션 {entry.session} · {entry.judgedAt}
              </h3>
              <KrGateTable rows={entry.rows} label={`${entry.label} 게이트`} />
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}

/** 결정 목록의 칸 하나. 행 아래에 상세를 펼쳐야 해서 표를 이 파일이 그립니다(기관 선정 탭의 후보 표와 같은 방식). */
interface Column {
  key: string;
  header: string;
  align?: "left" | "right";
  render: (row: PaperDecisionSummary) => ReactNode;
}

function DecisionTable({
  rows,
  open,
  onToggle,
  showExposure,
  market,
}: {
  rows: PaperDecisionSummary[];
  open: readonly number[];
  onToggle: (id: number) => void;
  /** Claude 책이면 목표 노출 칸을 더합니다(규칙 책은 늘 비어 있는 칸이라 그리지 않음). */
  showExposure: boolean;
  market: PaperMarketCode;
}) {
  const korea = market === "KR";
  const kindLabel = korea ? krDecisionKindLabel : decisionKindLabel;
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted">
        {korea
          ? "아직 결정 기록이 없습니다 — 한국 네 계좌가 출발하면(개요의 '출발 지금 실행' 또는 출발일 밤 정기 출발) 출발 결정부터 KR 거래일마다 결정 창에서 남깁니다."
          : "아직 결정 기록이 없습니다 — 계좌를 시작한 뒤 거래일마다(KST 07:30 이후) 결정 작업이 남깁니다."}
      </p>
    );
  }

  const columns: Column[] = [
    {
      key: "date",
      header: "거래일",
      render: (row) => {
        const expanded = open.includes(row.id);
        return (
          <div className="flex flex-col items-start gap-1">
            <span className="whitespace-nowrap font-semibold text-bright">{row.asOfTradingDate}</span>
            <Button variant="ghost" expanded={expanded} onClick={() => onToggle(row.id)}>
              {expanded ? "상세 접기" : "상세 펼치기"}
            </Button>
          </div>
        );
      },
    },
    { key: "kind", header: "종류", render: (row) => <span className="whitespace-nowrap">{kindLabel(row.kind)}</span> },
    {
      key: "status",
      header: "상태",
      render: (row) => (
        <div className="flex min-w-[7rem] flex-col items-start gap-1">
          <Badges badges={[decisionStatusBadge(row.status, row.kind)]} />
          {row.error && <span className="text-[11px] leading-snug text-warn">{row.error}</span>}
        </div>
      ),
    },
    { key: "orders", header: "주문", align: "right", render: (row) => <span className="whitespace-nowrap">{decisionOrdersText(row)}</span> },
    ...(showExposure
      ? [{
        key: "exposure",
        header: "목표 노출",
        align: "right" as const,
        render: (row: PaperDecisionSummary) => <span className="whitespace-nowrap">{formatWithUnit(row.targetExposurePct, 1, "%")}</span>,
      }]
      : []),
    { key: "summary", header: "요약", render: (row) => <span className="text-xs text-body">{row.summary || EMPTY}</span> },
    {
      key: "prices",
      header: "가격",
      render: (row) => {
        const prices: { label: string; className: string; title?: string } = korea
          ? krPricesFinalText(row.pricesFinal) : pricesFinalText(row.pricesFinal);
        return <span className={`whitespace-nowrap text-xs ${prices.className}`} title={prices.title}>{prices.label}</span>;
      },
    },
    { key: "decidedAt", header: "결정 시각", render: (row) => <span className="whitespace-nowrap">{formatKst(row.decidedAtKst)}</span> },
  ];
  const align = (column: Column) => (column.align === "right" ? "text-right" : "text-left");

  return (
    <>
      <p className="mb-1 text-[11px] text-muted sm:hidden">← 표를 좌우로 넘겨 보세요</p>
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="결정 기록 표 (좌우 스크롤)">
        <table className="w-full min-w-[820px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
              {columns.map((column) => (
                <th key={column.key} className={`px-3 py-2 font-medium ${align(column)}`}>{column.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Fragment key={row.id}>
                <tr
                  className="border-b border-border/50 align-top hover:bg-surface-hover/60"
                  aria-label={`${row.asOfTradingDate} ${kindLabel(row.kind)}`}
                >
                  {columns.map((column) => (
                    <td key={column.key} className={`px-3 py-2 tabular-nums ${align(column)}`}>{column.render(row)}</td>
                  ))}
                </tr>
                {open.includes(row.id) && (
                  <tr className="border-b border-border/50 bg-canvas">
                    <td colSpan={columns.length} className="px-3 py-3">
                      <DecisionDetail id={row.id} market={market} />
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

/**
 * 결정 한 건의 상세 — 펼칠 때 GET /api/paper/decisions/{id}를 한 번 읽습니다(결정 기록은 바뀌지 않아 자동 갱신하지 않음).
 * Claude 책 기록이면 판단·제안 주문·검증·사용량을, 규칙 책 기록이면 선정·신호 표를 그립니다. 둘 다 아닌 모양이면 표 대신 원본 JSON만
 * 보입니다 — 모르는 모양을 빈 표로 그리면 "신호 없음"으로 읽힙니다.
 */
function DecisionDetail({ id, market }: { id: number; market: PaperMarketCode }) {
  const korea = market === "KR";
  const { data, loading, error, reload } = useApi<PaperDecisionDetailResponse>(endpoints.paper.decision(id));

  if (loading && !data) return <Loading label="결정 상세를 읽는 중…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;
  if (!data.available) return <Banner tone="warn">{data.message ?? "결정 기록을 읽을 수 없습니다."}</Banner>;
  const decision = data.decision ?? null;
  if (!decision) return <Banner tone="warn">결정 기록을 찾지 못했습니다.</Banner>;

  const claude = claudeDecisionView({
    book: decision.book,
    status: decision.status,
    kind: decision.kind,
    response: decision.response,
    usage: decision.usage,
    targetExposurePct: decision.targetExposurePct,
    exposureMismatch: decision.exposureMismatch,
  });
  const view = ruleDecisionView(decision.response);
  // 한국 규칙 계좌 기록은 한국 본문(KrRuleDecisionBody — 메모 포함)으로 그립니다. 미국 신호 표(13F)는 한국 기록에 그리지 않습니다.
  const krRules = korea ? krRuleDecisionView(decision.book, decision.response) : null;
  // 규칙 책 표(선정·신호·게이트)는 규칙 책 기록에만 — Claude 기록에 참고용 gate 같은 키가 있어도 빈 신호 표를 그리지 않습니다.
  // 처리 메모(notes)는 두 책 모두 그대로 보입니다.
  const rules = !korea && view.recognized && !claude.recognized;
  const selection = claude.recognized || korea ? null : view.selection;
  const kindLabel = korea ? krDecisionKindLabel : decisionKindLabel;
  const meta = decisionMeta(decision).map((cell) => (korea && cell.key === "pricesFinal"
    ? { ...cell, value: krPricesFinalText(decision.pricesFinal).label, title: krPricesFinalText(decision.pricesFinal).title }
    : cell));
  const orders = data.orders ?? [];
  const response = prettyJson(decision.response);
  const packet = prettyJson(decision.packet);
  const raw = typeof decision.responseRaw === "string" && decision.responseRaw ? decision.responseRaw : null;

  return (
    <section aria-label={`${decision.asOfTradingDate} ${kindLabel(decision.kind)} 상세`} className="flex flex-col gap-4">
      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
        {meta.map((cell) => (
          <div key={cell.key}>
            <dt className="text-muted">{cell.label}</dt>
            <dd className="tabular-nums font-semibold text-bright" title={cell.title}>{cell.value}</dd>
          </div>
        ))}
      </dl>
      {decision.error && <Banner tone="warn">오류 — {decision.error}</Banner>}

      {claude.recognized && (
        <ClaudeDecisionBody
          view={claude}
          kr={korea ? { extras: krDecisionExtras(decision.response), packet: decision.packet } : undefined}
        />
      )}

      {krRules?.recognized && <KrRuleDecisionBody view={krRules} />}

      {view.notes.length > 0 && !krRules?.recognized && (
        <Part title="처리 메모">
          <ul aria-label="결정 메모" className="list-disc space-y-0.5 pl-5 text-xs text-body">
            {view.notes.map((note, index) => <li key={`${index}-${note}`}>{note}</li>)}
          </ul>
        </Part>
      )}

      {selection && (
        <Part
          title={`선정 — ${selection.asOf} 기준`}
          note={selection.groupANames !== null || selection.pool.length > 0
            ? [
              selection.groupANames !== null ? `그룹 A: ${selection.groupANames}.` : null,
              selection.groupBNames !== null ? `그룹 B: ${selection.groupBNames}.` : null,
              `신호 풀(A ∪ B)과 기관 가중은 선정 때 값입니다${
                selection.groupWeightA !== null ? `(그룹 A 몫 ${formatRatioPercent(selection.groupWeightA)})` : ""
              }. 순위표는 그룹마다 선정 때의 상위 10입니다(공시일 기준 복제 수익률).`,
            ].filter(Boolean).join(" ")
            : `신호 기관: ${selection.selectedNames}. 순위표는 선정 때의 상위 10입니다(공시일 기준 복제 수익률).`}
        >
          {/* 그룹 섞기(D27) 뒤 기록은 신호 풀 표와 그룹별 순위표, 그 전 기록은 순위표 하나 — 결정 기록은 바뀌지 않는 이력이라 둘 다 그립니다. */}
          {selection.pool.length > 0 && (
            <Table<PoolRow>
              label="신호 풀"
              rows={selection.pool}
              rowKey={(row) => row.key}
              columns={[
                { key: "name", header: "기관", render: (row) => row.name },
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
          )}
          {selection.rankingA.length > 0 && (
            <Part title="그룹 A 순위표">
              <RankingTable rows={selection.rankingA} label="그룹 A 순위표" />
            </Part>
          )}
          {selection.rankingB.length > 0 && (
            <Part title="그룹 B 순위표">
              <RankingTable rows={selection.rankingB} label="그룹 B 순위표" />
            </Part>
          )}
          {(selection.ranking.length > 0
            || (selection.pool.length === 0 && selection.rankingA.length === 0)) && (
            <RankingTable rows={selection.ranking} label="순위표" />
          )}
        </Part>
      )}

      {rules && (
        <>
          <Part
            title="13F 신호 이벤트"
            note="신호 기관마다 선정 기준일까지 공시된 최신 분기와 바로 앞 분기를 비교한 결과입니다. 비중은 그 기관 13F 총액 대비."
          >
            <Table<SignalEventRow>
              label="13F 신호 이벤트"
              rows={view.events}
              rowKey={(row) => row.key}
              emptyMessage="신호 이벤트가 없습니다 — 신호 기관의 최신 분기에 신규 편입·확대·전량 매도가 없었습니다."
              columns={[
                { key: "filer", header: "기관(순위)", render: (row) => <span className="text-xs">{row.filer}</span> },
                { key: "ticker", header: "종목", render: (row) => <span className="font-semibold text-bright">{row.ticker}</span> },
                {
                  key: "action",
                  header: "행동",
                  render: (row) => <span className={row.actionKey === "CLOSED" ? "text-down" : "text-up"}>{row.action}</span>,
                },
                { key: "sharesChange", header: "주식 수 변화", align: "right", render: (row) => row.sharesChange },
                { key: "weight", header: "비중", align: "right", render: (row) => row.weight },
                { key: "previousWeight", header: "직전 비중", align: "right", render: (row) => row.previousWeight },
              ]}
            />
          </Part>

          <Part title="매수 후보" note={candidatesNote(decision.kind)}>
            {view.allocation && <p className="text-[11px] leading-relaxed text-body">{view.allocation}</p>}
            <Table<SignalCandidateRow>
              label="매수 후보"
              rows={view.candidates}
              rowKey={(row) => row.ticker}
              emptyMessage="매수 후보가 없습니다 — 여러 기관이 함께 신규 편입·확대한 종목이 없었습니다."
              columns={[
                { key: "ticker", header: "종목", render: (row) => <span className="font-semibold text-bright">{row.ticker}</span> },
                { key: "buyers", header: "매수 기관(순위)", render: (row) => <span className="text-xs">{row.buyers}</span> },
                { key: "buyerCount", header: "기관 수", align: "right", render: (row) => row.buyerCount },
                // 섞은 뒤 기록은 점수 순, 섞기 전 기록은 순위 합 순이라 정렬 기준 칸을 기록 모양에 맞춥니다.
                view.scored
                  ? { key: "score", header: "점수", align: "right", render: (row) => row.score }
                  : { key: "rankSum", header: "순위 합", align: "right", render: (row) => row.rankSum },
                { key: "combinedWeight", header: "합산 비중", align: "right", render: (row) => row.combinedWeight },
              ]}
            />
          </Part>

          {view.scored && (
            <Part title="점수 기여" note={view.convictionNote ?? undefined}>
              <Table<ContributionRow>
                label="점수 기여"
                rows={view.contributions}
                rowKey={(row) => row.key}
                emptyMessage="점수 기여 기록이 없습니다."
                columns={[
                  { key: "ticker", header: "종목", render: (row) => <span className="font-semibold text-bright">{row.ticker}</span> },
                  { key: "filer", header: "기관(순위)", render: (row) => <span className="text-xs">{row.filer}</span> },
                  {
                    key: "group",
                    header: "그룹",
                    render: (row) => (row.group ? <Badges badges={[row.group]} /> : <span className="text-muted">{EMPTY}</span>),
                  },
                  { key: "filerWeight", header: "기관 가중", align: "right", render: (row) => row.filerWeight },
                  { key: "conviction", header: "확신도", align: "right", render: (row) => row.conviction },
                  { key: "points", header: "점수 기여", align: "right", render: (row) => row.points },
                ]}
              />
            </Part>
          )}

          <Part title="전량 매도한 기관" note="보유 종목을 신호 기관 여러 곳이 전량 매도하면 매도 신호입니다.">
            <Table<ClosedSignalRow>
              label="전량 매도한 기관"
              rows={view.closed}
              rowKey={(row) => row.ticker}
              emptyMessage="전량 매도가 없습니다."
              columns={[
                { key: "ticker", header: "종목", render: (row) => <span className="font-semibold text-bright">{row.ticker}</span> },
                { key: "filers", header: "기관(순위)", render: (row) => <span className="text-xs">{row.filers}</span> },
                { key: "count", header: "기관 수", align: "right", render: (row) => row.count },
              ]}
            />
          </Part>
        </>
      )}

      <Part
        title="주문"
        note={claude.recognized
          ? "이 결정이 장부에 남긴 주문입니다 — 검증을 통과한 주문은 대기(체결 전), 거절된 주문은 거절과 사유로 남습니다. 대기 주문이 "
            + "집행 전에 취소되면(다음 결정이 대신함·일시정지) 취소와 사유가 보입니다. 근거는 모델이 쓴 문장입니다."
          : korea
            ? "이 결정이 낸 주문입니다 — 다음 KR 거래일 시가(KRX 시가 단일가)에 체결합니다. 근거에 점수(순위)·매도 사유·남는 현금이 남습니다."
            : "이 결정이 낸 주문입니다. 근거에 어느 기관(그룹·순위·가중)의 어떤 행동이 이 주문을 냈는지가 남습니다."}
      >
        <Table<PaperOrder>
          label="주문"
          rows={orders}
          rowKey={(row) => String(row.id)}
          emptyMessage="이 결정은 주문을 내지 않았습니다."
          columns={[
            { key: "ticker", header: "종목", render: (row) => <span className="font-semibold text-bright">{row.ticker}</span> },
            { key: "side", header: "방향", render: (row) => <span className={sideClass(row.side)}>{sideLabel(row.side)}</span> },
            { key: "size", header: "크기", align: "right", render: (row) => orderSizeText(row) },
            {
              key: "status",
              header: "상태",
              render: (row) => (
                <span className="flex flex-wrap items-center gap-1">
                  <Badges badges={[orderStatusBadge(row.status)]} />
                  {row.rejectReason && <span className="text-xs text-warn">{row.rejectReason}</span>}
                </span>
              ),
            },
            { key: "timing", header: "체결 시점", render: (row) => timingLabel(row.timing) },
            { key: "expires", header: "만료", render: (row) => row.expiresOn ?? EMPTY },
            {
              key: "reason",
              header: "근거",
              render: (row) => (
                <span className="text-xs text-muted" title={jsonTitle(row.reason)}>{orderReasonText(row.reason, 120)}</span>
              ),
            },
          ]}
        />
      </Part>

      {view.skipped.length > 0 && !krRules?.recognized && (
        <Part title="고르지 못한 후보" note="매수 후보였지만 주문을 내지 않은 종목과 서버가 남긴 사유입니다.">
          <Table<SkippedRow>
            label="고르지 못한 후보"
            rows={view.skipped}
            rowKey={(row) => row.key}
            columns={[
              { key: "ticker", header: "종목", render: (row) => row.ticker },
              { key: "reason", header: "사유", render: (row) => <span className="text-xs text-body">{row.reason}</span> },
            ]}
          />
        </Part>
      )}

      {rules && (
        <Part title="게이트 (참고)">
          <GateIndicatorBody gate={view.gate} compact />
        </Part>
      )}

      {response && (
        <details className="rounded-md border border-border px-3 py-2 text-xs">
          <summary className="cursor-pointer text-muted">결정 기록 원본(JSON)</summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all text-[11px] text-body">{response}</pre>
        </details>
      )}
      {raw && (
        <details className="rounded-md border border-border px-3 py-2 text-xs">
          <summary className="cursor-pointer text-muted">모델 응답 원문</summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all text-[11px] text-body">{raw}</pre>
        </details>
      )}
      {packet && (
        <details className="rounded-md border border-border px-3 py-2 text-xs">
          <summary className="cursor-pointer text-muted">입력 패킷(JSON)</summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all text-[11px] text-body">{packet}</pre>
        </details>
      )}
    </section>
  );
}

/** 선정 때의 순위표(상위 10) — 순위·기관·선정·CAGR·초과·샤프. 섞기 전 순위표와 그룹별 순위표가 같은 모양입니다. */
function RankingTable({ rows, label }: { rows: RankingRow[]; label: string }) {
  return (
    <Table<RankingRow>
      label={label}
      rows={rows}
      rowKey={(row) => row.cik}
      emptyMessage="순위표가 없습니다."
      columns={[
        { key: "rank", header: "순위", align: "right", render: (row) => row.rank },
        { key: "name", header: "기관", render: (row) => row.name },
        {
          key: "selected",
          header: "선정",
          render: (row) => {
            const badge = selectedBadge(row);
            return badge ? <Badges badges={[badge]} /> : <span className="text-muted">{EMPTY}</span>;
          },
        },
        { key: "cagr", header: "CAGR", align: "right", render: (row) => row.cagr },
        { key: "excess", header: "초과(SPY 대비)", align: "right", render: (row) => row.excess },
        { key: "sharpe", header: "샤프", align: "right", render: (row) => row.sharpe },
      ]}
    />
  );
}

/** 상세 안의 한 부분 — 제목·설명·내용. 제목이 영역 이름이 되어(aria-label) 표마다 따로 찾을 수 있습니다.
 * 제목은 h3 — 이 상세는 카드(제목 h2) 바로 안에 그려지므로 h4로 건너뛰지 않습니다. */
function Part({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold text-bright">{title}</h3>
      {note && <p className="text-[11px] leading-relaxed text-muted">{note}</p>}
      {children}
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
