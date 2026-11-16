/**
 * 앱 셸 — 옛 Sidebar.test.tsx의 의도를 옮겨 왔고(계정 영역·운영자 전용 메뉴·빌드 정보), 새 셸의 틀을 더 봅니다.
 *
 * 계정 영역(넓은 화면 상단바의 계정 메뉴 — 작업대 실행 명세 §5): 데모 열람(ADR 0013)이면 로그아웃·내 계정 링크 대신 "데모 열람". 로그인 없이 연 로컬
 * 운영자(ADR 0016)면 로그아웃 대신 "로컬 · 로그인 없음"을 내 계정 링크로. 계정 메뉴는 닫혀 있으면 내용이 DOM에 없어 Enter로 연 뒤 보고, 열린 메뉴는
 * 모달이라(뒤 화면 aria-hidden) 메뉴 밖을 role로 찾는 단언은 열기 전에 둡니다. 메뉴 안의 로그아웃은 단추가 아니라 메뉴 항목(menuitem)입니다
 * (뜻 단언 예외 — 실행 명세 §5 '계정 메뉴(읽기 모드와 빌드 정보를 그 안으로)'·ADR 0042 결정 5·9가 계정 메뉴를 메뉴로 정함, 진행 기록 §P3).
 * 좁은 화면의 더보기 계정 영역(단추)은 MoreMenu.test가 봅니다.
 * jsdom에는 CSS가 없어 왼쪽 내비와 하단 탭 바가 함께 DOM에 있으므로 메뉴는 nav 이름(주 메뉴·하단 메뉴·…하위 메뉴)으로 좁혀 봅니다.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNavCollapsedForTest } from "@/hooks/useNavCollapsed";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError, auth: { logout: vi.fn() } };
});
vi.mock("@/lib/api", () => api);

const nav = vi.hoisted(() => ({ pathname: "/macro" }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname, useRouter: () => router }));

const signal = vi.hoisted(() => ({
  token: 0, reloadAll: () => {}, notifyUnauthorized: () => {}, requestRefresh: vi.fn(), collecting: false, message: null as string | null,
}));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { Shell } from "../Shell";

const DEMO: SessionUser = { email: null, role: "MEMBER", tier: "PRO", demo: true };
const MEMBER_FREE: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "FREE" };
const MEMBER_PRO: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };
const LOCAL_OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: true };
const COOKIE_OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: false };

function renderShell(user: SessionUser | undefined, { path = "/macro", readMode = "auto", unread = 0 as number | null } = {}) {
  nav.pathname = path;
  return render(
    <Shell user={user} readMode={readMode} unread={unread}>
      <p>대시보드 본문</p>
    </Shell>,
  );
}

const mainNav = () => screen.getByRole("navigation", { name: "주 메뉴" });
/** 넓은 화면 상단바의 계정 메뉴를 엽니다(키보드 Enter — Radix 메뉴). */
function openAccountMenu(): HTMLElement {
  fireEvent.keyDown(screen.getByRole("button", { name: "계정 메뉴" }), { key: "Enter" });
  return screen.getByRole("menu", { name: "계정 메뉴" });
}
const bottomNav = () => screen.getByRole("navigation", { name: "하단 메뉴" });
const linkLabels = (scope: HTMLElement) => within(scope).getAllByRole("link").map((link) => link.textContent ?? "");
/** 주 메뉴의 탭 링크만(data-nav-tab) — 나무 메뉴가 지금 탭의 하위 화면 링크를 같은 nav 안에 펼치므로(실행 명세 §0 W2·§5) 탭 칸만 고릅니다. */
const tabLinkLabels = (scope: HTMLElement) => [...scope.querySelectorAll("a[data-nav-tab]")].map((link) => link.textContent ?? "");

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation(() => new Promise(() => {}));
  api.auth.logout.mockReset();
  router.push.mockReset();
  signal.requestRefresh.mockReset();
  signal.collecting = false;
  signal.message = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  window.localStorage.clear();
  resetNavCollapsedForTest();
});

describe("계정 영역(넓은 화면 상단바의 계정 메뉴 — 옛 사이드바 계정 영역)", () => {
  it("데모 열람이면 로그아웃·내 계정 링크가 없고 '데모 열람'과 조회 전용 안내를 보인다 — 운영 메뉴는 없고 유료 메뉴(AI)는 잠금 없이", () => {
    renderShell(DEMO, { path: "/alerts", readMode: "store_only" });

    expect(screen.queryByRole("button", { name: "로그아웃" })).toBeNull();
    const more = screen.getByRole("navigation", { name: "더보기 하위 메뉴" });
    expect(within(more).queryByRole("link", { name: "데이터 저장소 상태" })).toBeNull();
    expect(within(more).getByRole("link", { name: "AI 종합 분석" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /수동 새로고침/ })).toBeNull();

    const menu = openAccountMenu();
    expect(within(menu).queryByRole("menuitem", { name: "로그아웃" })).toBeNull();
    expect(document.querySelector('a[href="/account"]')).toBeNull();
    expect(screen.getByText("데모 열람")).toBeTruthy();
    expect(screen.getByText(/데모에서는 조회만 가능합니다/)).toBeTruthy();
  });

  it("계정으로 로그인한 회원은 이메일·등급 링크(내 계정)와 로그아웃을 보인다", () => {
    renderShell(MEMBER_FREE);

    const menu = openAccountMenu();
    expect(within(menu).getByRole("menuitem", { name: "로그아웃" })).toBeTruthy();
    const account = menu.querySelector('a[href="/account"]');
    expect(account?.textContent).toContain("member@test.local");
    expect(account?.textContent).toContain("무료 회원");
    expect(screen.queryByText("데모 열람")).toBeNull();
  });

  it("로그인 없이 연 로컬 운영자는 로그아웃 없이 '로컬 · 로그인 없음'·역할을 내 계정 링크로 보이고, 운영 메뉴와 수동 새로고침을 본다", () => {
    renderShell(LOCAL_OWNER, { path: "/alerts" });

    expect(screen.queryByRole("button", { name: "로그아웃" })).toBeNull();
    const more = screen.getByRole("navigation", { name: "더보기 하위 메뉴" });
    expect(within(more).getByRole("link", { name: "데이터 저장소 상태" })).toBeTruthy();
    expect(within(more).getByRole("link", { name: "사용자 관리" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /수동 새로고침/ })).toBeTruthy();

    const menu = openAccountMenu();
    expect(within(menu).queryByRole("menuitem", { name: "로그아웃" })).toBeNull();
    const account = menu.querySelector('a[href="/account"]');
    expect(account?.textContent).toContain("로컬 · 로그인 없음");
    expect(account?.textContent).toContain("운영자");
  });

  it("쿠키 세션으로 로그인한 운영자(local 아님)는 로그아웃을 보인다", () => {
    renderShell(COOKIE_OWNER);

    const menu = openAccountMenu();
    expect(within(menu).getByRole("menuitem", { name: "로그아웃" })).toBeTruthy();
    expect(menu.querySelector('a[href="/account"]')?.textContent).toContain("owner@test.local");
    expect(screen.queryByText(/로컬 · 로그인 없음/)).toBeNull();
  });

  it("데모 열람 표시가 앞선다 — local이 함께 와도 '데모 열람'만 보이고 로그아웃·내 계정 링크가 없다", () => {
    renderShell({ ...DEMO, local: true }, { readMode: "store_only" });

    expect(screen.queryByRole("button", { name: "로그아웃" })).toBeNull();
    const menu = openAccountMenu();
    expect(screen.getByText("데모 열람")).toBeTruthy();
    expect(screen.queryByText(/로컬 · 로그인 없음/)).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "로그아웃" })).toBeNull();
    expect(document.querySelector('a[href="/account"]')).toBeNull();
  });
});

describe("탭 — 모의매매(미국)는 운영자만", () => {
  it("운영자에게는 왼쪽 내비가 홈·시장·기관·모의매매·정보 검색·정보 수집·더보기, 하단 탭은 정보 수집 없이 여섯 칸(더보기에서 엶)", () => {
    renderShell(LOCAL_OWNER);

    expect(tabLinkLabels(mainNav())).toEqual(["홈", "시장", "기관", "모의매매", "정보 검색", "정보 수집", "더보기"]);
    expect(within(mainNav()).getByRole("link", { name: "정보 수집" }).getAttribute("href")).toBe("/info/overview");
    expect(within(mainNav()).getByRole("link", { name: "정보 검색" }).getAttribute("href")).toBe("/search");
    expect(linkLabels(bottomNav())).toEqual(["홈", "시장", "기관", "모의매매", "정보 검색", "더보기"]);
    for (const scope of [mainNav(), bottomNav()]) {
      expect(within(scope).getByRole("link", { name: "모의매매" }).getAttribute("href")).toBe("/paper/us");
    }
    expect(bottomNav().className).toContain("grid-cols-6");
  });

  it("회원·데모 열람에게는 모의매매 탭이 없다(다섯 칸) — 정보 검색은 보인다(D-1)", () => {
    renderShell(MEMBER_PRO);
    expect(tabLinkLabels(mainNav())).toEqual(["홈", "시장", "기관", "정보 검색", "더보기"]);
    expect(linkLabels(bottomNav())).toEqual(["홈", "시장", "기관", "정보 검색", "더보기"]);
    expect(bottomNav().className).toContain("grid-cols-5");
    cleanup();

    renderShell(DEMO, { readMode: "store_only" });
    expect(screen.queryAllByRole("link", { name: "모의매매" })).toHaveLength(0);
    expect(screen.queryAllByRole("link", { name: "정보 수집" })).toHaveLength(0);
    expect(within(mainNav()).getByRole("link", { name: "정보 검색" }).getAttribute("href")).toBe("/search");
  });

  it("더보기로 옮긴 한국 화면(/radar)에서는 두 내비의 '더보기'가 aria-current=true, 하위 메뉴 줄은 '한국 시장' 두 화면", () => {
    renderShell(MEMBER_PRO, { path: "/radar" });
    expect(within(mainNav()).getByRole("link", { name: "더보기" }).getAttribute("aria-current")).toBe("true");
    expect(within(bottomNav()).getByRole("link", { name: "더보기" }).getAttribute("aria-current")).toBe("true");
    const sub = screen.getByRole("navigation", { name: "한국 시장 하위 메뉴" });
    expect(linkLabels(sub)).toEqual(["수급 레이더", "파생·투기세력(KRX)"]);
    expect(within(sub).getByRole("link", { name: "수급 레이더" }).getAttribute("aria-current")).toBe("page");
  });

  it("지금 탭은 aria-current — 탭 첫 화면이면 page, 같은 탭의 다른 화면이면 true", () => {
    renderShell(MEMBER_PRO, { path: "/liquidity" });
    expect(within(mainNav()).getByRole("link", { name: "시장" }).getAttribute("aria-current")).toBe("true");
    expect(within(bottomNav()).getByRole("link", { name: "시장" }).getAttribute("aria-current")).toBe("true");
    expect(within(mainNav()).getByRole("link", { name: "홈" }).getAttribute("aria-current")).toBeNull();
    cleanup();

    renderShell(MEMBER_PRO, { path: "/macro" });
    expect(within(mainNav()).getByRole("link", { name: "시장" }).getAttribute("aria-current")).toBe("page");
  });

  it("왼쪽 내비의 가장 깊은 지금 칸(/macro에서는 '매크로 지표')은 왼쪽 3px 막대(고대비에서는 같은 폭의 왼쪽 테두리)·굵은 본문색 글, 펼친 지금 탭('시장')은 굵은 본문색 글만 — 글자는 강조 파랑이 아니다(QA-459, 작업대 명세 §3-8·§5)", () => {
    renderShell(MEMBER_PRO, { path: "/macro" });
    const current = within(mainNav()).getByRole("link", { name: "매크로 지표" }).className.split(/\s+/);
    expect(current).toEqual(
      expect.arrayContaining(["font-semibold", "text-text", "before:w-[3px]", "before:bg-accent", "forced-colors:before:border-l-[3px]"]),
    );
    expect(current).not.toContain("text-accent");
    const tab = within(mainNav()).getByRole("link", { name: "시장" }).className.split(/\s+/);
    expect(tab).toEqual(expect.arrayContaining(["font-semibold", "text-text"]));
    expect(tab.some((name) => name.startsWith("before:") || name.startsWith("forced-colors:"))).toBe(false);
    const other = within(mainNav()).getByRole("link", { name: "홈" }).className.split(/\s+/);
    expect(other.some((name) => name.startsWith("before:") || name.startsWith("forced-colors:"))).toBe(false);
    expect(mainNav().querySelector(".text-accent")).toBeNull();
  });
});

describe("하위 메뉴 줄(좁은 화면)", () => {
  it("시장 탭에서는 여섯 화면, 지금 화면이 aria-current=page", () => {
    renderShell(MEMBER_PRO, { path: "/liquidity" });
    const sub = screen.getByRole("navigation", { name: "시장 하위 메뉴" });
    // 넓은 화면에는 줄이 없다 — 왼쪽 나무 메뉴가 하위 화면을 펼친다(명세 §5 — W2)
    expect(sub.className.split(/\s+/)).toContain("lg:hidden");
    expect(linkLabels(sub)).toEqual(["매크로 지표", "순유동성", "섹터·자산군", "상관관계", "투기세력(COT)", "국면 판정"]);
    expect(within(sub).getByRole("link", { name: "순유동성" }).getAttribute("aria-current")).toBe("page");
    expect(within(sub).getByRole("link", { name: "매크로 지표" }).getAttribute("aria-current")).toBeNull();
  });

  it("화면이 하나뿐인 홈에서는 줄이 없다", () => {
    renderShell(MEMBER_PRO, { path: "/" });
    expect(screen.queryByRole("navigation", { name: /하위 메뉴/ })).toBeNull();
  });

  it("모의매매(운영자)는 미국·한국 두 링크(모의매매 화면의 시장 고르기는 이 줄 하나) — 예전 '한국 · 준비 중'은 없음", () => {
    renderShell(LOCAL_OWNER, { path: "/paper/us" });
    const sub = screen.getByRole("navigation", { name: "모의매매 하위 메뉴" });
    expect(linkLabels(sub)).toEqual(["미국", "한국"]);
    expect(within(sub).getByRole("link", { name: "미국" }).getAttribute("aria-current")).toBe("page");
    const korea = within(sub).getByRole("link", { name: "한국" });
    expect(korea.getAttribute("href")).toBe("/paper/kr");
    expect(korea.getAttribute("aria-current")).toBeNull();
    expect(within(sub).queryByText(/준비 중/)).toBeNull();
  });

  it("정보 수집(운영자)의 하위 메뉴 줄은 여덟 분류 탭, 지금 탭이 aria-current=page", () => {
    renderShell(LOCAL_OWNER, { path: "/info/kr" });
    const sub = screen.getByRole("navigation", { name: "정보 수집 하위 메뉴" });
    expect(linkLabels(sub)).toEqual(["개요", "뉴스·글", "국내 시장·수급", "해외 시장·거시", "기관·공시", "모의매매 입력", "출처 상태", "정보(메커니즘)"]);
    expect(within(sub).getByRole("link", { name: "국내 시장·수급" }).getAttribute("aria-current")).toBe("page");
    expect(within(mainNav()).getByRole("link", { name: "정보 수집" }).getAttribute("aria-current")).toBe("true");
  });

  it("한국 화면 탭 주소(/paper/kr/settings)에서는 '한국'이 고른 표시 — aria-current true", () => {
    renderShell(LOCAL_OWNER, { path: "/paper/kr/settings" });
    const sub = screen.getByRole("navigation", { name: "모의매매 하위 메뉴" });
    expect(within(sub).getByRole("link", { name: "한국" }).getAttribute("aria-current")).toBe("true");
    expect(within(sub).getByRole("link", { name: "미국" }).getAttribute("aria-current")).toBeNull();
  });

  it("모의매매 탭 주소(/paper/us/holdings)에서는 '미국'(→ 개요)이 고른 표시만 — aria-current는 page가 아니라 true", () => {
    renderShell(LOCAL_OWNER, { path: "/paper/us/holdings" });
    const sub = screen.getByRole("navigation", { name: "모의매매 하위 메뉴" });
    const us = within(sub).getByRole("link", { name: "미국" });
    expect(us.getAttribute("aria-current")).toBe("true");
    expect(us.className).toContain("font-semibold");
    // 탭 링크도 같은 규칙(첫 화면이 아니면 true)
    expect(within(mainNav()).getByRole("link", { name: "모의매매" }).getAttribute("aria-current")).toBe("true");
  });

  it("무료 회원에게는 유료 화면(AI 종합 분석)에 잠금 아이콘", () => {
    renderShell(MEMBER_FREE, { path: "/alerts" });
    const sub = screen.getByRole("navigation", { name: "더보기 하위 메뉴" });
    const ai = within(sub).getByRole("link", { name: /AI 종합 분석/ });
    expect(within(ai).getByRole("img", { name: "유료 등급 기능" })).toBeTruthy();
    // 잠금 아이콘에는 <title>이 없어 링크 글자는 메뉴 이름 그대로(명세 D8 c)
    expect(linkLabels(sub)).toEqual(["알림", "AI 종합 분석", "내 계정"]);
  });
});

describe("빵부스러기(넓은 화면 상단바)", () => {
  const crumbs = () => screen.getByRole("navigation", { name: "현재 위치" });
  const crumbItems = () => within(crumbs()).getAllByRole("listitem");

  it("모의매매 탭 주소는 모의매매 › 미국 › 보유·체결 — 앞 두 칸은 링크, 마지막 칸은 링크 없이 aria-current=page", () => {
    renderShell(LOCAL_OWNER, { path: "/paper/us/holdings" });
    expect(crumbItems().map((item) => item.textContent)).toEqual(["모의매매", "›미국", "›보유·체결"]);
    expect(within(crumbs()).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["모의매매", "/paper/us"],
      ["미국", "/paper/us"],
    ]);
    const current = within(crumbs()).getByText("보유·체결");
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(current.closest("a")).toBeNull();
    // 좁은 화면에는 없다(지금 구조 — 명세 §5)
    expect(crumbs().className.split(/\s+/)).toEqual(expect.arrayContaining(["hidden", "lg:flex"]));
    expect(crumbs().closest("header")).not.toBeNull();
    // 링크는 글 줄(text-sm 20px)에 위아래 2px — 누르는 높이 24px(넓은 화면 작은 조작, 명세 §3-7)
    for (const link of within(crumbs()).getAllByRole("link")) {
      expect(link.className.split(/\s+/)).toEqual(expect.arrayContaining(["py-0.5", "truncate"]));
    }
    expect(within(crumbs()).getByRole("list").className.split(/\s+/)).toContain("text-sm");
  });

  // QA-548: 칸(li)마다 flex-shrink 1이라 모자란 폭이 칸 폭 비율대로 모든 칸에 나뉘어, 1~5px만 모자라도 짧은 앞 칸까지 함께 말줄임됐습니다 —
  // QA 스택 1280(xl에서 앱 이름·검색 단추·장 시계가 한꺼번에 넓어져 자리 251px, 1024의 267px보다 좁음) /institutions/0001608046이 5.2px 모자라
  // '기... › 13F 포트폴... › CIK 0001608...'(27.4·95.8·102.8px), /krx가 '더... › 한국 ... › 파생·투기세력(K...'. 마지막 칸(대상·지금 화면 — 전체 글은
  // title)만 큰 축소 비중(shrink-1000)을 줘 모자란 폭을 먼저 받게 하고, 앞 칸은 1·min-w-0 그대로 둡니다(앞 칸을 shrink-0으로 두면 자리가 아주 좁을 때
  // 칸이 검색 단추를 덮음). 마지막 칸이 0이 된 뒤에야 앞 칸이 줄어듭니다.
  // 수정 전(재현 커밋에서는 it.fails)에는 세 칸 모두 'flex min-w-0 items-center gap-1'(축소 비중 1)이었습니다.
  it("모자란 폭은 마지막 칸이 먼저 받는다 — 마지막 칸(li)만 축소 비중 1000(shrink-1000), 앞 칸은 1·min-w-0 그대로 (QA-548)", () => {
    renderShell(MEMBER_PRO, { path: "/institutions/0001608046" });
    const classes = crumbItems().map((item) => item.className.split(/\s+/));
    expect(classes).toHaveLength(3);
    expect(classes[2]).toContain("shrink-1000");
    for (const front of classes.slice(0, 2)) {
      expect(front).not.toContain("shrink-1000");
      expect(front).toContain("min-w-0");
    }
  });

  it("종목 상세는 시장 › 종목(미국) › 코드 — 중간 칸은 주소가 없어 링크 없는 글", () => {
    renderShell(MEMBER_PRO, { path: "/s/us/NVDA" });
    expect(crumbItems().map((item) => item.textContent)).toEqual(["시장", "›종목(미국)", "›NVDA"]);
    expect(within(crumbs()).getAllByRole("link").map((link) => link.textContent)).toEqual(["시장"]);
    expect(within(crumbs()).getByText("NVDA").getAttribute("aria-current")).toBe("page");
  });

  it("홈은 한 칸(지금 화면), 앱 이름은 상단바에 한 번만 — 왼쪽 메뉴 맨 위 상표는 없다", () => {
    renderShell(MEMBER_PRO, { path: "/" });
    expect(crumbItems().map((item) => item.textContent)).toEqual(["홈"]);
    expect(within(crumbs()).queryAllByRole("link")).toHaveLength(0);
    // 빌드 정보의 '© 2026 My Macro Dashboard v2'는 앱 이름이 아니다(^로 시작하는 글만 셈).
    expect(screen.getAllByText(/^My Macro/)).toHaveLength(1);
    expect(within(screen.getByRole("banner")).getByText(/^My Macro/).textContent).toBe("My Macro Dashboard v2");
  });
});

describe("상단바 크기(작업대 실행 명세 §5 — 넓은 화면 48px 한 줄, 좁은 화면은 지금 구조)", () => {
  const classes = (element: Element) => element.className.split(/\s+/);

  it("넓은 화면 상단바는 48px 한 줄(lg:h-12, 줄바꿈 없음) — 좁은 화면의 앱 이름 줄은 64px 그대로", () => {
    renderShell(MEMBER_PRO);
    const header = screen.getByRole("banner");
    expect(classes(header)).toEqual(expect.arrayContaining(["lg:h-12", "lg:flex-nowrap", "flex-wrap"]));
    expect(classes(header).some((name) => /^(lg:)?h-16$/.test(name))).toBe(false);
    const appName = within(header).getByText(/^My Macro/);
    expect(classes(appName)).toEqual(expect.arrayContaining(["h-16", "lg:h-auto"]));
  });

  it("알림 벨은 좁은 화면 44px·넓은 화면 30px(상단바 조작 높이 — 검색·새로고침·계정과 같음)", () => {
    renderShell(MEMBER_PRO, { unread: 1 });
    const bell = screen.getByRole("link", { name: "알림 — 읽지 않음 1건" });
    expect(classes(bell)).toEqual(expect.arrayContaining(["size-11", "lg:size-[30px]", "rounded-control"]));
  });
});

describe("상단바 알림 벨", () => {
  it("읽지 않은 수를 이름에 담고, 1건 이상이면 숫자 배지(99건 넘으면 99+)", () => {
    renderShell(MEMBER_PRO, { unread: 3 });
    const bell = screen.getByRole("link", { name: "알림 — 읽지 않음 3건" });
    expect(bell.getAttribute("href")).toBe("/alerts");
    expect(bell.textContent).toBe("3");
    cleanup();

    renderShell(MEMBER_PRO, { unread: 150 });
    expect(screen.getByRole("link", { name: "알림 — 읽지 않음 150건" }).textContent).toBe("99+");
  });

  it("0건이면 배지 없이 '0건', 수를 모르면(null) 수를 지어내지 않고 '알림'만", () => {
    renderShell(MEMBER_PRO, { unread: 0 });
    expect(screen.getByRole("link", { name: "알림 — 읽지 않음 0건" }).textContent).toBe("");
    cleanup();

    renderShell(MEMBER_PRO, { unread: null });
    expect(screen.getByRole("link", { name: "알림" }).textContent).toBe("");
    expect(screen.queryByRole("link", { name: /읽지 않음/ })).toBeNull();
  });

  // QA-501: 고대비(forced-colors)에서는 배지 바탕(bg-accent)이 시스템 바탕색(Canvas)으로 지워지는데 배지에 테두리가 없어, 배지 상자가 사라지고
  // 숫자만 위첨자처럼 남은 채 그 Canvas 바탕이 벨 아이콘 오른쪽 위를 가렸습니다(4px 모서리라 한두 자리 수에서도 벨이 이 빠진 모양 — 작업대 D8).
  // 작업대 명세 A8/D9처럼 고대비에서는 1px 테두리(색은 고대비가 정함)로 상자를 남깁니다 — Skeleton·PeriodBars·고른 칸(FORCED_SELECTED)과 같은 방식.
  // 수정 전(재현 커밋에서는 it.fails)에는 배지 클래스 16개에 forced-colors 변형이 하나도 없었습니다.
  it("고대비에서도 수 배지가 상자로 남는다 — 배지에 forced-colors:border(1px 테두리) (QA-501)", () => {
    renderShell(MEMBER_PRO, { unread: 42 });
    const bell = screen.getByRole("link", { name: "알림 — 읽지 않음 42건" });
    const badge = bell.querySelector('span[aria-hidden="true"]') as HTMLElement;
    expect(badge.textContent).toBe("42");
    expect([...badge.classList]).toContain("forced-colors:border");
  });

  it("넓은 화면에서만 이름과 같은 글의 툴팁(설명으로 잇지 않음) — 좁은 화면은 툴팁 없이 지금 그대로", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === WIDE_SHELL_MEDIA, media: query }) as MediaQueryList);
    try {
      renderShell(MEMBER_PRO, { unread: 3 });
      const bell = screen.getByRole("link", { name: "알림 — 읽지 않음 3건" });
      act(() => bell.focus());
      expect(screen.getByRole("tooltip").textContent).toBe("알림 — 읽지 않음 3건");
      expect(bell.hasAttribute("aria-describedby")).toBe(false);
    } finally {
      cleanup();
      vi.unstubAllGlobals();
    }

    renderShell(MEMBER_PRO, { unread: 3 });
    act(() => screen.getByRole("link", { name: "알림 — 읽지 않음 3건" }).focus());
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  // 좁은 화면(둘째 줄)과 넓은 화면(한 줄)은 같은 인스턴스의 자리만 바뀐다 — 둘로 그리면 공휴일 요청·1초 시계·글이 두 번씩 생긴다.
  it("장 시계(장 상태 칩)는 상단바에 한 번만 — 본문 맨 위에는 없다", () => {
    renderShell(MEMBER_PRO);
    const banner = screen.getByRole("banner");
    expect(within(banner).getAllByText("KOSPI")).toHaveLength(1);
    expect(screen.getAllByText("KOSPI")).toHaveLength(1);
    expect(within(screen.getByRole("main")).queryByText("NASDAQ")).toBeNull();
    const holidayReads = api.apiGetShared.mock.calls.filter(([path]) => String(path).startsWith("/api/calendar/kr-holidays"));
    expect(holidayReads).toHaveLength(1);
  });

  it("상단바에 통합 검색 단추가 있다(닫힌 동안에는 검색 자료를 읽지 않음)", () => {
    renderShell(MEMBER_PRO);
    expect(screen.getByRole("button", { name: "종목·기관·지표·메뉴 검색" }).getAttribute("aria-haspopup")).toBe("dialog");
    const searchReads = api.apiGetShared.mock.calls.filter(([path]) =>
      ["/api/macro/overview", "/api/sec13f/institutions", "/api/stock/universe"].some((prefix) => String(path).startsWith(prefix)),
    );
    expect(searchReads).toHaveLength(0);
  });
});

describe("본문", () => {
  it("본문으로 건너뛰기 링크 → main#main(포커스 가능 tabIndex -1), 넓은 표가 페이지 가로 스크롤을 만들지 않게 min-w-0·overflow-x-clip", () => {
    renderShell(MEMBER_PRO);
    expect(screen.getByRole("link", { name: "본문으로 건너뛰기" }).getAttribute("href")).toBe("#main");
    const main = screen.getByRole("main");
    expect(main.id).toBe("main");
    expect(main.getAttribute("tabindex")).toBe("-1");
    expect(main.className).toContain("min-w-0");
    // hidden이 아니라 clip — lg 미만에서 본문이 스크롤하지 않는 스크롤 상자가 되어 sticky 머리가 붙지 않던 것(QA-450, ShellQaSticky.test).
    expect(main.className.split(/\s+/)).toContain("overflow-x-clip");
    // 본문 안 sr-only 글(absolute)의 위치 기준 — 없으면 390px에서 페이지가 넓어지고 데스크톱에서 문서가 스크롤됐습니다.
    expect(main.className.split(/\s+/)).toContain("relative");
    expect(within(main).getByText("대시보드 본문")).toBeTruthy();
  });

  // QA-502: Tailwind 4.3.5의 focus:not-sr-only가 padding:0을 다시 넣고 (0,2,0) 특이도로 기본 px-4·py-2를 이김 — 여백은 같은 focus: 변형으로 둬야
  // not-sr-only 뒤에 나옴(@tailwindcss/node 4.3.5 컴파일로 확인). 기본 px-4·py-2만 두면 포커스 때 링크가 여백 0(약 116x20)으로 그려져 글자가 파란
  // 상자 가장자리에 붙고 상자 아래로 상표 글이 비쳤습니다. 숨어 있을 때는 sr-only가 여백 0을 두므로 기본 여백은 필요 없습니다.
  // 수정 전(재현 커밋에서는 it.fails)에는 여백이 변형 없는 px-4·py-2뿐이었습니다.
  it("건너뛰기 링크의 안쪽 여백은 포커스 때 보이게 하는 것과 같은 focus: 변형으로 둔다 — focus:not-sr-only의 padding:0에 덮이지 않게 (QA-502)", () => {
    renderShell(MEMBER_PRO);
    const classes = screen.getByRole("link", { name: "본문으로 건너뛰기" }).className.split(/\s+/);
    expect(classes).toContain("focus:not-sr-only");
    expect(classes).toEqual(expect.arrayContaining(["focus:px-4", "focus:py-2"]));
  });

  it("넓은 화면 셸 뿌리는 왼쪽 메뉴 폭을 변수 --shell-nav-w(220px)로 둔다 — 왼쪽 메뉴와 고정 위치 덮개(정보 검색 아래 시트)가 같은 변수를 읽음", () => {
    renderShell(MEMBER_PRO);
    const root = screen.getByRole("main").closest("div.min-h-screen") as HTMLElement;
    expect(root.className.split(/\s+/)).toEqual(expect.arrayContaining(["lg:flex-col", "lg:[--shell-nav-w:220px]"]));
    expect(root.getAttribute("data-nav")).toBe("expanded");
    const aside = (mainNav().closest("aside") as HTMLElement).className.split(/\s+/);
    expect(aside).toContain("lg:w-[var(--shell-nav-w)]");
    // 폭 숫자를 왼쪽 메뉴가 따로 들고 있지 않다(한쪽만 고쳐 어긋나지 않게)
    expect(aside.some((name) => /^(lg:)?w-(12|\[\d+px\])$/.test(name))).toBe(false);
  });

  it("왼쪽 메뉴를 아이콘 레일로 접어 둔 사람(저장값 '1')은 접힌 채 시작하고 셸 변수가 48px — 메뉴를 펴면 220px로", () => {
    window.localStorage.setItem("shell.navCollapsed", "1");
    renderShell(MEMBER_PRO);
    const root = screen.getByRole("main").closest("div.min-h-screen") as HTMLElement;
    expect(root.getAttribute("data-nav")).toBe("collapsed");
    expect(root.className.split(/\s+/)).toContain("lg:[--shell-nav-w:48px]");
    expect((mainNav().closest("aside") as HTMLElement).className.split(/\s+/)).toContain("lg:w-[var(--shell-nav-w)]");

    fireEvent.click(screen.getByRole("button", { name: "왼쪽 메뉴 접기" }));
    expect(root.getAttribute("data-nav")).toBe("expanded");
    expect(root.className.split(/\s+/)).toContain("lg:[--shell-nav-w:220px]");
  });

  it("좁은 화면에서는 하단 탭 바(64px + 안전 영역)만큼 아래 여백, 데스크톱에서는 되돌린다", () => {
    renderShell(MEMBER_PRO);
    const main = screen.getByRole("main");
    expect(main.className).toContain("pb-[calc(64px+1rem+env(safe-area-inset-bottom))]");
    expect(main.className).toContain("lg:pb-6");
    expect(bottomNav().className).toContain("lg:hidden");
  });

  it("읽기 모드를 보이고(계정 메뉴 안), store_only면 저장본만 쓴다는 안내", () => {
    renderShell(MEMBER_PRO, { readMode: "store_only" });
    openAccountMenu();
    expect(screen.getByText("store_only")).toBeTruthy();
    expect(screen.getByText(/저장본만 사용합니다/)).toBeTruthy();
  });
});

describe("운영자 수동 새로고침(넓은 화면 상단바의 아이콘 단추)", () => {
  it("누르면 수집을 요청하고, 수집 중에는 막고 안내 문구를 그대로 보인다", () => {
    renderShell(LOCAL_OWNER);
    // 안내 영역(role=status)은 문구가 없을 때도 있다 — 지웠다 내용과 함께 다시 넣으면 낭독기가 새 문구를 읽지 않기도 한다.
    const empty = screen.getAllByRole("status").find((node) => node.closest("header"));
    expect(empty?.textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "데이터 수동 새로고침" }));
    expect(signal.requestRefresh).toHaveBeenCalledTimes(1);
    cleanup();

    signal.collecting = true;
    signal.message = "수집을 요청했습니다 — 끝나면 화면이 갱신됩니다.";
    renderShell(LOCAL_OWNER);
    const button = screen.getByRole("button", { name: "수집 중… 끝나면 자동 갱신" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("수집을 요청했습니다 — 끝나면 화면이 갱신됩니다.").getAttribute("role")).toBe("status");
  });

  it("상단바 안의 30px 아이콘 단추(넓은 화면만) — 안내 문구는 말줄임하고 전체 글은 title", () => {
    signal.message = "수집을 요청했습니다 — 끝나면 화면이 갱신됩니다.";
    renderShell(LOCAL_OWNER);
    const button = screen.getByRole("button", { name: "데이터 수동 새로고침" });
    expect(button.closest("header")).not.toBeNull();
    expect(button.className.split(/\s+/)).toEqual(expect.arrayContaining(["size-[30px]", "rounded-control"]));
    // 도구 줄의 단추라 주 단추(강조 파랑 바탕)가 아니다(명세 §3-4)
    expect(button.className).not.toContain("bg-accent");
    const row = button.closest("header > div") as HTMLElement;
    expect(row.className.split(/\s+/)).toEqual(expect.arrayContaining(["hidden", "lg:flex"]));
    const status = within(row).getByRole("status");
    expect(status.getAttribute("title")).toBe("수집을 요청했습니다 — 끝나면 화면이 갱신됩니다.");
    expect(status.className.split(/\s+/)).toEqual(expect.arrayContaining(["truncate", "max-w-40"]));
  });

  // QA-547: 상단바 새로고침 안내(role=status — 다음 새로고침까지, 화면을 옮겨도 남음)가 빵부스러기와 폭을 다퉜습니다. 빵부스러기 nav가 lg:flex-1·min-w-0
  // (flex-basis 0, 하한 0)이라 다른 항목이 자기 폭을 먼저 가져간 뒤 남는 폭만 받았고, 안내를 감싼 상자(min-w-0 shrink)는 글 폭(최대 160·288px)을 그대로 차지했습니다.
  // QA 스택(1024·1280) — 성공 안내가 뜨면 nav 267.7 → 99.7px(1024, 칸마다 말줄임), 1280(xl — 앱 이름이 길어지고 안내 상한 288px)에서는 막힌 POST 실패 글·
  // store_only 글로 nav 0px이 되어 칸 링크가 0폭인 채 Tab 순서에 남았습니다. 로그아웃 실패 글(계정 메뉴 왼쪽, 같은 폭)도 같은 꼴입니다.
  // 빵부스러기에 하한(lg:min-w-40 — 160px)을 두고, 안내를 감싼 상자가 모자란 폭을 먼저 내주되(shrink-[100]) 아이콘 단추 30px + 사이 8px 아래로는 줄지 않게
  // (min-w-[38px]) 합니다. 안내가 없으면 상자는 단추 폭 그대로입니다(shrink-0 — 늘 38px 하한을 두면 단추가 8px씩 왼쪽으로 밀림, QA 스택 1024·1440에서 잼).
  // 수정 전(재현 커밋에서는 it.fails)에는 nav가 'hidden min-w-0 lg:flex lg:flex-1'(하한 없음), 감싼 상자가 안내와 상관없이 'min-w-0 shrink'였습니다.
  it("안내 글이 떠 있어도 빵부스러기는 하한 160px — 모자란 폭은 안내를 감싼 상자가 먼저 내주고(단추 30px + 사이 8px까지), 안내가 없으면 상자는 단추 폭 그대로 (QA-547)", () => {
    const refreshBox = () => (screen.getByRole("button", { name: "데이터 수동 새로고침" }).closest("header > div") as HTMLElement).className.split(/\s+/);
    signal.message = "수집이 끝나 화면을 갱신했습니다.";
    renderShell(LOCAL_OWNER, { path: "/krx" });
    expect(screen.getByRole("navigation", { name: "현재 위치" }).className.split(/\s+/)).toEqual(expect.arrayContaining(["lg:flex-1", "lg:min-w-40"]));
    const withNotice = refreshBox();
    expect(withNotice).toEqual(expect.arrayContaining(["min-w-[38px]", "shrink-[100]"]));
    expect(withNotice).not.toContain("min-w-0");
    cleanup();

    signal.message = null;
    renderShell(LOCAL_OWNER, { path: "/krx" });
    const quiet = refreshBox();
    expect(quiet).toContain("shrink-0");
    expect(quiet).not.toContain("min-w-[38px]");
    expect(quiet).not.toContain("min-w-0");
  });

  it("회원·데모 열람에게는 단추도 안내 영역도 없다", () => {
    for (const user of [MEMBER_PRO, DEMO]) {
      renderShell(user);
      expect(screen.queryByRole("button", { name: /수동 새로고침/ })).toBeNull();
      expect(within(screen.getByRole("banner")).queryByRole("status")).toBeNull();
      cleanup();
    }
  });
});

describe("빌드 정보(계정 메뉴 안 — 옛 사이드바 아래)", () => {
  it("빌드한 커밋 옆에 그 커밋의 날짜를 '최종 수정'으로 보인다", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "main@1ccad1c");
    vi.stubEnv("NEXT_PUBLIC_APP_UPDATED", "2026-10-20");
    renderShell(DEMO, { readMode: "store_only" });

    openAccountMenu();
    expect(screen.getByText(/main@1ccad1c/)).toBeTruthy();
    expect(screen.getByText("최종 수정 2026-10-20")).toBeTruthy();
    // 테마 전환은 없습니다(어두운 한 벌 — ADR 0042 결정 2). 왼쪽 내비 아래에도 라디오 묶음이 없다.
    expect(screen.queryByRole("radiogroup", { name: "화면 테마" })).toBeNull();
  });

  it("날짜가 없거나 날짜 형식이 아니면 '최종 수정'을 표시하지 않는다", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_UPDATED", "unknown");
    renderShell(DEMO, { readMode: "store_only" });

    openAccountMenu();
    expect(screen.getByText(/© 2026 My Macro Dashboard v2/)).toBeTruthy();
    expect(screen.queryByText(/최종 수정/)).toBeNull();
  });
});
