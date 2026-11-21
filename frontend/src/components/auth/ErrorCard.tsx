"use client";

import Link from "@/components/ui/IntentLink";
import { AuthCard } from "@/components/auth/AuthCard";
import { AUTH_LINK_SHORT, AUTH_SUBMIT } from "@/components/auth/classes";
import { ERROR_RETRY_LABEL, ERROR_SCREEN_TEXT, ERROR_SCREEN_TITLE, errorDigest } from "@/lib/errorScreen";

/**
 * 셸 밖 렌더 예외의 카드(QA-920) — 루트 오류 경계(app/error.tsx)와 전체 오류 경계(app/global-error.tsx)가 함께 씁니다. 루트 not-found(QA-270)와 같은 인증
 * 카드 틀·같은 글 규칙(낱말 사이에서만 꺾는 안내 한 줄, 돌아갈 곳은 홈 하나 — 짧은 글 링크 누름 자리 AUTH_LINK_SHORT)에, 경계의 retry를 부르는 '다시 시도'를
 * 인증 화면의 주 단추(폭 전체 강조 파랑 큰 단추)로 둡니다. 예외 메시지는 보이지 않고 서버 쪽 예외의 digest만 '오류 번호'로 적습니다(lib/errorScreen).
 */
export function ErrorCard({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = errorDigest(error);
  return (
    <AuthCard
      title={ERROR_SCREEN_TITLE}
      footer={
        <Link href="/" className={AUTH_LINK_SHORT}>
          ← 홈
        </Link>
      }
    >
      <p className="mt-2 break-keep text-sm leading-relaxed text-text-2">{ERROR_SCREEN_TEXT}</p>
      {digest ? <p className="mt-2 text-xs text-text-3">오류 번호 {digest}</p> : null}
      <button type="button" onClick={() => retry()} className={AUTH_SUBMIT}>
        {ERROR_RETRY_LABEL}
      </button>
    </AuthCard>
  );
}
