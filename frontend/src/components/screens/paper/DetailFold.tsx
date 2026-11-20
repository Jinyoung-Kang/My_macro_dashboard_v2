import type { ReactNode } from "react";
import { FOCUS_RING, TEXT_TARGET } from "@/components/ui";
import { ChevronDownIcon } from "@/components/ui/icons";

/**
 * 모의매매 결정·복기 상세의 접기(원본 JSON·모델 응답 원문·입력 패킷·한국 후보 표·사건 패킷 글) — 테두리 상자 안의 펼치기 머리와 내용. 처음에는 접혀 있습니다.
 *
 * 머리는 좁은 화면(lg 미만) 누름 자리 44px(TEXT_TARGET — 원칙 A8, QA-748: 예전 머리는 12px 글 높이뿐)·넓은 화면 글 높이이고, 브라우저 삼각형 대신 공용
 * 아래 화살표(펼치면 뒤집힘 — 화면 머리의 '자세히'·'읽는 법' 접기와 같은 꼴)를 글 뒤에 둡니다. 펼친 내용은 부르는 쪽이 넘깁니다(`<pre>`·표).
 */
export function DetailFold({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group rounded-control border border-border px-3 py-2 text-xs">
      <summary
        className={`${TEXT_TARGET} w-fit cursor-pointer list-none gap-1 rounded-sm text-text-3 hover:text-text-2 [&::-webkit-details-marker]:hidden ${FOCUS_RING}`}
      >
        {summary}
        <ChevronDownIcon size={14} className="motion-safe:transition-transform group-open:rotate-180" />
      </summary>
      {children}
    </details>
  );
}
