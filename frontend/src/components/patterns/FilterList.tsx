"use client";

import { useId, useRef, type JSX, type KeyboardEvent, type ReactNode } from "react";

import { FOCUS_RING, SELECTED_BAR } from "@/components/ui/classes";
import { CheckIcon } from "@/components/ui/icons";

/** 거르기 목록 줄 하나 — `label`은 단추 이름 그대로, `note`는 보조 글(단추 설명 — 이름에 섞지 않음), `title`은 마우스 설명. */
export type FilterListItem = { key: string; label: string; note?: string | null; title?: string };

/*
 * 클래스는 통째로 적습니다(Tailwind는 소스의 글자 그대로를 훑음). 넓은 화면(lg 이상)은 늘 세로 목록, 좁은 화면은 `narrow`대로 태그 줄바꿈(wrap) 또는 세로 목록(list).
 * 고른 표시는 데이터 영역 안의 고름이라 강조 파랑이 아니라 잉크(체크 상자 bg-text·SELECTED_BAR)와 중립 바탕(surface-2)입니다(원칙 A1 — 기간 알약과 같은 규칙).
 * 고대비(forced-colors)에서는 바탕이 지워지므로 켠 줄에 2px 테두리를 더합니다(체크 상자 테두리·체크 표시·SELECTED_BAR 테두리는 그 모드에서도 남음).
 */

/** 줄 공통 — 좁은 화면 44px 누름 자리, 글 14/20, 말줄임 없이 낱말 사이 줄바꿈은 글 칸이 맡음. */
const ITEM = `relative flex min-h-11 min-w-0 items-center gap-2 px-3 text-left text-body hover:bg-surface-2 motion-safe:transition-colors motion-safe:duration-150 ${FOCUS_RING}`;

/** 세로 목록 줄(모든 폭) — 폭 전체, 구분선, 넓은 화면 32px(14/20 글 + 위 6px + 아래 5px + 구분선 1px — 목록-검사 줄과 같은 셈), 마지막 줄은 구분선 없이 위아래 6px. */
const LIST_LINED = "w-full border-b border-border-subtle py-2 lg:min-h-0 lg:pt-1.5 lg:pb-[5px]";
const LIST_LAST = "w-full py-2 lg:min-h-0 lg:py-1.5";

/** 좁은 화면 태그(4px·1px 경계·44px) → 넓은 화면 세로 목록 줄. 태그 모양은 max-lg:로만 걸어 넓은 화면 줄과 섞이지 않게 합니다. */
const WRAP_LINED =
  "max-lg:inline-flex max-lg:max-w-full max-lg:rounded-control max-lg:border max-lg:py-2 lg:w-full lg:min-h-0 lg:border-b lg:border-border-subtle lg:pt-1.5 lg:pb-[5px]";
const WRAP_LAST = "max-lg:inline-flex max-lg:max-w-full max-lg:rounded-control max-lg:border max-lg:py-2 lg:w-full lg:min-h-0 lg:py-1.5";

/**
 * 켠 줄·끈 줄의 글. 켠 줄은 굵게(고대비 2px 테두리), 끈 줄은 보통 굵기 — 좁은 화면 태그는 끈 태그를 보조 글자색으로 물립니다. 좁은 화면 끈 태그의 1px 경계는
 * 고대비에서 시스템 색으로 남으므로, 켠 태그는 테두리 두께만이 아니라 모양 표지(여럿 — 체크 상자, 하나 — 왼쪽 막대)로도 갈립니다(QA-712).
 */
const ON = "font-semibold text-text forced-colors:border-2";
const OFF = "font-normal text-text";
const WRAP_ON = "max-lg:border-border-strong max-lg:bg-surface-2";
const WRAP_OFF = "max-lg:border-border max-lg:font-medium max-lg:text-text-2 max-lg:hover:text-text";

/** 여럿 고름의 체크 상자(16px 장식) — 켜면 잉크 바탕 + 바탕색 체크, 끄면 빈 상자(border-strong — 3:1). */
const BOX_ON = "inline-flex size-4 shrink-0 items-center justify-center rounded-control border border-text bg-text text-bg";
const BOX_OFF = "inline-flex size-4 shrink-0 rounded-control border border-border-strong";

/**
 * 거르기 목록(작업대 실행 명세 §7 4행 — 교집합 기관 칩 12개를 거르기 목록으로, 13F 포트폴리오 기관 목록, P6·P7의 거르기도 같은 패턴).
 *
 * - 줄은 `<button type="button">`이고 이름은 `label` 글 그대로입니다 — 체크 표시는 장식(aria-hidden), `note`는 설명(aria-describedby)이라
 *   이름에 개수·설명이 섞이지 않습니다. Enter·Space는 브라우저 단추 기본 동작입니다.
 * - `selection="multiple"`(기본): 줄은 토글 단추(`aria-pressed`), 묶음은 이름 있는 role="group"(`label`), 줄마다 Tab 정지점(옛 교집합 칩과 같음). 누르면 그 키를
 *   켜고 끕니다(`onToggle`). 보이는 고름 `selected`는 부르는 쪽이 정합니다(빈 고름 = 전체 같은 규칙은 부르는 쪽 — lib/selection의 유효 고름). 넓은 화면은
 *   16px 체크 상자(켜면 잉크 + 체크) + 굵은 글입니다.
 * - `selection="single"`: 라디오 묶음입니다 — 묶음 role="radiogroup"(`label`), 줄 role="radio" + `aria-checked`(목록 ul·li는 role="none" — 라디오가 묶음에 바로
 *   딸리게). Tab 정지점은 고른 줄 하나(roving tabindex — 고른 줄이 없으면 첫 줄)이고, 위·아래(왼쪽·오른쪽)·Home·End가 포커스를 옮기며 그 줄을 고릅니다(끝에서는
 *   반대 끝으로). 고른 줄을 다시 눌러도 아무 일 없음(`onToggle`을 부르지 않음 — 라디오는 풀리지 않음). 예전에는 토글 단추(aria-pressed)라 고른 줄이 '눌림'으로
 *   읽히는데 다시 눌러도 풀리지 않았고, 줄마다 Tab 정지점이라 13F 기관 12줄이 Tab 정지점 12개였습니다(개편 전 고르기 상자는 1개 — QA-711). 넓은 화면은 고른 줄에
 *   3px 잉크 막대(SELECTED_BAR) + 굵은 글 + 중립 바탕(surface-2)이고, 좁은 화면 태그도 같은 막대를 태그 안 왼쪽 끝에 둡니다(고대비 표지 — QA-712).
 * - 넓은 화면(lg 이상)은 늘 세로 목록(줄 32px, 마우스를 올리면 surface-2). 좁은 화면은 `narrow`: "wrap"(기본)은 44px 태그가 줄을 바꾸며 늘어섭니다(켠 태그 진한
 *   경계 + surface-2 + 굵은 글 — 여럿이면 체크 상자도, 끈 태그 옅은 경계 + 보조 글자색), "list"는 넓은 화면과 같은 세로 목록(줄 44px)입니다.
 * - `count`: 목록 위 개수 줄(true면 여럿은 'n개 고름 · 전체 m개', 하나는 '전체 m개' — 함수면 그 글). `placeholder`를 주면 목록 대신(읽는 중·오류), 줄이 없으면 `emptyText`.
 * - 글은 말줄임 없이 낱말 사이에서 꺾습니다(공백 없는 긴 이름은 비상으로 꺾음). 데이터를 그리는 패턴이 아니라 고르는 조작이라 데이터 칸 강조색 금지 목록에는 넣지
 *   않지만, 위처럼 강조 파랑을 쓰지 않습니다.
 */
export function FilterList({
  label,
  items,
  selected,
  onToggle,
  selection = "multiple",
  narrow = "wrap",
  count,
  placeholder,
  emptyText = "고를 항목이 없습니다.",
}: {
  /** 묶음 이름(여럿은 role="group", 하나는 role="radiogroup" — 줄이 없는 동안은 group, 예 '분석 대상 기관'). */
  label: string;
  items: readonly FilterListItem[];
  /** 보이는 고름(키 목록). */
  selected: readonly string[];
  /** 여럿: 켬·끔, 하나: 고름(이미 고른 줄은 부르지 않음). */
  onToggle: (key: string) => void;
  selection?: "multiple" | "single";
  /** lg 미만 모양 — "wrap"(태그 줄바꿈, 기본) 또는 "list"(세로 목록). lg 이상은 늘 세로 목록. */
  narrow?: "wrap" | "list";
  count?: boolean | ((selected: number, total: number) => string);
  /** 읽는 중·오류 — 목록 대신. */
  placeholder?: ReactNode;
  emptyText?: ReactNode;
}): JSX.Element {
  const baseId = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const multiple = selection === "multiple";
  const wrap = narrow === "wrap";
  const chosen = new Set(selected);
  const chosenCount = items.filter((item) => chosen.has(item.key)).length;
  const hasPlaceholder = placeholder !== undefined && placeholder !== null && placeholder !== false;

  let countText: string | null = null;
  if (typeof count === "function") countText = count(chosenCount, items.length);
  else if (count === true)
    countText = multiple
      ? `${chosenCount.toLocaleString("ko-KR")}개 고름 · 전체 ${items.length.toLocaleString("ko-KR")}개`
      : `전체 ${items.length.toLocaleString("ko-KR")}개`;

  // 하나 고름의 Tab 정지점 — 고른 줄(목록에 없으면 첫 줄).
  const checkedIndex = items.findIndex((item) => chosen.has(item.key));
  const focusIndex = checkedIndex >= 0 ? checkedIndex : 0;
  /** 하나 고름의 키 이동 — 위·왼쪽은 앞 줄, 아래·오른쪽은 다음 줄(끝에서는 반대 끝), Home·End는 처음·끝. 옮긴 줄에 포커스를 두고 그 줄을 고릅니다. */
  const onRadioKeyDown = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const last = items.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = index >= last ? 0 : index + 1;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = index <= 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    buttons.current[next]?.focus();
    const key = items[next].key;
    if (!chosen.has(key)) onToggle(key);
  };

  let body: ReactNode;
  if (hasPlaceholder) {
    body = <div className="min-w-0">{placeholder}</div>;
  } else if (items.length === 0) {
    body = <div className="min-w-0 py-1 text-sm text-text-2 break-keep wrap-anywhere">{emptyText}</div>;
  } else {
    body = (
      <ul role={multiple ? undefined : "none"} className={wrap ? "flex min-w-0 flex-wrap gap-2 lg:flex-col lg:flex-nowrap lg:gap-0" : "flex min-w-0 flex-col"}>
        {items.map((item, index) => {
          const on = chosen.has(item.key);
          const last = index === items.length - 1;
          const noteId = item.note ? `${baseId}-note-${index}` : undefined;
          const shape = wrap ? (last ? WRAP_LAST : WRAP_LINED) : last ? LIST_LAST : LIST_LINED;
          const tone = on
            ? `${ON}${wrap ? ` ${WRAP_ON}` : ""}${multiple ? "" : " bg-surface-2"}`
            : `${OFF}${wrap ? ` ${WRAP_OFF}` : ""}`;
          return (
            <li key={item.key} role={multiple ? undefined : "none"} className={wrap ? "min-w-0 max-w-full lg:max-w-none" : "min-w-0"}>
              <button
                ref={(element) => {
                  buttons.current[index] = element;
                }}
                type="button"
                {...(multiple
                  ? { "aria-pressed": on }
                  : { role: "radio", "aria-checked": on, tabIndex: index === focusIndex ? 0 : -1, onKeyDown: onRadioKeyDown(index) })}
                aria-describedby={noteId}
                title={item.title}
                onClick={() => {
                  if (!multiple && on) return;
                  onToggle(item.key);
                }}
                className={`${ITEM} ${shape} ${tone}`}
              >
                {/* 하나 고름의 고른 줄 막대 — 좁은 화면 태그에도 둡니다(태그 안 왼쪽 끝, 절대 위치라 태그 폭이 그대로). 고대비에서는 바탕이 지워지고 끈 태그의
                    1px 경계도 시스템 색으로 남아, 이 막대(그 모드에서 3px 왼쪽 테두리)가 없으면 켠 태그와 끈 태그를 테두리 두께로만 갈랐습니다(QA-712). */}
                {!multiple && on ? <span aria-hidden="true" className={SELECTED_BAR} /> : null}
                {multiple ? (
                  <span aria-hidden="true" className={on ? BOX_ON : wrap ? `${BOX_OFF} max-lg:hidden` : BOX_OFF}>
                    {on ? <CheckIcon size={12} /> : null}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 break-keep wrap-anywhere">{item.label}</span>
                {item.note ? (
                  <span id={noteId} aria-hidden="true" className="shrink-0 text-xs font-normal tabular-nums text-text-3">
                    {item.note}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    // 하나 고름이라도 줄이 없는 동안(읽는 중·오류·빈 목록)은 라디오가 없는 묶음이라 보통 묶음(group)으로 둡니다.
    <div role={multiple || hasPlaceholder || items.length === 0 ? "group" : "radiogroup"} aria-label={label} className="min-w-0">
      {countText !== null && !hasPlaceholder ? <p className="mb-1 text-xs tabular-nums text-text-2">{countText}</p> : null}
      {body}
    </div>
  );
}
