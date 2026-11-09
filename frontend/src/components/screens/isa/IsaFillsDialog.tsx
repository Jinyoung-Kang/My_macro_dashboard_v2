"use client";

import { useCallback, useId, useState } from "react";
import { Banner, buttonClasses, inputClasses } from "@/components/ui";
import { Dialog } from "@/components/ui/Dialog";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { buildFillsRequest, formatPrice, type IsaFillLine, sideLabel, symbolText, toNumber } from "@/lib/isa";
import type { IsaOkResponse } from "@/lib/types/isa";
import { postConfirmInstructions, postFills, sendIsa } from "./isaRequests";

/**
 * 창을 연 대상 — 줄(지시·스탑 지시마다 하나)과, '표시만 남기기'에 쓸 다음 시가 지시 번호(스탑 지시만 있으면 비어 그 단추가 없음 — 스탑 지시에는 표시가 없고
 * 적지 않으면 밤에 자동 기록됩니다).
 */
export interface IsaFillTarget {
  lines: IsaFillLine[];
  confirmIds: number[];
}

/**
 * ISA 계좌 체결 입력 창(2026-11-09 사용자 결정) — '매매함'을 누르면 지시마다 수량·체결가·수수료·세금을 받아 한 번에 장부에 적습니다(보유에 바로 반영, 한 줄이라도
 * 안 되면 아무것도 적지 않음 — 서버 한 트랜잭션). 안 한 종목은 그 줄을 빼면 되고, 체결가를 모르면 '표시만 남기기'로 예전처럼 장 중반 알림만 끄고 밤 자동 기록에
 * 맡깁니다. 행 시각은 서버가 자동 기록과 같은 시각으로 적습니다(다르면 장부에서 고침).
 */
export function IsaFillsDialog({
  target,
  onClose,
  onDone,
  onMarked,
  onReload,
}: {
  target: IsaFillTarget | null;
  onClose: () => void;
  onDone: (count: number) => void;
  onMarked: () => void;
  onReload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title="체결 입력"
      description="실제로 체결된 수량과 체결가를 적으면 장부와 보유에 바로 반영합니다. 증권사로 주문을 보내지는 않습니다."
      size="lg"
      placement="top"
      dismissible={!busy}
    >
      {/* 내용은 닫히면 DOM에서 빠지므로 입력과 오류는 다시 열 때 저절로 비워집니다. */}
      {target && (
        <FillsForm target={target} onBusyChange={setBusy} onCancel={onClose} onDone={onDone} onMarked={onMarked} onReload={onReload} />
      )}
    </Dialog>
  );
}

function FillsForm({
  target,
  onBusyChange,
  onCancel,
  onDone,
  onMarked,
  onReload,
}: {
  target: IsaFillTarget;
  onBusyChange: (busy: boolean) => void;
  onCancel: () => void;
  onDone: (count: number) => void;
  onMarked: () => void;
  onReload: () => void;
}) {
  const ids = useId();
  const [lines, setLines] = useState<IsaFillLine[]>(target.lines);
  const send = useCallback((request: () => Promise<IsaOkResponse>) => sendIsa(request, onReload), [onReload]);
  const action = useAsyncAction(send, "장부에 적지 못했습니다.");
  const checked = buildFillsRequest(lines);
  const set = (key: string, field: "quantity" | "price" | "fee" | "tax", value: string) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, [field]: value } : line)));
  const markable = target.confirmIds;

  const submit = async () => {
    if (!checked.ok || action.busy) return;
    const body = checked.body;
    onBusyChange(true);
    const ok = await action.run(() => postFills(body));
    onBusyChange(false);
    if (ok) onDone(body.fills.length);
  };

  const markOnly = async () => {
    if (action.busy) return;
    onBusyChange(true);
    const ok = await action.run(() => postConfirmInstructions(markable, true));
    onBusyChange(false);
    if (ok) onMarked();
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
          const refs = [
            toNumber(line.refPrice) !== null ? `기준가 ${formatPrice(line.refPrice)}` : null,
            toNumber(line.autoPrice) !== null ? `자동 기록 ${formatPrice(line.autoPrice)}(이 값을 바꿈)` : null,
          ].filter(Boolean);
          return (
            <li key={line.key} className="rounded-card border border-border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-text">{who}</p>
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
              {refs.length > 0 && <p className="mt-0.5 text-xs text-text-3">{refs.join(" · ")}(참고)</p>}
              <div className="mt-2 flex flex-wrap gap-3">
                <NumberField id={`${ids}-${line.key}-quantity`} label="수량(주)" who={who} value={line.quantity} disabled={action.busy} onChange={(v) => set(line.key, "quantity", v)} />
                <NumberField id={`${ids}-${line.key}-price`} label="체결가(원)" who={who} value={line.price} disabled={action.busy} onChange={(v) => set(line.key, "price", v)} />
                <NumberField id={`${ids}-${line.key}-fee`} label="수수료(원)" who={who} value={line.fee} disabled={action.busy} onChange={(v) => set(line.key, "fee", v)} />
                <NumberField id={`${ids}-${line.key}-tax`} label="세금(원)" who={who} value={line.tax} disabled={action.busy} onChange={(v) => set(line.key, "tax", v)} />
              </div>
            </li>
          );
        })}
      </ul>

      <p className="text-xs leading-relaxed text-text-3">수수료·세금은 비우면 0입니다. 안 한 종목은 그 줄을 빼세요 — 뺀 지시는 그날 밤 지시대로 자동 기록되니, 매매하지 않았으면 지시 표에서 건너뜀을 누르세요.</p>

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
        {markable.length > 0 && (
          <button type="button" onClick={() => void markOnly()} disabled={action.busy} className={buttonClasses("secondary")}>
            표시만 남기기(체결가 모름)
          </button>
        )}
        <button type="submit" disabled={!checked.ok || action.busy} className={buttonClasses("primary")}>
          {action.busy ? "적는 중…" : "장부에 적기"}
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
    <div className="flex flex-col gap-1">
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
        className={`w-28 ${inputClasses()}`}
      />
    </div>
  );
}
