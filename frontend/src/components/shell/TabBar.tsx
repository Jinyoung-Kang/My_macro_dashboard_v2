"use client";

import Link from "next/link";
import { tabCurrent, visibleTabs } from "@/lib/nav";
import type { SessionUser } from "@/lib/types";
import { TabIcon } from "./icons";

/** 칸 수별 격자(Tailwind가 찾을 수 있게 클래스 이름을 통째로 적습니다). 회원은 모의매매가 빠져 다섯 칸입니다. */
const COLUMNS: Record<number, string> = { 5: "grid-cols-5", 6: "grid-cols-6" };

/**
 * 좁은 화면(lg 미만) 아래쪽 탭 바 — 홈·시장·기관·한국·모의매매(운영자만)·더보기, 같은 폭의 칸에 아이콘(22px) + 12px 이름.
 * 지금 탭은 강조 파랑 글·굵은 글(셸의 현재 메뉴 — 명세 원칙 A1), 나머지는 text-3(바탕 대비 5.1:1). 고대비(forced-colors) 모드에서는
 * 색이 지워지므로 지금 탭 이름에 밑줄을 더합니다(D9 — 굵기 차이와 함께 색 말고도 구분).
 * 화면 아래에 붙어 있고(높이 64px + 안전 영역), 본문은 그만큼 아래 여백을 둡니다(Shell). Tab으로 옮긴 포커스가 이 밑에 숨지 않게
 * 문서 스크롤 여백(html scroll-padding-bottom)도 같은 높이입니다(globals.css). 데스크톱에서는 숨깁니다.
 */
export function TabBar({ pathname, user }: { pathname: string; user?: SessionUser }) {
  // 정보 수집은 넓은 화면의 왼쪽 내비에만 — 아래쪽 탭 바는 6칸 그대로, 좁은 화면에서는 더보기에서 엽니다(사용자 결정 2026-11-11).
  const tabs = visibleTabs(user).filter((tab) => tab.key !== "info");
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
            className={`flex h-16 min-w-0 flex-col items-center justify-center gap-1 text-xs motion-safe:transition-colors motion-safe:duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ${
              current ? "font-semibold text-accent" : "font-normal text-text-3 hover:text-text"
            }`}
          >
            <TabIcon tab={tab.key} size={22} />
            <span className={`max-w-full truncate${current ? " forced-colors:underline" : ""}`}>{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
