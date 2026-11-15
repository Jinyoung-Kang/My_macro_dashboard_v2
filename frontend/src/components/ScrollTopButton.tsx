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
 * 맨 위로(TOP) 단추 — 사용자 요청(2026-11-03, 모의 매매 화면 · 2026-11-15 정보 검색). 조금 내려가면 오른쪽 아래에 나타나고, 누르면 본문과 창을
 * 모두 맨 위로 부드럽게 올립니다(움직임을 줄이는 설정이면 바로). 휴대폰에서는 아래 탭 막대 위에 둡니다.
 * lg 미만에서는 누름 자리를 44px 이상으로 둡니다(min-h-11 — ADR 0041 결정 11, QA-425). 아래 끝이 고정이라 위로 자라고 탭 막대를 덮지
 * 않습니다. 넓은 화면은 처음 높이(34px) 그대로입니다. 누르면 포커스를 본문 시작으로 옮깁니다(사라지는 단추에서 body로 떨어지지 않게 — QA-426).
 * 모양은 떠 있는 덮개(작업대 실행 명세 §3-3 3층 — surface-2 바탕·안쪽 밝은 1px 경계(border-overlay — 대화상자·토스트와 같은 토큰)·덮개 그림자, 4px 모서리)이고
 * hover는 덮개 안 hover 면(surface-3)입니다.
 *
 * 화면 아래에 붙은 고정 시트(정보 검색의 미리 보기 — xl 미만)가 열려 있으면 그 높이(문서 루트의 --bottom-sheet, hooks/useBottomSheet)만큼
 * 위로 올라갑니다 — 시트 밑에 숨은 채 Tab 차례에 남지 않게(WCAG 2.4.11, QA-420 검토). 시트가 없으면 0이라 자리는 그대로입니다.
 *
 * @param layer 층(z-index 클래스) — 기본 z-40. 화면에 같은 자리를 쓰는 고정 칸이 있으면 그보다 낮춰 덮지 않게 합니다(정보 검색은 휴대폰
 *   미리보기 서랍 z-30 아래인 z-20). 클래스 이름은 소스에 글자 그대로 적어야 Tailwind가 만듭니다.
 */
export function ScrollTopButton({ layer = "z-40" }: { layer?: string } = {}) {
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
    // 맨 위에 닿으면 이 단추는 사라집니다(400px 아래면 그리지 않음). 포커스가 body로 떨어져 다음 Tab이 화면 끝의 아래 탭 막대로 가지
    // 않게 본문 시작(main#main — 셸의 '본문으로 건너뛰기' 대상, tabIndex=-1·바깥선 없음)으로 옮깁니다(WCAG 2.4.3, QA-426). 다음 Tab은
    // 본문의 첫 대상입니다. preventScroll — 포커스가 부드러운 스크롤을 끊거나 휴대폰 창을 본문 머리(상단바 아래)로 옮기지 않게.
    document.getElementById("main")?.focus({ preventScroll: true });
  };
  return (
    // 이름은 보이는 글 'TOP'으로 시작하고 뜻을 덧붙입니다(WCAG 2.5.3 — 이름에 'TOP'이 없으면 음성 입력의 'TOP 누르기'가 단추를 찾지
    // 못함). 숨긴 글(sr-only)로 덧붙이면 그 사이 띄어쓰기를 도구마다 달리 다뤄 'TOP맨 위로'가 되기도 해서 이름을 통째로 적습니다.
    <button
      type="button"
      style={{ translate: "0 calc(-1 * var(--bottom-sheet, 0px))" }}
      onClick={toTop}
      aria-label="TOP 맨 위로"
      className={`fixed bottom-[calc(64px+1rem+env(safe-area-inset-bottom))] right-4 ${layer} inline-flex min-h-11 items-center justify-center gap-1 rounded-control border border-border-overlay bg-surface-2 px-3 py-2 text-xs font-semibold text-text shadow-overlay hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:bottom-6 lg:right-6 lg:min-h-0`}
    >
      <ChevronUpIcon size={14} />
      TOP
    </button>
  );
}
