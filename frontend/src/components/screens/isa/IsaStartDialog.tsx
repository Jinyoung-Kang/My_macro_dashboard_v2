"use client";

import { useCallback, useId, useMemo, useState } from "react";
import { Banner, buttonClasses, inputClasses } from "@/components/ui";
import { Dialog } from "@/components/ui/Dialog";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useLivePrices } from "@/hooks/useLivePrices";
import { useLiveSeconds } from "@/hooks/useLiveSeconds";
import { buildStartRequest, emptyStartLine, type IsaStartLine, SYMBOL_PATTERN } from "@/lib/isa";
import { liveKey, liveShown } from "@/lib/livePrices";
import type { IsaOkResponse } from "@/lib/types/isa";
import { postStart, sendIsa } from "./isaRequests";

/**
 * ISA 계좌 시작 창(ADR 0034) — 총 잔고(총평가금액 = 현금 + 주식)와 줄마다 종목(이름 또는 코드)·보유 수량·매입 금액을 적습니다. 현금은 서버가 총 잔고 − Σ(수량 × 가격)으로 셉니다
 * (가격: 이 창이 받은 실시간 가격 → 서버 직전 종가 → 매입 금액 어림). 시작은 한 번만 됩니다(이미 시작했으면 409 `already-started`).
 */
export function IsaStartDialog({
  open,
  onClose,
  onDone,
  onReload,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (positionCount: number, notes: readonly string[]) => void;
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
      description="오늘 잔고로 시작합니다 — 증권사 앱에 보이는 총평가금액과 지금 들고 있는 종목을 적으세요. 시작은 한 번만 됩니다(뒤의 차이는 잔고에서 고침)."
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
  onDone: (positionCount: number, notes: readonly string[]) => void;
  onReload: () => void;
}) {
  const ids = useId();
  const [total, setTotal] = useState("");
  const [lines, setLines] = useState<IsaStartLine[]>([emptyStartLine()]);
  const send = useCallback((request: () => Promise<IsaOkResponse>) => sendIsa(request, onReload), [onReload]);
  const action = useAsyncAction(send, "ISA 계좌를 시작하지 못했습니다.");

  // 코드로 적은 줄만 실시간 가격을 받습니다(이름이면 서버가 코드로 찾은 뒤 직전 종가).
  const [liveSeconds] = useLiveSeconds();
  const codes = useMemo(
    () => [...new Set(lines.map((line) => line.symbol.trim().toUpperCase()).filter((code) => SYMBOL_PATTERN.test(code)))],
    [lines],
  );
  const liveItems = useMemo(() => codes.map((code) => liveKey("KR", code)), [codes]);
  const realtime = useLivePrices(liveItems, liveSeconds, codes.length > 0);
  const prices = useMemo(() => {
    const out: Record<string, number> = {};
    if (realtime.disconnected) return out;
    for (const code of codes) {
      const key = liveKey("KR", code);
      if (realtime.missing.includes(key) || !Object.hasOwn(realtime.prices, key)) continue;
      out[code] = liveShown(realtime.prices[key]).price;
    }
    return out;
  }, [codes, realtime.disconnected, realtime.missing, realtime.prices]);

  const checked = buildStartRequest({ totalAsset: total, lines, prices });

  const update = (index: number, key: keyof IsaStartLine, value: string) =>
    setLines((rows) => rows.map((row, at) => (at === index ? { ...row, [key]: value } : row)));

  const submit = async () => {
    if (!checked.ok || action.busy) return;
    const body = checked.body;
    onBusyChange(true);
    let notes: readonly string[] = [];
    const ok = await action.run(async () => {
      const result = await postStart(body);
      notes = result.notes ?? [];
      return result;
    });
    onBusyChange(false);
    if (ok) onDone(body.positions.length, notes);
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
        <label htmlFor={`${ids}-total`} className="text-sm font-medium text-text">
          총 잔고(총평가금액, 원)
        </label>
        <input
          id={`${ids}-total`}
          type="text"
          inputMode="decimal"
          value={total}
          onChange={(event) => setTotal(event.target.value)}
          disabled={action.busy}
          autoComplete="off"
          placeholder="예: 10,000,000"
          className={`w-56 ${inputClasses()}`}
        />
        <p className="text-xs text-text-3">현금 + 주식 평가액 — 증권사 앱의 총평가금액. 현금은 여기에서 주식 평가액을 뺀 값으로 셉니다.</p>
      </div>

      <section aria-label="시작 보유" className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-text">지금 들고 있는 종목</h3>
        {lines.map((line, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <input
              aria-label={`${index + 1}번째 줄 종목`}
              type="text"
              value={line.symbol}
              onChange={(event) => update(index, "symbol", event.target.value)}
              disabled={action.busy}
              autoComplete="off"
              placeholder="종목(이름 또는 코드)"
              className={`w-52 ${inputClasses()}`}
            />
            <input
              aria-label={`${index + 1}번째 줄 수량`}
              type="text"
              inputMode="decimal"
              value={line.quantity}
              onChange={(event) => update(index, "quantity", event.target.value)}
              disabled={action.busy}
              autoComplete="off"
              placeholder="수량"
              className={`w-24 ${inputClasses()}`}
            />
            <input
              aria-label={`${index + 1}번째 줄 매입 금액`}
              type="text"
              inputMode="decimal"
              value={line.purchaseAmount}
              onChange={(event) => update(index, "purchaseAmount", event.target.value)}
              disabled={action.busy}
              autoComplete="off"
              placeholder="매입 금액(원)"
              className={`w-40 ${inputClasses()}`}
            />
            <button
              type="button"
              aria-label={`${index + 1}번째 줄 지우기`}
              onClick={() => setLines((rows) => (rows.length === 1 ? [emptyStartLine()] : rows.filter((_, at) => at !== index)))}
              disabled={action.busy}
              className={buttonClasses("ghost", "sm")}
            >
              줄 지우기
            </button>
          </div>
        ))}
        <div>
          <button type="button" onClick={() => setLines((rows) => [...rows, emptyStartLine()])} disabled={action.busy} className={buttonClasses("secondary", "sm")}>
            줄 추가
          </button>
        </div>
        <p className="text-xs leading-relaxed text-text-3">
          종목은 이름이나 여섯 자리 코드(한 종목으로 좁혀지지 않으면 코드를 넣으세요), 매입 금액은 그 종목을 산 돈 전체입니다. 들고 있는 종목이 없으면 비워 두세요(현금만으로 시작).
        </p>
      </section>

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
