"use client";

import Link from "next/link";
import { useEntityCrumbLabel } from "@/hooks/useEntityCrumb";
import { breadcrumbs } from "@/lib/breadcrumbs";
import type { SessionUser } from "@/lib/types";

/*
 * 칸(li)의 폭 규칙 — 모자란 폭은 마지막 칸(대상·지금 화면)이 먼저 받고(축소 비중 100000), 그 칸이 하한에 닿은 뒤 가운데 칸이 받습니다. 첫 칸(메뉴 이름 —
 * 두~네 글자)은 줄지 않습니다. 마지막 칸의 하한은 글 칸 2.5rem입니다(grid minmax — 'CIK…'·'파생…'처럼 대상의 첫 부분이 늘 보임, 칸에 min-w-0이 없어 그
 * 하한이 칸의 내용 하한이 됨). 세 글자 이하의 마지막 칸('홈'·'vix'·'설정' — 많아야 약 42px)은 하한 없이 제 폭이고 줄지 않습니다 — 2.5rem을 비워 두느라
 * 가운데 칸을 더 줄이지 않게.
 * 축소 비중이 1000이면 모자란 폭이 클 때 앞 칸에도 0.1px 남짓이 나뉘어 그 칸이 말줄임됐습니다(QA-548) — 100000이면 앞 칸 몫이 브라우저 배치 단위
 * (1/64px) 아래라 줄지 않습니다.
 */
const FIRST_ITEM = "flex shrink-0 items-center gap-1";
const MIDDLE_ITEM = "flex min-w-0 items-center gap-1";
const LAST_ITEM = "grid shrink-100000 grid-cols-[auto_minmax(2.5rem,1fr)] items-center gap-1";
const ONLY_ITEM = "grid shrink-100000 grid-cols-[minmax(2.5rem,1fr)] items-center";
const SHORT_LAST_ITEM = "flex shrink-0 items-center gap-1";

function itemClass(index: number, count: number, label: string): string {
  if (index < count - 1) return index === 0 ? FIRST_ITEM : MIDDLE_ITEM;
  if (Array.from(label).length <= 3) return SHORT_LAST_ITEM;
  return index > 0 ? LAST_ITEM : ONLY_ITEM;
}

/**
 * 넓은 화면(lg 이상) 상단바의 빵부스러기 — 메뉴 › 하위 화면 › 대상(칸은 lib/breadcrumbs가 주소로 계산하고, 상세 화면이 읽은 대상 이름이 있으면
 * 그 칸 글만 이름으로 — hooks/useEntityCrumb, P4). 좁은 화면에는 그리지 않습니다
 * (명세 §5 — 좁은 화면은 지금 구조).
 * 상단바에서의 폭: 자기 글 폭을 주장하고(lg:flex-auto — basis auto) 남는 폭을 차지합니다. 모자라면 곁의 새로고침 안내·로그아웃 실패 글을 감싼 상자가
 * 먼저 내주되(축소 비중 100000) 그 내용의 하한(실패: 아이콘 + 결과 낱말 '새로고침 실패'·'로그아웃 실패', 성공: 4rem)까지만 내주고, 그다음 이 nav가
 * 마지막 칸부터 줄어듭니다(위 칸 규칙). nav는 112px(lg:min-w-28 — 첫 칸 + 마지막 칸 하한) 아래로 줄지 않습니다(QA-547: 하한이 없어 안내가 떠 있는 동안
 * 1280에서 0px까지 줄고 0폭 칸 링크가 Tab 순서에 남았음).
 * 예전(QA-547 첫 고침)에는 nav가 flex-1(basis 0)이라 자기 글 폭을 주장하지 못하고 하한 160px까지 남는 폭만 받아, 안내 글이 뜨면 그 안에서 대상 칸이
 * 가장 먼저 8.6px('C')까지 줄었습니다(검토 — 1024~1366의 모든 안내 상태, 1440의 실패 안내). 정적 하네스(진짜 셸 DOM + 컴파일한 CSS, 크롬
 * 1024·1280·1366·1440·1920 × 39경로 × 안내 7상태)에서 상단바 넘침 0, 대상 칸 2.5rem 하한·첫 칸 온전.
 * 앞 칸은 링크(뒤 칸과 주소가 같은 칸은 글 — lib/breadcrumbs, QA-549. 보조 글색 — 누를 수 있다는 것은 hover 밑줄과 포커스 링이 알림, 앞 칸은 최대 12rem,
 * 전체 글은 title), 마지막 칸은 지금 화면이라 링크 없이 aria-current="page".
 * 링크는 위아래 2px 여백으로 누르는 높이를 24px(넓은 화면 작은 조작 — 명세 §3-7)로 둡니다 — 글 줄 높이(20px)만이던 것을 검토에서 고침(겉모양 그대로).
 * 사이의 '›'는 장식이라 읽지 않습니다(목록 항목 순서가 위계를 나름). 칸이 없으면(메뉴 밖 경로) 그리지 않습니다.
 */
export function Breadcrumbs({ pathname, user }: { pathname: string; user?: SessionUser }) {
  const entity = useEntityCrumbLabel();
  const crumbs = breadcrumbs(pathname, user, entity);
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label="현재 위치" className="hidden min-w-0 lg:flex lg:min-w-28 lg:flex-auto">
      <ol className="flex min-w-0 items-center gap-1 text-sm">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li key={`${index}:${crumb.label}`} className={itemClass(index, crumbs.length, crumb.label)}>
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
