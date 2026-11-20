"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/** 어느 방향의 넘침을 보는가 — x 좌우(가로 스크롤 표), y 위아래(글 상자), both 둘 중 하나라도. */
export type ScrollAxis = "x" | "y" | "both";

/** 잰 넘침 — 방향마다. */
export type ScrollOverflow = { x: boolean; y: boolean };

/**
 * 상자가 넘치는가 — scrollWidth·clientWidth는 정수로 반올림된 값이라 1px까지는 넘침으로 보지 않습니다(차트 sizeHold·HeatmapTable과 같은 여유).
 */
export function measureOverflow(box: Pick<HTMLElement, "scrollWidth" | "clientWidth" | "scrollHeight" | "clientHeight">): ScrollOverflow {
  return { x: box.scrollWidth > box.clientWidth + 1, y: box.scrollHeight > box.clientHeight + 1 };
}

function overflowsOn(overflow: ScrollOverflow, axis: ScrollAxis): boolean {
  return axis === "x" ? overflow.x : axis === "y" ? overflow.y : overflow.x || overflow.y;
}

/** 스크롤 상자에 펼쳐 붙일 속성 — 넘치면(또는 아직 모르면) Tab 정지점·이름 있는 영역, 아니면 스크립트 포커스 자리(-1)만. */
export type ScrollRegionProps =
  | { tabIndex: 0; role: "region"; "aria-label": string }
  | { tabIndex: -1; role?: undefined; "aria-label"?: undefined };

/**
 * 스크롤 상자(`ref` — 부르는 쪽이 만들어 상자에 붙인 ref)의 공용 계약(QA-939 — 결정 거리 datatable-scroll-region-tabstop-without-overflow): 상자가 실제로 넘칠 때만 Tab 정지점(tabIndex 0)이고
 * 이름 있는 영역(`label` — 보통 '{이름} (좌우 스크롤)'·'{이름} (스크롤)')입니다. 넘치지 않으면 키보드로 옮길 것이 없어 정지점·영역·이름을 두지 않습니다 —
 * 예전에는 늘 정지점이라 상자에 다 들어가는 표·글에서도 Tab이 하나 늘고 낭독기가 '좌우 스크롤'이라고 읽었습니다. 그때도 tabIndex는 -1로 남겨
 * 부르는 쪽의 포커스 되돌림(알림 규칙 표를 지운 뒤 표로 — 상자를 `data-scroll-box`로 찾음)이 닿게 합니다(Tab 차례에는 없음).
 *
 * - 재기: ResizeObserver가 상자와 그 첫 자식(표)을 봅니다 — 관찰을 시작할 때 한 번, 크기가 바뀔 때마다 알려 줍니다. `watch`가 바뀌면(글 상자의 글 등 상자
 *   크기를 바꾸지 않고 넘침만 바꾸는 것) 한 번 알려 받은 뒤부터는 다시 잽니다.
 * - 아직 재지 못했거나(첫 그리기·서버 그리기) 잴 수 없는 환경(ResizeObserver 없음·알려 주지 않는 대역)이면 예전처럼 정지점을 둡니다 — 넘치는 상자를
 *   키보드로 못 닿게 만들지 않으려고(보수적). 그래서 서버 그리기와 첫 그리기가 같고, 넘치지 않는 상자는 관찰이 알려 준 뒤에 정지점이 빠집니다.
 * - 상자에 포커스가 있는 동안 넘침이 풀려도(창을 넓힘) 정지점을 떼지 않습니다 — 떼면 포커스가 <body>로 떨어집니다. 포커스가 떠날 때 다시 잽니다.
 *
 * 돌려주는 `overflow`는 잰 넘침(모르면 null) — 넘칠 때만 띄우는 안내(DataTable scrollHint="overflow"의 '좌우로 넘겨 보세요')에 씁니다.
 * `enabled`가 거짓이면(상자를 그리지 않는 빈 상태) 재지 않고, 참이 되면(상자가 생김) 다시 관찰합니다.
 */
export function useScrollRegion(
  ref: RefObject<HTMLElement | null>,
  label: string,
  { axis, enabled = true, watch }: { axis: ScrollAxis; enabled?: boolean; watch?: unknown },
): { overflow: ScrollOverflow | null; regionProps: ScrollRegionProps } {
  const [overflow, setOverflow] = useState<ScrollOverflow | null>(null);
  // 관찰이 한 번이라도 알려 주었는가 — 알려 주지 않는 환경(대역)에서 `watch`로 재어 0·0을 '넘치지 않음'으로 읽지 않게.
  const reported = useRef(false);
  const measureRef = useRef<() => void>(() => {});

  useEffect(() => {
    const box = ref.current;
    if (!enabled || box === null || typeof ResizeObserver === "undefined") return undefined;
    const measure = (leaving = false) => {
      const next = measureOverflow(box);
      const focused = !leaving && document.activeElement === box;
      setOverflow((before) => {
        // 포커스가 상자에 있으면 정지점을 떼지 않습니다(위 설명) — 앞의 값(넘침·모름)을 그대로 두고, 포커스가 떠날 때 다시 잽니다.
        if (focused && (before === null || overflowsOn(before, axis)) && !overflowsOn(next, axis)) return before;
        return before !== null && before.x === next.x && before.y === next.y ? before : next;
      });
    };
    const onReport = () => {
      reported.current = true;
      measure();
    };
    // 포커스가 떠나는 중에는 activeElement가 아직 상자일 수 있어(브라우저마다 다름) 떠나는 것으로 보고 잽니다.
    const onFocusOut = () => {
      if (reported.current) measure(true);
    };
    measureRef.current = () => {
      if (reported.current) measure();
    };
    const observer = new ResizeObserver(onReport);
    observer.observe(box);
    if (box.firstElementChild) observer.observe(box.firstElementChild);
    box.addEventListener("focusout", onFocusOut);
    return () => {
      observer.disconnect();
      box.removeEventListener("focusout", onFocusOut);
      measureRef.current = () => {};
    };
  }, [ref, enabled, axis]);

  useEffect(() => {
    measureRef.current();
  }, [watch]);

  const stop = overflow === null || overflowsOn(overflow, axis);
  return {
    overflow,
    regionProps: stop ? { tabIndex: 0, role: "region", "aria-label": label } : { tabIndex: -1 },
  };
}
