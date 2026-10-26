"use client";

import type { JSX, KeyboardEvent } from "react";

import { allowedRangeKey, rangeKeyAfter, visibleRanges } from "@/lib/patternRows";

/**
 * 기간 탭(새 패턴) — 이미 받아 둔 시계열을 자르는 구간을 고릅니다. 옛 `components/RangeTabs.tsx`는 옛 화면이 쓰므로 그대로 둡니다.
 *
 * - `allowed`(저장 구간 안의 키)가 있으면 그 안의 탭만 그립니다. 밖의 탭은 렌더링하지 않습니다(설계서 §6).
 * - `value`가 그려지는 탭이 아니면 아무것도 선택하지 않습니다 — 부르는 쪽이 `allowedRangeKey`(lib/patternRows)로 상태를 맞춥니다.
 * - role="tablist" + 탭마다 aria-selected. 키보드: ←·→ 이웃 탭(끝에서 돎), Home·End. 포커스를 옮기며 바로 고릅니다
 *   (구간 자르기는 즉시 끝나 서버를 부르지 않으므로 자동 선택이 낫습니다). Tab 키로는 고른 탭(없으면 첫 탭) 하나에만 들어옵니다.
 * - 그릴 탭이 하나도 없으면 아무것도 그리지 않습니다.
 */
export function RangeTabs<K extends string>({
  ranges,
  allowed,
  value,
  onChange,
  label,
}: {
  ranges: readonly { key: K; label: string }[];
  allowed?: readonly K[];
  value: K;
  onChange: (k: K) => void;
  label: string;
}): JSX.Element {
  const shown = visibleRanges(ranges, allowed);
  if (shown.length === 0) {
    return <></>;
  }
  const keys = shown.map((range) => range.key);
  const focusKey = allowedRangeKey(value, ranges, allowed);

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: K) {
    const next = rangeKeyAfter(keys, current, event.key);
    if (next === null) {
      return;
    }
    event.preventDefault();
    const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs?.[keys.indexOf(next)]?.focus();
    if (next !== value) {
      onChange(next);
    }
  }

  return (
    <div role="tablist" aria-label={label} className="inline-flex max-w-full flex-wrap gap-1">
      {shown.map((range) => {
        const active = range.key === value;
        return (
          <button
            key={range.key}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={range.key === focusKey ? 0 : -1}
            onClick={() => {
              if (!active) {
                onChange(range.key);
              }
            }}
            onKeyDown={(event) => handleKeyDown(event, range.key)}
            className={`min-h-8 rounded-md px-3 py-1 text-sm tabular-nums transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
              active ? "bg-surface-2 font-semibold text-text" : "text-text-2 hover:bg-surface-2 hover:text-text"
            }`}
          >
            {range.label}
          </button>
        );
      })}
    </div>
  );
}
