"use client";

import Link from "next/link";
import { lockedFor } from "@/lib/access";
import { subNav } from "@/lib/nav";
import type { SessionUser } from "@/lib/types";

/**
 * 상단바 아래 하위 메뉴 줄 — 지금 탭에 화면이 둘 이상일 때만(lib/nav subNav). 좁으면 가로로 스크롤됩니다(줄을 바꾸지 않음).
 * 준비 중인 화면(모의매매 한국)은 링크 없이 이름만 흐리게 보입니다. 유료 화면은 무료 회원에게 🔒(눌러도 되며 화면이 안내).
 */
export function SubNav({ pathname, user }: { pathname: string; user?: SessionUser }) {
  const model = subNav(pathname, user);
  if (!model) return null;
  return (
    <nav aria-label={`${model.tab.label} 하위 메뉴`} className="shrink-0 border-b border-border bg-surface">
      <ul className="flex gap-1 overflow-x-auto px-2 sm:px-4 lg:px-5">
        {model.items.map((item) => {
          const current = item.href === model.current;
          return (
            <li key={item.href} className="shrink-0">
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={`inline-flex h-11 items-center gap-1 whitespace-nowrap border-b-2 px-3 text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ${
                  current ? "border-accent font-semibold text-text" : "border-transparent text-text-2 hover:text-text"
                }`}
              >
                {item.label}
                {lockedFor(user, item.href) && (
                  <span role="img" aria-label="유료 등급 기능" title="유료 등급 기능">
                    🔒
                  </span>
                )}
              </Link>
            </li>
          );
        })}
        {model.upcoming.map((entry) => (
          <li key={entry.label} className="shrink-0">
            <span aria-disabled="true" className="inline-flex h-11 items-center whitespace-nowrap px-3 text-sm text-text-3">
              {entry.label} · {entry.note}
            </span>
          </li>
        ))}
      </ul>
    </nav>
  );
}
