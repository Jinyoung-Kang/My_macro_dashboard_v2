"use client";

import { useId, useState, type ReactNode } from "react";
import { Dialog } from "@/components/ui/Dialog";

const BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-md border px-4 py-2 text-sm font-semibold lg:min-h-9 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50";

// 위험한 확인은 danger 바탕. 글자는 surface 색(라이트 흰색·다크 검정에 가까움)이라 두 테마 모두 대비 6.9:1 이상입니다.
const CONFIRM_TONE = {
  default: "border-accent bg-accent text-accent-fg hover:opacity-90",
  danger: "border-danger bg-danger text-surface hover:opacity-90",
} as const;

/**
 * 확인 창 — "정말 할까요?"를 한 번 더 묻는 모달(Radix Dialog).
 *
 * - 확인 단추는 스스로 창을 닫지 않습니다. 부르는 쪽이 일을 마친 뒤(성공이든 실패든) `onOpenChange(false)`로 닫습니다 —
 *   모의매매 화면의 "확인은 결과가 나온 뒤 닫는다" 규칙을 지키려는 것입니다. 그동안 `busy`를 주면 확인·취소·Esc·바깥 누르기가 막힙니다.
 * - `requireText`를 주면 그 글자를 정확히(대소문자·공백까지) 쳐야 확인할 수 있습니다. 친 글자는 창을 다시 열면 비워집니다.
 *   `onConfirm`은 친 글자를 받습니다(requireText가 없으면 빈 글). 서버가 같은 글자를 다시 검사하는 일(계좌 초기화의 confirm)은 부르는
 *   쪽이 이 값을 그대로 보냅니다 — 화면이 정답(requireText)을 대신 채워 보내면 서버 검사는 늘 통과해 두 번째 울타리가 되지 못합니다.
 * - Esc·취소는 `onOpenChange(false)`를 부릅니다. 열면 첫 포커스는 입력칸(있으면) 또는 취소 단추입니다(실수로 Enter를 눌러도 안전).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "취소",
  tone = "default",
  busy = false,
  requireText,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  busy?: boolean;
  /** 이 글자를 정확히 쳐야 확인할 수 있습니다(빈 문자열이면 묻지 않음). */
  requireText?: string;
  /** 확인 — 친 글자를 넘깁니다(requireText가 없으면 ""). 인자를 쓰지 않는 쪽은 `() => …`로 받아도 됩니다. */
  onConfirm: (typed: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description} size="sm" dismissible={!busy} showClose={false}>
      {/* 내용은 닫히면 DOM에서 빠지므로, 친 글자 상태를 이 안에 두면 다시 열 때 저절로 비워집니다. */}
      <ConfirmForm
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        tone={tone}
        busy={busy}
        requireText={requireText || null}
        onConfirm={onConfirm}
        onCancel={() => onOpenChange(false)}
      />
    </Dialog>
  );
}

function ConfirmForm({
  confirmLabel,
  cancelLabel,
  tone,
  busy,
  requireText,
  onConfirm,
  onCancel,
}: {
  confirmLabel: string;
  cancelLabel: string;
  tone: "default" | "danger";
  busy: boolean;
  requireText: string | null;
  onConfirm: (typed: string) => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const canConfirm = !busy && (requireText === null || typed === requireText);

  return (
    <form
      className="mt-4 flex flex-col gap-4"
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        // 입력칸에서 Enter를 눌러도 같은 조건을 거칩니다.
        if (canConfirm) onConfirm(requireText === null ? "" : typed);
      }}
    >
      {requireText !== null && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={inputId} className="text-sm text-text-2">
            확인하려면 다음 글자를 그대로 입력하세요:{" "}
            <code className="rounded-sm bg-surface-2 px-1 font-mono text-text">{requireText}</code>
          </label>
          <input
            id={inputId}
            type="text"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            disabled={busy}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60"
          />
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={`${BUTTON} border-border bg-surface text-text hover:bg-surface-2`}>
          {cancelLabel}
        </button>
        <button type="submit" disabled={!canConfirm} className={`${BUTTON} ${CONFIRM_TONE[tone]}`}>
          {confirmLabel}
        </button>
      </div>
    </form>
  );
}
