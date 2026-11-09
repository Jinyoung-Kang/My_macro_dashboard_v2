"use client";

import { useCallback, useId, useState } from "react";
import { Banner, buttonClasses, inputClasses } from "@/components/ui";
import { Dialog } from "@/components/ui/Dialog";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { buildPositionRequest, emptyPositionForm, formatWon, type IsaPositionForm, positionFormAmount, positionFormFromRow } from "@/lib/isa";
import type { IsaOkResponse, IsaPosition } from "@/lib/types/isa";
import { postPosition, sendIsa } from "./isaRequests";

/** 창을 연 까닭 — 행 추가 또는 그 행 고치기. */
export type IsaPositionTarget = { mode: "add" } | { mode: "edit"; row: IsaPosition };

/**
 * 잔고 행 추가·고치기 창(ADR 0034) — 종목코드(이름도 됨)·종목명·수량·가격(평균 매입가). 합계 '매입 금액 = 수량 × 가격'을 바로 보여 줍니다. 현금은 바꾸지 않습니다
 * (현금까지 맞추려면 '총 잔고 다시 맞추기'). 증권사로 주문을 보내지 않습니다.
 */
export function IsaPositionDialog({
  target,
  onClose,
  onDone,
  onReload,
}: {
  target: IsaPositionTarget | null;
  onClose: () => void;
  onDone: () => void;
  onReload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title={target?.mode === "edit" ? "잔고 고치기" : "잔고 행 추가"}
      description="연결되지 않은 계좌라 증권사로 주문을 보내지 않습니다 — 이 잔고만 고치고, 다음 지시는 고친 잔고로 계산합니다."
      size="md"
      placement="top"
      dismissible={!busy}
    >
      {target && <PositionForm target={target} onBusyChange={setBusy} onCancel={onClose} onDone={onDone} onReload={onReload} />}
    </Dialog>
  );
}

function PositionForm({
  target,
  onBusyChange,
  onCancel,
  onDone,
  onReload,
}: {
  target: IsaPositionTarget;
  onBusyChange: (busy: boolean) => void;
  onCancel: () => void;
  onDone: () => void;
  onReload: () => void;
}) {
  const ids = useId();
  const [form, setForm] = useState<IsaPositionForm>(() => (target.mode === "edit" ? positionFormFromRow(target.row) : emptyPositionForm()));
  const send = useCallback((request: () => Promise<IsaOkResponse>) => sendIsa(request, onReload), [onReload]);
  const action = useAsyncAction(send, "잔고를 고치지 못했습니다.");
  const original = target.mode === "edit" ? target.row.symbol : null;
  const checked = buildPositionRequest(form, original);
  const amount = positionFormAmount(form);

  const set = (key: keyof IsaPositionForm, value: string) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    if (!checked.ok || action.busy) return;
    const body = checked.body;
    onBusyChange(true);
    const ok = await action.run(() => postPosition(body));
    onBusyChange(false);
    if (ok) onDone();
  };

  const field = (key: keyof IsaPositionForm, label: string, placeholder: string, help?: string, decimal = false) => (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${ids}-${key}`} className="text-sm font-medium text-text">
        {label}
      </label>
      <input
        id={`${ids}-${key}`}
        type="text"
        inputMode={decimal ? "decimal" : undefined}
        value={form[key]}
        onChange={(event) => set(key, event.target.value)}
        disabled={action.busy}
        autoComplete="off"
        placeholder={placeholder}
        className={inputClasses()}
      />
      {help && <p className="text-xs text-text-3">{help}</p>}
    </div>
  );

  return (
    <form
      className="mt-4 flex flex-col gap-4"
      aria-busy={action.busy}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {field("symbol", "종목코드", "005930", "여섯 자리 코드나 종목 이름.")}
      {field("name", "종목명", "비우면 시세 이름표", "표시 이름만 바꿉니다.")}
      {field("quantity", "수량", "10", undefined, true)}
      {field("price", "가격(평균 매입가)", "12,000", "평균 매입가입니다. 여기를 고쳐도 현금은 바뀌지 않습니다 — 체결 금액이 틀렸으면 매매 내역의 '고치기'를 쓰세요.", true)}
      <p className="text-sm text-text-2">
        매입 금액 = 수량 × 가격: <strong className="font-semibold text-bright">{amount === null ? "—" : formatWon(amount)}</strong>
      </p>

      {!checked.ok && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-text-3" aria-label="보내기 전에 필요한 것">
          {checked.errors.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      )}
      {action.error && (
        <div role="alert">
          <Banner tone="danger">{action.error}</Banner>
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={action.busy} className={buttonClasses("secondary")}>
          취소
        </button>
        <button type="submit" disabled={!checked.ok || action.busy} className={buttonClasses("primary")}>
          {action.busy ? "저장하는 중…" : "저장"}
        </button>
      </div>
    </form>
  );
}
