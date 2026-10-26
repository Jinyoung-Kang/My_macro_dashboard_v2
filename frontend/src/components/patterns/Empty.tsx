import { EMPTY } from "@/lib/format";
import { presentText } from "@/lib/patterns";

/**
 * 값 없음 — "—"(EMPTY)와, 있으면 사유를 작은 글자로. 0으로 채우지 않습니다(PRINCIPLES "없는 숫자를 만들지 않는다").
 * 사유가 비었거나 "N/A"면 사유를 붙이지 않습니다(`presentText` — 배지의 사유와 같은 규칙).
 *
 * - "—"는 읽어 주기에서 빼고(aria-hidden) 대신 "값 없음"을 읽습니다. 기호만 읽으면 뜻이 전해지지 않습니다.
 * - 크기·색은 놓인 자리(타일·히어로·표 칸)를 따릅니다. 사유만 늘 작은 보조 글자입니다.
 */
export function Empty({ reason }: { reason?: string | null }) {
  const why = presentText(reason);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1">
      <span aria-hidden="true">{EMPTY}</span>
      <span className="sr-only">값 없음</span>
      {why ? <span className="text-xs font-normal text-text-3">{why}</span> : null}
    </span>
  );
}
