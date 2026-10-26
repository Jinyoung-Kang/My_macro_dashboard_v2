"use client";

import Link from "next/link";
import { unreadBadge } from "@/lib/alerts";
import type { SessionUser } from "@/lib/types";
import { SearchCommand } from "./SearchCommand";
import { BellIcon } from "./icons";

/**
 * 알림 벨의 이름 — 읽지 않은 수를 알면 함께 읽어 줍니다. 아직 모르면(읽는 중·실패) 수를 지어내지 않고 "알림"만.
 */
function bellLabel(unread: number | null | undefined): string {
  return typeof unread === "number" ? `알림 — 읽지 않음 ${unread}건` : "알림";
}

/**
 * 상단바(모든 폭, 높이 64px) — 좁은 화면의 짧은 상표, 통합 검색 단추(⌘K), 알림 벨(/alerts, 읽지 않은 수 배지).
 * 데스크톱에서는 본문만 스크롤되므로 늘 보이고, 좁은 화면에서는 페이지와 함께 올라갑니다(고정하면 화면 안 #앵커 제목을 가림).
 */
export function TopBar({ pathname, user, unread }: { pathname: string; user?: SessionUser; unread?: number | null }) {
  const badge = unreadBadge(unread);
  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 sm:px-6 lg:px-7">
      <span className="shrink-0 whitespace-nowrap text-[15px] font-bold text-text lg:hidden">My Macro v2</span>
      <SearchCommand user={user} />
      <div className="hidden flex-1 lg:block" />
      <Link
        href="/alerts"
        aria-label={bellLabel(unread)}
        aria-current={pathname === "/alerts" ? "page" : undefined}
        className="relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-border bg-surface text-text hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <BellIcon />
        {badge && (
          <span
            aria-hidden="true"
            className="absolute -right-1.5 -top-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[11px] font-semibold tabular-nums text-accent-fg"
          >
            {badge}
          </span>
        )}
      </Link>
    </header>
  );
}
