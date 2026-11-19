import Link from "next/link";
import type { ReactNode } from "react";
import { AUTH_CARD, AUTH_LINK, AUTH_MESSAGE, AUTH_MESSAGE_TONE, AUTH_SUBMIT, AUTH_TITLE } from "@/components/auth/classes";
import { inputClasses } from "@/components/ui/classes";
import { StatusText } from "@/components/ui/icons";

/**
 * 로그인 밖 화면(로그인·가입·인증·재설정·처리방침)의 공통 틀 — 화면 가운데 카드 하나(4px 모서리, 안쪽 24px), 제목 20px,
 * 입력칸·주 단추는 큰 조작(넓은 화면 40px, 좁은 화면 44px), 주 단추는 폭 전체 강조 파랑(명세 §7-3 배치, 작업대 화면 언어 겉모양).
 * 클래스는 서버 컴포넌트(/privacy)도 쓰므로 순수 모듈에서 가져옵니다.
 */
export function AuthCard({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className={AUTH_CARD}>
        <h1 className={AUTH_TITLE}>{title}</h1>
        {children}
        <div className="mt-6 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-text-2">
          {footer ?? <Link href="/login" className={AUTH_LINK}>← 로그인</Link>}
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
    <label className="mt-4 block text-[13px] font-medium text-text-2">
      {label}
      <input
        type={type}
        value={value}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-1.5 w-full ${inputClasses("lg")}`}
      />
    </label>
  );
}

/**
 * 결과 상자(오류·성공) — 공용 상태 글(StatusText)이라 오류는 위험 톤 아이콘과 낭독기 머리말 '오류: ', 성공은 정상 톤 체크 아이콘이 글 앞에 붙습니다
 * (색만으로 가르지 않음 — QA-855). 아이콘은 순수 SVG(components/ui/icons)라 서버 컴포넌트에서도 그릴 수 있습니다.
 */
export function AuthMessage({ tone, children }: { tone: "error" | "ok"; children: ReactNode }) {
  return (
    <p className={`${AUTH_MESSAGE} ${AUTH_MESSAGE_TONE[tone]}`}>
      <StatusText tone={tone === "error" ? "danger" : "ok"}>{children}</StatusText>
    </p>
  );
}

/** 입력 칸 아래의 오류 글(비밀번호 불일치) — 12px, 위험 톤 아이콘 + 낭독기 머리말 + 글(QA-855). */
export function AuthFieldError({ children }: { children: ReactNode }) {
  return (
    <p className="mt-2 text-xs">
      <StatusText tone="danger" iconSize={12}>
        {children}
      </StatusText>
    </p>
  );
}

export function AuthSubmit({ busy, disabled, children }: { busy: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="submit" disabled={busy || disabled} className={AUTH_SUBMIT}>
      {busy ? "처리 중…" : children}
    </button>
  );
}
