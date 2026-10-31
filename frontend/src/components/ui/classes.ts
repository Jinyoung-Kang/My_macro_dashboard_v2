/*
 * 공용 조각의 클래스 문자열 — React를 모르는 순수 모듈이라 서버 컴포넌트(인증 화면 카드 등)도 부를 수 있습니다
 * ("use client"인 ui/index.tsx에서 내보낸 함수는 서버에서 부를 수 없습니다). ui/index.tsx가 그대로 다시 내보내므로
 * 클라이언트 쪽은 `@/components/ui`에서 가져와도 됩니다. 모양의 근거는 docs/specs/2026-10-31-v2-coinbase-ui.md §3.
 */

/** 단추 모양(명세 §3) — 주 단추만 강조 파랑이고 나머지는 중립입니다. 강조 파랑은 누를 수 있는 것에만 씁니다(명세 원칙 A1). */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "sm";

/*
 * 알약 모양·굵은 글·색만 바뀌는 전환(움직임 줄이기면 없음)·포커스 링 2px(바탕 대비 6.3:1).
 * 투명 1px 테두리는 고대비(forced-colors) 모드에서 시스템 색 테두리로 보여 단추 경계가 남게 합니다(바탕색은 그 모드에서 지워짐).
 */
const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-full border border-transparent text-center font-semibold motion-safe:transition-colors motion-safe:duration-150 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover",
  secondary: "bg-surface-2 text-text hover:bg-[color-mix(in_oklab,var(--text)_8%,var(--surface-2))]",
  ghost: "bg-transparent text-text-2 hover:bg-surface-2 hover:text-text",
  danger: "bg-danger text-danger-fg hover:opacity-90",
};

// 좁은 화면(lg 미만 — 손가락)에서는 두 크기 모두 높이 44px 이상, 왼쪽 내비가 있는 넓은 화면에서는 40·32px.
const BUTTON_SIZE: Record<ButtonSize, string> = {
  md: "min-h-11 px-4 text-sm lg:min-h-10",
  sm: "min-h-11 px-3 text-[13px] lg:min-h-8",
};

/**
 * 단추 클래스 — `Button`을 쓸 수 없는 단추(확인 창의 submit·셸의 새로고침·로그아웃)도 같은 모양이 되게 내보냅니다.
 * 폭·여백 같은 배치 클래스는 부르는 쪽이 뒤에 붙입니다.
 */
export function buttonClasses(variant: ButtonVariant = "secondary", size: ButtonSize = "md"): string {
  return `${BUTTON_BASE} ${BUTTON_VARIANT[variant]} ${BUTTON_SIZE[size]}`;
}

/** 포커스 링 — 키보드로 옮긴 곳을 2px 바깥선으로 보입니다(바탕 대비 라이트 6.3·다크 6.8:1). */
export const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export type InputSize = "md" | "sm";

const INPUT_SIZE: Record<InputSize, string> = {
  md: "min-h-11 px-3 py-2 text-sm lg:min-h-10",
  sm: "min-h-11 px-2.5 py-1 text-[13px] lg:min-h-8",
};

/**
 * 날 입력칸(input·textarea·select) 모양 — 테두리 border-strong(3:1, WCAG 1.4.11), 바탕 surface, 포커스 링 2px.
 * 예전 모양(`outline-hidden focus:border-accent`)은 포커스 표시가 테두리 색 하나(1.9:1)뿐이라 모자랐습니다(명세 D9).
 * 폭·여백 같은 배치 클래스는 부르는 쪽이 붙입니다. sm은 카드 머리의 작은 고르기(새로고침 간격 등)용입니다.
 */
export function inputClasses(size: InputSize = "md"): string {
  return `rounded-control border border-border-strong bg-surface text-text placeholder:text-text-3 disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_RING} ${INPUT_SIZE[size]}`;
}

/*
 * 고르기 조각 셋(기간 알약·세그먼트·밑줄 탭) — 명세 §4. 고른 것은 색만이 아니라 굵기로도 다르고, 고대비(forced-colors) 모드에서는
 * 바탕색·그림자(ring)가 지워지므로 고른 칸에만 1px 테두리를 더합니다(명세 D9). 나머지 칸에는 테두리를 두지 않습니다 — 투명 테두리는
 * 그 모드에서 시스템 색으로 보여 모든 칸이 고른 것처럼 보입니다.
 */
const FORCED_SELECTED = "forced-colors:border";
const SELECT_MOTION = "motion-safe:transition-colors motion-safe:duration-150";

/**
 * 기간 알약(새 patterns/RangeTabs·옛 components/RangeTabs) — 이미 받은 시계열을 자르는 고르기. 데이터 영역이라 고른 칸도 강조 파랑이
 * 아니라 중립 바탕(surface-2)과 굵은 글입니다(명세 원칙 A1 — 강조 파랑은 하락 파랑과 색으로 구분되지 않음).
 * 좁은 화면(lg 미만)은 손가락으로 누르므로 높이 44px.
 */
export function pillTabClasses(active: boolean): string {
  return `inline-flex min-h-11 items-center justify-center rounded-full px-3.5 text-[13px] tabular-nums lg:min-h-8 ${SELECT_MOTION} ${FOCUS_RING} ${
    active ? `bg-surface-2 font-semibold text-text ${FORCED_SELECTED}` : "font-medium text-text-2 hover:text-text"
  }`;
}

/** 세그먼트의 트랙(라디오 묶음) — 배치(flex·inline-flex·폭)는 부르는 쪽이 붙입니다. */
export const SEGMENT_TRACK = "rounded-full bg-surface-2 p-1";

/**
 * 세그먼트 칸(테마 전환·홈 시장 고르기) — 가린 라디오 입력을 감싼 라벨에 붙입니다. 포커스 링은 라벨이 그립니다(has-[:focus-visible]).
 * 고른 칸은 트랙 위에 뜬 표면 칩(surface + 1px 링)입니다. 높이·글자 크기는 부르는 쪽이 붙입니다.
 */
export function segmentClasses(checked: boolean): string {
  return `inline-flex cursor-pointer items-center justify-center rounded-full ${SELECT_MOTION} has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus ${
    checked ? `bg-surface font-semibold text-text ring-1 ring-border ${FORCED_SELECTED}` : "font-medium text-text-2 hover:text-text"
  }`;
}

export type UnderlineTabSize = "md" | "sm";

const UNDERLINE_SIZE: Record<UnderlineTabSize, string> = {
  md: "h-12 text-[15px]",
  sm: "h-11 text-sm",
};

/**
 * 밑줄 탭(하위 메뉴 줄·모의매매 화면 탭) — 지금 탭은 강조 파랑 밑줄과 굵은 글(셸·탐색은 누를 수 있는 것이라 강조 파랑을 씀 — A1),
 * 나머지는 보조 글. 줄을 바꾸지 않고 감싼 줄이 가로로 스크롤합니다. `sm`은 하위 메뉴 줄 아래 두 번째 탭 줄(모의매매 7탭)용으로
 * 한 단계 작게 둬 두 줄의 위계를 가릅니다.
 */
export function underlineTabClasses(active: boolean, size: UnderlineTabSize = "md"): string {
  return `inline-flex shrink-0 items-center gap-1 whitespace-nowrap border-b-2 px-3 ${UNDERLINE_SIZE[size]} ${SELECT_MOTION} focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ${
    active ? "border-accent font-semibold text-text" : "border-transparent font-normal text-text-2 hover:text-text"
  }`;
}
