"use client";

import { useEffect, useState } from "react";
import { ChevronUpIcon } from "@/components/ui/icons";

/** 이만큼 내려가면 단추가 보입니다(px). */
export const SCROLL_TOP_THRESHOLD = 400;

/** 지금 스크롤하는 곳들 — 넓은 화면은 본문(main#main, lg:overflow-y-auto), 휴대폰은 창(components/shell/Shell). */
function scrollers(): (Window | HTMLElement)[] {
  const main = document.getElementById("main");
  return main ? [window, main] : [window];
}

function offset(target: Window | HTMLElement): number {
  return target === window ? window.scrollY : (target as HTMLElement).scrollTop;
}

/**
 * 맨 위로(TOP) 단추 — 사용자 요청(2026-11-03, 모의 매매 화면). 조금 내려가면 오른쪽 아래에 나타나고, 누르면 본문과 창을 모두 맨 위로 부드럽게
 * 올립니다(움직임을 줄이는 설정이면 바로). 휴대폰에서는 아래 탭 막대 위에 둡니다.
 */
export function ScrollTopButton() {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const targets = scrollers();
    const update = () => setShown(targets.some((target) => offset(target) > SCROLL_TOP_THRESHOLD));
    targets.forEach((target) => target.addEventListener("scroll", update, { passive: true }));
    update();
    return () => targets.forEach((target) => target.removeEventListener("scroll", update));
  }, []);

  if (!shown) return null;
  const toTop = () => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    scrollers().forEach((target) => target.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" }));
  };
  return (
    <button
      type="button"
      onClick={toTop}
      aria-label="맨 위로"
      className="fixed bottom-[calc(64px+1rem+env(safe-area-inset-bottom))] right-4 z-40 inline-flex items-center gap-1 rounded-full border border-border bg-surface px-3 py-2 text-xs font-semibold text-bright shadow-lg hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:bottom-6 lg:right-6"
    >
      <ChevronUpIcon size={14} />
      TOP
    </button>
  );
}
