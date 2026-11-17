"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { ChevronUpIcon } from "@/components/ui/icons";

/** 이만큼 내려가면 단추가 보입니다(px). */
export const SCROLL_TOP_THRESHOLD = 400;

/**
 * 문서 루트(html)에 적는 CSS 변수 — TOP 단추가 있는 화면에서 셸 본문(main#main)의 아래 여백에 더할 단추 자리. lg 미만은 앞의 것, lg 이상은 뒤의 것을
 * 셸이 읽습니다(components/shell/Shell — Tailwind가 찾도록 거기에는 이름을 글자 그대로 적음). 단추가 없는 화면은 지워져 0px입니다.
 */
export const SCROLL_TOP_RESERVE_VAR = "--scroll-top-reserve";
export const SCROLL_TOP_RESERVE_LG_VAR = "--scroll-top-reserve-lg";
/**
 * 단추 자리 — 단추 높이 + 틈 8px를 단추와 같은 단위로 적은 식(기본 글자 크기 16px에서 52·38px). 단추 높이는 rem이라 브라우저 기본 글자 크기를 키우면
 * 함께 자라므로 px 상수로 적으면 다시 가립니다(QA-686 보강 — 20px이면 3px, 24px이면 14px). 아래 단추 클래스와 짝입니다(바꾸면 함께):
 * lg 미만은 min-h-11(2.75rem)이 내용 높이(경계 2px + py-2 1rem + text-xs 줄 높이 1rem)보다 늘 커서 2.75rem, lg는 lg:min-h-[30px]와 내용 높이(경계 2px +
 * lg:py-1 0.5rem + 줄 높이 1rem — 아이콘 14px는 줄 높이 안) 가운데 큰 것.
 */
export const SCROLL_TOP_RESERVE = { narrow: "calc(2.75rem + 8px)", wide: "calc(max(30px, 1.5rem + 2px) + 8px)" } as const;

/** 단추 자리를 세워 둔 단추 수 — 화면이 바뀌는 사이 둘이 겹쳐 마운트돼도 마지막 하나가 떠날 때만 지웁니다. */
let reserveHolders = 0;

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
 * 않습니다. 넓은 화면은 기본 조작 높이 30px입니다(명세 §3-7 높이 단계 — 처음 높이 34px는 단계 밖이었음, 2026-11-16 검토 지적).
 * 누르면 포커스를 본문 시작으로 옮깁니다(사라지는 단추에서 body로 떨어지지 않게 — QA-426).
 * 모양은 떠 있는 덮개(작업대 실행 명세 §3-3 3층 — surface-2 바탕·안쪽 밝은 1px 경계(border-overlay — 대화상자·토스트와 같은 토큰)·덮개 그림자, 4px 모서리)이고
 * hover는 덮개 안 hover 면(surface-3)입니다.
 *
 * 화면 아래에 붙은 고정 시트(정보 검색의 미리 보기 — xl 미만)가 열려 있으면 그 높이(문서 루트의 --bottom-sheet, hooks/useBottomSheet)만큼
 * 위로 올라갑니다 — 시트 밑에 숨은 채 Tab 차례에 남지 않게(WCAG 2.4.11, QA-420 검토). 시트가 없으면 0이라 자리는 그대로입니다.
 *
 * 셸 본문의 아래 여백은 아래 탭 막대와의 틈만 두므로, 단추가 같은 자리에서 위로 솟아 맨 아래까지 내려도 본문 마지막 글을 가렸습니다(QA-686 — 390
 * /macro·/paper·/info). 그래서 마운트되는 동안 문서 루트에 단추 자리(SCROLL_TOP_RESERVE_VAR)를 세워 셸 본문이 그만큼 아래 여백을 더하게 합니다.
 * 보일 때가 아니라 마운트될 때 세웁니다 — 보일 때 세우면 400px를 지나는 스크롤 도중에 본문 높이가 바뀝니다. 시트가 열린 정보 검색은 시트 높이만큼
 * 결과 아래 여백이 따로 있고(FeedPanel) 단추도 그만큼 올라가므로 단추 자리는 한 번만 셉니다. 스크롤 여백(globals.css scroll-padding-bottom)에는
 * 더하지 않았습니다 — 그 여백은 폭 전체를 덮는 탭 막대·시트를 위한 것이고, 더하려면 시트가 열렸을 때의 단추 띠(min(시트 높이, 64px))와 한 번만 세게
 * 묶고 정보 검색의 보이는 자리 경계(FeedPanel rowOutsideView)도 함께 바꿔야 해 이 좁은 고침에서 뺐습니다(본문 중간에서 오른쪽 구석의 작은 포커스
 * 요소를 단추가 가릴 수 있는 것은 남은 일 — 작업대 진행 기록).
 *
 * @param layer 층(z-index 클래스) — 기본 z-40. 화면에 같은 자리를 쓰는 고정 칸이 있으면 그보다 낮춰 덮지 않게 합니다(정보 검색은 휴대폰
 *   미리보기 서랍 z-30 아래인 z-20). 클래스 이름은 소스에 글자 그대로 적어야 Tailwind가 만듭니다.
 */
export function ScrollTopButton({ layer = "z-40" }: { layer?: string } = {}) {
  const [shown, setShown] = useState(false);

  // 단추 자리(위 설명) — 그리기 전에 세워 첫 그림·스크롤 복원 때부터 본문 끝 여백이 맞게 합니다.
  useLayoutEffect(() => {
    const root = document.documentElement;
    reserveHolders += 1;
    root.style.setProperty(SCROLL_TOP_RESERVE_VAR, SCROLL_TOP_RESERVE.narrow);
    root.style.setProperty(SCROLL_TOP_RESERVE_LG_VAR, SCROLL_TOP_RESERVE.wide);
    return () => {
      reserveHolders -= 1;
      if (reserveHolders > 0) return;
      root.style.removeProperty(SCROLL_TOP_RESERVE_VAR);
      root.style.removeProperty(SCROLL_TOP_RESERVE_LG_VAR);
    };
  }, []);

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
      className={`fixed bottom-[calc(64px+1rem+env(safe-area-inset-bottom))] right-4 ${layer} inline-flex min-h-11 items-center justify-center gap-1 rounded-control border border-border-overlay bg-surface-2 px-3 py-2 text-xs font-semibold text-text shadow-overlay hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:bottom-6 lg:right-6 lg:min-h-[30px] lg:py-1`}
    >
      <ChevronUpIcon size={14} />
      TOP
    </button>
  );
}
