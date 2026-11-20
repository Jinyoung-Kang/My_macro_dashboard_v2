import type { ReactNode } from "react";
import { AUTH_SUBMIT } from "@/components/auth/classes";

/**
 * 인증 카드의 주 단추(보내기) — 가입·재설정 폼이 씁니다. 카드 틀(AuthCard.tsx)은 서버 컴포넌트(/privacy·루트 not-found)도 가져오므로, 폼에서만 쓰는
 * 이 단추는 따로 둡니다(클라이언트 화면만 가져옴).
 */
export function AuthSubmit({ busy, disabled, children }: { busy: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="submit" disabled={busy || disabled} className={AUTH_SUBMIT}>
      {busy ? "처리 중…" : children}
    </button>
  );
}
