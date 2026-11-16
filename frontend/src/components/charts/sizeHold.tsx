"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { isShellResizing, subscribeShellResizing } from "@/lib/shellResize";

/** 서버 렌더·첫 하이드레이션 값 — 셸 폭이 바뀌는 중이 아님. */
const serverSnapshot = () => false;

/**
 * 폭이 바뀐 뒤 차트가 새 폭으로 다시 그려질 때까지 바깥 상자가 가로 넘침을 자르는 최대 시간(ms, QA-614) — 첫 프레임 확인부터 셉니다. 넘으면 맞지
 * 않아도 풉니다(자르기가 붙어 남지 않게). /macro의 다시 그리기는 약 100~150ms입니다.
 */
export const CHART_FIT_CLIP_MAX_MS = 1000;

/**
 * 맞았다고 보는 여유(px) — 크기 감시가 폭을 반올림해 차트에 넘기므로(Recharts setContainerSize의 Math.round) 쉬는 상태에도 0.5px 안쪽의 차이가
 * 남고, 차트 그림이 없을 때 쓰는 scrollWidth·clientWidth는 정수라 1px까지 어긋날 수 있습니다.
 */
const FIT_SLACK_PX = 1;

/** 맞을 때까지 자르는 중인 바깥 상자 → 안쪽 상자와 첫 확인의 프레임 시각(확인 전이면 null). */
const fitting = new Map<HTMLElement, { inner: HTMLElement; since: number | null }>();
let fitFrame = 0;

/**
 * 차트가 바깥 상자 안에 맞는가 — 차트 그림(Recharts의 .recharts-wrapper — 크기 감시가 새 폭으로 다시 그리면 그 폭)의 오른쪽 끝으로 봅니다. 안쪽
 * 상자의 scrollWidth는 숨은 툴팁 상자(오른쪽 끝에 띄웠던 자리에 visibility hidden으로 남음)까지 재어, 그것으로 보면 툴팁을 한 번 띄운 차트는 다시
 * 그려진 뒤에도 상한까지 잘렸습니다(QA-614 리뷰 — 포커스 링 4px). 차트 그림이 없으면 안쪽 상자의 scrollWidth로 봅니다(넘침이 보이는 자손까지 재므로
 * 차트가 아직 앞 폭이면 clientWidth보다 큼).
 */
function fitsColumn(outer: HTMLElement, inner: HTMLElement): boolean {
  const charts = inner.querySelectorAll<HTMLElement>(".recharts-wrapper");
  if (charts.length === 0) return inner.scrollWidth - inner.clientWidth <= FIT_SLACK_PX;
  const right = outer.getBoundingClientRect().right + FIT_SLACK_PX;
  return Array.from(charts).every((chart) => chart.getBoundingClientRect().right <= right);
}

/** 프레임마다 자르는 중인 상자를 모두 읽은 뒤에 풉니다 — 상자마다 읽고 쓰면 차트 수만큼 배치를 다시 계산합니다. */
function checkFitting(now: number) {
  fitFrame = 0;
  const done: HTMLElement[] = [];
  fitting.forEach((entry, outer) => {
    entry.since ??= now;
    if (fitsColumn(outer, entry.inner) || now - entry.since >= CHART_FIT_CLIP_MAX_MS) done.push(outer);
  });
  done.forEach((outer) => stopClipping(outer));
  if (fitting.size > 0) fitFrame = requestAnimationFrame(checkFitting);
}

/**
 * 바깥 상자에 인라인 overflow-x: clip을 걸고 프레임 확인을 시작합니다(이미 자르는 중이면 상한 시각만 다시 셈).
 *
 * 인라인 스타일은 CSSOM(style.overflowX) 대신 style 속성으로 걸고 걷습니다 — Chrome은 CSSOM으로 바꾼 style 속성을 늦게 맞춰, 속성을 지운 뒤에도
 * 빈 style=""이 다시 생길 때가 있었습니다(자기 빌드 확인). 바깥 상자의 style 속성은 이 자르기만 씁니다(React는 바깥 상자에 style을 주지 않음).
 */
function clipUntilFits(outer: HTMLElement, inner: HTMLElement) {
  outer.setAttribute("style", "overflow-x: clip");
  fitting.set(outer, { inner, since: null });
  if (fitFrame === 0) fitFrame = requestAnimationFrame(checkFitting);
}

/**
 * 인라인 자르기를 걷고(style 속성째 — 쉬는 상태 그대로) 확인할 상자가 남지 않으면 프레임 확인을 멈춥니다. 바깥 상자에 React style을 주면 첫 해제에
 * 그것도 지워지고 다시 쓰이지 않으므로 주지 않습니다(sizeHoldQa614 시험이 쉬는 바깥 상자의 style 속성 없음을 봄).
 */
function stopClipping(outer: HTMLElement) {
  if (!fitting.delete(outer)) return;
  outer.removeAttribute("style");
  if (fitting.size === 0 && fitFrame !== 0) {
    cancelAnimationFrame(fitFrame);
    fitFrame = 0;
  }
}

/**
 * 셸 폭이 바뀌는 동안 차트 폭을 잡아 두는 감싸개(QA-601) — 공용 차트의 ResponsiveContainer(Recharts 크기 감시)를 모두 이 안에 둡니다.
 *
 * 넓은 화면 왼쪽 메뉴를 끄는 동안·접기 전환(150ms) 동안 본문 열 폭이 프레임마다 바뀌어, 크기 감시가 프레임마다 차트 전체를 다시 그렸습니다
 * (Recharts 3.10.1 Line은 움직임을 꺼도 그릴 때마다 경로 길이를 잼 — /macro의 10년 일별 선 다섯 개가 한 번에 약 100ms). 그래서 셸 신호
 * (lib/shellResize)가 켜지는 순간 바깥 상자의 폭을 재어 안쪽 상자를 그 px로 고정하고(크기 감시가 울리지 않음), 꺼지면 100%로 되돌려 마지막 폭으로
 * 한 번만 다시 그립니다. 본문의 글·표는 그대로 옆에서 다시 흐릅니다(작업대 실행 명세 §5) — 차트만 잠깐 앞 폭에 머뭅니다.
 *
 * - 쉬는 상태는 감싸기 전과 픽셀까지 같습니다: 두 상자 모두 폭 100%·min-width 0(ResponsiveContainer 자신의 폭 규칙)이고 인라인 스타일이 없으며,
 *   높이는 차트 높이가 백분율일 때만(`fillHeight` — 히어로 선 차트의 height "100%") 100%로 이어 줍니다. 숫자 높이면 높이를 정하지 않아(auto) 차트
 *   높이 그대로입니다 — 늘 100%로 두면 높이가 정해진 부모(늘인 격자 칸 등) 안에서 상자가 차트보다 길어질 수 있습니다.
 * - 고정한 동안 바깥 상자가 가로 넘침을 자릅니다(overflow-x: clip — 세로는 그대로라 툴팁이 위아래로 나갈 수 있음). 열이 좁아져도 가로 페이지
 *   스크롤이 생기지 않고, 쉬는 동안에는 툴팁·포커스 링을 자르지 않습니다.
 * - 폭이 바뀐 직후 차트가 아직 앞 폭인 동안에도 자릅니다(QA-614). 크기 감시는 새 폭을 자기 콜백에서야 알고 다시 그리기는 기본 우선순위라 다음
 *   그리기 뒤에 오며(/macro 약 100~150ms), Recharts의 안쪽 div는 넘침이 보여 그동안 앞 폭의 차트가 열 밖(옆 차트의 축 글자·본문 오른쪽 여백)에
 *   그려졌습니다. 고정을 풀 때는 이 커밋에서 걷히는 클래스 대신 인라인 자르기를 걸고, 신호 없이 폭이 한 번에 줄 때(손잡이 키 걸음·움직임 줄이기의
 *   접고 펴기·창 크기)는 안쪽 상자의 크기 알림(ResizeObserver — 배치 뒤·그리기 전이라 같은 프레임에 그려짐)에서 겁니다. 프레임마다 차트 그림의
 *   오른쪽 끝이 바깥 상자 안에 들어오면(여유 1px — 차트 그림이 없으면 안쪽 상자의 scrollWidth) 풀고, 맞지 않아도 CHART_FIT_CLIP_MAX_MS 뒤에는
 *   풉니다. 넓어질 때는 차트가 열보다 좁아 자르지 않습니다.
 * - 잰 폭이 0이면(숨긴 탭 — DetailTabs는 고르지 않은 탭을 hidden으로 그림, jsdom) 고정하지 않습니다.
 * - 신호가 켜진 채 새로 그려진 차트는 고정하지 않습니다(켜지는 순간만 봄 — 그때 잰 폭이 없음). 푸는 도중 신호가 다시 켜지면 그때 폭을 다시 재어
 *   고정합니다(자르기는 고정 쪽으로 넘김).
 * - 크기 감시의 지연(debounce)은 쓰지 않습니다 — 접기 전환은 고쳐지지만 끄는 동안 150ms마다 멈칫하고, 실행 중에 바꾸면 감시를 끊은 뒤에도 옛 크기로
 *   불릴 수 있습니다(QA-601 검증).
 */
export function ChartSizeHold({ fillHeight = false, children }: { fillHeight?: boolean; children: ReactNode }) {
  const resizing = useSyncExternalStore(subscribeShellResizing, isShellResizing, serverSnapshot);
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  // 잡아 둔 폭(px) — null이면 100%.
  const [held, setHeld] = useState<number | null>(null);
  // 앞 그리기의 신호 — 켜지고 꺼지는 순간만 봅니다(켜진 채 새로 그려진 차트는 고정하지 않음).
  const previous = useRef(resizing);

  useLayoutEffect(() => {
    if (previous.current === resizing) return;
    previous.current = resizing;
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!resizing) {
      // 클래스의 자르기는 이 커밋에서 걷히지만 차트는 다음 그리기 뒤까지 잡아 둔 폭 — 인라인으로 이어 자르고 맞으면 풂(QA-614).
      if (held !== null && outer && inner) clipUntilFits(outer, inner);
      setHeld(null);
      return;
    }
    // 푸는 도중 다시 켜지면 인라인 자르기를 걷고 고정(클래스)으로 넘깁니다.
    if (outer) stopClipping(outer);
    // 폭이 바뀌기 전(끌기는 다음 프레임에, 전환은 이 그리기 뒤부터 바뀜)에 잽니다.
    const width = outer?.getBoundingClientRect().width ?? 0;
    if (width > 0) setHeld(width);
  }, [resizing, held]);

  // 안쪽 상자가 좁아지면(신호 없이 폭이 한 번에 바뀜·고정을 푼 직후) 차트가 다시 그려질 때까지 자릅니다 — 크기 알림은 배치 뒤·그리기 전에 오므로
  // 여기서 건 인라인 자르기는 같은 프레임에 그려집니다(React 상태로 걸면 다음 그리기 뒤). 고정 중에는 안쪽 폭이 그대로라 울리지 않습니다.
  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner || typeof ResizeObserver === "undefined") return;
    let last: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]?.contentRect?.width;
      if (width === undefined) return;
      if (last !== null && width < last) clipUntilFits(outer, inner);
      last = width;
    });
    observer.observe(inner);
    return () => {
      observer.disconnect();
      stopClipping(outer);
    };
  }, []);

  const height = fillHeight ? " h-full" : "";
  return (
    <div ref={outerRef} className={`w-full min-w-0${height}${held === null ? "" : " overflow-x-clip"}`}>
      <div ref={innerRef} className={`w-full min-w-0${height}`} style={held === null ? undefined : { width: `${held}px` }}>
        {children}
      </div>
    </div>
  );
}
