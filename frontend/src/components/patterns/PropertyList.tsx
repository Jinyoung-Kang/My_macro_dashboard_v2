"use client";

import { useId, type JSX, type ReactNode } from "react";

import { isMissingValue, statValueText } from "@/lib/patterns";

import { EstimateBadge, ProvenanceBadge, StaleBadge } from "./badges";
import { Empty } from "./Empty";

/** 속성 한 줄 — 이름(dt)과 값(dd). */
export type PropertyItem = {
  /** 이름 — 13px 보조 글(text-caption text-text-2). */
  label: string;
  /**
   * 값 — 글·숫자·요소(링크 등). null·undefined·빈 글·"—"·"N/A"·NaN이면 "—"(Empty + emptyReason)이고 단위는 붙이지 않습니다(QA-049). 0은 값입니다.
   * 요소는 이미 그린 것으로 보고 그대로 둡니다.
   */
  value: ReactNode;
  /** React key(기본 label). 같은 이름이 두 번 나오면 줍니다. */
  key?: string;
  /** 숫자 값 서식(없으면 소수 둘째 자리 — lib/patterns statValueText). */
  format?: (value: number) => string;
  /** 단위 — 값이 있을 때만 붙습니다. */
  unit?: string | null;
  /** 값을 모르는 까닭(표본 부족 등) — "—" 옆 작은 글. */
  emptyReason?: string | null;
  /** 식별자(티커·CIK·CUSIP·카드 키) — 시스템 고정폭(font-mono, 명세 §3-6). */
  mono?: boolean;
  /** 값 아래 12px 보조 글(해석·기준일). */
  note?: ReactNode;
  isEstimated?: boolean;
  isProxy?: boolean;
  isStale?: boolean;
  staleReason?: string | null;
  /** 이 줄만의 출처(줄마다 출처가 다를 때) — 값 아래 출처 캡션(ProvenanceBadge). */
  source?: string | null;
  /** 긴 글 값(기관 소개 등) — 이름 위·값 아래, 왼쪽 정렬, 줄 간격 넓게. */
  block?: boolean;
};

/** 넓은 화면(lg 이상) 줄 위아래 여백 — 칸 글(14/20)과 아래 구분선 1px까지 32·28px(DataTable과 같은 셈 — 선이 있는 줄은 아래 여백 1px 덜). 클래스 이름을 통째로 적습니다. */
const ROW_Y = {
  normal: "py-2 lg:pt-1.5 lg:pb-[5px] lg:last:pb-1.5",
  dense: "py-2 lg:pt-1 lg:pb-[3px] lg:last:pb-1",
} as const;

/** 값 칸 — 숫자·글은 서식을 거치고, 모르면 "—"와 사유(단위 없음). 요소는 그대로. */
function PropertyValue({ item }: { item: PropertyItem }): JSX.Element {
  const { value } = item;
  const primitive = typeof value === "number" || typeof value === "string";
  const text = primitive ? statValueText(value, item.format) : null;
  const missing = primitive ? text === null : isMissingValue(value);
  if (missing) {
    return (
      <span className="text-text-3">
        <Empty reason={item.emptyReason} />
      </span>
    );
  }
  return (
    <>
      <span className={item.mono ? "font-mono" : undefined}>{primitive ? text : value}</span>
      {item.unit ? <span className="text-xs text-text-3">{item.unit}</span> : null}
    </>
  );
}

/**
 * 속성 목록(작업대 실행 명세 §6 PropertyList — 상세 화면의 왼쪽 칸·검사 칸): 이름-값 두 칸 줄을 위에서 아래로.
 *
 * - 값을 모르면 "—"와 사유, 단위는 값이 있을 때만(QA-049). 0은 값입니다. 숫자는 `tabular-nums`, 식별자(`mono`)는 시스템 고정폭.
 * - 추정·대리·이전 값 배지는 값 옆에 늘 보입니다(숨기는 옵션 없음). 줄마다 출처가 다르면 `source`(값 아래 출처 캡션), 목록 전체 출처는 `source` prop('출처 · …' 줄).
 * - 값은 말줄임하지 않고 낱말 사이에서 줄을 바꿉니다(break-keep wrap-anywhere — 긴 영문 업종·URL도 칸 안에서 꺾임). truncate·whitespace-nowrap을 쓰지 않습니다
 *   (13rem 왼쪽 칸에서 값이 잘리던 것 — QA-530 계열). 긴 글은 `block`(이름 위·값 아래, 왼쪽 정렬).
 * - 넓은 화면(lg 이상) 줄은 32px(`dense`면 28px — 아래 구분선 1px 포함, DataTable과 같은 셈), 값이 두 줄이면 그만큼 늘어납니다. 좁은 화면은 위아래 8px —
 *   누르는 줄이 아니라 44px로 키우지 않습니다. 구분선은 옅은 경계(border-subtle).
 * - `title`을 주면 이름 있는 영역(section aria-labelledby)과 제목(h2 heading-sm, 기본 h3 — 검사 칸 안의 작은 제목). 보통은 Panel 안에서 제목 없이 씁니다.
 * - `placeholder`(불러오는 중 Skeleton·오류 글)를 주면 줄 대신 그것(제목은 그대로), 줄이 없으면 `emptyText`.
 * - 데이터 영역이라 강조 파랑을 쓰지 않습니다(A1 — lib/__tests__/accentInData.test.ts).
 */
export function PropertyList({
  items,
  title,
  headingLevel = 3,
  dense = false,
  emptyText = "표시할 속성이 없습니다.",
  placeholder,
  source,
}: {
  items: readonly PropertyItem[];
  title?: string;
  headingLevel?: 2 | 3;
  dense?: boolean;
  emptyText?: ReactNode;
  placeholder?: ReactNode;
  source?: ReactNode;
}): JSX.Element {
  const headingId = useId();
  const rowY = ROW_Y[dense ? "dense" : "normal"];

  let body: ReactNode;
  if (placeholder !== undefined && placeholder !== null && placeholder !== false) {
    body = placeholder;
  } else if (items.length === 0) {
    body = <p className="py-1 text-sm text-text-2">{emptyText}</p>;
  } else {
    body = (
      <dl className="flex min-w-0 flex-col">
        {items.map((item) => {
          const flagged = Boolean(item.isEstimated || item.isProxy || item.isStale);
          const rowSource = item.source && !isMissingValue(item.source) ? item.source : null;
          return (
            <div
              key={item.key ?? item.label}
              className={`flex min-w-0 border-b border-border-subtle last:border-0 ${rowY} ${
                item.block ? "flex-col gap-0.5" : "items-baseline justify-between gap-3"
              }`}
            >
              <dt className="min-w-0 break-keep text-caption text-text-2">{item.label}</dt>
              <dd
                className={`min-w-0 break-keep wrap-anywhere text-body text-text tabular-nums ${
                  item.block ? "text-left leading-relaxed" : "text-right"
                }`}
              >
                <span className={`flex flex-wrap items-baseline gap-x-1 gap-y-1 ${item.block ? "justify-start" : "justify-end"}`}>
                  <PropertyValue item={item} />
                  {flagged ? (
                    <>
                      <EstimateBadge estimated={item.isEstimated} proxy={item.isProxy} />
                      <StaleBadge stale={item.isStale} reason={item.staleReason} />
                    </>
                  ) : null}
                </span>
                {item.note !== undefined && item.note !== null && item.note !== false && item.note !== "" ? (
                  <span className="mt-0.5 block text-xs leading-4 text-text-3">{item.note}</span>
                ) : null}
                {rowSource ? (
                  <span className="mt-0.5 block">
                    <ProvenanceBadge source={rowSource} />
                  </span>
                ) : null}
              </dd>
            </div>
          );
        })}
      </dl>
    );
  }

  const sourceLine =
    source !== undefined && source !== null && source !== false && source !== "" ? (
      <p className="mt-1 text-xs leading-4 text-text-3">
        <span>출처</span>
        <span aria-hidden="true"> · </span>
        {source}
      </p>
    ) : null;

  if (!title) {
    return (
      <div className="min-w-0">
        {body}
        {sourceLine}
      </div>
    );
  }
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <Heading
        id={headingId}
        className={headingLevel === 2 ? "mb-1 text-heading-sm text-text" : "mb-1 text-caption font-semibold text-text-2"}
      >
        {title}
      </Heading>
      {body}
      {sourceLine}
    </section>
  );
}
