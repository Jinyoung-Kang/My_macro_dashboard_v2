import type { JSX } from "react";

import { sparklineSegments } from "@/lib/patternRows";

// 선 색은 원래 변수 이름으로 — `--color-*`는 CSS에 출력되지 않습니다. 속성이 아니라 style로 넘겨 어느 브라우저에서나 var()가 풀리게 합니다.
const STROKE = "var(--text-2)";

/**
 * 스파크라인 — 축·눈금 없는 작은 추이 선. 판정을 전하지 않고 모양만 보입니다(값·변화는 옆의 글자가 전함).
 *
 * - 알려진 점이 2개 미만이면 그리지 않습니다(null). 값이 없는 자리에서 선을 끊고, 혼자 남은 점은 작은 점으로 찍습니다.
 * - Y 범위는 데이터 범위(`valueDomain`) — 0을 억지로 넣지 않습니다. 색은 상승·하락과 무관한 보조 글자색입니다.
 * - 기본은 읽어 주기에서 뺍니다(aria-hidden). `label`을 주면 role="img" + 그 이름으로 읽힙니다.
 */
export function Sparkline({
  values,
  width = 80,
  height = 24,
  label,
}: {
  values: readonly (number | null)[];
  width?: number;
  height?: number;
  label?: string;
}): JSX.Element | null {
  const segments = sparklineSegments(values, width, height);
  if (segments === null) {
    return null;
  }
  const name = label?.trim() || undefined;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={name ? "img" : undefined}
      aria-label={name}
      aria-hidden={name ? undefined : true}
      focusable="false"
      className="block shrink-0"
    >
      {segments.map((segment, index) =>
        segment.length === 1 ? (
          <circle key={index} cx={segment[0].x} cy={segment[0].y} r={1.5} style={{ fill: STROKE }} />
        ) : (
          <polyline
            key={index}
            points={segment.map((point) => `${point.x},${point.y}`).join(" ")}
            fill="none"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ stroke: STROKE }}
          />
        ),
      )}
    </svg>
  );
}
