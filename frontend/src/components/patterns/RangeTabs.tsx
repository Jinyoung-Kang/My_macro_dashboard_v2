"use client";

import type { JSX, KeyboardEvent } from "react";

import { pillTabClasses } from "@/components/ui/classes";
import { allowedRangeKey, rangeKeyAfter, visibleRanges } from "@/lib/patternRows";

/**
 * 기간 탭(새 패턴) — 이미 받아 둔 시계열을 자르는 구간을 고릅니다. 옛 `components/RangeTabs.tsx`는 옛 화면이 쓰므로 그대로 둡니다.
 *
 * - `allowed`(저장 구간 안의 키)가 있으면 그 안의 탭만 그립니다. 밖의 탭은 렌더링하지 않습니다(설계서 §6).
 * - `value`가 그려지는 탭이 아니면 아무것도 선택하지 않습니다 — 부르는 쪽이 `allowedRangeKey`(lib/patternRows)로 상태를 맞춥니다.
 * - role="tablist" + 탭마다 aria-selected. 키보드: ←·→ 이웃 탭(끝에서 돎), Home·End. 기본(`activation="auto"`)은 포커스를 옮기며 바로 고릅니다
 *   (구간 자르기는 즉시 끝나 서버를 부르지 않으므로 자동 선택이 낫습니다 — 모의매매 개요의 곡선 자르기). 기간마다 서버를 부르는 곳(상세 가격 차트 —
 *   기간마다 GET /api/macro/ticker → Yahoo)은 `activation="manual"`: 화살표·Home·End는 포커스만 옮기고 누르기·Enter·Space로 고릅니다(공용 Tabs와
 *   같은 규칙 — 지나가는 기간마다 부르지 않게). Tab 키로는 고른 탭(없으면 첫 탭) 하나에만 들어옵니다.
 * - 그릴 탭이 하나도 없으면 아무것도 그리지 않습니다.
 * - 모양은 공용 기간 고르기 조각(`pillTabClasses` — 4px, lg 이상 30px) — 고른 탭은 중립 바탕·안쪽 선과 굵은 글(데이터 영역이라 강조 파랑을 쓰지 않음), 고대비 모드에서는 테두리.
 */
export function RangeTabs<K extends string>({
  ranges,
  allowed,
  value,
  onChange,
  label,
  activation = "auto",
}: {
  ranges: readonly { key: K; label: string }[];
  allowed?: readonly K[];
  value: K;
  onChange: (k: K) => void;
  label: string;
  /** auto(기본): 화살표로 포커스를 옮기며 바로 고름. manual: 화살표는 포커스만, 누르기·Enter·Space로 고름(기간마다 서버를 부르는 곳). */
  activation?: "auto" | "manual";
}): JSX.Element {
  const shown = visibleRanges(ranges, allowed);
  if (shown.length === 0) {
    return <></>;
  }
  const keys = shown.map((range) => range.key);
  const focusKey = allowedRangeKey(value, ranges, allowed);

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: K) {
    // 수동 활성의 Enter·Space — 기본 동작(단추 누르기)을 막고 여기서 한 번만 고릅니다(이미 고른 탭이면 누르기와 같이 부르지 않음).
    if (activation === "manual" && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      if (current !== value) {
        onChange(current);
      }
      return;
    }
    const next = rangeKeyAfter(keys, current, event.key);
    if (next === null) {
      return;
    }
    event.preventDefault();
    const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs?.[keys.indexOf(next)]?.focus();
    if (activation === "auto" && next !== value) {
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
            className={pillTabClasses(active)}
          >
            {range.label}
          </button>
        );
      })}
    </div>
  );
}
