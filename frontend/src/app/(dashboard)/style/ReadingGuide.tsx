import type { ReactNode } from "react";
import { FOCUS_RING, TEXT_TARGET } from "@/components/ui";
import { ChevronDownIcon } from "@/components/ui/icons";

/**
 * '읽는 법' 접기 — 패널 아래의 긴 설명 문단(유효 종목 수·회전율, 겹침 비중·코사인, 위험 기여)을 처음에 접어 둡니다(실행 명세 §1 — 긴 설명 문단은
 * 접기로, 글은 그대로). 펼치기 머리는 보이는 글 '읽는 법' + 아래 화살표(펼치면 뒤집힘), 좁은 화면(lg 미만) 누름 자리 44px(TEXT_TARGET)·넓은 화면 글
 * 높이. 한 화면에 셋이라 낭독기에는 무엇의 읽는 법인지(`topic`)를 덧붙여 읽힙니다 — 보이는 글이 이름의 앞에 그대로 있습니다(WCAG 2.5.3).
 * 접힌 동안 글은 DOM에 있지만 그려지지 않아 접근성 트리에서도 빠집니다. 그래서 접힌 글에만 두는 뜻이 없어야 합니다 — 값과 그 한계는 표·안내 상자가 늘
 * 보이게 말합니다(모르는 회전율은 표 칸의 '— 직전 분기 없음' — QA-719, 커버리지는 위험 패널의 안내 상자).
 */
export function ReadingGuide({ topic, children }: { topic: string; children: ReactNode }) {
  return (
    <details className="group mt-3 min-w-0">
      <summary
        className={`${TEXT_TARGET} w-fit cursor-pointer list-none gap-1 rounded-sm text-caption font-medium text-text-2 hover:text-text [&::-webkit-details-marker]:hidden ${FOCUS_RING}`}
      >
        읽는 법<span className="sr-only"> — {topic}</span>
        <ChevronDownIcon size={14} className="motion-safe:transition-transform group-open:rotate-180" />
      </summary>
      <p className="mt-1 max-w-[72ch] text-xs leading-relaxed text-text-3">{children}</p>
    </details>
  );
}
