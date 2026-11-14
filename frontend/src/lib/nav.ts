/**
 * 화면 메뉴(정보 구조) — 홈·시장·기관·모의매매·정보 검색·정보 수집·더보기와 탭마다의 하위 화면(설계서 §4, 1단계 브리프 §1.3,
 * 2026-11-14 재배치 — ADR 0041 결정 1: 한국 탭을 없애고 그 두 화면을 더보기의 '한국 시장' 묶음으로). React를 모르는 순수 함수(ADR 0004).
 *
 * 1단계는 옛 화면 경로를 그대로 쓰고(4단계에서 /markets/… 로 옮김), 탭은 그 화면들을 묶기만 합니다.
 * 누구에게 무엇을 보이는지는 lib/access.ts가 정합니다(운영자 전용 숨김·유료 잠금 — 경로 앞부분 일치).
 * 셸(왼쪽 내비·하단 탭·하위 메뉴), 브라우저 탭 제목, 통합 검색의 메뉴 항목이 모두 이 표 하나를 씁니다.
 */
import { lockedFor, visibleMenus } from "./access";
import type { SessionUser } from "./types";

export type TabKey = "home" | "markets" | "institutions" | "paper" | "search" | "info" | "more";

/** 더보기 탭 안에서 따로 묶는 한국 시장 화면(수급 레이더·파생·투기세력) — 더보기 화면의 제목 묶음이자 하위 메뉴 줄의 범위(ADR 0041 결정 1). */
export const KR_MARKET_GROUP = "한국 시장";

export type NavItem = {
  href: string;
  /** 하위 메뉴에 적는 짧은 이름. */
  label: string;
  /** 브라우저 탭 제목·검색 결과에 쓸 이름 — 짧은 이름만으로는 뜻이 모자랄 때(모의매매 "미국"). 없으면 label. */
  title?: string;
  /** 검색에서 함께 맞추는 말 — 화면 제목·옛 사이드바 메뉴 이름(예전 이름으로 찾아도 나오게). */
  keywords?: readonly string[];
  /**
   * 탭 안의 묶음 이름(예: "한국 시장"). 묶음이 있는 화면은 더보기 화면에서 그 제목 아래 따로 그리고, 하위 메뉴 줄은 같은 묶음의 화면만 보입니다
   * (/radar에서 알림·운영 화면이 섞이지 않게, /alerts에서 레이더가 섞이지 않게). 없으면 그 탭의 기본 묶음.
   */
  group?: string;
};

export type NavTab = {
  key: TabKey;
  label: string;
  /** 탭을 누르면 가는 곳(그 탭의 첫 화면). */
  href: string;
  /** 이 탭에 속하는 화면(하위 메뉴 순서). */
  items: readonly NavItem[];
  /**
   * 하위 화면 말고도 이 탭에 속하는 경로의 앞부분 — 모의매매는 /paper 아래 전부(옛 /paper 포함), 시장은 검색 상세(지표 /markets/i/…·종목 /s/…).
   */
  sections?: readonly string[];
  /** 아직 없는 하위 화면 — 하위 메뉴에 표시만 하고 링크는 없습니다. */
  upcoming?: readonly UpcomingItem[];
};

/** 하위 메뉴의 준비 중 표시 하나 — 예: "한국 · 준비 중" + 언제 여는지("2단계", 보이는 글). 지금은 쓰는 탭이 없습니다(모의매매 한국은 열림). */
export type UpcomingItem = { label: string; note: string; opensIn?: string };

export const TABS: readonly NavTab[] = [
  { key: "home", label: "홈", href: "/", items: [{ href: "/", label: "홈" }] },
  {
    key: "markets",
    label: "시장",
    href: "/macro",
    // 검색 상세 화면(명세 2026-11-01-search-detail) — 지표 /markets/i/<id>·종목 /s/<시장>/<코드>. 기관 상세 /institutions/<CIK>는 기관 탭의 13F 포트폴리오 아래.
    sections: ["/markets", "/s"],
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
    key: "paper",
    label: "모의매매",
    // 시장마다 화면은 /paper/us·/paper/kr(개요)와 그 아래 탭 주소(/paper/kr/holdings 등 — 하위 화면 하나가 덮음)입니다. 옛 /paper는
    // next.config가 /paper/us로 보내고, 탭 영역(sections)은 /paper 아래 전부입니다. 이 하위 메뉴 줄이 모의매매의 시장 고르기입니다
    // (화면 안에 같은 고르기를 또 두지 않음 — 두 줄로 겹쳐 보였음). 한국 책은 2단계 명세 §4-16(F2)에서 열었습니다.
    href: "/paper/us",
    sections: ["/paper"],
    items: [
      { href: "/paper/us", label: "미국", title: "모의매매(미국)", keywords: ["모의 알고리즘 매매(미국)"] },
      { href: "/paper/kr", label: "한국", title: "모의매매(한국)", keywords: ["모의 알고리즘 매매(한국)", "한국 증시 모의매매"] },
    ],
  },
  {
    // 정보 검색(ADR 0041) — 기업·기관·사람·주제를 대상으로 풀어 최근 2년의 뉴스·공시·리서치·글을 모아 봅니다. 회원 이상(운영자 전용이 아님 — D-1).
    // 상단 통합 검색(메뉴·지표·기관·종목 찾기)과는 다른 기능입니다.
    key: "search",
    label: "정보 검색",
    href: "/search",
    items: [{ href: "/search", label: "정보 검색", keywords: ["대상 검색", "기업·기관·사람 뉴스·공시", "관심 대상"] }],
  },
  {
    // 정보 수집(ADR 0035·0036) — 수집기가 받는 모든 출처의 자료·상태와 작동 방식. 운영자 전용. 하위 메뉴 줄이 큰 분류(탭)입니다.
    // 자리는 정보 검색과 더보기 사이(ADR 0041 결정 1 — 그 전에는 모의매매와 더보기 사이, ADR 0036 결정 1).
    // 좁은 화면의 아래쪽 탭 바에는 넣지 않고(6칸 유지 — 사용자 결정 2026-11-11) 더보기에서 엽니다(TabBar·MoreMenu).
    key: "info",
    label: "정보 수집",
    href: "/info/overview",
    sections: ["/info"],
    items: [
      { href: "/info/overview", label: "개요", title: "정보 수집 개요", keywords: ["수집 출처", "데이터 출처"] },
      { href: "/info/news", label: "뉴스·글", title: "정보 수집 · 뉴스·글", keywords: ["해외 블로그", "waedge", "거장", "사건 뉴스 RSS"] },
      { href: "/info/kr", label: "국내 시장·수급", title: "정보 수집 · 국내 시장·수급", keywords: ["네이버 매매상위", "KRX 정보데이터시스템", "공매도", "외국인 보유"] },
      { href: "/info/global", label: "해외 시장·거시", title: "정보 수집 · 해외 시장·거시", keywords: ["FRED", "경제 캘린더", "COT"] },
      { href: "/info/filings", label: "기관·공시", title: "정보 수집 · 기관·공시·재무", keywords: ["SEC 13F", "DART", "어닝 서프라이즈"] },
      { href: "/info/paper", label: "모의매매 입력", title: "정보 수집 · 모의매매 입력" },
      { href: "/info/status", label: "출처 상태", title: "정보 수집 · 출처 상태", keywords: ["수집 끊김", "차단", "형식 바뀜"] },
      { href: "/info/mechanism", label: "정보(메커니즘)", title: "정보 수집 · 작동 방식", keywords: ["작동 원리", "수집 설정", "하루 예산"] },
    ],
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
      // 옛 한국 탭(ADR 0041 결정 1) — 주소는 그대로. 탭 이름이 검색어였으므로 '한국'을 검색어로 직접 둡니다.
      { href: "/radar", label: "수급 레이더", group: KR_MARKET_GROUP, keywords: ["한국", "외국인/기관 수급 레이더 (KRX)"] },
      { href: "/krx", label: "파생·투기세력(KRX)", group: KR_MARKET_GROUP, keywords: ["한국", "국내 파생 & 투기세력 (KRX)"] },
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

/** 지금 경로가 속한 탭. 탭 첫 화면·하위 화면·탭 영역(sections) 중 하나에 맞으면 그 탭입니다. */
export function activeTab(pathname: string): NavTab | null {
  const item = activeItem(pathname);
  if (item) return TABS.find((tab) => tab.items.includes(item)) ?? null;
  return TABS.find((tab) => covers(tab.href, pathname) || (tab.sections ?? []).some((section) => covers(section, pathname))) ?? null;
}

/** 이 사용자에게 보이는 탭(운영자가 아니면 모의매매·정보 수집 탭이 빠짐 — lib/access.ts 앞부분 일치). */
export function visibleTabs(user: SessionUser | null | undefined): NavTab[] {
  return visibleMenus(TABS, user);
}

/** 이 사용자에게 보이는 그 탭의 하위 화면(운영자 전용 화면은 운영자에게만). */
export function visibleItems(tab: NavTab, user: SessionUser | null | undefined): NavItem[] {
  return visibleMenus(tab.items, user);
}

export type SubNavModel = {
  tab: NavTab;
  /** 줄의 이름(내비 이름표 "<이름> 하위 메뉴") — 묶음 화면이면 묶음 이름(한국 시장), 아니면 탭 이름. */
  label: string;
  items: NavItem[];
  /** 지금 화면(고른 표시)의 href. 탭 영역 안이지만 하위 화면이 아니면(/more) null. */
  current: string | null;
  /**
   * 그 링크의 aria-current — 링크 주소 그대로를 보고 있으면 "page", 그 화면의 아래 주소면 "true"(이 화면 안에 있음, tabCurrent와 같은
   * 규칙). /paper/us/holdings에서 "미국"(→ /paper/us, 누르면 개요로 감)을 "현재 페이지"라고 읽으면 틀린 안내가 됩니다. current가 null이면 null.
   */
  currentAria: "page" | "true" | null;
  upcoming: readonly UpcomingItem[];
};

/**
 * 상단바 아래 하위 메뉴 줄. 지금 탭에 보이는 화면(+ 준비 중 표시)이 둘 이상일 때만 그립니다 — 하나뿐이면 줄이 할 일이 없습니다.
 * 사용자에게 보이지 않는 탭(회원이 주소로 연 /paper)은 하위 화면이 걸러져 줄이 생기지 않습니다.
 */
export function subNav(pathname: string, user: SessionUser | null | undefined): SubNavModel | null {
  const tab = activeTab(pathname);
  if (!tab) return null;
  const item = activeItem(pathname);
  // 같은 묶음의 화면만 — 묶음 화면(/radar)에서는 그 묶음, 하위 화면이 아니거나(/more) 묶음 없는 화면이면 묶음 없는 화면들.
  const group = item && tab.items.includes(item) ? item.group : undefined;
  const items = visibleItems(tab, user).filter((entry) => entry.group === group);
  const upcoming = tab.upcoming ?? [];
  if (items.length + upcoming.length < 2) return null;
  const current = item && items.includes(item) ? item : null;
  return {
    tab,
    label: group ?? tab.label,
    items,
    current: current ? current.href : null,
    currentAria: current ? (pathname === current.href ? "page" : "true") : null,
    upcoming,
  };
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

/**
 * 통합 검색의 메뉴 항목 하나 — 보이는 화면만, 탭 이름(묶음 화면은 묶음 이름)이 보조 글. locked는 무료 회원에게 잠긴 유료 화면(하위 메뉴와 같은 잠금 표시).
 * tab은 그 화면이 속한 탭(결과 행 왼쪽 원에 그 탭의 아이콘을 그림).
 */
export type NavSearchItem = { href: string; label: string; section: string; tab: TabKey; keywords: readonly string[]; locked: boolean };

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
        section: item.group ?? tab.label,
        tab: tab.key,
        keywords: [tab.label, ...(item.group ? [item.group] : []), ...(item.keywords ?? [])],
        locked: lockedFor(user, item.href),
      });
    }
    if (!tab.items.some((item) => item.href === tab.href)) {
      out.push({ href: tab.href, label: tab.label, section: tab.label, tab: tab.key, keywords: [], locked: lockedFor(user, tab.href) });
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
