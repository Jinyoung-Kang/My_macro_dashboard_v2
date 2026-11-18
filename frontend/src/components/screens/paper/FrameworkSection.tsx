"use client";

import { type ReactNode, useEffect, useState } from "react";
import {
  MasterDetail,
  PropertyList,
  type PropertyItem,
  SectionAnchor,
  SectionIndex,
  type SectionIndexItem,
  Timeline,
  type TimelineEntry,
} from "@/components/patterns";
import { Button, Callout, ErrorState, inputClasses, Loading, Panel, Select, Table, Tag } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useElapsedSeconds } from "@/hooks/useElapsedSeconds";
import { apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, formatNumber } from "@/lib/format";
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
  frameworkVersionLabel,
  insightNotePayload,
  mergedInsightNoteOptions,
  noteCreateResultView,
  PAPER_SOURCES,
  PROPOSAL_COST_NOTE,
  type ProposalAssessmentRow,
  type ProposalOperationRow,
  proposalBaseToFetch,
  proposalFocusView,
  proposalStatusBadge,
  proposalView,
  proposeResultView,
  rejectResultView,
  renderedCompare,
  textLength,
} from "@/lib/paper";
import {
  frameworkOutline,
  frameworkOutlineTocLevel,
  type FrameworkVersionEntry,
  frameworkVersionEntries,
} from "@/lib/paperFrameworkOutline";
import type { PaperMarketCode } from "@/lib/paperMarket";
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

import { FrameworkOutline } from "./FrameworkOutline";

const INPUT = `w-full ${inputClasses()}`;

/**
 * 프레임 탭(명세 F1~F5·F7·D15) — Claude 책의 판단 프레임(투자 OS) 판.
 *
 * 위에서부터: 지금 판(상태 배지 — 임시면 "임시 v0", 속성 — 판·만든 시각·구성·토큰 어림 vs 예산·바꾼 내용, 예산 초과 경고, 렌더링 글을 펼친 본문),
 * 제안 요청 카드(임시 판이면 "OS 원문으로 새 판 만들기", 사용자 판이면 "방법론 글로 갱신 제안 받기" — 글 → 방법론 메모 저장 또는 있는 메모 고르기 →
 * Claude 제안 → 승인), 제안 목록(목록-검사 — 고른 제안의 평가·변경·전후 비교, 승인·거절), 판 이력(시각순 목록), 두 판 나란히 비교, 직접 고치기
 * (원칙·엔진·규칙 폼 — 저장하면 사용자 판).
 *
 * <p><b>배치</b>(작업대 P6 — 명세 §7-1 '프레임'): 긴 화면 목차(SectionIndex — 2xl 이상 왼쪽 13rem 세로 목록, 그 아래 본문 위 가로 줄 — 매크로와 같은
 * 까닭으로 1280~1535는 가로 줄)의 칸은 지금 판(하위 칸 = 렌더링 글의 머리 절 — lib/paperFrameworkOutline)·제안 요청·제안(개수)·판 이력(개수)·두 판 비교·
 * 직접 고치기이고, 새로 고친·바로 연 주소의 #절로 맞춥니다(alignHashOnLoad). 렌더링 글은 접지 않고 긴 글(running 15/24, 72ch)로 펼칩니다 — 글은 서버
 * 글 그대로(U10). 제안은 기본 접힘 — 목록 줄('#번호 상태 요약 첫 줄')을 고르면 틀 48rem부터는 오른쪽 넓은 검사 칸, 그 아래는 위쪽 대화상자(제목에
 * 포커스)에 그 제안을 그립니다. 판 이력은 판을 고르면 검사 칸에 판의 속성(새 요청 없음).
 *
 * 렌더링·토큰 어림·예산 초과는 서버가 정합니다(화면은 다시 세지 않음). 제안 요청만 Claude를 부르고(비용·하루 상한 공유 — 확인 단계),
 * 승인·거절·수동 편집은 부르지 않습니다. 어느 쪽이든 판이 바뀌면 지금 판과 제안 목록을 다시 읽습니다. 규칙 책은 프레임을 쓰지 않습니다.
 *
 * 결정 로그 탭의 주간 복기에서 제안 링크를 누르고 오면({@code focusProposalId}) 제안 목록에서 그 제안을 고르고(넓은 틀은 검사 칸, 좁은 틀은 대화상자를
 * 엶) 제안 절로 스크롤합니다 — 검사 칸 안의 '주간 복기에서 연 제안' 글과 aria-current(2단계 D — 복기가 낸 제안도 같은 목록·같은 승인 흐름).
 *
 * <p><b>한국 화면</b>(`market` "KR" — 사용자 결정 2026-10-29: 프레임은 두 시장 공용 화면): 같은 판·같은 쓰기 경로(편집·제안·승인)이고, 맨 위에
 * 공용 판이라는 것과 한국 프롬프트에서 무엇이 본문보다 앞서는지를 적습니다(어느 상태에서든 — 읽는 중·오류에도). 방법론 메모 고르기는 두 시장
 * 목록을 합치고(사용자 결정 2026-10-29 y1 — 두 화면 같음), 저장만 그 화면의 시장 메모(한국은 본문 market:"KR")입니다.
 */
export function FrameworkSection({
  focusProposalId = null,
  market = "US",
}: {
  focusProposalId?: number | null;
  market?: PaperMarketCode;
}) {
  const banner = market === "KR" ? <Callout tone="neutral">{KR_FRAMEWORK_NOTE}</Callout> : null;
  return (
    <>
      {banner}
      <FrameworkBody focusProposalId={focusProposalId} market={market} />
    </>
  );
}

/** 한국 화면 프레임 탭 머리의 안내 — 두 시장 공용 판과 한국 프롬프트의 우선순위(2단계 명세 §5 K34, 사용자 결정 v1 ⓐ). */
const KR_FRAMEWORK_NOTE =
  "두 시장 공용 프레임 — 미국·한국 Claude 계좌가 같은 판을 씁니다. 한국 결정·복기 프롬프트에서는 한국 고정 문단(KR_FIXED_RULES) 첫 줄의 우선순위 "
  + "문장과 한국 하드 규칙 줄(kr.*)이 이 본문보다 앞섭니다(본문의 미국 문장 — NEXT_OBSERVATION·SHY·13F 등 — 은 한국에서 그 문장이 덮음). 판을 "
  + "바꾸면(직접 고치기·제안 승인) 두 시장의 다음 결정부터 바뀝니다. 아래 방법론 메모 고르기·저장은 한국 메모입니다.";

function FrameworkBody({ focusProposalId, market }: { focusProposalId: number | null; market: PaperMarketCode }) {
  const framework = useApi<PaperFrameworkResponse>(endpoints.paper.framework);
  const proposals = useApi<PaperProposalsResponse>(endpoints.paper.proposals);
  // 예산(frameworkTokenBudget)이 판 응답에 없을 때만 설정 값을 씁니다(계약에 없는 필드) — 실패해도 토큰 어림은 그대로 보입니다.
  const settings = useApi<PaperSettingsResponse>(endpoints.paper.settings);
  const proposalList = proposals.data?.available ? proposals.data.proposals ?? [] : [];
  const focus = proposalFocusView(proposalList, focusProposalId);
  const frameworkReady = Boolean(framework.data?.available);
  // 제안 목록에서 고른 제안(검사 칸·대화상자) — 주간 복기에서 연 제안이면 처음부터 그 제안입니다(좁은 틀은 대화상자를 엶 — revealSelectedInDialog).
  const [pickedProposal, setPickedProposal] = useState<string | null>(focusProposalId === null ? null : String(focusProposalId));
  useEffect(() => {
    if (focusProposalId !== null) setPickedProposal(String(focusProposalId));
  }, [focusProposalId]);
  // 목록이 그려진 뒤에 제안 절로 옮깁니다(판 응답이 늦으면 목록이 아직 없음). jsdom에는 scrollIntoView가 없어 있을 때만 부릅니다.
  // 움직임 줄이기(prefers-reduced-motion)를 켠 사람에게는 부드러운 스크롤 대신 바로 옮깁니다(개요 탭의 계좌 상세와 같음).
  useEffect(() => {
    if (!focus.found || focusProposalId === null || !frameworkReady) return;
    const reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(FRAME_IDS.proposals)?.scrollIntoView?.({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
  }, [focus.found, focusProposalId, frameworkReady]);

  if (framework.loading && !framework.data) return <Loading label="프레임을 읽는 중…" />;
  if (framework.error) return <ErrorState message={framework.error} onRetry={framework.reload} />;
  if (!framework.data) return null;
  if (!framework.data.available) return <Callout tone="warn">{framework.data.message ?? "프레임을 읽을 수 없습니다."}</Callout>;

  const current = framework.data.current ?? null;
  const view = frameworkCurrentView(current, frameworkBudgetFrom(framework.data, settings.data?.available ? settings.data.body : null));
  const sourceCard = frameworkSourceCardView(current?.status);
  const outline = frameworkOutline(view?.rendered, OUTLINE_PREFIX);
  const tocLevel = frameworkOutlineTocLevel(outline);
  const versions = frameworkVersionEntries(framework.data.versions, current?.version ?? null);
  const proposalsReady = Boolean(proposals.data?.available);
  const reloadAll = () => {
    void framework.reload();
    void proposals.reload();
  };

  const items: SectionIndexItem[] = [
    {
      id: FRAME_IDS.current,
      label: "지금 판",
      children: outline
        .filter((section) => section.level !== 0 && section.level === tocLevel && section.title !== null)
        .map((section) => ({ id: section.id, label: section.title ?? "" })),
    },
    { id: FRAME_IDS.request, label: "제안 요청" },
    { id: FRAME_IDS.proposals, label: "제안", count: proposalsReady ? proposalList.length : null, pendingCount: proposals.loading && !proposals.data },
    { id: FRAME_IDS.versions, label: "판 이력", count: versions.length },
    { id: FRAME_IDS.compare, label: "두 판 비교" },
    { id: FRAME_IDS.edit, label: "직접 고치기" },
  ];

  return (
    <SectionIndex label="프레임 목차" items={items} columnFrom="2xl" alignHashOnLoad>
      <SectionAnchor id={FRAME_IDS.current} columnFrom="2xl">
        <CurrentCard view={view} outline={outline} tocLevel={tocLevel} />
      </SectionAnchor>

      <SectionAnchor id={FRAME_IDS.request} columnFrom="2xl">
        <OsSourceCard current={current} proposals={proposalList} onChanged={reloadAll} market={market} />
      </SectionAnchor>

      <SectionAnchor id={FRAME_IDS.proposals} columnFrom="2xl">
        <Panel
          title="제안"
          subtitle="Claude가 OS 절차 B로 낸 변경 제안(최근 순) — 자동 반영은 없고, 승인해야 새 판이 됩니다. 줄을 고르면 평가·변경·전후 비교와 승인·거절이 열립니다."
          source={PAPER_SOURCES.proposals}
        >
          {proposals.loading && !proposals.data && <Loading label="제안을 읽는 중…" />}
          {proposals.error && <ErrorState message={proposals.error} onRetry={proposals.reload} />}
          {proposals.data && !proposals.data.available && (
            <Callout tone="warn">{proposals.data.message ?? "제안을 읽을 수 없습니다."}</Callout>
          )}
          {proposals.data?.available && focus.note && <div className="mb-3"><Callout tone="neutral">{focus.note}</Callout></div>}
          {proposals.data?.available && (proposalList.length === 0 ? (
            <p className="text-sm text-text-3">{`아직 제안이 없습니다 — 위 '${sourceCard.title}'에서 요청하면 생깁니다.`}</p>
          ) : (
            // 기본 접힘(명세 §7-1) — 고르기 전에는 제안 상세(평가·변경·전후 비교)를 그리지 않고, 고른 제안만 검사 칸(틀 48rem부터 오른쪽 넓은 칸)이나 위쪽
            // 대화상자에 그립니다. 그래서 결정된 제안의 기준 판 읽기(proposalBaseToFetch)도 그 제안을 고를 때 한 번입니다(예전에는 목록을 그릴 때 제안마다).
            <MasterDetail<PaperFrameworkProposal>
              label="제안 목록"
              items={proposalList}
              itemKey={(proposal) => String(proposal.id)}
              itemLabel={(proposal) => `제안 #${proposal.id}`}
              renderItem={(proposal) => <ProposalRow proposal={proposal} />}
              renderDetail={(proposal) => (
                <ProposalItem
                  proposal={proposal}
                  current={current}
                  onChanged={reloadAll}
                  anchor
                  framed={false}
                  highlighted={proposal.id === focusProposalId}
                />
              )}
              selectedKey={pickedProposal}
              onSelectedKeyChange={setPickedProposal}
              inspectorWidth="wide"
              dialogFocus="title"
              revealSelectedInDialog
              count
              inspectorHint="제안을 고르면 이 칸에 평가·변경·전후 비교와 승인·거절이 나옵니다(j/k·↑↓로 옮김)."
            />
          ))}
        </Panel>
      </SectionAnchor>

      <SectionAnchor id={FRAME_IDS.versions} columnFrom="2xl">
        <VersionHistoryCard entries={versions} />
      </SectionAnchor>

      <SectionAnchor id={FRAME_IDS.compare} columnFrom="2xl">
        <CompareCard response={framework.data} />
      </SectionAnchor>

      <SectionAnchor id={FRAME_IDS.edit} columnFrom="2xl">
        <EditCard current={current} maxIds={framework.data.maxIdNumbers ?? null} onChanged={reloadAll} />
      </SectionAnchor>
    </SectionIndex>
  );
}

/** 목차 칸·닻 id(렌더링 절 닻은 OUTLINE_PREFIX-{차례}). */
const FRAME_IDS = {
  current: "paper-frame-current",
  request: "paper-frame-request",
  proposals: "paper-frame-proposals",
  versions: "paper-frame-versions",
  compare: "paper-frame-compare",
  edit: "paper-frame-edit",
} as const;
const OUTLINE_PREFIX = "paper-frame-section";

/**
 * 지금 판 카드 — 머리(상태 배지), 임시 판 안내, 속성(판·만든 시각·구성·렌더링 크기·바꾼 내용), 예산 초과 경고, 토큰 안내, 그리고 렌더링 글을 펼친 본문
 * (FrameworkOutline — 머리 절마다 목차 닻). 판이 없으면(서버가 아직 시드하지 않음) 그렇다고 적습니다.
 */
function CurrentCard({
  view,
  outline,
  tocLevel,
}: {
  view: FrameworkCurrentView | null;
  outline: ReturnType<typeof frameworkOutline>;
  tocLevel: ReturnType<typeof frameworkOutlineTocLevel>;
}) {
  if (!view) {
    return (
      <Panel title="지금 프레임" source={PAPER_SOURCES.framework}>
        <p className="text-sm text-text-3">아직 판이 없습니다 — 서버가 프레임 표를 처음 읽을 때 임시 v0을 만듭니다. 잠시 뒤 다시 읽어 보세요.</p>
      </Panel>
    );
  }
  const properties: PropertyItem[] = [
    { label: "판", value: view.badge.label },
    { label: "만든 시각", value: view.createdAt },
    { label: "구성", value: view.counts, emptyReason: "본문 없음" },
    { label: "렌더링 크기", value: view.tokens },
    { label: "바꾼 내용", value: view.changelog, block: true },
  ];
  return (
    <Panel title="지금 프레임" subtitle={view.title} source={PAPER_SOURCES.framework} actions={<BadgeChip badge={view.badge} />}>
      <div className="flex min-w-0 flex-col gap-3">
        {view.interimNote && <Callout tone="warn">{view.interimNote}</Callout>}
        <div className="max-w-[40rem]">
          <PropertyList items={properties} dense />
        </div>
        {view.overBudget && <Callout tone="warn">{view.overBudget}</Callout>}
        <p className="max-w-[72ch] text-xs leading-relaxed text-text-3">
          토큰은 서버의 문자 수 어림입니다(한글 1자 ≈ 1토큰, 영문 4자 ≈ 1토큰). 아래 렌더링은 이 판을 만들 때의 글이고, 결정의 시스템
          프롬프트는 결정 시점의 설정(하드 규칙 수치)으로 다시 렌더링합니다 — 결정 기록마다 프레임 판과 설정 버전이 남습니다.
        </p>
        {outline.length > 0 ? (
          <FrameworkOutline sections={outline} tocLevel={tocLevel} label={`${view.badge.label} 렌더링(시스템 프롬프트)`} />
        ) : (
          <p className="text-sm text-text-3">서버가 렌더링을 보내지 않았습니다.</p>
        )}
      </div>
    </Panel>
  );
}

/** 제안 목록 줄 — '#번호 상태 요약 첫 줄'(줄 단추 안 — 링크·단추 없음). 요약이 없으면 '—'. */
function ProposalRow({ proposal }: { proposal: PaperFrameworkProposal }) {
  const firstLine = (proposal.summary ?? "").split("\n").map((line) => line.trim()).find((line) => line !== "") ?? null;
  return (
    <span className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
      <span className="shrink-0 font-semibold tabular-nums text-text">{`#${proposal.id}`}</span>{" "}
      <span className="shrink-0">
        <BadgeChip badge={proposalStatusBadge(proposal.status)} />
      </span>{" "}
      <span className="min-w-0 basis-full break-keep wrap-anywhere text-text-2 @sm:flex-1 @sm:basis-auto">{firstLine ?? EMPTY}</span>
    </span>
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
  market,
}: {
  current: PaperFrameworkVersion | null;
  proposals: readonly PaperFrameworkProposal[];
  onChanged: () => void;
  market: PaperMarketCode;
}) {
  const card = frameworkSourceCardView(current?.status);
  // 고르기 목록은 두 시장 메모를 합칩니다(사용자 결정 2026-10-29 y1 — 프레임은 공용). 저장은 지금 화면의 시장 메모로 남습니다.
  const usNotes = useApi<PaperNotesResponse>(endpoints.paper.market("US").notes(false));
  const krNotes = useApi<PaperNotesResponse>(endpoints.paper.market("KR").notes(false));
  const notes = market === "KR" ? krNotes : usNotes;
  const noteOptions = mergedInsightNoteOptions([
    { market: "US", notes: usNotes.data?.available ? usNotes.data.notes : null },
    { market: "KR", notes: krNotes.data?.available ? krNotes.data.notes : null },
  ]);
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
    if (await saveNote.run(insightNotePayload(title, body, card.defaultTitle, market))) void notes.reload();
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
    <Panel title={card.title} subtitle={card.subtitle} source={PAPER_SOURCES.proposals}>
      <p className="text-xs leading-relaxed text-text-3">{card.intro}</p>

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
        <label className="flex flex-col gap-1 text-xs text-text-3">
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
          <label className="flex flex-col gap-1 text-xs text-text-3">
            {card.bodyLabel}
            <textarea
              value={body}
              rows={10}
              readOnly={locked}
              onChange={(event) => setBody(event.target.value)}
              className={`${INPUT} font-mono text-xs leading-relaxed`}
            />
          </label>
          <span className="text-xs text-text-3">
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
        {saveNote.error && <Callout tone="warn">{saveNote.error}</Callout>}
        {noteView && <Callout tone={noteView.tone}>{noteView.text}</Callout>}
      </div>

      <div className="mt-4 flex flex-col gap-2 border-t border-border pt-3">
        <p className="text-xs text-text-3">비용: {PROPOSAL_COST_NOTE}</p>
        {confirming ? (
          <div className="flex flex-col gap-3 rounded-control border border-warn/30 bg-warn-tint px-4 py-3">
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
        {propose.error && <Callout tone="warn">{propose.error}</Callout>}
        {proposeView && <Callout tone={proposeView.tone}>{proposeView.text}</Callout>}
        {created && <ProposalItem proposal={created} current={current} onChanged={onChanged} />}
      </div>
    </Panel>
  );
}

/** 확인을 연 동작. */
type Deciding = "approve" | "reject" | null;

/**
 * 제안 한 건 — 머리(상태·요청 시각·모델·근거 메모·기준 판), 요약, 평가 표, 변경 표(대기 중이면 지금 글, 결정된 제안이면 기준 판 글 → 바꿀
 * 글), 전후 비교, 오류. 대기 중이면 승인·거절(둘 다 확인 단계 — 승인은 새 판을 만들어 다음 결정부터 바뀜). 기준 판이 지금 판과 다르거나 변경이
 * 0건이면 승인 버튼을 막습니다(서버도 400). 결정된 제안의 기준 판이 지금 판이 아니면 그 판을 따로 읽어 대조합니다(proposalBaseToFetch) — 이 부품이
 * 그려질 때 한 번이라, 제안 목록에서는 그 제안을 고를 때(검사 칸·대화상자 — 작업대 P6 기본 접힘), 요청 카드에서는 받은 제안(대기 — 읽지 않음)입니다.
 */
function ProposalItem({
  proposal,
  current,
  onChanged,
  anchor = false,
  highlighted = false,
  framed = true,
}: {
  proposal: PaperFrameworkProposal;
  current: PaperFrameworkVersion | null;
  onChanged: () => void;
  /** 제안 목록의 항목이면 id를 붙입니다(주간 복기에서 찾아옴) — 요청 카드에 같은 제안이 한 번 더 보여도 id가 겹치지 않게. */
  anchor?: boolean;
  /** 주간 복기에서 이 제안을 눌러 왔음 — '주간 복기에서 연 제안' 글과 aria-current(테두리 강조는 검사 칸 틀이 맡음 — 작업대 P6). */
  highlighted?: boolean;
  /**
   * 제 테두리 상자와 제목을 그리는가 — 요청 카드 안(기본)은 상자와 제목 '제안 #n', 제안 목록의 검사 칸·대화상자는 틀이 상자이고 제목(h3·대화상자 이름)이
   * 같은 '제안 #n'이라 둘 다 그리지 않습니다(영역 이름 aria-label은 그대로).
   */
  framed?: boolean;
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
      className={`flex min-w-0 scroll-mt-4 flex-col gap-3 ${framed ? "rounded-control border border-border bg-surface px-4 py-3" : ""}`.trim()}
    >
      <header className="flex flex-wrap items-center gap-2">
        {framed && <h3 className="text-sm font-semibold text-text">{view.title}</h3>}
        <BadgeChip badge={view.status} />
        {highlighted && <span className="text-xs font-semibold text-text">주간 복기에서 연 제안</span>}
      </header>
      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
        {view.meta.map((cell) => <Meta key={cell.key} label={cell.label} value={cell.value} />)}
      </dl>
      {view.error && <Callout tone="warn">오류 — {view.error}</Callout>}
      {view.summary && <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-2">{view.summary}</p>}

      {view.assessment.length > 0 && (
        <Part title="평가 (OS 절차 B)" note="원문의 주장마다 지금 판과 대조한 결과입니다 — Claude 응답 그대로.">
          <Table<ProposalAssessmentRow>
            label="평가"
            rows={view.assessment}
            rowKey={(row) => row.key}
            columns={[
              { key: "point", header: "주장", render: (row) => <span className="text-xs text-text-2">{row.point}</span> },
              { key: "verdict", header: "평가", render: (row) => <BadgeChip badge={row.verdict} /> },
              { key: "reason", header: "이유", render: (row) => <span className="text-xs text-text-2">{row.reason}</span> },
            ]}
          />
        </Part>
      )}

      {(view.operations.length > 0 || view.pending) && (
        <Part title="변경" note={view.operationsNote}>
          <Table<ProposalOperationRow>
            label="변경"
            rows={view.operations}
            rowKey={(row) => row.key}
            emptyMessage={view.emptyMessage}
            columns={[
              { key: "op", header: "변경", render: (row) => <span className="whitespace-nowrap font-semibold text-text">{row.op}</span> },
              { key: "target", header: "대상", render: (row) => <code className="text-xs text-text-2">{row.target}</code> },
              { key: "before", header: view.beforeHeader, render: (row) => <span className="text-xs text-text-3">{row.before}</span> },
              {
                key: "after",
                header: "바꿀 글",
                render: (row) => (
                  <span className="flex flex-col gap-1 text-xs text-text-2">
                    <span>{row.after}</span>
                    {row.warning && <span className="text-warn">{row.warning}</span>}
                  </span>
                ),
              },
              { key: "why", header: "이유", render: (row) => <span className="text-xs text-text-2">{row.why}</span> },
            ]}
          />
        </Part>
      )}

      {view.beforeAfter && (
        <Part title="전후 비교">
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-text-2">{view.beforeAfter}</p>
        </Part>
      )}

      {view.staleBase && <Callout tone="warn">{view.staleBase}</Callout>}

      {view.pending && (deciding ? (
        <div className="flex flex-col gap-3 rounded-control border border-warn/30 bg-warn-tint px-4 py-3">
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
          <p className="text-xs text-text-3">{APPROVE_COST_NOTE}</p>
        </div>
      ))}

      {/* 서버의 400 문구(다른 판이 먼저 승인됨·대상 없음 등)를 그대로. */}
      {approve.error && <Callout tone="warn">{approve.error}</Callout>}
      {reject.error && <Callout tone="warn">{reject.error}</Callout>}
      {approved && <Callout tone={approved.tone}>{approved.text}</Callout>}
      {approved?.warning && <Callout tone="warn">{approved.warning}</Callout>}
      {rejected && <Callout tone={rejected.tone}>{rejected.text}</Callout>}
    </article>
  );
}

/**
 * 판 이력 — 판 목록(서버 순서 — 최근 순)을 시각순 목록(Timeline — 만든 날·종류 태그(처음·제안 승인·수동 편집)·'판 제목' 요약, 지금 판 표지)으로.
 * 판 하나를 고르면 검사 칸(틀 32rem부터 옆 칸, 그 아래 위쪽 대화상자 — 열면 제목에 포커스)에 판·제목·바꾼 내용·출처·만든 시각·토큰 어림을 보입니다
 * (모두 판 목록 응답의 값 — 새 요청 없음, 토큰은 계약 밖 tokensEst를 보낼 때만). 지난 판의 렌더링 글은 아래 '두 판 비교'에서 읽습니다.
 */
function VersionHistoryCard({ entries }: { entries: readonly FrameworkVersionEntry[] }) {
  const byKey = new Map(entries.map((entry) => [entry.key, entry] as const));
  const timeline: TimelineEntry[] = entries.map((entry) => ({
    key: entry.key,
    at: entry.createdDate ?? EMPTY,
    dateTime: entry.createdDate ?? undefined,
    kind: { label: entry.kind },
    summary: (
      <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-semibold tabular-nums text-text">{entry.label}</span>
        {entry.current ? (
          <span className="whitespace-nowrap">
            <Tag>지금 판</Tag>
          </span>
        ) : null}{" "}
        <span className="min-w-0 text-text-2">{entry.title}</span>
      </span>
    ),
    title: `${entry.label} — ${entry.title}`,
  }));
  return (
    <Panel title="판 이력" subtitle="판마다 바꾼 내용과 출처(제안 승인·수동 편집) — 판을 고르면 자세한 값이 나옵니다." source={PAPER_SOURCES.framework}>
      <Timeline
        label="판 이력"
        entries={timeline}
        emptyText="판 목록이 없습니다."
        count={(count) => `${count.toLocaleString("ko-KR")}판`}
        dialogFocus="title"
        inspectorHint="판을 고르면 이 칸에 바꾼 내용·출처·만든 시각이 나옵니다(j/k·↑↓로 옮김)."
        renderDetail={(item) => {
          const entry = byKey.get(item.key);
          if (!entry) return null;
          const properties: PropertyItem[] = [
            { label: "판", value: entry.current ? <span className="inline-flex flex-wrap items-baseline justify-end gap-1">{entry.label} <Tag>지금 판</Tag></span> : entry.label },
            { label: "제목", value: entry.title },
            { label: "바꾼 내용", value: entry.changelog, block: true },
            { label: "출처", value: entry.source },
            { label: "만든 시각", value: entry.createdAt },
            { label: "렌더링 크기", value: entry.tokens, emptyReason: "서버가 보내지 않음" },
          ];
          return <PropertyList items={properties} dense />;
        }}
      />
    </Panel>
  );
}

/**
 * 두 판 나란히 비교 — 두 판의 렌더링은 서버가 준 글 그대로(GET …/versions/{v}), 다른 쪽에 없는 줄만 표시합니다. 기본은 지금 판과 그 바로 앞 판입니다
 * (판이 하나여도 오른쪽 기본 — 지금 판 — 을 읽는 것은 예전 그대로). 판이 하나뿐이면 비교 대신 안내입니다.
 */
function CompareCard({ response }: { response: PaperFrameworkResponse }) {
  const versions = response.versions ?? [];
  const currentVersion = response.current?.version ?? null;
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
    <Panel title="두 판 비교" subtitle="두 판의 렌더링을 나란히 — 기본은 지금 판과 그 바로 앞 판." source={PAPER_SOURCES.framework}>
      {options.length < 2 ? (
        <p className="text-xs text-text-3">판이 하나뿐입니다 — 새 판이 생기면 두 판의 렌더링을 나란히 비교할 수 있습니다.</p>
      ) : (
        <section aria-label="두 판 비교" className="flex flex-col gap-3">
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
          <p className="text-xs text-text-3">
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
    </Panel>
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
    <section aria-label={label} className="min-w-0 rounded-control border border-border px-3 py-2">
      <h4 className="text-xs font-semibold text-text">
        {version ? `${frameworkVersionLabel(version.version, version.status)} — ${version.title ?? ""}` : label}
      </h4>
      {loading && <Loading label="판을 읽는 중…" />}
      {error && <p className="mt-1 text-xs text-warn">{error}</p>}
      {message && <p className="mt-1 text-xs text-warn">{message}</p>}
      {version && (lines.length === 0 ? (
        <p className="mt-1 text-xs text-text-3">서버가 렌더링을 보내지 않았습니다.</p>
      ) : (
        <pre className="mt-2 max-h-[32rem] overflow-auto text-xs leading-relaxed">
          {lines.map((line) => (
            <span
              key={line.key}
              data-changed={line.changed ? "true" : undefined}
              // 강조한 줄은 회색 바탕 + 굵은 잉크 글(강조 파랑 아님 — 명세 A1). 굵기는 고대비 모드에서 바탕이 지워져도 남습니다.
              className={`block whitespace-pre-wrap break-words ${line.changed ? "bg-surface-2 font-semibold text-text" : "text-text-2"}`}
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
 * (사용자 판)이 됩니다. 글자 수는 입력 중에 보이고, 4,000자·20,000자를 넘거나 빈 칸이 있으면 저장 버튼을 막습니다(서버가 다시 검사).
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
      <Panel title="직접 고치기" subtitle="지금 판을 복사해 원칙·엔진·규칙을 고치고 새 판으로 저장합니다(사용자 판). Claude를 부르지 않습니다." source={PAPER_SOURCES.framework}>
        <Button onClick={start} disabled={!startable}>지금 판으로 편집 시작</Button>
        {!startable && <p className="mt-2 text-xs text-text-3">지금 판의 본문을 읽지 못해 편집할 수 없습니다.</p>}
        {result && <div className="mt-3"><Callout tone={result.tone}>{result.text}</Callout></div>}
        {result?.warning && <div className="mt-3"><Callout tone="warn">{result.warning}</Callout></div>}
      </Panel>
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
    <Panel
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
        <label className="flex flex-col gap-1 text-xs text-text-3">
          제목
          <input type="text" value={draft.title} onChange={(event) => edit({ type: "title", value: event.target.value })} className={INPUT} />
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-semibold text-text">원칙</legend>
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
          <fieldset key={`${engine.id}-${engineIndex}`} className="flex flex-col gap-2 rounded-control border border-border px-3 py-2">
            <legend className="px-1 text-sm font-semibold text-text">엔진 {engine.id}</legend>
            <label className="flex flex-col gap-1 text-xs text-text-3">
              이름
              <input
                type="text"
                aria-label={`엔진 ${engine.id} 이름`}
                value={engine.name}
                onChange={(event) => edit({ type: "engineName", engine: engineIndex, value: event.target.value })}
                className={INPUT}
              />
            </label>
            {engine.rules.length === 0 && <p className="text-xs text-text-3">규칙이 없습니다.</p>}
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
          <label className="flex flex-col gap-1 text-xs text-text-3">
            지침(엔진 밖 자유 지침)
            <textarea
              value={draft.guidance}
              rows={4}
              onChange={(event) => edit({ type: "guidance", value: event.target.value })}
              className={`${INPUT} leading-relaxed`}
            />
          </label>
          <span className={`text-xs ${guidance.over ? "text-warn" : "text-text-3"}`}>{guidance.text}</span>
        </div>

        <label className="flex flex-col gap-1 text-xs text-text-3">
          바꾼 내용(changelog — 판 목록에 남음)
          <input
            type="text"
            value={draft.changelog}
            onChange={(event) => edit({ type: "changelog", value: event.target.value })}
            className={INPUT}
          />
        </label>

        {moved && (
          <Callout tone="warn">
            편집을 시작한 뒤 판이 바뀌었습니다(기준 {frameworkVersionLabel(draft.baseVersion, draft.baseStatus)} → 지금{" "}
            {frameworkVersionLabel(current?.version, current?.status)}) — 그대로 저장하면 새 판의 변경이 사라집니다. 편집을 다시 시작하세요.
          </Callout>
        )}
        {check.errors.length > 0 && (
          <ul aria-label="저장 전 확인" className="list-disc pl-5 text-xs text-warn">
            {check.errors.map((error) => <li key={error}>{error}</li>)}
          </ul>
        )}

        {confirming ? (
          <div className="flex flex-col gap-3 rounded-control border border-warn/30 bg-warn-tint px-4 py-3">
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
        {/* 서버의 400 문구(엔진 수·id·4,000자 등)를 그대로 — 무엇이 틀렸는지 서버가 적어 보냅니다. */}
        {save.error && <Callout tone="warn">{save.error}</Callout>}
      </form>
    </Panel>
  );
}

/** 원칙·규칙 한 줄 — id, 본문, 글자 수(4,000자 기준), 지우기. */
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
      <code className="pt-2 text-xs text-text-3">{id}</code>
      <div className="min-w-0">
        <textarea
          aria-label={label}
          value={text}
          rows={2}
          onChange={(event) => onChange(event.target.value)}
          className={`${INPUT} leading-relaxed`}
        />
        <p className={`text-xs ${count.over ? "text-warn" : "text-text-3"}`}>
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
      <dt className="text-text-3">{label}</dt>
      <dd className="tabular-nums font-semibold text-text">{value}</dd>
    </div>
  );
}

/** 안의 한 부분 — 제목이 영역 이름이 되어(aria-label) 표마다 따로 찾을 수 있습니다(결정 로그 탭과 같은 모양). */
function Part({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h4 className="text-sm font-semibold text-text">{title}</h4>
      {note && <p className="text-xs leading-relaxed text-text-3">{note}</p>}
      {children}
    </section>
  );
}

function BadgeChip({ badge }: { badge: Badge }) {
  return (
    <span title={badge.title} className={`whitespace-nowrap rounded-control border px-2 py-px text-xs ${badge.className}`}>
      {badge.label}
    </span>
  );
}
