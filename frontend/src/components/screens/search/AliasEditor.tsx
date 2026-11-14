"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { inputClasses } from "@/components/ui";
import { StatusText, XIcon } from "@/components/ui/icons";
import type { InfoSearchWatch } from "@/hooks/useInfoSearchWatch";
import { DEMO_READ_ONLY } from "@/lib/access";
import { EMPTY } from "@/lib/format";
import { ALIAS_MERGE_NOTE, ALIAS_SHORT_NOTE, WATCH_ALIAS_MAX, aliasDraft, aliasesForSave, sameAliases, watchAliasesOf } from "@/lib/infoSearch";
import type { SearchWatchItem } from "@/lib/types";
import { BUTTON, BUTTON_PRIMARY, PaneHeading } from "./parts";

/** 입력칸 — 공용 모양(테두리 3:1·포커스 링 2px·lg 미만 44px), 칸 폭을 다 씀. */
const FIELD = `${inputClasses("sm")} min-w-0 flex-1`;

/** 별칭 칩 — 긴 별칭(60자)도 칸 폭 안에서 줄을 바꿈. */
const CHIP = "inline-flex max-w-full items-center rounded-control border border-border bg-surface-2 text-xs text-text-2";

/** 별칭 칩의 지우기 단추 — 좁은 화면 44px 정사각, 넓은 화면 24px. 칩 테두리 안이라 포커스 링을 안쪽에. */
const CHIP_REMOVE =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control text-text-3 hover:bg-surface hover:text-text lg:min-h-6 lg:min-w-6 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus";

/** 편집을 마친 뒤 포커스를 둘 자리. */
type FocusTarget = "input" | "edit" | null;

/**
 * 관심 대상의 별칭 편집(계약 §9-4) — 속성 칸에 둡니다(이 대상이 내 관심 대상일 때만). 별칭은 그 사용자의 검색어입니다: 결과 경로가 수집기에
 * 넘기면 수집기는 대상 풀기의 별칭에 더해 쓰고(합집합 — 표의 '별칭'은 여기서 빼도 쓰임), 정기 수집은 대표 키마다 모든 사용자의 것을 합쳐 씁니다.
 * 이 사실을 편집 칸에 늘 적습니다(ALIAS_MERGE_NOTE — 칩을 빼면 검색에서 빠지는 것처럼 보이지 않게). 이름은 바꾸지 않습니다.
 *
 * 평소에는 별칭 꼬리표와 '별칭 편집' 단추, 편집 중에는 칩마다 지우기 단추 · 더할 칸과 '더하기' · '저장'·'취소'. 검사는 서버와 같은 규칙
 * (lib/infoSearch — 1~12개, 하나 1~60자, 제어 글자 없음, 대소문자 무시 중복은 하나)이고 틀리면 보내지 않고 사유를 글로(role=alert) 보입니다.
 * 더할 칸에 남긴 글은 '저장'을 누를 때 함께 더합니다. 바뀐 것이 없으면 요청 없이 편집만 닫습니다. 저장하면(PATCH) 목록을 다시 읽고(훅) onSaved로
 * 지금 결과를 다시 부릅니다. 저장하는 동안에는 '취소'도 막습니다 — 보낸 요청은 거둘 수 없어, 닫고 나서 저장되거나 실패 문구가 사라지지 않게.
 *
 * 데모 열람은 읽기만 합니다(편집 단추 없음 — 데모는 관심 대상을 읽지도 않아 실제로는 이 칸이 나오지 않음). 줄의 별칭 칸을 받지 못했으면
 * (단계 6 묶음 1까지의 백엔드) 편집하지 않고 그렇다고 적습니다.
 */
export function AliasEditor({
  watch,
  item,
  demo,
  onSaved,
}: {
  watch: InfoSearchWatch;
  item: SearchWatchItem;
  demo: boolean;
  /** 저장이 끝나 목록을 다시 읽은 뒤 — 지금 결과를 다시 부릅니다. */
  onSaved?: () => void;
}) {
  const headingId = useId();
  const inputId = useId();
  const noteId = useId();
  const errorId = useId();
  const current = watchAliasesOf(item);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<FocusTarget>(null);
  // 다시 그리기 전에 두 번 눌러도 한 번만 보내게(aria-disabled는 다시 그린 뒤에 걸림).
  const saving = useRef(false);
  const { saveAliases, clearAliasError, aliasBusy } = watch;

  // 편집을 열면 더할 칸으로, 닫으면 '별칭 편집' 단추로 포커스를 옮깁니다(사라진 단추에서 포커스가 body로 떨어지지 않게 — WCAG 2.4.3).
  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    if (target === "input") inputRef.current?.focus();
    else editRef.current?.focus();
  }, [editing, draft]);

  if (current === null) {
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
        <PaneHeading id={headingId}>관심 대상 별칭</PaneHeading>
        <p className="text-xs leading-5 text-text-3">관심 대상의 별칭을 받지 못해 여기서 고칠 수 없습니다.</p>
      </section>
    );
  }

  const start = () => {
    clearAliasError();
    setLocalError(null);
    setDraft(current);
    setText("");
    focusNext.current = "input";
    setEditing(true);
  };
  /** 편집을 닫습니다(문구·더할 칸을 비우고 '별칭 편집'으로 포커스). */
  const finish = () => {
    clearAliasError();
    setLocalError(null);
    setText("");
    focusNext.current = "edit";
    setEditing(false);
  };
  /** '취소' — 저장하는 동안은 닫지 않습니다(보낸 PATCH는 거둘 수 없음 — 취소했는데 저장되거나, 실패 문구가 닫힌 편집과 함께 사라지지 않게). */
  const cancel = () => {
    if (aliasBusy || saving.current) return;
    finish();
  };

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = aliasDraft(text, draft);
    if (!next.ok) {
      setLocalError(next.message);
      return;
    }
    setLocalError(null);
    setDraft([...draft, next.alias]);
    setText("");
  };

  const removeAt = (index: number) => {
    setLocalError(null);
    focusNext.current = "input";
    setDraft(draft.filter((_, at) => at !== index));
  };

  const save = async () => {
    if (aliasBusy || saving.current) return;
    let list = draft;
    // 더할 칸에 남긴 글은 함께 더합니다('더하기'를 누르지 않고 '저장'을 눌러도 사라지지 않게).
    if (text.trim()) {
      const next = aliasDraft(text, draft);
      if (!next.ok) {
        setLocalError(next.message);
        return;
      }
      list = [...draft, next.alias];
    }
    const checked = aliasesForSave(list);
    if (!checked.ok) {
      setLocalError(checked.message);
      return;
    }
    setLocalError(null);
    if (sameAliases(checked.aliases, current)) {
      finish();
      return;
    }
    saving.current = true;
    let saved = false;
    try {
      saved = await saveAliases(item.id, checked.aliases);
    } finally {
      saving.current = false;
    }
    if (saved) {
      finish();
      onSaved?.();
    }
  };

  const error = localError ?? watch.aliasError;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <PaneHeading id={headingId}>관심 대상 별칭</PaneHeading>
      {!editing ? (
        <>
          {current.length > 0 ? (
            <ul aria-label="별칭" className="flex flex-wrap gap-1.5">
              {current.map((alias, index) => (
                <li key={`${index}:${alias}`} className={`${CHIP} px-1.5 py-0.5`}>
                  <span className="min-w-0 break-all">{alias}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-text-2">{EMPTY}</p>
          )}
          {demo ? (
            <p className="text-xs text-text-3">{DEMO_READ_ONLY}</p>
          ) : (
            <button ref={editRef} type="button" className={`${BUTTON} self-start`} onClick={start} aria-describedby={noteId}>
              별칭 편집
            </button>
          )}
        </>
      ) : (
        <>
          {draft.length > 0 ? (
            <ul aria-label="편집 중인 별칭" className="flex flex-wrap gap-1.5">
              {draft.map((alias, index) => (
                <li key={`${index}:${alias}`} className={`${CHIP} gap-0.5 py-0.5 pl-1.5 pr-0.5`}>
                  <span className="min-w-0 break-all">{alias}</span>
                  <button type="button" className={CHIP_REMOVE} aria-label={`별칭 ${alias} 빼기`} onClick={() => removeAt(index)}>
                    <XIcon size={12} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-text-2">별칭이 없습니다 — 하나 이상 넣어야 저장됩니다.</p>
          )}
          <form aria-label="별칭 더하기" onSubmit={add} className="flex flex-col gap-1">
            <label htmlFor={inputId} className="text-xs text-text-2">
              더할 별칭 <span className="tabular-nums text-text-3">({draft.length} / {WATCH_ALIAS_MAX})</span>
            </label>
            <div className="flex items-center gap-1.5">
              <input
                ref={inputRef}
                id={inputId}
                value={text}
                onChange={(event) => setText(event.target.value)}
                autoComplete="off"
                maxLength={200}
                aria-invalid={localError !== null || undefined}
                aria-describedby={error ? `${errorId} ${noteId}` : noteId}
                className={FIELD}
              />
              <button type="submit" className={BUTTON}>
                더하기
              </button>
            </div>
          </form>
          <div className="flex flex-wrap gap-1.5">
            {/* 저장하는 동안 disabled로 바꾸지 않습니다(포커스가 body로 떨어짐) — aria-disabled로 알리고 누름은 한 번만 보냅니다. 취소도 같습니다. */}
            <button
              type="button"
              className={`${BUTTON_PRIMARY} aria-disabled:cursor-not-allowed aria-disabled:opacity-50`}
              aria-disabled={aliasBusy || undefined}
              onClick={() => void save()}
            >
              {aliasBusy ? "저장하는 중…" : "저장"}
            </button>
            <button
              type="button"
              className={`${BUTTON} aria-disabled:cursor-not-allowed aria-disabled:opacity-50`}
              aria-disabled={aliasBusy || undefined}
              onClick={cancel}
            >
              취소
            </button>
          </div>
        </>
      )}
      {editing && error ? (
        <p id={errorId} role="alert" className="text-xs leading-5 text-text-2">
          <StatusText tone="warn" colorText={false} iconSize={12}>
            {error}
          </StatusText>
        </p>
      ) : null}
      <p id={noteId} className="text-xs leading-5 text-text-3">
        {ALIAS_MERGE_NOTE} {ALIAS_SHORT_NOTE} 이름은 바꾸지 않습니다.
      </p>
    </section>
  );
}
