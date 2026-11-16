"use client";

import Link from "next/link";
import { buttonClasses } from "@/components/ui";
import { AlertTriangleIcon, StatusText } from "@/components/ui/icons";
import { useLogout } from "@/hooks/useLogout";
import { DEMO_READ_ONLY, accountInitial, isDemo, isLocalOwner, noLoginName, roleLabel } from "@/lib/access";
import type { SessionUser } from "@/lib/types";

// 계정 행(내 계정 링크) — 누르는 것이라 좁은 화면(더보기 화면 — 손가락)에서 높이 44px 이상. 원 안 글자는 이메일 첫 글자(장식).
const ROW =
  "flex min-h-11 items-center gap-2.5 rounded-control px-2 py-1.5 hover:bg-surface-2 motion-safe:transition-colors motion-safe:duration-150";
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/**
 * 계정 머리글자 원판(장식 — 이메일 첫 글자). 이메일이 없으면(데모 열람·사용자 모름) 그리지 않습니다 — 빈 원을 두지 않습니다.
 * 더보기의 계정 행과 넓은 화면 상단바 계정 메뉴의 계정 줄(AccountMenu)이 같이 씁니다.
 */
export function AccountAvatar({ user }: { user: SessionUser | null | undefined }) {
  const initial = accountInitial(user);
  if (!initial) return null;
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-[13px] font-semibold text-text-2"
    >
      {initial}
    </span>
  );
}

/**
 * 데모 열람 한 줄 — "데모 열람 · 데모에서는 조회만 가능합니다"(계정·세션이 없어 내 계정·로그아웃 대신, ADR 0013). 더보기에서는 상자(surface-2)로,
 * 넓은 화면 계정 메뉴의 설명 칸에서는 상자 없이(`boxed={false}` — 덮개 바탕이 이미 surface-2) 그립니다.
 */
export function DemoNote({ user, boxed = true }: { user: SessionUser | null | undefined; boxed?: boolean }) {
  return (
    <p className={`${boxed ? "rounded-control bg-surface-2 px-3 py-2 " : ""}text-xs leading-5 text-text-2`}>
      {roleLabel(user)}
      <span className="ml-1 text-text-3">· {DEMO_READ_ONLY}</span>
    </p>
  );
}

/** 계정 행 — 원(이메일 첫 글자) · 이름(이메일 또는 '로컬 · 로그인 없음') · 역할 캡션. 긴 이메일은 말줄임하고 title에 전부 둡니다. */
function AccountRow({ user, name }: { user: SessionUser; name: string }) {
  return (
    <Link href="/account" className={`${ROW} ${FOCUS}`}>
      <AccountAvatar user={user} />
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
 * 계정 영역 — 누가 보고 있는지와 내 계정·로그아웃(더보기 화면 — 좁은 화면의 계정 자리. 넓은 화면은 상단바의 계정 메뉴 AccountMenu가 같은 규칙으로 그림).
 *
 * - 데모 열람(ADR 0013)은 계정·세션이 없어 내 계정·로그아웃 대신 "데모 열람 · 조회만" 표시. 접근은 앞단의 접근 코드가 정합니다.
 * - 로그인 없이 연 로컬 운영자(ADR 0016)는 세션이 없어 로그아웃할 것이 없습니다 — "로컬 · 로그인 없음"을 내 계정 링크로(비밀번호 변경은 거기서).
 * - 그 밖에는 이메일·등급(내 계정 링크)과 로그아웃. 로그아웃이 실패하면 삼키지 않고 알립니다(QA-051).
 *
 * 로그아웃 단추와 내 계정 링크는 처음 그릴 때부터 DOM에 있습니다(닫힌 메뉴 안에 두지 않음 — 더보기 화면 시험이 고정).
 */
export function AccountBox({ user }: { user?: SessionUser }) {
  // 실패를 삼키면 버튼이 아무 반응 없이 끝나고 세션은 그대로입니다(QA-051) — useLogout이 실패 글을 돌려줍니다.
  const { logout, error: logoutError } = useLogout();

  if (isDemo(user)) {
    return <DemoNote user={user} />;
  }

  if (user && isLocalOwner(user)) {
    return <AccountRow user={user} name={noLoginName(user)} />;
  }

  return (
    <div className="flex flex-col gap-2">
      {user && <AccountRow user={user} name={user.email ?? roleLabel(user)} />}
      <button
        type="button"
        onClick={() => void logout()}
        className={`${buttonClasses("secondary", "md")} w-full`}
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
