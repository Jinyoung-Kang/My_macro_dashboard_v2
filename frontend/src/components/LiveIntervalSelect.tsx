"use client";

import { NativeSelect } from "@/components/ui";
import { useLiveSeconds } from "@/hooks/useLiveSeconds";
import { LIVE_SECONDS_OPTIONS } from "@/lib/livePrices";

/**
 * 실시간 시세 주기 고르기(ADR 0024) — 장중 카드·보유 표·종목 상세가 같은 값을 씁니다(hooks/useLiveSeconds, 기본 10초). 고른 주기마다 서버가 값을
 * 밀어 줍니다(SSE). 끄기면 화면을 열 때 한 번만 읽습니다.
 */
export function LiveIntervalSelect({ label = "실시간 시세" }: { label?: string }) {
  const [seconds, setSeconds] = useLiveSeconds();
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted">
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
