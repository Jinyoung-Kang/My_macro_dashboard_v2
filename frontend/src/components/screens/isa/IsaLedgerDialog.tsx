"use client";

import { useCallback, useId, useState, type ReactNode } from "react";
import { Banner, buttonClasses, inputClasses, NativeSelect } from "@/components/ui";
import { Dialog } from "@/components/ui/Dialog";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import {
  buildLedgerRequest,
  emptyLedgerForm,
  fillAtDefault,
  formatPrice,
  formatShares,
  kindLabel,
  LEDGER_KINDS,
  ledgerFields,
  ledgerFormFromInstruction,
  ledgerFormFromRow,
  sideLabel,
  sourceLabel,
  symbolText,
  type IsaLedgerForm,
} from "@/lib/isa";
import type { IsaInstructionItem, IsaLedgerKind, IsaLedgerRow, IsaOkResponse } from "@/lib/types/isa";
import { postLedger, sendIsa } from "./isaRequests";

/**
 * 창을 연 까닭 — 행 추가·장부 행 고치기·지시의 체결 고치기(그 지시로 적힌 행이 있으면 그 행을 고침). 체결 고치기의 `open`은 그 지시 세션의
 * 개장 시각(ISO — 최신 세션의 지시일 때만 알고, 지난 세션 지시는 null).
 */
export type IsaLedgerTarget =
  | { mode: "add" }
  | { mode: "edit"; row: IsaLedgerRow }
  | { mode: "instruction"; item: IsaInstructionItem; row: IsaLedgerRow | null; session: string | null; open?: string | null };

function titleOf(target: IsaLedgerTarget | null): string {
  if (!target || target.mode === "add") return "장부 행 추가";
  if (target.mode === "edit") return "장부 행 고치기";
  return `체결 고치기 — ${sideLabel(target.item.side)} ${symbolText(target.item.symbol, target.item.name)}`;
}

/**
 * 처음 입력 — 체결 고치기의 새 행은 시각을 그 세션 개장 시각으로 채웁니다(자동 기록 행과 같은 시각 — 모르면 그 세션 09:00, 비우면 서버가 지금으로).
 */
function initialForm(target: IsaLedgerTarget): IsaLedgerForm {
  if (target.mode === "add") return emptyLedgerForm();
  if (target.mode === "edit") return ledgerFormFromRow(target.row) ?? emptyLedgerForm();
  const form = ledgerFormFromInstruction(target.item, target.row);
  if (target.row) return form;
  const at = fillAtDefault(target.session, target.open);
  return at === "" ? form : { ...form, at };
}

/**
 * 보낼 때 함께 실을 것 — 고치는 행의 id와, 지시에 묶인 행이면 그 지시 번호(고쳐도 묶임이 풀리지 않게), 고치는 행의 시각 원문(시각을 바꾸지 않았으면
 * 그대로 보내 초·소수초를 잃지 않게).
 */
function contextOf(target: IsaLedgerTarget): { id?: number; instructionId?: number; originalAt?: string | null } {
  if (target.mode === "add") return {};
  if (target.mode === "edit") {
    const base = { id: target.row.id, originalAt: target.row.at };
    return typeof target.row.instructionId === "number" ? { ...base, instructionId: target.row.instructionId } : base;
  }
  return target.row
    ? { id: target.row.id, instructionId: target.item.id, originalAt: target.row.at }
    : { instructionId: target.item.id };
}

/**
 * ISA 계좌 장부 행 추가·고치기 창(ADR 0029, 명세 §3·§8) — 종류(매수·매도·입금·출금·조정)마다 쓰는 칸만 보입니다. 고치기·체결 고치기에서는 종류를
 * 바꾸지 않습니다(다른 종류면 지우고 새로 추가). 체결 고치기는 그 지시로 적힌 행(자동 기록 또는 앞서 직접 적은 행)이 있으면 그 행을 고치고, 없으면 지시의
 * 방향·종목·수량으로 새 행(지시 번호를 담음)을 채웁니다 — 체결가는 비워 두고 지시 기준가를 참고로만 보입니다.
 *
 * <p>창은 결과가 나온 뒤 닫힙니다(처리 중에는 Esc·바깥 누르기로 닫히지 않음). 서버 오류는 코드별 문구로 창 안에 보입니다.
 */
export function IsaLedgerDialog({
  target,
  onClose,
  onDone,
  onReload,
}: {
  target: IsaLedgerTarget | null;
  onClose: () => void;
  onDone: (target: IsaLedgerTarget) => void;
  onReload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title={titleOf(target)}
      description="연결되지 않은 계좌라 증권사로 주문을 보내지 않습니다 — 이 장부만 고치고, 다음 지시는 고친 장부로 계산합니다."
      size="md"
      placement="top"
      dismissible={!busy}
    >
      {/* 내용은 닫히면 DOM에서 빠지므로 입력과 오류는 다시 열 때 저절로 비워집니다. */}
      {target && (
        <LedgerForm target={target} onBusyChange={setBusy} onCancel={onClose} onDone={() => onDone(target)} onReload={onReload} />
      )}
    </Dialog>
  );
}

function LedgerForm({
  target,
  onBusyChange,
  onCancel,
  onDone,
  onReload,
}: {
  target: IsaLedgerTarget;
  onBusyChange: (busy: boolean) => void;
  onCancel: () => void;
  onDone: () => void;
  onReload: () => void;
}) {
  const ids = useId();
  const [form, setForm] = useState<IsaLedgerForm>(() => initialForm(target));
  const send = useCallback((request: () => Promise<IsaOkResponse>) => sendIsa(request, onReload), [onReload]);
  const action = useAsyncAction(send, "장부에 적지 못했습니다.");
  const fields = ledgerFields(form.kind);
  const checked = buildLedgerRequest(form, contextOf(target));
  const kindLocked = target.mode !== "add";
  const symbolLocked = target.mode === "instruction";
  const set = (key: keyof IsaLedgerForm) => (value: string) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    if (!checked.ok || action.busy) return;
    const body = checked.body;
    onBusyChange(true);
    const ok = await action.run(() => postLedger(body));
    onBusyChange(false);
    if (ok) onDone();
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
      {target.mode === "instruction" && (
        <p className="text-sm leading-relaxed text-text-2">
          지시: {sideLabel(target.item.side)} {formatShares(target.item.quantity)}주 · 기준가 {formatPrice(target.item.refPrice)}(참고)
          {target.row
            ? ` — 이 지시로 적힌 장부 행 #${target.row.id}(${sourceLabel(target.row.source)})을 고칩니다.`
            : " — 실제로 체결된 수량과 체결가를 적으세요. 지시대로 했으면 그날 밤 자동 기록되니 적지 않아도 됩니다."}
        </p>
      )}

      {kindLocked ? (
        <p className="flex flex-col gap-1.5 text-sm text-text">
          <span className="font-medium">종류</span>
          <span>{kindLabel(form.kind)}(고치기에서는 바꾸지 않습니다 — 다른 종류면 지우고 새로 추가)</span>
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${ids}-kind`} className="text-sm font-medium text-text">
            종류
          </label>
          <NativeSelect
            id={`${ids}-kind`}
            value={form.kind}
            onChange={(event) => set("kind")(event.target.value as IsaLedgerKind)}
            disabled={action.busy}
            wrapperClassName="block w-full sm:max-w-[16rem]"
          >
            {LEDGER_KINDS.map((option) => (
              <option key={option.kind} value={option.kind}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}

      {fields.symbol && (
        <Field id={`${ids}-symbol`} label="종목 코드" help={symbolLocked ? "지시의 종목입니다." : "여섯 자리(예: 005930)."}>
          <input
            id={`${ids}-symbol`}
            type="text"
            value={form.symbol}
            onChange={(event) => set("symbol")(event.target.value)}
            readOnly={symbolLocked}
            disabled={action.busy}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className={`w-40 font-mono ${inputClasses()}`}
          />
        </Field>
      )}

      {fields.quantity && (
        <Field
          id={`${ids}-quantity`}
          label="수량(주)"
          help={form.kind === "ADJUST" ? "늘면 양수, 줄면 음수(분할·병합 등 — 현금은 바뀌지 않음)." : undefined}
        >
          <input
            id={`${ids}-quantity`}
            type="text"
            inputMode="decimal"
            value={form.quantity}
            onChange={(event) => set("quantity")(event.target.value)}
            disabled={action.busy}
            autoComplete="off"
            className={`w-40 ${inputClasses()}`}
          />
        </Field>
      )}

      {fields.price && (
        <Field id={`${ids}-price`} label="체결가(원)">
          <input
            id={`${ids}-price`}
            type="text"
            inputMode="decimal"
            value={form.price}
            onChange={(event) => set("price")(event.target.value)}
            disabled={action.busy}
            autoComplete="off"
            className={`w-40 ${inputClasses()}`}
          />
        </Field>
      )}

      {fields.amount && (
        <Field id={`${ids}-amount`} label="금액(원)">
          <input
            id={`${ids}-amount`}
            type="text"
            inputMode="decimal"
            value={form.amount}
            onChange={(event) => set("amount")(event.target.value)}
            disabled={action.busy}
            autoComplete="off"
            className={`w-48 ${inputClasses()}`}
          />
        </Field>
      )}

      {fields.costs && (
        <div className="flex flex-wrap gap-4">
          <Field id={`${ids}-fee`} label="수수료(원)" help="비우면 0.">
            <input
              id={`${ids}-fee`}
              type="text"
              inputMode="decimal"
              value={form.fee}
              onChange={(event) => set("fee")(event.target.value)}
              disabled={action.busy}
              autoComplete="off"
              className={`w-32 ${inputClasses()}`}
            />
          </Field>
          <Field id={`${ids}-tax`} label="세금(원)" help="비우면 0.">
            <input
              id={`${ids}-tax`}
              type="text"
              inputMode="decimal"
              value={form.tax}
              onChange={(event) => set("tax")(event.target.value)}
              disabled={action.busy}
              autoComplete="off"
              className={`w-32 ${inputClasses()}`}
            />
          </Field>
        </div>
      )}

      <Field id={`${ids}-at`} label="시각(서울)" help="비우면 지금 시각으로 적습니다.">
        <input
          id={`${ids}-at`}
          type="datetime-local"
          value={form.at}
          onChange={(event) => set("at")(event.target.value)}
          disabled={action.busy}
          className={`w-60 ${inputClasses()}`}
        />
      </Field>

      <Field id={`${ids}-note`} label="메모">
        <input
          id={`${ids}-note`}
          type="text"
          value={form.note}
          onChange={(event) => set("note")(event.target.value)}
          disabled={action.busy}
          autoComplete="off"
          maxLength={200}
          className={`w-full ${inputClasses()}`}
        />
      </Field>

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
          {action.busy ? "적는 중…" : "장부에 적기"}
        </button>
      </div>
    </form>
  );
}

/** 이름표 + 입력칸 + 도움말 한 묶음. */
function Field({ id, label, help, children }: { id: string; label: string; help?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      {children}
      {help && <p className="text-xs text-text-3">{help}</p>}
    </div>
  );
}
