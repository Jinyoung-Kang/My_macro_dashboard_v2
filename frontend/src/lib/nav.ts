/**
 * 화면 메뉴(정보 구조) — 다섯 탭 + 더보기와 탭마다의 하위 화면(설계서 §4, 1단계 브리프 §1.3). React를 모르는 순수 함수(ADR 0004).
 *
 * 1단계는 옛 화면 경로를 그대로 쓰고(4단계에서 /markets/… 로 옮김), 탭은 그 화면들을 묶기만 합니다.
 * 누구에게 무엇을 보이는지는 lib/access.ts가 정합니다(운영자 전용 숨김·유료 잠금 — 경로 앞부분 일치).
 * 셸(왼쪽 내비·하단 탭·하위 메뉴), 브라우저 탭 제목, 통합 검색의 메뉴 항목이 모두 이 표 하나를 씁니다.
 */
import { lockedFor, visibleMenus } from "./access";
import type { SessionUser } from "./types";

export type TabKey = "home" | "markets" | "institutions" | "korea" | "paper" | "more";

export type NavItem = {
  href: string;
  /** 하위 메뉴에 적는 짧은 이름. */
  label: string;
  /** 브라우저 탭 제목·검색 결과에 쓸 이름 — 짧은 이름만으로는 뜻이 모자랄 때(모의매매 "미국"). 없으면 label. */
  title?: string;
  /** 검색에서 함께 맞추는 말 — 화면 제목·옛 사이드바 메뉴 이름(예전 이름으로 찾아도 나오게). */
  keywords?: readonly string[];
};

export type NavTab = {
  key: TabKey;
  label: string;
  /** 탭을 누르면 가는 곳(그 탭의 첫 화면). */
  href: string;
  /** 이 탭에 속하는 화면(하위 메뉴 순서). */
  items: readonly NavItem[];
  /** 하위 화면 말고도 이 탭에 속하는 경로의 앞부분 — 모의매매는 /paper 아래 전부(2단계의 /paper/kr까지). */
  section?: string;
  /** 아직 없는 하위 화면 — 하위 메뉴에 표시만 하고 링크는 없습니다. */
  upcoming?: readonly { label: string; note: string }[];
};

export const TABS: readonly NavTab[] = [
  { key: "home", label: "홈", href: "/", items: [{ href: "/", label: "홈" }] },
  {
    key: "markets",
    label: "시장",
    href: "/macro",
    items: [
      { href: "/macro", label: "매크로 지표", keywords: ["거시경제 매크로 지표"] },
      { href: "/liquidity", label: "순유동성", keywords: ["연준 순유동성 트래커"] },
      { href: "/sector", label: "섹터·자산군", keywords: ["섹터 & 자산군 로테이션"] },
      { href: "/correlation", label: "상관관계", keywords: ["지표 상관관계"] },
      { href: "/cot", label: "투기세력(COT)", keywords: ["글로벌 투기세력 (COT)", "CFTC"] },
      { href: "/regime", label: "국면 판정", keywords: ["시장 국면 판정"] },
    ],
  },
  {
    key: "institutions",
    label: "기관",
    href: "/institutions",
    items: [
      { href: "/institutions", label: "13F 포트폴리오", keywords: ["기관 13F 포트폴리오 분석", "SEC"] },
      { href: "/consensus", label: "Money 교집합", keywords: ["기관 13F Money 교집합"] },
      { href: "/style", label: "스타일·위험", keywords: ["기관 13F 스타일·위험"] },
      { href: "/scorecard", label: "종목 스코어카드" },
    ],
  },
  {
    key: "korea",
    label: "한국",
    href: "/radar",
    items: [
      { href: "/radar", label: "수급 레이더", keywords: ["외국인/기관 수급 레이더 (KRX)"] },
      { href: "/krx", label: "파생·투기세력(KRX)", keywords: ["국내 파생 & 투기세력 (KRX)"] },
    ],
  },
  {
    key: "paper",
    label: "모의매매",
    // 미국 책 화면은 아직 옛 경로 /paper 하나입니다. /paper/us 경로(옛 /paper는 리디렉션)가 생기는 커밋에서 탭 href와
    // 하위 화면 href를 함께 /paper/us로 옮깁니다(브리프 §1.3) — 그 전에 옮기면 탭·하위 메뉴·검색이 404로 갑니다.
    href: "/paper",
    section: "/paper",
    items: [{ href: "/paper", label: "미국", title: "모의매매(미국)", keywords: ["모의 알고리즘 매매(미국)"] }],
    // 한국 증시 책은 2단계(계획서 §4) — 그때 /paper/kr 하위 메뉴가 됩니다.
    upcoming: [{ label: "한국", note: "준비 중" }],
  },
  {
    key: "more",
    label: "더보기",
    href: "/more",
    items: [
      { href: "/alerts", label: "알림" },
      { href: "/ai/report", label: "AI 종합 분석", keywords: ["AI 종합 데이터 분석"] },
      { href: "/status", label: "데이터 저장소 상태" },
      { href: "/connections", label: "외부 API 연결 테스트" },
      { href: "/admin/users", label: "사용자 관리" },
      { href: "/account", label: "내 계정" },
    ],
  },
];

/** 경로가 이 메뉴의 화면인가 — 같거나 `href/`로 시작. 홈(`/`)은 `//`로 시작하는 경로가 없어 정확히 같을 때만입니다. */
function covers(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** 지금 경로의 하위 화면. 겹치면 더 긴(구체적인) 경로가 이깁니다. 메뉴에 없는 경로(/login 등)는 null. */
export function activeItem(pathname: string): NavItem | null {
  let best: NavItem | null = null;
  for (const tab of TABS) {
    for (const item of tab.items) {
      if (covers(item.href, pathname) && (!best || item.href.length > best.href.length)) best = item;
    }
  }
  return best;
}

/** 지금 경로가 속한 탭. 탭 첫 화면·하위 화면·탭 영역(section) 중 하나에 맞으면 그 탭입니다. */
export function activeTab(pathname: string): NavTab | null {
  const item = activeItem(pathname);
  if (item) return TABS.find((tab) => tab.items.includes(item)) ?? null;
  return TABS.find((tab) => covers(tab.href, pathname) || (tab.section !== undefined && covers(tab.section, pathname))) ?? null;
}

/** 이 사용자에게 보이는 탭(운영자가 아니면 모의매매 탭이 빠짐 — lib/access.ts 앞부분 일치). */
export function visibleTabs(user: SessionUser | null | undefined): NavTab[] {
  return visibleMenus(TABS, user);
}

/** 이 사용자에게 보이는 그 탭의 하위 화면(운영자 전용 화면은 운영자에게만). */
export function visibleItems(tab: NavTab, user: SessionUser | null | undefined): NavItem[] {
  return visibleMenus(tab.items, user);
}

export type SubNavModel = {
  tab: NavTab;
  items: NavItem[];
  /** 지금 화면(aria-current="page")의 href. 탭 영역 안이지만 하위 화면이 아니면(/more) null. */
  current: string | null;
  upcoming: readonly { label: string; note: string }[];
};

/**
 * 상단바 아래 하위 메뉴 줄. 지금 탭에 보이는 화면(+ 준비 중 표시)이 둘 이상일 때만 그립니다 — 하나뿐이면 줄이 할 일이 없습니다.
 * 사용자에게 보이지 않는 탭(회원이 주소로 연 /paper)은 하위 화면이 걸러져 줄이 생기지 않습니다.
 */
export function subNav(pathname: string, user: SessionUser | null | undefined): SubNavModel | null {
  const tab = activeTab(pathname);
  if (!tab) return null;
  const items = visibleItems(tab, user);
  const upcoming = tab.upcoming ?? [];
  if (items.length + upcoming.length < 2) return null;
  const current = activeItem(pathname);
  return { tab, items, current: current && items.includes(current) ? current.href : null, upcoming };
}

/** 브라우저 탭 제목에 쓸 화면 이름 — 하위 화면 이름(없으면 탭 이름). 메뉴에 없는 경로는 null. */
export function menuTitle(pathname: string): string | null {
  const item = activeItem(pathname);
  if (item) return item.title ?? item.label;
  return activeTab(pathname)?.label ?? null;
}

export const APP_TITLE = "매크로 대시보드";

/** 브라우저 탭 제목 — "순유동성 · 매크로 대시보드". 읽지 않은 알림 접두사는 lib/alerts의 titleWithUnread가 붙입니다. */
export function documentTitle(pathname: string): string {
  const name = menuTitle(pathname);
  return name ? `${name} · ${APP_TITLE}` : APP_TITLE;
}

/** 통합 검색의 메뉴 항목 하나 — 보이는 화면만, 탭 이름이 보조 글. locked는 무료 회원에게 잠긴 유료 화면(하위 메뉴와 같은 🔒). */
export type NavSearchItem = { href: string; label: string; section: string; keywords: readonly string[]; locked: boolean };

/**
 * 통합 검색에 넣을 메뉴 — 이 사용자에게 보이는 탭의 보이는 화면 전부(하위 메뉴가 하나뿐인 탭도) + 더보기 화면 자체.
 * 탭 이름을 검색어로 함께 넣어 "시장"·"기관"으로 그 탭의 화면을 모두 찾게 합니다.
 */
export function navSearchItems(user: SessionUser | null | undefined): NavSearchItem[] {
  const out: NavSearchItem[] = [];
  for (const tab of visibleTabs(user)) {
    for (const item of visibleItems(tab, user)) {
      out.push({
        href: item.href,
        label: item.title ?? item.label,
        section: tab.label,
        keywords: [tab.label, ...(item.keywords ?? [])],
        locked: lockedFor(user, item.href),
      });
    }
    if (!tab.items.some((item) => item.href === tab.href)) {
      out.push({ href: tab.href, label: tab.label, section: tab.label, keywords: [], locked: lockedFor(user, tab.href) });
    }
  }
  return out;
}

/**
 * 탭 링크의 aria-current — 그 탭의 첫 화면을 보고 있으면 "page", 같은 탭의 다른 화면이면 "true"(이 탭 안에 있음), 아니면 없음.
 * 탭 링크는 첫 화면으로 가므로, /liquidity에서 "시장"(→ /macro)을 "현재 페이지"라고 읽으면 틀린 안내가 됩니다.
 */
export function tabCurrent(tab: NavTab, pathname: string): "page" | "true" | undefined {
  if (activeTab(pathname)?.key !== tab.key) return undefined;
  return pathname === tab.href ? "page" : "true";
}
