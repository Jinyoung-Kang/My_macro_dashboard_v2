"use client";

import { FormEvent, useEffect, useState } from "react";
import { AuthCard, AuthField, AuthFieldError, AuthMessage, AuthSubmit } from "@/components/auth/AuthCard";
import { auth } from "@/lib/api";

/**
 * 비밀번호 재설정 — 링크(?token=) 없이 열면 메일 요청, 링크로 열면 새 비밀번호 입력.
 * 요청 응답은 가입 여부와 무관하게 같습니다. 재설정하면 모든 기기에서 로그아웃됩니다.
 */
export default function ResetPage() {
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const mismatch = confirm.length > 0 && password !== confirm;

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token"));
  }, []);

  const run = async (action: () => Promise<{ message: string }>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ ok: true, text: (await action()).message });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "처리하지 못했습니다." });
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (token) {
      if (!mismatch) void run(() => auth.confirmReset(token, password));
    } else {
      void run(() => auth.requestReset(email));
    }
  };

  const done = message?.ok;
  return (
    <AuthCard title="비밀번호 재설정">
      {!done && (
        <form onSubmit={submit}>
          {token ? (
            <>
              <p className="mt-1 text-xs text-text-3">새 비밀번호를 정하세요(10자 이상). 링크는 한 번만 쓸 수 있습니다.</p>
              <AuthField label="새 비밀번호" type="password" value={password} onChange={setPassword} autoComplete="new-password" autoFocus />
              <AuthField label="새 비밀번호 확인" type="password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
              {mismatch && <AuthFieldError>비밀번호가 서로 다릅니다.</AuthFieldError>}
            </>
          ) : (
            <>
              <p className="mt-1 text-xs text-text-3">가입한 메일 주소로 재설정 링크를 보냅니다(30분 동안 유효).</p>
              <AuthField label="이메일" type="email" value={email} onChange={setEmail} autoComplete="email" autoFocus />
            </>
          )}
          <AuthSubmit busy={busy} disabled={token ? !password || mismatch : !email}>
            {token ? "비밀번호 바꾸기" : "재설정 메일 받기"}
          </AuthSubmit>
        </form>
      )}
      {message && <AuthMessage tone={message.ok ? "ok" : "error"}>{message.text}</AuthMessage>}
    </AuthCard>
  );
}
