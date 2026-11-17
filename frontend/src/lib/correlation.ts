/** 상관계수의 세기를 말로 옮깁니다. 숫자만 보면 0.35가 큰지 작은지 알기 어렵습니다. */
export function correlationStrength(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "계산할 수 없습니다.";
  }
  const magnitude = Math.abs(value);
  const direction = value > 0 ? "같은 방향" : "반대 방향";
  if (magnitude < 0.2) {
    return "거의 무관합니다.";
  }
  if (magnitude < 0.4) {
    return `약하게 ${direction}으로 움직였습니다.`;
  }
  if (magnitude < 0.6) {
    return `어느 정도 ${direction}으로 움직였습니다.`;
  }
  return `뚜렷하게 ${direction}으로 움직였습니다.`;
}

/**
 * 상관계수가 추정치인가 — 두 계열 가운데 하나라도 추정치로 읽었으면(응답 x·y의 isEstimated) 그 상관계수도 추정치입니다(QA-634).
 * 화면은 상관계수 옆에 '추정' 배지를 늘 보입니다(PRINCIPLES '추정치는 isEstimated와 함께').
 */
export function correlationEstimated(pair: { x?: { isEstimated?: boolean } | null; y?: { isEstimated?: boolean } | null } | null | undefined): boolean {
  return Boolean(pair?.x?.isEstimated || pair?.y?.isEstimated);
}
