"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { createContext, useContext, useRef, type ReactElement, type ReactNode } from "react";
import { XIcon } from "@/components/ui/icons";

/** 폭 — 확인 창은 sm, 보통은 md, 검색처럼 목록이 긴 것은 lg. 좁은 화면에서는 양옆 16px만 남기고 다 씁니다. */
const WIDTH = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-2xl" } as const;

export type DialogSize = keyof typeof WIDTH;

/**
 * 범위 표지(data-scope)를 이어받는 자리 — 대화상자는 body 끝으로 옮겨 그려(portal) 화면의 범위 토큰(globals.css의 [data-scope="…"])이
 * 닿지 않습니다. 정보 검색 화면처럼 늘 어두운 화면은 이것으로 감싸 그 안에서 연 대화상자(원문 팝업 등 대화상자를 감싼 부품 포함)에 같은 표지를
 * 붙입니다. 밖에서는 값이 없어 지금처럼 앱 테마 그대로입니다.
 */
const DialogScopeContext = createContext<string | undefined>(undefined);

export function DialogScope({ value, children }: { value: string; children: ReactNode }) {
  return <DialogScopeContext.Provider value={value}>{children}</DialogScopeContext.Provider>;
}

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
 * - `placement="top"`: 화면 위쪽(높이의 12% — 좁은 화면은 1rem)에 붙여 그립니다. 가운데 두면 내용 높이가 바뀔 때마다(검색 결과 수) 위 끝이
 *   오르내려 입력칸이 움직였습니다(사용자 요청 2026-11-02). 기본은 가운데입니다.
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
  placement = "center",
  scope,
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
  /** 세로 자리 — 가운데(기본) 또는 위쪽 고정(내용 높이가 바뀌어도 위 끝이 그대로). */
  placement?: "center" | "top";
  /** 범위 표지 — 주면 대화상자 상자에 data-scope를 붙여 그 범위의 토큰으로 그립니다. 없으면 둘러싼 DialogScope, 그것도 없으면 앱 테마. */
  scope?: string;
  children?: ReactNode;
}) {
  const inherited = useContext(DialogScopeContext);
  const scopeValue = scope ?? inherited;
  // 열기 직전에 포커스가 있던 요소. 이벤트 처리기에서만 읽고 씁니다.
  const opener = useRef<HTMLElement | null>(null);
  const blockWhenBusy = (event: Event) => {
    if (!dismissible) event.preventDefault();
  };

  const heading = (
    <DialogPrimitive.Title className={`text-title-2 text-text ${showClose ? "pr-10" : ""}`}>{title}</DialogPrimitive.Title>
  );

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>}
      <DialogPrimitive.Portal>
        {/* 덮개는 두 테마 모두 검정 반투명입니다(밝은 덮개는 다크에서 화면을 씻어 냄). */}
        <DialogPrimitive.Overlay className={`fixed inset-0 z-50 bg-black/50 ${FADE_IN}`} />
        <DialogPrimitive.Content
          data-scope={scopeValue}
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
          className={`fixed left-1/2 z-50 w-[calc(100%-2rem)] ${WIDTH[size]} -translate-x-1/2 ${
            placement === "top"
              ? "top-4 max-h-[calc(100dvh-2rem)] sm:top-[12dvh] sm:max-h-[calc(88dvh-1rem)]"
              : "top-1/2 max-h-[calc(100dvh-2rem)] -translate-y-1/2"
          } overflow-y-auto rounded-card border border-border bg-surface p-6 text-text shadow-overlay outline-none ${FADE_IN}`}
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
              className="absolute right-2 top-2 inline-flex h-11 w-11 items-center justify-center rounded-full text-text-3 hover:bg-surface-2 hover:text-text motion-safe:transition-colors lg:right-4 lg:top-4 lg:h-8 lg:w-8 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50"
            >
              <XIcon size={16} />
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
