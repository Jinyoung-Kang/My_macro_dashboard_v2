/**
 * 앱 셸 — 옛 Sidebar.test.tsx의 의도를 옮겨 왔고(계정 영역·운영자 전용 메뉴·빌드 정보), 새 셸의 틀을 더 봅니다.
 *
 * 계정 영역(왼쪽 내비 아래): 데모 열람(ADR 0013)이면 로그아웃·내 계정 링크 대신 "데모 열람". 로그인 없이 연 로컬 운영자(ADR 0016)면
 * 로그아웃 대신 "로컬 · 로그인 없음"을 내 계정 링크로. jsdom에는 CSS가 없어 왼쪽 내비와 하단 탭 바가 함께 DOM에 있으므로
 * 메뉴는 nav 이름(주 메뉴·하단 메뉴·…하위 메뉴)으로 좁혀 봅니다.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const bottomNav = () => screen.getByRole("navigation", { name: "하단 메뉴" });
const linkLabels = (scope: HTMLElement) => within(scope).getAllByRole("link").map((link) => link.textContent ?? "");

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
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear();
});

describe("계정 영역(옛 사이드바 계정 영역)", () => {
  it("데모 열람이면 로그아웃·내 계정 링크가 없고 '데모 열람'과 조회 전용 안내를 보인다 — 운영 메뉴는 없고 유료 메뉴(AI)는 잠금 없이", () => {
    renderShell(DEMO, { path: "/alerts", readMode: "store_only" });

    expect(screen.queryByRole("button", { name: "로그아웃" })).toBeNull();
    expect(document.querySelector('a[href="/account"]')).toBeNull();
    expect(screen.getByText("데모 열람")).toBeTruthy();
    expect(screen.getByText(/데모에서는 조회만 가능합니다/)).toBeTruthy();
    const more = screen.getByRole("navigation", { name: "더보기 하위 메뉴" });
    expect(within(more).queryByRole("link", { name: "데이터 저장소 상태" })).toBeNull();
    expect(within(more).getByRole("link", { name: "AI 종합 분석" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /수동 새로고침/ })).toBeNull();
  });

  it("계정으로 로그인한 회원은 이메일·등급 링크(내 계정)와 로그아웃을 보인다", () => {
    renderShell(MEMBER_FREE);

    expect(screen.getByRole("button", { name: "로그아웃" })).toBeTruthy();
    const account = document.querySelector('a[href="/account"]');
    expect(account?.textContent).toContain("member@test.local");
    expect(account?.textContent).toContain("무료 회원");
    expect(screen.queryByText("데모 열람")).toBeNull();
  });

  it("로그인 없이 연 로컬 운영자는 로그아웃 없이 '로컬 · 로그인 없음'·역할을 내 계정 링크로 보이고, 운영 메뉴와 수동 새로고침을 본다", () => {
    renderShell(LOCAL_OWNER, { path: "/alerts" });

    expect(screen.queryByRole("button", { name: "로그아웃" })).toBeNull();
    const account = document.querySelector('a[href="/account"]');
    expect(account?.textContent).toContain("로컬 · 로그인 없음");
    expect(account?.textContent).toContain("운영자");
    const more = screen.getByRole("navigation", { name: "더보기 하위 메뉴" });
    expect(within(more).getByRole("link", { name: "데이터 저장소 상태" })).toBeTruthy();
    expect(within(more).getByRole("link", { name: "사용자 관리" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /수동 새로고침/ })).toBeTruthy();
  });

  it("쿠키 세션으로 로그인한 운영자(local 아님)는 로그아웃을 보인다", () => {
    renderShell(COOKIE_OWNER);

    expect(screen.getByRole("button", { name: "로그아웃" })).toBeTruthy();
    expect(document.querySelector('a[href="/account"]')?.textContent).toContain("owner@test.local");
    expect(screen.queryByText(/로컬 · 로그인 없음/)).toBeNull();
  });

  it("데모 열람 표시가 앞선다 — local이 함께 와도 '데모 열람'만 보이고 로그아웃·내 계정 링크가 없다", () => {
    renderShell({ ...DEMO, local: true }, { readMode: "store_only" });

    expect(screen.getByText("데모 열람")).toBeTruthy();
    expect(screen.queryByText(/로컬 · 로그인 없음/)).toBeNull();
    expect(screen.queryByRole("button", { name: "로그아웃" })).toBeNull();
    expect(document.querySelector('a[href="/account"]')).toBeNull();
  });
});

describe("탭 — 모의매매(미국)는 운영자만", () => {
  it("운영자에게는 왼쪽 내비·하단 탭 모두 홈·시장·기관·한국·모의매매·더보기 순서, 모의매매는 미국 화면(/paper/us)", () => {
    renderShell(LOCAL_OWNER);

    for (const scope of [mainNav(), bottomNav()]) {
      expect(linkLabels(scope)).toEqual(["홈", "시장", "기관", "한국", "모의매매", "더보기"]);
      expect(within(scope).getByRole("link", { name: "모의매매" }).getAttribute("href")).toBe("/paper/us");
    }
    expect(bottomNav().className).toContain("grid-cols-6");
  });

  it("회원·데모 열람에게는 모의매매 탭이 없다(다섯 칸)", () => {
    renderShell(MEMBER_PRO);
    expect(linkLabels(mainNav())).toEqual(["홈", "시장", "기관", "한국", "더보기"]);
    expect(linkLabels(bottomNav())).toEqual(["홈", "시장", "기관", "한국", "더보기"]);
    expect(bottomNav().className).toContain("grid-cols-5");
    cleanup();

    renderShell(DEMO, { readMode: "store_only" });
    expect(screen.queryAllByRole("link", { name: "모의매매" })).toHaveLength(0);
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
});

describe("하위 메뉴 줄", () => {
  it("시장 탭에서는 여섯 화면, 지금 화면이 aria-current=page", () => {
    renderShell(MEMBER_PRO, { path: "/liquidity" });
    const sub = screen.getByRole("navigation", { name: "시장 하위 메뉴" });
    expect(linkLabels(sub)).toEqual(["매크로 지표", "순유동성", "섹터·자산군", "상관관계", "투기세력(COT)", "국면 판정"]);
    expect(within(sub).getByRole("link", { name: "순유동성" }).getAttribute("aria-current")).toBe("page");
    expect(within(sub).getByRole("link", { name: "매크로 지표" }).getAttribute("aria-current")).toBeNull();
  });

  it("화면이 하나뿐인 홈에서는 줄이 없다", () => {
    renderShell(MEMBER_PRO, { path: "/" });
    expect(screen.queryByRole("navigation", { name: /하위 메뉴/ })).toBeNull();
  });

  it("모의매매(운영자)는 미국 링크와 링크 없는 '한국 · 준비 중' + 보이는 '2단계'(모의매매 화면의 시장 고르기는 이 줄 하나)", () => {
    renderShell(LOCAL_OWNER, { path: "/paper/us" });
    const sub = screen.getByRole("navigation", { name: "모의매매 하위 메뉴" });
    expect(linkLabels(sub)).toEqual(["미국"]);
    expect(within(sub).getByRole("link", { name: "미국" }).getAttribute("aria-current")).toBe("page");
    const korea = within(sub).getByText("한국 · 준비 중");
    expect(korea.closest("a")).toBeNull();
    expect(korea.getAttribute("aria-disabled")).toBe("true");
    // 언제 여는지는 title이 아니라 보이는 글 — 낭독기는 "(2단계에서 엽니다)"로 읽습니다.
    expect(within(korea).getByText("2단계")).toBeTruthy();
    expect(korea.textContent).toBe("한국 · 준비 중 (2단계에서 엽니다)");
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

  it("무료 회원에게는 유료 화면(AI 종합 분석)에 🔒", () => {
    renderShell(MEMBER_FREE, { path: "/alerts" });
    const sub = screen.getByRole("navigation", { name: "더보기 하위 메뉴" });
    const ai = within(sub).getByRole("link", { name: /AI 종합 분석/ });
    expect(within(ai).getByRole("img", { name: "유료 등급 기능" })).toBeTruthy();
    expect(linkLabels(sub).map((label) => label.replace("🔒", ""))).toEqual(["알림", "AI 종합 분석", "내 계정"]);
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
  it("본문으로 건너뛰기 링크 → main#main(포커스 가능 tabIndex -1), 넓은 표가 페이지 가로 스크롤을 만들지 않게 min-w-0·overflow-x-hidden", () => {
    renderShell(MEMBER_PRO);
    expect(screen.getByRole("link", { name: "본문으로 건너뛰기" }).getAttribute("href")).toBe("#main");
    const main = screen.getByRole("main");
    expect(main.id).toBe("main");
    expect(main.getAttribute("tabindex")).toBe("-1");
    expect(main.className).toContain("min-w-0");
    expect(main.className).toContain("overflow-x-hidden");
    expect(within(main).getByText("대시보드 본문")).toBeTruthy();
  });

  it("좁은 화면에서는 하단 탭 바(64px + 안전 영역)만큼 아래 여백, 데스크톱에서는 되돌린다", () => {
    renderShell(MEMBER_PRO);
    const main = screen.getByRole("main");
    expect(main.className).toContain("pb-[calc(64px+1rem+env(safe-area-inset-bottom))]");
    expect(main.className).toContain("lg:pb-6");
    expect(bottomNav().className).toContain("lg:hidden");
  });

  it("읽기 모드를 보이고, store_only면 저장본만 쓴다는 안내", () => {
    renderShell(MEMBER_PRO, { readMode: "store_only" });
    expect(screen.getByText("store_only")).toBeTruthy();
    expect(screen.getByText(/저장본만 사용합니다/)).toBeTruthy();
  });
});

describe("운영자 수동 새로고침", () => {
  it("누르면 수집을 요청하고, 수집 중에는 막고 안내 문구를 그대로 보인다", () => {
    renderShell(LOCAL_OWNER);
    // 안내 영역(role=status)은 문구가 없을 때도 있다 — 지웠다 내용과 함께 다시 넣으면 낭독기가 새 문구를 읽지 않기도 한다.
    const empty = screen.getAllByRole("status").find((node) => node.closest("aside"));
    expect(empty?.textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "데이터 수동 새로고침 🚀" }));
    expect(signal.requestRefresh).toHaveBeenCalledTimes(1);
    cleanup();

    signal.collecting = true;
    signal.message = "수집을 요청했습니다 — 끝나면 화면이 갱신됩니다.";
    renderShell(LOCAL_OWNER);
    const button = screen.getByRole("button", { name: "수집 중… 끝나면 자동 갱신" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("수집을 요청했습니다 — 끝나면 화면이 갱신됩니다.").getAttribute("role")).toBe("status");
  });
});

describe("빌드 정보(옛 사이드바 아래)", () => {
  it("빌드한 커밋 옆에 그 커밋의 날짜를 '최종 수정'으로 보인다", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "main@1ccad1c");
    vi.stubEnv("NEXT_PUBLIC_APP_UPDATED", "2026-10-20");
    renderShell(DEMO, { readMode: "store_only" });

    expect(screen.getByText(/main@1ccad1c/)).toBeTruthy();
    expect(screen.getByText("최종 수정 2026-10-20")).toBeTruthy();
  });

  it("날짜가 없거나 날짜 형식이 아니면 '최종 수정'을 표시하지 않는다", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_UPDATED", "unknown");
    renderShell(DEMO, { readMode: "store_only" });

    expect(screen.queryByText(/최종 수정/)).toBeNull();
  });
});
