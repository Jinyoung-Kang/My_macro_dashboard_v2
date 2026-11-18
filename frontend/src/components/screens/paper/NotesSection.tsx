"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { MasterDetail, type PropertyItem, PropertyList } from "@/components/patterns";
import { Button, buttonClasses, Callout, ErrorState, inputClasses, Loading, NativeSelect, Panel } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { apiDelete, apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import {
  EMPTY_NOTE_DRAFT,
  type NoteDraft,
  type NoteRow,
  noteArchiveConfirm,
  noteAsOfHint,
  noteCreateResultView,
  noteDraftCheck,
  noteExpiryHint,
  notePayload,
  noteRows,
  notesIntro,
  PAPER_SOURCES,
} from "@/lib/paper";
import type { PaperMarketCode } from "@/lib/paperMarket";
import type { PaperNoteCreateResult, PaperNotesResponse, PaperOkResult, PaperSettingsResponse } from "@/lib/types";
import { PaperBadge } from "./PaperBadge";

const INPUT = `w-full ${inputClasses()}`;
/** 한 줄 입력(날짜·제목) — 공용 고르기 상자(ui Select)처럼 넓은 화면(sm 이상)에서 22rem까지(QA-750). 본문 칸은 패널 폭. */
const LINE_INPUT = `${INPUT} sm:max-w-[22rem]`;
/** 폼 라벨 — 공용 고르기 상자(ui Select)의 라벨과 같은 13px 보조 글(QA-750 — 예전 12px 흐린 글). */
const FIELD_LABEL = "flex flex-col gap-1 text-[13px] text-text-2";

/** lib noteRows가 방법론 메모(만료 없음)의 만료 칸에 적는 글. */
const NO_EXPIRY = "만료 없음";

/**
 * 메모 탭(명세 F6·D14) — 시황 메모(MARKET: 기준일·만료일, 유효하면 Claude 결정 패킷 섹션 11에 자료로)와 방법론 메모(INSIGHT: 만료 없음,
 * 프레임 제안에만)의 목록·쓰기·보관. 목록은 목록-검사(작업대 P6)라 메모를 고르면 검사 칸(좁은 화면은 대화상자)에 본문·보관 단추가 나옵니다.
 *
 * 유효한지(active)·기준일·만료일 기본값은 서버가 정합니다 — 화면은 날짜를 다시 비교하지 않고 서버 값을 그대로 보입니다. 기준일 칸에는 비우면
 * 채워지는 날(referenceDate — 마지막으로 끝난 미국 세션)을 적고, 저장한 시황 메모가 그 거래일 패킷에 실리지 않으면(서버 active:false) 저장
 * 결과에서 바로 알립니다(F4). 보관은 지우지 않고
 * archived로 표시하는 DELETE이고, 되돌릴 화면이 없어 확인을 한 번 거칩니다. 만료일 안내의 기본 거래일 수는 설정(notesDefaultExpiryTradingDays)을
 * 읽어 적습니다(못 읽으면 기본값이라고).
 *
 * <p><b>한국</b>(`market` "KR", 2단계 명세 §4-16 F1b): 목록은 `?market=KR`(한국 메모만), 쓰기는 본문 `market:"KR"`, 기준일·만료는 그 조회 실행의
 * KRX 달력으로 셉니다(기본 기준일 = 마지막으로 끝난 한국 세션). 한국 메모는 한국 Claude 계좌 결정 패킷 섹션 11에만 실립니다. 달력이 지금의 해를
 * 모르면 서버가 기준일 대신 사유(referenceDateReason)를 보내고 쓰기를 거절합니다(400) — 그 사유를 적고 저장 단추는 그대로 둡니다(서버 문구를
 * 보이려고). 한국 책이 쉬어도 메모는 받습니다(글일 뿐). 보관(DELETE)은 번호로 찾아 시장과 관계없습니다.
 */
export function NotesSection({ startDate, market = "US" }: { startDate: string | null; market?: PaperMarketCode }) {
  const korea = market === "KR";
  const [includeExpired, setIncludeExpired] = useState(false);
  const notes = useApi<PaperNotesResponse>(endpoints.paper.market(market).notes(includeExpired));
  const settings = useApi<PaperSettingsResponse>(endpoints.paper.settings);
  const [draft, setDraft] = useState<NoteDraft>(EMPTY_NOTE_DRAFT);
  const [confirmingArchive, setConfirmingArchive] = useState<number | null>(null);
  // 마지막으로 보관을 보낸 메모 — 그 결과·오류는 그 메모 칸(검사 칸·대화상자) 안의 알림 영역에만 그립니다(QA-812).
  const [archivedFor, setArchivedFor] = useState<number | null>(null);
  const create = useAsyncAction(
    (payload: Record<string, unknown>) => apiPost<PaperNoteCreateResult>(endpoints.paper.createNote, payload),
    "메모를 저장하지 못했습니다.",
  );
  const archive = useAsyncAction(
    (id: number) => apiDelete<PaperOkResult>(endpoints.paper.archiveNote(id)),
    "메모를 보관하지 못했습니다.",
  );

  const check = noteDraftCheck(draft);
  const referenceDate = notes.data?.available ? notes.data.referenceDate ?? null : null;
  const created = create.result ? noteCreateResultView(create.result, referenceDate) : null;
  const expiryHint = noteExpiryHint(settings.data?.available ? settings.data.body : null, market);
  const referenceReason = korea && notes.data?.available ? notes.data.referenceDateReason ?? null : null;
  const dormantReason = korea && notes.data?.available ? notes.data.dormantReason ?? null : null;

  const edit = (change: Partial<NoteDraft>) => setDraft((current) => ({ ...current, ...change }));
  const submit = async () => {
    if (!check.canSave) return;
    if (await create.run(notePayload(draft, market))) {
      // 성공했을 때만 입력을 비웁니다 — 실패하면 쓴 글이 남아 고쳐 다시 누를 수 있게(QA-051).
      setDraft({ ...EMPTY_NOTE_DRAFT, kind: draft.kind });
      void notes.reload();
    }
  };
  const runArchive = async (id: number) => {
    setArchivedFor(id);
    const ok = await archive.run(id);
    focusAfter.current = { id, archived: ok };
    setConfirmingArchive(null);
    if (ok) void notes.reload();
  };
  const cancelArchive = (id: number) => {
    focusAfter.current = { id, archived: false };
    setConfirmingArchive(null);
  };

  const rows = notes.data?.available ? noteRows(notes.data.notes) : [];
  const confirmingRow = rows.find((row) => row.id === confirmingArchive) ?? null;
  // 화면 안 확인 상자를 열면 '취소'로 포커스합니다(검사 칸·대화상자 안 — 공용 확인 창 규칙: 실수로 Enter를 눌러도 DELETE가 나가지 않게, 확인 글은 그 단추의
  // 설명으로 읽힘 — QA-767).
  const archiveCancelRef = useRef<HTMLButtonElement>(null);
  const archiveTextId = `${useId()}-archive`;
  const openedFor = useRef<number | null>(null);
  useEffect(() => {
    if (confirmingArchive === null) {
      openedFor.current = null;
      return;
    }
    if (openedFor.current === confirmingArchive || !archiveCancelRef.current) return;
    openedFor.current = confirmingArchive;
    archiveCancelRef.current.focus();
  });
  // 확인 상자를 '취소'로 닫거나 보관이 끝나면 포커스를 되돌립니다(QA-768 — 상자와 함께 누른 단추가 사라져 포커스가 문서·대화상자 틀로 떨어졌음): 그 메모의
  // '보관 #n'이 있으면 그 단추로(취소·실패), 보관으로 메모가 목록에서 빠졌으면(다시 읽은 뒤) 포커스를 잃었을 때만 목록의 Tab 정지점 줄로.
  const focusAfter = useRef<{ id: number; archived: boolean } | null>(null);
  useEffect(() => {
    const target = focusAfter.current;
    if (target === null || confirmingArchive !== null || archive.busy) return;
    // 보관했는데 목록을 아직 다시 읽지 않았으면(그 메모가 보관 전 그대로) 기다립니다.
    if (target.archived && rows.some((row) => row.id === target.id && !row.archived)) return;
    focusAfter.current = null;
    const button = document.querySelector<HTMLButtonElement>(`button[data-note-archive="${target.id}"]`);
    if (button && !button.disabled) {
      button.focus();
      return;
    }
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected && active.getAttribute("role") !== "dialog") return;
    document.querySelector<HTMLButtonElement>('ul[data-shell-list][aria-label="메모"] button[tabindex="0"]')?.focus();
  });

  return (
    <>
      <Panel
        title={korea ? "메모(한국)" : "메모"}
        subtitle={korea
          ? "한국 Claude 계좌의 자료 — 시황 메모는 한국 결정 패킷에, 방법론 메모는 프레임 제안에"
          : "Claude 계좌의 자료 — 시황 메모는 결정 패킷에, 방법론 메모는 프레임 제안에"}
        source={PAPER_SOURCES.notes}
        actions={
          // 감싼 label이 누름 자리 — 좁은 화면(lg 미만) 44px, 넓은 화면 24px(명세 §3-7 작은 조작, QA-749).
          <label className="flex min-h-11 min-w-11 cursor-pointer items-center gap-2 text-xs text-text-3 lg:min-h-6">
            <input type="checkbox" checked={includeExpired} onChange={(event) => setIncludeExpired(event.target.checked)} />
            만료한 메모도 보기
          </label>
        }
      >
        <p className="mb-3 text-xs leading-relaxed text-text-3">
          {notesIntro(startDate, market)}
          {notes.data?.available && notes.data.referenceDate ? ` 유효 여부는 ${notes.data.referenceDate} 기준(서버 판정)입니다.` : ""}
        </p>
        {referenceReason && (
          <div className="mb-3">
            <Callout tone="warn">
              <strong>기준 거래일을 셀 수 없습니다</strong> — {referenceReason}. 그동안 목록은 만료를 가를 수 없어 보관하지 않은 메모 전부이고(시황 메모의
              유효 여부는 &apos;모름&apos;), 새 메모는 서버가 거절합니다(400).
            </Callout>
          </div>
        )}
        {/* 쉬는 사유는 화면 맨 위 배너가 적습니다(PaperScreen) — 여기서는 메모를 써도 되는지만. */}
        {dormantReason && (
          <p className="mb-3 text-xs leading-relaxed text-text-3">
            한국 계좌가 쉬는 동안에도 메모는 쓸 수 있습니다(글일 뿐) — 한국 결정이 돌기 시작하면 그 거래일에 유효한 메모가 실립니다.
          </p>
        )}
        {notes.loading && !notes.data && <Loading label="메모를 읽는 중…" />}
        {notes.error && <ErrorState message={notes.error} onRetry={notes.reload} />}
        {notes.data && !notes.data.available && <Callout tone="warn">{notes.data.message ?? "메모를 읽을 수 없습니다."}</Callout>}
        {notes.data?.available && (
          // 목록-검사(작업대 P6 — 명세 §7-1 '메모: 목록-검사'): 줄 = 번호·종류·상태·제목(과 기준일·만료일), 고르면 검사 칸(틀 32rem부터 옆 15rem, 좁은 화면은
          // 위쪽 대화상자 — 첫 포커스 제목)에 속성·본문·보관 단추와 그 화면 안 확인 상자, 보관 결과·오류 알림(QA-812 — 목록 아래에 두면 좁은 배치에서
          // 대화상자 밖 덮개 뒤라 보이지도 들리지도 않았음). 보관을 보내는 동안은 대화상자를 닫지 못합니다(결과를 볼 칸이 사라지지 않게 — QA-766과 같은 규칙).
          <MasterDetail<NoteRow>
            label="메모"
            items={rows}
            itemKey={(row) => row.key}
            itemLabel={(row) => `${row.idText} ${row.title}`}
            renderItem={(row) => <NoteLine row={row} />}
            renderDetail={(row) => (
              <NoteDetail
                key={row.key}
                row={row}
                archiving={archive.busy}
                confirming={confirmingArchive}
                onArchive={() => setConfirmingArchive(row.id)}
                onCancel={() => setConfirmingArchive(null)}
                status={archivedFor === row.id ? (
                  <>
                    {archive.error && <Callout tone="warn">{archive.error}</Callout>}
                    {archive.result && archive.result.ok === false && (
                      <Callout tone="warn">{archive.result.message ?? "메모를 보관하지 못했습니다."}</Callout>
                    )}
                  </>
                ) : null}
                confirmBox={confirmingRow && confirmingRow.id === row.id ? (
                  <div className="mt-3 flex flex-col gap-3 rounded-control border border-warn/30 bg-warn-tint px-4 py-3">
                    <p id={`${archiveTextId}-${confirmingRow.id}`} className="text-sm leading-relaxed text-warn">{noteArchiveConfirm(confirmingRow)}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="primary" onClick={() => void runArchive(confirmingRow.id)} disabled={archive.busy}>
                        {archive.busy ? "보관 중…" : "보관 확인"}
                      </Button>
                      <button
                        ref={archiveCancelRef}
                        type="button"
                        onClick={() => cancelArchive(confirmingRow.id)}
                        disabled={archive.busy}
                        aria-describedby={`${archiveTextId}-${confirmingRow.id}`}
                        className={buttonClasses()}
                      >
                        취소
                      </button>
                    </div>
                  </div>
                ) : null}
              />
            )}
            dialogFocus="title"
            dialogDismissible={!archive.busy}
            count={(count) => `${count.toLocaleString("ko-KR")}건`}
            emptyText={includeExpired ? "메모가 없습니다." : "유효한 메모가 없습니다 — 만료한 메모는 위 '만료한 메모도 보기'로 봅니다."}
            inspectorHint="메모를 고르면 이 칸에 본문과 보관 단추를 보입니다(j/k·↑↓로 옮김)."
          />
        )}
      </Panel>

      <Panel
        title={korea ? "한국 메모 쓰기" : "메모 쓰기"}
        subtitle={korea
          ? "한국 시황 메모는 기준일·만료일 사이에만 한국 결정 패킷에 실립니다. 날짜를 비우면 서버가 KRX 달력으로 기본값을 채웁니다(저장 결과에 적힘)."
          : "시황 메모는 기준일·만료일 사이에만 패킷에 실립니다. 날짜를 비우면 서버가 기본값으로 채웁니다(저장 결과에 적힘)."}
      >
        <form
          aria-label="메모 쓰기"
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <label className={FIELD_LABEL}>
              종류
              <NativeSelect
                value={draft.kind}
                onChange={(event) => edit({ kind: event.target.value === "INSIGHT" ? "INSIGHT" : "MARKET" })}
                wrapperClassName="block w-full sm:max-w-[22rem]"
              >
                <option value="MARKET">{korea ? "시황 메모(MARKET) — 한국 결정 패킷에" : "시황 메모(MARKET) — 결정 패킷에"}</option>
                <option value="INSIGHT">방법론 메모(INSIGHT) — 프레임 제안에</option>
              </NativeSelect>
            </label>
            <div className="flex flex-col gap-1">
              <label className={FIELD_LABEL}>
                기준일(선택)
                <input
                  type="date"
                  value={draft.asOfDate}
                  aria-describedby="paper-note-asof-hint"
                  onChange={(event) => edit({ asOfDate: event.target.value })}
                  className={LINE_INPUT}
                />
              </label>
              <span id="paper-note-asof-hint" className="text-xs text-text-3">{noteAsOfHint(referenceDate, market)}</span>
            </div>
            {draft.kind === "MARKET" ? (
              <div className="flex flex-col gap-1">
                <label className={FIELD_LABEL}>
                  만료일(선택)
                  <input
                    type="date"
                    value={draft.expiresOn}
                    aria-describedby="paper-note-expiry-hint"
                    onChange={(event) => edit({ expiresOn: event.target.value })}
                    className={LINE_INPUT}
                  />
                </label>
                <span id="paper-note-expiry-hint" className="text-xs text-text-3">{expiryHint}</span>
              </div>
            ) : (
              <p className="self-end text-xs text-text-3">방법론 메모는 만료가 없습니다.</p>
            )}
          </div>
          <label className={FIELD_LABEL}>
            제목
            <input type="text" value={draft.title} onChange={(event) => edit({ title: event.target.value })} className={LINE_INPUT} />
          </label>
          <div className="flex flex-col gap-1">
            <label className={FIELD_LABEL}>
              본문
              <textarea
                value={draft.body}
                rows={8}
                onChange={(event) => edit({ body: event.target.value })}
                className={`${INPUT} leading-relaxed`}
              />
            </label>
            <span className={`text-xs ${check.bodyCount.over ? "text-warn" : "text-text-3"}`}>
              {check.bodyCount.text}
              {draft.kind === "MARKET" ? " — 패킷에는 유효한 메모를 합쳐 설정 notesMaxCharsInPacket까지 싣습니다." : ""}
            </span>
          </div>
          {check.errors.length > 0 && (draft.title || draft.body) && (
            <ul aria-label="메모 입력 확인" className="list-disc pl-5 text-xs text-warn">
              {check.errors.map((error) => <li key={error}>{error}</li>)}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" disabled={!check.canSave || create.busy}>
              {create.busy ? "저장 중…" : "메모 저장"}
            </Button>
          </div>
          {/* 서버 400 문구(길이·날짜 형식 등)를 그대로 — 무엇이 틀렸는지 서버가 적어 보냅니다. */}
          {create.error && <Callout tone="warn">{create.error}</Callout>}
          {created && <Callout tone={created.tone}>{created.text}</Callout>}
        </form>
      </Panel>
    </>
  );
}

/** 메모 줄 — 번호·종류·상태 배지·제목, 아래 줄에 기준일·만료일(13px 보조 글). 줄 단추 안이라 링크·단추가 없습니다. */
function NoteLine({ row }: { row: NoteRow }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="tabular-nums text-text-3">{row.idText}</span>
        <span className="flex flex-wrap gap-1 whitespace-nowrap">
          <PaperBadge badge={row.kind} />
          <PaperBadge badge={row.state} />
        </span>
        <span className="min-w-0 break-keep wrap-anywhere font-semibold text-text">{row.title}</span>
      </span>
      {/* 방법론 메모의 만료 칸은 lib noteRows가 '만료 없음'으로 적습니다 — 그 글은 그대로, 날짜면 '만료일 날짜'. */}
      <span className="text-[13px] tabular-nums text-text-2">
        기준일 {row.asOf} · {row.expires === NO_EXPIRY ? row.expires : `만료일 ${row.expires}`}
      </span>
    </span>
  );
}

/**
 * 고른 메모 — 속성(종류·상태·기준일·만료일·길이·쓴 시각), 본문(running 글자 15/24, 72ch — 서버 글 그대로·줄바꿈 유지), 보관 단추(보관한 메모는 '보관함')와 그
 * 화면 안 확인 상자(부르는 쪽이 그림 — 확인 글 noteArchiveConfirm·DELETE 그대로). 이 칸이 사라지면(대화상자를 닫음·다른 메모를 고름) 열어 둔 확인을 접습니다 —
 * 보이지 않는 확인 상자가 다른 메모의 보관 단추를 막지 않게.
 */
function NoteDetail({
  row,
  archiving,
  confirming,
  onArchive,
  onCancel,
  confirmBox,
  status,
}: {
  row: NoteRow;
  archiving: boolean;
  confirming: number | null;
  onArchive: () => void;
  onCancel: () => void;
  confirmBox: ReactNode;
  /** 이 메모로 보낸 보관의 결과·오류(부르는 쪽이 그림) — 늘 그려 둔 알림 영역 안에 둡니다. */
  status: ReactNode;
}) {
  const mine = confirming === row.id;
  // 칸이 사라질 때 읽을 마지막 값 — 그리기 중에는 ref를 쓰지 않고 그린 뒤에 옮겨 둡니다.
  const latest = useRef({ mine, onCancel });
  useEffect(() => {
    latest.current = { mine, onCancel };
  });
  useEffect(() => () => {
    if (latest.current.mine) latest.current.onCancel();
  }, []);
  const properties: PropertyItem[] = [
    { key: "kind", label: "종류", value: <PaperBadge badge={row.kind} /> },
    { key: "state", label: "상태", value: <PaperBadge badge={row.state} /> },
    { key: "asOf", label: "기준일", value: row.asOf },
    { key: "expires", label: "만료일", value: row.expires },
    { key: "length", label: "길이", value: row.length },
    { key: "createdAt", label: "쓴 시각", value: row.createdAt },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <PropertyList items={properties} dense />
      <p className="max-w-[72ch] whitespace-pre-wrap break-keep wrap-anywhere text-[15px] leading-6 text-text">{row.body}</p>
      <div>
        {row.archived ? (
          <span className="text-xs text-text-3">보관함</span>
        ) : (
          <button
            type="button"
            data-note-archive={row.id}
            onClick={onArchive}
            disabled={archiving || confirming !== null}
            className={buttonClasses()}
          >
            {`보관 ${row.idText}`}
          </button>
        )}
        {confirmBox}
        {/* 보관 결과·오류의 알림 영역(role=status) — 늘 그려 두어야 새 글을 읽습니다. 비어 있으면 높이·간격이 없습니다(QA-812). */}
        <div role="status" className="mt-3 flex flex-col gap-2 empty:mt-0">{status}</div>
      </div>
    </div>
  );
}
