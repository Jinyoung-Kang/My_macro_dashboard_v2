"use client";

import { usePathname } from "next/navigation";
import { MarketClock } from "@/components/MarketClock";
import type { SessionUser } from "@/lib/types";
import { ReadModeProvider } from "./ReadMode";
import { SideNav } from "./SideNav";
import { SubNav } from "./SubNav";
import { TabBar } from "./TabBar";
import { TopBar } from "./TopBar";

/**
 * 앱 셸 — 왼쪽 내비(lg 이상) · 상단바(검색·알림 벨) · 하위 메뉴 줄 · 본문 · 하단 탭 바(lg 미만). 옛 Sidebar를 대신합니다.
 *
 * 세션은 다시 읽지 않습니다 — 사용자·읽기 모드·읽지 않은 알림 수는 대시보드 레이아웃이 한 번 읽어 넘깁니다(레이아웃 세션 테스트가
 * 세션 호출 횟수를 고정). 읽기 모드는 본문 화면(더보기)도 읽도록 context로 내려 줍니다.
 * 주소는 usePathname만 씁니다(테스트의 next/navigation mock은 usePathname·useRouter뿐).
 *
 * 본문(main#main)은 min-w-0·overflow-x-hidden으로 넓은 표가 페이지 가로 스크롤을 만들지 않게 하고, 데스크톱에서는 본문만 스크롤됩니다.
 * 좁은 화면에서는 하단 탭 바(64px + 안전 영역)에 끝 내용이 가리지 않게 그만큼 아래 여백을 둡니다.
 */
export function Shell({
  user,
  readMode,
  unread,
  children,
}: {
  user?: SessionUser;
  readMode?: string;
  /** 읽지 않은 알림 수. 모르면(읽는 중·실패) null — 0으로 바꾸지 않습니다. */
  unread?: number | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  return (
    <ReadModeProvider readMode={readMode}>
      <div className="min-h-screen lg:flex">
        <a
          href="#main"
          className="sr-only rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-fg focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          본문으로 건너뛰기
        </a>
        <SideNav pathname={pathname} user={user} />
        <div className="flex min-w-0 flex-1 flex-col lg:h-screen">
          <TopBar pathname={pathname} user={user} unread={unread} />
          <SubNav pathname={pathname} user={user} />
          <main
            id="main"
            tabIndex={-1}
            className="min-h-0 min-w-0 flex-1 overflow-x-hidden p-4 pb-[calc(64px+1rem+env(safe-area-inset-bottom))] outline-none sm:p-6 sm:pb-[calc(64px+1.5rem+env(safe-area-inset-bottom))] lg:overflow-y-auto lg:pb-6"
          >
            <div className="mb-5">
              <MarketClock />
            </div>
            {children}
          </main>
        </div>
        <TabBar pathname={pathname} user={user} />
      </div>
    </ReadModeProvider>
  );
}
