"use client";

import { useCallback, useState } from "react";

import { scrubIndex } from "@/lib/lineChart";

/**
 * 히어로 차트 문지르기 상태 — 가리킨 점의 순번(없으면 null). 표시 글은 `lib/lineChart`의 `scrubModel`이 만들고 히어로가 그립니다(ADR 0004:
 * 상태는 훅, 계산은 lib).
 *
 * - `onScrub`은 차트(`LineChart`의 `onScrub`)에 그대로 넘깁니다. 마우스·터치·키보드(차트에 초점을 두고 ←·→)가 모두 이 한 길로 옵니다.
 * - 순번은 그것을 받은 때의 행 수와 함께 기억합니다. 기간을 바꿔 행 수가 달라지면(다른 구간) 예전 순번은 지웁니다 — 다른 날짜를
 *   문지르는 것처럼 보이지 않게(같은 기간으로 돌아와도 되살아나지 않음). 범위 밖 순번도 null입니다.
 *
 * @param length 지금 그리는 행 수
 */
export function useChartScrub(length: number): { index: number | null; onScrub: (index: number | null) => void } {
  const [scrub, setScrub] = useState<{ index: number; length: number } | null>(null);
  const onScrub = useCallback(
    (next: number | null) => setScrub((prev) => {
      if (next === null) return prev === null ? prev : null;
      return prev !== null && prev.index === next && prev.length === length ? prev : { index: next, length };
    }),
    [length],
  );
  // 행 수가 바뀌면 렌더 중에 바로 지웁니다(React가 이 컴포넌트를 곧바로 다시 그림 — 효과로 지우면 한 번은 예전 순번이 보임).
  if (scrub !== null && scrub.length !== length) {
    setScrub(null);
  }
  const index = scrub !== null && scrub.length === length ? scrubIndex(scrub.index, length) : null;
  return { index, onScrub };
}
