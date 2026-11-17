import type { ReactNode } from "react";
import { FOCUS_RING, TEXT_TARGET } from "@/components/ui";
import { ChevronDownIcon } from "@/components/ui/icons";

/**
 * 해석 기준표 접기 — 매크로 화면의 참고 표(장단기 금리차·신용·변동성 해석 기준)는 처음에 접어 둡니다(실행 명세 §9-10 — 긴 화면은 기본 접힘으로
 * DOM과 스크롤을 줄임). 펼치기 머리는 표 이름 글 + 아래 화살표(펼치면 뒤집힘), 좁은 화면(lg 미만) 누름 자리 44px(TEXT_TARGET)·넓은 화면 글 높이.
 * 접힌 동안 표는 DOM에 있지만 그려지지 않아 접근성 트리에서도 빠집니다 — 낭독기 가상 커서로는 닿지 않고, 펼침 상태를 알리는 요약 단추(표 이름)로 펼칩니다.
 * 브라우저 찾기는 크롬이 찾은 곳을 저절로 펼쳐 닿습니다. 그래서 접힌 표 안에만 두는 뜻이 없어야 합니다 — 두 해석 기준표는 참고표이고, 역전 경고는 금리차
 * 패널의 안내 상자가 따로 말합니다.
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
