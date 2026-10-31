"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonClasses } from "@/components/ui";
import { AlertTriangleIcon, StatusText } from "@/components/ui/icons";
import { auth } from "@/lib/api";
import { DEMO_READ_ONLY, LOCAL_NO_LOGIN, accountInitial, isDemo, isLocalOwner, roleLabel } from "@/lib/access";
import type { SessionUser } from "@/lib/types";

// 계정 행(내 계정 링크) — 누르는 것이라 좁은 화면(더보기 화면 — 손가락)에서 높이 44px 이상. 원 안 글자는 이메일 첫 글자(장식).
const ROW =
  "flex min-h-11 items-center gap-2.5 rounded-control px-2 py-1.5 hover:bg-surface-2 motion-safe:transition-colors motion-safe:duration-150";
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** 계정 행 — 원(이메일 첫 글자) · 이름(이메일 또는 '로컬 · 로그인 없음') · 역할 캡션. 긴 이메일은 말줄임하고 title에 전부 둡니다. */
function AccountRow({ user, name }: { user: SessionUser; name: string }) {
  const initial = accountInitial(user);
  return (
    <Link href="/account" className={`${ROW} ${FOCUS}`}>
      {initial && (
        <span
          aria-hidden="true"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-[13px] font-semibold text-text-2"
        >
          {initial}
        </span>
      )}
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[13px] font-medium leading-5 text-text" title={name}>
          {name}
        </span>
        <span className="text-xs leading-4 text-text-3">{roleLabel(user)}</span>
      </span>
    </Link>
  );
}

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
      <p className="rounded-control bg-surface-2 px-3 py-2 text-xs leading-5 text-text-2">
        {roleLabel(user)}
        <span className="ml-1 text-text-3">· {DEMO_READ_ONLY}</span>
      </p>
    );
  }

  if (user && isLocalOwner(user)) {
    return <AccountRow user={user} name={LOCAL_NO_LOGIN} />;
  }

  return (
    <div className="flex flex-col gap-2">
      {user && <AccountRow user={user} name={user.email ?? roleLabel(user)} />}
      <button
        type="button"
        onClick={() => void logout()}
        className={`${buttonClasses("secondary", "sm")} w-full`}
      >
        로그아웃
      </button>
      {logoutError && (
        <p role="alert" className="text-xs leading-5 text-warn">
          <StatusText tone="warn" icon={<AlertTriangleIcon size={12} />}>
            {logoutError}
          </StatusText>
        </p>
      )}
    </div>
  );
}
