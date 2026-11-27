"use client";

import { NativeSelect } from "@/components/ui";
import { useLiveSeconds } from "@/hooks/useLiveSeconds";
import { LIVE_SECONDS_OPTIONS } from "@/lib/livePrices";

/**
 * 실시간 시세 주기 고르기(ADR 0024) — 장중 카드·보유 표·종목 상세가 같은 값을 씁니다(hooks/useLiveSeconds, 기본 10초). 고른 주기마다 서버가 값을
 * 밀어 줍니다(SSE). 끄기면 화면을 열 때 한 번만 읽습니다.
 *
 * `pending`이면 같은 크기의 보이지 않는 자리만 그립니다(낭독·포커스·조작 없음) — 값이 온 뒤에야 이 상자를 두는 화면(종목 상세 머리)이 읽는 중에
 * 자리를 미리 잡아, 상자가 생기며 옆의 링크가 밀리지 않게 합니다(QA-1042).
 */
export function LiveIntervalSelect({ label = "실시간 시세", pending = false }: { label?: string; pending?: boolean }) {
  const [seconds, setSeconds] = useLiveSeconds();
  if (pending) {
    return (
      <span aria-hidden="true" className="invisible flex items-center gap-1.5 text-xs text-text-3">
        <span className="whitespace-nowrap">{label}</span>
        <NativeSelect value={String(seconds)} onChange={() => undefined} inputSize="sm" disabled tabIndex={-1}>
          {LIVE_SECONDS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      </span>
    );
  }
  return (
    <label className="flex items-center gap-1.5 text-xs text-text-3">
      <span className="whitespace-nowrap">{label}</span>
      <NativeSelect
        value={String(seconds)}
        onChange={(event) => setSeconds(Number(event.target.value))}
        inputSize="sm"
        aria-label={`${label} 주기`}
      >
        {LIVE_SECONDS_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
    </label>
  );
}
