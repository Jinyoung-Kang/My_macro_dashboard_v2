"use client";

import { useCallback, useId, useState } from "react";
import { Banner, buttonClasses, inputClasses, NativeSelect } from "@/components/ui";
import { Dialog } from "@/components/ui/Dialog";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import {
  buildDirectTradeRequest,
  confirmLineWarning,
  directTradeHolding,
  directTradePrice,
  emptyDirectTradeForm,
  formatPrice,
  formatShares,
  type IsaDirectTradeField,
  type IsaDirectTradeForm,
  symbolText,
  toNumber,
  updateDirectTradeForm,
} from "@/lib/isa";
import type { IsaOkResponse, IsaPosition } from "@/lib/types/isa";
import { postDirectTrade, sendIsa } from "./isaRequests";

/**
 * 지시 없는 매매 적기 창(2026-11-24 사용자 결정 — ADR 0034 개정) — 지시와 다른 종목을 사거나 판 날, 그 매매를 방향·종목(이름 또는 코드)·수량·체결 금액(총액)·
 * 수수료로 적습니다. 지시 줄의 '확인'과 같은 계산으로 잔고에 바로 반영하고 매매 내역에 '지시 없음'으로 남깁니다(세금은 서버가 매도에 자동으로 셈). 수수료는 직접
 * 고치기 전까지 수수료율로 다시 셉니다. 증권사로 주문을 보내지 않습니다.
 */
export function IsaDirectTradeDialog({
  open,
  positions,
  commissionPct,
  onClose,
  onDone,
  onReload,
}: {
  open: boolean;
  /** 지금 보유 — 종목 칸의 고르기 목록과 매도 보유 수량·참고 가격 안내. */
  positions: readonly IsaPosition[];
  commissionPct: number | null;
  onClose: () => void;
  onDone: (result: IsaOkResponse) => void;
  onReload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title="지시 없는 매매 적기"
      description="지시와 다른 종목을 사거나 판 날 그 매매를 적습니다 — 지시가 있는 매매는 지시 줄의 '확인'을 쓰세요. 적은 값으로 잔고에 바로 반영하며, 증권사로 주문을 보내지는 않습니다."
      size="md"
      placement="top"
      dismissible={!busy}
    >
      {/* 내용은 닫히면 DOM에서 빠지므로 입력과 오류는 다시 열 때 저절로 비워집니다. */}
      {open && <DirectTradeForm positions={positions} commissionPct={commissionPct} onBusyChange={setBusy} onCancel={onClose} onDone={onDone} onReload={onReload} />}
    </Dialog>
  );
}

function DirectTradeForm({
  positions,
  commissionPct,
  onBusyChange,
  onCancel,
  onDone,
  onReload,
}: {
  positions: readonly IsaPosition[];
  commissionPct: number | null;
  onBusyChange: (busy: boolean) => void;
  onCancel: () => void;
  onDone: (result: IsaOkResponse) => void;
  onReload: () => void;
}) {
  const ids = useId();
  const [form, setForm] = useState<IsaDirectTradeForm>(emptyDirectTradeForm);
  const send = useCallback((request: () => Promise<IsaOkResponse>) => sendIsa(request, onReload), [onReload]);
  const action = useAsyncAction(send, "매매를 적지 못했습니다.");
  const checked = buildDirectTradeRequest(form);
  const holding = directTradeHolding(form, positions);
  const price = directTradePrice(form);
  const refPrice = holding ? toNumber(holding.lastPrice) : null;
  const warning = confirmLineWarning({ price: price === null ? "" : String(Math.round(price * 100) / 100), refPrice, amount: form.amount, fee: form.fee });
  const sellWithoutHolding = form.side === "SELL" && form.symbol.trim() !== "" && holding === null;

  const set = (field: IsaDirectTradeField, value: string) => setForm((current) => updateDirectTradeForm(current, field, value, commissionPct));

  const submit = async () => {
    if (!checked.ok || action.busy) return;
    const body = checked.body;
    let reply: IsaOkResponse = { ok: true };
    onBusyChange(true);
    const ok = await action.run(async () => {
      reply = await postDirectTrade(body);
      return reply;
    });
    onBusyChange(false);
    if (ok) onDone(reply);
  };

  const field = (key: Exclude<IsaDirectTradeField, "side">, label: string, placeholder: string, help?: string, decimal = true) => (
    <div className="flex min-w-0 flex-col gap-1.5">
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
        list={key === "symbol" ? `${ids}-held` : undefined}
        className={`w-full ${inputClasses()}`}
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
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}-side`} className="text-sm font-medium text-text">
          방향
        </label>
        <NativeSelect id={`${ids}-side`} value={form.side} onChange={(event) => set("side", event.target.value)} disabled={action.busy} wrapperClassName="block w-full">
          <option value="SELL">매도</option>
          <option value="BUY">매수</option>
        </NativeSelect>
      </div>
      {field("symbol", "종목", "005930 또는 종목 이름", "종목 이름이나 여섯 자리 코드. 매도는 잔고에 있는 종목만 됩니다.", false)}
      <datalist id={`${ids}-held`}>
        {positions.map((row) => (
          <option key={row.symbol} value={row.name ?? row.symbol}>
            {row.symbol}
          </option>
        ))}
      </datalist>
      {holding && (
        <p className="text-xs text-text-2">
          잔고: {symbolText(holding.symbol, holding.name)} {formatShares(holding.quantity)}주{refPrice !== null ? ` · 참고 가격 ${formatPrice(refPrice)}` : ""}
        </p>
      )}
      {sellWithoutHolding && <p className="text-xs text-warn">잔고에서 이 종목을 찾지 못했습니다 — 매도는 잔고에 있는 종목만 적을 수 있습니다(코드로 넣어도 됩니다).</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {field("quantity", "수량(주)", "10")}
        {field("amount", "체결 금액(총액, 원)", "1,250,000")}
        {field("fee", "매매 비용(수수료, 원)", "비우면 수수료율로")}
      </div>
      <p className="text-sm text-text-2">
        평균 단가 = 체결 금액 ÷ 수량: <strong className="font-semibold text-text">{price === null ? "—" : formatPrice(price)}</strong>
      </p>
      {warning && <p className="text-xs text-warn">{warning}</p>}
      <p className="text-xs leading-relaxed text-text-3">
        {"세금은 매도에 자동으로 계산합니다. 시각은 지금으로 적고, 잘못 적었으면 매매 내역의 '고치기'·'되돌리기'를 쓰세요. 다음 세션 지시가 이미 있으면 그날 08:00 전에는 고친 잔고로 다시 만듭니다."}
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
