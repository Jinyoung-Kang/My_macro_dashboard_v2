"use client";

import Link from "next/link";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
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
 * 가운데 칸에는 CSS 하한이 없습니다(min-w-0 — 하한을 두면 1024 주말 두 안내 상태에서 상단바가 9px 넘침). 대신 그 글(링크·글 칸)이 MIDDLE_MIN(24px —
 * 첫 글자와 말줄임) 아래로 줄면 가운데 칸을 통째로 접습니다(그리지 않음 — 아래 useFoldedMiddle, QA-593). 0폭 링크가 Tab 순서·낭독에 남고 '모의매매 › › 보…'로
 * 구분 기호 둘이 붙던 것이 '모의매매 › 보…'가 되고, 비운 폭은 마지막 칸이 받습니다.
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

/** 가운데 칸 글의 하한(px) — 첫 글자와 말줄임('미…')이 보이는 폭. 이보다 좁으면 가운데 칸을 접습니다(QA-593). */
const MIDDLE_MIN = 24;
/**
 * 접힌 뒤 다시 펼 때의 몫(px, 가운데 칸 하나마다) — 하한 24px + 여유 12px. 펼친 배치에서 넓어진 폭은 가운데 칸 글이 그대로 받으므로(곁의 안내 상자는
 * 이미 하한, 마지막 칸도 하한) 접힐 때보다 Σ(이 몫 − 그때 가운데 칸 글 폭(하한까지))만큼 넓어지면 펴도 가운데 칸 글이 적어도 36px — 다시 접히지 않아
 * 접고 펴기를 오가며 깜박이지 않습니다. 접힐 때의 폭을 빼지 않으면 20px에서 접힌 칸이 원래 폭으로 돌아와도 펴지지 않았습니다(정적 하네스).
 */
const REOPEN_ROOM = 36;

/** 접힌 상태 — 접혔을 때의 칸 표지와 다시 펼 nav·상단바 너비(상단바 너비를 모르면 null). */
type Fold = { signature: string; reopenAt: number; reopenBarAt: number | null };

/**
 * 가운데 칸을 접는가(QA-593) — nav와 상단바(nav의 부모)를 ResizeObserver로 재어, 펼친 상태에서 가운데 칸 글 하나라도 MIDDLE_MIN 아래면 접고 다시 펼
 * 너비를 기억합니다. 접힌 뒤에는 둘 가운데 하나면 폅니다.
 * - 상단바가 접힐 때 너비 + 몫(REOPEN_ROOM 셈) 이상: 창을 넓힌 경우. 접어서 생긴 폭은 곁의 새로고침 안내 상자가 먼저 가져가(축소 비중 100000) 접힌 nav는
 *   창을 넓혀도 접힌 크기에 머물므로 nav 너비로는 알 수 없습니다(검토 — nav만 보던 때는 1280에서 접힌 칸이 1536에서야 펴졌고, 펼친 배치면 가운데 칸 글이
 *   다 들어가는 1310~1512에서도 '미국'·'한국' 링크가 없었음).
 * - nav가 접힐 때 너비 + 몫 이상: 안내가 사라져 nav가 남는 폭을 받은 경우(상단바 너비는 그대로).
 * 칸이 바뀌면(주소·대상 이름 — `signature`) 펼친 상태로 다시 잽니다. nav 너비가 0이면(좁은 화면에서 숨김·배치를 하지 않는 시험 대역) 아무것도 정하지
 * 않습니다 — 재기 전에는 접지 않습니다. ResizeObserver가 없으면 펼친 그대로. 재기와 접기는 layout effect라 칠하기 전에 끝납니다(0폭 칸이 한 번 그려졌다
 * 사라지지 않음). 펴 본 배치에서도 가운데 칸 글이 하한 아래면(곁의 다른 칸 폭이 바뀐 경우 등) 칠하기 전에 그 너비로 다시 접습니다.
 */
function useFoldedMiddle(navRef: RefObject<HTMLElement | null>, signature: string, middleCount: number): boolean {
  // 표지가 지금 칸과 다르면 펼친 것으로 칩니다.
  const [fold, setFold] = useState<Fold | null>(null);
  const folded = middleCount > 0 && fold !== null && fold.signature === signature;
  const reopenAt = folded ? fold.reopenAt : null;
  const reopenBarAt = folded ? fold.reopenBarAt : null;
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav || middleCount === 0 || typeof ResizeObserver !== "function") return undefined;
    const bar = nav.parentElement;
    const measure = () => {
      const width = nav.getBoundingClientRect().width;
      if (!(width > 0)) return;
      const barWidth = bar ? bar.getBoundingClientRect().width : 0;
      if (reopenAt !== null) {
        if (width >= reopenAt || (reopenBarAt !== null && barWidth >= reopenBarAt)) setFold(null);
        return;
      }
      const widths = [...nav.querySelectorAll<HTMLElement>(":scope > ol > li")]
        .slice(1, -1)
        .map((item) => (item.lastElementChild instanceof HTMLElement ? item.lastElementChild.getBoundingClientRect().width : MIDDLE_MIN));
      if (widths.some((text) => text < MIDDLE_MIN)) {
        const room = widths.reduce((sum, text) => sum + REOPEN_ROOM - Math.min(text, MIDDLE_MIN), 0);
        setFold({ signature, reopenAt: width + room, reopenBarAt: barWidth > 0 ? barWidth + room : null });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    if (bar) observer.observe(bar);
    return () => observer.disconnect();
  }, [navRef, signature, middleCount, reopenAt, reopenBarAt]);
  return folded;
}

/**
 * 넓은 화면(lg 이상) 상단바의 빵부스러기 — 메뉴 › 하위 화면 › 대상(칸은 lib/breadcrumbs가 주소로 계산하고, 상세 화면이 읽은 대상 이름이 있으면
 * 그 칸 글만 이름으로 — hooks/useEntityCrumb, P4). 좁은 화면에는 그리지 않습니다
 * (명세 §5 — 좁은 화면은 지금 구조).
 * 상단바에서의 폭: 자기 글 폭을 주장하고(lg:flex-auto — basis auto) 남는 폭을 차지합니다. 모자라면 곁의 새로고침 안내·로그아웃 실패 글을 감싼 상자가
 * 먼저 내주되(축소 비중 100000) 그 내용의 하한(실패: 아이콘 + 결과 낱말 '새로고침 실패'·'로그아웃 실패', 성공: 4rem)까지만 내주고, 그다음 이 nav가
 * 마지막 칸부터 줄어듭니다(위 칸 규칙). nav는 112px(lg:min-w-28 — 첫 칸 + 마지막 칸 하한) 아래로 줄지 않습니다(QA-547: 하한이 없어 안내가 떠 있는 동안
 * 1280에서 0px까지 줄고 0폭 칸 링크가 Tab 순서에 남았음). 이 하한은 가운데 칸을 담지 않습니다 — 가운데 칸은 글이 24px 아래로 줄면 접힙니다(QA-593:
 * 새로고침 실패와 로그아웃 실패가 함께 뜬 1280, 장 시계 칩이 '휴장 (주말)'이면 새로고침 실패 하나로도 '미국'·'한국' 링크가 0px인 채 Tab 정지점이었음).
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
  const navRef = useRef<HTMLElement>(null);
  const middleCount = Math.max(crumbs.length - 2, 0);
  const signature = crumbs.map((crumb) => `${crumb.label}\u0000${crumb.href ?? ""}`).join("\u0001");
  const folded = useFoldedMiddle(navRef, signature, middleCount);
  if (crumbs.length === 0) return null;
  // 접히면 첫 칸과 마지막 칸만 — 칸 열쇠는 원래 순번 그대로(마지막 칸이 다시 마운트되지 않게).
  const shown = crumbs.map((crumb, index) => ({ crumb, index })).filter(({ index }) => !folded || index === 0 || index === crumbs.length - 1);
  return (
    <nav ref={navRef} aria-label="현재 위치" className="hidden min-w-0 lg:flex lg:min-w-28 lg:flex-auto">
      <ol className="flex min-w-0 items-center gap-1 text-sm">
        {shown.map(({ crumb, index: key }, index) => {
          const last = index === shown.length - 1;
          return (
            <li key={`${key}:${crumb.label}`} className={itemClass(index, shown.length, crumb.label)}>
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
