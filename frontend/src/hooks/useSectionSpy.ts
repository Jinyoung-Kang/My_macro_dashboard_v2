"use client";

import { useEffect, useState } from "react";

import { pickActiveSection } from "@/lib/sectionIndex";

/** 지금 절을 보는 띠 — 뷰포트 위쪽 34%(아래 66%를 뺌). 띠에 조금이라도 걸친 절이 후보입니다. */
const SPY_ROOT_MARGIN = "0px 0px -66% 0px";

/**
 * 긴 화면 목차(components/patterns/SectionIndex)의 지금 절 — 절 닻(id)들이 화면 위쪽 띠에 걸치는지 IntersectionObserver(root 뷰포트)로 보고,
 * 고르는 차례(`ids` — lib/sectionIndex `sectionOrder`, 하위 칸이 부모보다 앞)로 하나를 고릅니다(`pickActiveSection`). 걸친 절이 없으면 앞 값을 둡니다.
 *
 * - root는 뷰포트입니다 — 넓은 화면은 본문(main)이 스크롤 상자이고 좁은 화면은 창이 스크롤하지만, 뷰포트 기준 교차는 두 경우 모두 맞습니다.
 * - `enabled`가 거짓이거나 IntersectionObserver가 없으면(서버·jsdom) null — 목차는 지금 칸 없이 그립니다.
 * - 닻은 이 훅을 부르는 부품보다 먼저 그려져 있어야 합니다(목차의 자식 — 효과는 자식부터 돎). `ids`가 바뀌면(운영자만 보이는 절 등) 다시 봅니다.
 */
export function useSectionSpy(ids: readonly string[], enabled = true): string | null {
  const [active, setActive] = useState<string | null>(null);
  // 배열의 참조가 그릴 때마다 바뀌어도 같은 목록이면 다시 관찰하지 않게 글 하나로 묶습니다(id에는 줄바꿈이 없음).
  const key = ids.join("\n");
  useEffect(() => {
    if (!enabled || typeof IntersectionObserver !== "function") return undefined;
    const order = key === "" ? [] : key.split("\n");
    const intersecting = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).id;
          if (entry.isIntersecting) intersecting.add(id);
          else intersecting.delete(id);
        }
        setActive((previous) => pickActiveSection(order, intersecting, previous));
      },
      { root: null, rootMargin: SPY_ROOT_MARGIN },
    );
    for (const id of order) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [key, enabled]);
  return enabled ? active : null;
}
