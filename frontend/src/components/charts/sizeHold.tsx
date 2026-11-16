"use client";

import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { isShellResizing, subscribeShellResizing } from "@/lib/shellResize";

/** 서버 렌더·첫 하이드레이션 값 — 셸 폭이 바뀌는 중이 아님. */
const serverSnapshot = () => false;

/**
 * 셸 폭이 바뀌는 동안 차트 폭을 잡아 두는 감싸개(QA-601) — 공용 차트의 ResponsiveContainer(Recharts 크기 감시)를 모두 이 안에 둡니다.
 *
 * 넓은 화면 왼쪽 메뉴를 끄는 동안·접기 전환(150ms) 동안 본문 열 폭이 프레임마다 바뀌어, 크기 감시가 프레임마다 차트 전체를 다시 그렸습니다
 * (Recharts 3.10.1 Line은 움직임을 꺼도 그릴 때마다 경로 길이를 잼 — /macro의 10년 일별 선 다섯 개가 한 번에 약 100ms). 그래서 셸 신호
 * (lib/shellResize)가 켜지는 순간 바깥 상자의 폭을 재어 안쪽 상자를 그 px로 고정하고(크기 감시가 울리지 않음), 꺼지면 100%로 되돌려 마지막 폭으로
 * 한 번만 다시 그립니다. 본문의 글·표는 그대로 옆에서 다시 흐릅니다(작업대 실행 명세 §5) — 차트만 잠깐 앞 폭에 머뭅니다.
 *
 * - 쉬는 상태는 감싸기 전과 픽셀까지 같습니다: 두 상자 모두 폭 100%·min-width 0(ResponsiveContainer 자신의 폭 규칙)이고, 높이는 차트 높이가
 *   백분율일 때만(`fillHeight` — 히어로 선 차트의 height "100%") 100%로 이어 줍니다. 숫자 높이면 높이를 정하지 않아(auto) 차트 높이 그대로입니다 —
 *   늘 100%로 두면 높이가 정해진 부모(늘인 격자 칸 등) 안에서 상자가 차트보다 길어질 수 있습니다.
 * - 고정한 동안만 바깥 상자가 가로 넘침을 자릅니다(overflow-x: clip — 세로는 그대로라 툴팁이 위아래로 나갈 수 있음). 열이 좁아져도 가로 페이지
 *   스크롤이 생기지 않고, 쉬는 동안에는 툴팁·포커스 링을 자르지 않습니다.
 * - 잰 폭이 0이면(숨긴 탭 — DetailTabs는 고르지 않은 탭을 hidden으로 그림, jsdom) 고정하지 않습니다.
 * - 신호가 켜진 채 새로 그려진 차트는 고정하지 않습니다(켜지는 순간만 봄 — 그때 잰 폭이 없음).
 * - 크기 감시의 지연(debounce)은 쓰지 않습니다 — 접기 전환은 고쳐지지만 끄는 동안 150ms마다 멈칫하고, 실행 중에 바꾸면 감시를 끊은 뒤에도 옛 크기로
 *   불릴 수 있습니다(QA-601 검증).
 */
export function ChartSizeHold({ fillHeight = false, children }: { fillHeight?: boolean; children: ReactNode }) {
  const resizing = useSyncExternalStore(subscribeShellResizing, isShellResizing, serverSnapshot);
  const outerRef = useRef<HTMLDivElement>(null);
  // 잡아 둔 폭(px) — null이면 100%.
  const [held, setHeld] = useState<number | null>(null);
  // 앞 그리기의 신호 — 켜지고 꺼지는 순간만 봅니다(켜진 채 새로 그려진 차트는 고정하지 않음).
  const previous = useRef(resizing);

  useLayoutEffect(() => {
    if (previous.current === resizing) return;
    previous.current = resizing;
    if (!resizing) {
      setHeld(null);
      return;
    }
    // 폭이 바뀌기 전(끌기는 다음 프레임에, 전환은 이 그리기 뒤부터 바뀜)에 잽니다.
    const width = outerRef.current?.getBoundingClientRect().width ?? 0;
    if (width > 0) setHeld(width);
  }, [resizing]);

  const height = fillHeight ? " h-full" : "";
  return (
    <div ref={outerRef} className={`w-full min-w-0${height}${held === null ? "" : " overflow-x-clip"}`}>
      <div className={`w-full min-w-0${height}`} style={held === null ? undefined : { width: `${held}px` }}>
        {children}
      </div>
    </div>
  );
}
