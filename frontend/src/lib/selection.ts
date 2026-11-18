/**
 * "비우면 전체" 식의 다중 선택(13F 교집합의 기관 필터).
 *
 * 저장하는 값은 `selected`(빈 목록 = 전체)이고, 화면과 요청은 **유효 선택**(effectiveSelection)을 씁니다.
 * 예전에는 화면이 `selected`를 그대로 하이라이트해 "아무것도 선택 안 됨"으로 보이는데 요청은 전체였고,
 * 하나를 누르면 그 기관 하나만 남아 교집합이 사라졌습니다(QA-003). 전체가 켜진 상태에서 시작해 빼는 쪽이
 * 눈에 보이는 것과 실제가 같습니다.
 */
export function effectiveSelection(all: string[], selected: string[]): string[] {
  return selected.length > 0 ? selected : all;
}

/** 하나를 토글합니다. 결과가 전체와 같으면 빈 목록("전체")으로 돌아갑니다. 마지막 하나를 빼면 전체가 됩니다. */
export function toggleSelection(all: string[], selected: string[], key: string): string[] {
  const current = effectiveSelection(all, selected);
  const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
  if (next.length === 0 || next.length >= all.length) {
    return [];
  }
  return all.filter((item) => next.includes(item));   // 원래 순서 유지
}
