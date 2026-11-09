"use client";

import { useCallback, useId, useState } from "react";
import { Banner, buttonClasses, inputClasses } from "@/components/ui";
import { Dialog } from "@/components/ui/Dialog";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import {
  buildApplyRequest,
  buildEditTradeRequest,
  confirmLineWarning,
  formatShares,
  type IsaConfirmField,
  type IsaConfirmLine,
  sideLabel,
  symbolText,
  updateConfirmLine,
} from "@/lib/isa";
import type { IsaOkResponse } from "@/lib/types/isa";
import { postApply, postEditTrade, sendIsa } from "./isaRequests";

/**
 * 창을 연 대상 — 지시·스탑 지시의 '확인'(줄마다 하나, 전부 확인이면 여러 줄) 또는 매매 내역의 '고치기'(한 줄, {@code tradeId}).
 */
export type IsaConfirmTarget = { mode: "apply"; lines: IsaConfirmLine[] } | { mode: "edit"; tradeId: number; line: IsaConfirmLine };

/**
 * ISA 계좌 체결 입력 창(2026-11-09 사용자 결정 — ADR 0034) — 줄마다 수량·체결 금액(총액)·평균 단가·수수료. 실시간 가격으로 채워 두어 그대로 누를 수 있고, 금액을 고치면
 * 평균 단가가, 평균 단가나 수량을 고치면 금액이 따라 바뀝니다(수수료는 직접 고치기 전까지 수수료율로 다시 셈). 적은 값으로 잔고에 바로 반영합니다. 세금은 서버가 매도에 자동으로
 * 셉니다. 증권사로 주문을 보내지 않습니다.
 */
export function IsaConfirmDialog({
  target,
  commissionPct,
  onClose,
  onDone,
  onReload,
}: {
  target: IsaConfirmTarget | null;
  commissionPct: number | null;
  onClose: () => void;
  onDone: (result: IsaOkResponse, count: number) => void;
  onReload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title={target?.mode === "edit" ? "매매 고치기" : "체결 입력"}
      description="증권사 앱에 나온 수량과 체결 금액, 수수료를 적으세요. 적은 값으로 잔고에 바로 반영하며, 증권사로 주문을 보내지는 않습니다."
      size="lg"
      placement="top"
      dismissible={!busy}
    >
      {/* 내용은 닫히면 DOM에서 빠지므로 입력과 오류는 다시 열 때 저절로 비워집니다. */}
      {target && <ConfirmForm target={target} commissionPct={commissionPct} onBusyChange={setBusy} onCancel={onClose} onDone={onDone} onReload={onReload} />}
    </Dialog>
  );
}

function ConfirmForm({
  target,
  commissionPct,
  onBusyChange,
  onCancel,
  onDone,
  onReload,
}: {
  target: IsaConfirmTarget;
  commissionPct: number | null;
  onBusyChange: (busy: boolean) => void;
  onCancel: () => void;
  onDone: (result: IsaOkResponse, count: number) => void;
  onReload: () => void;
}) {
  const ids = useId();
  const [lines, setLines] = useState<IsaConfirmLine[]>(target.mode === "edit" ? [target.line] : target.lines);
  const send = useCallback((request: () => Promise<IsaOkResponse>) => sendIsa(request, onReload), [onReload]);
  const action = useAsyncAction(send, "잔고에 반영하지 못했습니다.");
  const editing = target.mode === "edit";
  const checked = editing ? buildEditTradeRequest(lines[0]) : buildApplyRequest(lines);
  const set = (key: string, field: IsaConfirmField, value: string) =>
    setLines((current) => current.map((line) => (line.key === key ? updateConfirmLine(line, field, value, commissionPct) : line)));

  const submit = async () => {
    if (!checked.ok || action.busy) return;
    let reply: IsaOkResponse = { ok: true };
    onBusyChange(true);
    const ok = await action.run(async () => {
      reply = target.mode === "edit" ? await postEditTrade(target.tradeId, buildEditBody()) : await postApply(buildApplyBody());
      return reply;
    });
    onBusyChange(false);
    if (ok) onDone(reply, lines.length);
  };
  // 위에서 checked.ok를 본 뒤에만 부릅니다.
  const buildEditBody = () => {
    const result = buildEditTradeRequest(lines[0]);
    if (!result.ok) throw new Error(result.errors[0]);
    return result.body;
  };
  const buildApplyBody = () => {
    const result = buildApplyRequest(lines);
    if (!result.ok) throw new Error(result.errors[0]);
    return result.body;
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
      <ul className="flex flex-col gap-3">
        {lines.map((line) => {
          const who = `${sideLabel(line.side)} ${symbolText(line.symbol, line.name)}`;
          const warning = confirmLineWarning(line);
          return (
            <li key={line.key} className="rounded-card border border-border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-text">
                  {who}
                  {line.instructed !== null && <span className="ml-2 text-xs font-normal text-text-3">지시 {formatShares(line.instructed)}주</span>}
                </p>
                {lines.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setLines((current) => current.filter((entry) => entry.key !== line.key))}
                    disabled={action.busy}
                    aria-label={`이 줄 빼기 — ${who}`}
                    className={buttonClasses("ghost", "sm")}
                  >
                    빼기
                  </button>
                )}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <NumberField id={`${ids}-${line.key}-quantity`} label="수량(주)" who={who} value={line.quantity} disabled={action.busy} onChange={(v) => set(line.key, "quantity", v)} />
                <NumberField id={`${ids}-${line.key}-amount`} label="체결 금액(총액, 원)" who={who} value={line.amount} disabled={action.busy} onChange={(v) => set(line.key, "amount", v)} />
                <NumberField id={`${ids}-${line.key}-price`} label="평균 단가(원)" who={who} value={line.price} disabled={action.busy} onChange={(v) => set(line.key, "price", v)} />
                <NumberField id={`${ids}-${line.key}-fee`} label="매매 비용(수수료, 원)" who={who} value={line.fee} disabled={action.busy} onChange={(v) => set(line.key, "fee", v)} />
              </div>
              {warning && <p className="mt-2 text-xs text-warn">{warning}</p>}
            </li>
          );
        })}
      </ul>

      <p className="text-xs leading-relaxed text-text-3">
        세금은 매도에 자동으로 계산합니다. {editing ? "고치면 현금·매입 금액·세금·실현 손익을 이 값으로 다시 셉니다." : "안 한 종목은 그 줄을 빼세요 — 뺀 지시는 미확인으로 남습니다."}
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
          {action.busy ? "반영하는 중…" : "잔고에 반영"}
        </button>
      </div>
    </form>
  );
}

/** 숫자 입력 한 칸 — 줄이 여럿이라 읽어 주는 이름에 종목을 함께 넣습니다. */
function NumberField({
  id,
  label,
  who,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  who: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-text-2">
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        autoComplete="off"
        aria-label={`${label} — ${who}`}
        className={`w-full ${inputClasses()}`}
      />
    </div>
  );
}
