"use client";

import { useState } from "react";
import { Banner, Button, Card, ErrorState, Loading, Table } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { apiDelete, apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import {
  type Badge,
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
import type { PaperNoteCreateResult, PaperNotesResponse, PaperOkResult, PaperSettingsResponse } from "@/lib/types";

const INPUT = "w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-body outline-hidden focus:border-accent";

/**
 * 메모 탭(명세 F6·D14) — 시황 메모(MARKET: 기준일·만료일, 유효하면 Claude 결정 패킷 섹션 11에 자료로)와 방법론 메모(INSIGHT: 만료 없음,
 * 프레임 제안에만)의 목록·쓰기·보관.
 *
 * 유효한지(active)·기준일·만료일 기본값은 서버가 정합니다 — 화면은 날짜를 다시 비교하지 않고 서버 값을 그대로 보입니다. 기준일 칸에는 비우면
 * 채워지는 날(referenceDate — 마지막으로 끝난 미국 세션)을 적고, 저장한 시황 메모가 그 거래일 패킷에 실리지 않으면(서버 active:false) 저장
 * 결과에서 바로 알립니다(F4). 보관은 지우지 않고
 * archived로 표시하는 DELETE이고, 되돌릴 화면이 없어 확인을 한 번 거칩니다. 만료일 안내의 기본 거래일 수는 설정(notesDefaultExpiryTradingDays)을
 * 읽어 적습니다(못 읽으면 기본값이라고).
 */
export function NotesSection({ startDate }: { startDate: string | null }) {
  const [includeExpired, setIncludeExpired] = useState(false);
  const notes = useApi<PaperNotesResponse>(endpoints.paper.notes(includeExpired));
  const settings = useApi<PaperSettingsResponse>(endpoints.paper.settings);
  const [draft, setDraft] = useState<NoteDraft>(EMPTY_NOTE_DRAFT);
  const [confirmingArchive, setConfirmingArchive] = useState<number | null>(null);
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
  const expiryHint = noteExpiryHint(settings.data?.available ? settings.data.body : null);

  const edit = (change: Partial<NoteDraft>) => setDraft((current) => ({ ...current, ...change }));
  const submit = async () => {
    if (!check.canSave) return;
    if (await create.run(notePayload(draft))) {
      // 성공했을 때만 입력을 비웁니다 — 실패하면 쓴 글이 남아 고쳐 다시 누를 수 있게(QA-051).
      setDraft({ ...EMPTY_NOTE_DRAFT, kind: draft.kind });
      void notes.reload();
    }
  };
  const runArchive = async (id: number) => {
    const ok = await archive.run(id);
    setConfirmingArchive(null);
    if (ok) void notes.reload();
  };

  const rows = notes.data?.available ? noteRows(notes.data.notes) : [];
  const confirmingRow = rows.find((row) => row.id === confirmingArchive) ?? null;

  return (
    <>
      <Card
        title="메모"
        subtitle="Claude 계좌의 자료 — 시황 메모는 결정 패킷에, 방법론 메모는 프레임 제안에"
        source={PAPER_SOURCES.notes}
        actions={
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={includeExpired} onChange={(event) => setIncludeExpired(event.target.checked)} />
            만료한 메모도 보기
          </label>
        }
      >
        <p className="mb-3 text-xs leading-relaxed text-muted">
          {notesIntro(startDate)}
          {notes.data?.available && notes.data.referenceDate ? ` 유효 여부는 ${notes.data.referenceDate} 기준(서버 판정)입니다.` : ""}
        </p>
        {notes.loading && !notes.data && <Loading label="메모를 읽는 중…" />}
        {notes.error && <ErrorState message={notes.error} onRetry={notes.reload} />}
        {notes.data && !notes.data.available && <Banner tone="warn">{notes.data.message ?? "메모를 읽을 수 없습니다."}</Banner>}
        {notes.data?.available && (
          <Table<NoteRow>
            rows={rows}
            rowKey={(row) => row.key}
            emptyMessage={includeExpired ? "메모가 없습니다." : "유효한 메모가 없습니다 — 만료한 메모는 위 '만료한 메모도 보기'로 봅니다."}
            columns={[
              { key: "id", header: "번호", render: (row) => <span className="tabular-nums text-muted">{row.idText}</span> },
              {
                key: "kind",
                header: "종류·상태",
                render: (row) => (
                  <span className="flex flex-wrap gap-1">
                    <BadgeChip badge={row.kind} />
                    <BadgeChip badge={row.state} />
                  </span>
                ),
              },
              {
                key: "title",
                header: "제목·본문",
                render: (row) => (
                  <details className="text-xs">
                    <summary className="cursor-pointer font-semibold text-bright">{row.title}</summary>
                    <p className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap leading-relaxed text-body">{row.body}</p>
                  </details>
                ),
              },
              { key: "asOf", header: "기준일", render: (row) => <span className="whitespace-nowrap">{row.asOf}</span> },
              { key: "expires", header: "만료일", render: (row) => <span className="whitespace-nowrap">{row.expires}</span> },
              { key: "length", header: "길이", align: "right", render: (row) => row.length },
              { key: "createdAt", header: "쓴 시각", render: (row) => <span className="whitespace-nowrap">{row.createdAt}</span> },
              {
                key: "archive",
                header: "보관",
                render: (row) => (row.archived ? (
                  <span className="text-xs text-muted">보관함</span>
                ) : (
                  <Button
                    onClick={() => setConfirmingArchive(row.id)}
                    disabled={archive.busy || confirmingArchive !== null}
                  >
                    {`보관 ${row.idText}`}
                  </Button>
                )),
              },
            ]}
          />
        )}
        {confirmingRow && (
          <div className="mt-3 flex flex-col gap-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-3">
            <p className="text-sm leading-relaxed text-warn">{noteArchiveConfirm(confirmingRow)}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={() => void runArchive(confirmingRow.id)} disabled={archive.busy}>
                {archive.busy ? "보관 중…" : "보관 확인"}
              </Button>
              <Button onClick={() => setConfirmingArchive(null)} disabled={archive.busy}>취소</Button>
            </div>
          </div>
        )}
        {archive.error && <div className="mt-3"><Banner tone="warn">{archive.error}</Banner></div>}
        {archive.result && archive.result.ok === false && (
          <div className="mt-3"><Banner tone="warn">{archive.result.message ?? "메모를 보관하지 못했습니다."}</Banner></div>
        )}
      </Card>

      <Card title="메모 쓰기" subtitle="시황 메모는 기준일·만료일 사이에만 패킷에 실립니다. 날짜를 비우면 서버가 기본값으로 채웁니다(저장 결과에 적힘).">
        <form
          aria-label="메모 쓰기"
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-xs text-muted">
              종류
              <select
                value={draft.kind}
                onChange={(event) => edit({ kind: event.target.value === "INSIGHT" ? "INSIGHT" : "MARKET" })}
                className={INPUT}
              >
                <option value="MARKET">시황 메모(MARKET) — 결정 패킷에</option>
                <option value="INSIGHT">방법론 메모(INSIGHT) — 프레임 제안에</option>
              </select>
            </label>
            <div className="flex flex-col gap-1">
              <label className="flex flex-col gap-1 text-xs text-muted">
                기준일(선택)
                <input
                  type="date"
                  value={draft.asOfDate}
                  aria-describedby="paper-note-asof-hint"
                  onChange={(event) => edit({ asOfDate: event.target.value })}
                  className={INPUT}
                />
              </label>
              <span id="paper-note-asof-hint" className="text-[11px] text-muted">{noteAsOfHint(referenceDate)}</span>
            </div>
            {draft.kind === "MARKET" ? (
              <div className="flex flex-col gap-1">
                <label className="flex flex-col gap-1 text-xs text-muted">
                  만료일(선택)
                  <input
                    type="date"
                    value={draft.expiresOn}
                    aria-describedby="paper-note-expiry-hint"
                    onChange={(event) => edit({ expiresOn: event.target.value })}
                    className={INPUT}
                  />
                </label>
                <span id="paper-note-expiry-hint" className="text-[11px] text-muted">{expiryHint}</span>
              </div>
            ) : (
              <p className="self-end text-[11px] text-muted">방법론 메모는 만료가 없습니다.</p>
            )}
          </div>
          <label className="flex flex-col gap-1 text-xs text-muted">
            제목
            <input type="text" value={draft.title} onChange={(event) => edit({ title: event.target.value })} className={INPUT} />
          </label>
          <div className="flex flex-col gap-1">
            <label className="flex flex-col gap-1 text-xs text-muted">
              본문
              <textarea
                value={draft.body}
                rows={8}
                onChange={(event) => edit({ body: event.target.value })}
                className={`${INPUT} leading-relaxed`}
              />
            </label>
            <span className={`text-[11px] ${check.bodyCount.over ? "text-warn" : "text-muted"}`}>
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
          {create.error && <Banner tone="warn">{create.error}</Banner>}
          {created && <Banner tone={created.tone}>{created.text}</Banner>}
        </form>
      </Card>
    </>
  );
}

function BadgeChip({ badge }: { badge: Badge }) {
  return (
    <span title={badge.title} className={`whitespace-nowrap rounded-sm border px-1.5 py-px text-[10px] ${badge.className}`}>
      {badge.label}
    </span>
  );
}
