"use client";

import { Children, ReactNode, useId, useLayoutEffect, useRef, type KeyboardEvent, type SelectHTMLAttributes } from "react";
import { useScrollStripActive } from "@/hooks/useScrollStripActive";
import { deltaColor, deltaDirection, EMPTY, formatAge, formatKst, textDeltaDirection, withMinusSign, withoutLeadingIcon } from "@/lib/format";
import {
  buttonClasses,
  FOCUS_RING,
  inputClasses,
  TEXT_TARGET,
  underlineTabClasses,
  type ButtonSize,
  type ButtonVariant,
  type InputSize,
  type UnderlineTabSize,
} from "./classes";
import { AlertTriangleIcon, CheckCircleIcon, ChevronDownIcon, ClockIcon, InfoIcon, LineIcon, SpinnerIcon, XCircleIcon, XIcon } from "./icons";

// 클래스 문자열은 서버 컴포넌트도 부를 수 있게 순수 모듈(classes.ts)에 두고 여기서 다시 내보냅니다.
export {
  buttonClasses,
  filterChipClasses,
  FOCUS_RING,
  inputClasses,
  LINK_CLASSES,
  PANEL_CLASSES,
  pillTabClasses,
  ROW_TRIGGER,
  SEGMENT_TRACK,
  SELECTED_BAR,
  segmentClasses,
  SKELETON_BAR,
  TEXT_TARGET,
  toggleClasses,
  underlineTabClasses,
  type ButtonSize,
  type ButtonVariant,
  type InputSize,
  type UnderlineTabSize,
} from "./classes";

/**
 * 패널(섹션 컨테이너 — 작업대 실행 명세 §3-3·§3-7·§6). 1층 면: surface 바탕·1px 경계·4px 모서리, 그림자 없음.
 * 머리줄(제목·개수·동작)은 아래 1px 경계로 본문과 가르고, 본문 안쪽은 12px(lg 16px)입니다. 본문이 비면(접힌 패널 — children이 false·null)
 * 머리만 있는 상자입니다 — 본문 칸과 머리 아래 경계를 그리지 않습니다(빈 칸이 경계 밑에 띠로 남았음 — QA-494). 머리줄 바탕은 패널과 같은 surface입니다 —
 * 명세 표의 '패널 머리 surface-2'로 칠하면 머리 동작에 놓이는 기본 단추·출처 배지(둘 다 surface-2)가 묻혀서, 정보 검색 패널(검증한
 * 작업대 언어)처럼 경계로만 가릅니다.
 *
 * @param count 표·목록의 개수(명세 §3-7 '머리에는 늘 개수') — 제목 옆 보조 글로 그리고, 제목(h2)의 이름에는 넣지 않습니다.
 * @param source 이 패널 숫자의 출처. 모든 패널이 같은 모양("출처 · …")으로 적도록 여기서 그립니다.
 *               출처 문구는 `lib/sources.ts`에 모아 두었습니다 — 화면마다 따로 적으면 표기가 갈립니다.
 * @param region true면 이름 있는 영역(section aria-labelledby → 제목 h2) — 낭독기의 영역(랜드마크) 목록으로 찾아가야 하는 패널만 켭니다(홈의 구역,
 *               상세 화면의 차트 패널). 기본은 이름 없는 section이라 지금 쓰는 곳(약 180곳)은 영역이 되지 않습니다. 겉모양은 켜도 그대로이고, 제목이 없으면 영역 이름도 없습니다.
 */
export function Panel({
  title,
  subtitle,
  count,
  source,
  actions,
  children,
  className = "",
  region = false,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  count?: ReactNode;
  source?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  region?: boolean;
}) {
  const headingId = useId();
  const labelled = region && Boolean(title);
  // 패널 제목에는 아이콘을 쓰지 않습니다 — 데이터에서 온 제목도 앞 아이콘을 뗍니다.
  const heading = title ? (
    <h2 id={labelled ? headingId : undefined} className="text-heading-sm text-text">
      {typeof title === "string" ? withoutLeadingIcon(title) : title}
    </h2>
  ) : null;
  const counted = count !== undefined && count !== null;
  // 본문이 비면(접힌 패널) 머리만 있는 상자 — false·null·undefined는 Children.toArray에서 빠집니다.
  const hasBody = Children.toArray(children).length > 0;
  return (
    <section aria-labelledby={labelled ? headingId : undefined} className={`rounded-card border border-border bg-surface ${className}`}>
      {(title || actions || source) && (
        <header className={`flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-3 py-2.5 lg:px-4${hasBody ? " border-b border-border" : ""}`}>
          <div className="min-w-0">
            {heading && counted ? (
              <div className="flex flex-wrap items-baseline gap-x-2">
                {heading}
                <span className="text-[13px] tabular-nums text-text-3">{count}</span>
              </div>
            ) : (
              heading
            )}
            {subtitle && <p className="mt-0.5 break-keep text-[13px] leading-5 text-text-2">{subtitle}</p>}
            {source && <SourceLine>{source}</SourceLine>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      {hasBody && <div className="p-3 lg:p-4">{children}</div>}
    </section>
  );
}

/** 옛 이름 — Panel과 같습니다(부르는 곳 약 180곳을 한꺼번에 고치지 않으려고 남기고, 화면 단계에서 정리합니다). */
export const Card = Panel;

/**
 * 화면 머리 — h1(글자 단계 heading 20px) · 설명(14px 보조 글 한 줄) · '자세히' 접기 · 오른쪽 동작 영역(신선도·고르기·단추 — 작업대 실행 명세 §6).
 * 화면마다 h1 모양을 따로 적던 곳을 하나로 모읍니다(명세 §7-1). 설명 아래에 덧붙일 줄(예: 매크로 자동 갱신 안내)은 children으로 넘깁니다.
 * 긴 설명은 지우지 않고 `details`로 넘겨 '자세히' 접기 안에 둡니다(명세 §1 — 긴 설명 문단은 접기로 옮김). 처음에는 접혀 있습니다.
 * 동작은 넓은 화면에서 제목 묶음의 아래 끝에 맞춰 오른쪽에 두고(이름표가 위에 있는 고르기 상자의 상자가 설명 줄과 한 줄에 놓임),
 * 자리가 모자라면 제목 아래로 내려갑니다.
 */
export function PageHeader({
  title,
  description,
  details,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** '자세히' 접기 안의 긴 설명(최대 72자 폭). */
  details?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
      <div className="min-w-0">
        <h1 className="text-heading text-text">{title}</h1>
        {description ? <p className="mt-0.5 text-sm text-text-2">{description}</p> : null}
        {details ? (
          <details className="group mt-0.5 text-sm text-text-2">
            <summary
              className={`${TEXT_TARGET} cursor-pointer list-none gap-1 rounded-sm text-[13px] text-text-2 hover:text-text [&::-webkit-details-marker]:hidden ${FOCUS_RING}`}
            >
              자세히
              <ChevronDownIcon size={14} className="motion-safe:transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-1 max-w-[72ch] leading-relaxed">{details}</div>
          </details>
        ) : null}
        {children}
      </div>
      {actions ? <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** 지표 칸 (구버전 st.metric에 해당) — 4px·1px 경계·안쪽 12px, 값은 KPI 크기(20px, lg 24px — 작업대 실행 명세 §3-6)·tabular-nums. */
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
  // 변화 줄 — 색만으로 등락을 전하지 않게 ▲▼(읽기에서 뺌, 12px)와 읽어 주는 방향 글을 붙이고, 음수 부호는 −(U+2212)로 그립니다(변화 칩과 같은 문법 — QA-525).
  // 방향·색은 보이는 글의 첫 부호 숫자를 따르고(글을 다른 자릿수·단위로 찍은 칸 — 매크로 카드 '+0.004'·순유동성 '+40.0억 달러', QA-527), 부호 숫자가 없으면
  // 값과 자릿수(deltaDigits)로 판정합니다. 글이 '—'(모름)이면 방향 표시를 두지 않습니다.
  const shownDelta = deltaText ?? EMPTY;
  const direction =
    shownDelta.trim() === "" || shownDelta.trim() === EMPTY ? null : (textDeltaDirection(shownDelta) ?? deltaDirection(delta, deltaDigits));
  const deltaTone =
    direction === "up" ? "text-up" : direction === "down" ? "text-down" : direction === "flat" ? "text-text-2" : deltaColor(delta, deltaDigits);
  return (
    <div className="min-w-0 rounded-control border border-border bg-surface p-3">
      <div className="text-[13px] font-medium text-text-2">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums lg:text-2xl ${tone ?? "text-text"}`}>
        {value}
      </div>
      {(deltaText || delta !== undefined) && (
        <div className={`mt-1 text-sm tabular-nums ${deltaTone}`}>
          {direction === "up" || direction === "down" ? (
            <span aria-hidden="true" className="mr-1 text-xs">
              {direction === "up" ? "▲" : "▼"}
            </span>
          ) : null}
          {direction ? <span className="sr-only">{direction === "up" ? "상승" : direction === "down" ? "하락" : "변화 없음"}</span> : null}
          <span>{withMinusSign(shownDelta)}</span>
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
 * 한글은 낱말 사이에서만 줄을 바꾸고 공백 없는 긴 토큰만 칸 안에서 꺾습니다(break-keep wrap-break-word — 출처 배지와 같음, QA-568).
 */
export function SourceLine({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1 break-keep wrap-break-word text-xs leading-4 text-text-3">
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
  pending = false,
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
  /**
   * 첫 응답을 기다리는 중(hooks/useApi의 `firstLoadPending` — `loading && !data`는 실패 뒤 다시 읽는 동안에도 참이라 쓰지 않음, QA-895) — 값이 온 뒤의 평상시 배지('수집' + 'YYYY-MM-DD HH:MM')와 같은 폭의 보이지 않는 자리를 둡니다(낭독
   * 없음). 머리·패널 동작 줄이 응답 뒤 배지만큼 넓어져 꺾이며 아래를 밀던 첫 적재 이동을 막습니다(QA-892 — 수급 레이더 머리). 주지 않으면 예전 그대로
   * 값이 없을 때 아무것도 그리지 않습니다.
   */
  pending?: boolean;
}) {
  if (!collectedAt && ageSeconds === undefined && !refreshError) {
    return pending ? (
      <span aria-hidden="true" className="invisible inline-flex flex-wrap items-center gap-1">
        <span className="inline-flex items-center gap-1 text-xs">
          <ClockIcon size={12} />
          수집
          <span className="tabular-nums">0000-00-00 00:00</span>
        </span>
      </span>
    ) : null;
  }
  const age = formatAge(ageSeconds);

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {refreshError && (
        // 글은 이 span의 글자 그대로 둡니다(아이콘·sr 머리말은 따로) — '새로 읽지 못함'으로 찾은 요소가 title을 가진 이 알약입니다.
        <span
          className="inline-flex items-center gap-1 rounded-control border border-warn/30 bg-warn-tint px-1.5 py-px align-top text-xs text-warn"
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
        className="inline-flex items-center gap-1 rounded-control border border-warn/30 bg-warn-tint px-1.5 py-px align-top text-xs text-warn"
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

export type CalloutTone = "neutral" | "warn" | "danger" | "ok";

/**
 * 안내 상자(Callout — 작업대 실행 명세 §3-4) — 중립·주의·위험·정상 네 가지이고 늘 톤 아이콘과 함께(제목은 title로). 추정치·이력 대체처럼
 * "값의 성격"을 알리거나(warn), 실패·심각한 주의(danger)·안내(neutral)·완료(ok)를 알릴 때 씁니다. 옛 톤 이름 '정보'(info)는 중립과 같습니다.
 * 바탕은 모두 불투명(톤은 globals.css의 *-tint, 중립은 surface-2)이라 패널 밖 페이지 바탕 위에 놓여도 글자 대비가 같습니다.
 * 중립은 파랑이 아닙니다 — 바탕 surface-2·테두리 border-strong·아이콘과 글은 중립색. 강조 파랑은 누를 수 있는 것에만 쓰고(원칙 A1), 상자 안의
 * 링크(text-accent)가 accent 틴트 위 4.47:1로 4.5에 못 미치지 않게 합니다(QA-459 — surface-2 위 4.51).
 *
 * 앞에 톤 아이콘(장식)을 둡니다 — 예전에 부르는 쪽이 글 앞에 붙이던 경고 이모지 자리. 상승색과 위험색은 색만으로 갈리지 않으므로(명세 §3-2-1)
 * 상태·위험은 늘 아이콘과 글입니다. 주의(warn)·위험(danger)은 낭독기에 '주의: '를 먼저 읽힙니다(아이콘은 aria-hidden). danger는 실패만이
 * 아니라 추정치 모드·금리 역전 같은 심각한 주의에도 쓰여 '오류'라 읽히지 않게 합니다.
 * 글(제목 포함)은 톤 글자색을 가진 div로 감쌉니다 — 글로 찾은 요소(또는 그 closest div)가 톤 글자색을 그대로 가집니다(명세 D8 b).
 *
 * @param title 상자 제목(굵은 한 줄) — 본문 위에 둡니다.
 * @param icon 톤 기본 아이콘 대신 쓸 아이콘(예: 잠금). false면 아이콘 없이 글만.
 */
export function Callout({
  tone = "neutral",
  title,
  icon,
  children,
}: {
  tone?: CalloutTone | "info";
  title?: ReactNode;
  icon?: ReactNode | false;
  children?: ReactNode;
}) {
  const style = CALLOUT_TONES[tone === "info" ? "neutral" : tone];
  return (
    <div className={`flex items-start gap-2 rounded-control border p-3 text-sm leading-relaxed ${style.box}`}>
      {icon === false ? null : <LineIcon className={style.icon}>{icon ?? style.glyph}</LineIcon>}
      {style.srPrefix && <span className="sr-only">{style.srPrefix}</span>}
      <div className={`min-w-0 flex-1 ${style.text}`}>
        {title ? <p className="font-semibold">{title}</p> : null}
        {children}
      </div>
    </div>
  );
}

/**
 * 배너 — 안내 상자(Callout)의 옛 이름(부르는 곳 약 220곳을 한꺼번에 고치지 않으려고 남기고, 화면 단계에서 정리합니다). 기본 톤은 예전처럼
 * 주의(warn)이고, '정보'(info)는 중립과 같습니다.
 */
export function Banner({ tone = "warn", ...props }: { tone?: CalloutTone | "info"; title?: ReactNode; icon?: ReactNode | false; children: ReactNode }) {
  return <Callout tone={tone} {...props} />;
}

const CALLOUT_TONES = {
  neutral: { box: "border-border-strong bg-surface-2 text-text", text: "text-text", icon: "text-text-2", glyph: <InfoIcon size={16} />, srPrefix: "" },
  warn: { box: "border-warn/30 bg-warn-tint text-warn", text: "text-warn", icon: "", glyph: <AlertTriangleIcon size={16} />, srPrefix: "주의: " },
  danger: { box: "border-danger/30 bg-danger-tint text-danger", text: "text-danger", icon: "", glyph: <AlertTriangleIcon size={16} />, srPrefix: "주의: " },
  ok: { box: "border-ok/30 bg-ok-tint text-ok", text: "text-ok", icon: "", glyph: <CheckCircleIcon size={16} />, srPrefix: "" },
} as const;

export function Loading({ label = "불러오는 중…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-text-3">
      {/* 도는 것은 움직임 줄이기(prefers-reduced-motion)가 꺼져 있을 때만 — 켜져 있으면 멈춘 호와 글 */}
      <SpinnerIcon size={16} className="motion-safe:animate-spin" />
      {label}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-control bg-surface-2/60 px-3 py-6 text-center text-sm text-text-2">
      {message}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-control border border-danger/30 bg-danger-tint p-3 text-sm text-danger">
      <p className="flex items-start gap-2">
        <XCircleIcon size={16} className="mt-0.5" />
        {/*
          한글은 낱말 사이에서만 줄을 바꾸고 공백 없는 긴 토큰만 칸 안에서 꺾습니다(break-keep wrap-break-word — 공용 글 부품 규약 QA-568, 출처 줄·배지와 같음).
          좁은 칸(상관 화면 15rem 왼쪽 칸의 목록 오류 상자 206px)에서 '읽지 못했습|니다'처럼 음절 사이가 갈렸습니다(QA-664 검토).
        */}
        <span className="min-w-0 break-keep wrap-break-word">{message}</span>
      </p>
      {onRetry && (
        <button type="button" onClick={onRetry} className={`mt-2 ${buttonClasses("default", "sm")}`}>
          다시 시도
        </button>
      )}
    </div>
  );
}

/** 요청 중(busy) 단추 — 꺼진 단추(disabled:)와 같은 흐림·커서. busy일 때만 붙여 다른 단추의 클래스 글은 그대로입니다. */
const BUSY_CLASSES = "aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

/**
 * 공용 단추.
 *
 * @param disabled 켜짐 조건(빈 입력·데모·권한 등)으로 누를 수 없을 때 — 진짜 disabled.
 * @param busy 이 단추가 시작한 요청이 끝나지 않았을 때(`useAsyncAction`의 busy 등). 진짜 disabled가 아니라 aria-disabled로 알리고 누름을 무시합니다
 *             (submit이면 폼 보내기도 막음). 누른 단추가 disabled가 되면 크롬이 포커스를 body로 보내 응답 뒤 Tab이 문서 처음부터 시작했습니다(QA-899 —
 *             정보 수집 번역 단추 QA-887·알림 규칙 줄 QA-898과 같은 꼴). 모양은 꺼진 단추와 같습니다. 입력칸에서 Enter로 폼을 다시 보내는 길은 단추가 막지
 *             못하므로(꺼진 submit 단추와 달리) 폼의 onSubmit도 busy면 돌아갑니다 — 부르는 쪽이 지킵니다.
 * @param ariaLabel 낭독 이름(aria-label) — 보이는 글로 이름이 모자란 아이콘 단추 등에만. 보이는 글이 있으면 그 글로 시작하게 씁니다(WCAG 2.5.3).
 * @param describedBy 낭독 설명이 될 요소의 id(aria-describedby, 빈칸으로 여럿) — 보이는 글·이름은 그대로 두고 덧붙여 읽힙니다. 표의 줄마다 같은 이름인
 *                    쓰기 단추('다시 실행'·'지우기')가 그 줄의 이름 칸을 가리킵니다(QA-900). 이름은 그대로라 이름으로 찾는 쓰기 시험·음성 조작이 바뀌지 않고,
 *                    설명 글을 단추 옆에 따로 두지 않아(보이는 줄 이름을 가리킴) 같은 글이 두 번 있지 않습니다.
 */
export function Button({
  children,
  onClick,
  variant = "default",
  size = "md",
  icon,
  disabled,
  busy = false,
  ariaLabel,
  describedBy,
  type = "button",
  className = "",
  expanded,
}: {
  children: ReactNode;
  onClick?: () => void;
  /** 단추 네 종류(default·primary·danger·minimal — 옛 이름 secondary·ghost도 받음). 주지 않으면 기본(default). */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 글 앞 아이콘(장식 — components/ui/icons의 aria-hidden 아이콘). 뜻은 단추 글이 나릅니다. */
  icon?: ReactNode;
  disabled?: boolean;
  busy?: boolean;
  ariaLabel?: string;
  describedBy?: string;
  type?: "button" | "submit";
  className?: string;
  /** 펼치고 접는 버튼이면 지금 펼쳐졌는지(aria-expanded). 아니면 넘기지 않습니다. */
  expanded?: boolean;
}) {
  return (
    <button
      aria-expanded={expanded}
      aria-disabled={busy || undefined}
      aria-label={ariaLabel}
      aria-describedby={describedBy || undefined}
      type={type}
      onClick={busy ? (event) => event.preventDefault() : onClick}
      disabled={disabled}
      className={`${buttonClasses(variant, size)} ${busy ? `${BUSY_CLASSES} ` : ""}${className}`.trim()}
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
   *
   * group(선택)을 준 항목은 그 이름의 묶음(optgroup)으로 모읍니다 — 묶음은 처음 나온 차례, 묶음 안은 받은 차례, 묶음 없는 항목은 맨 앞.
   * 고른 값의 글이 묶음 이름 없이 짧아져 좁은 칸에서도 잘리지 않습니다(상관 화면의 계열 고르기). 아무 항목에도 주지 않으면 예전과 같습니다.
   */
  options: { value: string; label: string; disabled?: boolean; group?: string }[];
}) {
  /*
    주의: 폭을 반드시 묶어 둡니다.
    select는 가장 긴 option에 맞춰 스스로 넓어집니다. AI 엔진 목록처럼 라벨이
    긴 선택지가 들어오자 폭이 533px이 되어, 390px 화면에서 페이지 전체가
    가로로 스크롤됐습니다. 좁은 화면에서는 한 줄을 다 쓰고, 넓은 화면에서는
    내용만큼만 차지하되 화면을 넘지 않게 합니다.
  */
  return (
    <label className="flex min-w-0 max-w-full flex-col gap-1 text-[13px] text-text-2 sm:w-auto">
      {label}
      {/* 상자 모양·화살표 아이콘은 NativeSelect, 폭 묶기(좁은 화면 한 줄 전체·넓은 화면 22rem까지)는 감싼 칸이 합니다. */}
      <NativeSelect
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        wrapperClassName="block w-full sm:max-w-[22rem]"
      >
        {selectOptionGroups(options).map(({ group, items }) =>
          group === null ? (
            items.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </option>
            ))
          ) : (
            <optgroup key={`group:${group}`} label={group}>
              {items.map((option) => (
                <option key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ),
        )}
      </NativeSelect>
    </label>
  );
}

/** Select 선택지를 묶음(optgroup)으로 — 묶음 없는 항목(null)이 맨 앞, 묶음은 처음 나온 차례. 아무 항목에도 묶음이 없으면 묶음 없는 한 덩어리. */
function selectOptionGroups<T extends { group?: string }>(options: readonly T[]): { group: string | null; items: T[] }[] {
  const plain: T[] = [];
  const grouped = new Map<string, T[]>();
  for (const option of options) {
    const group = option.group?.trim();
    if (!group) {
      plain.push(option);
    } else {
      grouped.set(group, [...(grouped.get(group) ?? []), option]);
    }
  }
  return [...(plain.length > 0 ? [{ group: null, items: plain }] : []), ...[...grouped].map(([group, items]) => ({ group, items }))];
}

/**
 * 고르기 상자 하나 — 날 select에 공용 입력칸 모양(inputClasses)과 화살표 아이콘을 입힙니다. 브라우저 화살표는 지우고(appearance-none)
 * 아이콘을 둡니다 — 고대비 모드에서도 글자색으로 보이고, 같은 화면의 고르기 상자가 한 모양이 됩니다(예전에는 날 select만 브라우저 화살표).
 * 이름은 부르는 쪽이 붙입니다(감싼 label·aria-label·id). `Select`(라벨·선택지 목록까지 그림)로 안 되는 자리 — 설정 표의 칸·카드 머리의
 * 작은 고르기 — 에 씁니다. 폭은 `className`(select)·`wrapperClassName`(감싼 칸).
 * 화살표 자리(오른쪽 32px)는 모든 폭에서 비웁니다 — 입력칸 모양이 넓은 화면 가로 여백(`lg:px-*`)을 따로 두고, Tailwind는 변형 규칙을
 * 뒤에 내보내므로 `pr-8` 하나만 두면 lg부터 덮여 고른 글이 화살표 밑으로 들어갑니다(QA-463). 그래서 `lg:pr-8`을 함께 붙입니다.
 * 감싼 칸은 기본 inline-flex입니다 — inline-block이면 칸 안에 줄 상자가 생겨, 놓인 글의 줄 높이(본문 16/24 등)에 따라 sm(24px) 고르기를 감싼 칸이
 * 25px(줄 높이가 더 크면 26px)로 늘어 같은 줄의 sm 단추(24px)와 어긋났습니다(2026-11-16 검토 지적 — 머리 없는 크롬으로 잼). flex 칸이면 칸 높이가 고르기 높이와 같습니다.
 */
export function NativeSelect({
  inputSize = "md",
  className = "",
  wrapperClassName = "inline-flex",
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  inputSize?: InputSize;
  /** 감싼 칸의 배치(표시 방식·폭). 기본은 글 흐름 안의 inline-flex — 한 줄을 다 쓰려면 "block w-full"(넓은 화면 sm이면 "flex w-full"). */
  wrapperClassName?: string;
}) {
  return (
    <span className={`relative max-w-full ${wrapperClassName}`.trim()}>
      <select {...props} className={`w-full max-w-full appearance-none pr-8 ${inputClasses(inputSize)} lg:pr-8 ${className}`.trim()}>
        {children}
      </select>
      <ChevronDownIcon size={16} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-3" />
    </span>
  );
}

/**
 * 단순 테이블. 컬럼 정의로 정렬/포맷을 제어합니다. 조밀한 행(작업대 실행 명세 §3-7 — 행 32px: 14px 글 + 위아래 6px), 머리는 13px 보조 글과
 * 1px 경계, 행 사이는 옅은 구분선(border-subtle).
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
            {/* 머리는 13px 보조 글 — 대문자·자간은 한국어 머리에서 뜻이 없어 뺐습니다. 머리·칸은 낱말 사이에서만 줄을 바꿉니다(break-keep —
                기본 줄바꿈은 좁은 칸에서 한글 낱말을 '기준/일'처럼 글자 사이에서 끊었음, QA-526). 낱말 안 꺾기(wrap-anywhere)는 넣지 않습니다 —
                칸의 최소 폭을 한 글자로 줄여 같은 꺾임을 다시 냄. 칸이 넓어지면 아래 가로 스크롤 상자 안에서 넘깁니다. */}
            <tr className="border-b border-border text-[13px] text-text-2">
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={`break-keep px-3 py-1.5 font-medium ${
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
                className="border-b border-border-subtle last:border-0 hover:bg-surface-2 motion-safe:transition-colors"
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={`break-keep px-3 py-1.5 tabular-nums ${
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

/**
 * 작은 글 배지(출처 종류·모델 이름·기준 분기 등). 모서리는 rounded-full이 아니라 4px(rounded-control) — 표의 좁은 칸에서 두 줄로 접히면
 * rounded-full은 글이 모서리에 걸린 타원이 됐습니다(추정·이전 값 배지와 같은 까닭). 테두리 있는 꼬리표는 Tag(중립)입니다.
 * 높이는 20px(12/16 글 + 위아래 2px, 테두리 없음)로 Tag와 같고, 표 칸 같은 글 흐름 안에서는 Tag처럼 줄 위에 맞춥니다(align-top) — 기준선에 맞추면
 * 공용 표(Table) 칸에 든 행이 1px 늘었습니다(머리 없는 크롬으로 잼, 2026-11-16 태그 20px 결정과 같은 까닭). flex 줄 안에서는 이 맞춤이 쓰이지 않습니다.
 * 날짜처럼 접히면 안 되는 값은 부르는 쪽(표 칸의 className)이 whitespace-nowrap을 붙입니다.
 */
export function SourceBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-control bg-surface-2 px-2 py-0.5 align-top text-xs leading-4 text-text-2">
      {children}
    </span>
  );
}

/** 탭 하나의 id — 탭 패널의 aria-labelledby가 같은 값을 씁니다. */
export function tabId(idPrefix: string, key: string): string {
  return `${idPrefix}-${key}`;
}

const TAB_KEYS = new Set(["ArrowRight", "ArrowLeft", "Home", "End"]);

/**
 * 탭 줄(ARIA tabs) — 탭 모양은 밑줄 탭 하나입니다(underlineTabClasses, 작업대 실행 명세 §6). role="tablist"(이름 `label`)와 탭마다
 * role="tab"·aria-selected·aria-controls(panelId)·id(tabId)를 붙이고, Tab 키로는 고른 탭 하나에만 들어옵니다(나머지 tabIndex -1).
 * ←·→(끝에서 돎)·Home·End는 포커스만 옮기고, 여는 것은 누르기·Enter·Space입니다 — 탭마다 자료를 읽거나 주소를 바꾸는 화면이 지나가며
 * 부르지 않게 합니다(정보 검색 결과 탭과 같은 규칙). 탭 패널(role="tabpanel", id=panelId, aria-labelledby=tabId(idPrefix, value))과
 * 탭을 바꿀 때의 일(주소 바꾸기 — 모의매매 탭의 history.replaceState 등)은 부르는 쪽이 onChange에서 합니다.
 *
 * 탭 줄이 폭보다 길면 가로로 스크롤하고(줄을 바꾸지 않음), 고른 탭과 키보드로 옮긴 탭(:focus-visible)을 줄 안으로 보이게 합니다 — 줄의 scrollLeft만
 * 옮기고 창(문서)의 세로 스크롤은 그대로입니다(좁은 화면 하위 메뉴 줄과 같은 훅 — hooks/useScrollStripActive, QA-510 방식). 그래서 줄이 위치 기준(relative)입니다.
 * 처음 그릴 때와 고른 탭이 바뀔 때만 움직이고, 손가락·마우스로 누른 칸은 고른 뒤에 보입니다(누르는 도중에 줄이 움직이지 않게).
 * `wrap`을 주면 대신 줄을 바꿔 모든 탭이 보입니다(가로 스크롤 없음) — 탭마다 제 줄의 바닥선을 지녀 고른 탭의 밑줄이 다음 줄 위에 떠 보이지
 * 않습니다(underlineTabClasses wrap). 반 폭 패널처럼 탭 다섯이 들어가지 않는 자리(홈 시장 패널 — 2026-11-16 결정 1)만 켭니다.
 *
 * 포커스가 있던 탭이 다시 그리기에서 빠지면(경제 캘린더 날짜 띠의 지난날이 새 자료에서 사라짐 등) 그 단추가 DOM에서 떨어져 포커스가 body로 갔습니다
 * (QA-685 — 포커스 링이 사라지고 낭독기는 자리를 잃음. 크롬의 다음 Tab·Shift+Tab은 사라진 자리 근처인 표·고른 탭에서 이어졌음). 그래서 탭 줄 안 포커스가
 * 그 탭과 함께 사라졌을 때만 지금 진입 탭(고른 탭 — 새 value)으로 옮깁니다(스크롤 없이).
 * 포커스가 다른 곳에 있으면 건드리지 않습니다(activeElement가 body·null일 때만 — 정보 검색 제외 목록 QA-444의 되돌림과 같은 규칙).
 */
export function Tabs<K extends string>({
  label,
  items,
  value,
  onChange,
  idPrefix,
  panelId,
  size = "sm",
  wrap = false,
  className = "",
}: {
  label: string;
  /** 탭 목록 — suffix는 이름 뒤에 붙는 보조 글(예: '(준비 중)'). */
  items: readonly { key: K; label: ReactNode; suffix?: ReactNode }[];
  value: K;
  onChange: (key: K) => void;
  idPrefix: string;
  panelId: string;
  /** sm(화면 안 탭 줄 — lg 이상 30px)이 기본, md는 하위 메뉴 줄 크기(lg 이상 40px). */
  size?: UnderlineTabSize;
  /** true면 폭이 모자랄 때 줄을 바꿉니다(가로 스크롤 대신 — 위 설명). 기본은 한 줄 + 가로 스크롤. */
  wrap?: boolean;
  /** 탭 줄의 배치 클래스(여백 등). */
  className?: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const listRef = useRef<HTMLDivElement>(null);
  // 포커스를 지닌 단추의 ref가 풀렸는가(QA-685 — 위 설명). ref가 null로 풀리는 때는 단추가 아직 문서에 있어 activeElement로 알 수 있습니다. 다시 그릴
  // 때마다 새 ref 함수라 남는 단추도 풀렸다 다시 붙으므로, 옮길지는 그린 뒤 포커스가 정말 body로 갔는지로 가립니다.
  const focusDetached = useRef(false);
  // 고른 탭이 바뀌면(처음 그릴 때 포함) 그 탭을, 키보드로 옮긴 탭은 포커스가 들어올 때 줄 안에 보이게 — 줄을 바꾸는 줄(wrap)은 넘치지 않아 움직일 일이 없습니다.
  useScrollStripActive(listRef, value, { current: '[role="tab"][aria-selected="true"]' });
  const selectedIndex = items.findIndex((item) => item.key === value);
  const entry = selectedIndex >= 0 ? selectedIndex : 0;
  useLayoutEffect(() => {
    if (!focusDetached.current) return;
    focusDetached.current = false;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const target = items[entry];
    if (target) refs.current[target.key]?.focus({ preventScroll: true });
  });
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!TAB_KEYS.has(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
    refs.current[items[next].key]?.focus();
  };
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      className={`relative flex ${wrap ? "flex-wrap" : "overflow-x-auto"} border-b border-border ${className}`.trim()}
    >
      {items.map((item, index) => (
        <button
          key={item.key}
          ref={(element) => {
            const previous = refs.current[item.key];
            if (element === null && previous && previous === document.activeElement) focusDetached.current = true;
            refs.current[item.key] = element;
          }}
          type="button"
          role="tab"
          id={tabId(idPrefix, item.key)}
          aria-selected={item.key === value}
          aria-controls={panelId}
          tabIndex={index === entry ? 0 : -1}
          onClick={() => onChange(item.key)}
          onKeyDown={(event) => onKeyDown(event, index)}
          className={underlineTabClasses(item.key === value, size, wrap)}
        >
          {item.label}
          {item.suffix}
        </button>
      ))}
    </div>
  );
}

export type TagTone = "neutral" | "warn" | "danger" | "ok";

const TAG_TONES: Record<TagTone, { box: string; glyph: ReactNode; srPrefix: string }> = {
  neutral: { box: "border-border bg-surface-2 text-text-2", glyph: null, srPrefix: "" },
  warn: { box: "border-warn/30 bg-warn-tint text-warn", glyph: <AlertTriangleIcon size={12} />, srPrefix: "주의: " },
  danger: { box: "border-danger/30 bg-danger-tint text-danger", glyph: <AlertTriangleIcon size={12} />, srPrefix: "주의: " },
  ok: { box: "border-ok/30 bg-ok-tint text-ok", glyph: <CheckCircleIcon size={12} />, srPrefix: "" },
};

/**
 * 태그(작업대 실행 명세 §6) — 4px 모서리·1px 경계·12px 글. 높이는 20px(글줄 16px + 위아래 1px 여백 + 경계 — 2026-11-16 결정)로 칸 글줄(14/20)과 같아,
 * 표 칸·속성 값에 들어가도 행이 32·28px 그대로입니다(추정·이전 값 배지·정보 검색 종류 표지·개장 배지·신선도 주의 표지가 같은 높이). 글 흐름 안(표 칸)에서는
 * 줄 위에 맞춥니다(align-top) — 기준선에 맞추면 태그 안 글의 기준선 자리(글꼴 따라 0.5~1px)만큼 줄이 늘어 행이 1px 커졌습니다(머리 없는 크롬으로 잼).
 * flex 줄(대부분의 자리) 안에서는 이 맞춤이 쓰이지 않습니다.
 * 중립(별칭·식별자·종류)과 의도 셋(주의·위험·정상)이고, 의도 태그는 늘 아이콘과
 * 글을 함께 씁니다(상승색과 위험색은 색만으로 갈리지 않음 — 명세 §3-2-1). 주의·위험은 낭독기에 '주의: '를 먼저 읽힙니다. 파랑(정보) 태그는
 * 없습니다 — 강조 파랑은 누를 수 있는 것에만(원칙 A1).
 * onRemove를 주면 지울 수 있는 태그입니다 — 지우기 단추(이름 removeLabel, 없으면 '{글} 지우기')는 좁은 화면(lg 미만)에서 44px, 넓은 화면은
 * 작은 조작 24px(명세 §3-7)입니다. 단추는 위아래 음수 여백으로 줄 높이(16px)만 차지해 태그 높이를 키우지 않고(누르는 자리는 태그 위아래로
 * 넘침), 오른쪽은 태그 안쪽 여백까지만 씁니다 — 왼쪽으로는 넘치지 않아 태그 글을 눌러 지우는 일이 없습니다. 좁은 화면에서는 태그가 그만큼 넓어집니다.
 *
 * @param icon 톤 기본 아이콘 대신 쓸 아이콘(장식). false면 아이콘 없이 글만(중립은 기본이 아이콘 없음).
 */
export function Tag({
  tone = "neutral",
  icon,
  onRemove,
  removeLabel,
  children,
}: {
  tone?: TagTone;
  icon?: ReactNode | false;
  onRemove?: () => void;
  removeLabel?: string;
  children: ReactNode;
}) {
  const style = TAG_TONES[tone];
  const glyph = icon === false ? null : (icon ?? style.glyph);
  const name = removeLabel ?? (typeof children === "string" ? `${children} 지우기` : "지우기");
  return (
    <span className={`inline-flex items-center gap-1 rounded-control border px-1.5 py-px align-top text-xs leading-4 ${style.box}`}>
      {glyph}
      {style.srPrefix ? <span className="sr-only">{style.srPrefix}</span> : null}
      {children}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={name}
          className={`-my-3.5 -mr-1.5 inline-flex min-h-11 min-w-11 items-center justify-center rounded-sm opacity-80 hover:opacity-100 lg:-my-1 lg:min-h-6 lg:min-w-6 ${FOCUS_RING}`}
        >
          <XIcon size={12} />
        </button>
      ) : null}
    </span>
  );
}
