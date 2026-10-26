"use client";

import { ReactNode } from "react";
import { deltaColor, EMPTY, formatAge, formatKst, withoutLeadingIcon } from "@/lib/format";

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
    <section
      className={`rounded-lg border border-border bg-surface p-4 sm:p-5 ${className}`}
    >
      {(title || actions || source) && (
        <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            {/* 카드 제목에는 아이콘을 쓰지 않습니다 — 데이터에서 온 제목도 앞 아이콘을 뗍니다. */}
            {title && (
              <h2 className="text-base font-semibold text-bright">
                {typeof title === "string" ? withoutLeadingIcon(title) : title}
              </h2>
            )}
            {subtitle && <p className="mt-1 text-xs text-muted">{subtitle}</p>}
            {source && <SourceLine>{source}</SourceLine>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** 지표 카드 (구버전 st.metric에 해당). */
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
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${tone ?? "text-bright"}`}>
        {value}
      </div>
      {(deltaText || delta !== undefined) && (
        <div className={`mt-1 text-xs tabular-nums ${deltaColor(delta, deltaDigits)}`}>
          {deltaText ?? EMPTY}
        </div>
      )}
      {caption && <div className="mt-1 text-[11px] text-muted">{caption}</div>}
      {note && <div className="mt-2 text-[11px] leading-relaxed text-muted">{note}</div>}
      {source && <SourceLine>{source}</SourceLine>}
    </div>
  );
}

/** "출처 · …" 한 줄. 카드·지표가 같은 모양을 쓰게 합니다. */
export function SourceLine({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1 text-[11px] text-muted">
      <span className="mr-1 rounded-sm border border-border px-1 py-px text-[10px]">출처</span>
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
        <span
          className="inline-flex items-center rounded-sm border border-warn/40 bg-warn/10 px-2 py-0.5 text-[11px] text-warn"
          title={`${refreshError} — 앞서 받은 값을 보여 줍니다`}
          role="status"
        >
          ⚠️ 새로 읽지 못함
        </span>
      )}
      {(collectedAt || ageSeconds !== undefined) && (
        <FreshnessBadge collectedAt={collectedAt} age={age} stale={stale} />
      )}
    </span>
  );
}

function FreshnessBadge({ collectedAt, age, stale }: { collectedAt?: string | null; age: string; stale?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[11px] ${
        stale
          ? "border-warn/40 bg-warn/10 text-warn"
          : "border-border bg-surface-hover text-muted"
      }`}
      title={collectedAt ? `${formatKst(collectedAt)} (한국 시간) · 조회 시점 기준 ${age}` : undefined}
    >
      {stale ? "⚠️ 오래된 저장본" : "🕒 수집"}
      {/* 시각을 모르면 그때만 경과 시간으로 대신합니다 — 아무것도 안 적는 것보다 낫습니다. */}
      <span className="tabular-nums">
        {collectedAt ? formatKst(collectedAt) : age}
      </span>
    </span>
  );
}

/** 경고 배너 — 추정치·이력 대체처럼 "값의 성격"을 알려야 할 때. */
export function Banner({
  tone = "warn",
  children,
}: {
  tone?: "warn" | "danger" | "info";
  children: ReactNode;
}) {
  const palette = {
    warn: "border-warn/40 bg-warn/10 text-warn",
    danger: "border-danger/40 bg-danger/10 text-danger",
    info: "border-accent/40 bg-accent/10 text-accent",
  }[tone];

  return (
    <div className={`rounded-lg border px-4 py-3 text-sm leading-relaxed ${palette}`}>
      {children}
    </div>
  );
}

export function Loading({ label = "불러오는 중…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-muted">
      <span className="h-3 w-3 animate-pulse rounded-full bg-accent" />
      {label}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted">
      {message}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-4 text-sm text-danger">
      <p>{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded-sm border border-danger/40 px-3 py-1 text-xs hover:bg-danger/20"
        >
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
  disabled,
  type = "button",
  className = "",
  expanded,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
  /** 펼치고 접는 버튼이면 지금 펼쳐졌는지(aria-expanded). 아니면 넘기지 않습니다. */
  expanded?: boolean;
}) {
  const palette = {
    default: "border-border bg-surface-hover text-body hover:border-muted hover:text-bright",
    primary: "border-accent/60 bg-accent/15 text-accent hover:bg-accent/25",
    ghost: "border-transparent bg-transparent text-muted hover:text-bright",
  }[variant];

  return (
    <button
      aria-expanded={expanded}
      type={type}
      onClick={onClick}
      disabled={disabled}
      // focus-visible 링 — 키보드로 조작할 때 지금 어디에 있는지 보여 줍니다.
      // 브라우저 기본 외곽선은 이 어두운 배경에서 거의 보이지 않았습니다.
      className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-canvas ${palette} ${className}`}
    >
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
    <label className="flex min-w-0 max-w-full flex-col gap-1 text-xs text-muted sm:w-auto">
      {label}
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="w-full max-w-full disabled:opacity-60 rounded-md border border-border bg-surface-hover px-2 py-1.5 text-sm text-body outline-hidden focus:border-accent focus-visible:ring-2 focus-visible:ring-accent sm:max-w-[22rem]"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 단순 테이블. 컬럼 정의로 정렬/포맷을 제어합니다. */
export function Table<T>({
  columns,
  rows,
  emptyMessage = "표시할 데이터가 없습니다.",
  rowKey,
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
      <p className="mb-1 text-[11px] text-muted sm:hidden">← 표를 좌우로 넘겨 보세요</p>
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="표 (좌우 스크롤)">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={`px-3 py-2 font-medium ${
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
                className="border-b border-border/50 last:border-0 hover:bg-surface-hover/60"
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={`px-3 py-2 tabular-nums ${
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
    <span className="rounded-sm border border-border bg-surface-hover px-2 py-0.5 text-[11px] text-muted">
      {children}
    </span>
  );
}
