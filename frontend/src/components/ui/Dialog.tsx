"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { useRef, type ReactElement, type ReactNode } from "react";

/** 폭 — 확인 창은 sm, 보통은 md, 검색처럼 목록이 긴 것은 lg. 좁은 화면에서는 양옆 16px만 남기고 다 씁니다. */
const WIDTH = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-2xl" } as const;

export type DialogSize = keyof typeof WIDTH;

/*
 * 움직임은 나타날 때의 짧은 흐려짐(150ms) 하나뿐이고, 움직임 줄이기(prefers-reduced-motion)면 없습니다 — motion-safe: 안에만 둡니다.
 * 키프레임을 따로 두지 않고 @starting-style(starting:)을 써서 globals.css를 건드리지 않습니다. 닫힐 때는 바로 사라집니다.
 */
const FADE_IN = "motion-safe:transition-opacity motion-safe:duration-150 motion-safe:starting:opacity-0";

/**
 * 대화상자(모달) — Radix Dialog를 토큰 색으로 감싼 것.
 *
 * 포커스 가두기·Esc로 닫기·바깥 누르면 닫기·뒤 화면 aria-hidden·스크롤 잠금은 Radix가 합니다. 여기서 더하는 것은
 * - 이름 필수: `title`이 대화상자의 이름(aria-labelledby)입니다. 화면에 안 보이게 하려면 `hideTitle`(이름은 남음).
 * - 연 단추로 포커스 돌려주기: Radix는 Trigger로만 돌려주므로, Trigger 없이 여는 확인 창도 닫은 뒤 연 단추로 돌아가게 합니다.
 * - `dismissible={false}`: 처리 중에는 Esc·바깥 누르기·닫기 단추로 닫히지 않습니다(결과가 나온 뒤 부르는 쪽이 닫음).
 *
 * 열림 상태는 부르는 쪽이 쥡니다(`open`·`onOpenChange`). 닫혀 있으면 내용이 DOM에 없고, 열리면 body 끝으로 옮겨 그립니다(portal).
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  hideTitle = false,
  description,
  trigger,
  size = "md",
  dismissible = true,
  showClose = true,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 대화상자 이름 — 화면 읽기 프로그램이 "대화상자, {title}"로 읽습니다. */
  title: string;
  /** 제목을 화면에서 숨기고 이름으로만 남깁니다(검색 창처럼 입력칸이 제목 노릇을 할 때). */
  hideTitle?: boolean;
  /** 제목 아래 설명(aria-describedby로 이어짐). 블록 요소를 넣어도 되게 div로 그립니다. */
  description?: ReactNode;
  /** 여는 단추(요소 하나). 넘기면 Radix Trigger로 감싸 aria-haspopup="dialog"·aria-expanded가 붙습니다. */
  trigger?: ReactElement;
  size?: DialogSize;
  /** false면 Esc·바깥 누르기·닫기 단추로 닫히지 않습니다. */
  dismissible?: boolean;
  /** 오른쪽 위 닫기(✕) 단추. 확인 창처럼 취소 단추가 따로 있으면 끕니다. */
  showClose?: boolean;
  children?: ReactNode;
}) {
  // 열기 직전에 포커스가 있던 요소. 이벤트 처리기에서만 읽고 씁니다.
  const opener = useRef<HTMLElement | null>(null);
  const blockWhenBusy = (event: Event) => {
    if (!dismissible) event.preventDefault();
  };

  const heading = (
    <DialogPrimitive.Title className={`text-base font-semibold text-text ${showClose ? "pr-10" : ""}`}>{title}</DialogPrimitive.Title>
  );

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>}
      <DialogPrimitive.Portal>
        {/* 덮개는 두 테마 모두 검정 반투명입니다(밝은 덮개는 다크에서 화면을 씻어 냄). */}
        <DialogPrimitive.Overlay className={`fixed inset-0 z-50 bg-black/50 ${FADE_IN}`} />
        <DialogPrimitive.Content
          onOpenAutoFocus={() => {
            // 이 시점에는 아직 포커스가 옮겨지기 전입니다(Radix FocusScope가 옮기기 직전에 부름).
            const active = document.activeElement;
            opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
          }}
          onCloseAutoFocus={(event) => {
            // dev Strict Mode의 가짜 언마운트에서도 불립니다 — 내용이 아직 DOM에 있으면 열려 있는 것이므로 포커스를 옮기지 않습니다.
            if ((event.currentTarget as Node | null)?.isConnected) {
              event.preventDefault();
              return;
            }
            const target = opener.current;
            opener.current = null;
            if (target?.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
          onEscapeKeyDown={blockWhenBusy}
          onInteractOutside={blockWhenBusy}
          className={`fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] ${WIDTH[size]} -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-surface p-5 text-text outline-none ${FADE_IN}`}
        >
          {hideTitle ? <VisuallyHidden.Root asChild>{heading}</VisuallyHidden.Root> : heading}
          {description && (
            <DialogPrimitive.Description asChild>
              <div className="mt-1 text-sm leading-relaxed text-text-2">{description}</div>
            </DialogPrimitive.Description>
          )}
          {children}
          {/* 닫기 단추는 DOM 맨 끝에 둡니다 — 열었을 때 첫 포커스가 내용(입력칸·취소 단추)으로 가게(보이기는 오른쪽 위).
              좁은 화면(lg 미만)에서는 누르는 칸을 44px로 키우고 위치를 그만큼 당겨 X 아이콘 자리는 그대로 둡니다. */}
          {showClose && (
            <DialogPrimitive.Close
              aria-label="닫기"
              disabled={!dismissible}
              className="absolute right-1.5 top-1.5 inline-flex h-11 w-11 items-center justify-center rounded-md text-text-3 hover:bg-surface-2 hover:text-text lg:right-3 lg:top-3 lg:h-8 lg:w-8 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50"
            >
              <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
