"use client";

import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { buttonClasses, FOCUS_RING, TEXT_TARGET } from "@/components/ui/classes";
import { ERROR_RETRY_LABEL, ERROR_SCREEN_TEXT, ERROR_SCREEN_TITLE, errorDigest } from "@/lib/errorScreen";

/** 홈 링크 — 셸 안 not-found(app/(dashboard)/not-found.tsx)의 홈 링크와 같은 클래스(강조 파랑 글 링크, 좁은 화면 높이·폭 44px, 글은 머리 시작선). */
const HOME_LINK = `${TEXT_TARGET} min-w-11 rounded-sm text-accent underline-offset-2 hover:text-accent-hover hover:underline lg:min-w-0 ${FOCUS_RING}`;

/**
 * 셸 안 오류 경계(QA-920) — 대시보드 화면이 렌더 중 던진 예외를 받아 셸(왼쪽 메뉴·상단바·빵부스러기)은 그대로 두고 본문에 그립니다. 셸 안 not-found(QA-864)와
 * 같은 꼴 — 셸이 `<main>`을 가지므로 자기 `<main>`·카드 없이 화면 머리(h1)·안내 한 줄(낱말 사이에서만 꺾음)·돌아갈 곳 홈 하나에, 경계의 retry를 부르는
 * '다시 시도' 단추(작은 주 단추 — 좁은 화면 44px)를 홈 링크 앞에 둡니다. retry(Next 16 문서가 권함 — router.refresh + 다시 그림)라 서버 컴포넌트가 던진 예외도
 * 다시 받고, 브라우저에서 읽는 화면(useApi)은 다시 그리며 다시 읽습니다. 주소를 옮기면 Next 경계가 스스로 풀립니다.
 * 예외 메시지는 보이지 않고 서버 쪽 예외의 digest만 '오류 번호'로 적습니다(lib/errorScreen).
 */
export default function DashboardError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = errorDigest(error);
  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
      <PageHeader title={ERROR_SCREEN_TITLE} description={<span className="break-keep">{ERROR_SCREEN_TEXT}</span>} />
      {digest ? <p className="text-xs text-text-3">오류 번호 {digest}</p> : null}
      <p className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <button type="button" onClick={() => retry()} className={buttonClasses("primary", "sm")}>
          {ERROR_RETRY_LABEL}
        </button>
        <Link href="/" className={HOME_LINK}>
          ← 홈
        </Link>
      </p>
    </div>
  );
}
