import type { TabKey } from "@/lib/nav";

/*
 * 셸의 작은 선 아이콘(승인된 시안과 같은 모양) — 아이콘 패키지를 들이지 않고 SVG 몇 줄로 둡니다.
 * 색은 글자색(currentColor)을 따르고, 뜻은 옆의 글자가 나르므로 모두 aria-hidden입니다.
 */

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

function Svg({ size, children }: { size: number; children: React.ReactNode }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      {children}
    </svg>
  );
}

export function TabIcon({ tab, size = 18 }: { tab: TabKey; size?: number }) {
  return <Svg size={size}>{TAB_PATHS[tab]}</Svg>;
}

export function SearchIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg size={size}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </Svg>
  );
}

export function BellIcon({ size = 18 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </Svg>
  );
}

export function ChevronRightIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M9 6l6 6-6 6" />
    </Svg>
  );
}
