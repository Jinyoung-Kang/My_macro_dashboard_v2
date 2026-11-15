/*
 * 공용 조각의 클래스 문자열 — React를 모르는 순수 모듈이라 서버 컴포넌트(인증 화면 카드 등)도 부를 수 있습니다
 * ("use client"인 ui/index.tsx에서 내보낸 함수는 서버에서 부를 수 없습니다). ui/index.tsx가 그대로 다시 내보내므로
 * 클라이언트 쪽은 `@/components/ui`에서 가져와도 됩니다. 모양의 근거는 작업대 화면 언어 실행 명세
 * docs/specs/2026-11-15-v2-workbench-ui.md §3-4·§3-7·§3-8·§6 — 모서리 4px, 넓은 화면(lg 이상) 조작 30px(작은 것 24·큰 것 40),
 * 좁은 화면(lg 미만) 누르는 자리 44px.
 */

/** 포커스 링 — 키보드로 옮긴 곳을 2px 바깥선으로 보입니다(focus 대비 bg 9.35·surface 8.20·surface-2 7.31·surface-3 6.34:1). */
export const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/**
 * 단추 네 종류(실행 명세 §3-4) — 기본(default: 조작 바탕과 1px 경계), 주(primary: 강조 파랑 바탕 — 한 묶음에 하나), 위험(danger: 확인
 * 대화상자를 거치는 파괴적 동작에만, 늘 글과 함께), 최소(minimal: 투명 — 표 안·도구 줄, hover 때 조작 바탕). 강조 파랑은 누를 수 있는 것에만 씁니다(원칙 A1).
 * 조작 바탕(bg-control-fill — globals.css)은 패널·바탕 위에서 surface-2, 덮개(대화상자·토스트 — data-overlay) 안에서 한 단계 위 surface-3입니다 —
 * 덮개 바탕이 surface-2라 같은 값이면 기본 단추의 바탕과 최소 단추의 hover가 사라졌습니다(2026-11-16 결정). 기본 단추의 hover는 두 자리 모두 경계를
 * border-strong으로 진하게 합니다. 그 바탕 위 글자는 text·text-2만 둡니다(surface-3 위 text-3·accent·danger 금지 — 부르는 쪽이 글자색을 덧붙일 때도).
 * secondary·ghost는 옛 이름으로 default·minimal과 같습니다 — 부르는 곳을 한꺼번에 고치지 않으려고 남깁니다.
 */
export type ButtonVariant = "default" | "primary" | "danger" | "minimal" | "secondary" | "ghost";
/** md는 기본(lg 이상 30px), sm은 작은 것(24px — 표 안·카드 머리), lg는 큰 것(40px — 인증 화면처럼 화면에 하나뿐인 주 동작). */
export type ButtonSize = "md" | "sm" | "lg";

/*
 * 4px 모서리·색만 바뀌는 전환(움직임 줄이기면 없음)·포커스 링 2px. 모든 종류에 1px 테두리가 있어(주·위험·최소는 투명) 고대비(forced-colors)
 * 모드에서 시스템 색 테두리로 단추 경계가 남습니다(바탕색은 그 모드에서 지워짐).
 * 글은 줄을 바꾸지 않습니다(whitespace-nowrap) — 단추 글은 짧다는 전제이고, 표의 좁은 칸에서 접히면 단추가 세로로 길어져
 * '상세 펼치 / 기'·'다시 실행'(한 글자씩 세로로) 같은 꼴이 됐습니다. 접히지 않는 대신 칸이 단추 폭만큼 넓어집니다.
 */
const CONTROL_BASE = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-control border text-center motion-safe:transition-colors motion-safe:duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`;

const BUTTON_KIND = {
  default: "border-border bg-control-fill font-medium text-text hover:border-border-strong",
  primary: "border-transparent bg-accent font-semibold text-accent-fg hover:bg-accent-hover",
  // 위험 바탕 위 글자는 danger-fg(5.88:1 — 흰 글자는 3.14:1이라 쓰지 않음).
  danger: "border-transparent bg-danger font-semibold text-danger-fg hover:opacity-90",
  minimal: "border-transparent bg-transparent font-medium text-text-2 hover:bg-control-fill hover:text-text",
} as const;

const BUTTON_VARIANT: Record<ButtonVariant, string> = { ...BUTTON_KIND, secondary: BUTTON_KIND.default, ghost: BUTTON_KIND.minimal };

// 좁은 화면(lg 미만 — 손가락)에서는 모든 크기가 높이 44px 이상, 넓은 화면에서는 30·24·40px.
const BUTTON_SIZE: Record<ButtonSize, string> = {
  md: "min-h-11 px-3 text-sm lg:min-h-[30px] lg:px-2.5",
  sm: "min-h-11 px-2.5 text-[13px] lg:min-h-6 lg:px-2",
  lg: "min-h-11 px-4 text-sm lg:min-h-10 lg:px-3.5",
};

/**
 * 단추 클래스 — `Button`을 쓸 수 없는 단추(확인 창의 submit·셸의 새로고침·로그아웃)도 같은 모양이 되게 내보냅니다.
 * 폭·여백 같은 배치 클래스는 부르는 쪽이 뒤에 붙입니다.
 */
export function buttonClasses(variant: ButtonVariant = "default", size: ButtonSize = "md"): string {
  return `${CONTROL_BASE} ${BUTTON_VARIANT[variant]} ${BUTTON_SIZE[size]}`;
}

export type InputSize = "md" | "sm" | "lg";

// 단추와 같은 높이 — lg 이상 기본 30px·작은 것 24px·큰 것(인증 화면) 40px, lg 미만은 모두 44px. 높이는 줄 높이 + 위아래 여백 + 경계 2px라
// 줄 높이를 글자 단계로 고정합니다 — md는 text-sm(14/20 → 20+8+2), sm은 caption(13/18 → 18+4+2). 임의 크기 text-[13px]는 줄 높이를 정하지 않아
// 부모의 줄 높이(본문 1.5 → 19.5px)를 물려받아 sm이 25.5px로 같은 줄의 sm 단추(24px)와 어긋났습니다.
const INPUT_SIZE: Record<InputSize, string> = {
  md: "min-h-11 px-3 py-2 text-sm lg:min-h-[30px] lg:px-2.5 lg:py-1",
  sm: "min-h-11 px-2.5 py-1 text-caption lg:min-h-6 lg:px-2 lg:py-0.5",
  // 인증 화면(로그인·가입·재설정)의 입력칸 — 화면 가운데 카드 하나라 큰 것(40px).
  lg: "min-h-11 px-3 py-2 text-sm lg:min-h-10",
};

/**
 * 날 입력칸(input·textarea·select) 모양 — 테두리 border-strong(3:1, WCAG 1.4.11), 바탕 surface, 포커스 링 2px, 모서리 4px.
 * 예전 모양(`outline-hidden focus:border-accent`)은 포커스 표시가 테두리 색 하나(1.9:1)뿐이라 모자랐습니다(명세 D9).
 * 폭·여백 같은 배치 클래스는 부르는 쪽이 붙입니다. sm은 카드 머리·표 안의 작은 고르기(새로고침 간격 등)용, lg는 인증 화면용입니다.
 */
export function inputClasses(size: InputSize = "md"): string {
  return `rounded-control border border-border-strong bg-surface text-text placeholder:text-text-3 disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_RING} ${INPUT_SIZE[size]}`;
}

/*
 * 고르기 조각(기간 고르기·세그먼트·밑줄 탭·거르기 칩·켜고 끄는 단추) — 실행 명세 §3-7·§3-8·§6. 모서리 4px, lg 이상 30px(세그먼트 칸은 트랙 안
 * 24px), lg 미만 44px. 고른 것은 색만이 아니라 굵기로도 다르고, 고대비(forced-colors) 모드에서는 바탕색·그림자(ring)가 지워지므로 고른 칸에만
 * 1px 테두리를 더합니다(명세 D9). 나머지 칸에는 테두리를 두지 않습니다 — 투명 테두리는 그 모드에서 시스템 색으로 보여 모든 칸이 고른 것처럼 보입니다.
 */
const FORCED_SELECTED = "forced-colors:border";
const SELECT_MOTION = "motion-safe:transition-colors motion-safe:duration-150";

/**
 * 기간 고르기(새 patterns/RangeTabs·옛 components/RangeTabs·정보 검색의 기간·연결 보기 — 이름은 옛 '기간 알약' 그대로) — 이미 받은 시계열을
 * 자르는 고르기. 데이터 영역이라 고른 칸도 강조 파랑이 아니라 중립 바탕(surface-2)·진한 안쪽 선(border-strong)·굵은 글입니다(원칙 A1 —
 * 강조 파랑은 하락 파랑과 색으로 구분되지 않음). 좁은 화면(lg 미만)은 손가락으로 누르므로 높이 44px, 넓은 화면 30px.
 * 칸 안에 글 조각이 여럿이면(정보 검색 기간의 '{이름} {N건}') 사이를 6px 띄우고 줄을 바꾸지 않습니다 — inline-flex 안에서는 이름 끝 빈칸이
 * 접혀 '30일148건'처럼 붙었습니다(QA-464).
 */
export function pillTabClasses(active: boolean): string {
  return `inline-flex min-h-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-control px-3 text-sm tabular-nums lg:min-h-[30px] lg:px-2.5 ${SELECT_MOTION} ${FOCUS_RING} ${
    active ? `bg-surface-2 font-semibold text-text ring-1 ring-inset ring-border-strong ${FORCED_SELECTED}` : "font-medium text-text-2 hover:bg-surface-2 hover:text-text"
  }`;
}

/** 세그먼트의 트랙(라디오 묶음) — 4px·1px 경계, 놓인 면보다 어두운 바탕(bg) 위에 고른 칸이 뜹니다. 배치(flex·inline-flex·폭)는 부르는 쪽이 붙입니다. */
export const SEGMENT_TRACK = "rounded-control border border-border bg-bg p-0.5";

/**
 * 세그먼트 칸(홈 시장 고르기·모의매매 실행 감사 계좌·결정 로그 보기) — 가린 라디오 입력을 감싼 라벨(또는 aria-pressed 단추)에 붙입니다.
 * 포커스 링은 라벨이 그립니다(has-[:focus-visible]). 고른 칸은 트랙 위에 뜬 칩(surface-2 + 1px 링)입니다. 높이는 좁은 화면(lg 미만) 44px·
 * 넓은 화면 24px(트랙의 2px 안쪽 여백·1px 경계와 합쳐 30px)를 여기서 붙이고(QA-458 — 부르는 쪽에 맡기면 새 화면이 빠뜨릴 수 있음),
 * 여백·글자 크기는 부르는 쪽이 붙입니다.
 */
export function segmentClasses(checked: boolean): string {
  return `inline-flex min-h-11 cursor-pointer items-center justify-center rounded-control lg:min-h-6 ${SELECT_MOTION} has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus ${
    checked ? `bg-surface-2 font-semibold text-text ring-1 ring-border ${FORCED_SELECTED}` : "font-medium text-text-2 hover:text-text"
  }`;
}

/**
 * 따로 선 글 링크·글 단추(목록의 '원문 열기'·'본문 보기'·'번역', 카드 머리의 작은 링크 등)의 누르는 자리 — 좁은 화면(lg 미만)은 높이 44px
 * (원칙 A8, QA-458), 넓은 화면은 글 높이 그대로입니다. 색·밑줄·글자 크기는 부르는 쪽이 붙입니다. 문장 안의 링크에는 붙이지 않습니다
 * (줄 높이에 묶인 글 안 링크 — WCAG 2.5.8 예외, 붙이면 줄 가운데가 44px로 벌어짐).
 */
export const TEXT_TARGET = "inline-flex min-h-11 items-center lg:min-h-0";

/** 글 링크(누를 수 있는 것이라 강조 파랑) — 따로 선 링크라 좁은 화면에서도 누르는 자리 44px(TEXT_TARGET과 같은 규칙), 넓은 화면은 글 높이. */
export const LINK_CLASSES = `${TEXT_TARGET} rounded-sm text-accent underline-offset-2 hover:text-accent-hover hover:underline ${FOCUS_RING}`;

/**
 * 거르기 칩(교집합의 분석 대상 기관·환율 겹쳐 보기·정보 수집의 거르기) — 여럿을 켜고 끄는 aria-pressed 단추. 누를 수 있는 것이라 켠 칩은
 * 강조 파랑(틴트 바탕·파랑 테두리, 명세 원칙 A1이 허용)이고, 색만으로 켬을 전하지 않게 굵기와 체크 아이콘(부르는 쪽이 켠 칩 앞에 둠)이 함께 바뀝니다.
 * 켠 칩의 글자는 본문색입니다 — accent 틴트 위 accent 글자는 4.47:1로 4.5에 못 미칩니다(QA-459, 작업대 실행 명세 §3-2).
 * 두 상태 모두 테두리가 있어 고대비(forced-colors) 모드에서도 칩 경계가 남고, 켬은 굵기·아이콘으로 갈립니다. 4px, lg 이상 30px, lg 미만 44px.
 */
export function filterChipClasses(pressed: boolean): string {
  return `inline-flex min-h-11 items-center gap-1 rounded-control border px-3 text-[13px] lg:min-h-[30px] lg:px-2.5 ${SELECT_MOTION} ${FOCUS_RING} ${
    pressed ? "border-accent bg-accent-tint font-semibold text-text" : "border-border bg-surface font-medium text-text-2 hover:bg-surface-2 hover:text-text"
  }`;
}

/**
 * 켜고 끄는 단추(aria-pressed — 관심 대상의 알림): 켠 칸은 진한 테두리·굵은 글, 끈 칸은 옅은 글(상태는 단추의 글 '켬'·'끔'이 나름 — 색만이 아님).
 * 바꾸는 중에는 aria-disabled(포커스가 떨어지지 않게 disabled를 쓰지 않음). 모양·높이는 기본 단추와 같고(lg 이상 30px), compact는 목록 줄 —
 * 좁은 화면 44px 정사각, 넓은 화면은 줄 높이 32px, 넘침을 자르는 스크롤 영역 안이라 포커스 링을 안쪽에 그립니다.
 */
export function toggleClasses(pressed: boolean, compact = false): string {
  const shape = compact
    ? "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-control border px-2 text-xs lg:min-h-8 lg:min-w-0 lg:px-1.5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
    : `${CONTROL_BASE} ${BUTTON_SIZE.md}`;
  return `${shape} aria-disabled:cursor-not-allowed aria-disabled:opacity-50 motion-safe:transition-colors ${
    pressed
      ? "border-border-strong bg-surface-2 font-semibold text-text forced-colors:border-2"
      : "border-border font-medium text-text-2 hover:border-border-strong hover:text-text"
  }`;
}

export type UnderlineTabSize = "md" | "sm";

// md는 하위 메뉴 줄(좁은 화면 48px·15px, 넓은 화면 40px·14px), sm은 화면 안의 탭 줄(44px, 넓은 화면 30px — 정보 검색 결과 탭과 같음).
const UNDERLINE_SIZE: Record<UnderlineTabSize, string> = {
  md: "min-h-12 text-[15px] lg:min-h-10 lg:text-sm",
  sm: "min-h-11 text-sm lg:min-h-[30px]",
};

/**
 * 밑줄 탭(하위 메뉴 줄·모의매매 화면 탭·공용 Tabs) — 탭 모양은 이것 하나입니다(실행 명세 §6). 지금 탭은 강조 파랑 2px 밑줄과 굵은 글
 * (셸·탐색은 누를 수 있는 것이라 강조 파랑을 씀 — A1), 나머지는 보조 글. 줄을 바꾸지 않고 감싼 줄이 가로로 스크롤합니다. `sm`은 하위 메뉴 줄
 * 아래 두 번째 탭 줄(모의매매 탭)용으로 한 단계 작게 둬 두 줄의 위계를 가릅니다.
 * 나머지 탭의 투명 밑줄(글이 위아래로 흔들리지 않게 둔 자리)은 고대비(forced-colors) 모드에서 시스템 글자색으로 칠해져 모든 탭에 밑줄이
 * 생기므로, 그 모드에서는 지웁니다 — 지금 탭만 밑줄과 굵은 글이 남습니다(명세 D9, headless 크롬 forced-colors 흉내로 확인).
 */
export function underlineTabClasses(active: boolean, size: UnderlineTabSize = "md"): string {
  return `inline-flex shrink-0 items-center gap-1 whitespace-nowrap border-b-2 px-3 ${UNDERLINE_SIZE[size]} ${SELECT_MOTION} focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ${
    active ? "border-accent font-semibold text-text" : "border-transparent font-normal text-text-2 hover:text-text forced-colors:border-b-0"
  }`;
}

/** 면(패널) — 1px 경계, 모서리 4px(정보 검색 화면에서 옮김 — 공용 Panel과 같은 바탕·경계). */
export const PANEL_CLASSES = "rounded-card border border-border bg-surface";

/**
 * 고른 행의 왼쪽 막대(자산 행·검색 결과 — 감싼 행이 relative) — 3px 잉크(데이터 영역이라 강조 파랑 아님, 원칙 A1). 고른 행의 바탕(surface-2)과
 * 막대의 바탕색은 고대비(forced-colors) 모드에서 지워지므로, 그 모드에서는 같은 폭의 왼쪽 테두리로 그립니다 — 테두리는 시스템 글자색으로
 * 남습니다(명세 D9).
 */
export const SELECTED_BAR = "absolute inset-y-1 left-0 w-[3px] rounded-r bg-text forced-colors:border-l-[3px]";
