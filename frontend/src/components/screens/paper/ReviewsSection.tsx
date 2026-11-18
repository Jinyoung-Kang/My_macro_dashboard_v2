"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { DataTable, type PropertyItem, PropertyList, Timeline, type TimelineEntry } from "@/components/patterns";
import { Button, Callout, ErrorState, Freshness, Loading, Panel } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useElapsedSeconds } from "@/hooks/useElapsedSeconds";
import { apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { EMPTY } from "@/lib/format";
import {
  latestReviewNote,
  PAPER_SOURCES,
  resolveReviewWeek,
  REVIEW_COST_NOTE,
  REVIEW_SCHEDULE_NOTE,
  reviewDetailView,
  type ReviewDetailKey,
  reviewRowSignature,
  reviewRunResultView,
  type ReviewVerdictRow,
  shouldReloadReviewDetail,
  sideClass,
  storedText,
} from "@/lib/paper";
import {
  KR_REVIEW_EMPTY,
  KR_REVIEW_ENTRY_NOTE,
  KR_REVIEW_SCHEDULE_NOTE,
  krLatestWeekReasonText,
  krManualReviewNote,
  krReviewComparison,
  type KrReviewEntryRow,
  krReviewInputRows,
} from "@/lib/paperKr";
import type { PaperMarketCode } from "@/lib/paperMarket";
import { type ReviewTimelineRow, reviewTimelineEntries } from "@/lib/paperTimeline";
import type {
  PaperBookSummary,
  PaperReviewResponse,
  PaperReviewsResponse,
  PaperRunReviewResult,
  PaperStatusResponse,
} from "@/lib/types";
import { DetailFold } from "./DetailFold";
import { PaperBadge } from "./PaperBadge";
import { TickerName } from "./TickerName";

/**
 * 결정 로그 탭의 '주간 복기'(2단계 명세 §3 D1~D6) — 주마다 한 건, Claude 계좌의 지난 4주 결정을 그 뒤 가격과 대조한 복기 메모.
 *
 * 위에서부터: 복기가 언제 생기는지·가장 최근 주와 수동 실행(Claude를 한 번 부르므로 확인 단계), 복기 목록(시각순 목록 — 상태·창·판정 수·연결된 제안),
 * 고른 주의 복기(검사 칸 — 넓은 틀은 목록 오른쪽, 좁은 화면은 대화상자: 상태·판정 수·복기 기록 칸, 판정 표 — 결정 날짜는 서버가 입력에서 찾아 붙인 값,
 * 반복 오류·지킬 것, 프레임 제안으로 이동, 사용량, 입력·응답 원본). 읽는 주는 지금처럼 고른 주(없으면 가장 최근 주)이고 화면을 열 때 한 번 읽습니다.
 * 제안 링크는 프레임 탭으로 옮겨 그 제안을 강조합니다(page.tsx) — 승인·거절은 프레임 탭에서만 합니다(자동 반영 없음).
 *
 * 숫자(수익률·낙폭·판정 수)는 서버 값 그대로이고 화면은 이름을 붙여 늘어놓기만 합니다(ADR 0004). 모르는 값은 "—".
 *
 * <b>한국</b>(`market` "KR", 2단계 명세 §9 E3·F2): 같은 화면을 `?market=KR` 경로(목록·한 건·수동 실행)로 — 일정 문구는 일요일 22:00 KST, 수동 실행
 * 확인 창에 수동 호출 문턱, 최근 복기 주를 셀 수 없으면 그 사유(달력 없음)를 적고, 복기 한 건에는 입력의 가정 진입(출처·근사 배지)과 계좌 수익률
 * 비교('잠정 줄 포함' 배지 — 계좌는 `books`의 이름) 표를 더합니다.
 */
export function ReviewsSection({
  onOpenProposal,
  market = "US",
  books = [],
}: {
  onOpenProposal?: (id: number) => void;
  /** 화면의 시장 — 미국은 예전 그대로(?market 없는 경로). */
  market?: PaperMarketCode;
  /** 개요의 계좌 목록 — 한국 계좌 수익률 비교에 코드 대신 이름을 적습니다(목록에 없으면 코드). */
  books?: readonly PaperBookSummary[];
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
  const rows = reviewTimelineEntries(reviews);
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
    return <Callout tone="warn">{list.data.message ?? "주간 복기를 읽을 수 없습니다."}</Callout>;
  }

  return (
    <>
      <Panel title="주간 복기" source={source} actions={<Freshness refreshError={list.refreshError} />}>
        <p className="text-xs leading-relaxed text-text-3">{korea ? KR_REVIEW_SCHEDULE_NOTE : REVIEW_SCHEDULE_NOTE}</p>
        {note && <p className="mt-2 text-xs text-text-2">{note}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={() => setConfirming(true)} disabled={run.busy || confirming}>
            {run.busy ? `복기 중… ${elapsed}초` : "지금 복기 실행"}
          </Button>
        </div>
        {confirming && (
          <div className="mt-3 flex flex-col gap-3 rounded-control border border-warn/30 bg-warn-tint px-4 py-3">
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
        {run.error && <div className="mt-3"><Callout tone="warn">{storedText(run.error)}</Callout></div>}
        {runView && <div className="mt-3"><Callout tone={runView.tone}>{runView.text}</Callout></div>}
      </Panel>

      <Panel
        title="복기 기록 (최근 52주)"
        subtitle="주마다 한 건(같은 주에 다시 돌아도 새로 만들지 않음). 주를 고르면 그 주의 판정 표·반복 오류·제안을 봅니다."
        source={source}
      >
        <ReviewTimeline
          rows={rows}
          week={week}
          onPick={setPicked}
          empty={korea ? KR_REVIEW_EMPTY : "아직 복기가 없습니다 — Claude 계좌가 시작한 다음 주 일요일 21:00(KST) 뒤에 첫 복기가 생깁니다."}
          renderBody={(row) => (
            // 주마다 따로 그립니다(key) — 앞 주의 접기 열림 상태가 다음 주로 넘어가지 않게(QA-765와 같은 까닭).
            <ReviewPane
              key={row.key}
              row={row}
              week={week}
              onShow={setPicked}
              detail={detail}
              onOpenProposal={onOpenProposal}
              korea={korea}
              books={books}
            />
          )}
        />
      </Panel>
    </>
  );
}

/**
 * 복기 기록 — 공용 시각순 목록(Timeline, 작업대 P6). 주마다 한 줄(시각 열 = 복기 주, 종류 태그 '주간 복기', 요약 = 상태 배지·창·판정 수·연결된 제안·남긴 시각·
 * 안내 — 값은 lib/paperTimeline). 줄을 고르면 그 주의 복기를 틀 48rem부터 목록 오른쪽 넓은 검사 칸에, 그 아래(좁은 화면·좁은 틀)는 위쪽 대화상자(첫 포커스 제목)에
 * 그립니다. 넓은 배치에서 고른 줄은 부모가 읽는 주(resolveReviewWeek — 고른 주, 없으면 가장 최근 주)라 화면을 열면 가장 최근 주가 검사 칸에 있습니다.
 * 줄 단추 안이라 제안 링크는 검사 칸(복기 한 건의 속성 '제안'·프레임 제안 칸)에 있습니다.
 */
function ReviewTimeline({
  rows,
  week,
  onPick,
  empty,
  renderBody,
}: {
  rows: ReviewTimelineRow[];
  week: string | null;
  onPick: (week: string) => void;
  empty: string;
  renderBody: (row: ReviewTimelineRow) => ReactNode;
}) {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const entries: TimelineEntry[] = rows.map((row) => ({
    key: row.key,
    at: row.at,
    dateTime: row.dateTime,
    kind: { label: "주간 복기" },
    summary: <ReviewLineSummary row={row} />,
    title: row.title,
  }));
  return (
    <Timeline
      label="복기 기록"
      entries={entries}
      renderDetail={(entry) => {
        const row = byKey.get(entry.key);
        return row ? renderBody(row) : null;
      }}
      inspectorWidth="wide"
      dialogFocus="title"
      selectedKey={week}
      // 넓은 배치에서 Esc로 고름을 풀어도 부모의 주(가장 최근 주)가 남습니다 — 고른 주만 받습니다.
      onSelectedKeyChange={(key) => {
        if (key !== null) onPick(key);
      }}
      inspectorHint="주를 고르면 이 칸에 그 주의 복기를 보입니다(j/k·↑↓로 옮김)."
      emptyText={empty}
    />
  );
}

/** 복기 줄의 요약 — 1행 상태 배지·창·판정 수(13px 보조 글), 2행 연결된 제안·남긴 시각, 오류·재시도 안내는 작은 보조 글. 줄 단추 안이라 링크가 없습니다. */
function ReviewLineSummary({ row }: { row: ReviewTimelineRow }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] tabular-nums text-text-2">
        <PaperBadge badge={row.status} />
        <span className="whitespace-nowrap">창 {row.window}</span>
        <span className="whitespace-nowrap">판정 {row.counts}</span>
      </span>
      <span className="text-text">
        {row.proposal === EMPTY ? <span className="text-text-3">제안 —</span> : row.proposal}
        <span className="text-text-3"> · 남긴 시각 {row.createdAt}</span>
      </span>
      {row.note && <span className="text-xs leading-snug text-text-3">{row.note}</span>}
    </span>
  );
}

/**
 * 고른 주의 복기 한 건 — 부모가 읽은 그 주의 상세(GET …/reviews/{주}, 읽는 때는 부모가 정함)를 그립니다. 대화상자로 연 주가 부모의 주와 다르면(좁은 배치에서
 * 다른 주를 누름) 그 주를 부모에 알려 읽게 하고, 그동안은 읽는 중입니다 — 예전 '{주} 보기' 단추와 같은 요청(그 주 상세 한 번).
 */
function ReviewPane({
  row,
  week,
  onShow,
  detail,
  onOpenProposal,
  korea,
  books,
}: {
  row: ReviewTimelineRow;
  week: string | null;
  onShow: (week: string) => void;
  detail: { data: PaperReviewResponse | null; loading: boolean; error: string | null; reload: () => void };
  onOpenProposal?: (id: number) => void;
  korea: boolean;
  books: readonly PaperBookSummary[];
}) {
  const shown = row.weekEnding === week;
  useEffect(() => {
    if (!shown) onShow(row.weekEnding);
  }, [shown, onShow, row.weekEnding]);
  const review = shown && detail.data?.available ? (detail.data.review ?? null) : null;
  if (!shown || (detail.loading && !detail.data)) return <Loading label="복기를 읽는 중…" />;
  if (detail.error) return <ErrorState message={detail.error} onRetry={detail.reload} />;
  if (detail.data && !detail.data.available) return <Callout tone="warn">{detail.data.message ?? "복기를 읽을 수 없습니다."}</Callout>;
  if (!review || review.weekEnding !== row.weekEnding) return <Loading label="복기를 읽는 중…" />;
  return <ReviewBody review={review} onOpenProposal={onOpenProposal} korea={korea} books={books} />;
}

function ReviewBody({
  review,
  onOpenProposal,
  korea,
  books,
}: {
  review: NonNullable<PaperReviewResponse["review"]>;
  onOpenProposal?: (id: number) => void;
  /** 한국 복기 — 입력의 가정 진입·계좌 수익률 비교 표를 더합니다. */
  korea: boolean;
  books: readonly PaperBookSummary[];
}) {
  const view = reviewDetailView(review);
  const proposal = view.proposal;
  const entries = korea ? krReviewInputRows(review.input) : [];
  const comparison = korea ? krReviewComparison(review.input, new Map(books.map((book) => [book.code, book.label]))) : null;
  // 맨 위 속성 — 상태·판정 수와 복기 기록 칸(복기 주·창·모델·기준 프레임·남긴 시각·재시도 — lib/paper reviewDetailView).
  const properties: PropertyItem[] = [
    { key: "status", label: "상태", value: <PaperBadge badge={view.status} /> },
    { key: "counts", label: "판정", value: view.counts },
    ...view.meta.map((cell): PropertyItem => ({ key: cell.key, label: cell.label, value: cell.value })),
  ];
  return (
    <section aria-label={view.title} className="flex flex-col gap-4">
      <PropertyList items={properties} dense />
      {view.notices.map((text) => <Callout key={text} tone="warn">{text}</Callout>)}

      {view.verdicts.length > 0 && (
        <Part title="논거 판정" note="결정마다 Claude가 그 뒤 사실(서버가 계산한 수익률·낙폭·스탑·무효화 평가, 결정 뒤 지수·계좌 수익률과 관심 종목의 그 뒤 가격)로 내린 판정입니다.">
          <DataTable<ReviewVerdictRow>
            caption="논거 판정"
            dense
            scrollHint
            rows={view.verdicts}
            rowKey={(row) => row.key}
            columns={[
              { key: "decision", header: "결정", className: "break-keep", cell: (row) => <code className="text-xs text-text-2">{row.decision}</code> },
              { key: "book", header: "계좌", className: "whitespace-nowrap", cell: (row) => <span className="whitespace-nowrap text-xs text-text-3">{row.book}</span> },
              { key: "asOf", header: "기준 거래일", className: "whitespace-nowrap", cell: (row) => <span className="whitespace-nowrap text-xs text-text-2">{row.asOf}</span> },
              { key: "kind", header: "종류", className: "break-keep", cell: (row) => <span className="text-xs text-text-3">{row.kind}</span> },
              { key: "thesis", header: "판정", className: "whitespace-nowrap", cell: (row) => <PaperBadge badge={row.thesisHeld} /> },
              { key: "note", header: "근거", className: "break-keep", cell: (row) => <span className="text-xs text-text-2">{row.note}</span> },
            ]}
          />
          {view.missing && <p className="mt-2 text-xs text-text-3">{view.missing}</p>}
        </Part>
      )}

      {entries.length > 0 && (
        <Part title="가정 진입(거절 주문)" note={KR_REVIEW_ENTRY_NOTE}>
          <DataTable<KrReviewEntryRow>
            caption="가정 진입"
            dense
            scrollHint
            rows={entries}
            rowKey={(row) => row.key}
            columns={[
              { key: "decision", header: "결정", className: "break-keep", cell: (row) => <span className="whitespace-nowrap text-xs text-text-2">{row.decision}</span> },
              { key: "ticker", header: "종목", className: "break-keep", cell: (row) => <span className="font-semibold text-text"><TickerName code={row.ticker} /></span> },
              // 방향이 있어야 변화의 부호를 읽을 수 있습니다 — 매도의 음수는 피한 하락(손실이 아님).
              {
                key: "side",
                header: "방향",
                className: "whitespace-nowrap",
                cell: (row) => <span className={`text-xs ${sideClass(row.sideCode)}`}>{row.side}</span>,
              },
              { key: "reject", header: "거절 사유", className: "break-keep", cell: (row) => <span className="text-xs text-warn">{row.rejectReason}</span> },
              { key: "entryDate", header: "진입일", className: "whitespace-nowrap", cell: (row) => <span className="whitespace-nowrap text-xs text-text-2">{row.entryDate}</span> },
              { key: "entryPrice", header: "진입가(원)", align: "right", className: "whitespace-nowrap", cell: (row) => row.entryPrice },
              {
                key: "source",
                header: "진입가 출처",
                className: "break-keep",
                cell: (row) => (row.badges.length > 0 ? (
                  <span className="flex flex-wrap gap-1 whitespace-nowrap">{row.badges.map((badge) => <PaperBadge key={badge.key} badge={badge} />)}</span>
                ) : <span className="text-xs text-text-3">—</span>),
              },
              {
                key: "returnPct",
                header: "진입가 → 기준일 종가",
                align: "right",
                cell: (row) => (row.afterSell || row.reason ? (
                  <span className="flex flex-col items-end">
                    <span>{row.returnPct}</span>
                    {row.afterSell && <span className="whitespace-nowrap text-xs text-text-3">{row.afterSell}</span>}
                    {/* 값이 없으면 서버가 notes에 남긴 이유(기준일 뒤 세션·시가 없음·분할 의심 등) — '—'만 두지 않습니다. */}
                    {row.reason && <span className="min-w-[10rem] text-xs leading-snug text-text-3">{row.reason}</span>}
                  </span>
                ) : row.returnPct),
              },
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
                {/* 다른 한국 화면처럼 계좌 이름 — 코드는 마우스를 올려 봅니다. */}
                <span className="font-medium text-text-2" title={row.code}>{row.book}</span>
                <span className="tabular-nums font-semibold text-text">{row.returnPct}</span>
                {row.reason && <span className="text-text-3">{row.reason}</span>}
                {row.badges.map((badge) => <PaperBadge key={badge.key} badge={badge} />)}
              </li>
            ))}
          </ul>
        </Part>
      )}

      {view.recurringErrors.length > 0 && (
        <Part title="반복되는 오류">
          <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-text-2">
            {view.recurringErrors.map((text) => <li key={text}>{text}</li>)}
          </ul>
        </Part>
      )}
      {view.keep.length > 0 && (
        <Part title="지킬 것">
          <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-text-2">
            {view.keep.map((text) => <li key={text}>{text}</li>)}
          </ul>
        </Part>
      )}
      {view.watchItems.length > 0 && (
        <Part title="지켜볼 것" note="규칙을 바꾸기에는 근거가 모자라 다음 복기가 이어받아 따지는 항목입니다.">
          <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-text-2">
            {view.watchItems.map((text) => <li key={text}>{text}</li>)}
          </ul>
        </Part>
      )}

      {proposal && (
        <Part title="프레임 제안" note="자동 반영은 없습니다 — 프레임 탭에서 승인해야 새 판이 됩니다.">
          <div className="flex flex-col gap-2 rounded-control border border-border px-3 py-2">
            <p className="text-sm font-semibold text-text">{proposal.label}</p>
            {proposal.summary && <p className="text-xs leading-relaxed text-text-2">{proposal.summary}</p>}
            <p className="text-xs text-text-3">{proposal.detail}</p>
            {onOpenProposal && (
              <div>
                <Button onClick={() => onOpenProposal(proposal.id)}>프레임 탭에서 이 제안 보기</Button>
              </div>
            )}
          </div>
        </Part>
      )}
      {view.noProposal && <p className="text-xs text-text-3">제안 없음 — 이번 복기는 프레임을 고칠 반복 오류를 찾지 않았습니다.</p>}

      {view.usage.length > 0 && (
        <Part title="사용량">
          <PropertyList items={view.usage.map((cell) => ({ key: cell.key, label: cell.label, value: cell.value }))} dense />
        </Part>
      )}
      {view.input && (
        <DetailFold summary="복기 입력(JSON — 서버가 장부에서 만든 사실)">
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs text-text-2">{view.input}</pre>
        </DetailFold>
      )}
      {view.response && (
        <DetailFold summary="복기 응답(JSON)">
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs text-text-2">{view.response}</pre>
        </DetailFold>
      )}
    </section>
  );
}

function Part({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-text">{title}</h3>
      {note && <p className="text-xs text-text-3">{note}</p>}
      {children}
    </section>
  );
}
