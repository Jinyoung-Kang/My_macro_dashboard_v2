/**
 * 셸 폭이 바뀌는 중인가 — 넓은 화면 왼쪽 메뉴의 폭이 프레임마다 바뀌는 동안을 알리는 작은 저장소(React 없음, QA-601).
 *
 * 왼쪽 메뉴의 폭(셸 변수 --shell-nav-w)이 바뀌면 본문 열 폭이 바뀌고, 공용 차트의 크기 감시(Recharts ResponsiveContainer)가 그때마다 차트 전체를 다시
 * 그립니다. /macro의 10년 일별 선 다섯 개는 한 번에 약 100ms라, 끄는 동안(1024 1배속 7fps)과 접기 전환(150ms가 5프레임으로 끊김)이 버벅였습니다.
 * 그래서 폭이 프레임마다 바뀌는 동안 이 신호를 켜 두고, 공용 차트의 감싸개(components/charts/sizeHold)가 그동안 차트 폭을 잡아 두었다가 끝나면 한 번만
 * 다시 그리게 합니다. 켜고 끄는 쪽은 hooks/useNavResize 하나입니다.
 *
 * 값은 두 원천의 OR입니다 — 하나의 참·거짓을 두 곳에서 켜고 끄면, 끄는 도중 레일로 접히는 프레임이 켠 전환의 타이머(NAV_MOTION_HOLD_MS)가 끝날 때
 * 끌기가 아직 이어지는데도 꺼집니다.
 * - `drag`: 손잡이 끌기가 문턱(NAV_DRAG_SLOP)을 넘은 뒤부터 끝날 때(놓음·취소·잡기 잃음·넓은 화면이 좁아짐·메뉴가 사라짐)까지.
 * - `motion`: 접힘이 바뀌어 폭 전환을 켠 동안(단추·[·두 번 누르기·Enter·끌기 중 레일로 접힘 — 전환 타이머가 끝나거나 끌기가 전환을 끌 때까지).
 *   움직임 줄이기면 전환이 없으므로 켜지 않습니다.
 * 키 걸음(←·→·Home·End)·계정 메뉴의 폭 고르기·다른 탭의 storage 이벤트는 폭이 한 번에 바뀌어(전환 없음) 켜지 않습니다 — 그때 차트는 한 번 다시 그립니다.
 */
export type ShellResizeSource = "drag" | "motion";

const sources: Record<ShellResizeSource, boolean> = { drag: false, motion: false };
const listeners = new Set<() => void>();

/** 지금 셸 폭이 바뀌는 중인가(두 원천 가운데 하나라도 켜져 있음). useSyncExternalStore의 읽기 함수로도 씁니다. */
export function isShellResizing(): boolean {
  return sources.drag || sources.motion;
}

/** 한 원천을 켜거나 끕니다 — 합친 값이 바뀔 때만 알립니다. */
export function setShellResizing(source: ShellResizeSource, on: boolean): void {
  if (sources[source] === on) return;
  const before = isShellResizing();
  sources[source] = on;
  if (isShellResizing() !== before) [...listeners].forEach((listener) => listener());
}

/** 합친 값이 바뀔 때 부를 함수를 등록합니다 — 돌려준 함수로 해제. */
export function subscribeShellResizing(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 시험이 두 원천을 끕니다(알리지 않음 — 시험 사이 정리용). */
export function resetShellResizingForTest(): void {
  sources.drag = false;
  sources.motion = false;
}
