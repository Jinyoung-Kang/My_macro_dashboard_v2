"use client";

import { useCallback, useId, useState } from "react";
import { DataTable, type Column } from "@/components/patterns";
import { Banner, buttonClasses, inputClasses } from "@/components/ui";
import { Dialog } from "@/components/ui/Dialog";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { buildStartRequest, formatPrice, formatShares, formatWon, parseDecimal, parseStartBuys, startBuysTotal } from "@/lib/isa";
import type { IsaOkResponse, IsaStartBuy } from "@/lib/types/isa";
import { postStart, sendIsa } from "./isaRequests";

/** 붙여 넣기 칸의 예시(형식만 — 값은 아무 뜻 없는 보기). */
const BUYS_PLACEHOLDER = "123450 10 10000\n678900 3 25000";

const BUY_COLUMNS: readonly Column<IsaStartBuy>[] = [
  { key: "symbol", header: "종목 코드", cell: (row) => row.symbol },
  { key: "quantity", header: "수량(주)", align: "right", cell: (row) => formatShares(row.quantity) },
  { key: "price", header: "가격", align: "right", cell: (row) => formatPrice(row.price) },
  { key: "amount", header: "금액(어림)", align: "right", cell: (row) => formatWon(row.quantity * row.price) },
];

/**
 * ISA 계좌 시작 창(ADR 0029, 명세 §3 '시작'·§8) — 시작 현금(입금 행)과 시작 매수 목록(매수 행 — '코드 수량 가격'을 줄마다 붙여 넣기)을 한 번에 적습니다.
 * 시작은 한 번만 됩니다(이미 시작했으면 409 `already-started`). 붙여 넣은 줄은 바로 읽어 보이고(읽은 줄 표·줄마다 오류·시작 매수 합·남는 현금 어림),
 * 형식이 틀린 줄이 있거나 시작 매수 합이 시작 현금보다 크면 보내지 않습니다.
 */
export function IsaStartDialog({
  open,
  onClose,
  onDone,
  onReload,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (buyCount: number) => void;
  onReload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title="ISA 계좌 시작"
      description="연결되지 않은 다른 증권사 계좌의 장부를 시작합니다 — 시작 현금과, 이미 산 종목이 있으면 그 수량·체결가를 적으세요. 시작은 한 번만 됩니다(뒤의 차이는 장부에서 고침)."
      size="lg"
      placement="top"
      dismissible={!busy}
    >
      {open && <StartForm onBusyChange={setBusy} onCancel={onClose} onDone={onDone} onReload={onReload} />}
    </Dialog>
  );
}

function StartForm({
  onBusyChange,
  onCancel,
  onDone,
  onReload,
}: {
  onBusyChange: (busy: boolean) => void;
  onCancel: () => void;
  onDone: (buyCount: number) => void;
  onReload: () => void;
}) {
  const ids = useId();
  const [cash, setCash] = useState("");
  const [startedAt, setStartedAt] = useState("");
  const [buys, setBuys] = useState("");
  const send = useCallback((request: () => Promise<IsaOkResponse>) => sendIsa(request, onReload), [onReload]);
  const action = useAsyncAction(send, "ISA 계좌를 시작하지 못했습니다.");

  const parsed = parseStartBuys(buys);
  const total = startBuysTotal(parsed.buys);
  const cashValue = parseDecimal(cash, { maxDecimals: 2 });
  const checked = buildStartRequest({ cash, startedAt, buys });

  const submit = async () => {
    if (!checked.ok || action.busy) return;
    const body = checked.body;
    onBusyChange(true);
    const ok = await action.run(() => postStart(body));
    onBusyChange(false);
    if (ok) onDone(body.buys.length);
  };

  return (
    <form
      className="mt-4 flex flex-col gap-5"
      aria-busy={action.busy}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}-cash`} className="text-sm font-medium text-text">
          시작 현금(원)
        </label>
        <input
          id={`${ids}-cash`}
          type="text"
          inputMode="decimal"
          value={cash}
          onChange={(event) => setCash(event.target.value)}
          disabled={action.busy}
          autoComplete="off"
          placeholder="예: 10,000,000"
          className={`w-56 ${inputClasses()}`}
        />
        <p className="text-xs text-text-3">계좌에 넣은 돈 전부(입금 행). 시작 매수 대금은 여기서 빠집니다.</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}-at`} className="text-sm font-medium text-text">
          시작 시각(서울)
        </label>
        <input
          id={`${ids}-at`}
          type="datetime-local"
          value={startedAt}
          onChange={(event) => setStartedAt(event.target.value)}
          disabled={action.busy}
          className={`w-60 ${inputClasses()}`}
        />
        <p className="text-xs text-text-3">비우면 지금 시각. 시작 매수를 산 시각을 적어도 됩니다.</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}-buys`} className="text-sm font-medium text-text">
          시작 매수 목록
        </label>
        <textarea
          id={`${ids}-buys`}
          value={buys}
          onChange={(event) => setBuys(event.target.value)}
          disabled={action.busy}
          rows={7}
          spellCheck={false}
          placeholder={BUYS_PLACEHOLDER}
          aria-describedby={`${ids}-buys-help`}
          className={`w-full font-mono ${inputClasses()}`}
        />
        <p id={`${ids}-buys-help`} className="text-xs leading-relaxed text-text-3">
          줄마다 &lsquo;종목코드 수량 체결가&rsquo;(빈칸이나 탭으로 나눔 — 표에서 복사한 줄도 됨, 천 단위 쉼표 허용). 산 것이 없으면 비워 두세요(현금만으로 시작).
        </p>
      </div>

      {parsed.buys.length > 0 && (
        <section aria-label="읽은 시작 매수" className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-text">읽은 시작 매수 {parsed.buys.length}줄</h3>
          <DataTable
            caption="읽은 시작 매수"
            columns={BUY_COLUMNS}
            rows={parsed.buys}
            rowKey={(row) => `${row.symbol}-${parsed.buys.indexOf(row)}`}
            maxHeight={240}
          />
          <p className="text-xs text-text-3">
            시작 매수 합 {formatWon(total)}
            {cashValue !== null && cashValue > 0 ? ` · 남는 현금 ${formatWon(cashValue - total)}` : ""}(어림 — 수수료·세금 제외, 장부에서 고칠 수 있음)
          </p>
        </section>
      )}

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
          {action.busy ? "적는 중…" : "시작"}
        </button>
      </div>
    </form>
  );
}
