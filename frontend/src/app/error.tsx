"use client";

import { ErrorCard } from "@/components/auth/ErrorCard";

/**
 * 루트 오류 경계(QA-920) — 셸 밖에서 그리는 화면(로그인·가입·인증·재설정·처리방침)과 대시보드 레이아웃(셸) 자체가 렌더 중 던진 예외를 받습니다
 * (Next 규약: error.tsx는 같은 단계의 layout을 감싸지 않으므로 루트 레이아웃의 예외는 app/global-error.tsx가 받음). 셸 안 화면의 예외는 셸 안 경계
 * app/(dashboard)/error.tsx가 셸 본문에 그립니다. 루트 not-found(QA-270)와 같은 인증 카드 틀이고, '다시 시도'는 경계의 reset입니다 — 화면들이 자기
 * 데이터를 브라우저에서 읽으므로(useApi) 서버에서 다시 받을 것(retry의 router.refresh)이 없고, 다시 그리면 화면이 다시 읽습니다.
 * 받는 값은 Next 16 규약의 `{ error: unknown, reset, retry }`(next/dist/client/components/error-boundary ErrorInfo).
 */
export default function RootError({ error, reset }: { error: unknown; reset: () => void }) {
  return <ErrorCard error={error} reset={reset} />;
}
