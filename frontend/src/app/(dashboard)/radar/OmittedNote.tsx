import { EMPTY } from "@/lib/format";

/** 금액을 몰라 차트에서 뺀 종목 수. 표에는 그대로 "—"로 남아 있습니다. */
export function OmittedNote({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <p className="mt-2 text-xs text-text-3">
      금액을 모르는 {count}개 종목은 차트에서 뺐습니다(아래 표에 &quot;{EMPTY}&quot;로 표시).
    </p>
  );
}
