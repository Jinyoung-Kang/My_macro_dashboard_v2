"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
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
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
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
    setBusy(true);
    setError(null);
    try {
      await auth.login(email, password);
      // 로그인 뒤 첫 화면은 홈(/)입니다(v2 — 예전에는 /가 /macro로 리디렉션돼 바로 매크로 화면으로 보냈음).
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "로그인에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  // 로그인할 필요가 없으면 첫 화면으로 가는 동안 로그인 칸을 보이지 않습니다.
  if (leaving) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-muted">
        대시보드로 이동하는 중…
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-xl border border-border bg-surface p-6"
      >
        <h1 className="text-lg font-bold text-bright">🔒 Global Macro &amp; 13F Dashboard</h1>
        <p className="mt-1 text-xs text-muted">인가된 사용자만 접근할 수 있는 시스템입니다.</p>

        <label className="mt-6 block text-xs text-muted">
          이메일
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            autoFocus
            className="mt-1 w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-body outline-hidden focus:border-accent"
          />
        </label>

        <label className="mt-3 block text-xs text-muted">
          비밀번호
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Enter Password..."
            autoComplete="current-password"
            className="mt-1 w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-body outline-hidden focus:border-accent"
          />
        </label>

        {error && (
          <p className="mt-3 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || password.length === 0 || email.trim().length === 0}
          className="mt-5 w-full rounded-md border border-accent/60 bg-accent/15 px-3 py-2 text-sm font-semibold text-accent transition hover:bg-accent/25 disabled:opacity-50"
        >
          {busy ? "확인 중…" : "로그인"}
        </button>

        {mailAvailable && (
          <div className="mt-4 flex justify-between text-xs text-muted">
            <Link href="/signup" className="hover:text-accent">가입하기</Link>
            <Link href="/reset" className="hover:text-accent">비밀번호를 잊었나요?</Link>
          </div>
        )}
      </form>
    </main>
  );
}
