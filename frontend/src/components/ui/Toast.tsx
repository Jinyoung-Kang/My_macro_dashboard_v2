"use client";

import * as ToastPrimitive from "@radix-ui/react-toast";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

export type ToastTone = "info" | "warn";

type ToastItem = { id: number; message: string; tone: ToastTone };

/** 한 알림이 떠 있는 시간. 마우스를 올리거나 포커스가 들어가면 Radix가 멈춥니다. */
const DURATION_MS = 5000;
/** 한꺼번에 보이는 수 — 넘치면 오래된 것부터 뺍니다(화면 구석이 알림으로 덮이지 않게). */
const MAX_VISIBLE = 3;

type ToastApi = { show: (message: string, tone?: ToastTone) => void };

// Provider 밖(페이지·섹션만 그리는 테스트 등)에서는 아무것도 하지 않습니다. 알림은 보조 수단이라 결과는 화면 본문에도 남깁니다.
const ToastContext = createContext<ToastApi>({ show: () => {} });

const TONE = {
  info: "border-border",
  warn: "border-warn",
} as const;

/**
 * 짧은 안내(토스트) — Radix Toast. 앱 셸에 한 번 두고 안쪽에서 `useToast().show(문구, "info" | "warn")`로 띄웁니다.
 *
 * - 자리: 데스크톱(lg 이상)은 오른쪽 아래, 좁은 화면은 하단 탭 바(64px + 안전 영역) 위로 80px 띄웁니다.
 * - 읽어 주기: Radix가 body 끝의 숨은 role="status" 영역으로 읽습니다(info는 polite, warn은 assertive).
 *   목록 항목(li)에 role을 덮지 않습니다 — 목록 의미가 깨지고 같은 글이 두 번 읽힙니다.
 * - 5초 뒤 사라지고, 닫기 단추·Esc·오른쪽으로 밀기로도 닫힙니다. F8로 알림 영역에 포커스를 옮길 수 있습니다.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const show = useCallback((message: string, tone: ToastTone = "info") => {
    nextId.current += 1;
    const item = { id: nextId.current, message, tone };
    setItems((current) => [...current, item].slice(-MAX_VISIBLE));
  }, []);
  const remove = useCallback((id: number) => setItems((current) => current.filter((item) => item.id !== id)), []);
  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      <ToastPrimitive.Provider label="안내" duration={DURATION_MS} swipeDirection="right">
        {children}
        {items.map((item) => (
          <ToastPrimitive.Root
            key={item.id}
            type={item.tone === "warn" ? "foreground" : "background"}
            onOpenChange={(open) => {
              if (!open) remove(item.id);
            }}
            className={`flex items-start gap-3 rounded-xl border bg-surface py-3 pl-4 pr-2 text-sm text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] motion-safe:transition-opacity motion-safe:duration-150 motion-safe:starting:opacity-0 ${TONE[item.tone]}`}
          >
            <ToastPrimitive.Description className="min-w-0 flex-1 py-1 leading-relaxed">
              {item.tone === "warn" && (
                <>
                  <span aria-hidden="true" className="mr-1 text-warn">⚠️</span>
                  <span className="sr-only">주의: </span>
                </>
              )}
              {item.message}
            </ToastPrimitive.Description>
            <ToastPrimitive.Close
              aria-label="닫기"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport
          label="안내 메시지 ({hotkey})"
          className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-[60] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2 outline-none lg:bottom-4"
        />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

/** 토스트를 띄우는 함수. ToastProvider 밖에서는 아무것도 하지 않습니다. */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}
