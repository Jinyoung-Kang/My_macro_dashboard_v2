"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { AuthCard, AuthField, AuthMessage, AuthSubmit } from "@/components/auth/AuthCard";
import { FOCUS_RING } from "@/components/ui";
import { auth } from "@/lib/api";

/**
 * 가입 — 무료 회원으로 만들고, 받은 메일의 링크를 열어야 로그인할 수 있습니다.
 * 이미 있는 주소여도 같은 안내가 나옵니다(계정 존재를 화면으로 드러내지 않음).
 */
export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const mismatch = confirm.length > 0 && password !== confirm;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    try {
      setDone((await auth.signup(email, password, agreed)).message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "가입하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="가입">
      {done ? (
        <AuthMessage tone="ok">{done}</AuthMessage>
      ) : (
        <form onSubmit={submit}>
          <p className="mt-1 text-xs text-muted">무료 회원으로 가입합니다. 비밀번호는 10자 이상입니다.</p>
          <AuthField label="이메일" type="email" value={email} onChange={setEmail} autoComplete="email" autoFocus />
          <AuthField label="비밀번호" type="password" value={password} onChange={setPassword} autoComplete="new-password" />
          <AuthField label="비밀번호 확인" type="password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
          {mismatch && <p className="mt-2 text-xs text-danger">비밀번호가 서로 다릅니다.</p>}
          <label className="mt-4 flex items-start gap-2 text-xs text-body">
            <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} className={`mt-0.5 size-4 shrink-0 accent-accent ${FOCUS_RING}`} />
            <span>
              <Link href="/privacy" className="text-accent underline">개인정보 수집·이용</Link>(이메일·비밀번호 해시·알림 설정)에
              동의합니다.
            </span>
          </label>
          {error && <AuthMessage tone="error">{error}</AuthMessage>}
          <AuthSubmit busy={busy} disabled={!email || !password || mismatch || !agreed}>가입하고 확인 메일 받기</AuthSubmit>
        </form>
      )}
    </AuthCard>
  );
}
