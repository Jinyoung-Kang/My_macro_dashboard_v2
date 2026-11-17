import { EMPTY } from "@/lib/format";
import { presentText } from "@/lib/patterns";

/**
 * 값 없음 — "—"(EMPTY)와, 있으면 사유를 작은 글자로. 0으로 채우지 않습니다(PRINCIPLES "없는 숫자를 만들지 않는다").
 * 사유가 비었거나 "N/A"면 사유를 붙이지 않습니다(`presentText` — 배지의 사유와 같은 규칙).
 *
 * - "—"는 읽어 주기에서 빼고(aria-hidden) 대신 "값 없음"을 읽습니다. 기호만 읽으면 뜻이 전해지지 않습니다.
 * - 크기·색은 놓인 자리(타일·히어로·표 칸)를 따릅니다. 사유만 늘 작은 보조 글자입니다.
 * - 바깥 span은 `relative`입니다 — 안의 sr-only(절대 위치)가 가로 스크롤 상자(DataTable) 밖으로 빠져 문서 폭을 넓히지 않게. 그러지 않으면
 *   390px에서 넘겨야 보이는 칸의 "값 없음"이 페이지 전체를 가로로 넘치게 했습니다(한국 종목 선정 표, 화면 확인 2026-10-29).
 * - `align="end"`는 오른쪽 맞춤 숫자 칸(표의 `align: "right"` 열)용 — "—"와 사유가 칸 폭보다 넓어 줄을 꺾으면 꺾인 상자가 칸 폭을 다 차지하고
 *   항목이 시작(왼쪽)부터 놓여, 같은 열의 숫자보다 41~53px 왼쪽에 그려졌습니다(매크로 지표 표 수집 실패 줄 — QA-666). 끝 맞춤이면 꺾여도 각 줄이
 *   칸 오른쪽 끝에 붙습니다. 기본(시작 맞춤)은 그대로입니다(타일·속성 목록·문장 안).
 */
export function Empty({ reason, align = "start" }: { reason?: string | null; align?: "start" | "end" }) {
  const why = presentText(reason);
  return (
    <span className={`relative inline-flex flex-wrap items-baseline gap-x-1${align === "end" ? " justify-end" : ""}`}>
      <span aria-hidden="true">{EMPTY}</span>
      <span className="sr-only">값 없음</span>
      {why ? <span className="text-xs font-normal text-text-3">{why}</span> : null}
    </span>
  );
}
