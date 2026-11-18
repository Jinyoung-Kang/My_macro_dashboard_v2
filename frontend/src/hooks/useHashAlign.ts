"use client";

import { useEffect } from "react";

/** 사용자가 스스로 움직였다고 보는 입력 — 이 가운데 하나가 오면 맞춤을 그칩니다(스크롤 자체는 보지 않음 — 맞춤이 내는 스크롤과 갈리지 않아서). */
const USER_INPUTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/** 맞춤을 이어 가는 가장 긴 시간(ms) — 그 뒤로는 자료가 늦게 와 위가 자라도 따라가지 않습니다. */
export const HASH_ALIGN_MAX_MS = 10_000;

/** 주소 해시('#…' 또는 '')의 id — 비었거나 잘못된 % 꼴이면 null. */
function hashId(hash: string): string | null {
  if (hash.length <= 1) return null;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
}

/**
 * 새로 고침·바로 연 주소의 해시(#절)에 맞추기(작업대 P6 — 긴 화면 목차 SectionIndex `alignHashOnLoad`가 씀, 모의매매 프레임·설정 / P7 저장소 상태·AI 리포트).
 *
 * 브라우저의 해시 이동은 문서가 처음 그려질 때 한 번뿐이라, 셸이 그린 뒤에 생기는 닻이나 자료가 오며 자라는 위쪽 절 때문에 절 머리가 화면 밖에 남았습니다
 * (진행 기록 P5a '남긴 것' — QA-641과 같은 원인). 이 훅은 처음 그린 뒤
 * - `location.hash`의 id가 `ids`(목차 칸 — 하위 칸 포함) 가운데 하나면 그 닻으로 옮기고(scrollIntoView — 닻의 scroll-margin·스크롤 상자 위쪽 여백을 따름),
 *   닻이 아직 없으면 생길 때(MutationObserver) 옮깁니다.
 * - 닻과 그 조상의 크기가 바뀌면(ResizeObserver — 위쪽 절이 자료를 받아 자람) 다시 맞춥니다.
 * - 사용자 입력(wheel·touchstart·keydown·pointerdown)이 오거나 `HASH_ALIGN_MAX_MS`(10초)가 지나면 그칩니다 — 사용자가 움직인 자리를 빼앗지 않게.
 * 목차 밖 해시(#main 등)·해시 없는 주소에서는 아무것도 하지 않습니다. 뒤로·앞으로 가기(hashchange)는 목차가 따로 맞춥니다(SectionIndex — QA-659).
 */
export function useHashAlign(ids: readonly string[], enabled: boolean): void {
  // 배열의 참조가 그릴 때마다 바뀌어도 같은 목록이면 다시 걸지 않게 글 하나로 묶습니다(id에는 줄바꿈이 없음).
  const key = ids.join("\n");
  useEffect(() => {
    if (!enabled || key === "") return undefined;
    const id = hashId(window.location.hash);
    if (id === null || !key.split("\n").includes(id)) return undefined;

    let resizeObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;
    let stopped = false;
    const align = (): HTMLElement | null => {
      const anchor = document.getElementById(id);
      anchor?.scrollIntoView?.();
      return anchor;
    };
    const watch = (anchor: HTMLElement) => {
      if (typeof ResizeObserver !== "function") return;
      resizeObserver = new ResizeObserver(() => {
        if (!stopped) align();
      });
      // 닻과 그 조상 — 닻 위의 어느 절이 자라도 그 절을 담은 조상이 자랍니다(아래가 자라도 다시 맞출 뿐 자리는 같음).
      for (let element: HTMLElement | null = anchor; element !== null; element = element.parentElement) resizeObserver.observe(element);
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.clearTimeout(timer);
      for (const type of USER_INPUTS) window.removeEventListener(type, stop, true);
    };
    for (const type of USER_INPUTS) window.addEventListener(type, stop, { capture: true, passive: true });
    const timer = window.setTimeout(stop, HASH_ALIGN_MAX_MS);

    const anchor = align();
    if (anchor !== null) {
      watch(anchor);
    } else if (typeof MutationObserver === "function") {
      mutationObserver = new MutationObserver(() => {
        const found = align();
        if (found === null) return;
        mutationObserver?.disconnect();
        mutationObserver = null;
        watch(found);
      });
      mutationObserver.observe(document.body, { childList: true, subtree: true });
    }
    return stop;
  }, [enabled, key]);
}
