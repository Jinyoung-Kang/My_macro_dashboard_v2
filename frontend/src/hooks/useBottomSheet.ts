"use client";

import { useEffect, useState, type RefObject } from "react";

/**
 * 문서 루트(html)에 적는 CSS 변수 — 화면 아래에 붙은 고정 시트가 지금 차지한 높이(px). 시트가 없으면 지웁니다(읽는 쪽은 0px로 봄).
 * 읽는 곳: globals.css(본문·문서의 스크롤 여백 — 고른 줄·포커스가 시트 밑에 숨지 않게), ScrollTopButton(TOP 단추를 시트 위로 올림).
 * Tailwind가 클래스를 찾도록 읽는 곳은 이 이름을 글자 그대로 적습니다.
 */
export const BOTTOM_SHEET_VAR = "--bottom-sheet";

export type BottomSheetSpace = {
  /** 시트의 높이(px) — 고정 시트가 아니거나 닫혀 있으면 0. 시트를 담은 화면은 이만큼 아래 여백을 두어 끝 내용이 시트 위로 올라오게 합니다. */
  height: number;
  /** 본문(main#main — 넓은 화면의 스크롤 상자)의 세로 스크롤 막대 폭(px). 시트의 오른쪽을 이만큼 비워 스크롤 막대를 덮지 않게 합니다. */
  gutter: number;
  /**
   * 잰 때의 창 폭(window.innerWidth, px) — 고정 시트가 아니거나 닫혀 있으면 0. 창 폭이 바뀌면(휴대폰을 돌림·창 폭 조절) 줄 바꿈이 달라져
   * 시트 밖의 내용이 움직이므로, 시트를 담은 화면이 높이만 바뀐 때(휴대폰 주소 막대)와 가를 때 씁니다(QA-447).
   */
  width: number;
};

const NONE: BottomSheetSpace = { height: 0, gutter: 0, width: 0 };

/**
 * 화면 아래에 붙은 고정 시트(정보 검색의 미리 보기 — xl 미만)가 열려 있는 동안 그 높이를 재서 문서 루트의 --bottom-sheet로 적고 돌려줍니다.
 * 시트가 고정(position: fixed)이 아니면(xl의 오른쪽 칸처럼 흐름 안에 있으면) 0이고 적지 않습니다 — 고정인지는 계산된 스타일로 보므로
 * 클래스의 창 폭 경계(xl:static 등)와 늘 같습니다. 시트 크기가 바뀌거나(ResizeObserver) 창 크기가 바뀌면 다시 재고(창 폭도 함께 돌려줌),
 * 닫히거나 화면을 떠나면 지웁니다.
 */
export function useBottomSheet(ref: RefObject<HTMLElement | null>, open: boolean): BottomSheetSpace {
  const [space, setSpace] = useState<BottomSheetSpace>(NONE);

  useEffect(() => {
    const sheet = ref.current;
    if (!open || !sheet) return undefined;
    const root = document.documentElement;
    const main = document.getElementById("main");
    const measure = () => {
      const fixed = window.getComputedStyle(sheet).position === "fixed";
      const height = fixed ? Math.ceil(sheet.getBoundingClientRect().height) : 0;
      const gutter = fixed && main ? Math.max(0, main.offsetWidth - main.clientWidth) : 0;
      const width = fixed ? window.innerWidth : 0;
      if (height > 0) root.style.setProperty(BOTTOM_SHEET_VAR, `${height}px`);
      else root.style.removeProperty(BOTTOM_SHEET_VAR);
      setSpace((current) =>
        current.height === height && current.gutter === gutter && current.width === width ? current : { height, gutter, width },
      );
    };
    measure();
    // 본문도 봅니다 — 시트를 연 뒤 아래 여백이 생겨 본문에 스크롤 막대가 새로 생기면 폭이 바뀝니다.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(sheet);
    if (main) observer?.observe(main);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      root.style.removeProperty(BOTTOM_SHEET_VAR);
      setSpace(NONE);
    };
  }, [ref, open]);

  return space;
}
