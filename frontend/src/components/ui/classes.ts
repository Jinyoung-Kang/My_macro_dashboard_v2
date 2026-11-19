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

/*
 * hover는 누를 수 있을 때만 — 비활성(disabled·aria-disabled="true") 단추가 경계를 진하게 하거나 바탕을 밝히면 누를 수 있는 것처럼 보입니다(QA-493).
 * `not-disabled:not-aria-disabled:hover:`는 :not(:disabled):not([aria-disabled="true"]):hover라 단추 모양 링크(<a> — 읽기 창 '원문 열기')에도 맞습니다.
 * `enabled:`(:enabled — 폼 요소에만 맞음)는 그 링크의 hover를 지우므로 쓰지 않고, pointer-events-none은 비활성 단추의 안내(title·툴팁)까지 막아 쓰지 않습니다.
 * 클래스 이름은 조각을 이어 붙이지 않고 통째로 적습니다 — Tailwind는 소스의 글자 그대로를 훑어 CSS를 만듭니다.
 */
const BUTTON_KIND = {
  default: "border-border bg-control-fill font-medium text-text not-disabled:not-aria-disabled:hover:border-border-strong",
  primary: "border-transparent bg-accent font-semibold text-accent-fg not-disabled:not-aria-disabled:hover:bg-accent-hover",
  // 위험 바탕 위 글자는 danger-fg(5.88:1 — 흰 글자는 3.14:1이라 쓰지 않음).
  danger: "border-transparent bg-danger font-semibold text-danger-fg not-disabled:not-aria-disabled:hover:opacity-90",
  minimal:
    "border-transparent bg-transparent font-medium text-text-2 not-disabled:not-aria-disabled:hover:bg-control-fill not-disabled:not-aria-disabled:hover:text-text",
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
 * 포커스 링은 라벨이 그립니다(has-[:focus-visible]). 고른 칸은 트랙 위에 뜬 칩(surface-2 + 1px 진한 링)입니다. 링은 기간 고르기와 같은
 * border-strong입니다 — 칩 바탕(surface-2)은 트랙(bg)과 1.28:1이라 고른 칸을 알리는 표시가 링이고, 패널 경계(border)로 그리면 트랙 위 1.71:1로
 * WCAG 1.4.11(3:1)에 못 미쳐 굵기만 남았습니다(QA-484 — border-strong은 bg 위 4.60·surface-2 위 3.59:1). 높이는 좁은 화면(lg 미만) 44px·
 * 넓은 화면 24px(트랙의 2px 안쪽 여백·1px 경계와 합쳐 30px)를 여기서 붙이고(QA-458 — 부르는 쪽에 맡기면 새 화면이 빠뜨릴 수 있음),
 * 여백·글자 크기는 부르는 쪽이 붙입니다.
 */
export function segmentClasses(checked: boolean): string {
  return `inline-flex min-h-11 cursor-pointer items-center justify-center rounded-control lg:min-h-6 ${SELECT_MOTION} has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus ${
    checked ? `bg-surface-2 font-semibold text-text ring-1 ring-border-strong ${FORCED_SELECTED}` : "font-medium text-text-2 hover:text-text"
  }`;
}

/**
 * 따로 선 글 링크·글 단추(목록의 '원문 열기'·'본문 보기'·'번역', 카드 머리의 작은 링크 등)의 누르는 자리 — 좁은 화면(lg 미만)은 높이 44px
 * (원칙 A8, QA-458), 넓은 화면은 글 높이 그대로입니다. 색·밑줄·글자 크기는 부르는 쪽이 붙입니다. 문장 안의 링크에는 붙이지 않습니다
 * (줄 높이에 묶인 글 안 링크 — WCAG 2.5.8 예외, 붙이면 줄 가운데가 44px로 벌어짐).
 */
export const TEXT_TARGET = "inline-flex min-h-11 items-center lg:min-h-0";

/**
 * 짧은 글 단추·링크(3글자 안팎 — '번역'·'원문'·'읽음'·쪽 넘기기 옆 글 단추 등)의 누르는 자리 — 좁은 화면(lg 미만)은 높이와 폭 모두 44px(원칙 A8.
 * TEXT_TARGET은 높이만이라 두 글자 단추는 폭이 글 폭뿐 — D2 QA에서 '접기' 28px), 글은 상자 가운데라 키보드 포커스 링이 글 양쪽으로 고르게 벌어집니다(D2 QA 'QA-610 뒤
 * 접기 단추 링' — 글이 44px 상자 왼쪽에 붙어 링 안 오른쪽만 빔). 넓은 화면은 높이·폭 모두 글 크기 그대로(TEXT_TARGET과 같은 규칙 — 24px 하한은 기록된
 * 결정 거리 lg-sort-header-summary-text-height). 색·밑줄·글자 크기·포커스 링은 부르는 쪽이 붙입니다.
 *
 * 고르는 규칙: 3글자 안팎의 홀로 선 글 단추·링크는 TEXT_TARGET_SHORT, 그보다 긴 글 링크는 TEXT_TARGET, 문장 안의 링크는 둘 다 쓰지 않습니다
 * (WCAG 2.5.8 글 안 예외). 좁은 화면에서 글이 상자 가운데로 들어가 문단 시작선에서 (44 − 글 폭) / 2만큼 밀리므로, 문단 시작선에 맞춰야 하는 머리
 * (상세 화면 '접기' 등)에는 쓰지 않습니다.
 */
export const TEXT_TARGET_SHORT = "inline-flex min-h-11 min-w-11 items-center justify-center lg:min-h-0 lg:min-w-0";

/**
 * 표·목록 줄의 이름 단추(검사 칸 틀의 줄 단추 InspectorTrigger, COT 자산 고르기 단추 등) — 데이터 칸이라 강조 파랑이 아니라 중립 잉크(본문색), 마우스를
 * 올리면 밑줄, 포커스 링. 좁은 화면(lg 미만) 누르는 자리는 높이와 폭 모두 44px(한 글자 이름 '금'도 — TEXT_TARGET은 높이만), 넓은 화면은 높이와 폭 모두
 * 24px 이상(명세 §3-7 '작은 것 24px(표 안)' — WCAG 2.5.8 최소 크기. 글 높이 20px인 단추가 24px, 한 글자 '금'은 폭 14 → 24px — 2026-11-17 결정 8, 사용자
 * 위임 — 권장안). TEXT_TARGET을 쓰지 않고 같은 조각을 여기 적습니다 — 그 lg:min-h-0과 lg:min-h-6을 함께 두면 어느 쪽이 이길지가 생성된 CSS 차례에 걸립니다.
 * 이름은 말줄임 없이 낱말 사이에서 꺾습니다.
 */
export const ROW_TRIGGER = `inline-flex min-h-11 min-w-11 items-center rounded-sm text-left text-text break-keep underline-offset-2 hover:underline lg:min-h-6 lg:min-w-6 ${FOCUS_RING}`;

/**
 * 읽는 중 자리표시 막대의 겉모습 — 공용 Skeleton 막대와 같은 모양(놓인 면보다 한 단계 위 면 bg-control-fill·4px 모서리·motion-safe 깜빡임·고대비 1px
 * 테두리). 크기와 display는 부르는 쪽이 붙입니다. 화면이 값이 온 뒤의 꼴을 본뜬 자리표시(국면 대상 머리·판정 기록 목록·매크로 지표 패널·COT 요약 표 —
 * P5a 후속)를 그릴 때 씁니다.
 */
export const SKELETON_BAR = "rounded-control bg-control-fill motion-safe:animate-pulse forced-colors:border";

/** 글 링크(누를 수 있는 것이라 강조 파랑) — 따로 선 링크라 좁은 화면에서도 누르는 자리 44px(TEXT_TARGET과 같은 규칙), 넓은 화면은 글 높이. */
export const LINK_CLASSES = `${TEXT_TARGET} rounded-sm text-accent underline-offset-2 hover:text-accent-hover hover:underline ${FOCUS_RING}`;

/**
 * 거르기 칩(교집합의 분석 대상 기관·환율 겹쳐 보기·정보 수집의 거르기) — 여럿을 켜고 끄는 aria-pressed 단추. 누를 수 있는 것이라 켠 칩은
 * 강조 파랑(틴트 바탕·파랑 테두리, 명세 원칙 A1이 허용)이고, 색만으로 켬을 전하지 않게 굵기가 함께 바뀝니다(체크 아이콘은 부르는 쪽이 켠 칩 앞에 둘 때만 —
 * 컨센서스·환율 비교는 두고, 정보 수집 두 화면은 없음).
 * 켠 칩의 글자는 본문색입니다 — accent 틴트 위 accent 글자는 4.47:1로 4.5에 못 미칩니다(QA-459, 작업대 실행 명세 §3-2).
 * 두 상태 모두 테두리가 있어 고대비(forced-colors) 모드에서도 칩 경계가 남고, 켬은 굵기·고대비 2px 테두리로 갈립니다(그 모드는 틴트 바탕을 지우고
 * 두 상태의 테두리를 같은 시스템 색으로 칠해, 굵기만 남았습니다 — QA-492, 켜고 끄는 단추와 같은 방법). 4px, lg 이상 30px, lg 미만 44px.
 */
export function filterChipClasses(pressed: boolean): string {
  return `inline-flex min-h-11 items-center gap-1 rounded-control border px-3 text-[13px] lg:min-h-[30px] lg:px-2.5 ${SELECT_MOTION} ${FOCUS_RING} ${
    pressed
      ? "border-accent bg-accent-tint font-semibold text-text forced-colors:border-2"
      : "border-border bg-surface font-medium text-text-2 hover:bg-surface-2 hover:text-text"
  }`;
}

/**
 * 켜고 끄는 단추(aria-pressed — 관심 대상의 알림): 켠 칸은 진한 테두리·굵은 글, 끈 칸은 옅은 글(상태는 단추의 글 '켬'·'끔'이 나름 — 색만이 아님).
 * 바꾸는 중에는 aria-disabled(포커스가 떨어지지 않게 disabled를 쓰지 않음). 모양·높이는 기본 단추와 같고(lg 이상 30px), compact는 목록 줄 —
 * 좁은 화면 44px 정사각, 넓은 화면은 기본 조작 높이 30px(명세 §3-7 높이 단계 — 32px 목록 줄 가운데에 놓임, 예전 32px는 단계 밖이었음 — 2026-11-16 검토 지적),
 * 넘침을 자르는 스크롤 영역 안이라 포커스 링을 안쪽에 그립니다.
 */
export function toggleClasses(pressed: boolean, compact = false): string {
  const shape = compact
    ? "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-control border px-2 text-xs lg:min-h-[30px] lg:min-w-0 lg:px-1.5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
    : `${CONTROL_BASE} ${BUTTON_SIZE.md}`;
  return `${shape} aria-disabled:cursor-not-allowed aria-disabled:opacity-50 motion-safe:transition-colors ${
    pressed
      ? "border-border-strong bg-surface-2 font-semibold text-text forced-colors:border-2"
      : // 바꾸는 중(aria-disabled)에는 hover에 반응하지 않습니다(QA-493 — 단추와 같은 이유).
        "border-border font-medium text-text-2 not-aria-disabled:hover:border-border-strong not-aria-disabled:hover:text-text"
  }`;
}

export type UnderlineTabSize = "md" | "sm";

// md는 하위 메뉴 줄(좁은 화면 48px·15px, 넓은 화면 40px·14px), sm은 화면 안의 탭 줄(44px, 넓은 화면 30px — 정보 검색 결과 탭과 같음).
const UNDERLINE_SIZE: Record<UnderlineTabSize, string> = {
  md: "min-h-12 text-[15px] lg:min-h-10 lg:text-sm",
  sm: "min-h-11 text-sm lg:min-h-[30px]",
};

// 줄을 바꾸는 탭(wrap)은 1px 높습니다 — 탭이 -mb-px로 다음 줄과 1px 겹쳐 다음 줄 탭이 그 자리를 덮으므로(누르기가 그 탭에 감), 겹친 1px을 빼도
// 누르는 자리가 한 줄 탭과 같고(sm 44px·lg 30px — 원칙 A8), 한 줄로 들어갈 때 탭 줄 높이(45·31px)도 한 줄 탭 줄과 같습니다(2026-11-16 결정 1 검토 지적 —
// 예전 44·30px에서는 첫 줄 탭이 43·29px만 받고 줄도 1px 낮았음).
const UNDERLINE_WRAP_SIZE: Record<UnderlineTabSize, string> = {
  md: "min-h-[49px] text-[15px] lg:min-h-[41px] lg:text-sm",
  sm: "min-h-[45px] text-sm lg:min-h-[31px]",
};

/**
 * 밑줄 탭(하위 메뉴 줄·모의매매 화면 탭·공용 Tabs) — 탭 모양은 이것 하나입니다(실행 명세 §6). 지금 탭은 강조 파랑 2px 밑줄과 굵은 글
 * (셸·탐색은 누를 수 있는 것이라 강조 파랑을 씀 — A1), 나머지는 보조 글. 줄을 바꾸지 않고 감싼 줄이 가로로 스크롤합니다. `sm`은 하위 메뉴 줄
 * 아래 두 번째 탭 줄(모의매매 탭)용으로 한 단계 작게 둬 두 줄의 위계를 가릅니다.
 * 나머지 탭의 투명 밑줄(글이 위아래로 흔들리지 않게 둔 자리)은 고대비(forced-colors) 모드에서 시스템 글자색으로 칠해져 모든 탭에 밑줄이
 * 생기므로, 그 모드에서는 지웁니다 — 지금 탭만 밑줄과 굵은 글이 남습니다(명세 D9, headless 크롬 forced-colors 흉내로 확인).
 * `wrap`은 줄을 바꿔도 되는 탭 줄(공용 Tabs의 `wrap` — 홈 시장 패널 하나)의 탭입니다: 탭마다 제 줄의 바닥선을 지녀, 줄이 둘이어도 고른 탭의 밑줄이
 * 제 줄 선 위에 놓입니다(아래 설명). 넓이·글 크기는 같고 높이는 1px 높습니다(UNDERLINE_WRAP_SIZE — 겹친 1px을 빼도 누르는 자리가 같게).
 */
export function underlineTabClasses(active: boolean, size: UnderlineTabSize = "md", wrap = false): string {
  const shape = `inline-flex shrink-0 items-center gap-1 whitespace-nowrap px-3 ${(wrap ? UNDERLINE_WRAP_SIZE : UNDERLINE_SIZE)[size]} ${SELECT_MOTION} focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus`;
  if (wrap) {
    // 두 줄 허용(공용 Tabs `wrap`): 탭마다 자기 줄의 바닥선을 지닙니다 — 나머지 탭은 1px 경계선(+ 1px 아래 여백으로 지금 탭의 2px 밑줄과 같은 높이 —
    // 글이 위아래로 흔들리지 않음), 지금 탭은 그 자리에 강조 파랑 2px. 탭 줄 바닥선(감싼 tablist의 1px 아래 경계)과는 -mb-px로 겹쳐, 마지막 줄의 선이
    // 두 겹(2px)이 되지 않고 다음 줄이 앞 줄 바닥선에 붙습니다. 그래서 첫 줄에서 고른 탭의 밑줄이 둘째 줄 위에 떠 보이지 않고 제 줄의 선 위에 놓입니다.
    // 고대비(forced-colors)에서는 두 선이 모두 남아 줄마다 바닥선이 그대로 보이고, 지금 탭의 밑줄은 시스템 강조색(Highlight — 작성자가 지정한 시스템 색은
    // 그 모드에서도 남음)으로 그려 나머지 탭의 1px 선(시스템 글자색)과 두께·굵은 글만이 아니라 색으로도 갈립니다(2026-11-16 결정 1 검토 지적).
    return `${shape} -mb-px ${
      active
        ? "border-b-2 border-accent font-semibold text-text forced-colors:border-[Highlight]"
        : "border-b border-border pb-px font-normal text-text-2 hover:text-text"
    }`;
  }
  return `${shape} border-b-2 ${
    active ? "border-accent font-semibold text-text" : "border-transparent font-normal text-text-2 hover:text-text forced-colors:border-b-0"
  }`;
}

/** 면(패널) — 1px 경계, 모서리 4px(정보 검색 화면에서 옮김 — 공용 Panel과 같은 바탕·경계). */
export const PANEL_CLASSES = "rounded-card border border-border bg-surface";

/*
 * 대상 화면의 칸 틀 — 정보 검색 대상 화면(search/entityGrid.ts)에서 옮긴 클래스 두 개. 칸 틀 패턴(components/patterns/SplitPane)과 정보 검색
 * (entityGrid.ts가 같은 이름 ENTITY_GRID·ENTITY_LEFT로 다시 내보냄)이 함께 씁니다 — 정보 검색이 패턴 배럴 전체를 싣지 않게 이 순수 모듈에 둡니다
 * (겉모습 고정 — components/screens/search/__tests__/entityGridPin.test.ts). 칸 폭과 기준 폭의 셈은 entityGrid.ts 머리 주석에 있습니다.
 */

/** 칸 틀 — lg 두 칸, xl 세 칸. 자식은 왼쪽(ENTITY_FRAME_LEFT) · 가운데 · 오른쪽 차례입니다(바뀌는 것은 자리뿐 — 읽는 차례·Tab 차례는 그대로). */
export const ENTITY_FRAME =
  "lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:grid-rows-[auto_1fr] xl:grid-cols-[13rem_minmax(0,1fr)_18rem] xl:grid-rows-none";

/** 왼쪽 칸 — lg는 가운데와 그 아래 오른쪽 칸의 두 줄을 차지합니다. */
export const ENTITY_FRAME_LEFT = "lg:row-span-2 xl:row-span-1";

/**
 * 고른 행의 왼쪽 막대(자산 행·검색 결과 — 감싼 행이 relative) — 3px 잉크(데이터 영역이라 강조 파랑 아님, 원칙 A1). 고른 행의 바탕(surface-2)과
 * 막대의 바탕색은 고대비(forced-colors) 모드에서 지워지므로, 그 모드에서는 같은 폭의 왼쪽 테두리로 그립니다 — 테두리는 시스템 글자색으로
 * 남습니다(명세 D9).
 */
export const SELECTED_BAR = "absolute inset-y-1 left-0 w-[3px] rounded-r bg-text forced-colors:border-l-[3px]";
