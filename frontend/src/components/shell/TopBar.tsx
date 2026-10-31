"use client";

import Link from "next/link";
import { MarketClock } from "@/components/MarketClock";
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
 * 상단바 — 좁은 화면의 짧은 상표, 통합 검색 단추(⌘K), 장 상태 칩 둘(MarketClock), 알림 벨(/alerts, 읽지 않은 수 배지).
 * 넓은 화면(lg 이상)은 높이 64px 한 줄(검색 · 빈칸 · 장 상태 칩 · 벨), 좁은 화면은 64px 줄(상표·검색·벨) 아래 장 상태 칩 줄을 하나 더 둡니다.
 * 장 시계는 인스턴스 하나이고 자리(order)만 바뀝니다 — 둘로 그리면 공휴일 요청·1초 시계·글이 두 번씩 생깁니다.
 * 데스크톱에서는 본문만 스크롤되므로 늘 보이고, 좁은 화면에서는 페이지와 함께 올라갑니다(고정하면 화면 안 #앵커 제목을 가림).
 */
export function TopBar({ pathname, user, unread }: { pathname: string; user?: SessionUser; unread?: number | null }) {
  const badge = unreadBadge(unread);
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-3 border-b border-border bg-surface px-4 sm:px-6 lg:h-16 lg:flex-nowrap lg:px-7">
      <span className="flex h-16 shrink-0 items-center whitespace-nowrap text-[15px] font-bold text-text lg:hidden">My Macro v2</span>
      <SearchCommand user={user} />
      {/* 빈칸은 검색 단추(기준 폭 520px)가 다 자란 뒤에 남는 자리만 차지합니다 — 장 상태 칩이 들어온 뒤로 둘이 남는 폭을 반씩 나눠 검색이 좁아졌습니다. */}
      <div className="hidden flex-1 lg:block" />
      {/* 좁은 화면: 맨 뒤 순서(order-last)·폭 전체라 둘째 줄로 내려갑니다. 넓은 화면: 원래 순서대로 빈칸과 벨 사이. 칩이 폭보다 넓으면
          이 줄만 가로로 넘깁니다(페이지 가로 스크롤을 만들지 않음). */}
      <div className="order-last flex h-10 w-full min-w-0 items-start overflow-x-auto lg:order-none lg:h-auto lg:w-auto lg:shrink-0 lg:items-center lg:overflow-visible">
        <MarketClock />
      </div>
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
