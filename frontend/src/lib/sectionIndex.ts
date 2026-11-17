/**
 * 긴 화면 목차(components/patterns/SectionIndex)의 순수 규칙 — 목차 항목 모양, 지금 절을 고르는 차례와 판정, 하위 칸의 부모(ADR 0004 — React를 모름).
 *
 * 지금 절은 화면 위쪽 띠(뷰포트 위 96px 아래 ~ 34% — hooks/useSectionSpy의 IntersectionObserver rootMargin)에 걸친 절 가운데 고릅니다. 하위 칸(예: 매크로 지표 절 안의
 * 범주)이 걸쳐 있으면 그 부모 절도 늘 걸쳐 있으므로, 고르는 차례(`sectionOrder`)는 하위 칸을 부모보다 앞에 둡니다 — 그래서 띠에 하위 칸이 있으면 하위 칸,
 * 부모 절의 머리(첫 하위 칸 앞)만 있으면 부모가 지금 절입니다. 형제·다른 절 사이는 문서 차례 그대로입니다.
 * 스크롤 상자가 끝까지 내려가 있으면 띠 대신 위 끝이 화면 안인 마지막 절입니다(`pickEndSection` — 마지막 절은 띠에 닿지 못함, QA-645).
 */

/** 목차 칸 하나 — id는 화면의 절 닻(SectionAnchor) id, count는 숫자일 때만 보입니다(모르면 null — 0으로 채우지 않음). */
export type SectionIndexLeaf = { id: string; label: string; count?: number | null };

/**
 * 첫 단계 목차 칸 — 하위 칸(children)은 세로 목록에서만 들여 보입니다(가로 줄은 첫 단계만). 하위 칸을 아직 모르면(자료를 읽는 중) `pendingChildren`만큼
 * 세로 목록에 글 없는 자리 줄을 둡니다(읽기에서 뺌 — 하위 칸이 온 뒤 아래 칸들이 밀리지 않게, 자리일 뿐 개수를 보이지 않음). 하위 칸이 있으면 보지 않습니다.
 */
export type SectionIndexItem = SectionIndexLeaf & { children?: readonly SectionIndexLeaf[]; pendingChildren?: number };

/**
 * 지금 절을 고르는 차례 — 첫 단계 칸마다 하위 칸(문서 차례)을 먼저, 그다음 그 칸. 예: [지표 > 범주 A·B, 환율] → [범주 A, 범주 B, 지표, 환율].
 * 같은 id가 두 번 나오면 처음 것만 둡니다.
 */
export function sectionOrder(items: readonly SectionIndexItem[]): string[] {
  const order: string[] = [];
  const push = (id: string) => {
    if (!order.includes(id)) order.push(id);
  };
  for (const item of items) {
    for (const child of item.children ?? []) push(child.id);
    push(item.id);
  }
  return order;
}

/**
 * 지금 절 — 띠에 걸친 절(`intersecting`) 가운데 고르는 차례(`order`)가 가장 앞인 것. 걸친 절이 없으면(절 사이 빈 곳·화면 끝) 앞 값을 그대로 두고,
 * 앞 값이 차례에 없으면(목차가 바뀜) null입니다.
 */
export function pickActiveSection(order: readonly string[], intersecting: ReadonlySet<string>, previous: string | null): string | null {
  const first = order.find((id) => intersecting.has(id));
  if (first !== undefined) return first;
  return previous !== null && order.includes(previous) ? previous : null;
}

/** 스크롤 상자가 끝까지 내려가 있는가 — 넘침이 있고 남은 거리가 1px 이하(소수 픽셀 스크롤). 넘침이 없으면 거짓(스크롤할 수 없는 화면). */
export function scrolledToEnd(box: { scrollTop: number; scrollHeight: number; clientHeight: number }): boolean {
  const max = box.scrollHeight - box.clientHeight;
  return max > 0 && box.scrollTop >= max - 1;
}

/**
 * 끝까지 내려갔을 때의 지금 절 — 위 끝이 뷰포트 아래 끝보다 위인(화면 안이거나 이미 지나간) 절 가운데 위 끝이 가장 아래인 것(QA-645). 마지막 절은 페이지가
 * 더 내려가지 못해 위 끝이 지금 절 띠 아래에 남으므로, 띠로는 지금 절이 될 수 없었습니다. 그런 절이 없으면 null.
 */
export function pickEndSection(tops: readonly { id: string; top: number }[], viewportHeight: number): string | null {
  let picked: { id: string; top: number } | null = null;
  for (const entry of tops) {
    if (!Number.isFinite(entry.top) || entry.top >= viewportHeight) continue;
    if (picked === null || entry.top > picked.top) picked = entry;
  }
  return picked?.id ?? null;
}

/** 하위 칸 id의 부모(첫 단계 칸) id — 첫 단계 칸이거나 목차에 없으면 null. */
export function sectionParent(items: readonly SectionIndexItem[], id: string | null): string | null {
  if (id === null) return null;
  return items.find((item) => (item.children ?? []).some((child) => child.id === id))?.id ?? null;
}

/** 목차의 개수 글 — 유한한 숫자만(0 포함, 천 단위 쉼표). null·undefined·NaN이면 null(자리를 그리지 않음). */
export function sectionCountText(count: number | null | undefined): string | null {
  return typeof count === "number" && Number.isFinite(count) ? count.toLocaleString("ko-KR") : null;
}
