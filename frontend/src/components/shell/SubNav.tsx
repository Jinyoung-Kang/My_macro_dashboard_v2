"use client";

import Link from "next/link";
import { underlineTabClasses } from "@/components/ui/classes";
import { LockIcon } from "@/components/ui/icons";
import { lockedFor } from "@/lib/access";
import { subNav } from "@/lib/nav";
import type { SessionUser } from "@/lib/types";

/**
 * 상단바 아래 하위 메뉴 줄 — 지금 탭에 화면이 둘 이상일 때만(lib/nav subNav). 좁으면 가로로 스크롤됩니다(줄을 바꾸지 않음).
 * 준비 중인 화면(lib/nav upcoming — 지금은 없음, 예전 모의매매 한국)은 링크 없이 이름만 흐리게 보이고, 언제 여는지("2단계")를 작은 표시로 붙입니다 — title이 아니라
 * 보이는 글이라 키보드·터치 사용자도 봅니다. 유료 화면은 무료 회원에게 🔒(눌러도 되며 화면이 안내).
 * 고른 링크의 aria-current는 그 주소 그대로면 "page", 그 화면의 아래 주소(/paper/us/holdings)면 "true"입니다(lib/nav currentAria).
 *
 * 모양은 밑줄 탭(`underlineTabClasses` md — 15px·높이 48px). 모의매매 화면 안의 7탭은 한 단계 작은 sm(14px·44px)이라 두 줄이
 * 같은 모양으로 겹쳐 위계가 흐려지지 않습니다(명세 §4). 바깥 줄은 폭 전체, 안의 목록은 본문 열(최대 1280px)과 같은 세로줄에 글을 맞춥니다
 * — 탭 안쪽 여백(12px)만큼 목록 여백을 줄였습니다.
 */
export function SubNav({ pathname, user }: { pathname: string; user?: SessionUser }) {
  const model = subNav(pathname, user);
  if (!model) return null;
  return (
    <nav aria-label={`${model.tab.label} 하위 메뉴`} className="shrink-0 border-b border-border bg-surface">
      <ul className="mx-auto flex max-w-7xl overflow-x-auto px-1 sm:px-3 lg:px-5">
        {model.items.map((item) => {
          const current = item.href === model.current;
          return (
            <li key={item.href} className="shrink-0">
              <Link
                href={item.href}
                aria-current={current ? (model.currentAria ?? undefined) : undefined}
                className={underlineTabClasses(current, "md")}
              >
                {item.label}
                {lockedFor(user, item.href) && (
                  // 이름은 아이콘의 aria-label, 마우스 설명은 감싼 span의 title(아이콘에 <title>을 두면 링크 글자에 섞임 — 명세 D8 c)
                  <span title="유료 등급 기능" className="ml-1 inline-flex">
                    <LockIcon size={14} label="유료 등급 기능" />
                  </span>
                )}
              </Link>
            </li>
          );
        })}
        {model.upcoming.map((entry) => (
          <li key={entry.label} className="shrink-0">
            <span aria-disabled="true" className="inline-flex h-12 items-center gap-1.5 whitespace-nowrap px-3 text-[15px] text-text-3">
              {entry.label} · {entry.note}
              {entry.opensIn ? (
                <span className="rounded-full border border-border px-2 text-xs leading-5">
                  <span className="sr-only"> (</span>
                  {entry.opensIn}
                  <span className="sr-only">에서 엽니다)</span>
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </nav>
  );
}
