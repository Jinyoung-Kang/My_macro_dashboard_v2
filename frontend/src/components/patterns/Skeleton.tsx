import { skeletonLineCount } from "@/lib/patterns";

/**
 * 불러오는 중 자리표시 — 값이 아직 없을 때만 씁니다(값이 있으면 다시 읽는 동안에도 값을 그대로 둠).
 *
 * - `height`(px)를 주면 그 높이의 블록(차트·카드 자리), `lines`는 글 줄 수. 둘 다 없으면 3줄.
 * - role="status" + aria-busy, 읽어 주는 글은 `label`(기본 "불러오는 중"). 막대는 읽어 주기에서 뺍니다.
 * - 깜빡임은 motion-safe에서만 — prefers-reduced-motion이면 멈춘 막대입니다.
 * - 막대 바탕은 놓인 면보다 한 단계 위 면(bg-control-fill — 패널·바탕 위 surface-2, 덮개 안[data-overlay] surface-3)입니다. surface-2로 고정하면
 *   덮개(대화상자 — 바탕 surface-2) 안에서 막대가 바탕과 같은 색(1.00:1)이 됐습니다. 고대비(forced-colors) 모드에서는 바탕색이 지워져 막대가 통째로
 *   사라지므로 그 모드에서만 1px 테두리를 둡니다(명세 D9 — 낭독기는 role=status 이름으로 읽음, 눈으로 보는 표시가 남게).
 * - `inline`이면 글줄 안에 두는 짧은 막대 하나입니다(span만 — 머리 줄의 '읽지 않음 N건'처럼 글 사이의 수 자리, QA-605). 12×24px 막대를 글줄 가운데에
 *   맞춰 text-xs(16px) 글줄 높이를 바꾸지 않고, 바깥 상자(div·py-1)를 두지 않아 글 요소 안에 넣어도 됩니다. `lines`·`height`는 보지 않습니다.
 */
export function Skeleton({ lines, height, label = "불러오는 중", inline = false }: { lines?: number; height?: number; label?: string; inline?: boolean }) {
  if (inline) {
    return (
      // relative — 안의 sr-only(절대 위치)가 가로 스크롤 상자 밖으로 빠져 문서 폭을 넓히지 않게(Empty와 같은 까닭).
      <span role="status" aria-busy="true" aria-label={label} className="relative inline-block align-middle">
        <span className="sr-only">{label}</span>
        <span aria-hidden="true" className="block h-3 w-6 rounded-control bg-control-fill motion-safe:animate-pulse forced-colors:border" />
      </span>
    );
  }
  const count = skeletonLineCount(lines, height);
  return (
    <div role="status" aria-busy="true" aria-label={label} className="flex flex-col gap-2 py-1">
      <span className="sr-only">{label}</span>
      {height !== undefined && height > 0 ? (
        <div aria-hidden="true" className="w-full rounded-control bg-control-fill motion-safe:animate-pulse forced-colors:border" style={{ height }} />
      ) : null}
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          aria-hidden="true"
          // 마지막 줄을 짧게 — 글 문단처럼 보이게. 모서리는 4px(rounded-full은 상태 점·토글 손잡이·아바타만 — 작업대 실행 명세 §3-8).
          className={`h-3.5 rounded-control bg-control-fill motion-safe:animate-pulse forced-colors:border ${count > 1 && index === count - 1 ? "w-3/5" : "w-full"}`}
        />
      ))}
    </div>
  );
}
