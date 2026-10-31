"use client";

import Link from "next/link";
import { useSessionUser } from "@/hooks/useSessionUser";
import { lockedFor } from "@/lib/access";
import { TABS, visibleItems } from "@/lib/nav";
import { AccountBox } from "./AccountBox";
import { BuildInfo } from "./BuildInfo";
import { PageHeader } from "@/components/ui";
import { LockIcon } from "@/components/ui/icons";
import { ReadModeNote } from "./ReadMode";
import { RefreshButton } from "./RefreshButton";
import { ThemeSwitch } from "./ThemeSwitch";
import { ChevronRightIcon, MenuIcon } from "./icons";

const MORE = TABS.find((tab) => tab.key === "more");

/**
 * 더보기 화면(/more) — 더보기 하위 화면 목록(행) + 계정 영역 + 읽기 모드·수동 새로고침(운영자) + 테마 전환 + 빌드 정보.
 *
 * 좁은 화면에서는 왼쪽 내비가 없어 계정·읽기 모드·새로고침·테마·빌드 정보를 여기서 씁니다. 데스크톱에서도 열립니다(같은 내용이 왼쪽 내비에도 있음 —
 * 테마 전환 둘은 같은 탭 안 이벤트로 함께 바뀝니다). 운영자 전용 화면은 운영자에게만, 유료 화면은 무료 회원에게 🔒.
 * 하위 화면은 목록 행(높이 64px — 원 안 아이콘 · 화면 이름 · 오른쪽 화살표)이고, 행 전체가 링크입니다(hover 바탕).
 */
export function MoreMenu() {
  const user = useSessionUser();
  const items = MORE ? visibleItems(MORE, user) : [];
  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      <PageHeader title="더보기" description="알림·계정·운영 화면과 화면 설정" />

      <section aria-labelledby="more-menus" className="flex flex-col gap-2">
        <h2 id="more-menus" className="text-sm font-semibold text-text-2">메뉴</h2>
        <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
          {items.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="flex min-h-16 items-center gap-3 px-4 text-[15px] font-semibold text-text hover:bg-surface-2 motion-safe:transition-colors motion-safe:duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus lg:px-5"
              >
                <span
                  aria-hidden="true"
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-text-2"
                >
                  <MenuIcon href={item.href} size={20} />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {item.label}
                  {lockedFor(user, item.href) && (
                    <span title="유료 등급 기능" className="ml-1.5 inline-flex align-[-2px]">
                      <LockIcon size={14} label="유료 등급 기능" />
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
