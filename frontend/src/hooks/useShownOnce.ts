"use client";

import { useEffect, useState } from "react";

/**
 * 이 탭이 한 번이라도 보였는가(QA-156). 숨긴 탭으로 열린 화면(새 탭으로 열기·브라우저가 되살린 탭)이 처음 보일 때까지 읽기를 미루는 데 씁니다 —
 * useApi의 첫 읽기는 탭이 보이는지 보지 않습니다. 한 번 보이면 다시 숨겨도 true(그 뒤의 멈춤은 useApi·useVisibleWake가 맡음).
 */
export function useShownOnce(): boolean {
  const [shown, setShown] = useState(() => typeof document !== "undefined" && document.visibilityState === "visible");

  useEffect(() => {
    if (shown) return;
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") setShown(true);
    };
    // 첫 그리기와 이 effect 사이에 보이게 됐을 수 있습니다.
    onVisibilityChange();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [shown]);

  return shown;
}
