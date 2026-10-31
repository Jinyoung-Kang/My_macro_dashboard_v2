/**
 * 13F 기관 이름과 보유 변화(직전 분기 대비)의 표기 — React를 모르는 순수 함수(ADR 0004).
 *
 * 기관 이름은 백엔드·수집기 목록이 앞에 국기를 붙여 내려 줍니다('🇺🇸 버크셔 해서웨이 (Berkshire Hathaway)'). 그 이름은 Claude
 * 패킷·알림 원문에도 쓰여 서버에서는 그대로 두고(명세 §8-4), 화면에서만 뗍니다.
 *
 * 백엔드(HoldingsDiff)는 변화를 '신규 매수 (New)'·'전량 매도 (Closed)'·'비중 확대 (Added)'·'비중 축소 (Reduced)'·
 * '유지 (Unchanged)'·'비교 데이터 없음'·'비교 불가 (주식 수 없음)' 글로 내려 줍니다. 예전 문구와 저장본에는 앞에 그림 문자가
 * 붙어 있어 화면에서 떼고, 종류는 글로 알아봅니다(기호에 기대지 않음 — 서버가 기호를 빼도 같은 결과).
 */
import { EMPTY, withoutLeadingIcon } from "./format";

/** 화면에 쓸 기관 이름 — 국기·그림 문자를 뗀 글. 이름이 없거나 기호뿐이면 null(부르는 쪽이 CIK 등으로 대신, 지어내지 않음). */
export function filerName(name: string | null | undefined): string | null {
  return withoutLeadingIcon(name ?? "") || null;
}

/**
 * 좁은 칸(교집합의 보유 기관 목록 배지)에 쓰는 짧은 이름 — 국기를 뗀 이름의 첫 낱말('국민연금 (National …)' → '국민연금').
 * 예전에는 국기가 붙은 이름의 첫 낱말이라 국기만 남았습니다. 이름이 비면 받은 글 그대로.
 */
export function filerShortName(name: string): string {
  return (filerName(name) ?? name).split(" ")[0] ?? name;
}

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
