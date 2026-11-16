"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef } from "react";
import { LockIcon, PanelLeftIcon } from "@/components/ui/icons";
import { Tooltip } from "@/components/ui/Tooltip";
import { useNavCollapsed } from "@/hooks/useNavCollapsed";
import { navTree, type NavTreeLeaf, type NavTreeNode, type UpcomingItem } from "@/lib/nav";
import { onShellCommand } from "@/lib/shellCommands";
import type { SessionUser } from "@/lib/types";
import { TabIcon } from "./icons";

/** 칸 공통 — 높이 32px(명세 §3-7 표 행 단계), 4px 모서리, 14px 글, 색 전환만(움직임 줄이기면 없음), 포커스 링은 안쪽 2px(메뉴 스크롤 상자가 자르지 않게). */
const ROW =
  "relative flex h-8 items-center gap-2 rounded-control text-sm motion-safe:transition-colors motion-safe:duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus";
/** 탭 칸의 안쪽 여백과 하위 칸의 들여쓰기(탭 아이콘 16px + 사이 8px만큼 — 하위 칸 글이 탭 이름과 같은 세로줄). 레일(접힘)에서는 아이콘만 가운데. */
const TAB_PAD = "px-2.5";
const RAIL_PAD = "justify-center";
const LEAF_PAD = "pl-8 pr-2.5";

/*
 * 막대(가장 깊은 지금 칸 하나 — lib/nav navTree의 marked): 왼쪽 3px 강조 파랑 막대·선택 바탕(surface-2)·본문색 굵은 글(작업대 실행 명세 §3-8·§5 — 막대 폭은
 * 고른 행 막대 SELECTED_BAR와 같음). 셸의 현재 메뉴는 누를 수 있는 것이라 막대에 강조 파랑을 쓰되(원칙 A1), 글자는 강조 파랑이 아닙니다(QA-459 — accent 틴트
 * 위 accent 글자는 4.47:1). 고대비(forced-colors)에서는 바탕색·막대 바탕이 지워지므로 같은 폭(3px)의 왼쪽 테두리로 그립니다(명세 §3-8·D9). 나머지 칸에는
 * 테두리를 두지 않습니다(투명 테두리는 그 모드에서 시스템 색으로 보여 모든 칸이 고른 것처럼 보임).
 */
const MARKED =
  "bg-surface-2 font-semibold text-text before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-r before:bg-accent forced-colors:before:border-l-[3px]";
/** 펼친 지금 탭(그 아래 지금 하위 칸이 막대를 가짐) — 굵은 본문색 글만. */
const OPEN_TAB = "font-semibold text-text hover:bg-surface-2";
/** 나머지 칸. */
const REST = "font-medium text-text-2 hover:bg-surface-2 hover:text-text";

/**
 * 넓은 화면(lg 이상) 왼쪽 나무 메뉴(폭 220px — 작업대 실행 명세 §5, ADR 0042 결정 5). 이 사용자에게 보이는 탭(홈·시장·기관·모의매매·정보 검색·정보 수집·더보기)을
 * 두고, **지금 탭의 하위 화면을 그 아래에 펼칩니다** — 그래서 넓은 화면에는 하위 메뉴 줄(SubNav)이 없습니다. 모양은 lib/nav navTree가 정하고 여기서는 그리기만 합니다
 * (ADR 0004 1단계 덧붙임). 앱 이름은 폭 전체의 상단바 맨 왼쪽에 있고(메뉴 맨 위 상표는 없앰), 예전 아래쪽의 읽기 모드·수동 새로고침·계정·빌드 정보는 상단바로
 * 옮겼습니다(새로고침은 아이콘 단추, 나머지는 계정 메뉴). 테마 전환은 없습니다(어두운 한 벌 — ADR 0042 결정 2).
 * 좁은 화면에서는 숨기고(하단 탭 바 + 하위 메뉴 줄 + 더보기 화면이 대신), 데스크톱에서는 상단바 아래 남는 높이에 붙어 본문만 스크롤됩니다(메뉴가 길면 메뉴만 따로 스크롤).
 *
 * - 칸은 32px, 탭 아이콘 16px. 하위 칸은 탭 이름과 같은 세로줄로 들여 씁니다. 묶음(더보기의 '한국 시장')은 누르지 않는 글 머리 아래 따로 목록.
 * - aria-current는 nav.ts 규칙 그대로 — 탭 링크는 tabCurrent(첫 화면 page·같은 탭의 다른 화면 true), 하위 칸은 지금 화면만(주소 그대로 page·아래 주소 true).
 * - 하위 화면 목록은 nav가 아니라 이름 있는 목록('{탭} 화면')입니다 — '…하위 메뉴' 이름의 내비는 좁은 화면 하위 메뉴 줄 하나로 남습니다.
 * - 유료 화면은 무료 회원에게 자물쇠 아이콘(눌러도 되며 화면이 안내 — 하위 메뉴 줄과 같음). 준비 중 화면은 링크 없는 흐린 글(aria-disabled).
 * - 탭 링크에는 data-nav-tab을 붙입니다(시험이 탭 링크만 고를 때 — 펼친 하위 칸과 가름).
 *
 * **접힘(48px 아이콘 레일)**: 맨 아래 접기 단추(이름 '왼쪽 메뉴 접기' — aria-pressed가 접힘, 단축키 [ — 명령 팔레트 쪽이 넓은 화면에서만 셸 명령 toggle-nav를
 * 보내고 여기서 받음)로 접고 폅니다. 접히면 탭 아이콘(20px)만 남고 이름은 sr-only 글(링크 접근 이름 그대로)과 오른쪽 툴팁(이름과 같은 글이라 labelOnly)으로,
 * 하위 화면은 숨깁니다(펼치기·명령 팔레트·빵부스러기로 닿음). 막대는 보이는 칸 가운데 가장 깊은 지금 칸 — 레일에서는 지금 탭 칸입니다. 접힘은 보는 사람별로
 * 이 브라우저에 기억합니다(useNavCollapsed — 저장소를 못 써도 동작). 폭은 움직이지 않고 바로 바뀝니다(명세 §3-8 — 모션은 색 전환만).
 * 탭 링크는 접고 펼 때 같은 요소로 남아(툴팁 감쌈을 늘 두고 펼친 동안은 열지 않음) 포커스가 그대로이고, 포커스가 사라지는 하위 칸에 있었으면 접기 단추로 옮깁니다.
 */
export function SideNav({ pathname, user }: { pathname: string; user?: SessionUser }) {
  const tree = navTree(pathname, user);
  const idBase = useId();
  const navId = `${idBase}-nav`;
  const [collapsed, toggle] = useNavCollapsed();
  const asideRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  // 접고 펴기 직전에 포커스가 이 메뉴 안에 있었는가 — 그린 뒤 포커스가 사라졌으면(하위 칸) 접기 단추로 옮깁니다.
  const refocus = useRef(false);

  const handleToggle = useCallback(() => {
    const active = document.activeElement;
    refocus.current = Boolean(asideRef.current && active && asideRef.current.contains(active));
    toggle();
  }, [toggle]);

  // 셸 명령 신호 — [ 키·명령 팔레트의 '왼쪽 메뉴 접기·펼치기'(넓은 화면에서만 보냄, lib/shellCommands).
  useEffect(() => onShellCommand("toggle-nav", handleToggle), [handleToggle]);

  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const active = document.activeElement;
    if (!(asideRef.current && active && asideRef.current.contains(active))) toggleRef.current?.focus();
  }, [collapsed]);

  return (
    <aside
      ref={asideRef}
      className={`hidden shrink-0 flex-col border-r border-border bg-surface lg:flex lg:overflow-y-auto ${collapsed ? "w-12" : "w-[220px]"}`}
    >
      <nav id={navId} aria-label="주 메뉴" className="p-2">
        <ul className="flex flex-col gap-0.5">
          {tree.map((node) => {
            // 막대 — 펼친 메뉴는 가장 깊은 지금 칸(navTree), 레일은 하위 칸이 숨으므로 지금 탭 칸.
            const marked = collapsed ? node.current !== undefined : node.marked;
            return (
              <li key={node.tab.key}>
                <Tooltip content={node.tab.label} side="right" labelOnly disabled={!collapsed}>
                  <Link
                    data-nav-tab=""
                    href={node.tab.href}
                    aria-current={node.current}
                    className={`${ROW} ${collapsed ? RAIL_PAD : TAB_PAD} ${marked ? MARKED : node.groups && !collapsed ? OPEN_TAB : REST}`}
                  >
                    <TabIcon tab={node.tab.key} size={collapsed ? 20 : 16} />
                    <span className={collapsed ? "sr-only" : "min-w-0 truncate"}>{node.tab.label}</span>
                  </Link>
                </Tooltip>
                {node.groups && !collapsed && <TabScreens node={node} idBase={`${idBase}-${node.tab.key}`} />}
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="mt-auto border-t border-border p-2">
        {/* 이름은 상태와 상관없이 '왼쪽 메뉴 접기'(보이는 글 '메뉴 접기'가 이름 안에 있음), 접혔는지는 aria-pressed. 툴팁은 단축키를 알리는 설명. */}
        <Tooltip content={collapsed ? "메뉴 펼치기 ([)" : "메뉴 접기 ([)"} side="right">
          <button
            ref={toggleRef}
            type="button"
            aria-label="왼쪽 메뉴 접기"
            aria-pressed={collapsed}
            aria-controls={navId}
            aria-keyshortcuts="["
            onClick={handleToggle}
            className={`${ROW} w-full ${collapsed ? RAIL_PAD : TAB_PAD} ${REST}`}
          >
            <PanelLeftIcon size={collapsed ? 20 : 16} />
            {!collapsed && <span className="min-w-0 truncate">메뉴 접기</span>}
          </button>
        </Tooltip>
      </div>
    </aside>
  );
}

/** 펼친 탭의 하위 화면 — 묶음 없는 화면 먼저, 묶음은 그 이름(글 머리) 아래 따로 목록. */
function TabScreens({ node, idBase }: { node: NavTreeNode; idBase: string }) {
  return (
    <ul aria-label={`${node.tab.label} 화면`} className="mt-0.5 flex flex-col gap-0.5">
      {(node.groups ?? []).flatMap((group, index) => {
        if (group.label === null) {
          return [
            ...group.leaves.map((leaf) => <LeafRow key={leaf.item.href} leaf={leaf} />),
            ...group.upcoming.map((entry) => <UpcomingRow key={entry.label} entry={entry} />),
          ];
        }
        const headingId = `${idBase}-group-${index}`;
        return [
          <li key={`group:${group.label}`}>
            <span id={headingId} className={`block ${LEAF_PAD} pb-1 pt-2 text-xs text-text-3`}>
              {group.label}
            </span>
            <ul aria-labelledby={headingId} className="flex flex-col gap-0.5">
              {group.leaves.map((leaf) => (
                <LeafRow key={leaf.item.href} leaf={leaf} />
              ))}
            </ul>
          </li>,
        ];
      })}
    </ul>
  );
}

function LeafRow({ leaf }: { leaf: NavTreeLeaf }) {
  return (
    <li>
      <Link href={leaf.item.href} aria-current={leaf.current} className={`${ROW} ${LEAF_PAD} ${leaf.marked ? MARKED : REST}`}>
        <span className="min-w-0 truncate">{leaf.item.label}</span>
        {leaf.locked && (
          // 이름은 아이콘의 aria-label, 마우스 설명은 감싼 span의 title(아이콘에 <title>을 두면 링크 글자에 섞임 — 명세 D8 c)
          <span title="유료 등급 기능" className="inline-flex shrink-0">
            <LockIcon size={14} label="유료 등급 기능" />
          </span>
        )}
      </Link>
    </li>
  );
}

/** 준비 중 화면(lib/nav upcoming — 지금은 없음) — 링크 없이 흐린 글과 언제 여는지(보이는 글). */
function UpcomingRow({ entry }: { entry: UpcomingItem }) {
  return (
    <li>
      <span aria-disabled="true" className={`${ROW} ${LEAF_PAD} font-medium text-text-3`}>
        <span className="min-w-0 truncate">
          {entry.label} · {entry.note}
        </span>
        {entry.opensIn ? (
          <span className="shrink-0 rounded-control border border-border px-1.5 text-xs leading-4">
            <span className="sr-only"> (</span>
            {entry.opensIn}
            <span className="sr-only">에서 엽니다)</span>
          </span>
        ) : null}
      </span>
    </li>
  );
}
