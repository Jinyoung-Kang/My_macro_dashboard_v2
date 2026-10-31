import { EMPTY, withoutLeadingIcon } from "./format";

/**
 * 연속 순매수·순매도 일수 표기. 받은 기록 전부가 같은 방향이면 실제로는 더 길 수 있어 "+"를 붙입니다.
 *
 * @param streak  양수 = 연속 순매수 일수, 음수 = 연속 순매도 일수. 모르면 undefined
 * @param records 받은 기록 수
 */
export function streakText(streak: number | null | undefined, records: number): string {
  if (!streak) return EMPTY;
  const days = Math.abs(streak);
  const label = days >= records ? `${days}일+` : `${days}일`;
  return `${label} ${streak > 0 ? "순매수" : "순매도"}`;
}

/**
 * KRX 투자주체별 선물 포지션 성향 — 수집기가 적은 글('매수 우위(Long)'·'매도 우위(Short)'·'중립'·'판정 불가')에서 앞의
 * 색 원 기호를 떼고 글만 씁니다. 색도 입히지 않습니다 — 성향은 판정이라 상승·하락 색(값의 방향)과 섞지 않습니다.
 * 수집기 문구는 AI 입력(KrPacketBuilder)이라 서버에서는 그대로 둡니다(명세 §8-4). 모르면 '—'.
 */
export function stanceText(stance: string | null | undefined): string {
  return withoutLeadingIcon(stance ?? "") || EMPTY;
}
