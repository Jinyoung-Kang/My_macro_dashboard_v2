"use client";

import { useEffect, useRef, useState } from "react";
import { AuthCard, AuthMessage } from "@/components/auth/AuthCard";
import { auth } from "@/lib/api";

/** 메일 인증 링크 — ?token=…을 백엔드에 한 번 넘깁니다(링크는 한 번만 쓸 수 있음). */
export default function VerifyPage() {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;   // 개발 모드의 이중 실행에서 토큰을 두 번 쓰지 않게
    sent.current = true;
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    auth.verify(token)
      .then((response) => setResult({ ok: true, message: response.message }))
      .catch((err) => setResult({ ok: false, message: err instanceof Error ? err.message : "인증하지 못했습니다." }));
  }, []);

  return (
    <AuthCard title="메일 인증">
      {result === null ? (
        <p className="mt-3 text-xs text-text-3">확인하는 중…</p>
      ) : (
        <AuthMessage tone={result.ok ? "ok" : "error"}>{result.message}</AuthMessage>
      )}
    </AuthCard>
  );
}
