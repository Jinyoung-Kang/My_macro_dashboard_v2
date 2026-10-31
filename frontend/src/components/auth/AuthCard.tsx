import Link from "next/link";
import type { ReactNode } from "react";
import { inputClasses } from "@/components/ui/classes";

/** 로그인 밖 화면(로그인·가입·인증·재설정·처리방침)의 공통 틀. */
export function AuthCard({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6">
        <h1 className="text-lg font-bold text-bright">{title}</h1>
        {children}
        <div className="mt-5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {footer ?? <Link href="/login" className="hover:text-accent">← 로그인</Link>}
        </div>
      </div>
    </main>
  );
}

/** 입력 칸 하나. */
export function AuthField({
  label, type = "text", value, onChange, autoComplete, autoFocus,
}: {
  label: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  autoFocus?: boolean;
}) {
  return (
    <label className="mt-3 block text-xs text-muted">
      {label}
      <input
        type={type}
        value={value}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-1 w-full ${inputClasses()}`}
      />
    </label>
  );
}

export function AuthMessage({ tone, children }: { tone: "error" | "ok"; children: ReactNode }) {
  const style = tone === "error"
    ? "border-danger/40 bg-danger/10 text-danger"
    : "border-ok/40 bg-ok/10 text-ok";
  return <p className={`mt-3 rounded-sm border px-3 py-2 text-xs ${style}`}>{children}</p>;
}

export function AuthSubmit({ busy, disabled, children }: { busy: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      className="mt-5 w-full rounded-md border border-accent/60 bg-accent/15 px-3 py-2 text-sm font-semibold text-accent transition hover:bg-accent/25 disabled:opacity-50"
    >
      {busy ? "처리 중…" : children}
    </button>
  );
}
