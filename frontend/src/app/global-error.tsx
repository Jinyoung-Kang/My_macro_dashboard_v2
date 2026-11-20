"use client";

import { ErrorCard } from "@/components/auth/ErrorCard";
import { ERROR_DOCUMENT_TITLE } from "@/lib/errorScreen";
import "./globals.css";

/**
 * 전체 오류 경계(QA-920) — 루트 레이아웃(app/layout.tsx)이 렌더 중 던진 예외를 받습니다. 활성이면 루트 레이아웃을 대신하므로 Next 16 규약대로
 * `<html>`·`<body>`를 스스로 그리고 전역 CSS(어두운 토큰 — ADR 0042 결정 2)를 가져오며, metadata를 쓸 수 없어 React `<title>`을 둡니다(설치된 next의
 * docs/01-app/03-api-reference/03-file-conventions/error.md 'Global Error'). `<html>`·`<body>`는 루트 레이아웃과 같은 언어·바탕 클래스이고, 없앤 테마
 * 선택의 값을 지우는 인라인 스크립트는 두지 않습니다(다음 정상 적재 때 루트 레이아웃이 지움). 안은 루트 오류 경계와 같은 카드입니다.
 */
export default function GlobalError({ error, reset }: { error: unknown; reset: () => void }) {
  return (
    <html lang="ko">
      <body className="min-h-screen bg-bg text-text antialiased">
        <title>{ERROR_DOCUMENT_TITLE}</title>
        <ErrorCard error={error} reset={reset} />
      </body>
    </html>
  );
}
