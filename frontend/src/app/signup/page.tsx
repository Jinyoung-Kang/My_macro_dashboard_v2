"use client";

import Link from "next/link";
import { FormEvent, useEffect, useId, useRef, useState } from "react";
import { AuthAlert, AuthCard, AuthField, AuthFieldError, AuthMessage } from "@/components/auth/AuthCard";
import { AuthSubmit } from "@/components/auth/AuthSubmit";
import { AUTH_CHECK } from "@/components/auth/classes";
import { FOCUS_RING } from "@/components/ui";
import { auth } from "@/lib/api";

/**
 * 가입 — 무료 회원으로 만들고, 받은 메일의 링크를 열어야 로그인할 수 있습니다.
 * 이미 있는 주소여도 같은 안내가 나옵니다(계정 존재를 화면으로 드러내지 않음).
 *
 * 낭독(QA-868 — 문구·요청 그대로): 비밀번호 불일치면 확인 입력칸이 aria-invalid이고 불일치 글로 설명됩니다. 서버 오류 상자는 늘 있는 알림 영역(AuthAlert)
 * 안에 그리고 세 입력칸이 그 글로 설명됩니다. 가입되어 폼이 결과 글로 바뀌면 포커스를 결과 글로 옮깁니다(누른 단추가 사라져 body로 떨어졌음).
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
  const mismatchId = useId();
  const errorId = useId();
  const doneRef = useRef<HTMLParagraphElement>(null);
  const finished = done !== null;
  useEffect(() => {
    if (finished) doneRef.current?.focus();
  }, [finished]);
  const errorRef = error ? errorId : undefined;

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
        <AuthMessage tone="ok" focusRef={doneRef}>{done}</AuthMessage>
      ) : (
        <form onSubmit={submit}>
          <p className="mt-1 text-xs text-text-3">무료 회원으로 가입합니다. 비밀번호는 10자 이상입니다.</p>
          <AuthField label="이메일" type="email" value={email} onChange={setEmail} autoComplete="email" autoFocus describedBy={errorRef} />
          <AuthField label="비밀번호" type="password" value={password} onChange={setPassword} autoComplete="new-password" describedBy={errorRef} />
          <AuthField
            label="비밀번호 확인" type="password" value={confirm} onChange={setConfirm} autoComplete="new-password"
            invalid={mismatch} describedBy={[mismatch ? mismatchId : "", errorRef ?? ""].join(" ").trim()}
          />
          {mismatch && <AuthFieldError id={mismatchId}>비밀번호가 서로 다릅니다.</AuthFieldError>}
          <label className={AUTH_CHECK}>
            <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} className={`mt-0.5 size-4 shrink-0 accent-accent ${FOCUS_RING}`} />
            <span>
              <Link href="/privacy" className="text-accent underline">개인정보 수집·이용</Link>(이메일·비밀번호 해시·알림 설정)에
              동의합니다.
            </span>
          </label>
          <AuthAlert>{error && <AuthMessage tone="error" id={errorId}>{error}</AuthMessage>}</AuthAlert>
          <AuthSubmit busy={busy} disabled={!email || !password || mismatch || !agreed}>가입하고 확인 메일 받기</AuthSubmit>
        </form>
      )}
    </AuthCard>
  );
}
