import type { ReactNode } from "react";
import { FOCUS_RING, TEXT_TARGET } from "@/components/ui";
import { ChevronDownIcon } from "@/components/ui/icons";

/**
 * 보안 공지 상세의 접기(패치됨·무관 판정 줄, 공지 본문) — 처음에 접어 둡니다(매크로 해석 기준표 CriteriaDetails와 같은 꼴: 펼치기 머리는 글 + 아래 화살표,
 * 펼치면 뒤집힘, 좁은 화면 누름 자리 44px·넓은 화면 글 높이). 접힌 동안 안의 표는 DOM에 있지만 그려지지 않습니다 — 접힌 것에만 두는 뜻이 없게, 건수는 머리 글이
 * 늘 말합니다('패치됨 3개').
 */
export function Fold({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="group min-w-0">
      <summary
        className={`${TEXT_TARGET} w-fit cursor-pointer list-none gap-1 rounded-sm text-sm font-semibold text-text-2 hover:text-text [&::-webkit-details-marker]:hidden ${FOCUS_RING}`}
      >
        {summary}
        <ChevronDownIcon size={14} className="motion-safe:transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2 min-w-0">{children}</div>
    </details>
  );
}
