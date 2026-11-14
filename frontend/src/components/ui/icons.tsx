import type { ReactNode } from "react";

/*
 * 화면 아이콘 — 아이콘 패키지를 들이지 않고 SVG 몇 줄로 둡니다(24 뷰박스, 선 굵기 2, 둥근 끝, 색은 글자색 currentColor).
 * 이모지 대신 씁니다(docs/specs/2026-10-31-v2-coinbase-ui.md 원칙 A7). 기본은 장식(aria-hidden)이고 뜻은 옆의 글이나 sr-only 글이 나릅니다.
 *
 * label을 주면 이름 있는 그림(role="img" + aria-label)이 됩니다 — 잠금처럼 아이콘 혼자 뜻을 나를 때만 씁니다.
 * <title>은 두지 않습니다: 제목 글이 감싼 링크·단추의 textContent에 섞여("AI 종합 분석유료 등급 기능") 글로 비교하는 곳이 깨지고,
 * 마우스 설명이 필요하면 감싼 요소의 title 속성에 둡니다.
 */

export type IconProps = {
  /** 한 변의 픽셀. */
  size?: number;
  className?: string;
  /** 주면 이름 있는 그림(role="img"·aria-label). 없으면 장식(aria-hidden). */
  label?: string;
};

/** 아이콘의 바탕 SVG — 셸의 탭 아이콘(shell/icons.tsx)도 이것을 씁니다. */
export function IconBase({ size = 16, className = "", label, children }: IconProps & { children: ReactNode }) {
  const naming = label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const };
  return (
    <svg
      {...naming}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      className={`shrink-0 ${className}`.trim()}
    >
      {children}
    </svg>
  );
}

/** 주의(경고 삼각형) — 예전 [경고] 이모지 자리. */
export function AlertTriangleIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3.5 2.5 20h19z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.5v.01" />
    </IconBase>
  );
}

/** 안내(원 안의 i). */
export function InfoIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <path d="M12 7.5v.01" />
    </IconBase>
  );
}

/** 정상(원 안의 체크) — 예전 [확인] 이모지 자리. */
export function CheckCircleIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.5 3 3 5-6" />
    </IconBase>
  );
}

/** 오류·실패(원 안의 X) — 예전 [가위표] 이모지 자리. */
export function XCircleIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </IconBase>
  );
}

/** 없음·키 없음(점선 원) — 예전 [흰원] 이모지 자리. */
export function CircleDashedIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="9" strokeDasharray="3 3.1" />
    </IconBase>
  );
}

/** 건너뜀 — 예전 [건너뜀] 이모지 자리. */
export function SkipIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 5.5 14 12l-9 6.5z" />
      <path d="M19 5v14" />
    </IconBase>
  );
}

export function MinusIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 12h14" />
    </IconBase>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 5v14M5 12h14" />
    </IconBase>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </IconBase>
  );
}

/** 닫기(X) — 대화상자·토스트의 닫기 단추가 함께 씁니다. */
export function XIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </IconBase>
  );
}

/** 잠금 — 유료 등급 기능 표시. 혼자 뜻을 나르므로 부르는 쪽이 label을 줍니다. */
export function LockIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </IconBase>
  );
}

/** 수집 시각 — 예전 [시계] 이모지 자리. */
export function ClockIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </IconBase>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m6 9 6 6 6-6" />
    </IconBase>
  );
}

export function ChevronUpIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m6 15 6-6 6 6" />
    </IconBase>
  );
}

export function ChevronRightIcon({ size = 16, ...props }: IconProps) {
  return (
    <IconBase size={size} {...props}>
      <path d="M9 6l6 6-6 6" />
    </IconBase>
  );
}

export function SearchIcon({ size = 16, ...props }: IconProps) {
  return (
    <IconBase size={size} {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </IconBase>
  );
}

export function BellIcon({ size = 18, ...props }: IconProps) {
  return (
    <IconBase size={size} {...props}>
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </IconBase>
  );
}

/** 기업(사무 건물) — 정보 검색의 대상 종류. */
export function BuildingIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="5" y="3" width="14" height="18" rx="1" />
      <path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2" />
      <path d="M10.5 21v-3h3v3" />
    </IconBase>
  );
}

/** 기관(기둥 있는 건물 — 13F 기관 등) — 정보 검색의 대상 종류. */
export function LandmarkIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 21h18M3 9.5 12 4l9 5.5z" />
      <path d="M6 12.5V18M10 12.5V18M14 12.5V18M18 12.5V18" />
    </IconBase>
  );
}

/** 사람 — 정보 검색의 대상 종류. */
export function PersonIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
    </IconBase>
  );
}

/** 주제(꼬리표) — 정보 검색의 대상 종류(어디에도 없는 검색어). */
export function TagIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 4v7.2a1 1 0 0 0 .3.7l9.8 9.8a1 1 0 0 0 1.4 0l6.2-6.2a1 1 0 0 0 0-1.4L10.9 4.3a1 1 0 0 0-.7-.3H4a1 1 0 0 0-1 1z" />
      <circle cx="7.5" cy="8.5" r="1.5" />
    </IconBase>
  );
}

/**
 * 별 — 정보 검색의 관심 대상 등록 단추. filled면 별을 글자색으로 채웁니다(등록됨). 뜻은 옆의 글('관심 대상 등록'·'해제')이 나르고,
 * 채움만으로 상태를 알리지 않습니다(명세 원칙 A5).
 */
export function StarIcon({ filled = false, ...props }: IconProps & { filled?: boolean }) {
  return (
    <IconBase {...props}>
      <path
        d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"
        {...(filled ? { fill: "currentColor" } : {})}
      />
    </IconBase>
  );
}

/** 바깥 링크(새 창) — 글자 '↗'(그림 문자라 쓰지 않음) 대신. 뜻은 옆 글이나 sr-only '(새 창)'이 나릅니다. */
export function ExternalLinkIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </IconBase>
  );
}

/** 새로 읽기(돌아가는 화살표). */
export function RefreshIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v4h-4" />
    </IconBase>
  );
}

/** 불러오는 중 — 돌리는 것은 부르는 쪽이 motion-safe:animate-spin으로(움직임 줄이기면 멈춘 호). */
export function SpinnerIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M21 12a9 9 0 1 1-6.22-8.56" />
    </IconBase>
  );
}

/** 상태 톤 — 상태 점·상태 글이 함께 씁니다. 색은 늘 글·sr-only 글과 함께 갑니다(색만으로 뜻을 전하지 않음). */
export type StatusTone = "ok" | "warn" | "danger" | "neutral";

const TONE_TEXT: Record<StatusTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  neutral: "text-text-3",
};

/**
 * 상태 점(8px) — 장 상태 칩·기기 목록처럼 옆의 글이 뜻을 나를 때의 작은 표지. 장식이라 aria-hidden입니다.
 * 바탕색이 아니라 굵은 테두리(border-current)로 칠합니다 — 고대비(forced-colors)에서는 바탕색이 지워져 점이 사라지지만 테두리는 시스템 글자색으로 남습니다.
 */
export function StatusDot({ tone, className = "" }: { tone: StatusTone; className?: string }) {
  return <span aria-hidden="true" className={`inline-block size-2 shrink-0 rounded-full border-4 border-current ${TONE_TEXT[tone]} ${className}`.trim()} />;
}

const STATUS_ICON: Record<StatusTone, typeof CheckCircleIcon> = {
  ok: CheckCircleIcon,
  warn: AlertTriangleIcon,
  danger: XCircleIcon,
  neutral: CircleDashedIcon,
};

/** 낭독기가 글 앞에 읽는 머리말 — 아이콘은 aria-hidden이라 '주의'·'오류'를 글로 남깁니다. 정상·없음은 글 자체가 뜻을 나릅니다. */
const STATUS_SR_PREFIX: Record<StatusTone, string> = {
  ok: "",
  warn: "주의: ",
  danger: "오류: ",
  neutral: "",
};

/**
 * 상태 글 — 아이콘 + sr-only 머리말 + 글. 셋을 따로 두어 getByText가 글 span만 찾습니다(아이콘·머리말이 글에 섞이지 않음).
 * 예전 '[경고] 이전 값'·'[확인] 정상'처럼 이모지를 글 앞에 붙이던 자리에 씁니다.
 */
export function StatusText({
  tone,
  children,
  icon,
  iconSize = 14,
  colorText = true,
  srPrefix,
  className = "",
}: {
  tone: StatusTone;
  children: ReactNode;
  /** 톤 기본 아이콘 대신 쓸 아이콘(예: 건너뜀). false면 아이콘 없이 글만. */
  icon?: ReactNode | false;
  /** 톤 기본 아이콘의 크기 — 12px 글 옆에는 12. */
  iconSize?: number;
  /** false면 글은 놓인 자리의 색 그대로(보조 글 안의 주의 표시), 아이콘만 톤 색. */
  colorText?: boolean;
  /** 톤 기본 머리말 대신 쓸 sr-only 머리말. */
  srPrefix?: string;
  className?: string;
}) {
  const Icon = STATUS_ICON[tone];
  const prefix = srPrefix ?? STATUS_SR_PREFIX[tone];
  return (
    <span className={`inline-flex items-start gap-1.5 ${colorText ? TONE_TEXT[tone] : ""} ${className}`.replace(/\s+/g, " ").trim()}>
      {icon === false ? null : <LineIcon className={colorText ? "" : TONE_TEXT[tone]}>{icon ?? <Icon size={iconSize} />}</LineIcon>}
      {prefix && <span className="sr-only">{prefix}</span>}
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/**
 * 상태 아이콘 하나 — 표 칸처럼 글 없이 아이콘만 둘 자리. 뜻(label)은 sr-only 글과 마우스 설명(title)이 나릅니다.
 * 옆에 같은 뜻의 글이 이미 보이면 이것 대신 장식 아이콘(aria-hidden)만 씁니다(같은 말을 두 번 읽히지 않게).
 */
export function StatusIcon({
  tone,
  label,
  icon,
  size = 14,
}: {
  tone: StatusTone;
  label: string;
  /** 톤 기본 아이콘 대신 쓸 아이콘(예: 인증됨의 체크). */
  icon?: ReactNode;
  size?: number;
}) {
  const Icon = STATUS_ICON[tone];
  return (
    <span className={`inline-flex shrink-0 items-center ${TONE_TEXT[tone]}`} title={label}>
      {icon ?? <Icon size={size} />}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * 글 첫 줄의 가운데에 아이콘을 둡니다 — 한 줄 높이(1lh)의 칸 안에서 가운데 정렬. 글이 여러 줄로 접혀도 아이콘이 첫 줄 옆에 남습니다
 * (items-center면 여러 줄 글의 한가운데로 내려감). 상태 글·배너가 함께 씁니다.
 */
export function LineIcon({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`flex h-[1lh] shrink-0 items-center ${className}`.trim()}>{children}</span>;
}
