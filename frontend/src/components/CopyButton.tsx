"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { copyText } from "@/lib/clipboard";

/**
 * 복사 버튼 — 눌렀을 때 <b>무슨 일이 일어났는지</b>를 반드시 알려 줍니다.
 *
 * <p>예전 "원본 데이터 복사" 버튼은 성공해도 실패해도 화면이 그대로여서,
 * 사용자가 복사가 된 건지 알 수 없었습니다(보안 컨텍스트가 아니면 조용히
 * 실패합니다).
 *
 * <p>`text`에 함수를 주면 누를 때 값을 만들어 옵니다. 아직 받아 오지 않은
 * 데이터를 복사해야 할 때 씁니다 — 화면에 펼치지 않아도 복사는 되게.
 */
export function CopyButton({
  text,
  label = "복사",
  copiedLabel = "복사됨 ✓",
  variant = "default",
  disabled,
}: {
  text: string | null | undefined | (() => Promise<string | null> | string | null);
  label?: string;
  copiedLabel?: string;
  variant?: "default" | "primary" | "ghost";
  disabled?: boolean;
}) {
  const [state, setState] = useState<"idle" | "working" | "copied">("idle");
  const [error, setError] = useState<string | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) {
        clearTimeout(resetTimer.current);
      }
    },
    [],
  );

  const handleClick = async () => {
    setError(null);
    setState("working");
    try {
      const value = typeof text === "function" ? await text() : text;
      if (!value) {
        throw new Error("복사할 내용이 아직 없습니다.");
      }
      await copyText(value);
      setState("copied");
      resetTimer.current = setTimeout(() => setState("idle"), 2000);
    } catch (err) {
      setState("idle");
      setError(err instanceof Error ? err.message : "복사하지 못했습니다.");
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant={variant}
        onClick={handleClick}
        disabled={disabled || state === "working"}
      >
        {state === "working" ? "복사 중…" : state === "copied" ? copiedLabel : label}
      </Button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </span>
  );
}
