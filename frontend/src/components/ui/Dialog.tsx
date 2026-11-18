"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { createContext, useContext, useRef, type ReactElement, type ReactNode } from "react";
import { XIcon } from "@/components/ui/icons";

/** 폭 — 확인 창은 sm, 보통은 md, 검색처럼 목록이 긴 것은 lg. 좁은 화면에서는 양옆 16px만 남기고 다 씁니다. */
const WIDTH = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-2xl" } as const;

export type DialogSize = keyof typeof WIDTH;

/** 오른쪽 세로 패널(`placement="end"`)의 폭 — 좁은 화면(sm 미만)은 화면 전체 폭, 그 위는 같은 크기 이름의 폭까지. */
const END_WIDTH = { sm: "sm:max-w-sm", md: "sm:max-w-md", lg: "sm:max-w-2xl" } as const;

/** 대화상자 자리 — 가운데(기본)·위쪽 고정·오른쪽 끝에 붙은 세로 패널(서랍 — ui/Drawer). */
export type DialogPlacement = "center" | "top" | "end";

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
 * 대화상자(모달) — Radix Dialog를 토큰 색으로 감싼 것. 모양은 덮개 3층(작업대 실행 명세 §3-3): 바탕 surface-2, 안쪽 1px 밝은 경계
 * (border-overlay), 바깥 그림자(shadow-overlay), 4px 모서리, 안쪽 16px. 덮개 안에서 누르는 칸의 hover는 surface-3이고, 그 위에는
 * text-3·accent·danger 글자를 두지 않습니다(대비 4.5:1 미만 — 금지 쌍 시험). 상자에 덮개 범위 표지(data-overlay)를 붙여, 안의 공용 단추가
 * 조작 바탕을 한 단계 위(surface-3)로 씁니다 — 기본 단추 바탕·최소 단추 hover가 덮개 바탕(surface-2)에 묻히지 않게(globals.css, 2026-11-16 결정).
 *
 * 포커스 가두기·Esc로 닫기·바깥 누르면 닫기·뒤 화면 aria-hidden·스크롤 잠금은 Radix가 합니다. 여기서 더하는 것은
 * - 이름 필수: `title`이 대화상자의 이름(aria-labelledby)입니다. 화면에 안 보이게 하려면 `hideTitle`(이름은 남음).
 * - 연 단추로 포커스 돌려주기: Radix는 Trigger로만 돌려주므로, Trigger 없이 여는 확인 창도 닫은 뒤 연 단추로 돌아가게 합니다.
 * - `dismissible={false}`: 처리 중에는 Esc·바깥 누르기·닫기 단추로 닫히지 않습니다(결과가 나온 뒤 부르는 쪽이 닫음).
 * - `placement="top"`: 화면 위쪽(높이의 12% — 좁은 화면은 1rem)에 붙여 그립니다. 가운데 두면 내용 높이가 바뀔 때마다(검색 결과 수) 위 끝이
 *   오르내려 입력칸이 움직였습니다(사용자 요청 2026-11-02). 기본은 가운데입니다.
 * - `placement="end"`(작업대 P6 — 서랍 ui/Drawer가 씀): 오른쪽 끝에 붙은 화면 높이의 세로 패널입니다. 좁은 화면(sm 미만)은 화면 전체 폭, 그 위는 `size`의
 *   폭(sm·md·2xl)까지. 덮개 3층(surface-2 바탕·안쪽 밝은 경계 — 화면 안쪽 왼쪽 가장자리 1px·바깥 그림자)·덮개 범위 표지·닫기 단추·포커스 규칙은 같고,
 *   화면 가장자리에 붙어 모서리를 둥글리지 않습니다.
 * - `initialFocus="title"`(작업대 P6 — 목록-검사의 검사 대화상자가 씀): 열 때 첫 포커스를 내용의 첫 조작 대신 제목(h2 — tabIndex -1, 링 없음)에 둡니다.
 *   낭독기가 제목부터 읽고 다음 Tab이 내용의 첫 조작으로 갑니다. 닫으면 연 단추로 돌아가는 규칙은 같습니다. 기본(content)은 Radix 그대로 — 내용의
 *   첫 조작(없으면 닫기 단추)입니다.
 *
 * 열림 상태는 부르는 쪽이 쥡니다(`open`·`onOpenChange`). 닫혀 있으면 내용이 DOM에 없고, 열리면 body 끝으로 옮겨 그립니다(portal).
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  titleLang,
  hideTitle = false,
  description,
  trigger,
  size = "md",
  dismissible = true,
  showClose = true,
  placement = "center",
  initialFocus = "content",
  scope,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 대화상자 이름 — 화면 읽기 프로그램이 "대화상자, {title}"로 읽습니다. */
  title: string;
  /** 제목의 언어(lang) — 화면 글(한국어)과 다른 언어의 이름(영어 기사 제목 등)이면 넘겨 그 언어의 음성으로 읽히게 합니다(WCAG 3.1.2). 없으면 문서 언어. */
  titleLang?: string;
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
  /** 자리 — 가운데(기본), 위쪽 고정(내용 높이가 바뀌어도 위 끝이 그대로), 오른쪽 끝 세로 패널(end — 서랍). */
  placement?: DialogPlacement;
  /** 열 때 첫 포커스 — 내용의 첫 조작(기본 content) 또는 제목(title). */
  initialFocus?: "content" | "title";
  /** 범위 표지 — 주면 대화상자 상자에 data-scope를 붙여 그 범위의 토큰으로 그립니다. 없으면 둘러싼 DialogScope, 그것도 없으면 앱 테마. */
  scope?: string;
  children?: ReactNode;
}) {
  const inherited = useContext(DialogScopeContext);
  const scopeValue = scope ?? inherited;
  // 열기 직전에 포커스가 있던 요소. 이벤트 처리기에서만 읽고 씁니다.
  const opener = useRef<HTMLElement | null>(null);
  // 제목 — 첫 포커스를 제목에 둘 때(initialFocus="title")만 씁니다.
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleFocus = initialFocus === "title";
  const blockWhenBusy = (event: Event) => {
    if (!dismissible) event.preventDefault();
  };

  // 제목은 데이터 이름(13F 보유 종목·기관 이름)이 들어오기도 해 대상 머리 h1·검사 칸 제목과 같은 이름 규칙 — 말줄임 없이 낱말 사이에서 줄을 바꾸고
  // 칸보다 긴 낱말만 칸 안에서 끊습니다(QA-569 — 공백 없는 긴 이름이 닫기 단추 밑으로 넘쳐 대화상자가 가로로 스크롤됐음).
  const heading = (
    <DialogPrimitive.Title
      ref={titleRef}
      lang={titleLang}
      tabIndex={titleFocus ? -1 : undefined}
      className={`min-w-0 break-keep wrap-anywhere text-heading text-text ${showClose ? "pr-10" : ""}${titleFocus ? " outline-none" : ""}`.trim()}
    >
      {title}
    </DialogPrimitive.Title>
  );

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>}
      <DialogPrimitive.Portal>
        {/* 덮개 뒤 가림은 토큰 scrim(바탕색 70% — 원색 클래스 없이, 실행 명세 §3-2)입니다. */}
        <DialogPrimitive.Overlay className={`fixed inset-0 z-50 bg-scrim ${FADE_IN}`} />
        <DialogPrimitive.Content
          data-scope={scopeValue}
          data-overlay=""
          onOpenAutoFocus={(event) => {
            // 이 시점에는 아직 포커스가 옮겨지기 전입니다(Radix FocusScope가 옮기기 직전에 부름).
            const active = document.activeElement;
            opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
            // 제목 첫 포커스 — Radix의 첫 조작 포커스를 막고 제목에 둡니다(제목은 포커스 가둠 안 — 대화상자 내용의 첫 요소).
            if (titleFocus) {
              event.preventDefault();
              titleRef.current?.focus();
            }
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
          className={
            placement === "end"
              ? `fixed inset-y-0 right-0 z-50 w-full ${END_WIDTH[size]} overflow-y-auto border-l border-border-overlay bg-surface-2 p-4 text-text shadow-overlay outline-none ${FADE_IN}`
              : `fixed left-1/2 z-50 w-[calc(100%-2rem)] ${WIDTH[size]} -translate-x-1/2 ${
                  placement === "top"
                    ? "top-4 max-h-[calc(100dvh-2rem)] sm:top-[12dvh] sm:max-h-[calc(88dvh-1rem)]"
                    : "top-1/2 max-h-[calc(100dvh-2rem)] -translate-y-1/2"
                } overflow-y-auto rounded-card border border-border-overlay bg-surface-2 p-4 text-text shadow-overlay outline-none ${FADE_IN}`
          }
        >
          {hideTitle ? <VisuallyHidden.Root asChild>{heading}</VisuallyHidden.Root> : heading}
          {description && (
            <DialogPrimitive.Description asChild>
              <div className="mt-1 text-sm leading-relaxed text-text-2">{description}</div>
            </DialogPrimitive.Description>
          )}
          {children}
          {/* 닫기 단추는 DOM 맨 끝에 둡니다 — 열었을 때 첫 포커스가 내용(입력칸·취소 단추)으로 가게(보이기는 오른쪽 위).
              좁은 화면(lg 미만)에서는 누르는 칸을 44px로 키우고 위치를 그만큼 당겨 X 아이콘 자리는 그대로 둡니다. 넓은 화면은 최소 단추 30px.
              덮개 안 hover 바탕은 surface-3이라 아이콘 색은 text-3이 아니라 text-2입니다(금지 쌍). */}
          {showClose && (
            <DialogPrimitive.Close
              aria-label="닫기"
              disabled={!dismissible}
              className="absolute right-2 top-2 inline-flex h-11 w-11 items-center justify-center rounded-control text-text-2 hover:bg-surface-3 hover:text-text motion-safe:transition-colors lg:right-3 lg:top-3 lg:h-[30px] lg:w-[30px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50"
            >
              <XIcon size={16} />
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
