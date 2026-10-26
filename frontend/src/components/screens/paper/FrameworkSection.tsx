"use client";

import { type ReactNode, useEffect, useState } from "react";
import { Banner, Button, Card, ErrorState, Loading, Select, Table } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useElapsedSeconds } from "@/hooks/useElapsedSeconds";
import { apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { formatNumber } from "@/lib/format";
import {
  APPROVE_COST_NOTE,
  approveResultView,
  type Badge,
  charCount,
  type CompareLine,
  editFrameworkDraft,
  FRAMEWORK_GUIDANCE_LIMIT,
  FRAMEWORK_TEXT_LIMIT,
  frameworkBudgetFrom,
  frameworkCompareDefaults,
  frameworkCompareOptions,
  type FrameworkCurrentView,
  frameworkCurrentView,
  type FrameworkDraft,
  type FrameworkDraftEdit,
  frameworkDraftCheck,
  frameworkDraftFrom,
  frameworkSavePayload,
  frameworkSaveResultView,
  frameworkSourceCardView,
  type FrameworkVersionRow,
  frameworkVersionLabel,
  frameworkVersionRows,
  insightNoteOptions,
  insightNotePayload,
  noteCreateResultView,
  PAPER_SOURCES,
  PROPOSAL_COST_NOTE,
  type ProposalAssessmentRow,
  type ProposalOperationRow,
  proposalBaseToFetch,
  proposalFocusView,
  proposalView,
  proposeResultView,
  rejectResultView,
  renderedCompare,
  textLength,
} from "@/lib/paper";
import type {
  PaperFrameworkMaxIds,
  PaperFrameworkProposal,
  PaperFrameworkResponse,
  PaperFrameworkSaveResult,
  PaperFrameworkVersion,
  PaperFrameworkVersionResponse,
  PaperNoteCreateResult,
  PaperNotesResponse,
  PaperOkResult,
  PaperProposalApproveResult,
  PaperProposalsResponse,
  PaperProposeResult,
  PaperSettingsResponse,
} from "@/lib/types";

const INPUT = "w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-body outline-hidden focus:border-accent";

/**
 * 프레임 탭(명세 F1~F5·F7·D15) — Claude 책의 판단 프레임(투자 OS) 판.
 *
 * 위에서부터: 지금 판(상태 배지 — 임시면 "임시 v0", 렌더링 미리보기는 접어 둠, 토큰 어림 vs 예산·초과 경고, 바꾼 내용), 제안 요청
 * 카드(임시 판이면 "OS 원문으로 새 판 만들기", 사용자 판이면 "방법론 글로 갱신 제안 받기" — 글 → 방법론 메모 저장 또는 있는 메모 고르기 →
 * Claude 제안 → 승인), 제안 목록(평가·변경·전후 비교, 승인·거절), 판 목록과 두 판 나란히 비교, 직접 고치기(원칙·엔진·규칙 폼 — 저장하면
 * 사용자 판).
 *
 * 렌더링·토큰 어림·예산 초과는 서버가 정합니다(화면은 다시 세지 않음). 제안 요청만 Claude를 부르고(비용·하루 상한 공유 — 확인 단계),
 * 승인·거절·수동 편집은 부르지 않습니다. 어느 쪽이든 판이 바뀌면 지금 판과 제안 목록을 다시 읽습니다. 규칙 책은 프레임을 쓰지 않습니다.
 *
 * 결정 로그 탭의 주간 복기에서 제안 링크를 누르고 오면({@code focusProposalId}) 제안 목록의 그 제안으로 스크롤하고 테두리로 강조합니다
 * (2단계 D — 복기가 낸 제안도 같은 목록·같은 승인 흐름).
 */
export function FrameworkSection({ focusProposalId = null }: { focusProposalId?: number | null }) {
  const framework = useApi<PaperFrameworkResponse>(endpoints.paper.framework);
  const proposals = useApi<PaperProposalsResponse>(endpoints.paper.proposals);
  // 예산(frameworkTokenBudget)이 판 응답에 없을 때만 설정 값을 씁니다(계약에 없는 필드) — 실패해도 토큰 어림은 그대로 보입니다.
  const settings = useApi<PaperSettingsResponse>(endpoints.paper.settings);
  const proposalList = proposals.data?.available ? proposals.data.proposals ?? [] : [];
  const focus = proposalFocusView(proposalList, focusProposalId);
  const frameworkReady = Boolean(framework.data?.available);
  // 목록이 그려진 뒤에 옮깁니다(판 응답이 늦으면 목록이 아직 없음). jsdom에는 scrollIntoView가 없어 있을 때만 부릅니다.
  useEffect(() => {
    if (!focus.found || focusProposalId === null || !frameworkReady) return;
    document.getElementById(`paper-proposal-${focusProposalId}`)?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [focus.found, focusProposalId, frameworkReady]);

  if (framework.loading && !framework.data) return <Loading label="프레임을 읽는 중…" />;
  if (framework.error) return <ErrorState message={framework.error} onRetry={framework.reload} />;
  if (!framework.data) return null;
  if (!framework.data.available) return <Banner tone="warn">{framework.data.message ?? "프레임을 읽을 수 없습니다."}</Banner>;

  const current = framework.data.current ?? null;
  const view = frameworkCurrentView(current, frameworkBudgetFrom(framework.data, settings.data?.available ? settings.data.body : null));
  const sourceCard = frameworkSourceCardView(current?.status);
  const reloadAll = () => {
    void framework.reload();
    void proposals.reload();
  };

  return (
    <>
      <CurrentCard view={view} />

      <OsSourceCard current={current} proposals={proposalList} onChanged={reloadAll} />

      <Card
        title="제안"
        subtitle="Claude가 OS 절차 B로 낸 변경 제안(최근 순) — 자동 반영은 없고, 승인해야 새 판이 됩니다."
        source={PAPER_SOURCES.proposals}
      >
        {proposals.loading && !proposals.data && <Loading label="제안을 읽는 중…" />}
        {proposals.error && <ErrorState message={proposals.error} onRetry={proposals.reload} />}
        {proposals.data && !proposals.data.available && (
          <Banner tone="warn">{proposals.data.message ?? "제안을 읽을 수 없습니다."}</Banner>
        )}
        {proposals.data?.available && focus.note && <div className="mb-3"><Banner tone="info">{focus.note}</Banner></div>}
        {proposals.data?.available && (proposalList.length === 0 ? (
          <p className="text-sm text-muted">{`아직 제안이 없습니다 — 위 '${sourceCard.title}'에서 요청하면 생깁니다.`}</p>
        ) : (
          <div className="flex flex-col gap-4">
            {proposalList.map((proposal) => (
              <ProposalItem
                key={proposal.id}
                proposal={proposal}
                current={current}
                onChanged={reloadAll}
                anchor
                highlighted={proposal.id === focusProposalId}
              />
            ))}
          </div>
        ))}
      </Card>

      <VersionsCard response={framework.data} />

      <EditCard current={current} maxIds={framework.data.maxIdNumbers ?? null} onChanged={reloadAll} />
    </>
  );
}

/** 지금 판 카드. 판이 없으면(서버가 아직 시드하지 않음) 그렇다고 적습니다. */
function CurrentCard({ view }: { view: FrameworkCurrentView | null }) {
  if (!view) {
    return (
      <Card title="지금 프레임" source={PAPER_SOURCES.framework}>
        <p className="text-sm text-muted">아직 판이 없습니다 — 서버가 프레임 표를 처음 읽을 때 임시 v0을 만듭니다. 잠시 뒤 다시 읽어 보세요.</p>
      </Card>
    );
  }
  return (
    <Card title="지금 프레임" subtitle={view.title} source={PAPER_SOURCES.framework} actions={<BadgeChip badge={view.badge} />}>
      {view.interimNote && <Banner tone="warn">{view.interimNote}</Banner>}
      <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs">
        <Meta label="판" value={view.badge.label} />
        <Meta label="만든 시각" value={view.createdAt} />
        {view.counts && <Meta label="구성" value={view.counts} />}
        <Meta label="렌더링 크기" value={view.tokens} />
      </dl>
      {view.overBudget && <div className="mt-3"><Banner tone="warn">{view.overBudget}</Banner></div>}
      <p className="mt-3 text-xs text-body">
        <span className="text-muted">바꾼 내용 </span>
        {view.changelog}
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-muted">
        토큰은 서버의 문자 수 어림입니다(한글 1자 ≈ 1토큰, 영문 4자 ≈ 1토큰). 아래 렌더링은 이 판을 만들 때의 글이고, 결정의 시스템
        프롬프트는 결정 시점의 설정(하드 규칙 수치)으로 다시 렌더링합니다 — 결정 기록마다 프레임 판과 설정 버전이 남습니다.
      </p>
      <details className="mt-3 rounded-md border border-border px-3 py-2 text-xs">
        <summary className="cursor-pointer text-muted">렌더링 미리보기(시스템 프롬프트)</summary>
        {view.rendered ? (
          <pre className="mt-2 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-body">{view.rendered}</pre>
        ) : (
          <p className="mt-2 text-muted">서버가 렌더링을 보내지 않았습니다.</p>
        )}
      </details>
    </Card>
  );
}

/**
 * 제안 요청 카드(F1·F2) — ① 글을 방법론 메모(INSIGHT)로 저장하거나 이미 있는 방법론 메모를 고름 → ② 그 메모로 제안 요청(Claude 호출 1회,
 * 확인 단계) → ③ 받은 제안을 그 자리에서 보고 승인·거절. 이름·안내는 지금 판에 따라 바뀝니다(임시 판: "OS 원문으로 새 판 만들기", 사용자 판:
 * "방법론 글로 갱신 제안 받기" — frameworkSourceCardView). 원문은 메모에만 남고 프레임에는 승인한 규칙만 들어갑니다(F4). 메모를 저장하거나
 * 고른 뒤에는 글을 잠급니다 — 제안이 실패해 다시 요청할 때 같은 메모를 쓰게(다시 저장해 같은 글의 메모가 쌓이지 않게). 있는 메모를 고르는
 * 목록은 보관하지 않은 방법론 메모만 보입니다(서버가 보관 메모의 제안을 거절).
 */
function OsSourceCard({
  current,
  proposals,
  onChanged,
}: {
  current: PaperFrameworkVersion | null;
  proposals: readonly PaperFrameworkProposal[];
  onChanged: () => void;
}) {
  const card = frameworkSourceCardView(current?.status);
  const notes = useApi<PaperNotesResponse>(endpoints.paper.notes(false));
  const noteOptions = insightNoteOptions(notes.data?.available ? notes.data.notes : null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [picked, setPicked] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const saveNote = useAsyncAction(
    (payload: ReturnType<typeof insightNotePayload>) => apiPost<PaperNoteCreateResult>(endpoints.paper.createNote, payload),
    "메모를 저장하지 못했습니다.",
  );
  const propose = useAsyncAction(
    (noteId: number) => apiPost<PaperProposeResult>(endpoints.paper.propose, { noteId }),
    "제안을 받지 못했습니다.",
  );
  const elapsed = useElapsedSeconds(propose.busy);
  // "다른 글로 다시 쓰기"를 누르면 그때의 저장·제안 결과를 치웁니다 — 훅에 결과를 비우는 함수가 없어, 치운 결과를 기억해 두고 그와 같은
  // 결과는 그리지 않습니다(새로 저장하면 새 결과 객체라 다시 보임).
  const [dismissed, setDismissed] = useState<{ note: PaperNoteCreateResult | null; proposal: PaperProposeResult | null }>({
    note: null,
    proposal: null,
  });
  const noteResult = saveNote.result !== dismissed.note ? saveNote.result : null;
  const proposeResult = propose.result !== dismissed.proposal ? propose.result : null;

  const savedId = noteResult && noteResult.ok !== false ? noteResult.note?.id ?? null : null;
  const noteId = savedId ?? picked;
  const locked = noteId !== null;
  const noteView = noteResult ? noteCreateResultView(noteResult) : null;
  const proposeView = proposeResult ? proposeResultView(proposeResult) : null;
  const createdId = proposeResult?.proposal?.id ?? null;
  // 승인·거절 뒤 목록을 다시 읽으면 상태가 바뀐 그 제안을 씁니다 — 요청 응답의 사본은 처음 상태(대기)에 멈춰 있습니다.
  const created = createdId === null ? null : proposals.find((entry) => entry.id === createdId) ?? proposeResult?.proposal ?? null;
  const count = textLength(body.trim());

  const runSave = async () => {
    // 저장한 메모가 고르기 목록에도 보이게 다시 읽습니다("다른 글로 다시 쓰기" 뒤 그 메모를 다시 고를 수 있게).
    if (await saveNote.run(insightNotePayload(title, body, card.defaultTitle))) void notes.reload();
  };
  const runPropose = async () => {
    if (noteId === null) return;
    const ok = await propose.run(noteId);
    // 성공·실패 모두 확인을 닫습니다 — 실패 사유는 아래 경고로 남고, 다시 부르려면 확인을 한 번 더 거칩니다.
    setConfirming(false);
    if (ok) onChanged();
  };
  const restart = () => {
    setTitle("");
    setBody("");
    setPicked(null);
    setConfirming(false);
    setDismissed({ note: saveNote.result, proposal: propose.result });
  };
  const pick = (value: string) => {
    setPicked(value === "" ? null : Number(value));
    setConfirming(false);
  };

  return (
    <Card title={card.title} subtitle={card.subtitle} source={PAPER_SOURCES.proposals}>
      <p className="text-xs leading-relaxed text-muted">{card.intro}</p>

      <div className="mt-3 flex flex-col gap-2">
        {noteOptions.length > 0 && (
          <Select
            label="이미 있는 방법론 메모로 요청"
            value={picked === null ? "" : String(picked)}
            onChange={pick}
            disabled={savedId !== null || propose.busy}
            options={[{ value: "", label: "고르지 않음 — 아래에 글을 붙여 새 메모로" }, ...noteOptions]}
          />
        )}
        <label className="flex flex-col gap-1 text-xs text-muted">
          {`메모 제목(비우면 "${card.defaultTitle}")`}
          <input
            type="text"
            value={title}
            readOnly={locked}
            onChange={(event) => setTitle(event.target.value)}
            className={INPUT}
          />
        </label>
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1 text-xs text-muted">
            {card.bodyLabel}
            <textarea
              value={body}
              rows={10}
              readOnly={locked}
              onChange={(event) => setBody(event.target.value)}
              className={`${INPUT} font-mono text-xs leading-relaxed`}
            />
          </label>
          <span className="text-[11px] text-muted">
            {picked !== null && savedId === null
              ? `메모 #${picked}의 글로 요청합니다 — 새 메모를 만들지 않습니다.`
              : `${formatNumber(count, 0)}자`}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void runSave()} disabled={count === 0 || locked || saveNote.busy}>
            {saveNote.busy ? "저장 중…" : "① 메모로 저장"}
          </Button>
          {locked && <Button variant="ghost" onClick={restart} disabled={propose.busy}>다른 글로 다시 쓰기</Button>}
        </div>
        {saveNote.error && <Banner tone="warn">{saveNote.error}</Banner>}
        {noteView && <Banner tone={noteView.tone}>{noteView.text}</Banner>}
      </div>

      <div className="mt-4 flex flex-col gap-2 border-t border-border pt-3">
        <p className="text-xs text-muted">비용: {PROPOSAL_COST_NOTE}</p>
        {confirming ? (
          <div className="flex flex-col gap-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-3">
            <p className="text-sm leading-relaxed text-warn">
              {`메모(#${noteId ?? "—"})로 제안을 요청할까요? ${PROPOSAL_COST_NOTE} 판은 바뀌지 않습니다 — 받은 제안을 승인해야 새 판이 됩니다.`}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={() => void runPropose()} disabled={propose.busy}>
                {propose.busy ? `제안 받는 중… ${elapsed}초` : "제안 요청 확인"}
              </Button>
              <Button onClick={() => setConfirming(false)} disabled={propose.busy}>취소</Button>
            </div>
          </div>
        ) : (
          <div>
            <Button variant="primary" onClick={() => setConfirming(true)} disabled={noteId === null || propose.busy}>
              ② 제안 요청
            </Button>
          </div>
        )}
        {/* 서버 문구(호출 상한·키 없음·다른 요청 진행 중·보관한 메모 등)를 그대로 — 무엇을 해야 하는지 서버가 적어 보냅니다. */}
        {propose.error && <Banner tone="warn">{propose.error}</Banner>}
        {proposeView && <Banner tone={proposeView.tone}>{proposeView.text}</Banner>}
        {created && <ProposalItem proposal={created} current={current} onChanged={onChanged} />}
      </div>
    </Card>
  );
}

/** 확인을 연 동작. */
type Deciding = "approve" | "reject" | null;

/**
 * 제안 한 건 — 머리(상태·요청 시각·모델·근거 메모·기준 판), 요약, 평가 표, 변경 표(대기 중이면 지금 글, 결정된 제안이면 기준 판 글 → 바꿀
 * 글), 전후 비교, 오류. 대기 중이면 승인·거절(둘 다 확인 단계 — 승인은 새 판을 만들어 다음 결정부터 바뀜). 기준 판이 지금 판과 다르거나 변경이
 * 0건이면 승인 버튼을 막습니다(서버도 400). 결정된 제안의 기준 판이 지금 판이 아니면 그 판을 따로 읽어 대조합니다(proposalBaseToFetch).
 */
function ProposalItem({
  proposal,
  current,
  onChanged,
  anchor = false,
  highlighted = false,
}: {
  proposal: PaperFrameworkProposal;
  current: PaperFrameworkVersion | null;
  onChanged: () => void;
  /** 제안 목록의 항목이면 id를 붙입니다(주간 복기에서 찾아옴) — 요청 카드에 같은 제안이 한 번 더 보여도 id가 겹치지 않게. */
  anchor?: boolean;
  /** 주간 복기에서 이 제안을 눌러 왔음 — 테두리로 강조. */
  highlighted?: boolean;
}) {
  const baseToFetch = proposalBaseToFetch(proposal, current);
  const baseFrame = useApi<PaperFrameworkVersionResponse>(baseToFetch === null ? null : endpoints.paper.frameworkVersion(baseToFetch));
  const view = proposalView(proposal, current, baseFrame.data?.available ? baseFrame.data.version ?? null : null);
  const [deciding, setDeciding] = useState<Deciding>(null);
  const approve = useAsyncAction(
    (id: number) => apiPost<PaperProposalApproveResult>(endpoints.paper.approveProposal(id)),
    "승인하지 못했습니다.",
  );
  const reject = useAsyncAction(
    (id: number) => apiPost<PaperOkResult>(endpoints.paper.rejectProposal(id)),
    "거절하지 못했습니다.",
  );
  const busy = approve.busy || reject.busy;
  const approved = approve.result ? approveResultView(approve.result) : null;
  const rejected = reject.result ? rejectResultView(reject.result) : null;

  const decide = async () => {
    const action = deciding === "approve" ? approve : reject;
    const ok = await action.run(view.id);
    setDeciding(null);
    if (ok) onChanged();
  };

  return (
    <article
      id={anchor ? `paper-proposal-${proposal.id}` : undefined}
      aria-label={view.title}
      aria-current={highlighted ? "true" : undefined}
      className={`flex scroll-mt-4 flex-col gap-3 rounded-lg border bg-canvas px-4 py-3 ${
        highlighted ? "border-accent ring-2 ring-accent/60" : "border-border"
      }`}
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-bright">{view.title}</h3>
        <BadgeChip badge={view.status} />
        {highlighted && <span className="text-[11px] text-accent">주간 복기에서 연 제안</span>}
      </header>
      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
        {view.meta.map((cell) => <Meta key={cell.key} label={cell.label} value={cell.value} />)}
      </dl>
      {view.error && <Banner tone="warn">오류 — {view.error}</Banner>}
      {view.summary && <p className="whitespace-pre-wrap text-sm leading-relaxed text-body">{view.summary}</p>}

      {view.assessment.length > 0 && (
        <Part title="평가 (OS 절차 B)" note="원문의 주장마다 지금 판과 대조한 결과입니다 — Claude 응답 그대로.">
          <Table<ProposalAssessmentRow>
            rows={view.assessment}
            rowKey={(row) => row.key}
            columns={[
              { key: "point", header: "주장", render: (row) => <span className="text-xs text-body">{row.point}</span> },
              { key: "verdict", header: "평가", render: (row) => <BadgeChip badge={row.verdict} /> },
              { key: "reason", header: "이유", render: (row) => <span className="text-xs text-body">{row.reason}</span> },
            ]}
          />
        </Part>
      )}

      {(view.operations.length > 0 || view.pending) && (
        <Part title="변경" note={view.operationsNote}>
          <Table<ProposalOperationRow>
            rows={view.operations}
            rowKey={(row) => row.key}
            emptyMessage={view.emptyMessage}
            columns={[
              { key: "op", header: "변경", render: (row) => <span className="whitespace-nowrap font-semibold text-bright">{row.op}</span> },
              { key: "target", header: "대상", render: (row) => <code className="text-xs text-body">{row.target}</code> },
              { key: "before", header: view.beforeHeader, render: (row) => <span className="text-xs text-muted">{row.before}</span> },
              {
                key: "after",
                header: "바꿀 글",
                render: (row) => (
                  <span className="flex flex-col gap-1 text-xs text-body">
                    <span>{row.after}</span>
                    {row.warning && <span className="text-warn">{row.warning}</span>}
                  </span>
                ),
              },
              { key: "why", header: "이유", render: (row) => <span className="text-xs text-body">{row.why}</span> },
            ]}
          />
        </Part>
      )}

      {view.beforeAfter && (
        <Part title="전후 비교">
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-body">{view.beforeAfter}</p>
        </Part>
      )}

      {view.staleBase && <Banner tone="warn">{view.staleBase}</Banner>}

      {view.pending && (deciding ? (
        <div className="flex flex-col gap-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-3">
          <p className="text-sm leading-relaxed text-warn">{deciding === "approve" ? view.confirmApprove : view.confirmReject}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => void decide()} disabled={busy}>
              {busy ? "보내는 중…" : deciding === "approve" ? "승인 확인" : "거절 확인"}
            </Button>
            <Button onClick={() => setDeciding(null)} disabled={busy}>취소</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => setDeciding("approve")} disabled={busy || !view.approvable}>
              {`${view.title} 승인`}
            </Button>
            <Button onClick={() => setDeciding("reject")} disabled={busy}>{`${view.title} 거절`}</Button>
          </div>
          <p className="text-[11px] text-muted">{APPROVE_COST_NOTE}</p>
        </div>
      ))}

      {/* 서버의 400 문구(다른 판이 먼저 승인됨·대상 없음 등)를 그대로. */}
      {approve.error && <Banner tone="warn">{approve.error}</Banner>}
      {reject.error && <Banner tone="warn">{reject.error}</Banner>}
      {approved && <Banner tone={approved.tone}>{approved.text}</Banner>}
      {approved?.warning && <Banner tone="warn">{approved.warning}</Banner>}
      {rejected && <Banner tone={rejected.tone}>{rejected.text}</Banner>}
    </article>
  );
}

/**
 * 판 목록과 두 판 나란히 비교 — 두 판의 렌더링은 서버가 준 글 그대로(GET …/versions/{v}), 다른 쪽에 없는 줄만 표시합니다. 기본은 지금 판과
 * 그 바로 앞 판입니다.
 */
function VersionsCard({ response }: { response: PaperFrameworkResponse }) {
  const versions = response.versions ?? [];
  const currentVersion = response.current?.version ?? null;
  const rows = frameworkVersionRows(versions, currentVersion);
  const options = frameworkCompareOptions(versions);
  const [picked, setPicked] = useState<{ left: number | null; right: number | null } | null>(null);
  const selection = picked ?? frameworkCompareDefaults(versions, currentVersion);
  const left = useApi<PaperFrameworkVersionResponse>(selection.left === null ? null : endpoints.paper.frameworkVersion(selection.left));
  const right = useApi<PaperFrameworkVersionResponse>(selection.right === null ? null : endpoints.paper.frameworkVersion(selection.right));
  const leftVersion = left.data?.available ? left.data.version ?? null : null;
  const rightVersion = right.data?.available ? right.data.version ?? null : null;
  const compare = renderedCompare(leftVersion?.rendered, rightVersion?.rendered);
  const pick = (side: "left" | "right", value: string) =>
    setPicked({ ...selection, [side]: value === "" ? null : Number(value) });

  return (
    <Card title="판 목록·비교" subtitle="판마다 바꾼 내용과 출처(제안 승인·수동 편집), 두 판의 렌더링을 나란히." source={PAPER_SOURCES.framework}>
      <Table<FrameworkVersionRow>
        rows={rows}
        rowKey={(row) => row.key}
        emptyMessage="판 목록이 없습니다."
        columns={[
          {
            key: "version",
            header: "판",
            render: (row) => (
              <span className="whitespace-nowrap font-semibold text-bright">
                {row.version}
                {row.current && <span className="ml-1 text-[10px] font-normal text-accent">지금</span>}
              </span>
            ),
          },
          { key: "title", header: "제목", render: (row) => <span className="text-xs text-body">{row.title}</span> },
          { key: "changelog", header: "바꾼 내용", render: (row) => <span className="text-xs text-body">{row.changelog}</span> },
          { key: "source", header: "출처", render: (row) => <span className="whitespace-nowrap text-xs">{row.source}</span> },
          { key: "createdAt", header: "만든 시각", render: (row) => <span className="whitespace-nowrap">{row.createdAt}</span> },
        ]}
      />

      {options.length < 2 ? (
        <p className="mt-3 text-xs text-muted">판이 하나뿐입니다 — 새 판이 생기면 두 판의 렌더링을 나란히 비교할 수 있습니다.</p>
      ) : (
        <section aria-label="두 판 비교" className="mt-4 flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <Select
              label="왼쪽 판"
              value={selection.left === null ? "" : String(selection.left)}
              onChange={(value) => pick("left", value)}
              options={[{ value: "", label: "고르기" }, ...options]}
            />
            <Select
              label="오른쪽 판"
              value={selection.right === null ? "" : String(selection.right)}
              onChange={(value) => pick("right", value)}
              options={[{ value: "", label: "고르기" }, ...options]}
            />
          </div>
          <p className="text-[11px] text-muted">
            강조한 줄은 다른 쪽 렌더링에 똑같은 줄이 없는 줄입니다(왼쪽 {compare.changedLeft}줄 · 오른쪽 {compare.changedRight}줄). 줄 순서를
            맞추는 비교가 아니라서 자리만 옮긴 줄은 강조하지 않습니다.
          </p>
          <div className="grid gap-3 lg:grid-cols-2">
            <RenderedPane
              label={selection.left === null ? "왼쪽" : `v${selection.left} 렌더링`}
              loading={left.loading && !left.data}
              error={left.error}
              message={left.data && !left.data.available ? left.data.message ?? "판을 읽을 수 없습니다." : null}
              version={leftVersion}
              lines={compare.left}
            />
            <RenderedPane
              label={selection.right === null ? "오른쪽" : `v${selection.right} 렌더링`}
              loading={right.loading && !right.data}
              error={right.error}
              message={right.data && !right.data.available ? right.data.message ?? "판을 읽을 수 없습니다." : null}
              version={rightVersion}
              lines={compare.right}
            />
          </div>
        </section>
      )}
    </Card>
  );
}

/** 비교의 한쪽 — 판 이름·상태와 렌더링 줄(다른 쪽에 없는 줄은 강조). */
function RenderedPane({
  label,
  loading,
  error,
  message,
  version,
  lines,
}: {
  label: string;
  loading: boolean;
  error: string | null;
  message: string | null;
  version: PaperFrameworkVersion | null;
  lines: CompareLine[];
}) {
  return (
    <section aria-label={label} className="min-w-0 rounded-md border border-border px-3 py-2">
      <h4 className="text-xs font-semibold text-bright">
        {version ? `${frameworkVersionLabel(version.version, version.status)} — ${version.title ?? ""}` : label}
      </h4>
      {loading && <Loading label="판을 읽는 중…" />}
      {error && <p className="mt-1 text-xs text-warn">{error}</p>}
      {message && <p className="mt-1 text-xs text-warn">{message}</p>}
      {version && (lines.length === 0 ? (
        <p className="mt-1 text-xs text-muted">서버가 렌더링을 보내지 않았습니다.</p>
      ) : (
        <pre className="mt-2 max-h-[32rem] overflow-auto text-[11px] leading-relaxed">
          {lines.map((line) => (
            <span
              key={line.key}
              data-changed={line.changed ? "true" : undefined}
              className={`block whitespace-pre-wrap break-words ${line.changed ? "bg-accent/15 text-bright" : "text-body"}`}
            >
              {line.text || " "}
            </span>
          ))}
        </pre>
      ))}
    </section>
  );
}

/**
 * 직접 고치기(수동 편집, F3) — 지금 판을 복사해 원칙·엔진(8개 고정)·규칙·지침을 폼으로 고치고, 바꾼 내용(changelog)과 함께 저장하면 새 판
 * (사용자 판)이 됩니다. 글자 수는 입력 중에 보이고, 300자·2,000자를 넘거나 빈 칸이 있으면 저장 버튼을 막습니다(서버가 다시 검사).
 * 편집을 시작한 뒤 다른 판이 생기면(제안 승인) 저장을 막습니다 — 그대로 저장하면 그 판의 변경이 사라집니다. 이 화면이 아는 판만 보므로,
 * 저장 본문에 기준 판(baseVersion)을 실어 서버도 대조하고(다른 창·탭에서 승인했으면 400), 저장이 거절되면 판을 다시 읽어 아래 "판이
 * 바뀌었습니다" 안내가 뜨게 합니다(FW-1). 새 원칙·규칙 번호는 모든 판에서 쓴 가장 큰 번호(maxIds)보다 크게 매깁니다(FW-2).
 */
function EditCard({
  current,
  maxIds,
  onChanged,
}: {
  current: PaperFrameworkVersion | null;
  maxIds: PaperFrameworkMaxIds | null;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<FrameworkDraft | null>(null);
  const [confirming, setConfirming] = useState(false);
  const save = useAsyncAction(
    (payload: ReturnType<typeof frameworkSavePayload>) => apiPost<PaperFrameworkSaveResult>(endpoints.paper.saveFramework, payload),
    "판을 저장하지 못했습니다.",
  );
  const startable = frameworkDraftFrom(current) !== null;
  const result = save.result ? frameworkSaveResultView(save.result) : null;

  const start = () => {
    setDraft(frameworkDraftFrom(current, maxIds));
    setConfirming(false);
  };
  const edit = (change: FrameworkDraftEdit) => {
    setDraft((value) => (value ? editFrameworkDraft(value, change) : value));
    // 확인을 연 뒤 또 고치면 확인을 닫습니다 — 확인한 내용과 저장할 내용이 달라지지 않게.
    setConfirming(false);
  };

  if (!draft) {
    return (
      <Card title="직접 고치기" subtitle="지금 판을 복사해 원칙·엔진·규칙을 고치고 새 판으로 저장합니다(사용자 판). Claude를 부르지 않습니다." source={PAPER_SOURCES.framework}>
        <Button onClick={start} disabled={!startable}>지금 판으로 편집 시작</Button>
        {!startable && <p className="mt-2 text-xs text-muted">지금 판의 본문을 읽지 못해 편집할 수 없습니다.</p>}
        {result && <div className="mt-3"><Banner tone={result.tone}>{result.text}</Banner></div>}
        {result?.warning && <div className="mt-3"><Banner tone="warn">{result.warning}</Banner></div>}
      </Card>
    );
  }

  const check = frameworkDraftCheck(draft, current);
  const moved = current !== null && draft.baseVersion !== current.version;
  const canSave = check.canSave && !moved && !save.busy;
  const guidance = charCount(draft.guidance.trim(), FRAMEWORK_GUIDANCE_LIMIT);
  const submit = async () => {
    const ok = await save.run(frameworkSavePayload(draft));
    setConfirming(false);
    if (ok) setDraft(null);
    // 실패해도 판을 다시 읽습니다 — 다른 창에서 판이 생겨 거절됐으면 지금 판이 바뀌어 "판이 바뀌었습니다" 안내가 뜹니다(편집본은 그대로).
    onChanged();
  };

  return (
    <Card
      title="직접 고치기"
      subtitle={`기준 판 ${frameworkVersionLabel(draft.baseVersion, draft.baseStatus)} — 저장하면 새 판(사용자 판)이 되고 다음 Claude 결정부터 씁니다. Claude를 부르지 않습니다(비용 없음).`}
      source={PAPER_SOURCES.framework}
    >
      <form
        aria-label="프레임 편집"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) setConfirming(true);
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-muted">
          제목
          <input type="text" value={draft.title} onChange={(event) => edit({ type: "title", value: event.target.value })} className={INPUT} />
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-semibold text-bright">원칙</legend>
          {draft.principles.map((entry, index) => (
            <TextRow
              key={`${entry.id}-${index}`}
              id={entry.id}
              label={`원칙 ${entry.id}`}
              text={entry.text}
              onChange={(text) => edit({ type: "principle", index, text })}
              onRemove={() => edit({ type: "removePrinciple", index })}
            />
          ))}
          <div><Button onClick={() => edit({ type: "addPrinciple" })}>원칙 추가</Button></div>
        </fieldset>

        {draft.engines.map((engine, engineIndex) => (
          <fieldset key={`${engine.id}-${engineIndex}`} className="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
            <legend className="px-1 text-sm font-semibold text-bright">엔진 {engine.id}</legend>
            <label className="flex flex-col gap-1 text-xs text-muted">
              이름
              <input
                type="text"
                aria-label={`엔진 ${engine.id} 이름`}
                value={engine.name}
                onChange={(event) => edit({ type: "engineName", engine: engineIndex, value: event.target.value })}
                className={INPUT}
              />
            </label>
            {engine.rules.length === 0 && <p className="text-xs text-muted">규칙이 없습니다.</p>}
            {engine.rules.map((rule, index) => (
              <TextRow
                key={`${rule.id}-${index}`}
                id={rule.id}
                label={`규칙 ${rule.id}`}
                text={rule.text}
                note={rule.addedIn === null
                  ? "새 규칙 — 추가한 판 번호는 저장할 때 서버가 채움"
                  : `v${rule.addedIn}에서 추가${rule.sourceNoteId === null ? "" : ` · 근거 메모 #${rule.sourceNoteId}`}`}
                onChange={(text) => edit({ type: "rule", engine: engineIndex, index, text })}
                onRemove={() => edit({ type: "removeRule", engine: engineIndex, index })}
              />
            ))}
            <div><Button onClick={() => edit({ type: "addRule", engine: engineIndex })}>{`규칙 추가 (${engine.id})`}</Button></div>
          </fieldset>
        ))}

        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1 text-xs text-muted">
            지침(엔진 밖 자유 지침)
            <textarea
              value={draft.guidance}
              rows={4}
              onChange={(event) => edit({ type: "guidance", value: event.target.value })}
              className={`${INPUT} leading-relaxed`}
            />
          </label>
          <span className={`text-[11px] ${guidance.over ? "text-warn" : "text-muted"}`}>{guidance.text}</span>
        </div>

        <label className="flex flex-col gap-1 text-xs text-muted">
          바꾼 내용(changelog — 판 목록에 남음)
          <input
            type="text"
            value={draft.changelog}
            onChange={(event) => edit({ type: "changelog", value: event.target.value })}
            className={INPUT}
          />
        </label>

        {moved && (
          <Banner tone="warn">
            편집을 시작한 뒤 판이 바뀌었습니다(기준 {frameworkVersionLabel(draft.baseVersion, draft.baseStatus)} → 지금{" "}
            {frameworkVersionLabel(current?.version, current?.status)}) — 그대로 저장하면 새 판의 변경이 사라집니다. 편집을 다시 시작하세요.
          </Banner>
        )}
        {check.errors.length > 0 && (
          <ul aria-label="저장 전 확인" className="list-disc pl-5 text-xs text-warn">
            {check.errors.map((error) => <li key={error}>{error}</li>)}
          </ul>
        )}

        {confirming ? (
          <div className="flex flex-col gap-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-3">
            <p className="text-sm leading-relaxed text-warn">
              새 판으로 저장할까요? 사용자 판이 되고 다음 Claude 결정부터 이 판으로 판단합니다. 렌더링·토큰 어림은 저장할 때 서버가 계산합니다.
              Claude를 부르지 않습니다(비용 없음).
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={() => void submit()} disabled={save.busy}>
                {save.busy ? "저장 중…" : "저장 확인"}
              </Button>
              <Button onClick={() => setConfirming(false)} disabled={save.busy}>취소</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" disabled={!canSave}>새 판 저장</Button>
            <Button onClick={() => setDraft(null)} disabled={save.busy}>편집 그만두기</Button>
          </div>
        )}
        {/* 서버의 400 문구(엔진 수·id·300자 등)를 그대로 — 무엇이 틀렸는지 서버가 적어 보냅니다. */}
        {save.error && <Banner tone="warn">{save.error}</Banner>}
      </form>
    </Card>
  );
}

/** 원칙·규칙 한 줄 — id, 본문, 글자 수(300자 기준), 지우기. */
function TextRow({
  id,
  label,
  text,
  note,
  onChange,
  onRemove,
}: {
  id: string;
  label: string;
  text: string;
  note?: string | null;
  onChange: (text: string) => void;
  onRemove: () => void;
}) {
  const count = charCount(text.trim(), FRAMEWORK_TEXT_LIMIT);
  return (
    <div className="grid gap-1 sm:grid-cols-[5rem_minmax(0,1fr)_auto] sm:items-start">
      <code className="pt-2 text-xs text-muted">{id}</code>
      <div className="min-w-0">
        <textarea
          aria-label={label}
          value={text}
          rows={2}
          onChange={(event) => onChange(event.target.value)}
          className={`${INPUT} leading-relaxed`}
        />
        <p className={`text-[11px] ${count.over ? "text-warn" : "text-muted"}`}>
          {count.text}
          {note ? ` · ${note}` : ""}
        </p>
      </div>
      <Button variant="ghost" onClick={onRemove}>{`${label} 지우기`}</Button>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="tabular-nums font-semibold text-bright">{value}</dd>
    </div>
  );
}

/** 안의 한 부분 — 제목이 영역 이름이 되어(aria-label) 표마다 따로 찾을 수 있습니다(결정 로그 탭과 같은 모양). */
function Part({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h4 className="text-sm font-semibold text-bright">{title}</h4>
      {note && <p className="text-[11px] leading-relaxed text-muted">{note}</p>}
      {children}
    </section>
  );
}

function BadgeChip({ badge }: { badge: Badge }) {
  return (
    <span title={badge.title} className={`whitespace-nowrap rounded-sm border px-1.5 py-px text-[10px] ${badge.className}`}>
      {badge.label}
    </span>
  );
}
