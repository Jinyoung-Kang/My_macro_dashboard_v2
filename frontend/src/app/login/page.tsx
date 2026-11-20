"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { FormEvent, useEffect, useId, useState } from "react";
import { AuthAlert, AuthMessage, credentialsRejected } from "@/components/auth/AuthCard";
import { AuthSubmit } from "@/components/auth/AuthSubmit";
import { AUTH_CARD, AUTH_LINK, AUTH_TITLE } from "@/components/auth/classes";
import { inputClasses } from "@/components/ui";
import { isDemo, isLocalOwner } from "@/lib/access";
import { auth } from "@/lib/api";

/**
 * 로그인 — 이메일·비밀번호(계정, ADR 0010).
 *
 * 비밀번호는 백엔드가 검증하고, 세션은 httpOnly 쿠키로 유지됩니다.
 * (토큰을 브라우저 저장소에 두지 않습니다 — XSS로 새어 나갈 수 있습니다.)
 * 처음 쓰는 경우 운영자 계정은 .env의 OWNER_EMAIL·APP_PASSWORD로 만들어집니다.
 *
 * 데모 열람(ADR 0013 — AWS 공개 데모에서 접근 코드를 통과한 방문자)과 로그인 없이 연 로컬 운영자(ADR 0016 —
 * 로컬 Docker 실행에서 localhost로 연 경우)는 로그인하지 않으므로 대시보드 첫 화면으로 보냅니다.
 *
 * 낭독(QA-868 — 문구·요청·리디렉트 그대로): 오류 상자는 늘 있는 알림 영역(AuthAlert) 안에 그리고, 두 입력칸이 오류 글로 설명됩니다(aria-describedby).
 * 서버가 이메일·비밀번호를 받지 않은 401이면 두 칸이 aria-invalid입니다(연결 실패 등은 설명만).
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  // 서버가 이메일·비밀번호를 받지 않았는지(401) — 두 입력칸의 aria-invalid(QA-868).
  const [rejected, setRejected] = useState(false);
  const errorId = useId();
  const [busy, setBusy] = useState(false);
  // 가입·재설정은 백엔드에 메일 발송이 설정됐을 때만 보여 줍니다.
  const [mailAvailable, setMailAvailable] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    auth
      .session()
      .then((s) => {
        if (s.authenticated && (isDemo(s.user) || isLocalOwner(s.user))) {
          setLeaving(true);
          router.replace("/");
          return;
        }
        setMailAvailable(Boolean(s.mailAvailable));
      })
      .catch(() => setMailAvailable(false));
  }, [router]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // 요청 중이면 다시 보내지 않습니다 — 단추는 요청 동안 aria-disabled라(QA-909) 입력칸 Enter의 폼 보내기를 막지 못합니다.
    if (busy) return;
    setBusy(true);
    setError(null);
    setRejected(false);
    try {
      await auth.login(email, password);
      // 로그인 뒤 첫 화면은 홈(/)입니다(v2 — 예전에는 /가 /macro로 리디렉션돼 바로 매크로 화면으로 보냈음).
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "로그인에 실패했습니다.");
      setRejected(credentialsRejected(err));
    } finally {
      setBusy(false);
    }
  };

  // 로그인할 필요가 없으면 첫 화면으로 가는 동안 로그인 칸을 보이지 않습니다.
  if (leaving) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-text-3">
        대시보드로 이동하는 중…
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form
        onSubmit={submit}
        className={AUTH_CARD}
      >
        <h1 className={AUTH_TITLE}>Global Macro &amp; 13F Dashboard</h1>
        <p className="mt-1 text-[13px] text-text-2">인가된 사용자만 접근할 수 있는 시스템입니다.</p>

        <label className="mt-6 block text-[13px] font-medium text-text-2">
          이메일
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            autoFocus
            aria-invalid={rejected || undefined}
            aria-describedby={error ? errorId : undefined}
            className={`mt-1.5 w-full ${inputClasses("lg")}`}
          />
        </label>

        <label className="mt-4 block text-[13px] font-medium text-text-2">
          비밀번호
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Enter Password..."
            autoComplete="current-password"
            aria-invalid={rejected || undefined}
            aria-describedby={error ? errorId : undefined}
            className={`mt-1.5 w-full ${inputClasses("lg")}`}
          />
        </label>

        <AuthAlert>{error && <AuthMessage tone="error" id={errorId}>{error}</AuthMessage>}</AuthAlert>

        <AuthSubmit busy={busy} disabled={password.length === 0 || email.trim().length === 0} busyLabel="확인 중…">
          로그인
        </AuthSubmit>

        {mailAvailable && (
          <div className="mt-5 flex justify-between text-[13px] text-text-2">
            <Link href="/signup" className={AUTH_LINK}>가입하기</Link>
            <Link href="/reset" className={AUTH_LINK}>비밀번호를 잊었나요?</Link>
          </div>
        )}
      </form>
    </main>
  );
}
