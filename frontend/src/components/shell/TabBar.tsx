"use client";

import Link from "next/link";
import { tabCurrent, visibleTabs } from "@/lib/nav";
import type { SessionUser } from "@/lib/types";
import { TabIcon } from "./icons";

/** 칸 수별 격자(Tailwind가 찾을 수 있게 클래스 이름을 통째로 적습니다). 회원은 모의매매가 빠져 다섯 칸입니다. */
const COLUMNS: Record<number, string> = { 5: "grid-cols-5", 6: "grid-cols-6" };

/**
 * 좁은 화면(lg 미만) 아래쪽 탭 바 — 홈·시장·기관·한국·모의매매(운영자만)·더보기, 같은 폭의 칸에 아이콘 + 12px 이름.
 * 화면 아래에 붙어 있고(높이 64px + 안전 영역), 본문은 그만큼 아래 여백을 둡니다(Shell). 데스크톱에서는 숨깁니다.
 */
export function TabBar({ pathname, user }: { pathname: string; user?: SessionUser }) {
  const tabs = visibleTabs(user);
  return (
    <nav
      aria-label="하단 메뉴"
      className={`fixed inset-x-0 bottom-0 z-40 grid border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden ${COLUMNS[tabs.length] ?? "grid-cols-6"}`}
    >
      {tabs.map((tab) => {
        const current = tabCurrent(tab, pathname);
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={current}
            className={`flex h-16 min-w-0 flex-col items-center justify-center gap-[3px] text-xs focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ${
              current ? "font-bold text-text" : "text-text-3 hover:text-text"
            }`}
          >
            <TabIcon tab={tab.key} size={20} />
            <span className="max-w-full truncate">{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
