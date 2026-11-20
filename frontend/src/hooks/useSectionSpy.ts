"use client";

import { useEffect, useState } from "react";

import { pickActiveSection, pickEndSection, scrolledToEnd, sectionsBelowBand } from "@/lib/sectionIndex";

/**
 * 지금 절을 보는 띠 — 뷰포트 위 96px 아래부터 위쪽 34%까지(아래 66%를 뺌). 띠에 조금이라도 걸친 절이 후보입니다.
 * 위 96px을 빼는 까닭: 목차 칸을 눌러 절로 옮기면(스크롤 상자의 위쪽 여백 = 가로 줄 높이(QA-643) + 절 닻의 scroll-margin 12px) 앞 절의 꼬리가 위에 붙은
 * 상단바(넓은 화면 48px)·가로 목차 줄(좁은 화면 44px·넓은 화면 30px) 밑에 가려진 채 남는데, 띠가 0px부터면 그 꼬리가 걸려 차례가 앞인 앞 절이 지금 절로
 * 골렸습니다(QA-626 — 390은 앞 절 꼬리 ~40px, 1024는 ~80px까지). 옮긴 절의 위 끝(약 57·91px — 1440 세로 목록 64px)은 아래로 길게 이어져 띠에 걸립니다.
 */
const SPY_ROOT_MARGIN = "-96px 0px -66% 0px";

/**
 * 긴 화면 목차(components/patterns/SectionIndex)의 지금 절 — 절 닻(id)들이 화면 위쪽 띠(SPY_ROOT_MARGIN)에 걸치는지 IntersectionObserver(root 뷰포트)로 보고,
 * 고르는 차례(`ids` — lib/sectionIndex `sectionOrder`, 하위 칸이 부모보다 앞)로 하나를 고릅니다(`pickActiveSection`). 걸친 절이 없으면 앞 값을 두되, 모든 절이
 * 띠 아래면(첫 절에 닿기 전 — 화면 맨 위) 처음 연 화면처럼 null입니다(QA-968 — 뒤로 가기로 맨 위에 와도 옮긴 절이 남았음).
 *
 * - root는 뷰포트입니다 — 넓은 화면은 본문(main)이 스크롤 상자이고 좁은 화면은 창이 스크롤하지만, 뷰포트 기준 교차는 두 경우 모두 맞습니다.
 * - 닻을 담은 스크롤 상자(창 또는 main — 문서의 scroll 이벤트를 capture로 받아 그 상자가 닻을 담는지 봄)가 끝까지 내려가 있으면 띠 대신 위 끝이 화면 안인
 *   마지막 절을 고릅니다(`pickEndSection` — 마지막 절은 페이지가 더 내려가지 못해 띠에 닿지 못함, QA-645). 끝에서 벗어나면 다시 띠로 고릅니다.
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
    // 스크롤 상자가 끝이면 그때 고른 절(아니면 null — 띠로 고름).
    let endPick: string | null = null;
    // 띠에 걸친 절이 없을 때 모든 절이 띠 아래인가(첫 절에 닿기 전 — 화면 맨 위) — 그때는 앞 값이 아니라 처음 연 화면처럼 지금 칸 없음(QA-968).
    const aboveAll = () =>
      intersecting.size === 0 &&
      sectionsBelowBand(
        order.map((id) => document.getElementById(id)?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY),
        window.innerHeight,
      );
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).id;
          if (entry.isIntersecting) intersecting.add(id);
          else intersecting.delete(id);
        }
        setActive((previous) => endPick ?? pickActiveSection(order, intersecting, previous, aboveAll()));
      },
      { root: null, rootMargin: SPY_ROOT_MARGIN },
    );
    for (const id of order) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    const onScroll = (event: Event) => {
      // 창 스크롤은 문서(document)가, 본문 상자 스크롤은 그 요소가 대상입니다. 닻을 담지 않은 상자(표의 가로 스크롤 등)는 보지 않습니다.
      const box = event.target instanceof Element ? event.target : (document.scrollingElement ?? document.documentElement);
      const first = order.length > 0 ? document.getElementById(order[0]) : null;
      if (first === null || !box.contains(first)) return;
      const next = scrolledToEnd(box)
        ? pickEndSection(
            order.map((id) => ({ id, top: document.getElementById(id)?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY })),
            window.innerHeight,
          )
        : null;
      if (next === endPick) return;
      endPick = next;
      setActive((previous) => next ?? pickActiveSection(order, intersecting, previous, aboveAll()));
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      observer.disconnect();
      document.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [key, enabled]);
  return enabled ? active : null;
}
