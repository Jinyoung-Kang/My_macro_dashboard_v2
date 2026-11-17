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

/**
 * 수집기가 일부러 티커를 붙이지 않은 13F 보유의 까닭(저장본·포트폴리오 응답의 tickerNote — collector/app/equities.py의 NOTE_DEBT·NOTE_NON_COMMON)
 * → 종목 팝업의 경고 글. 회사 이름은 알지만 그 줄이 보통주가 아니라서 뺀 것이라, 공시 이름으로 찾아 고른 종목의 주가가 그 줄의 값과 다르다는 것을
 * 알립니다. 까닭이 없으면 null, 모르는 까닭이면 그 값을 그대로 적은 일반 경고(새 까닭이 생겨도 조용히 빠지지 않게).
 */
export function tickerNoteWarning(note: string | null | undefined): string | null {
  const code = (note ?? "").trim();
  if (!code) return null;
  if (code === "debt") return "이 줄은 채권(사채·전환사채 등)이라 아래 종목의 주가와 값이 다릅니다.";
  if (code === "non_common") return "이 줄은 보통주가 아닌 증권(우선주·워런트 등)이라 아래 종목(보통주)의 주가와 값이 다릅니다.";
  return `수집기가 일부러 티커를 붙이지 않은 줄입니다(${code}) — 아래 종목의 주가와 값이 다를 수 있습니다.`;
}
