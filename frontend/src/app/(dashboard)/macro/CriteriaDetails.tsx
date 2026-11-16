import type { ReactNode } from "react";
import { FOCUS_RING, TEXT_TARGET } from "@/components/ui";
import { ChevronDownIcon } from "@/components/ui/icons";

/**
 * 해석 기준표 접기 — 매크로 화면의 참고 표(장단기 금리차·신용·변동성 해석 기준)는 처음에 접어 둡니다(실행 명세 §9-10 — 긴 화면은 기본 접힘으로
 * DOM과 스크롤을 줄임). 펼치기 머리는 표 이름 글 + 아래 화살표(펼치면 뒤집힘), 좁은 화면(lg 미만) 누름 자리 44px(TEXT_TARGET)·넓은 화면 글 높이.
 * 접힌 동안에도 표는 DOM에 있어 찾기·낭독기 탐색에서 빠지지 않습니다(브라우저 기본 동작 — details).
 */
export function CriteriaDetails({ summary, children }: { summary: string; children: ReactNode }) {
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
