"use client";

import { useEffect, useRef, type JSX, type ReactNode } from "react";

import { FOCUS_RING, SKELETON_BAR, underlineTabClasses } from "@/components/ui/classes";
import { useScrollStripActive } from "@/hooks/useScrollStripActive";
import { useSectionSpy } from "@/hooks/useSectionSpy";
import { useSectionStripHeight } from "@/hooks/useSectionStripHeight";
import { followHashLink } from "@/lib/hashLink";
import { sectionCountText, sectionOrder, sectionParent, type SectionIndexItem, type SectionIndexLeaf } from "@/lib/sectionIndex";

export type { SectionIndexItem, SectionIndexLeaf };

/** 왼쪽 세로 목록이 되는 폭 — 그 아래는 본문 위 가로 줄. */
type ColumnFrom = "lg" | "xl" | "2xl";

/*
 * Tailwind가 클래스를 글로 찾으므로 폭마다의 클래스를 통째로 적어 둡니다(조립하지 않음).
 * 틀: columnFrom 이상은 왼쪽 13rem 목차 + 본문(minmax(0,1fr)), 사이 24px. 그 아래는 블록(목차 줄 → 본문).
 */
const FRAME: Record<ColumnFrom, string> = {
  lg: "min-w-0 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-6",
  xl: "min-w-0 xl:grid xl:grid-cols-[13rem_minmax(0,1fr)] xl:gap-6",
  "2xl": "min-w-0 2xl:grid 2xl:grid-cols-[13rem_minmax(0,1fr)] 2xl:gap-6",
};

/**
 * 목차(nav) — columnFrom 미만은 본문 위에 붙는 가로 줄(sticky top-0 — 좁은 화면은 창, 넓은 화면은 본문 스크롤 상자에 붙음 — 바탕을 칠해 아래로 지나가는
 * 내용을 가림, z-20은 덮개(대화상자 z-50)·아래 탭 바(z-40) 밑), 줄과 본문 사이는 본문의 절 사이 간격과 같게(16·24px). columnFrom 이상은 왼쪽 칸에서
 * 스크롤 영역 위쪽에 붙어 따라옵니다(self-start — 격자 칸 안에서 붙으려면 칸 높이를 내용만큼).
 */
const NAV: Record<ColumnFrom, string> = {
  lg: "sticky top-0 z-20 mb-4 min-w-0 bg-bg lg:top-4 lg:z-auto lg:mb-0 lg:self-start lg:bg-transparent",
  xl: "sticky top-0 z-20 mb-4 min-w-0 bg-bg lg:mb-6 xl:top-4 xl:z-auto xl:mb-0 xl:self-start xl:bg-transparent",
  "2xl": "sticky top-0 z-20 mb-4 min-w-0 bg-bg lg:mb-6 2xl:top-4 2xl:z-auto 2xl:mb-0 2xl:self-start 2xl:bg-transparent",
};

/** 가로 줄(columnFrom 미만) — 첫 단계 칸만, 넘치면 가로 스크롤(지금 칸을 줄 안에 — useScrollStripActive가 offsetLeft를 쓰므로 relative). */
const STRIP: Record<ColumnFrom, string> = {
  lg: "relative flex overflow-x-auto border-b border-border lg:hidden",
  xl: "relative flex overflow-x-auto border-b border-border xl:hidden",
  "2xl": "relative flex overflow-x-auto border-b border-border 2xl:hidden",
};

/** 세로 목록(columnFrom 이상) — 하위 칸은 들여 씁니다. */
const COLUMN: Record<ColumnFrom, string> = {
  lg: "hidden flex-col gap-px lg:flex",
  xl: "hidden flex-col gap-px xl:flex",
  "2xl": "hidden flex-col gap-px 2xl:flex",
};

/**
 * 절 닻 — 가로 줄이 보이는 폭(columnFrom 미만)은 스크롤 상자의 위쪽 여백(globals.css — 잰 줄 높이(기본 45·31px, 고전 가로 막대가 서면 +10px), QA-643·
 * QA-656) 위에 줄 아래 간격 12px만 더하고, 세로 목록 폭에서는 16px. 그래서 목차로 옮긴 절 머리는 줄 바로 아래 12px에 옵니다(390 57px·1024 #main 위 43px).
 * 바깥선 없음(outline-none) — 목차 누름은 닻 안 첫 제목에, 제목이 없을 때만 닻에 포커스를 두는데(QA-680 — 그때만 tabindex -1, QA-688) 누를 수 있는
 * 것이 아니라 절 전체에 포커스 테두리를 그리지 않습니다(본문 main#main과 같음).
 */
const ANCHOR: Record<ColumnFrom, string> = {
  lg: "min-w-0 scroll-mt-3 outline-none lg:scroll-mt-4",
  xl: "min-w-0 scroll-mt-3 outline-none xl:scroll-mt-4",
  "2xl": "min-w-0 scroll-mt-3 outline-none 2xl:scroll-mt-4",
};

/**
 * 세로 목록 칸 — 좁은 화면(lg 미만) 44px·넓은 화면 32px(min-h-8), 첫 단계 14px·하위 13px(들여쓰기 24px). 글은 말줄임 없이 낱말 사이에서 꺾습니다.
 * 지금 칸은 본문색 굵은 글 + 왼쪽 3px 강조 파랑 막대(목차는 누르는 내비라 셸의 현재 메뉴와 같은 규칙 — 원칙 A1, 글자는 강조 파랑이 아님),
 * 고대비(forced-colors)에서는 막대 바탕이 지워지므로 같은 폭의 왼쪽 테두리로 그립니다(SideNav와 같음). 하위 칸이 지금이면 부모는 굵은 글만.
 */
const ROW = `relative flex min-h-11 w-full items-center gap-2 rounded-control px-3 py-1 motion-safe:transition-colors lg:min-h-8 ${FOCUS_RING}`;
const ROW_CURRENT =
  "font-semibold text-text hover:bg-surface-2 before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-r before:bg-accent forced-colors:before:border-l-[3px]";
const ROW_OPEN = "font-semibold text-text hover:bg-surface-2";
const ROW_REST = "font-medium text-text-2 hover:bg-surface-2 hover:text-text";
const ROW_TOP = "text-sm";
const ROW_CHILD = "pl-6 text-caption";

/**
 * 개수 — 숫자일 때만(12px tabular-nums 보조 글). 이름 글 바로 뒤라 읽어 주기에서 '지표37'로 붙지 않게 앞에 빈칸 글 마디(flex 줄 안이라 보이지 않음 —
 * 간격은 gap)를 두고, 이름에는 낭독기 전용 마디 하나 '(37)'을 넣고 보이는 숫자 '37'은 읽기에서 뺍니다('지표 (37)').
 * 괄호를 숫자 앞뒤의 낭독기 전용 마디 둘로 나누면 안 됩니다 — Tailwind sr-only는 position:absolute라 크롬이 블록으로 보고 이름 계산에서 조각마다 앞뒤
 * 빈칸을 넣어 '지표 ( 37 )'이 되었습니다(QA-658 — QA 스택 390~1600).
 * 개수를 읽는 중(`pending`)이면 그 자리에 숫자 두 자리 폭(12px 글의 2ch)의 글 없는 막대를 둡니다 — 개수가 생길 때 가로 줄의 뒤 칸이 밀리지 않게(QA-652 —
 * 매크로 '지표 21'에서 17px). 읽기에서 뺍니다(자리일 뿐 개수가 아님).
 */
function Count({ count, pending = false }: { count?: number | null; pending?: boolean }): JSX.Element | null {
  const text = sectionCountText(count);
  if (text === null) {
    // 빈칸 글 마디는 두지 않습니다 — 막대는 읽기에서 빠지고, flex 줄 안의 빈칸은 폭이 없어(간격은 gap) 개수가 온 뒤와 폭이 같습니다.
    return pending ? (
      <span
        aria-hidden="true"
        data-section-index-count-pending=""
        className={`inline-block h-3 w-[2ch] shrink-0 text-xs ${SKELETON_BAR}`}
      />
    ) : null;
  }
  return (
    <>
      {" "}
      <span className="shrink-0 text-xs tabular-nums text-text-3">
        <span className="sr-only">({text})</span>
        <span aria-hidden="true">{text}</span>
      </span>
    </>
  );
}

/**
 * 하위 칸 자리 줄(하위 칸을 아직 모를 때 — `pendingChildren`) — 하위 칸과 같은 높이(좁은 화면 44px·넓은 화면 32px)·들여쓰기의 글 없는 막대(공용 Skeleton 막대와 같은
 * 모양 — 놓인 면보다 한 단계 위 면·motion-safe 깜빡임·고대비 1px 테두리). 읽기에서 뺍니다(내비의 칸이 아님).
 */
function PendingChildren({ count }: { count?: number }): JSX.Element | null {
  const rows = typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (rows === 0) return null;
  return (
    <ul aria-hidden="true" data-section-index-pending="" className="flex flex-col gap-px">
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className="flex min-h-11 items-center pr-3 pl-6 lg:min-h-8">
          <span className="block h-3 w-2/3 rounded-control bg-control-fill motion-safe:animate-pulse forced-colors:border" />
        </li>
      ))}
    </ul>
  );
}

/** 주소 해시('#…' 또는 '')의 id — 잘못된 % 꼴이면 null(목차 칸이 아님). */
function hashId(hash: string): string | null {
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
}

/** 주소 글의 해시('#…' 또는 '') — 읽지 못하면 ''. */
function urlHash(url: string): string {
  try {
    return new URL(url).hash;
  } catch {
    return "";
  }
}

/**
 * 요소를 담은 가장 가까운 요소 스크롤 상자 — 세로 넘침이 auto·scroll이고 실제로 넘치는 조상(넓은 화면의 본문 #main). 창이 스크롤하면(좁은 화면 —
 * #main은 넘침 visible) null.
 */
function scrollBoxOf(element: Element | null): Element | null {
  for (let box = element?.parentElement ?? null; box !== null && box !== document.body && box !== document.documentElement; box = box.parentElement) {
    const overflow = window.getComputedStyle(box).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && box.scrollHeight > box.clientHeight) return box;
  }
  return null;
}

function ColumnLink({ leaf, state, child }: { leaf: SectionIndexLeaf; state: "current" | "open" | "rest"; child: boolean }): JSX.Element {
  const tone = state === "current" ? ROW_CURRENT : state === "open" ? ROW_OPEN : ROW_REST;
  return (
    <a
      href={`#${leaf.id}`}
      onClick={(event) => followHashLink(event, leaf.id)}
      aria-current={state === "current" ? "location" : undefined}
      className={`${ROW} ${child ? ROW_CHILD : ROW_TOP} ${tone}`}
    >
      <span className="min-w-0 flex-1 break-keep wrap-anywhere">{leaf.label}</span>
      <Count count={leaf.count} pending={leaf.pendingCount} />
    </a>
  );
}

/**
 * 긴 화면 목차(작업대 실행 명세 §6 SectionIndex — 처음 쓰는 곳 매크로 P5a, 프레임·설정 P6, 저장소 상태 P7): 절 목록을 sticky로 두고 지금 절을 표시합니다.
 *
 * - 배치: `columnFrom`(lg·xl·2xl, 기본 lg) 이상은 왼쪽 13rem 세로 목록(하위 칸 들여씀, 스크롤 영역 위쪽에 붙음) + 본문, 그 아래는 본문 위에 붙는 가로 줄(첫 단계 칸만 —
 *   밑줄 탭 모양 `underlineTabClasses(…, "sm")`: 좁은 화면 44px·넓은 화면 30px, 넘치면 가로 스크롤하고 지금 칸을 줄 안에 보임). 이름 있는 내비(nav
 *   aria-label) 하나 안에 두 목록이 있고 폭마다 하나만 보입니다(다른 하나는 display:none — 읽기·Tab에서 빠짐).
 * - 칸은 같은 화면 절 링크(`<a href="#id">` — 스크롤은 즉시, 부드러운 스크롤 없음)이고 지금 칸은 aria-current="location"입니다. 가로 줄에서는 지금 절의
 *   첫 단계 칸이 지금 칸입니다(하위 칸이 지금이어도). 누르면 브라우저 기본 해시 이동 대신 `lib/hashLink` followHashLink가 기록 하나(history.pushState —
 *   Next가 라우터 상태를 실음)를 쌓고 닻으로 옮겨 닻 안 첫 제목(없으면 닻)에 포커스합니다(다음 Tab이 그 절에서 이어짐 — 닻에 두면 크롬이 절 내용 전체를
 *   접근 이름으로 읽음, QA-680 보강). 기본 해시 이동의 상태 없는 기록은 다른 화면으로 갔다가
 *   뒤로 가기로 돌아올 때 Next 라우터가 무시해 주소만 바뀌고 화면이 남았습니다(QA-680). 가운데 단추·수식키 누름(새 탭 등)은 브라우저에 맡깁니다. 개수(`count`)는 숫자일 때만 보입니다(모르면 자리 없음 — 0으로 채우지 않음). 개수를 읽는 중
 *   (`pendingCount`)이면 숫자 두 자리 폭의 글 없는 막대로 자리를 잡습니다(읽기에서 뺌 — QA-652).
 * - 뒤로·앞으로 가기로 주소의 해시가 목차 칸(하위 칸 포함)으로 바뀌면(hashchange) 그 절 닻으로 옮깁니다(scrollIntoView — 즉시, 닻의 scroll-margin과
 *   스크롤 상자의 위쪽 여백을 따름). 넓은 화면은 본문(#main)이 스크롤 상자라 크롬의 같은 문서 기록 이동이 연속 이동의 첫 번째 뒤로는 창 위치만 되돌려
 *   본문이 움직이지 않았습니다(QA-659). 목차 칸 해시에서 해시 없는 기록(처음 연 주소)으로 돌아오면 닻을 담은 요소 스크롤 상자를 해시 없이 있던 마지막
 *   자리로(모르면 맨 위) 되돌립니다 — 크롬은 이때도 본문 스크롤 상자를 되돌리지 않아 넓은 화면은 주소만 바뀌고 본문이 옮긴 절에 남았습니다(QA-659 후속,
 *   좁은 화면은 창이 스크롤 상자라 브라우저가 되돌림 — 그대로 둠). 목차 밖 해시(#main 등)는 보지 않습니다. 새로 고침·바로 열기의 해시 맞춤은 여기서
 *   하지 않습니다(P6·P7).
 * - 지금 절: `activeId`를 주면 그 값(제어 — 시험·화면이 정함), 주지 않으면 `hooks/useSectionSpy`(뷰포트 위 96px 아래 ~ 34% 띠에 걸친 절 — 하위 칸이 부모보다 앞,
 *   스크롤 상자가 끝까지 내려가 있으면 위 끝이 화면 안인 마지막 절 — QA-645, 규칙은 `lib/sectionIndex`). 처음 그릴 때와 IntersectionObserver가 없는 곳에서는
 *   지금 칸이 없습니다.
 * - 본문(`children`)은 절 닻(`SectionAnchor` — 같은 `columnFrom`)들이고 절 사이 16·24px입니다. 닻은 자료와 상관없이 늘 그립니다(해시 주소로 열 때 첫 그림에서 닿게).
 * - 하위 칸을 아직 모르는 칸(`pendingChildren` — 자료를 읽는 중)은 세로 목록에 그만큼 글 없는 자리 줄을 둡니다(읽기에서 뺌 — 하위 칸이 온 뒤 아래 칸이 밀리지 않게).
 * - 목차 칸이 없으면 내비 없이 본문만 그립니다.
 * - 내비라 강조 파랑을 씁니다(지금 칸 막대·가로 줄 밑줄 — 누를 수 있는 것) — 데이터 칸 강조색 금지 목록(lib/__tests__/accentInData)에 넣지 않습니다.
 */
export function SectionIndex({
  label,
  items,
  columnFrom = "lg",
  activeId,
  children,
}: {
  /** 내비 이름 — 예 '매크로 지표 목차'. */
  label: string;
  items: readonly SectionIndexItem[];
  /** 이 폭부터 왼쪽 세로 목록(기본 lg). 본문이 넓어야 하는 화면은 xl·2xl(매크로 — 지표 표 옆에 미리보기 칸이 서려면 1280~1535에서도 본문이 넓어야 함). */
  columnFrom?: ColumnFrom;
  /** 주면 지금 절을 부르는 쪽이 정합니다(null이면 지금 칸 없음). 주지 않으면 화면 위쪽 띠로 고릅니다. */
  activeId?: string | null;
  children: ReactNode;
}): JSX.Element {
  const order = sectionOrder(items);
  const spied = useSectionSpy(order, activeId === undefined && items.length > 0);
  const active = activeId !== undefined ? activeId : spied;
  const openParent = sectionParent(items, active);
  // 가로 줄의 지금 칸 — 첫 단계 칸(하위 칸이 지금이면 그 부모).
  const activeTop = openParent ?? (items.some((item) => item.id === active) ? active : null);
  const stripRef = useRef<HTMLUListElement>(null);
  useScrollStripActive(stripRef, activeTop);
  // 가로 줄의 잰 높이 → 문서 루트 --section-strip-h(스크롤 상자의 위쪽 여백·옆 검사 칸의 sticky 위치가 읽음 — QA-656·657).
  useSectionStripHeight(stripRef, items.map((item) => item.id).join("\n"));
  // 뒤로·앞으로 가기(hashchange)로 해시가 목차 칸이 되면 그 닻으로, 목차 칸 해시에서 해시 없는 기록으로 돌아오면 닻을 담은 요소 스크롤 상자를 해시 없이
  // 있던 마지막 자리로(QA-659). 배열의 참조가 그릴 때마다 바뀌어도 같은 목록이면 다시 걸지 않게 글 하나로 묶습니다(useSectionSpy와 같음 — id에는 줄바꿈이 없음).
  const orderKey = order.join("\n");
  useEffect(() => {
    if (orderKey === "") return undefined;
    const ids = orderKey.split("\n");
    const known = new Set(ids);
    // 해시 없는 기록에 있는 동안 닻을 담은 요소 스크롤 상자(넓은 화면의 #main)의 마지막 자리 — 창 스크롤은 브라우저가 되돌리므로 적지 않습니다. 목차로
    // 옮기면 주소가 먼저 바뀌고 그 스크롤은 뒤에 오므로(scroll 이벤트는 다음 그리기 때) 옮긴 자리는 적히지 않습니다.
    let topWithoutHash: { box: Element; top: number } | null = null;
    const onScroll = (event: Event) => {
      if (window.location.hash !== "") return;
      const box = event.target;
      if (!(box instanceof Element) || !box.contains(document.getElementById(ids[0]))) return;
      topWithoutHash = { box, top: box.scrollTop };
    };
    const onHashChange = (event: HashChangeEvent) => {
      const id = hashId(window.location.hash);
      if (id !== null && known.has(id)) {
        document.getElementById(id)?.scrollIntoView();
        return;
      }
      // 해시 없는 기록으로 돌아옴. 크롬은 같은 문서 기록 이동에서 창 위치만 되돌리고 요소 스크롤 상자는 그대로 두어, 넓은 화면은 주소만 바뀌고 본문이
      // 옮긴 절에 남았습니다. 창이 스크롤하는 폭(좁은 화면 — 요소 스크롤 상자 없음)은 브라우저가 되돌린 자리를 그대로 둡니다.
      if (window.location.hash !== "") return;
      const box = scrollBoxOf(document.getElementById(ids[0]));
      if (box === null) return;
      const left = hashId(urlHash(event.oldURL));
      if (left !== null && known.has(left)) {
        // 목차 칸 해시에서 — 해시 없이 있던 자리로, 모르면 맨 위(빈 해시가 가리키는 문서 맨 위).
        box.scrollTop = topWithoutHash !== null && topWithoutHash.box === box ? topWithoutHash.top : 0;
      } else {
        // 목차 밖 해시(#main 등)에서 — 건드리지 않고, 지금 자리를 해시 없는 기록의 자리로 적습니다(그 해시에서 내린 자리는 위 scroll에서 적히지 않음).
        topWithoutHash = { box, top: box.scrollTop };
      }
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("hashchange", onHashChange);
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [orderKey]);

  const body = <div className="flex min-w-0 flex-col gap-4 lg:gap-6">{children}</div>;
  if (items.length === 0) {
    return body;
  }
  return (
    <div className={FRAME[columnFrom]}>
      {/* data-section-index-bar — 가로 줄이 보이는 폭의 스크롤 상자에 줄 높이(잰 값 --section-strip-h — QA-656)만큼 위쪽 스크롤 여백을 두는 전역 규칙(globals.css, QA-643)의 표지. */}
      <nav aria-label={label} data-section-index-bar={columnFrom} className={NAV[columnFrom]}>
        <ul ref={stripRef} className={STRIP[columnFrom]}>
          {items.map((item) => {
            const current = item.id === activeTop;
            return (
              <li key={item.id} className="shrink-0">
                <a
                  href={`#${item.id}`}
                  onClick={(event) => followHashLink(event, item.id)}
                  aria-current={current ? "location" : undefined}
                  className={underlineTabClasses(current, "sm")}
                >
                  {item.label}
                  <Count count={item.count} pending={item.pendingCount} />
                </a>
              </li>
            );
          })}
        </ul>
        <ul className={COLUMN[columnFrom]}>
          {items.map((item) => (
            <li key={item.id} className="min-w-0">
              <ColumnLink leaf={item} child={false} state={item.id === active ? "current" : item.id === openParent ? "open" : "rest"} />
              {item.children && item.children.length > 0 ? (
                <ul className="flex flex-col gap-px">
                  {item.children.map((child) => (
                    <li key={child.id} className="min-w-0">
                      <ColumnLink leaf={child} child state={child.id === active ? "current" : "rest"} />
                    </li>
                  ))}
                </ul>
              ) : (
                <PendingChildren count={item.pendingChildren} />
              )}
            </li>
          ))}
        </ul>
      </nav>
      {body}
    </div>
  );
}

/**
 * 절 닻 — 목차가 가리키는 절 하나(id = 목차 칸 id). 가로 줄 밑에 절 머리가 숨지 않게 스크롤 상자의 위쪽 여백(잰 줄 높이(기본 45·31px, 고전 가로 막대가
 * 서면 +10px) — QA-643·QA-656) 위에 12px scroll-margin을 두고, 세로 목록 폭(columnFrom 이상)에서는 16px.
 * 목차와 같은 `columnFrom`을 넘깁니다. 자료가 오기 전에도 늘 그립니다(해시 주소의 이동이 첫 그림에서 닿게).
 * 닻은 늘 포커스를 받는 자리가 아닙니다(tabindex 없음). 목차 누름의 포커스는 닻 안 첫 제목에 가고, 제목이 없을 때만 lib/hashLink가 그때 닻에
 * tabindex -1을 붙였다가 포커스가 떠나면 뗍니다(QA-680, 기본 해시 이동처럼 다음 Tab이 그 절에서 이어짐 — 이름·역할 없는 닻은 크롬이 내용 전체를 접근
 * 이름으로 읽음). 늘 tabIndex -1을 두면 크롬이 뒤로·앞으로 가기의 조각 처리에서 닻에 포커스를 두어 낭독기가 절 전체를 읽었습니다(QA-688).
 */
export function SectionAnchor({ id, columnFrom = "lg", children }: { id: string; columnFrom?: ColumnFrom; children: ReactNode }): JSX.Element {
  return (
    <div id={id} className={ANCHOR[columnFrom]}>
      {children}
    </div>
  );
}
