"use client";

import { useCallback, useId, useState } from "react";
import { Banner, buttonClasses, inputClasses } from "@/components/ui";
import { Dialog } from "@/components/ui/Dialog";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { buildCommissionRequest, buildTotalRequest, type Checked } from "@/lib/isa";
import type { IsaOkResponse } from "@/lib/types/isa";
import { postCommission, postTotal, sendIsa } from "./isaRequests";

/** 값 하나를 받아 보내는 작은 창의 공통 모양. */
function OneFieldForm<T>({
  label,
  help,
  initial,
  placeholder,
  build,
  post,
  onBusyChange,
  onCancel,
  onDone,
  onReload,
  submitLabel,
}: {
  label: string;
  help: string;
  initial: string;
  placeholder: string;
  build: (text: string) => Checked<T>;
  post: (body: T) => Promise<IsaOkResponse>;
  onBusyChange: (busy: boolean) => void;
  onCancel: () => void;
  onDone: (result: IsaOkResponse) => void;
  onReload: () => void;
  submitLabel: string;
}) {
  const ids = useId();
  const [text, setText] = useState(initial);
  const send = useCallback((request: () => Promise<IsaOkResponse>) => sendIsa(request, onReload), [onReload]);
  const action = useAsyncAction(send, "저장하지 못했습니다.");
  const checked = build(text);

  const submit = async () => {
    if (!checked.ok || action.busy) return;
    const body = checked.body;
    onBusyChange(true);
    let reply: IsaOkResponse = { ok: true };
    const ok = await action.run(async () => {
      reply = await post(body);
      return reply;
    });
    onBusyChange(false);
    if (ok) onDone(reply);
  };

  return (
    <form
      className="mt-4 flex flex-col gap-4"
      aria-busy={action.busy}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}-value`} className="text-sm font-medium text-text">
          {label}
        </label>
        <input
          id={`${ids}-value`}
          type="text"
          inputMode="decimal"
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={action.busy}
          autoComplete="off"
          placeholder={placeholder}
          className={`w-56 ${inputClasses()}`}
        />
        <p className="text-xs leading-relaxed text-text-3">{help}</p>
      </div>
      {!checked.ok && text.trim() !== "" && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-text-3" aria-label="보내기 전에 필요한 것">
          {checked.errors.map((message) => (
            <li key={message}>{message}</li>
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
          {action.busy ? "저장하는 중…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

/** 총 잔고 다시 맞추기(ADR 0034) — 증권사 앱의 총평가금액을 넣으면 현금을 다시 셉니다(보유 평가는 화면의 실시간 가격 → 서버 직전 종가). */
export function IsaTotalDialog({
  open,
  prices,
  onClose,
  onDone,
  onReload,
}: {
  open: boolean;
  prices: Readonly<Record<string, number>>;
  onClose: () => void;
  onDone: (notes: readonly string[]) => void;
  onReload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title="총 잔고 다시 맞추기"
      description="증권사 앱의 총평가금액을 넣으면 보유 평가액을 뺀 값으로 현금을 다시 셉니다."
      size="md"
      placement="top"
      dismissible={!busy}
    >
      {open && (
        <OneFieldForm
          label="총 잔고(총평가금액, 원)"
          help="현금 + 주식 평가액. 보유 평가는 지금 화면이 받은 실시간 가격, 없으면 직전 종가로 셉니다."
          initial=""
          placeholder="예: 10,000,000"
          build={(text) => buildTotalRequest(text, prices)}
          post={postTotal}
          onBusyChange={setBusy}
          onCancel={onClose}
          onDone={(result) => onDone(result.notes ?? [])}
          onReload={onReload}
          submitLabel="다시 맞추기"
        />
      )}
    </Dialog>
  );
}

/** 수수료율 고치기(ADR 0034) — 기본 0.015%, 다음 확인부터 그 요율로 셉니다. */
export function IsaCommissionDialog({
  open,
  current,
  onClose,
  onDone,
  onReload,
}: {
  open: boolean;
  /** 지금 요율(%). 모르면 빈 칸. */
  current: number | null;
  onClose: () => void;
  onDone: () => void;
  onReload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title="수수료율 고치기"
      description="매수·매도 각각에 붙는 수수료율입니다(0~1%, 기본 0.015%). 다음 확인부터 이 요율로 셉니다."
      size="md"
      placement="top"
      dismissible={!busy}
    >
      {open && (
        <OneFieldForm
          label="수수료율(%)"
          help="세금은 설정값(코스피 거래세+농특세·코스닥 거래세, ETF 0)을 그대로 씁니다."
          initial={current === null ? "" : String(current)}
          placeholder="0.015"
          build={buildCommissionRequest}
          post={postCommission}
          onBusyChange={setBusy}
          onCancel={onClose}
          onDone={() => onDone()}
          onReload={onReload}
          submitLabel="저장"
        />
      )}
    </Dialog>
  );
}
