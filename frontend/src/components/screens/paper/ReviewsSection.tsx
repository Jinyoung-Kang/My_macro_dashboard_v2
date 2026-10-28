"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { Banner, Button, Card, ErrorState, Freshness, Loading, Table } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useElapsedSeconds } from "@/hooks/useElapsedSeconds";
import { apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import {
  type Badge,
  latestReviewNote,
  PAPER_SOURCES,
  resolveReviewWeek,
  REVIEW_COST_NOTE,
  REVIEW_SCHEDULE_NOTE,
  reviewDetailView,
  type ReviewDetailKey,
  type ReviewRow,
  reviewRowSignature,
  reviewRows,
  reviewRunResultView,
  type ReviewVerdictRow,
  shouldReloadReviewDetail,
} from "@/lib/paper";
import {
  KR_REVIEW_EMPTY,
  KR_REVIEW_SCHEDULE_NOTE,
  krLatestWeekReasonText,
  krManualReviewNote,
  krReviewComparison,
  type KrReviewEntryRow,
  krReviewInputRows,
} from "@/lib/paperKr";
import type { PaperMarketCode } from "@/lib/paperMarket";
import type { PaperReviewResponse, PaperReviewsResponse, PaperRunReviewResult, PaperStatusResponse } from "@/lib/types";

/**
 * 결정 로그 탭의 '주간 복기'(2단계 명세 §3 D1~D6) — 주마다 한 건, Claude 계좌의 지난 4주 결정을 그 뒤 가격과 대조한 복기 메모.
 *
 * 위에서부터: 복기가 언제 생기는지·가장 최근 주와 수동 실행(Claude를 한 번 부르므로 확인 단계), 복기 목록(상태·창·판정 수·연결된 제안),
 * 고른 주의 복기(판정 표 — 결정 날짜는 서버가 입력에서 찾아 붙인 값, 반복 오류·지킬 것, 프레임 제안으로 이동, 사용량, 입력·응답 원본).
 * 제안 링크는 프레임 탭으로 옮겨 그 제안을 강조합니다(page.tsx) — 승인·거절은 프레임 탭에서만 합니다(자동 반영 없음).
 *
 * 숫자(수익률·낙폭·판정 수)는 서버 값 그대로이고 화면은 이름을 붙여 늘어놓기만 합니다(ADR 0004). 모르는 값은 "—".
 *
 * <b>한국</b>(`market` "KR", 2단계 명세 §9 E3·F2): 같은 화면을 `?market=KR` 경로(목록·한 건·수동 실행)로 — 일정 문구는 토요일 22:30 KST, 수동 실행
 * 확인 창에 수동 호출 문턱, 최근 복기 주를 셀 수 없으면 그 사유(달력 없음)를 적고, 복기 한 건에는 입력의 가정 진입(출처·근사 배지)과 계좌 수익률
 * 비교('잠정 줄 포함' 배지) 표를 더합니다.
 */
export function ReviewsSection({
  onOpenProposal,
  market = "US",
}: {
  onOpenProposal?: (id: number) => void;
  /** 화면의 시장 — 미국은 예전 그대로(?market 없는 경로). */
  market?: PaperMarketCode;
}) {
  const korea = market === "KR";
  const paths = endpoints.paper.market(market);
  const list = useApi<PaperReviewsResponse>(paths.reviews, 60_000);
  // 한국만 — 수동 실행 확인 창의 수동 호출 문턱(상태 응답 호출 사용량).
  const status = useApi<PaperStatusResponse>(korea ? paths.status : null, 60_000);
  const [picked, setPicked] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const run = useAsyncAction(async () => {
    const result = await apiPost<PaperRunReviewResult>(paths.runReview);
    // 실행한 주를 바로 펼칩니다 — 목록을 다시 읽기 전에도 그 주의 기록이 보이게.
    if (result.review?.weekEnding) setPicked(result.review.weekEnding);
    return result;
  }, "복기를 실행하지 못했습니다.");
  const elapsed = useElapsedSeconds(run.busy);
  const reviews = list.data?.available ? list.data.reviews ?? [] : [];
  const week = resolveReviewWeek(picked, reviews);
  const detail = useApi<PaperReviewResponse>(week ? paths.review(week) : null);
  // 상세는 주기 갱신하지 않고, 60초마다 갱신되는 목록에서 그 주의 행이 바뀌면 다시 읽습니다(lib/paper의 shouldReloadReviewDetail).
  const signature = reviewRowSignature(reviews, week);
  const seen = useRef<ReviewDetailKey | null>(null);
  const reloadDetail = detail.reload;
  useEffect(() => {
    const next = { week, signature };
    if (shouldReloadReviewDetail(seen.current, next)) void reloadDetail();
    seen.current = next;
  }, [week, signature, reloadDetail]);
  const rows = reviewRows(reviews);
  const runView = run.result ? reviewRunResultView(run.result) : null;
  const note = latestReviewNote(list.data?.latestWeekEnding, list.data?.latestOpensAtKst, reviews)
    ?? (korea ? krLatestWeekReasonText(list.data?.latestWeekEnding, list.data?.latestWeekEndingReason) : null);
  const manualLimit = status.data?.available ? (status.data.apiUsage?.today?.manualLimit ?? null) : null;
  const source = korea ? PAPER_SOURCES.krReviews : PAPER_SOURCES.reviews;

  const runNow = async () => {
    const ok = await run.run();
    setConfirming(false);
    if (ok) {
      void list.reload();
      void detail.reload();
    }
  };

  if (list.loading && !list.data) return <Loading label="주간 복기를 읽는 중…" />;
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />;
  if (list.data && !list.data.available) {
    return <Banner tone="warn">{list.data.message ?? "주간 복기를 읽을 수 없습니다."}</Banner>;
  }

  return (
    <>
      <Card title="주간 복기" source={source} actions={<Freshness refreshError={list.refreshError} />}>
        <p className="text-xs leading-relaxed text-muted">{korea ? KR_REVIEW_SCHEDULE_NOTE : REVIEW_SCHEDULE_NOTE}</p>
        {note && <p className="mt-2 text-xs text-body">{note}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={() => setConfirming(true)} disabled={run.busy || confirming}>
            {run.busy ? `복기 중… ${elapsed}초` : "지금 복기 실행"}
          </Button>
        </div>
        {confirming && (
          <div className="mt-3 flex flex-col gap-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-3">
            <p className="text-sm leading-relaxed text-warn">Claude를 지금 부를까요? {REVIEW_COST_NOTE}</p>
            {korea && <p className="text-xs leading-relaxed text-warn">{krManualReviewNote(manualLimit)}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={() => void runNow()} disabled={run.busy}>
                {run.busy ? `복기 중… ${elapsed}초` : "복기 실행 확인"}
              </Button>
              <Button onClick={() => setConfirming(false)} disabled={run.busy}>취소</Button>
            </div>
          </div>
        )}
        {/* 서버의 400·429 문구(계좌 상태·확정 종가·하루 상한·진행 중)를 그대로. */}
        {run.error && <div className="mt-3"><Banner tone="warn">{run.error}</Banner></div>}
        {runView && <div className="mt-3"><Banner tone={runView.tone}>{runView.text}</Banner></div>}
      </Card>

      <Card
        title="복기 기록 (최근 52주)"
        subtitle="주마다 한 건(같은 주에 다시 돌아도 새로 만들지 않음). '보기'로 그 주의 판정 표·반복 오류·제안을 펼칩니다."
        source={source}
      >
        {rows.length === 0 ? (
          <p className="text-sm text-muted">
            {korea ? KR_REVIEW_EMPTY : "아직 복기가 없습니다 — Claude 계좌가 시작한 다음 주 토요일 09:00(KST) 뒤에 첫 복기가 생깁니다."}
          </p>
        ) : (
          <Table<ReviewRow>
            label="복기 기록"
            rows={rows}
            rowKey={(row) => row.key}
            columns={[
              {
                key: "week",
                header: "복기 주",
                render: (row) => (
                  <Button variant="ghost" onClick={() => setPicked(row.weekEnding)} expanded={row.weekEnding === week}>
                    {`${row.weekEnding} 보기`}
                  </Button>
                ),
              },
              {
                key: "status",
                header: "상태",
                render: (row) => (
                  <span className="flex flex-col gap-1">
                    <Chip badge={row.status} />
                    {row.note && <span className="text-[11px] text-muted">{row.note}</span>}
                  </span>
                ),
              },
              { key: "window", header: "창", render: (row) => <span className="text-xs text-body">{row.window}</span> },
              { key: "counts", header: "판정", render: (row) => <span className="text-xs text-body">{row.counts}</span> },
              {
                key: "proposal",
                header: "제안",
                render: (row) => {
                  const id = row.proposalId;
                  return id !== null && onOpenProposal ? (
                    <Button variant="ghost" onClick={() => onOpenProposal(id)}>{row.proposal}</Button>
                  ) : (
                    <span className="text-xs text-body">{row.proposal}</span>
                  );
                },
              },
              { key: "createdAt", header: "남긴 시각", render: (row) => <span className="text-xs text-muted">{row.createdAt}</span> },
            ]}
          />
        )}
      </Card>

      {week && (
        <Card title={`${week} 주 복기`} source={source}>
          {detail.loading && !detail.data && <Loading label="복기를 읽는 중…" />}
          {detail.error && <ErrorState message={detail.error} onRetry={detail.reload} />}
          {detail.data && !detail.data.available && (
            <Banner tone="warn">{detail.data.message ?? "복기를 읽을 수 없습니다."}</Banner>
          )}
          {detail.data?.available && detail.data.review && (
            <ReviewBody review={detail.data.review} onOpenProposal={onOpenProposal} korea={korea} />
          )}
        </Card>
      )}
    </>
  );
}

function ReviewBody({
  review,
  onOpenProposal,
  korea,
}: {
  review: NonNullable<PaperReviewResponse["review"]>;
  onOpenProposal?: (id: number) => void;
  /** 한국 복기 — 입력의 가정 진입·계좌 수익률 비교 표를 더합니다. */
  korea: boolean;
}) {
  const view = reviewDetailView(review);
  const proposal = view.proposal;
  const entries = korea ? krReviewInputRows(review.input) : [];
  const comparison = korea ? krReviewComparison(review.input) : null;
  return (
    <section aria-label={view.title} className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-2">
        <Chip badge={view.status} />
        <span className="text-xs text-muted">{`판정 ${view.counts}`}</span>
      </header>
      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
        {view.meta.map((cell) => <Meta key={cell.key} label={cell.label} value={cell.value} />)}
      </dl>
      {view.notices.map((text) => <Banner key={text} tone="warn">{text}</Banner>)}

      {view.verdicts.length > 0 && (
        <Part title="논거 판정" note="결정마다 Claude가 그 뒤 사실(서버가 계산한 수익률·낙폭·스탑·무효화 평가)로 내린 판정입니다.">
          <Table<ReviewVerdictRow>
            label="논거 판정"
            rows={view.verdicts}
            rowKey={(row) => row.key}
            columns={[
              { key: "decision", header: "결정", render: (row) => <code className="text-xs text-body">{row.decision}</code> },
              { key: "asOf", header: "기준 거래일", render: (row) => <span className="whitespace-nowrap text-xs text-body">{row.asOf}</span> },
              { key: "kind", header: "종류", render: (row) => <span className="text-xs text-muted">{row.kind}</span> },
              { key: "thesis", header: "판정", render: (row) => <Chip badge={row.thesisHeld} /> },
              { key: "note", header: "근거", render: (row) => <span className="text-xs text-body">{row.note}</span> },
            ]}
          />
          {view.missing && <p className="mt-2 text-xs text-muted">{view.missing}</p>}
        </Part>
      )}

      {entries.length > 0 && (
        <Part
          title="가정 진입(거절 주문)"
          note="거절된 주문을 결정 다음 세션 시가에 샀다고 가정한 값입니다(비용 제외) — 금융위 확정 시가가 없으면 토스 잠정 시가, 그 세션 시가가 없으면 종가 근사."
        >
          <Table<KrReviewEntryRow>
            label="가정 진입"
            rows={entries}
            rowKey={(row) => row.key}
            columns={[
              { key: "decision", header: "결정", render: (row) => <span className="whitespace-nowrap text-xs text-body">{row.decision}</span> },
              { key: "ticker", header: "종목", render: (row) => <span className="font-semibold text-bright">{row.ticker}</span> },
              { key: "reject", header: "거절 사유", render: (row) => <span className="text-xs text-warn">{row.rejectReason}</span> },
              { key: "entryDate", header: "진입일", render: (row) => <span className="whitespace-nowrap text-xs text-body">{row.entryDate}</span> },
              { key: "entryPrice", header: "진입가(원)", align: "right", render: (row) => row.entryPrice },
              {
                key: "source",
                header: "진입가 출처",
                render: (row) => (row.badges.length > 0 ? (
                  <span className="flex flex-wrap gap-1">{row.badges.map((badge) => <Chip key={badge.key} badge={badge} />)}</span>
                ) : <span className="text-xs text-muted">—</span>),
              },
              { key: "returnPct", header: "가정 수익률", align: "right", render: (row) => row.returnPct },
            ]}
          />
        </Part>
      )}

      {comparison && comparison.rows.length > 0 && (
        <Part title={`계좌 수익률 비교 (${comparison.range})`} note={comparison.note ?? undefined}>
          {/* 세 칸짜리 짧은 표라 목록으로 — 표로 그리면 휴대폰 폭에서 수익률 칸이 가로 스크롤 밖으로 밀렸습니다. */}
          <ul aria-label="계좌 수익률 비교" className="flex flex-col gap-1 text-xs">
            {comparison.rows.map((row) => (
              <li key={row.key} className="flex flex-wrap items-center gap-2">
                <code className="text-body">{row.book}</code>
                <span className="tabular-nums font-semibold text-bright">{row.returnPct}</span>
                {row.badges.map((badge) => <Chip key={badge.key} badge={badge} />)}
              </li>
            ))}
          </ul>
        </Part>
      )}

      {view.recurringErrors.length > 0 && (
        <Part title="반복되는 오류">
          <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-body">
            {view.recurringErrors.map((text) => <li key={text}>{text}</li>)}
          </ul>
        </Part>
      )}
      {view.keep.length > 0 && (
        <Part title="지킬 것">
          <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-body">
            {view.keep.map((text) => <li key={text}>{text}</li>)}
          </ul>
        </Part>
      )}

      {proposal && (
        <Part title="프레임 제안" note="자동 반영은 없습니다 — 프레임 탭에서 승인해야 새 판이 됩니다.">
          <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
            <p className="text-sm font-semibold text-bright">{proposal.label}</p>
            {proposal.summary && <p className="text-xs leading-relaxed text-body">{proposal.summary}</p>}
            <p className="text-[11px] text-muted">{proposal.detail}</p>
            {onOpenProposal && (
              <div>
                <Button onClick={() => onOpenProposal(proposal.id)}>프레임 탭에서 이 제안 보기</Button>
              </div>
            )}
          </div>
        </Part>
      )}
      {view.noProposal && <p className="text-xs text-muted">제안 없음 — 이번 복기는 프레임을 고칠 반복 오류를 찾지 않았습니다.</p>}

      {view.usage.length > 0 && (
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
          {view.usage.map((cell) => <Meta key={cell.key} label={cell.label} value={cell.value} />)}
        </dl>
      )}
      {view.input && (
        <details className="rounded-md border border-border px-3 py-2 text-xs">
          <summary className="cursor-pointer text-muted">복기 입력(JSON — 서버가 장부에서 만든 사실)</summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all text-[11px] text-body">{view.input}</pre>
        </details>
      )}
      {view.response && (
        <details className="rounded-md border border-border px-3 py-2 text-xs">
          <summary className="cursor-pointer text-muted">복기 응답(JSON)</summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all text-[11px] text-body">{view.response}</pre>
        </details>
      )}
    </section>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1">
      <dt className="text-muted">{label}</dt>
      <dd className="text-body">{value}</dd>
    </div>
  );
}

function Part({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-bright">{title}</h3>
      {note && <p className="text-[11px] text-muted">{note}</p>}
      {children}
    </section>
  );
}

function Chip({ badge }: { badge: Badge }) {
  return (
    <span title={badge.title} className={`w-fit whitespace-nowrap rounded-sm border px-1.5 py-px text-[10px] ${badge.className}`}>
      {badge.label}
    </span>
  );
}
