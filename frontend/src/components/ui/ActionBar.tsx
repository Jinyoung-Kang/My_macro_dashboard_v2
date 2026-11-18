"use client";

import { useRef, type JSX } from "react";

import { buttonClasses } from "./classes";
import { DropdownMenu, DropdownMenuItem } from "./DropdownMenu";
import { ChevronDownIcon } from "./icons";

/** 동작의 의도 — 기본·주(한 묶음에 하나)·위험(확인 대화상자를 거치는 파괴적 동작에만 — 실행 명세 §3-4). */
export type ActionBarIntent = "default" | "primary" | "danger";

/** 동작 하나. */
export type ActionBarItem = {
  /** 키이자 단추의 data-action. */
  id: string;
  /** 보이는 글이자 이름(진행 글 '결정 중… 12초'처럼 바뀌는 글도 부르는 쪽이 넘김). */
  label: string;
  onSelect: () => void;
  intent?: ActionBarIntent;
  disabled?: boolean;
  /** 대화상자를 엶 → aria-haspopup="dialog". */
  opensDialog?: boolean;
  /** 화면 안 확인 상자를 여닫음 → aria-expanded(주지 않으면 붙이지 않음). */
  expanded?: boolean;
  /** 여닫는 영역의 id → aria-controls. */
  controls?: string;
  /**
   * 설명 글의 id → aria-describedby(작업대 P6 검토 — 확인 없이 바로 도는 동작이 무엇을 하는지 늘 보이는 글로 화면에 두고 그 글을 가리킴). 늘 보이는 단추에만
   * 붙습니다(메뉴로 넘친 항목은 메뉴 글이 이름 — 설명이 필요한 동작은 `pin`으로 단추에 둡니다).
   */
  describedBy?: string;
  /** '동작' 메뉴의 글자 찾기 별칭(한국어 이름에 로마자·초성 — DropdownMenuItem textValue). */
  textValue?: string;
  /** 메뉴로 접지 않음 — 늘 닿아야 하는 동작. */
  pin?: boolean;
};

/**
 * 화면 머리의 동작 영역(작업대 실행 명세 §6 ActionBar — 처음 쓰는 곳 P6 모의매매 머리, 탭마다 다른 동작 목록 — 명세 §7-1).
 *
 * - 이름 있는 묶음(role="group", `label`)에 동작을 늘어놓습니다. 앞의 `maxInline`(기본 3)개는 늘 보이는 단추이고, 넘는 것만 '동작'(`menuLabel`) 메뉴의
 *   항목이 됩니다(공용 DropdownMenu — 막힌 항목은 화살표·글자 찾기가 건너뜀, 위험 의도는 경고 삼각형 표지, `textValue`는 글자 찾기 별칭). `pin`인 동작은
 *   넘쳐도 단추입니다. 빈 목록이면 아무것도 그리지 않습니다(null — 모의매매 실제 계좌·ISA 탭은 지금 빈 목록, 명세 §7-1 확장 지점).
 * - 단추는 공용 단추 클래스(buttonClasses — 의도별 바탕, 좁은 화면 44px·넓은 화면 30px)이고 `data-action`이 붙습니다. 대화상자를 여는 동작은
 *   aria-haspopup="dialog", 화면 안 확인 상자를 여닫는 동작은 aria-expanded·aria-controls, 설명 글을 가리키는 동작(`describedBy`)은 aria-describedby.
 * - 메뉴 항목을 고르면 그 동작의 `onSelect`는 메뉴가 닫히고 포커스가 여는 단추로 돌아간 뒤에 불립니다(onCloseAutoFocus 다음 마이크로태스크). 그래서
 *   대화상자를 여는 동작이 메뉴의 포커스 되돌림과 겹치지 않고, 대화상자를 닫으면 '동작' 단추로 돌아옵니다.
 * - 데모 열람의 막힌 동작(ADR 0013)은 모의매매가 운영자 전용이라 아직 쓰지 않습니다 — 막힘은 `disabled`로 충분합니다.
 * - 실제 매매 끄기처럼 늘 보여야 하는 단추는 이 영역에 넣지 않고 제자리에 둡니다(명세 §7-1 SEC-6).
 * - Radix 메뉴를 실어 ui 배럴(`@/components/ui`)에 넣지 않습니다 — 경로(`@/components/ui/ActionBar`)로 가져옵니다.
 */
export function ActionBar({
  label,
  actions,
  maxInline = 3,
  menuLabel = "동작",
}: {
  /** 묶음 이름 — 예 '보유·체결 동작'. */
  label: string;
  actions: readonly ActionBarItem[];
  /** 늘 보이는 단추 수(앞에서부터). 넘는 것은 메뉴로(pin 제외). */
  maxInline?: number;
  /** 넘친 동작 메뉴의 여는 단추 글이자 메뉴 이름. */
  menuLabel?: string;
}): JSX.Element | null {
  // 메뉴에서 고른 동작 — 메뉴가 닫히고 포커스가 돌아간 뒤에 부릅니다.
  const pending = useRef<(() => void) | null>(null);
  if (actions.length === 0) return null;
  const inline = actions.filter((action, index) => index < maxInline || action.pin);
  const overflow = actions.filter((action, index) => !(index < maxInline || action.pin));

  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
      {inline.map((action) => (
        <button
          key={action.id}
          type="button"
          data-action={action.id}
          disabled={action.disabled}
          aria-haspopup={action.opensDialog ? "dialog" : undefined}
          aria-expanded={action.expanded}
          aria-controls={action.controls}
          aria-describedby={action.describedBy}
          onClick={action.onSelect}
          className={buttonClasses(action.intent ?? "default")}
        >
          {action.label}
        </button>
      ))}
      {overflow.length > 0 ? (
        <DropdownMenu
          label={menuLabel}
          onCloseAutoFocus={() => {
            const run = pending.current;
            pending.current = null;
            // 메뉴가 여는 단추로 포커스를 돌린 다음(Radix가 이 처리기 뒤에 함) 부릅니다.
            if (run) queueMicrotask(run);
          }}
          trigger={
            <button type="button" className={buttonClasses("default")}>
              {menuLabel}
              <ChevronDownIcon size={14} />
            </button>
          }
        >
          {overflow.map((action) => (
            <DropdownMenuItem
              key={action.id}
              disabled={action.disabled}
              textValue={action.textValue}
              tone={action.intent === "danger" ? "danger" : undefined}
              onSelect={() => {
                pending.current = action.onSelect;
              }}
            >
              {action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenu>
      ) : null}
    </div>
  );
}
