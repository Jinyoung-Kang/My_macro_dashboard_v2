import type { TabKey } from "@/lib/nav";
import { IconBase } from "@/components/ui/icons";

/*
 * 셸의 탭 아이콘(승인된 시안과 같은 모양). 바탕 SVG와 나머지 아이콘은 화면 공용 모음(components/ui/icons.tsx)에 있고,
 * 셸이 쓰던 이름(검색·벨·오른쪽 화살표)은 여기서 그대로 다시 내보냅니다 — 두 벌을 두지 않습니다.
 * 색은 글자색(currentColor)을 따르고, 뜻은 옆의 글자가 나르므로 모두 aria-hidden입니다.
 */

export { BellIcon, ChevronRightIcon, SearchIcon } from "@/components/ui/icons";

const TAB_PATHS: Record<TabKey, React.ReactNode> = {
  home: <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  markets: <path d="M3 17l6-6 4 4 8-8" />,
  institutions: <path d="M3 21h18M5 21V9l7-5 7 5v12M9 21v-6h6v6" />,
  korea: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
    </>
  ),
  paper: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 15l3-3 3 2 4-5" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </>
  ),
};

export function TabIcon({ tab, size = 18 }: { tab: TabKey; size?: number }) {
  return <IconBase size={size}>{TAB_PATHS[tab]}</IconBase>;
}

/** 더보기 하위 화면의 아이콘(경로별). 표에 없는 화면은 더보기 탭 아이콘. 뜻은 옆의 화면 이름이 나릅니다. */
const MENU_PATHS: Record<string, React.ReactNode> = {
  "/alerts": (
    <>
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </>
  ),
  "/ai/report": (
    <>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
    </>
  ),
  "/status": (
    <>
      <ellipse cx="12" cy="5.5" rx="7.5" ry="2.5" />
      <path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13" />
      <path d="M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5" />
    </>
  ),
  "/connections": (
    <>
      <path d="M9 7V3M15 7V3" />
      <path d="M6 7h12v4a6 6 0 0 1-12 0z" />
      <path d="M12 17v4" />
    </>
  ),
  "/admin/users": (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6" />
    </>
  ),
  "/account": (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
    </>
  ),
};

export function MenuIcon({ href, size = 18 }: { href: string; size?: number }) {
  return <IconBase size={size}>{MENU_PATHS[href] ?? TAB_PATHS.more}</IconBase>;
}
