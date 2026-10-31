"use client";

import { ReactNode } from "react";
import { deltaColor, EMPTY, formatAge, formatKst, withoutLeadingIcon } from "@/lib/format";
import { buttonClasses, FOCUS_RING, inputClasses, type ButtonSize, type ButtonVariant } from "./classes";
import { AlertTriangleIcon, CheckCircleIcon, ChevronDownIcon, ClockIcon, InfoIcon, LineIcon, SpinnerIcon, XCircleIcon } from "./icons";

// 클래스 문자열은 서버 컴포넌트도 부를 수 있게 순수 모듈(classes.ts)에 두고 여기서 다시 내보냅니다.
export {
  buttonClasses,
  filterChipClasses,
  FOCUS_RING,
  inputClasses,
  pillTabClasses,
  SEGMENT_TRACK,
  segmentClasses,
  underlineTabClasses,
  type ButtonSize,
  type ButtonVariant,
  type InputSize,
  type UnderlineTabSize,
} from "./classes";

/**
 * 섹션 카드 컨테이너.
 *
 * @param source 이 카드 숫자의 출처. 모든 카드가 같은 모양("출처 · …")으로 적도록 여기서 그립니다.
 *               출처 문구는 `lib/sources.ts`에 모아 두었습니다 — 화면마다 따로 적으면 표기가 갈립니다.
 */
export function Card({
  title,
  subtitle,
  source,
  actions,
  children,
  className = "",
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  source?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-card border border-border bg-surface p-5 lg:p-6 ${className}`}>
      {(title || actions || source) && (
        <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {/* 카드 제목에는 아이콘을 쓰지 않습니다 — 데이터에서 온 제목도 앞 아이콘을 뗍니다. */}
            {title && (
              <h2 className="text-title-3 text-text">
                {typeof title === "string" ? withoutLeadingIcon(title) : title}
              </h2>
            )}
            {subtitle && <p className="mt-1 text-[13px] leading-5 text-text-2">{subtitle}</p>}
            {source && <SourceLine>{source}</SourceLine>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/**
 * 화면 머리 — h1(좁은 화면 24px, sm 이상 글자 단계 title-1 28px) · 설명(15px 보조 글) · 오른쪽 동작(신선도·고르기·단추).
 * 화면마다 h1 모양을 따로 적던 곳을 하나로 모읍니다(명세 §7-1). 설명 아래에 덧붙일 줄(예: 매크로 자동 갱신 안내)은 children으로 넘깁니다.
 * 동작은 넓은 화면에서 제목 묶음의 아래 끝에 맞춰 오른쪽에 두고(이름표가 위에 있는 고르기 상자의 상자가 설명 줄과 한 줄에 놓임),
 * 자리가 모자라면 제목 아래로 내려갑니다.
 */
export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-text sm:text-title-1">{title}</h1>
        {description ? <p className="mt-1 text-body-md text-text-2">{description}</p> : null}
        {children}
      </div>
      {actions ? <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** 지표 카드 (구버전 st.metric에 해당) — 겉모양은 새 통계 타일(patterns/StatTile)과 같습니다. */
export function Metric({
  label,
  value,
  delta,
  deltaText,
  deltaDigits,
  caption,
  note,
  source,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  delta?: number | null;
  deltaText?: string;
  /** deltaText에 찍는 소수 자릿수 — 색도 같은 자릿수로 판단합니다("0.00인데 파란색" 방지). */
  deltaDigits?: number;
  caption?: ReactNode;
  note?: ReactNode;
  /** 이 지표 하나의 출처 (카드 전체 출처와 다를 때) */
  source?: ReactNode;
  tone?: string;
}) {
  return (
    <div className="min-w-0 rounded-control border border-border bg-surface p-4">
      <div className="text-[13px] font-medium text-text-2">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone ?? "text-text"}`}>
        {value}
      </div>
      {(deltaText || delta !== undefined) && (
        <div className={`mt-1 text-sm tabular-nums ${deltaColor(delta, deltaDigits)}`}>
          {deltaText ?? EMPTY}
        </div>
      )}
      {caption && <div className="mt-1 text-xs text-text-3">{caption}</div>}
      {note && <div className="mt-2 text-xs leading-relaxed text-text-3">{note}</div>}
      {source && <SourceLine>{source}</SourceLine>}
    </div>
  );
}

/**
 * "출처 · …" 한 줄. 카드·지표가 같은 모양을 쓰게 합니다 — 테두리 상자 없는 캡션(새 패턴의 ProvenanceBadge와 같은 12px text-3).
 * '출처'와 가운뎃점은 따로 span이라 출처 글(children)이 이 줄의 글자로 그대로 남습니다(getByText가 출처 글로 찾음).
 */
export function SourceLine({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1 text-xs leading-4 text-text-3">
      <span>출처</span>
      <span aria-hidden="true"> · </span>
      {children}
    </p>
  );
}

/**
 * 데이터 신선도 배지 — "언제 수집한 값인지"를 항상 함께 보여 줍니다.
 *
 * <p>경과 시간("1초 전")이 아니라 <b>수집한 시각</b>을 적습니다. 경과 시간은
 * 화면을 연 순간을 기준으로 계산되므로, 대시보드를 띄워 둔 채 한참 뒤에 보면
 * "1초 전"이라고 적혀 있어도 실제로는 한 시간 전 값일 수 있습니다. 시각은
 * 화면이 멈춰 있어도 틀리지 않습니다. 경과 시간은 배지에 마우스를 올리면
 * 보이도록 남겨 둡니다.
 */
export function Freshness({
  collectedAt,
  ageSeconds,
  stale,
  refreshError,
}: {
  /** 백엔드가 KST로 찍어 준 수집 시각 문자열 (collectedAtKst). */
  collectedAt?: string | null;
  ageSeconds?: number | null;
  stale?: boolean;
  /**
   * 자동 갱신·다시 읽기가 실패했으면 그 문구(useApi의 refreshError). 화면은 앞서 받은 값을 그대로 보이므로, 그것이
   * 지금 값이 아니라는 것을 알려야 합니다 — 예전에는 아무 표시가 없었습니다(QA-050).
   */
  refreshError?: string | null;
}) {
  if (!collectedAt && ageSeconds === undefined && !refreshError) {
    return null;
  }
  const age = formatAge(ageSeconds);

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {refreshError && (
        // 글은 이 span의 글자 그대로 둡니다(아이콘·sr 머리말은 따로) — '새로 읽지 못함'으로 찾은 요소가 title을 가진 이 알약입니다.
        <span
          className="inline-flex items-center gap-1 rounded-full border border-warn/30 bg-warn-tint px-2 py-0.5 text-xs text-warn"
          title={`${refreshError} — 앞서 받은 값을 보여 줍니다`}
          role="status"
        >
          <AlertTriangleIcon size={12} />
          <span className="sr-only">주의: </span>
          새로 읽지 못함
        </span>
      )}
      {(collectedAt || ageSeconds !== undefined) && (
        <FreshnessBadge collectedAt={collectedAt} age={age} stale={stale} />
      )}
    </span>
  );
}

function FreshnessBadge({ collectedAt, age, stale }: { collectedAt?: string | null; age: string; stale?: boolean }) {
  const title = collectedAt ? `${formatKst(collectedAt)} (한국 시간) · 조회 시점 기준 ${age}` : undefined;
  // 시각을 모르면 그때만 경과 시간으로 대신합니다 — 아무것도 안 적는 것보다 낫습니다.
  const when = <span className="tabular-nums">{collectedAt ? formatKst(collectedAt) : age}</span>;
  if (stale) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-warn/30 bg-warn-tint px-2 py-0.5 text-xs text-warn"
        title={title}
      >
        <AlertTriangleIcon size={12} />
        <span className="sr-only">주의: </span>
        오래된 저장본
        {when}
      </span>
    );
  }
  // 평상시는 알약 없이 캡션 한 줄 — 시계 아이콘 + '수집' + 시각.
  return (
    <span className="inline-flex items-center gap-1 text-xs text-text-3" title={title}>
      <ClockIcon size={12} />
      수집
      {when}
    </span>
  );
}

/**
 * 배너 — 추정치·이력 대체처럼 "값의 성격"을 알리거나(warn), 실패·심각한 주의(danger)·안내(info)·완료(ok)를 알릴 때.
 * 바탕은 모두 불투명 틴트(globals.css의 *-tint)라 카드 밖 페이지 바탕 위에 놓여도 글자 대비가 같습니다(톤 글자 4.7:1 이상).
 * 안내(info)는 글을 본문색으로 둡니다 — 강조 파랑 글자는 링크로 읽히고 하락 파랑과 구분되지 않습니다(명세 원칙 A1).
 *
 * 앞에 톤 아이콘(장식)을 둡니다 — 예전에 부르는 쪽이 글 앞에 붙이던 경고 이모지 자리. 주의(warn)·심각(danger)은 낭독기에 '주의: '를
 * 먼저 읽힙니다(아이콘은 aria-hidden). danger는 실패만이 아니라 추정치 모드·금리 역전 같은 심각한 주의에도 쓰여 '오류'라 읽히지 않게 합니다.
 * 글은 톤 글자색을 가진 div로 감쌉니다 — 글로 찾은 요소(또는 그 closest div)가 톤 글자색을 그대로 가집니다(명세 D8 b).
 *
 * @param icon 톤 기본 아이콘 대신 쓸 아이콘(예: 잠금). false면 아이콘 없이 글만.
 */
export function Banner({
  tone = "warn",
  icon,
  children,
}: {
  tone?: "warn" | "danger" | "info" | "ok";
  icon?: ReactNode | false;
  children: ReactNode;
}) {
  const style = BANNER_TONES[tone];
  return (
    <div className={`flex items-start gap-2.5 rounded-control border px-4 py-3 text-sm leading-relaxed ${style.box}`}>
      {icon === false ? null : <LineIcon className={style.icon}>{icon ?? style.glyph}</LineIcon>}
      {style.srPrefix && <span className="sr-only">{style.srPrefix}</span>}
      <div className={`min-w-0 flex-1 ${style.text}`}>{children}</div>
    </div>
  );
}

const BANNER_TONES = {
  warn: { box: "border-warn/30 bg-warn-tint text-warn", text: "text-warn", icon: "", glyph: <AlertTriangleIcon size={16} />, srPrefix: "주의: " },
  danger: { box: "border-danger/30 bg-danger-tint text-danger", text: "text-danger", icon: "", glyph: <AlertTriangleIcon size={16} />, srPrefix: "주의: " },
  // 안내의 아이콘만 강조색 — 안내 톤의 표지이고, 글은 본문색입니다.
  info: { box: "border-accent/25 bg-accent-tint text-text", text: "text-text", icon: "text-accent", glyph: <InfoIcon size={16} />, srPrefix: "" },
  ok: { box: "border-ok/30 bg-ok-tint text-ok", text: "text-ok", icon: "", glyph: <CheckCircleIcon size={16} />, srPrefix: "" },
} as const;

export function Loading({ label = "불러오는 중…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-text-3">
      {/* 도는 것은 움직임 줄이기(prefers-reduced-motion)가 꺼져 있을 때만 — 켜져 있으면 멈춘 호와 글 */}
      <SpinnerIcon size={16} className="motion-safe:animate-spin" />
      {label}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-control bg-surface-2/60 px-4 py-10 text-center text-sm text-text-2">
      {message}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-control border border-danger/30 bg-danger-tint px-4 py-4 text-sm text-danger">
      <p className="flex items-start gap-2">
        <XCircleIcon size={16} className="mt-0.5" />
        <span className="min-w-0">{message}</span>
      </p>
      {onRetry && (
        <button type="button" onClick={onRetry} className={`mt-3 ${buttonClasses("secondary", "sm")}`}>
          다시 시도
        </button>
      )}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  size = "md",
  icon,
  disabled,
  type = "button",
  className = "",
  expanded,
}: {
  children: ReactNode;
  onClick?: () => void;
  /** "default"는 옛 이름으로 secondary와 같습니다 — variant를 주지 않은 곳(약 48곳)을 한꺼번에 고치지 않으려고 남깁니다. */
  variant?: ButtonVariant | "default";
  size?: ButtonSize;
  /** 글 앞 아이콘(장식 — components/ui/icons의 aria-hidden 아이콘). 뜻은 단추 글이 나릅니다. */
  icon?: ReactNode;
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
  /** 펼치고 접는 버튼이면 지금 펼쳐졌는지(aria-expanded). 아니면 넘기지 않습니다. */
  expanded?: boolean;
}) {
  return (
    <button
      aria-expanded={expanded}
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${buttonClasses(variant === "default" ? "secondary" : variant, size)} ${className}`.trim()}
    >
      {icon}
      {children}
    </button>
  );
}

export function Select({
  label,
  value,
  onChange,
  options,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** 저장 중처럼 잠깐 고를 수 없을 때. */
  disabled?: boolean;
  /**
   * disabled를 준 항목은 목록에 보이지만 고를 수 없습니다.
   *
   * 아예 빼지 않는 이유 — 원래 있던 선택지가 소리 없이 사라지면 "내 화면이
   * 이상한가?"가 됩니다. 남겨 두고 왜 못 고르는지 라벨에 적는 편이 낫습니다.
   */
  options: { value: string; label: string; disabled?: boolean }[];
}) {
  /*
    ⚠️ 폭을 반드시 묶어 둡니다.
    select는 가장 긴 option에 맞춰 스스로 넓어집니다. AI 엔진 목록처럼 라벨이
    긴 선택지가 들어오자 폭이 533px이 되어, 390px 화면에서 페이지 전체가
    가로로 스크롤됐습니다. 좁은 화면에서는 한 줄을 다 쓰고, 넓은 화면에서는
    내용만큼만 차지하되 화면을 넘지 않게 합니다.
  */
  return (
    <label className="flex min-w-0 max-w-full flex-col gap-1 text-[13px] text-text-2 sm:w-auto">
      {label}
      {/* 브라우저 화살표 대신 아이콘(appearance-none) — 고대비 모드에서도 글자색으로 보입니다. 폭 묶기는 감싼 칸이 합니다. */}
      <span className="relative block w-full max-w-full sm:max-w-[22rem]">
        <select
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={`w-full max-w-full appearance-none pr-9 ${inputClasses()}`}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDownIcon size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-3" />
      </span>
    </label>
  );
}

/**
 * 단순 테이블. 컬럼 정의로 정렬/포맷을 제어합니다.
 *
 * @param label 표 이름 — 좌우 스크롤 상자(region)의 이름 "{label} (좌우 스크롤)"이 됩니다. 한 화면에 표가 여럿이면 이름을 줘야
 *              랜드마크 목록에서 서로 구별됩니다(주지 않으면 "표 (좌우 스크롤)" — 새 DataTable의 caption과 같은 규칙).
 */
export function Table<T>({
  columns,
  rows,
  emptyMessage = "표시할 데이터가 없습니다.",
  rowKey,
  label,
}: {
  columns: {
    key: string;
    header: ReactNode;
    align?: "left" | "right";
    render: (row: T, index: number) => ReactNode;
    className?: string;
  }[];
  rows: T[];
  emptyMessage?: string;
  rowKey: (row: T, index: number) => string;
  label?: string;
}) {
  if (rows.length === 0) {
    return <EmptyState message={emptyMessage} />;
  }

  return (
    <>
      {/*
        표는 좁은 화면에서 좌우로 스크롤됩니다. 스크롤바가 보이지 않는 기기에서는
        오른쪽에 열이 더 있다는 사실을 알 수 없어, 폰에서만 안내를 한 줄 띄웁니다.
      */}
      <p className="mb-1 text-xs text-text-3 sm:hidden">← 표를 좌우로 넘겨 보세요</p>
      <div className={`overflow-x-auto ${FOCUS_RING}`} tabIndex={0} role="region" aria-label={`${label ?? "표"} (좌우 스크롤)`}>
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            {/* 머리는 13px 보조 글 — 대문자·자간은 한국어 머리에서 뜻이 없어 뺐습니다. */}
            <tr className="border-b border-border text-[13px] text-text-2">
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={`px-3 py-2.5 font-medium ${
                    column.align === "right" ? "text-right" : "text-left"
                  } ${column.className ?? ""}`}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={rowKey(row, index)}
                className="border-b border-border last:border-0 hover:bg-surface-2 motion-safe:transition-colors"
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={`px-3 py-3 tabular-nums ${
                      column.align === "right" ? "text-right" : "text-left"
                    } ${column.className ?? ""}`}
                  >
                    {column.render(row, index)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function SourceBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-xs leading-4 text-text-2">
      {children}
    </span>
  );
}
