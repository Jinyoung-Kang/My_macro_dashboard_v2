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
