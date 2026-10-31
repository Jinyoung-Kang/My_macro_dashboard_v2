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
