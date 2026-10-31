/**
 * 13F 보유 변화(직전 분기 대비)의 표기 — React를 모르는 순수 함수(ADR 0004).
 *
 * 백엔드(HoldingsDiff)는 변화를 '신규 매수 (New)'·'전량 매도 (Closed)'·'비중 확대 (Added)'·'비중 축소 (Reduced)'·
 * '유지 (Unchanged)'·'비교 데이터 없음'·'비교 불가 (주식 수 없음)' 글로 내려 줍니다. 예전 문구와 저장본에는 앞에 그림 문자가
 * 붙어 있어 화면에서 떼고, 종류는 글로 알아봅니다(기호에 기대지 않음 — 서버가 기호를 빼도 같은 결과).
 */
import { EMPTY, withoutLeadingIcon } from "./format";

/** new 신규 · closed 전량 매도 · added 확대 · reduced 축소 · unchanged 유지 · none 비교할 수 없음(직전 분기 없음 등). */
export type HoldingActionKind = "new" | "closed" | "added" | "reduced" | "unchanged" | "none";

/** 화면 표기 — 글(기호 없음)과 종류(아이콘 고르기). 글을 모르면 '—'(종류 none). */
export function holdingActionView(label: string | null | undefined): { kind: HoldingActionKind; text: string } {
  const text = withoutLeadingIcon(label ?? "");
  if (!text) return { kind: "none", text: EMPTY };
  return { kind: kindOf(text), text };
}

function kindOf(text: string): HoldingActionKind {
  if (/전량 매도|\(Closed\)/i.test(text)) return "closed";
  if (/신규|\(New\)/i.test(text)) return "new";
  if (/확대|\(Added\)/i.test(text)) return "added";
  if (/축소|\(Reduced\)/i.test(text)) return "reduced";
  if (/유지|\(Unchanged\)/i.test(text)) return "unchanged";
  return "none";
}
