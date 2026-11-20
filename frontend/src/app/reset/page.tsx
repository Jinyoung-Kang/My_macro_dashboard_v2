"use client";

import { FormEvent, useEffect, useId, useRef, useState } from "react";
import { AuthAlert, AuthCard, AuthField, AuthFieldError, AuthMessage } from "@/components/auth/AuthCard";
import { AuthSubmit } from "@/components/auth/AuthSubmit";
import { auth } from "@/lib/api";

/**
 * 비밀번호 재설정 — 링크(?token=) 없이 열면 메일 요청, 링크로 열면 새 비밀번호 입력.
 * 요청 응답은 가입 여부와 무관하게 같습니다. 재설정하면 모든 기기에서 로그아웃됩니다.
 *
 * 낭독(QA-868 — 문구·요청 그대로): 비밀번호 불일치면 확인 입력칸이 aria-invalid이고 불일치 글로 설명됩니다. 서버 오류 상자는 늘 있는 알림 영역(AuthAlert)
 * 안에 그리고 입력칸이 그 글로 설명됩니다. 성공해 폼이 사라지면 포커스를 결과 글로 옮깁니다(누른 단추가 사라져 body로 떨어졌음).
 */
export default function ResetPage() {
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const mismatch = confirm.length > 0 && password !== confirm;
  const mismatchId = useId();
  const errorId = useId();
  const doneRef = useRef<HTMLParagraphElement>(null);

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
    // 요청 중이면 다시 보내지 않습니다 — 단추는 요청 동안 aria-disabled라(QA-909) 입력칸 Enter의 폼 보내기를 막지 못합니다.
    if (busy) return;
    if (token) {
      if (!mismatch) void run(() => auth.confirmReset(token, password));
    } else {
      void run(() => auth.requestReset(email));
    }
  };

  const done = message?.ok;
  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);
  const errorRef = message && !message.ok ? errorId : undefined;
  return (
    <AuthCard title="비밀번호 재설정">
      {!done && (
        <form onSubmit={submit}>
          {token ? (
            <>
              <p className="mt-1 text-xs text-text-3">새 비밀번호를 정하세요(10자 이상). 링크는 한 번만 쓸 수 있습니다.</p>
              <AuthField
                label="새 비밀번호" type="password" value={password} onChange={setPassword} autoComplete="new-password" autoFocus describedBy={errorRef}
              />
              <AuthField
                label="새 비밀번호 확인" type="password" value={confirm} onChange={setConfirm} autoComplete="new-password"
                invalid={mismatch} describedBy={[mismatch ? mismatchId : "", errorRef ?? ""].join(" ").trim()}
              />
              {mismatch && <AuthFieldError id={mismatchId}>비밀번호가 서로 다릅니다.</AuthFieldError>}
            </>
          ) : (
            <>
              <p className="mt-1 text-xs text-text-3">가입한 메일 주소로 재설정 링크를 보냅니다(30분 동안 유효).</p>
              <AuthField label="이메일" type="email" value={email} onChange={setEmail} autoComplete="email" autoFocus describedBy={errorRef} />
            </>
          )}
          <AuthSubmit busy={busy} disabled={token ? !password || mismatch : !email}>
            {token ? "비밀번호 바꾸기" : "재설정 메일 받기"}
          </AuthSubmit>
        </form>
      )}
      <AuthAlert>{message && !message.ok && <AuthMessage tone="error" id={errorId}>{message.text}</AuthMessage>}</AuthAlert>
      {message?.ok && <AuthMessage tone="ok" focusRef={doneRef}>{message.text}</AuthMessage>}
    </AuthCard>
  );
}
