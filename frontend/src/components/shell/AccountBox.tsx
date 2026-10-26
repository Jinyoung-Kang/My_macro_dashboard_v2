"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { auth } from "@/lib/api";
import { DEMO_READ_ONLY, LOCAL_NO_LOGIN, isDemo, isLocalOwner, roleLabel } from "@/lib/access";
import type { SessionUser } from "@/lib/types";

const BOX = "block rounded-lg border border-border bg-surface px-3 text-xs leading-5 text-text-2";
// 누르는 것(내 계정 링크·로그아웃)은 좁은 화면(더보기 화면 — 손가락)에서 높이 44px 이상, 왼쪽 내비(lg)에서는 촘촘하게.
const TAP_BOX = `${BOX} py-3 lg:py-2`;
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/**
 * 계정 영역 — 누가 보고 있는지와 내 계정·로그아웃(왼쪽 내비 아래와 더보기 화면).
 *
 * - 데모 열람(ADR 0013)은 계정·세션이 없어 내 계정·로그아웃 대신 "데모 열람 · 조회만" 표시. 접근은 앞단의 접근 코드가 정합니다.
 * - 로그인 없이 연 로컬 운영자(ADR 0016)는 세션이 없어 로그아웃할 것이 없습니다 — "로컬 · 로그인 없음"을 내 계정 링크로(비밀번호 변경은 거기서).
 * - 그 밖에는 이메일·등급(내 계정 링크)과 로그아웃. 로그아웃이 실패하면 삼키지 않고 알립니다(QA-051).
 *
 * 로그아웃 단추와 내 계정 링크는 처음 그릴 때부터 DOM에 있습니다(닫힌 메뉴 안에 두지 않음 — 레이아웃 세션 테스트가 고정).
 */
export function AccountBox({ user }: { user?: SessionUser }) {
  const router = useRouter();
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const logout = async () => {
    setLogoutError(null);
    try {
      await auth.logout();
      router.push("/login");
    } catch (err) {
      // 실패를 삼키면 버튼이 아무 반응 없이 끝나고 세션은 그대로입니다(QA-051).
      setLogoutError(`로그아웃하지 못했습니다 — ${err instanceof Error ? err.message : "다시 시도하세요"}`);
    }
  };

  if (isDemo(user)) {
    return (
      <p className={`${BOX} py-2`}>
        {roleLabel(user)}
        <span className="ml-1 text-text-3">· {DEMO_READ_ONLY}</span>
      </p>
    );
  }

  if (isLocalOwner(user)) {
    return (
      <Link href="/account" className={`${TAP_BOX} hover:bg-surface-2 ${FOCUS}`}>
        {LOCAL_NO_LOGIN}
        <span className="ml-1 text-text-3">· {roleLabel(user)}</span>
      </Link>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {user && (
        <Link href="/account" className={`${TAP_BOX} break-all hover:bg-surface-2 ${FOCUS}`}>
          {user.email}
          <span className="ml-1 text-text-3">· {roleLabel(user)}</span>
        </Link>
      )}
      <button
        type="button"
        onClick={() => void logout()}
        className={`inline-flex h-11 items-center justify-center rounded-lg border border-border bg-surface px-3 text-sm font-medium text-text hover:bg-surface-2 lg:h-9 ${FOCUS}`}
      >
        로그아웃
      </button>
      {logoutError && (
        <p role="alert" className="text-xs leading-5 text-warn">
          <span aria-hidden="true">⚠️ </span>
          {logoutError}
        </p>
      )}
    </div>
  );
}
