"use client";

import Link from "next/link";
import { breadcrumbs } from "@/lib/breadcrumbs";
import type { SessionUser } from "@/lib/types";

/**
 * 넓은 화면(lg 이상) 상단바의 빵부스러기 — 메뉴 › 하위 화면 › 대상(칸은 lib/breadcrumbs가 주소만으로 계산). 좁은 화면에는 그리지 않습니다
 * (명세 §5 — 좁은 화면은 지금 구조). 상단바에서 남는 폭을 차지하고(flex-1), 모자라면 칸마다 말줄임합니다(앞 칸은 최대 12rem, 전체 글은 title).
 * 앞 칸은 링크(보조 글색 — 누를 수 있다는 것은 hover 밑줄과 포커스 링이 알림), 마지막 칸은 지금 화면이라 링크 없이 aria-current="page".
 * 사이의 '›'는 장식이라 읽지 않습니다(목록 항목 순서가 위계를 나름). 칸이 없으면(메뉴 밖 경로) 그리지 않습니다.
 */
export function Breadcrumbs({ pathname, user }: { pathname: string; user?: SessionUser }) {
  const crumbs = breadcrumbs(pathname, user);
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label="현재 위치" className="hidden min-w-0 lg:flex lg:flex-1">
      <ol className="flex min-w-0 items-center gap-1 text-sm">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li key={`${index}:${crumb.label}`} className="flex min-w-0 items-center gap-1">
              {index > 0 && (
                <span aria-hidden="true" className="shrink-0 text-text-3">
                  ›
                </span>
              )}
              {last ? (
                <span aria-current="page" title={crumb.label} className="truncate font-medium text-text">
                  {crumb.label}
                </span>
              ) : crumb.href ? (
                <Link
                  href={crumb.href}
                  title={crumb.label}
                  className="max-w-[12rem] truncate rounded-sm text-text-2 hover:text-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span title={crumb.label} className="max-w-[12rem] truncate text-text-2">
                  {crumb.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
