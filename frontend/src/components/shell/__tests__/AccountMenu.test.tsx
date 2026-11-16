/**
 * 넓은 화면 상단바의 계정 메뉴(shell/AccountMenu — 공용 DropdownMenu, 작업대 실행 명세 §5, ADR 0042 결정 5·9).
 *  - 누가 보고 있는지에 따라 내용이 다르다(더보기의 계정 영역 AccountBox와 같은 규칙): 계정 로그인 / 로그인 없는 운영자 / 데모 열람
 *  - 항목이 아닌 글(읽기 모드·빌드 정보·데모 열람 줄)은 메뉴의 설명 칸(aria-describedby) — 메뉴 안에서 역할을 갖는 것은 항목·구분선뿐
 *  - 로그아웃은 고르면 메뉴를 닫고 요청 — 실패하면 메뉴 밖(여는 단추 왼쪽) role=alert(QA-051), 성공하면 /login
 *  - '단축키 도움말'은 메뉴가 닫히고 포커스가 여는 단추로 돌아온 뒤 셸 명령 신호(open-shortcut-help)를 한 번 보낸다(lib/shellCommands)
 *  - 여는 단추는 30px·4px 경계 단추(원 아님 — 누르는 것), 메뉴 항목 글에 text-3이 없다(가리킨 항목 바탕 surface-3 위 금지 쌍)
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHELL_COMMAND_EVENT } from "@/lib/shellCommands";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => ({ auth: { logout: vi.fn() } }));
vi.mock("@/lib/api", () => api);

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/macro", useRouter: () => router }));

import { ReadModeProvider } from "../ReadMode";
import { AccountMenu } from "../AccountMenu";

const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "FREE" };
const COOKIE_OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: false };
const LOCAL_OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: true };
const TAILNET_OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: true, tailnet: true };
const DEMO: SessionUser = { email: null, role: "MEMBER", tier: "PRO", demo: true };

function renderMenu(user: SessionUser | undefined, readMode = "auto") {
  render(
    <ReadModeProvider readMode={readMode}>
      <AccountMenu user={user} />
    </ReadModeProvider>,
  );
  return screen.getByRole("button", { name: "계정 메뉴" });
}

function open(trigger: HTMLElement): HTMLElement {
  fireEvent.keyDown(trigger, { key: "Enter" });
  return screen.getByRole("menu", { name: "계정 메뉴" });
}

const itemNames = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((item) => item.textContent);
/** 메뉴의 설명(aria-describedby가 가리키는 칸)의 글. */
const descriptionText = (menu: HTMLElement) => document.getElementById(menu.getAttribute("aria-describedby") ?? "")?.textContent ?? null;

/** 메뉴(role=menu) 자식으로 둘 수 있는 역할(ARIA menu의 필수 자식 — 항목 셋·묶음, 구분선). 역할 없는 글 상자는 그 안을 다시 봅니다. */
const MENU_CHILD_ROLES = new Set(["menuitem", "menuitemcheckbox", "menuitemradio", "group", "separator"]);
/** 역할을 적지 않아도 역할을 갖는 요소(링크·단추·입력) — 메뉴 안에서는 항목 역할을 붙여야 합니다. */
const IMPLICIT_ROLE = (element: Element) =>
  (element.tagName === "A" && element.hasAttribute("href")) || ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(element.tagName);

/**
 * 메뉴 안에서 항목·구분선·묶음 말고 역할을 갖는 요소(axe aria-required-children이 보는 것 — 예: role=alert). 항목 안은 보지 않고(항목의 내용),
 * 역할 없는 글 상자는 그 안까지 봅니다. 새 시험 의존성 없이(명세 W11) 그 규칙의 뜻만 옮겼습니다.
 */
function menuChildViolations(menu: Element): string[] {
  const found: string[] = [];
  const walk = (parent: Element) => {
    for (const child of parent.children) {
      const role = child.getAttribute("role");
      if (role === "none" || role === "presentation" || role === "group") walk(child);
      else if (role !== null && MENU_CHILD_ROLES.has(role)) continue;
      else if (role !== null || IMPLICIT_ROLE(child)) found.push(`${child.tagName}[role=${role ?? "(암묵)"}] ${child.textContent?.slice(0, 20)}`);
      else walk(child);
    }
  };
  walk(menu);
  return found;
}

beforeEach(() => {
  api.auth.logout.mockReset();
  router.push.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("누가 보고 있는지에 따른 내용", () => {
  it("계정으로 로그인한 회원 — 계정 줄(내 계정 링크: 이메일·등급) · 단축키 도움말 · 읽기 모드 · 빌드 정보 · 로그아웃", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "main@1ccad1c");
    const menu = open(renderMenu(MEMBER, "store_only"));
    expect(itemNames(menu)).toEqual(["Mmember@test.local무료 회원", "단축키 도움말", "로그아웃"]);
    const account = within(menu).getByRole("menuitem", { name: /member@test\.local/ });
    expect(account.getAttribute("href")).toBe("/account");
    expect(within(menu).getByText("store_only")).toBeTruthy();
    expect(within(menu).getByText(/저장본만 사용합니다/)).toBeTruthy();
    expect(within(menu).getByText(/main@1ccad1c/)).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "단축키 도움말" }).getAttribute("aria-keyshortcuts")).toBe("?");
    // 읽기 모드·빌드 정보는 항목이 아니라 메뉴의 설명 — 메뉴가 열릴 때 함께 읽힘
    expect(descriptionText(menu)).toMatch(/^읽기 모드: store_only저장본만 사용합니다\..*© 2026 My Macro Dashboard v2.*main@1ccad1c$/);
  });

  it("쿠키 세션 운영자도 로그아웃이 있다", () => {
    const menu = open(renderMenu(COOKIE_OWNER));
    expect(itemNames(menu)).toEqual(["Oowner@test.local운영자", "단축키 도움말", "로그아웃"]);
  });

  it("로그인 없이 연 로컬·Tailscale 운영자 — 계정 줄('로컬 · 로그인 없음' 등)이 있고 로그아웃은 없다", () => {
    const local = open(renderMenu(LOCAL_OWNER));
    expect(itemNames(local)).toEqual(["O로컬 · 로그인 없음운영자", "단축키 도움말"]);
    expect(within(local).getByText("읽기 모드:", { exact: false })).toBeTruthy();
    expect(descriptionText(local)).toMatch(/^읽기 모드: auto/);
    cleanup();

    const tailnet = open(renderMenu(TAILNET_OWNER));
    expect(itemNames(tailnet)).toEqual(["OTailscale · 로그인 없음운영자", "단축키 도움말"]);
  });

  it("데모 열람 — '데모 열람 · 조회만' 줄, 내 계정·로그아웃 없음", () => {
    const menu = open(renderMenu(DEMO));
    expect(itemNames(menu)).toEqual(["단축키 도움말"]);
    expect(within(menu).getByText("데모 열람")).toBeTruthy();
    expect(within(menu).getByText(/데모에서는 조회만 가능합니다/)).toBeTruthy();
    expect(menu.querySelector('a[href="/account"]')).toBeNull();
    // 항목이 하나뿐이어도 '데모 열람 · 조회만'은 메뉴의 설명으로 읽힘(화살표로 닿지 않는 글로만 두지 않음)
    expect(descriptionText(menu)).toMatch(/^데모 열람· 데모에서는 조회만 가능합니다읽기 모드: auto/);
  });

  it("메뉴 안에서 역할을 갖는 것은 항목·구분선뿐이다 — 운영자·로그인 없는 운영자·데모 모두(경고·상태 글은 메뉴 밖, 그 밖의 글은 설명 칸)", () => {
    for (const user of [MEMBER, COOKIE_OWNER, LOCAL_OWNER, DEMO]) {
      const menu = open(renderMenu(user, "store_only"));
      expect(menuChildViolations(menu), user.email ?? "demo").toEqual([]);
      cleanup();
    }
  });

  it("검사기 자체 — 메뉴 안의 role=alert·역할 없는 단추를 찾고, 항목 안·역할 없는 글 상자 안의 글은 건너뛴다", () => {
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.innerHTML =
      '<div role="menuitem"><button>항목 안 단추</button></div><hr role="separator"><div><p>글</p><p role="alert">경고</p></div><button>단추</button>';
    expect(menuChildViolations(menu)).toEqual(["P[role=alert] 경고", "BUTTON[role=(암묵)] 단추"]);
  });
});

describe("로그아웃", () => {
  it("실패하면 메뉴를 닫고 메뉴 밖(여는 단추 왼쪽)에 경고 글(role=alert) — 삼키지 않는다(QA-051), 다시 고르면 지운 뒤 요청", async () => {
    api.auth.logout.mockRejectedValue(new Error("서버에 닿지 못했습니다"));
    const trigger = renderMenu(MEMBER);
    fireEvent.click(within(open(trigger)).getByRole("menuitem", { name: "로그아웃" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("로그아웃하지 못했습니다 — 서버에 닿지 못했습니다");
    expect(alert.getAttribute("title")).toBe("로그아웃하지 못했습니다 — 서버에 닿지 못했습니다");
    expect(alert.closest('[role="menu"]')).toBeNull();
    expect(alert.parentElement).toBe(trigger.parentElement);
    expect(router.push).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    api.auth.logout.mockResolvedValue(undefined);
    fireEvent.click(within(open(trigger)).getByRole("menuitem", { name: "로그아웃" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/login"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("성공하면 로그인 화면으로", async () => {
    api.auth.logout.mockResolvedValue(undefined);
    const menu = open(renderMenu(MEMBER));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "로그아웃" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/login"));
  });
});

describe("단축키 도움말", () => {
  it("고르면 메뉴가 닫히고 여는 단추로 포커스가 돌아온 뒤 셸 명령 open-shortcut-help를 한 번 보낸다", async () => {
    const received: { detail: unknown; focused: Element | null }[] = [];
    const listener = (event: Event) => received.push({ detail: (event as CustomEvent).detail, focused: document.activeElement });
    window.addEventListener(SHELL_COMMAND_EVENT, listener);
    try {
      const trigger = renderMenu(MEMBER);
      const menu = open(trigger);
      fireEvent.click(within(menu).getByRole("menuitem", { name: "단축키 도움말" }));
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      await waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]).toEqual({ detail: "open-shortcut-help", focused: trigger });
      // 다른 이유로 닫히면(Esc) 신호를 보내지 않는다.
      open(trigger);
      act(() => {
        fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
      });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(trigger));
      expect(received).toHaveLength(1);
    } finally {
      window.removeEventListener(SHELL_COMMAND_EVENT, listener);
    }
  });
});

describe("모양", () => {
  it("여는 단추는 30px·4px·1px 경계 단추(원 아님), 안의 머리글자는 장식 — 넓은 화면에서만 보인다", () => {
    const trigger = renderMenu(MEMBER);
    const classes = trigger.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["size-[30px]", "rounded-control", "border", "border-border"]));
    expect(classes).not.toContain("rounded-full");
    expect(trigger.textContent).toBe("M");
    expect(trigger.querySelector('[aria-hidden="true"]')?.textContent).toBe("M");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect((trigger.parentElement as HTMLElement).className.split(/\s+/)).toEqual(expect.arrayContaining(["hidden", "lg:flex"]));
    // 열린 모양은 aria-expanded로(이름 툴팁 트리거와 합쳐지면 data-state는 툴팁 것 — 공용 메뉴 tooltip)
    expect(classes).toEqual(expect.arrayContaining(["aria-expanded:border-border-strong", "aria-expanded:text-text"]));
    expect(classes.some((name) => name.startsWith("data-[state=open]:"))).toBe(false);
    // 마우스 사용자에게 이름(aria-label)을 같은 글의 툴팁으로 — 설명으로 잇지 않음
    act(() => trigger.focus());
    expect(screen.getByRole("tooltip").textContent).toBe("계정 메뉴");
    expect(trigger.hasAttribute("aria-describedby")).toBe(false);
    cleanup();

    // 이메일이 없으면(데모) 사람 아이콘 — 빈 원이나 빈 글자가 없다
    const demo = renderMenu(DEMO);
    expect(demo.textContent).toBe("");
    expect(demo.querySelector("svg")).not.toBeNull();
  });

  it("메뉴 항목 글은 text·text-2만 — 계정 줄의 역할 글도 text-2(가리킨 항목 바탕 surface-3 위 text-3 금지)", () => {
    const menu = open(renderMenu(MEMBER));
    for (const item of within(menu).getAllByRole("menuitem")) {
      for (const node of [item, ...item.querySelectorAll("*")]) {
        const classes = (node.getAttribute("class") ?? "").split(/\s+/);
        expect(classes.some((name) => ["text-text-3", "text-accent", "text-danger", "text-neutral"].includes(name))).toBe(false);
      }
    }
    expect(within(menu).getByText("무료 회원").className.split(/\s+/)).toContain("text-text-2");
  });
});
