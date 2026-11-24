"use client";

import { type FormEvent, type ReactElement, useId, useRef, useState } from "react";
import { Button, Tag } from "@/components/ui";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog } from "@/components/ui/Dialog";
import { FIELD_INPUT, FIELD_LABEL } from "@/components/ui/classes";
import { StatusText } from "@/components/ui/icons";
import type { FavoriteCandidate, Sec13fFavoritesEditor } from "@/hooks/useSec13fFavorites";
import { favoriteQueryKind } from "@/lib/institutionFavorites";
import type { InstitutionFavoriteEntry } from "@/lib/institutionsScreen";

/**
 * 13F 즐겨찾기 편집 대화상자(운영자, ADR 0048) — 이름 또는 CIK로 찾기 → 후보 고르기 → 표시 이름·설명(선택) → 더하기, 그리고 지금 목록의 줄마다 지우기(확인 창).
 *
 * - 이름 검색은 '찾기'를 누를 때만 부릅니다(입력마다 부르지 않음 — SEC 예절). 숫자 1~10자리를 넣으면 SEC 이름 검색 없이 그 CIK를 후보로 둡니다
 *   (더할 때 서버가 SEC에서 이름·13F 공시를 확인).
 * - 더하기는 서버가 SEC 확인과 그 기관의 13F 수집을 기다려 1분 가까이 걸릴 수 있어 진행 글을 보입니다. 실패는 서버가 준 사유 그대로.
 * - 보내는 동안 단추는 disabled가 아니라 aria-disabled·aria-busy(누른 단추에 포커스가 남게 — QA-444와 같은 규칙).
 */
export function FavoritesEditDialog({
  favorites,
  defaultCiks,
  editor,
  trigger,
  onRemoved,
}: {
  favorites: readonly InstitutionFavoriteEntry[];
  /** 기본 12곳의 CIK — CIK로 넣은 줄이 이미 기본 목록인지 알림. */
  defaultCiks: readonly string[];
  editor: Sec13fFavoritesEditor;
  trigger: ReactElement;
  /** 즐겨찾기를 지우는 데 성공하면 그 CIK로 부릅니다 — 화면이 지운 기관을 고른 채 두지 않게(QA-1031). */
  onRemoved?: (cik: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen} title="13F 즐겨찾기 편집" size="lg" trigger={trigger}
      description="기본 12곳 밖의 13F 보고 기관을 더하고 지웁니다. 더한 기관은 13F 포트폴리오·기관 상세에 보이고, 모의 매매·AI 리포트에는 쓰지 않습니다.">
      {open && <EditorBody favorites={favorites} defaultCiks={defaultCiks} editor={editor} onRemoved={onRemoved} />}
    </Dialog>
  );
}

function EditorBody({
  favorites,
  defaultCiks,
  editor,
  onRemoved,
}: {
  favorites: readonly InstitutionFavoriteEntry[];
  defaultCiks: readonly string[];
  editor: Sec13fFavoritesEditor;
  onRemoved?: (cik: string) => void;
}) {
  const queryId = useId();
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<FavoriteCandidate[] | null>(null);
  const [picked, setPicked] = useState<FavoriteCandidate | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [removing, setRemoving] = useState<InstitutionFavoriteEntry | null>(null);
  // 표시 이름·설명 고치기(2026-11-23 사용자 요청) — 한 번에 한 줄, 그 줄 안에 칸 둘과 저장·취소.
  const [editing, setEditing] = useState<{ cik: string; displayName: string; description: string } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** 고치기를 끝내면(저장·취소) 그 줄의 '고치기' 단추로 포커스를 돌립니다(칸이 사라지며 포커스가 몸통으로 떨어지지 않게). */
  const closeEditing = (cik: string) => {
    setEditing(null);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>(`[data-edit-cik="${cik}"] button`)?.focus());
  };
  const editFieldRef = useRef<HTMLInputElement>(null);
  const openEditing = (favorite: InstitutionFavoriteEntry) => {
    setEditing({
      cik: favorite.cik,
      // 표시 이름이 없으면 name이 SEC 등록 이름이라 칸은 비워 둡니다(그대로 저장하면 SEC 이름을 따름).
      displayName: favorite.name !== favorite.secName ? favorite.name : "",
      description: favorite.desc ?? "",
    });
    // 방금 누른 '고치기'의 바로 다음 칸(표시 이름)으로 포커스.
    requestAnimationFrame(() => editFieldRef.current?.focus());
  };
  const saveEditing = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing || editor.busy) return;
    const ok = await editor.editLabels(editing.cik, { displayName: editing.displayName.trim(), description: editing.description.trim() });
    if (ok) closeEditing(editing.cik);
  };
  const queryRef = useRef<HTMLInputElement>(null);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    if (editor.busy) return;
    setPicked(null);
    // 찾기를 다시 하면 앞 결과(오류 문구·후보)를 함께 비웁니다 — CIK 갈래가 앞 오류 문구를, 잘못된 입력 갈래가 앞 후보를 남겼습니다(QA-1031).
    editor.setMessage(null);
    setCandidates(null);
    const kind = favoriteQueryKind(query);
    if (kind.kind === "cik") {
      setCandidates([{ cik: kind.cik, name: null, status: statusOf(kind.cik, favorites, defaultCiks) }]);
      return;
    }
    if (kind.kind === "invalid") {
      editor.setMessage({ tone: "error", text: kind.reason });
      return;
    }
    const found = await editor.search(kind.text);
    if (found) setCandidates(found);
  };

  const add = async () => {
    if (!picked || editor.busy) return;
    const ok = await editor.add({ cik: picked.cik, displayName: displayName.trim() || undefined, description: description.trim() || undefined });
    if (ok) {
      setPicked(null);
      setCandidates(null);
      setQuery("");
      setDisplayName("");
      setDescription("");
      queryRef.current?.focus();
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <form onSubmit={search} className="flex min-w-0 flex-wrap items-end gap-2" role="search" aria-label="13F 기관 찾기">
        <label htmlFor={queryId} className={FIELD_LABEL}>
          기관 이름(영문) 또는 CIK
          <input
            id={queryId}
            ref={queryRef}
            className={FIELD_INPUT}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
            maxLength={60}
          />
        </label>
        <Button type="submit" busy={editor.busy}>
          찾기
        </Button>
      </form>

      {candidates !== null ? (
        candidates.length === 0 ? (
          <p className="text-sm text-text-2">13F-HR을 낸 기관 가운데 이 이름으로 시작하는 곳이 없습니다. 영문 이름 앞부분이나 CIK로 찾으세요.</p>
        ) : (
          <ul aria-label="찾은 기관" className="flex min-w-0 flex-col divide-y divide-border rounded-control border border-border">
            {candidates.map((candidate) => {
              // 표지는 그릴 때 지금 목록으로 다시 봅니다 — 찾은 뒤 즐겨찾기를 지워도 '즐겨찾기에 있음'이 남아 다시 고를 수 없었습니다(QA-1031).
              const status = candidate.status === "default" ? "default" : statusOf(candidate.cik, favorites, defaultCiks);
              return (
              <li key={candidate.cik} className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="flex min-w-0 flex-col">
                  <span className="break-keep font-medium text-text wrap-anywhere">{candidate.name ?? `CIK ${candidate.cik}`}</span>
                  <span className="text-xs text-text-3">
                    <span className="font-mono">CIK {candidate.cik}</span>
                    {candidate.checked === undefined ? null : ` · ${latestText(candidate)}`}
                  </span>
                </span>
                {status ? (
                  <Tag>{status === "default" ? "기본 12곳" : "즐겨찾기에 있음"}</Tag>
                ) : candidate.checked === true && !candidate.latest13F ? (
                  // 최근 공시 목록에 원본 13F-HR이 없으면 더해도 서버가 거절하므로 고르기를 두지 않습니다(QA-986).
                  <Tag>13F-HR 없음</Tag>
                ) : (
                  <Button size="sm" onClick={() => setPicked(candidate)} expanded={picked?.cik === candidate.cik}>
                    {picked?.cik === candidate.cik ? "고름" : "고르기"} <span className="sr-only">{candidate.name ?? `CIK ${candidate.cik}`}</span>
                  </Button>
                )}
              </li>
              );
            })}
          </ul>
        )
      ) : null}

      {picked ? (
        <section aria-label="더할 기관" className="flex min-w-0 flex-col gap-3 rounded-control border border-border p-3">
          <p className="text-sm text-text">
            {picked.name ?? `CIK ${picked.cik}`} <span className="font-mono text-xs text-text-3">CIK {picked.cik}</span>
          </p>
          <label className={FIELD_LABEL}>
            표시 이름(선택 — 비우면 SEC 등록 이름)
            <input className={FIELD_INPUT} value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={60} />
          </label>
          <label className={FIELD_LABEL}>
            설명(선택)
            <input className={FIELD_INPUT} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={200} />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={add} busy={editor.busy}>
              즐겨찾기에 더하기
            </Button>
            {editor.busy ? <span className="text-sm text-text-2">SEC에서 확인하고 13F를 모으는 중 — 1분 가까이 걸릴 수 있습니다.</span> : null}
          </div>
        </section>
      ) : null}

      <div role="status" aria-live="polite" className="min-h-0">
        {editor.message ? (
          <StatusText tone={editor.message.tone === "error" ? "danger" : "ok"}>{editor.message.text}</StatusText>
        ) : null}
      </div>

      <section aria-label="지금 즐겨찾기" className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-medium text-text">지금 즐겨찾기 {favorites.length}곳</h3>
        {favorites.length === 0 ? (
          <p className="text-sm text-text-2">아직 없습니다.</p>
        ) : (
          <ul ref={listRef} className="flex min-w-0 flex-col divide-y divide-border rounded-control border border-border">
            {favorites.map((favorite) => (
              <li key={favorite.cik} className="flex min-w-0 flex-col gap-2 px-3 py-2">
                <span className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <span className="flex min-w-0 flex-col">
                    <span className="break-keep text-text wrap-anywhere">{favorite.name}</span>
                    {favorite.desc ? <span className="break-keep text-xs text-text-2 wrap-anywhere">{favorite.desc}</span> : null}
                    <span className="text-xs text-text-3">
                      <span className="font-mono">CIK {favorite.cik}</span>
                      {favorite.secName && favorite.secName !== favorite.name ? ` · SEC ${favorite.secName}` : ""} ·{" "}
                      {favorite.stored ? `저장본 ${favorite.latestReportDate ?? ""} 보고 기준`.trim() : "저장본 없음(수집 전)"}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2" data-edit-cik={favorite.cik}>
                    <Button size="sm" onClick={() => openEditing(favorite)} expanded={editing?.cik === favorite.cik} busy={editor.busy}>
                      고치기 <span className="sr-only">{favorite.name}</span>
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setRemoving(favorite)} busy={editor.busy}>
                      지우기 <span className="sr-only">{favorite.name}</span>
                    </Button>
                  </span>
                </span>
                {editing?.cik === favorite.cik ? (
                  <form onSubmit={saveEditing} aria-label={`${favorite.name} 표시 이름·설명 고치기`} className="flex min-w-0 flex-col gap-2">
                    <label className={FIELD_LABEL}>
                      표시 이름(비우면 SEC 등록 이름)
                      <input
                        className={FIELD_INPUT}
                        value={editing.displayName}
                        onChange={(event) => setEditing({ ...editing, displayName: event.target.value })}
                        maxLength={60}
                        ref={editFieldRef}
                      />
                    </label>
                    <label className={FIELD_LABEL}>
                      설명(선택)
                      <input
                        className={FIELD_INPUT}
                        value={editing.description}
                        onChange={(event) => setEditing({ ...editing, description: event.target.value })}
                        maxLength={200}
                      />
                    </label>
                    <span className="flex flex-wrap items-center gap-2">
                      <Button type="submit" variant="primary" size="sm" busy={editor.busy}>
                        저장
                      </Button>
                      {/* 저장하는 동안에는 막습니다(다른 단추와 같은 규칙) — 취소하면 칸이 닫혀 저장 결과를 볼 자리가 사라졌습니다(QA-1031). */}
                      <Button size="sm" onClick={() => closeEditing(favorite.cik)} busy={editor.busy}>
                        취소
                      </Button>
                    </span>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => (next ? undefined : setRemoving(null))}
        title="즐겨찾기에서 지울까요?"
        description={removing ? removeDescription(removing) : undefined}
        confirmLabel="지우기"
        tone="danger"
        busy={editor.busy}
        onConfirm={async () => {
          if (!removing) return;
          const cik = removing.cik;
          const ok = await editor.remove(cik);
          // 성공·실패 모두 확인 창을 닫습니다 — 실패 사유는 아래 대화상자 본문(상태 줄)에 있어, 창이 열린 채면 가려졌습니다(QA-1031).
          setRemoving(null);
          if (ok) {
            onRemoved?.(cik);
            // 지운 줄의 단추가 사라져 포커스가 몸통으로 떨어지지 않게 찾기 칸으로(확인 창이 닫힌 뒤).
            requestAnimationFrame(() => queryRef.current?.focus());
          }
        }}
      />
    </div>
  );
}

/** 후보의 최근 13F 공시 글(QA-986) — 공시일(보고 기준일), 최근 공시 목록에 없음, 확인 못 함. */
function latestText(candidate: FavoriteCandidate): string {
  if (!candidate.checked) return "공시일 확인 못 함";
  if (!candidate.latest13F) return "최근 공시 목록에 13F-HR 없음";
  const report = candidate.latest13F.reportDate ? `(${candidate.latest13F.reportDate} 기준)` : "";
  return `최근 13F ${candidate.latest13F.filingDate} 공시${report}`;
}

/** 지우기 확인 글 — 그 기관의 13F 신규 편입 알림 규칙이 있으면 함께 지워지는 수(ADR 0048 단계 3). */
function removeDescription(favorite: InstitutionFavoriteEntry): string {
  const rules = favorite.alertRules ?? 0;
  return (
    `${favorite.name}(CIK ${favorite.cik})을 즐겨찾기에서 지웁니다.` +
    (rules > 0 ? ` 이 기관의 13F 신규 편입 알림 규칙 ${rules}개도 함께 지웁니다(모든 사용자).` : "") +
    " 13F 저장본은 남겨 두어 다시 더하면 바로 보입니다."
  );
}

function statusOf(cik: string, favorites: readonly InstitutionFavoriteEntry[], defaultCiks: readonly string[]): FavoriteCandidate["status"] {
  if (defaultCiks.includes(cik)) return "default";
  return favorites.some((favorite) => favorite.cik === cik) ? "favorite" : null;
}
