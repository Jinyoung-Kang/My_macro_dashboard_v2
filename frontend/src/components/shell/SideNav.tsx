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
 *
 * 메뉴는 알약 모양(높이 48px). 지금 탭은 옅은 강조 파랑 바탕·강조 파랑 글·굵은 글입니다 — 셸의 현재 메뉴는 누를 수 있는 것이라
 * 강조 파랑을 씁니다(명세 원칙 A1). 고대비(forced-colors) 모드에서는 바탕색이 지워지므로 지금 탭에만 1px 테두리를 더하고(D9),
 * 나머지 칸에는 테두리를 두지 않습니다(투명 테두리는 그 모드에서 시스템 색으로 보여 모든 칸이 고른 것처럼 보임).
 */
export function SideNav({ pathname, user }: { pathname: string; user?: SessionUser }) {
  return (
    <aside className="hidden w-[232px] shrink-0 flex-col border-r border-border bg-surface lg:flex lg:h-screen lg:overflow-y-auto">
      {/* 상표는 한 줄(시안 15px 굵게). 232px 폭에서 "v2"가 다음 줄로 넘어갔습니다 — 대체 글꼴(약 204px)도 오른쪽 여백 안에서 끝납니다. */}
      <p className="whitespace-nowrap px-6 pb-[18px] pt-[26px] text-[15px] font-bold text-text">My Macro Dashboard v2</p>
      <nav aria-label="주 메뉴" className="flex flex-col gap-1 px-3">
        {visibleTabs(user).map((tab) => {
          const current = tabCurrent(tab, pathname);
          return (
            <Link
              key={tab.key}
              href={tab.href}
              aria-current={current}
              className={`flex h-12 items-center gap-3 rounded-full px-4 text-[15px] motion-safe:transition-colors motion-safe:duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ${
                current
                  ? "bg-accent-tint font-semibold text-accent forced-colors:border"
                  : "font-medium text-text-2 hover:bg-surface-2 hover:text-text"
              }`}
            >
              <TabIcon tab={tab.key} size={22} />
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
