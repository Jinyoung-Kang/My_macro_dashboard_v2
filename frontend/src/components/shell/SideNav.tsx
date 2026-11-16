"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef } from "react";
import { FOCUS_RING } from "@/components/ui/classes";
import { LockIcon, PanelLeftIcon } from "@/components/ui/icons";
import { Tooltip } from "@/components/ui/Tooltip";
import { useNavCollapsed } from "@/hooks/useNavCollapsed";
import { useNavResize } from "@/hooks/useNavResize";
import { useNavWidth } from "@/hooks/useNavWidth";
import { useScrollNavActive } from "@/hooks/useScrollNavActive";
import { useWideShell } from "@/hooks/useWideShell";
import { navTree, type NavTreeLeaf, type NavTreeNode, type UpcomingItem } from "@/lib/nav";
import { NAV_WIDTH_MAX, NAV_WIDTH_MIN, navSeparatorValue } from "@/lib/navWidth";
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
 * 접기·펼치기의 폭 전환 — 150ms(lib/navWidth NAV_MOTION_MS와 같은 값), 움직임 줄이기면 없음. 상자에는 접힘이 바뀐 뒤 200ms만 붙습니다(useNavResize motion —
 * 끄는 동안·레일에서 끌어낼 때·처음 그릴 때는 없음). 작업대 실행 명세 §3-8의 '모션은 색 전환만'에 대한 2026-11-16 사용자 결정의 예외입니다.
 */
const NAV_MOTION = "motion-safe:transition-[width] motion-safe:duration-150";

/*
 * 폭 손잡이(role=separator) — 메뉴 상자의 오른쪽 경계선(1px)에 가운데를 맞춘 8px 띠(안 4·밖 4), 메뉴 높이 전체. 보이는 선은 경계선 그대로이고, 가리키면
 * 경계선 자리에 2px 선(border-strong), 잡은 동안·키보드 포커스면 강조 파랑 2px 선과 포커스 링(FOCUS_RING)이 보입니다. 커서는 col-resize, 손가락으로
 * 끌어도 화면이 밀리지 않게 touch-none, 글은 없습니다. 본문 위 4px에 걸치므로 본문(relative)보다 위(z-20) — 덮개(시트 z-30·툴팁·대화상자)보다는 아래.
 * 고대비(forced-colors)에서는 바탕색(선)이 지워지므로 가리킨 동안·잡은 동안 안쪽 2px Highlight 윤곽선을 그립니다(포커스는 FOCUS_RING 윤곽선이 남음).
 * 누름 자리가 8px로 좁은 까닭(WCAG 2.5.8)은 진행 기록 'P3 추가 — 가변 폭 왼쪽 메뉴'에 적었습니다(같은 일을 하는 접기 단추·키보드).
 */
const HANDLE = [
  "absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none select-none",
  "before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:w-0.5 before:-translate-x-1/2 before:bg-transparent",
  "motion-safe:before:transition-colors motion-safe:before:duration-150 hover:before:bg-border-strong",
  "focus-visible:before:bg-accent data-[dragging]:before:bg-accent",
  FOCUS_RING,
  "forced-colors:hover:outline-2 forced-colors:hover:-outline-offset-2 forced-colors:hover:outline-[Highlight]",
  "forced-colors:data-[dragging]:outline-2 forced-colors:data-[dragging]:-outline-offset-2 forced-colors:data-[dragging]:outline-[Highlight]",
].join(" ");

/**
 * 넓은 화면(lg 이상) 왼쪽 나무 메뉴(폭 기본 220px·끌어서 180~320px, 접으면 48px — 작업대 실행 명세 §5, ADR 0042 결정 5. 폭 값은 셸 뿌리의 변수 --shell-nav-w 하나에서 읽습니다 — Shell). 이 사용자에게 보이는 탭(홈·시장·기관·모의매매·정보 검색·정보 수집·더보기)을
 * 두고, **지금 탭의 하위 화면을 그 아래에 펼칩니다** — 그래서 넓은 화면에는 하위 메뉴 줄(SubNav)이 없습니다. 모양은 lib/nav navTree가 정하고 여기서는 그리기만 합니다
 * (ADR 0004 1단계 덧붙임). 앱 이름은 폭 전체의 상단바 맨 왼쪽에 있고(메뉴 맨 위 상표는 없앰), 예전 아래쪽의 읽기 모드·수동 새로고침·계정·빌드 정보는 상단바로
 * 옮겼습니다(새로고침은 아이콘 단추, 나머지는 계정 메뉴). 테마 전환은 없습니다(어두운 한 벌 — ADR 0042 결정 2).
 * 좁은 화면에서는 숨기고(하단 탭 바 + 하위 메뉴 줄 + 더보기 화면이 대신), 데스크톱에서는 상단바 아래 남는 높이에 붙어 본문만 스크롤됩니다(메뉴가 길면 메뉴만 따로 스크롤).
 * 스크롤 상자는 메뉴(nav — min-h-0 flex-1 overflow-y-auto)이고 맨 아래 접기 영역은 그 밖에서 줄지 않아(shrink-0) 창이 낮아도 늘 보입니다 — 예전에는
 * 감싼 상자 전체가 스크롤 상자라 펼친 메뉴가 길면 접기 단추가 메뉴와 함께 화면 밖으로 밀렸습니다(QA-555: 1024x600 /more에서 단추 609~641px). 그래서 지금 칸이
 * 메뉴 끝 쪽이면 주소가 바뀌거나 접고 펼 때, 좁은 폭에서 넓은 화면이 될 때, 창 높이가 줄어 가려질 때 메뉴만 스크롤해 보입니다(useScrollNavActive —
 * scrollIntoView 아님).
 *
 * - 칸은 32px, 탭 아이콘 16px. 하위 칸은 탭 이름과 같은 세로줄로 들여 씁니다. 묶음(더보기의 '한국 시장')은 누르지 않는 글 머리 아래 따로 목록.
 * - aria-current는 nav.ts 규칙 그대로 — 탭 링크는 tabCurrent(첫 화면 page·같은 탭의 다른 화면 true), 하위 칸은 지금 화면만(주소 그대로 page·아래 주소 true).
 * - 하위 화면 목록은 nav가 아니라 이름 있는 목록('{탭} 화면')입니다 — '…하위 메뉴' 이름의 내비는 좁은 화면 하위 메뉴 줄 하나로 남습니다.
 * - 유료 화면은 무료 회원에게 자물쇠 아이콘(눌러도 되며 화면이 안내 — 하위 메뉴 줄과 같음). 준비 중 화면은 링크 없는 흐린 글(aria-disabled).
 * - 탭 링크에는 data-nav-tab을 붙입니다(시험이 탭 링크만 고를 때 — 펼친 하위 칸과 가름).
 * - 감싼 상자는 랜드마크가 아닌 div입니다(data-shell-sidenav — 시험이 메뉴 상자를 찾는 표지). 이 영역의 랜드마크는 nav '주 메뉴' 하나이고 접기 단추는
 *   그 곁입니다. 예전 aside는 이름 없는 보조 영역(complementary)이라 /search에서 화면 안의 이름 없는 aside와 갈리지 않았고(axe landmark-unique), 이름
 *   '왼쪽 메뉴'를 둔 뒤에도 같은 영역이 랜드마크 목록에 두 번(보조 영역 안의 주 메뉴) 나왔습니다(QA-556).
 *
 * **접힘(48px 아이콘 레일)**: 맨 아래 접기 단추(이름 '왼쪽 메뉴 접기' — 켜고 끄는 단추라 이름은 그대로, aria-pressed가 접힘, 단축키 [ — 명령 팔레트
 * 쪽이 넓은 화면에서만 셸 명령 toggle-nav를 보내고 여기서 받음)로 접고 폅니다. 툴팁은 상태와 상관없이 이름과 같은 글에 단축키를 붙인 '왼쪽 메뉴 접기 ([)'이고
 * 설명으로 잇지 않습니다(labelOnly — 단축키는 aria-keyshortcuts). 예전에는 접히면 툴팁이 '메뉴 펼치기 ([)'라 보이는 글과 이름이 반대 뜻이었고(음성 제어로
 * 보이는 대로 말하면 단추를 못 찾음), 설명으로 이어져 '왼쪽 메뉴 접기, 눌림, 메뉴 펼치기'로 읽혔습니다(검토 지적). 접히면 탭 아이콘(20px)만 남고 이름은 sr-only 글(링크 접근 이름 그대로)과 오른쪽 툴팁(이름과 같은 글이라 labelOnly)으로,
 * 하위 화면은 숨깁니다(펼치기·명령 팔레트·빵부스러기로 닿음). 막대는 보이는 칸 가운데 가장 깊은 지금 칸 — 레일에서는 지금 탭 칸입니다. 접힘은 보는 사람별로
 * 이 브라우저에 기억합니다(useNavCollapsed — 저장소를 못 써도 동작). 접고 펼 때 폭은 150ms 전환으로 바뀝니다(움직임 줄이기면 바로 — 명세 §3-8의
 * 2026-11-16 사용자 결정 예외, 아래 '가변 폭').
 * 탭 링크는 접고 펼 때 같은 요소로 남아(툴팁 감쌈을 늘 두고 펼친 동안은 열지 않음) 포커스가 그대로이고, 포커스가 사라지는 하위 칸에 있었으면 접기 단추로 옮깁니다.
 * 툴팁(레일의 탭 이름·접기 단추)은 넓은 화면에서만 엽니다(useWideShell — 폭이 lg 아래로 바뀌면 닫힘, QA-554).
 *
 * **가변 폭(2026-11-16 사용자 결정 — 명세 §5 '가변 폭 왼쪽 메뉴')**: 오른쪽 경계선의 폭 손잡이(role=separator '왼쪽 메뉴 폭', hooks/useNavResize)를 끌면
 * 펼친 폭이 180~320px(기본 220) 사이에서 바뀌고, 140px 아래로 끌어 놓으면 레일로 접히며 레일을 그 너머로 끌어내면 끈 폭으로 펼칩니다. 두 번 누르면 접기·펼치기,
 * 키보드는 ←·→ 16px(Shift 64)·Home·End·Enter(접기·펼치기). 펼친 폭은 보는 사람별로 기억하고(useNavWidth — 키 shell.navWidth), 접기 단추·[로 펴면
 * 그 폭으로 돌아갑니다. 끄는 동안은 폭 전환이 없고(포인터를 바로 따라감) 툴팁이 열리지 않습니다. 셸 뿌리가 같은 값으로 --shell-nav-w를 둡니다(Shell).
 */
export function SideNav({ pathname, user }: { pathname: string; user?: SessionUser }) {
  const tree = navTree(pathname, user);
  const idBase = useId();
  const navId = `${idBase}-nav`;
  const [collapsed] = useNavCollapsed();
  const [width] = useNavWidth();
  // 툴팁은 넓은 화면에서만 — 메뉴가 CSS로 숨어도(lg 미만) 열린 툴팁이 좁은 화면 왼쪽 위에 남았습니다(QA-554).
  const wide = useWideShell();
  const boxRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  // 접고 펴기 직전에 포커스가 이 메뉴 안에 있었는가 — 그린 뒤 포커스가 사라졌으면(하위 칸) 접기 단추로 옮깁니다.
  const refocus = useRef(false);

  const rememberFocus = useCallback(() => {
    const active = document.activeElement;
    refocus.current = Boolean(boxRef.current && active && boxRef.current.contains(active));
  }, []);
  // 접기·펼치기(150ms 폭 전환)와 오른쪽 가장자리의 폭 손잡이(끌기·키·두 번 누르기) — hooks/useNavResize.
  const resize = useNavResize(rememberFocus);
  const handleToggle = resize.toggle;
  // 끄는 동안에는 툴팁을 열지 않습니다(포인터는 손잡이가 잡고 있지만 키보드 포커스로 열리는 것까지).
  const tooltipsOff = !wide || resize.dragging;
  const separator = navSeparatorValue({ collapsed, width });

  // 지금 칸이 메뉴 아래(접기 영역 뒤)에 가려져 열리지 않게 — 메뉴(nav)만 스크롤합니다(QA-555). 좁은 폭에서 연 화면을 넓히면 그때 다시 봅니다(wide).
  useScrollNavActive(navRef, pathname, collapsed, wide);

  // 셸 명령 신호 — [ 키·명령 팔레트의 '왼쪽 메뉴 접기·펼치기'(넓은 화면에서만 보냄, lib/shellCommands).
  useEffect(() => onShellCommand("toggle-nav", handleToggle), [handleToggle]);

  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const active = document.activeElement;
    if (!(boxRef.current && active && boxRef.current.contains(active))) toggleRef.current?.focus();
  }, [collapsed]);

  return (
    <div
      ref={boxRef}
      data-shell-sidenav=""
      className={`relative hidden shrink-0 flex-col border-r border-border bg-surface lg:flex lg:w-[var(--shell-nav-w)] ${resize.motion ? NAV_MOTION : ""}`}
    >
      <nav ref={navRef} id={navId} aria-label="주 메뉴" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2">
        <ul className="flex flex-col gap-0.5">
          {tree.map((node) => {
            // 막대 — 펼친 메뉴는 가장 깊은 지금 칸(navTree), 레일은 하위 칸이 숨으므로 지금 탭 칸.
            const marked = collapsed ? node.current !== undefined : node.marked;
            return (
              <li key={node.tab.key}>
                <Tooltip content={node.tab.label} side="right" labelOnly disabled={!collapsed || tooltipsOff}>
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
      <div className="mt-auto shrink-0 overflow-x-clip border-t border-border p-2">
        {/* 이름은 상태와 상관없이 '왼쪽 메뉴 접기'(보이는 글 '메뉴 접기'가 이름 안에 있음), 접혔는지는 aria-pressed. 툴팁은 이름과 같은 글 + 단축키라
            설명으로 잇지 않습니다(labelOnly — 단축키는 aria-keyshortcuts가 읽힘). */}
        <Tooltip content="왼쪽 메뉴 접기 ([)" side="right" labelOnly disabled={tooltipsOff}>
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
      {/* 폭 손잡이 — 오른쪽 경계선에 걸친 8px(창 나누개 패턴: role=separator, 포커스 가능, 값은 펼친 폭). Tab 순서는 접기 단추 다음, 본문 앞. */}
      <div
        role="separator"
        tabIndex={0}
        aria-label="왼쪽 메뉴 폭"
        aria-orientation="vertical"
        aria-controls={navId}
        aria-valuemin={NAV_WIDTH_MIN}
        aria-valuemax={NAV_WIDTH_MAX}
        aria-valuenow={separator.now}
        aria-valuetext={separator.text}
        data-dragging={resize.dragging ? "" : undefined}
        className={HANDLE}
        {...resize.separatorProps}
      />
    </div>
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
        // 글 머리는 한 줄(truncate) — 높이가 메뉴 폭에 따라 바뀌지 않게 합니다. 펼치는 150ms 전환의 첫 그림(48px 상자)에서 글자마다 줄이 바뀌어 아래 칸이
        // 밀렸다가 올라오고, 그 그림에서 잰 지금 칸 위치로 메뉴를 굴렸습니다(useScrollNavActive).
        return [
          <li key={`group:${group.label}`}>
            <span id={headingId} className={`block truncate ${LEAF_PAD} pb-1 pt-2 text-xs text-text-3`}>
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
