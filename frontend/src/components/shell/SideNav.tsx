"use client";

import Link from "next/link";
import { tabCurrent, visibleTabs } from "@/lib/nav";
import type { SessionUser } from "@/lib/types";
import { AccountBox } from "./AccountBox";
import { BuildInfo } from "./BuildInfo";
import { ReadModeNote } from "./ReadMode";
import { RefreshButton } from "./RefreshButton";
import { ThemeSwitch } from "./ThemeSwitch";
import { TabIcon } from "./icons";

/**
 * 데스크톱(lg 이상) 왼쪽 내비 — 상표, 다섯 탭 + 더보기, 아래쪽에 읽기 모드·수동 새로고침(운영자)·계정·테마·빌드 정보.
 * 좁은 화면에서는 숨기고(하단 탭 바 + 더보기 화면이 대신), 데스크톱에서는 화면 높이에 붙어 본문만 스크롤됩니다.
 */
export function SideNav({ pathname, user }: { pathname: string; user?: SessionUser }) {
  return (
    <aside className="hidden w-[232px] shrink-0 flex-col border-r border-border bg-surface lg:flex lg:h-screen lg:overflow-y-auto">
      <p className="px-6 pb-[18px] pt-[26px] text-[15px] font-bold text-text">My Macro Dashboard v2</p>
      <nav aria-label="주 메뉴" className="flex flex-col gap-1 px-3.5">
        {visibleTabs(user).map((tab) => {
          const current = tabCurrent(tab, pathname);
          return (
            <Link
              key={tab.key}
              href={tab.href}
              aria-current={current}
              className={`flex h-11 items-center gap-2.5 rounded-[10px] px-3 text-[15px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ${
                current ? "bg-surface-2 font-bold text-text" : "text-text-2 hover:bg-surface-2 hover:text-text"
              }`}
            >
              <TabIcon tab={tab.key} />
              {tab.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-3 border-t border-border px-4 py-4">
        {/* 읽기 모드는 세션 응답에 함께 옵니다(예전에는 이 한 줄 때문에 화면마다 무거운 /api/status를 불렀습니다). */}
        <ReadModeNote />
        <RefreshButton user={user} />
        <AccountBox user={user} />
        <ThemeSwitch />
        <BuildInfo />
      </div>
    </aside>
  );
}
