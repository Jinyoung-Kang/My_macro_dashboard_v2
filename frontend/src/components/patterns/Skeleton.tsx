import { skeletonLineCount } from "@/lib/patterns";

/**
 * 불러오는 중 자리표시 — 값이 아직 없을 때만 씁니다(값이 있으면 다시 읽는 동안에도 값을 그대로 둠).
 *
 * - `height`(px)를 주면 그 높이의 블록(차트·카드 자리), `lines`는 글 줄 수. 둘 다 없으면 3줄.
 * - role="status" + aria-busy, 읽어 주는 글은 `label`(기본 "불러오는 중"). 막대는 읽어 주기에서 뺍니다.
 * - 깜빡임은 motion-safe에서만 — prefers-reduced-motion이면 멈춘 막대입니다.
 */
export function Skeleton({ lines, height, label = "불러오는 중" }: { lines?: number; height?: number; label?: string }) {
  const count = skeletonLineCount(lines, height);
  return (
    <div role="status" aria-busy="true" aria-label={label} className="flex flex-col gap-2 py-1">
      <span className="sr-only">{label}</span>
      {height !== undefined && height > 0 ? (
        <div aria-hidden="true" className="w-full rounded-xl bg-surface-2 motion-safe:animate-pulse" style={{ height }} />
      ) : null}
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          aria-hidden="true"
          // 마지막 줄을 짧게 — 글 문단처럼 보이게.
          className={`h-3.5 rounded-md bg-surface-2 motion-safe:animate-pulse ${count > 1 && index === count - 1 ? "w-3/5" : "w-full"}`}
        />
      ))}
    </div>
  );
}
