/**
 * 넓은 화면 상단바의 계정 메뉴(shell/AccountMenu — 공용 DropdownMenu, 작업대 실행 명세 §5, ADR 0042 결정 5·9).
 *  - 누가 보고 있는지에 따라 내용이 다르다(더보기의 계정 영역 AccountBox와 같은 규칙): 계정 로그인 / 로그인 없는 운영자 / 데모 열람
 *  - 항목이 아닌 글(읽기 모드·빌드 정보·데모 열람 줄)은 메뉴의 설명 칸(aria-describedby) — 메뉴 안에서 역할을 갖는 것은 항목·구분선뿐
 *  - 로그아웃은 고르면 메뉴를 닫고 요청 — 실패하면 메뉴 밖(여는 단추 왼쪽) role=alert(QA-051), 성공하면 /login
 *  - '단축키 도움말'은 메뉴가 닫히고 포커스가 여는 단추로 돌아온 뒤 셸 명령 신호(open-shortcut-help)를 한 번 보낸다(lib/shellCommands)
 *  - 여는 단추는 30px·4px 경계 단추(원 아님 — 누르는 것), 메뉴 항목 글에 text-3이 없다(가리킨 항목 바탕 surface-3 위 금지 쌍)
 *  - 이름 툴팁은 넓은 화면에서만(QA-554 — 툴팁을 보는 시험은 넓은 화면 matchMedia 대역을 둠). 폭이 lg 아래로 바뀌면 메뉴가 닫히는 것은 Shell.test가 봄
 *  - '왼쪽 메뉴 폭'(작업대 P3 추가, 2026-11-16 결정 — 끌지 않는 포인터 수단): 단축키 도움말 다음·로그아웃 앞의 이름 있는 단일 선택 묶음(좁게 206 · 기본 220 ·
 *    넓게 272), 고른 항목은 기억한 펼친 폭과 같은 단계, 고르면 폭을 저장하고 접혀 있으면 셸 명령 toggle-nav(왼쪽 메뉴가 펼침 — 셸 전체는 shellWiring.test),
 *    좁은 화면의 더보기 계정 영역에는 없음
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNavCollapsedForTest } from "@/hooks/useNavCollapsed";
import { resetNavWidthForTest } from "@/hooks/useNavWidth";
import { SHELL_COMMAND_EVENT, WIDE_SHELL_MEDIA } from "@/lib/shellCommands";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => ({ auth: { logout: vi.fn() } }));
vi.mock("@/lib/api", () => api);

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/macro", useRouter: () => router }));

import { ReadModeProvider } from "../ReadMode";
import { AccountBox } from "../AccountBox";
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
  vi.unstubAllGlobals();
  window.localStorage.clear();
  resetNavCollapsedForTest();
  resetNavWidthForTest();
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
    expect(alert.textContent).toBe("주의: 로그아웃 실패 — 서버에 닿지 못했습니다");
    expect(alert.getAttribute("title")).toBe("로그아웃 실패 — 서버에 닿지 못했습니다");
    expect(alert.closest('[role="menu"]')).toBeNull();
    expect(alert.parentElement).toBe(trigger.parentElement);
    // 한 줄로 줄임 — 상단바 새로고침 안내와 같은 폭(빵부스러기 자리를 덜 먹게), 결과 낱말은 말줄임 밖이고 사유만 말줄임(QA-547 후속)
    expect(alert.className.split(/\s+/)).toEqual(expect.arrayContaining(["max-w-40", "xl:max-w-72"]));
    expect(alert.querySelector(".text-ellipsis")?.textContent).toBe(" — 서버에 닿지 못했습니다");
    expect(router.push).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    api.auth.logout.mockResolvedValue(undefined);
    fireEvent.click(within(open(trigger)).getByRole("menuitem", { name: "로그아웃" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/login"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // QA-547: 로그아웃 실패 글(상단바 새로고침 안내와 같은 폭 160·288px)을 감싼 상자가 'min-w-0 shrink'라 글 폭을 그대로 차지해, 떠 있는 동안 빵부스러기 자리가
  // 1440에서 412 → 116px, 새로고침 안내와 함께 뜨면 1280에서 0px까지 줄었습니다(QA 스택 확인 — Shell.test의 같은 번호 시험이 빵부스러기 쪽을 봄).
  // 실패 글이 떠 있는 동안 상자가 모자란 폭을 먼저 내주고(shrink-100000), 글이 없으면 단추 폭 그대로(shrink-0 — 늘 하한을 두면 단추가 밀림).
  // 처음 고칠 때 둔 정한 하한(min-w-[38px] — 단추 + 사이)은 검토 뒤 내용의 하한(아이콘 + 결과 낱말 + 사이 + 단추)으로 바꿨습니다(아래 시험).
  // 수정 전(재현 커밋에서는 it.fails)에는 글이 있든 없든 'min-w-0 shrink'였습니다.
  it("실패 글이 떠 있는 동안 감싼 상자는 모자란 폭을 먼저 내주고, 글이 없으면 단추 폭 그대로 (QA-547)", async () => {
    api.auth.logout.mockRejectedValue(new Error("서버에 닿지 못했습니다"));
    const trigger = renderMenu(MEMBER);
    const quiet = (trigger.parentElement as HTMLElement).className.split(/\s+/);
    expect(quiet).toContain("shrink-0");
    expect(quiet).not.toContain("min-w-[38px]");
    expect(quiet).not.toContain("min-w-0");

    fireEvent.click(within(open(trigger)).getByRole("menuitem", { name: "로그아웃" }));
    const alert = await screen.findByRole("alert");
    const box = (alert.parentElement as HTMLElement).className.split(/\s+/);
    expect(box).toContain("shrink-100000");
    expect(box).not.toContain("min-w-0");
  });

  // QA-547 후속(검토): 상단바 폭 배분을 고치며(빵부스러기 nav가 글 폭을 주장 — Shell.test 같은 번호) 로그아웃 실패 글도 내용의 하한까지만 줄게 합니다.
  // 결과 낱말 '로그아웃하지 못했습니다'(11자, 약 130px)를 하한으로 두면 새로고침 실패 글과 함께 뜰 때 1280에서 상단바가 넘치므로, 새로고침 실패와 같은
  // 짧은 결과 낱말 '로그아웃 실패 — 사유'로 쓰고 결과 낱말은 말줄임 밖에 둡니다(사유만 말줄임). 감싼 상자는 정한 38px가 아니라 그 내용의 하한까지 줍니다.
  // 수정 전(재현 커밋에서는 it.fails)에는 글이 '로그아웃하지 못했습니다 — 사유' 한 덩이 말줄임, 감싼 상자가 'min-w-[38px] shrink-[100]'이었습니다.
  it("실패 글은 짧은 결과 낱말 먼저('로그아웃 실패 — 사유') — 결과 낱말은 말줄임 밖이고, 감싼 상자는 내용의 하한까지만 준다 (QA-547)", async () => {
    api.auth.logout.mockRejectedValue(new Error("서버에 닿지 못했습니다"));
    const trigger = renderMenu(MEMBER);
    fireEvent.click(within(open(trigger)).getByRole("menuitem", { name: "로그아웃" }));
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("title")).toBe("로그아웃 실패 — 서버에 닿지 못했습니다");
    const head = within(alert).getByText("로그아웃 실패");
    expect(head.className.split(/\s+/)).toContain("whitespace-nowrap");
    expect(head.closest(".truncate, .text-ellipsis")).toBeNull();
    const box = (alert.parentElement as HTMLElement).className.split(/\s+/);
    expect(box).toContain("shrink-100000");
    expect(box).not.toContain("min-w-[38px]");
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
    // 이름 툴팁은 넓은 화면에서만 열린다(QA-554)
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === WIDE_SHELL_MEDIA, media: query }) as MediaQueryList);
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
    vi.unstubAllGlobals();

    // 좁은 화면(여는 단추가 숨음)에서는 툴팁을 열지 않는다
    const narrow = renderMenu(MEMBER);
    act(() => narrow.focus());
    expect(screen.queryByRole("tooltip")).toBeNull();
    cleanup();

    // 이메일이 없으면(데모) 사람 아이콘 — 빈 원이나 빈 글자가 없다
    const demo = renderMenu(DEMO);
    expect(demo.textContent).toBe("");
    expect(demo.querySelector("svg")).not.toBeNull();
  });

  it("메뉴 항목 글은 text·text-2만 — 계정 줄의 역할 글·폭 단계의 px 글도 text-2(가리킨 항목 바탕 surface-3 위 text-3 금지)", () => {
    const menu = open(renderMenu(MEMBER));
    for (const item of [...within(menu).getAllByRole("menuitem"), ...within(menu).getAllByRole("menuitemradio")]) {
      for (const node of [item, ...item.querySelectorAll("*")]) {
        const classes = (node.getAttribute("class") ?? "").split(/\s+/);
        expect(classes.some((name) => ["text-text-3", "text-accent", "text-danger", "text-neutral"].includes(name))).toBe(false);
      }
    }
    expect(within(menu).getByText("무료 회원").className.split(/\s+/)).toContain("text-text-2");
  });
});

describe("왼쪽 메뉴 폭(작업대 P3 추가 — 손잡이를 끌지 않는 포인터 수단)", () => {
  const group = (menu: HTMLElement) => within(menu).getByRole("group", { name: "왼쪽 메뉴 폭" });
  const radios = (menu: HTMLElement) => within(menu).getAllByRole("menuitemradio");
  const checked = (menu: HTMLElement) =>
    radios(menu)
      .filter((item) => item.getAttribute("aria-checked") === "true")
      .map((item) => item.textContent);
  /** 셸 명령을 받아 적습니다 — 받을 때의 저장된 폭과 함께(폭을 먼저 바꾼 뒤 보내는지). */
  function recordCommands() {
    const received: { detail: unknown; storedWidth: string | null }[] = [];
    const listener = (event: Event) =>
      received.push({ detail: (event as CustomEvent).detail, storedWidth: window.localStorage.getItem("shell.navWidth") });
    window.addEventListener(SHELL_COMMAND_EVENT, listener);
    return { received, stop: () => window.removeEventListener(SHELL_COMMAND_EVENT, listener) };
  }

  it("누가 보든 이름 있는 묶음 '왼쪽 메뉴 폭' — 좁게 206px · 기본 220px · 넓게 272px(menuitemradio), 저장값이 없으면 기본", () => {
    for (const user of [MEMBER, LOCAL_OWNER, DEMO]) {
      const menu = open(renderMenu(user));
      expect(within(group(menu)).getAllByRole("menuitemradio").map((item) => item.textContent), user.email ?? "demo").toEqual([
        "좁게 206px",
        "기본 220px",
        "넓게 272px",
      ]);
      expect(checked(menu)).toEqual(["기본 220px"]);
      // 고른 항목은 색이 아닌 체크 아이콘으로도 가림
      expect(radios(menu).map((item) => item.querySelectorAll("svg").length)).toEqual([0, 1, 0]);
      cleanup();
    }
  });

  it("자리는 단축키 도움말 다음·로그아웃 앞(구분선으로 나눔) — 항목이 아닌 글(읽기 모드·빌드 정보)은 그대로 설명 칸", () => {
    const menu = open(renderMenu(MEMBER));
    const help = within(menu).getByRole("menuitem", { name: "단축키 도움말" });
    const logout = within(menu).getByRole("menuitem", { name: "로그아웃" });
    const box = group(menu);
    expect(help.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(box.compareDocumentPosition(logout) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 단축키 도움말 · 구분선 · 이름표(묶음의 이름 — 항목 아님) · 묶음 · 구분선 · 로그아웃
    const label = within(menu).getByText("왼쪽 메뉴 폭");
    expect(box.getAttribute("aria-labelledby")).toBe(label.id);
    expect(label.hasAttribute("role")).toBe(false);
    expect(label.previousElementSibling?.getAttribute("role")).toBe("separator");
    expect(label.previousElementSibling?.previousElementSibling).toBe(help);
    expect(label.nextElementSibling).toBe(box);
    expect(box.nextElementSibling?.getAttribute("role")).toBe("separator");
    expect(box.nextElementSibling?.nextElementSibling).toBe(logout);
    expect(descriptionText(menu)).toMatch(/^읽기 모드: auto/);
  });

  it("고른 항목은 기억한 펼친 폭과 같은 단계 — 접혀 있어도 펼 때의 폭, 끌어서 정한 폭(250, 넓게를 내리기 전의 280)이면 없음, 하한을 올리기 전의 190·200은 206(좁게)", () => {
    const cases: [Record<string, string>, string[]][] = [
      [{ "shell.navWidth": "272" }, ["넓게 272px"]],
      [{ "shell.navWidth": "250" }, []],
      [{ "shell.navWidth": "280" }, []],
      [{ "shell.navWidth": "190" }, ["좁게 206px"]],
      [{ "shell.navWidth": "200" }, ["좁게 206px"]],
      [{ "shell.navWidth": "220", "shell.navCollapsed": "1" }, ["기본 220px"]],
    ];
    for (const [stored, expected] of cases) {
      for (const [key, value] of Object.entries(stored)) window.localStorage.setItem(key, value);
      resetNavWidthForTest();
      resetNavCollapsedForTest();
      expect(checked(open(renderMenu(MEMBER))), JSON.stringify(stored)).toEqual(expected);
      cleanup();
      window.localStorage.clear();
    }
  });

  it("펼친 동안 고르면 그 폭을 저장하고 셸 명령은 보내지 않는다 — 메뉴는 닫히고 포커스는 여는 단추로, 다시 열면 그 단계가 골라져 있음", async () => {
    const commands = recordCommands();
    try {
      const trigger = renderMenu(MEMBER);
      fireEvent.click(within(open(trigger)).getByRole("menuitemradio", { name: "넓게 272px" }));
      expect(window.localStorage.getItem("shell.navWidth")).toBe("272");
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(trigger));
      expect(commands.received).toEqual([]);
      expect(checked(open(trigger))).toEqual(["넓게 272px"]);
    } finally {
      commands.stop();
    }
  });

  it("접힌 동안 고르면 폭을 먼저 저장한 뒤 셸 명령 toggle-nav를 한 번 보낸다(왼쪽 메뉴가 받아 펼침) — 이미 고른 단계를 골라도", async () => {
    window.localStorage.setItem("shell.navCollapsed", "1");
    const commands = recordCommands();
    try {
      const trigger = renderMenu(MEMBER);
      fireEvent.click(within(open(trigger)).getByRole("menuitemradio", { name: "좁게 206px" }));
      expect(commands.received).toEqual([{ detail: "toggle-nav", storedWidth: "206" }]);
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

      // 왼쪽 메뉴가 없어 접힘이 그대로인 이 시험에서는, 이미 고른 단계(좁게)를 다시 골라도 펼치러 신호를 보냄
      fireEvent.click(within(open(trigger)).getByRole("menuitemradio", { name: "좁게 206px" }));
      expect(commands.received).toEqual([
        { detail: "toggle-nav", storedWidth: "206" },
        { detail: "toggle-nav", storedWidth: "206" },
      ]);
    } finally {
      commands.stop();
    }
  });

  it("좁은 화면의 더보기 계정 영역(AccountBox)에는 없다 — 계정 메뉴 전체가 넓은 화면 전용(감싼 상자 hidden lg:flex)", () => {
    render(<AccountBox user={MEMBER} />);
    expect(screen.queryByText("왼쪽 메뉴 폭")).toBeNull();
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    cleanup();
    const trigger = renderMenu(MEMBER);
    expect((trigger.parentElement as HTMLElement).className.split(/\s+/)).toEqual(expect.arrayContaining(["hidden", "lg:flex"]));
  });
});
