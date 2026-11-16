"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cloneElement, createContext, useContext, useState, type ReactElement, type ReactNode, type Ref } from "react";

/** 툴팁 상자 — 덮개 3층(surface-2·안쪽 밝은 경계·그림자·4px, 작업대 실행 명세 §3-3), 글은 caption(13px). */
const CONTENT = "z-50 max-w-xs rounded-control border border-border-overlay bg-surface-2 px-2 py-1 text-caption text-text shadow-overlay";

/** 이미 TooltipProvider 안인가 — 밖에서 쓴 Tooltip은 스스로 Provider로 감쌉니다(Radix는 Provider 없이 그리면 멈춤). */
const ProvidedContext = createContext(false);

/**
 * 툴팁 묶음 — 여는 지연 300ms, 다른 툴팁으로 옮겨 가면 300ms 안에는 바로 엽니다(Radix skipDelayDuration). 셸이 하나를 두고(Shell),
 * 그 밖에서 그린 Tooltip(시험·다른 화면)은 스스로 감쌉니다.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={300} skipDelayDuration={300}>
      <ProvidedContext.Provider value={true}>{children}</ProvidedContext.Provider>
    </TooltipPrimitive.Provider>
  );
}

type AnyProps = Record<string, unknown>;

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

/**
 * labelOnly 트리거 — Radix 툴팁 트리거가 넘긴 속성을 자식 요소에 합쳐 붙이되 aria-describedby만 뺍니다. 툴팁 글이 접근 이름과 같을 때
 * (접힌 메뉴의 탭 이름 등) 같은 글을 이름과 설명으로 두 번 읽지 않게 합니다. 자식에 aria-describedby: undefined를 두는 것으로는 지워지지 않습니다 —
 * Radix Slot 1.5.0이 자식과 트리거의 aria-describedby를 이어 붙이기 때문입니다(concatAriaDescribedby, 시험으로 확인).
 * 합치는 규칙은 Radix Slot과 같습니다 — 처리기(on…)는 자식 것 다음 트리거 것, className은 이어 붙이고 style은 합치며, 나머지는 자식 값이 이깁니다.
 */
function WithoutDescription({ children, ref, ...triggerProps }: AnyProps & { children: ReactElement<AnyProps>; ref?: Ref<HTMLElement> }) {
  delete triggerProps["aria-describedby"];
  const own = children.props;
  const merged: AnyProps = { ...triggerProps };
  for (const [name, value] of Object.entries(own)) {
    const theirs = triggerProps[name];
    if (/^on[A-Z]/.test(name) && typeof value === "function" && typeof theirs === "function") {
      merged[name] = (...args: unknown[]) => {
        value(...args);
        theirs(...args);
      };
    } else if (name === "className") {
      merged[name] = [theirs, value].filter(Boolean).join(" ");
    } else if (name === "style") {
      merged[name] = { ...(theirs as object | undefined), ...(value as object | undefined) };
    } else {
      merged[name] = value;
    }
  }
  const ownRef = own.ref as Ref<HTMLElement> | undefined;
  merged.ref = (node: HTMLElement | null) => {
    assignRef(ref, node);
    assignRef(ownRef, node);
  };
  return cloneElement(children, merged);
}

/**
 * 툴팁 — Radix Tooltip을 토큰 색으로 감싼 것(ADR 0042 결정 9, 실행 명세 §6 '메뉴·툴팁'). 처음 쓰는 곳은 넓은 화면 셸(P3 — 상단바 아이콘 단추의 이름,
 * 접힌 왼쪽 메뉴의 탭 이름, 접기 단추의 단축키 안내).
 *
 * - **이름을 대신하지 않습니다** — 접근 이름은 aria-label·sr-only 글이 나르고, 툴팁은 마우스를 올리거나 키보드로 포커스했을 때 보이는 보조 설명입니다.
 *   손가락으로 누를 때는 열리지 않습니다(Radix — 터치 포인터는 무시). Esc·포커스가 떠나면 닫힙니다.
 * - 열린 동안 트리거는 툴팁을 설명(aria-describedby)으로 잇습니다. 툴팁 글이 이름과 같으면 `labelOnly`로 그 연결을 뺍니다(같은 글을 두 번 읽지 않게).
 * - `disabled`면 열리지 않습니다 — 펼친 왼쪽 메뉴처럼 이름이 이미 보일 때. 감싼 구조는 그대로라 접고 펼 때 자식 요소(링크)가 다시 만들어지지 않습니다
 *   (포커스가 남음).
 * - 자식은 요소 하나(포커스를 받는 단추·링크)입니다.
 */
export function Tooltip({
  content,
  side = "bottom",
  align = "center",
  labelOnly = false,
  disabled = false,
  children,
}: {
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /** 툴팁 글이 트리거의 접근 이름과 같음 — 설명 연결(aria-describedby)을 두지 않습니다. */
  labelOnly?: boolean;
  /** 열지 않음(구조는 그대로). */
  disabled?: boolean;
  children: ReactElement<AnyProps>;
}) {
  const provided = useContext(ProvidedContext);
  // 열림은 늘 여기서 쥡니다 — disabled일 때만 제어하고 아닐 때 놓으면(제어 ↔ 비제어 전환) Radix가 개발 경고를 냅니다. disabled인 동안에는
  // 열림을 받지 않습니다 — 받아 두면 마우스가 떠난 뒤(상자가 없어 닫힘을 못 받음) disabled가 풀릴 때 툴팁이 뜬금없이 나타납니다.
  const [open, setOpen] = useState(false);
  const tooltip = (
    <TooltipPrimitive.Root open={open && !disabled} onOpenChange={(next) => setOpen(next && !disabled)}>
      <TooltipPrimitive.Trigger asChild>{labelOnly ? <WithoutDescription>{children}</WithoutDescription> : children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content side={side} align={align} sideOffset={6} collisionPadding={8} className={CONTENT}>
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
  return provided ? tooltip : <TooltipProvider>{tooltip}</TooltipProvider>;
}
