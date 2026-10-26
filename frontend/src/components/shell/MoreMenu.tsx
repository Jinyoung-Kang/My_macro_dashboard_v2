"use client";

import Link from "next/link";
import { useSessionUser } from "@/hooks/useSessionUser";
import { lockedFor } from "@/lib/access";
import { TABS, visibleItems } from "@/lib/nav";
import { AccountBox } from "./AccountBox";
import { BuildInfo } from "./BuildInfo";
import { ReadModeNote } from "./ReadMode";
import { RefreshButton } from "./RefreshButton";
import { ThemeSwitch } from "./ThemeSwitch";
import { ChevronRightIcon } from "./icons";

const MORE = TABS.find((tab) => tab.key === "more");

/**
 * 더보기 화면(/more) — 더보기 하위 화면 목록(행) + 계정 영역 + 읽기 모드·수동 새로고침(운영자) + 테마 전환 + 빌드 정보.
 *
 * 좁은 화면에서는 왼쪽 내비가 없어 계정·읽기 모드·새로고침·테마·빌드 정보를 여기서 씁니다. 데스크톱에서도 열립니다(같은 내용이 왼쪽 내비에도 있음 —
 * 테마 전환 둘은 같은 탭 안 이벤트로 함께 바뀝니다). 운영자 전용 화면은 운영자에게만, 유료 화면은 무료 회원에게 🔒.
 */
export function MoreMenu() {
  const user = useSessionUser();
  const items = MORE ? visibleItems(MORE, user) : [];
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-bold text-text">더보기</h1>
        <p className="mt-1 text-xs text-text-3">알림·계정·운영 화면과 화면 설정</p>
      </header>

      <section aria-labelledby="more-menus" className="flex flex-col gap-2">
        <h2 id="more-menus" className="text-sm font-semibold text-text-2">메뉴</h2>
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
          {items.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="flex min-h-[54px] items-center gap-3 px-4 text-[15px] text-text hover:underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
              >
                <span className="min-w-0 flex-1 truncate">
                  {item.label}
                  {lockedFor(user, item.href) && (
                    <span role="img" aria-label="유료 등급 기능" title="유료 등급 기능" className="ml-1">
                      🔒
                    </span>
                  )}
                </span>
                <span className="text-text-3">
                  <ChevronRightIcon />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="more-account" className="flex flex-col gap-2">
        <h2 id="more-account" className="text-sm font-semibold text-text-2">계정</h2>
        <div className="max-w-sm">
          <AccountBox user={user} />
        </div>
      </section>

      <section aria-labelledby="more-data" className="flex flex-col gap-2">
        <h2 id="more-data" className="text-sm font-semibold text-text-2">데이터 읽기</h2>
        <div className="flex max-w-sm flex-col gap-3">
          <ReadModeNote />
          <RefreshButton user={user} />
        </div>
      </section>

      <section aria-labelledby="more-theme" className="flex flex-col gap-2">
        <h2 id="more-theme" className="text-sm font-semibold text-text-2">화면 테마</h2>
        <div className="max-w-sm">
          <ThemeSwitch />
        </div>
      </section>

      <section aria-labelledby="more-build" className="flex flex-col gap-2">
        <h2 id="more-build" className="text-sm font-semibold text-text-2">빌드 정보</h2>
        <BuildInfo />
      </section>
    </div>
  );
}
