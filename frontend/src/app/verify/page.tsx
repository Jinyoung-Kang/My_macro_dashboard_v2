"use client";

import { useEffect, useRef, useState } from "react";
import { AuthCard, AuthMessage } from "@/components/auth/AuthCard";
import { auth } from "@/lib/api";

/**
 * 메일 인증 링크 — ?token=…을 백엔드에 한 번 넘깁니다(링크는 한 번만 쓸 수 있음).
 *
 * 결과(성공·실패)가 '확인하는 중…'을 바꾸면 포커스를 결과 글로 옮겨 낭독기가 읽게 합니다(QA-868 — 예전에는 조용히 바뀌고 포커스는 body). 화면에 다른
 * 조작은 '← 로그인' 하나뿐이고 사용자가 기다리는 것이 이 결과라, 포커스가 어디 있든 옮깁니다(알림 영역을 따로 두면 포커스와 함께 두 번 읽힘).
 */
export default function VerifyPage() {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const sent = useRef(false);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const arrived = result !== null;

  useEffect(() => {
    if (sent.current) return;   // 개발 모드의 이중 실행에서 토큰을 두 번 쓰지 않게
    sent.current = true;
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    auth.verify(token)
      .then((response) => setResult({ ok: true, message: response.message }))
      .catch((err) => setResult({ ok: false, message: err instanceof Error ? err.message : "인증하지 못했습니다." }));
  }, []);

  useEffect(() => {
    if (arrived) resultRef.current?.focus();
  }, [arrived]);

  return (
    <AuthCard title="메일 인증">
      {result === null ? (
        <p className="mt-3 text-xs text-text-3">확인하는 중…</p>
      ) : (
        <AuthMessage tone={result.ok ? "ok" : "error"} focusRef={resultRef}>{result.message}</AuthMessage>
      )}
    </AuthCard>
  );
}
