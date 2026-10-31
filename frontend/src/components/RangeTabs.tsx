"use client";

/**
 * 차트 기간 선택.
 *
 * 이미 받아 둔 시계열을 자르기만 하므로 즉시 반응하고, 서버를 다시 부르지
 * 않습니다(FRED 호출도 늘지 않습니다).
 *
 * 필터는 차트 카드 안이 아니라 **카드 머리말 줄**에 둡니다. 어느 차트에
 * 걸리는 필터인지 눈으로 바로 이어지게 하기 위해서입니다.
 *
 * 모양은 새 기간 탭(patterns/RangeTabs)과 같은 알약(`pillTabClasses`)이고, 고르기 의미(aria-pressed 단추 묶음)는 예전 그대로입니다.
 */
import { pillTabClasses } from "@/components/ui/classes";
import { RANGES, sliceByRange, type RangeValue } from "@/lib/ranges";

export { RANGES, sliceByRange, type RangeValue };

export function RangeTabs({
  value,
  onChange,
  label = "기간",
}: {
  value: RangeValue;
  onChange: (next: RangeValue) => void;
  label?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-text-3">{label}</span>
      <div role="group" aria-label={label} className="inline-flex flex-wrap gap-1">
        {RANGES.map((entry) => {
          const active = entry.value === value;
          return (
            <button
              key={entry.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(entry.value)}
              className={pillTabClasses(active)}
            >
              {entry.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
