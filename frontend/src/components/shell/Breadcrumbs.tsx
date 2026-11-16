"use client";

import Link from "next/link";
import { breadcrumbs } from "@/lib/breadcrumbs";
import type { SessionUser } from "@/lib/types";

/**
 * 넓은 화면(lg 이상) 상단바의 빵부스러기 — 메뉴 › 하위 화면 › 대상(칸은 lib/breadcrumbs가 주소만으로 계산). 좁은 화면에는 그리지 않습니다
 * (명세 §5 — 좁은 화면은 지금 구조). 상단바에서 남는 폭을 차지하고(flex-1), 모자라면 마지막 칸부터 말줄임합니다(앞 칸은 최대 12rem, 전체 글은 title) —
 * 마지막 칸(li)만 축소 비중 100000(shrink-100000)이라 모자란 폭을 먼저 받고, 마지막 칸이 0이 된 뒤에야 앞 칸이 줄어듭니다(QA-548: 모든 칸이 비례로 줄어
 * 1~5px만 모자라도 짧은 앞 칸까지 말줄임됐음. 앞 칸을 shrink-0으로 두지 않는 까닭 — 자리가 아주 좁을 때 칸이 검색 단추를 덮음). 비중이 1000이면 모자란
 * 폭이 클 때(안내 글로 자리가 160px 하한일 때 약 100px) 앞 칸에도 0.1px 남짓이 나뉘어 그 칸이 말줄임됐습니다('13F 포트폴...') — 100000이면 앞 칸 몫이
 * 브라우저 배치 단위(1/64px) 아래라 줄지 않습니다(정적 하네스 1024·1280·1440에서 잼).
 * 160px 아래로는 줄지 않습니다(lg:min-w-40) — 곁의 새로고침 안내·로그아웃 실패 글이 모자란 폭을 먼저 내줍니다(QA-547: 하한이 없어 그 글이 떠 있는 동안
 * 1280에서 0px까지 줄고 0폭 칸 링크가 Tab 순서에 남았음).
 * 앞 칸은 링크(뒤 칸과 주소가 같은 칸은 글 — lib/breadcrumbs, QA-549. 보조 글색 — 누를 수 있다는 것은 hover 밑줄과 포커스 링이 알림), 마지막 칸은 지금
 * 화면이라 링크 없이 aria-current="page".
 * 링크는 위아래 2px 여백으로 누르는 높이를 24px(넓은 화면 작은 조작 — 명세 §3-7)로 둡니다 — 글 줄 높이(20px)만이던 것을 검토에서 고침(겉모양 그대로).
 * 사이의 '›'는 장식이라 읽지 않습니다(목록 항목 순서가 위계를 나름). 칸이 없으면(메뉴 밖 경로) 그리지 않습니다.
 */
export function Breadcrumbs({ pathname, user }: { pathname: string; user?: SessionUser }) {
  const crumbs = breadcrumbs(pathname, user);
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label="현재 위치" className="hidden min-w-0 lg:flex lg:min-w-40 lg:flex-1">
      <ol className="flex min-w-0 items-center gap-1 text-sm">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li key={`${index}:${crumb.label}`} className={last ? "flex min-w-0 shrink-100000 items-center gap-1" : "flex min-w-0 items-center gap-1"}>
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
                  className="max-w-[12rem] truncate rounded-sm py-0.5 text-text-2 hover:text-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
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
