/**
 * 넓은 화면(lg 이상) 왼쪽 메뉴의 폭 — 끌어서 바꾸는 폭과 아이콘 레일로 접힘을 정하는 순수 함수(작업대 실행 명세 §5 '가변 폭 왼쪽 메뉴', ADR 0042
 * 2026-11-16 사용자 결정). React·DOM 없이 두어(ADR 0004) 손잡이(shell/SideNav)·기억 훅(hooks/useNavWidth)·셸 뿌리(shell/Shell)가 같은 숫자를 씁니다.
 *
 * - 펼친 폭은 206~320px(기본 220px)이고, 접으면 48px 아이콘 레일입니다. 접어도 펼친 폭은 기억해 두었다가 펼 때 되돌립니다.
 * - 끌기: 손잡이를 잡은 자리에서 옮긴 만큼 폭이 따라오고(206~320 안으로 자름), 140px 아래로 끌면 레일로 접히며(끌기 전 펼친 폭을 기억),
 *   레일을 140px 넘어 끌어내면 끈 폭으로 펼칩니다(206 아래면 206). 같은 끌기 안에서 잡을 때의 접힘으로 되돌아가려면 16px 더 끌어야 합니다
 *   (문턱 근처의 손떨림이 프레임마다 접고 펴지 않게).
 * - 키보드(손잡이 — role=separator): ←·→ 16px(Shift 64px), Home 최소·End 최대, Enter 접기·펼치기. 접힌 동안 →·Enter는 기억한 폭으로,
 *   End는 최대 폭으로 펼치고 ←·Home은 그대로입니다(이미 가장 왼쪽).
 * - 끌지 않는 포인터 수단: 계정 메뉴의 '왼쪽 메뉴 폭' 세 단계(NAV_WIDTH_PRESETS — 좁게·기본·넓게)로 펼친 폭을 고릅니다.
 */

/**
 * 펼친 폭의 하한·상한·기본(px). 하한은 처음 180이었다가 200으로(2026-11-16), 다시 206으로 올렸습니다(2026-11-17) — 둘 다 사용자 위임, 권장안.
 * 펼친 메뉴의 하위 칸에는 툴팁이 없어 잘린 이름을 읽을 길이 없으므로, 잘리지 않는 폭을 하한으로 둡니다.
 * - 180 → 200: 180에서는 하위 칸 글이 쓸 수 있는 폭이 121px라 긴 이름 몇('외부 API 연결 테스트'·'데이터 저장소 상태'(맑은 고딕),
 *   '파생·투기세력(KRX)'(대체 글꼴))이 잘렸고 196px부터 모두 들어갔습니다(검토가 잰 값 — 진행 기록 'P3 추가').
 * - 200 → 206(QA-611): 창 높이가 약 648px 이하이면 긴 운영 하위 메뉴가 넘쳐 메뉴에 10px 스크롤 막대(::-webkit-scrollbar 10px)가 서고, 200에서는
 *   '외부 API 연결 테스트'가 다시 잘렸습니다(지금 화면 굵은 글씨 Segoe UI + 맑은 고딕에서 0.2px, 다른 글꼴에서 1.2~4.6px 모자람). 206이면 잰 세 글꼴
 *   모두(굵은 글씨 포함) 들어갑니다 — 스크롤 막대가 설 때도 잘리지 않는 폭입니다. 전에 저장한 200~205는 206으로 읽습니다(clampNavWidth).
 */
export const NAV_WIDTH_MIN = 206;
export const NAV_WIDTH_MAX = 320;
export const NAV_WIDTH_DEFAULT = 220;
/**
 * 계정 메뉴 '왼쪽 메뉴 폭'의 세 단계(px) — 손잡이를 끌지 않고 24px 이상의 메뉴 항목으로 폭을 고르는 수단입니다(WCAG 2.2 2.5.7 끌기 동작·2.5.8 누름 자리,
 * 2026-11-16 결정 — 사용자 위임, 권장안). 좁게는 하한, 기본은 기본 폭이고, 넓게(280)는 상한(320)보다 낮게 둡니다 — 창 폭 1280에서 메뉴를 317px 넘게
 * 넓히면 정보 검색 대상 화면의 두 칸 줄 제목 칸이 목표(236px) 아래로 줄어(진행 기록 'P3 추가'의 '남긴 것'), 메뉴가 고르게 하는 폭은 그 아래에 둡니다.
 * 끌어서 정한 그 밖의 폭(예: 250)은 어느 단계와도 같지 않습니다(메뉴에서 고른 항목 없음).
 */
export const NAV_WIDTH_PRESETS: readonly { label: string; width: number }[] = [
  { label: "좁게", width: NAV_WIDTH_MIN },
  { label: "기본", width: NAV_WIDTH_DEFAULT },
  { label: "넓게", width: 280 },
];

/** 펼친 폭과 같은 단계 — 없으면(끌어서 정한 폭) null. 펼친 폭은 잘라서 견줍니다(저장값 검사와 같은 규칙). */
export function navWidthPreset(width: number): { label: string; width: number } | null {
  const value = clampNavWidth(width);
  return NAV_WIDTH_PRESETS.find((preset) => preset.width === value) ?? null;
}

/** 접힌 아이콘 레일의 폭(px). */
export const NAV_RAIL_WIDTH = 48;
/** 끌어서 이 폭(px) 아래로 놓이면 레일로 접힙니다 — 하한(206)보다 더 끌어야 접혀 실수로 접히지 않습니다. */
export const NAV_SNAP_WIDTH = 140;
/**
 * 끄는 동안 문턱의 되돌림 여유(px) — 같은 끌기 안에서 잡을 때의 접힘으로 되돌아가려면 문턱에서 이만큼 더 끌어야 합니다(펼친 채 잡아 접었으면 156 이상에서
 * 다시 펴고, 레일에서 끌어내 폈으면 124 아래에서 다시 접음). 문턱 근처에서 포인터가 1~2px 떨려도 프레임마다 접고 펴며 본문이 오가지 않게 합니다.
 */
export const NAV_SNAP_HYSTERESIS = 16;
/** 화살표 한 번에 바뀌는 폭(px) — Shift와 함께면 큰 걸음. */
export const NAV_KEY_STEP = 16;
export const NAV_KEY_STEP_LARGE = 64;
/** 이만큼(px) 움직이기 전에는 끌기로 보지 않습니다 — 두 번 누르기(접기·펼치기)의 손떨림이 폭을 바꾸지 않게. */
export const NAV_DRAG_SLOP = 3;
/** 접고 펼 때의 폭 전환 시간(ms) — 클래스 duration-150과 같은 값. */
export const NAV_MOTION_MS = 150;
/**
 * 접힘이 바뀐 뒤 전환 클래스를 붙여 두는 시간(ms) — 전환 시간에 50ms(서너 프레임)를 더해, 전환이 끝나기 전에 클래스가 빠져 마지막 몇 px이 튀지 않게
 * 합니다. 그 뒤에는 떼어, 다른 탭이 폭만 바꾼 storage 이벤트 같은 접힘이 바뀌지 않는 폭 바뀜이 전환으로 그려지지 않게 합니다.
 */
export const NAV_MOTION_HOLD_MS = NAV_MOTION_MS + 50;

/** 왼쪽 메뉴의 배치 — 접힘과 펼친 폭(접힌 동안에는 펼 때 되돌릴 폭). */
export type NavLayout = { collapsed: boolean; width: number };

/** 펼친 폭을 하한·상한 안의 정수로 — 숫자가 아니면(NaN·무한) 기본 폭. */
export function clampNavWidth(value: number): number {
  if (!Number.isFinite(value)) return NAV_WIDTH_DEFAULT;
  return Math.min(NAV_WIDTH_MAX, Math.max(NAV_WIDTH_MIN, Math.round(value)));
}

/**
 * 저장해 둔 펼친 폭을 읽습니다 — 이 브라우저의 저장소에 쓴 값이라도 손댄 값일 수 있어 검사합니다. 1~4자리 정수 글만 받고 하한·상한 안으로 자르며,
 * 없거나(null) 다른 꼴('abc'·'-5'·'1e3'·'220px'·빈 글)이면 기본 폭입니다.
 */
export function parseNavWidth(raw: string | null | undefined): number {
  if (typeof raw !== "string" || !/^\d{1,4}$/.test(raw)) return NAV_WIDTH_DEFAULT;
  return clampNavWidth(Number(raw));
}

/** 화면에 보이는 폭(px) — 접혔으면 레일 폭, 아니면 펼친 폭. 셸 뿌리의 변수 --shell-nav-w가 이 값입니다. */
export function navShownWidth(layout: NavLayout): number {
  return layout.collapsed ? NAV_RAIL_WIDTH : clampNavWidth(layout.width);
}

/** 끄는 동안의 접힘 — 손잡이를 잡을 때(`startCollapsed`)와 지금(`collapsed` — 바로 앞 프레임까지 그린 것). */
export type NavDragState = { startCollapsed: boolean; collapsed: boolean };

/**
 * 끄는 동안 접힘을 가르는 폭 — 잡을 때의 접힘에서 벗어나는 쪽은 140, 이미 벗어났다가 되돌아가는 쪽은 16px 더(펼친 채 잡았으면 156, 레일에서 잡았으면 124).
 * `state`가 없으면 140입니다.
 */
export function navSnapThreshold(state?: NavDragState): number {
  if (!state || state.collapsed === state.startCollapsed) return NAV_SNAP_WIDTH;
  return state.startCollapsed ? NAV_SNAP_WIDTH - NAV_SNAP_HYSTERESIS : NAV_SNAP_WIDTH + NAV_SNAP_HYSTERESIS;
}

/**
 * 끄는 동안의 배치 — `pointerWidth`는 손잡이를 잡은 자리에서 옮긴 만큼 더한 폭(잡을 때 보이던 폭 + 옮긴 거리), `restoreWidth`는 끌기 전 펼친 폭,
 * `state`는 잡을 때와 지금의 접힘(문턱의 되돌림 여유 — navSnapThreshold).
 * 문턱 아래면 레일로 접고 펼친 폭은 끌기 전 값으로 둡니다(지나며 자른 206이 아니라 — 펼치면 끌기 전 폭으로 돌아감). 그 밖은 끈 폭으로 펼칩니다(206~320).
 */
export function navDragLayout(pointerWidth: number, restoreWidth: number, state?: NavDragState): NavLayout {
  if (!(pointerWidth >= navSnapThreshold(state))) return { collapsed: true, width: clampNavWidth(restoreWidth) };
  return { collapsed: false, width: clampNavWidth(pointerWidth) };
}

/**
 * 손잡이 키 — 받는 키면 다음 배치(바뀌지 않을 수도 있음 — 이미 끝에서 같은 쪽으로 누름), 받지 않는 키면 null(그때는 기본 동작을 막지 않음).
 * Ctrl·⌘·Alt와 함께 누른 키는 받지 않습니다(브라우저·운영체제 단축키). Shift는 화살표의 큰 걸음입니다.
 * 누르고 있는 키의 반복(`repeat`)은 접고 펴지 않습니다 — 받기는 하되 배치 그대로(처음 한 번만 — `[` 단축키와 같음). Enter를 누르고 있으면 반복마다 접고
 * 펴기를 번갈아 셸 전체가 깜빡였습니다. 화살표의 반복은 폭을 이어서 바꿉니다(접힌 동안 →를 누르고 있으면 처음에 펴고 그다음부터 넓힘).
 */
export function navKeyLayout(
  event: { key: string; shiftKey: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; repeat?: boolean },
  layout: NavLayout,
): NavLayout | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const next = keyLayout(event, layout);
  if (next && event.repeat && next.collapsed !== layout.collapsed) return { collapsed: layout.collapsed, width: clampNavWidth(layout.width) };
  return next;
}

/** navKeyLayout의 키별 배치(반복·보조 키를 거르기 전). */
function keyLayout(event: { key: string; shiftKey: boolean }, layout: NavLayout): NavLayout | null {
  const width = clampNavWidth(layout.width);
  const step = event.shiftKey ? NAV_KEY_STEP_LARGE : NAV_KEY_STEP;
  if (layout.collapsed) {
    switch (event.key) {
      case "Enter":
      case "ArrowRight":
        return { collapsed: false, width };
      case "End":
        return { collapsed: false, width: NAV_WIDTH_MAX };
      case "ArrowLeft":
      case "Home":
        return { collapsed: true, width };
      default:
        return null;
    }
  }
  switch (event.key) {
    case "Enter":
      return { collapsed: true, width };
    case "ArrowLeft":
      return { collapsed: false, width: clampNavWidth(width - step) };
    case "ArrowRight":
      return { collapsed: false, width: clampNavWidth(width + step) };
    case "Home":
      return { collapsed: false, width: NAV_WIDTH_MIN };
    case "End":
      return { collapsed: false, width: NAV_WIDTH_MAX };
    default:
      return null;
  }
}

/**
 * 손잡이(role=separator)의 값 — aria-valuenow는 펼친 폭이고 접혔으면 가장 왼쪽 자리인 하한(206)입니다(창 나누개 패턴: 접힘 = 최소 자리).
 * 읽는 글(aria-valuetext)은 px 폭이고, 접혔으면 접힘과 펼 때 돌아갈 폭을 함께 말합니다.
 */
export function navSeparatorValue(layout: NavLayout): { now: number; text: string } {
  const width = clampNavWidth(layout.width);
  if (layout.collapsed) return { now: NAV_WIDTH_MIN, text: `접힘(아이콘 레일), 펼치면 ${width}px` };
  return { now: width, text: `${width}px` };
}
