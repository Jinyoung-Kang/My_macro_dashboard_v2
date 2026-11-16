/**
 * 셸 두 부분의 연결(작업대 P3 통합 — 실행 명세 §5, ADR 0042 결정 5). 배치 쪽(왼쪽 메뉴·레일·계정 메뉴)과 명령 팔레트 쪽(SearchCommand·단축키·도움말 창)은
 * 서로의 모듈을 가져오지 않고 셸 명령 신호(lib/shellCommands) 하나로만 이어집니다. 각 쪽 시험은 신호를 보내는지·받는지를 따로 봤고, 여기서는 셸 전체를
 * 그려 실제로 이어지는지 봅니다.
 *
 * - 넓은 화면: [ → 왼쪽 메뉴가 48px 레일로 접힘(셸 변수·하위 칸 사라짐·저장 '1'), 다시 [ → 펼침. 좁은 화면에서는 [가 아무것도 하지 않음(글자 그대로).
 * - 상단바의 팔레트 여는 단추(또는 Ctrl+K) → 명령 '왼쪽 메뉴 접기·펼치기' → 팔레트가 닫히고 포커스가 여는 단추로 돌아온 뒤 레일로 접힘. 레일에서도 단추·Ctrl+K가 그대로.
 * - 계정 메뉴 '단축키 도움말' → '단축키' 대화상자(넓은 화면이라 [ 줄이 있음), 닫으면 계정 메뉴 여는 단추로 포커스. ?도 같은 창을 엶.
 * - 덮개(팔레트·계정 메뉴·도움말 창) 안의 [는 메뉴를 접지 않음.
 * - 덮개 위의 Ctrl+K: 열린 계정 메뉴 안에서는 팔레트를 겹쳐 열지 않고, 도움말 창이 열려 있으면 그 창을 닫고 팔레트를 엶 — 고른 뒤 덮개가 남지 않음.
 * - 운영자 셸에서도 팔레트 안에는 '데이터 수동 새로고침'이 없음 — 그 단추는 상단바(팔레트 밖)에만(명세 §9-6, paletteNoWrites.test가 세 겹으로 고정).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNavCollapsedForTest } from "@/hooks/useNavCollapsed";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiPatch: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError, auth: { logout: vi.fn() } };
});
vi.mock("@/lib/api", () => api);

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/macro", useRouter: () => router }));

const signal = vi.hoisted(() => ({
  token: 0, reloadAll: () => {}, notifyUnauthorized: () => {}, requestRefresh: vi.fn(), collecting: false, message: null as string | null,
}));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { resetRecentEntitiesForTest } from "@/hooks/useRecentEntities";
import { Shell } from "../Shell";

const COOKIE_OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: false };

function stubWide(wide: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: wide && query === WIDE_SHELL_MEDIA,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

function renderShell() {
  return render(
    <Shell user={COOKIE_OWNER} readMode="auto" unread={0}>
      <p>대시보드 본문</p>
    </Shell>,
  );
}

const shellRoot = () => document.querySelector("[data-nav]") as HTMLElement;
// 덮개(팔레트·계정 메뉴·도움말 창)가 열린 동안 뒤 화면은 aria-hidden이라 hidden까지 찾습니다(접힘 상태를 덮개가 열린 채로도 봄).
const mainNav = () => screen.getByRole("navigation", { name: "주 메뉴", hidden: true });
const navToggle = () => screen.getByRole("button", { name: "왼쪽 메뉴 접기", hidden: true });
const paletteTrigger = () => screen.getByRole("button", { name: "종목·기관·지표·메뉴 검색" });
const accountTrigger = () => screen.getByRole("button", { name: "계정 메뉴" });
const palette = () => screen.queryByRole("dialog", { name: "통합 검색" });
const helpDialog = () => screen.queryByRole("dialog", { name: "단축키" });

/** 왼쪽 메뉴가 레일로 접혔는가 — 접기 단추·셸 뿌리(data-nav·셸 변수)·메뉴 폭·하위 칸이 모두 같은 상태를 말하는지 함께 봅니다. */
function expectCollapsed(collapsed: boolean) {
  expect(navToggle().getAttribute("aria-pressed")).toBe(String(collapsed));
  expect(shellRoot().getAttribute("data-nav")).toBe(collapsed ? "collapsed" : "expanded");
  expect(shellRoot().className.split(/\s+/)).toContain(collapsed ? "lg:[--shell-nav-w:48px]" : "lg:[--shell-nav-w:220px]");
  expect((mainNav().closest("aside") as HTMLElement).className.split(/\s+/)).toContain(collapsed ? "w-12" : "w-[220px]");
  if (collapsed) {
    expect(within(mainNav()).queryByRole("list", { name: "시장 화면", hidden: true })).toBeNull();
    expect(within(mainNav()).queryByRole("link", { name: "매크로 지표", hidden: true })).toBeNull();
  } else {
    expect(within(mainNav()).getByRole("list", { name: "시장 화면", hidden: true })).toBeTruthy();
  }
}

/** 본문(덮개 밖)에서 키 하나를 누릅니다. 돌려준 값이 false면 셸이 기본 동작을 막은 것(받아서 처리함). */
function pressInBody(key: string, init: Partial<KeyboardEventInit> = {}): boolean {
  const body = screen.getByText("대시보드 본문");
  return fireEvent.keyDown(body, { key, ...init });
}

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation(() => new Promise(() => {}));
  router.push.mockReset();
  signal.requestRefresh.mockReset();
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  resetNavCollapsedForTest();
  resetRecentEntitiesForTest();
});

describe("[ 키 → 왼쪽 메뉴", () => {
  it("넓은 화면에서 [를 누르면 왼쪽 메뉴가 48px 레일로 접히고(이 브라우저에 기억), 다시 누르면 펼친다", () => {
    stubWide(true);
    renderShell();
    expectCollapsed(false);

    expect(pressInBody("[", { code: "BracketLeft" })).toBe(false);
    expectCollapsed(true);
    expect(window.localStorage.getItem("shell.navCollapsed")).toBe("1");

    expect(pressInBody("[", { code: "BracketLeft" })).toBe(false);
    expectCollapsed(false);
    expect(window.localStorage.getItem("shell.navCollapsed")).toBe("0");
  });

  it("좁은 화면에서는 [가 아무것도 하지 않는다 — 기본 동작을 막지 않고 메뉴 상태·저장값도 그대로", () => {
    stubWide(false);
    renderShell();
    expect(pressInBody("[", { code: "BracketLeft" })).toBe(true);
    expectCollapsed(false);
    expect(window.localStorage.getItem("shell.navCollapsed")).toBeNull();
  });

  it("접힌 채 시작한 사람(저장값 '1')도 [로 펼친다 — 셸 뿌리와 왼쪽 메뉴가 같은 상태를 본다", () => {
    stubWide(true);
    window.localStorage.setItem("shell.navCollapsed", "1");
    renderShell();
    expectCollapsed(true);
    pressInBody("[");
    expectCollapsed(false);
  });
});

describe("명령 팔레트 → 왼쪽 메뉴", () => {
  it("상단바 여는 단추로 팔레트를 열어 '왼쪽 메뉴 접기·펼치기'를 고르면 팔레트가 닫히고 여는 단추로 포커스가 돌아온 뒤 레일로 접힌다", async () => {
    stubWide(true);
    renderShell();
    fireEvent.click(paletteTrigger());
    const dialog = palette() as HTMLElement;
    expect(dialog).toBeTruthy();
    // 팔레트 안의 [는 글자다 — 메뉴를 접지 않는다.
    const input = within(dialog).getByRole("combobox", { name: "검색어" });
    expect(fireEvent.keyDown(input, { key: "[", code: "BracketLeft" })).toBe(true);
    expectCollapsed(false);

    fireEvent.change(input, { target: { value: "메뉴 접기" } });
    const command = within(within(dialog).getByRole("group", { name: "명령" })).getByRole("option", { name: /왼쪽 메뉴 접기·펼치기/ });
    fireEvent.click(command);
    expect(palette()).toBeNull();
    await waitFor(() => expect(navToggle().getAttribute("aria-pressed")).toBe("true"));
    expectCollapsed(true);
    expect(document.activeElement).toBe(paletteTrigger());
    expect(router.push).not.toHaveBeenCalled();

    // 레일에서도 여는 단추와 Ctrl+K가 그대로 — 같은 명령을 키보드(Enter)로 골라 다시 편다.
    expect(fireEvent.keyDown(document.activeElement as HTMLElement, { key: "k", ctrlKey: true })).toBe(false);
    const again = palette() as HTMLElement;
    expect(again).toBeTruthy();
    fireEvent.change(within(again).getByRole("combobox", { name: "검색어" }), { target: { value: "[" } });
    expect(within(within(again).getByRole("group", { name: "명령" })).getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(within(again).getByRole("combobox", { name: "검색어" }), { key: "Enter" });
    expect(palette()).toBeNull();
    await waitFor(() => expect(navToggle().getAttribute("aria-pressed")).toBe("false"));
    expectCollapsed(false);
  });

  it("좁은 화면의 팔레트에는 '왼쪽 메뉴 접기·펼치기' 명령이 없다(왼쪽 메뉴가 보이지 않는 폭)", async () => {
    stubWide(false);
    renderShell();
    fireEvent.click(paletteTrigger());
    const dialog = palette() as HTMLElement;
    await act(async () => {});
    fireEvent.change(within(dialog).getByRole("combobox", { name: "검색어" }), { target: { value: "메뉴 접기" } });
    expect(within(dialog).queryByRole("group", { name: "명령" })).toBeNull();
  });
});

describe("계정 메뉴·? → 단축키 도움말", () => {
  it("계정 메뉴의 '단축키 도움말'을 고르면 메뉴가 닫히고 '단축키' 창이 열린다(넓은 화면이라 [ 줄이 있음) — 닫으면 계정 메뉴 여는 단추로 포커스", async () => {
    stubWide(true);
    renderShell();
    fireEvent.keyDown(accountTrigger(), { key: "Enter" });
    const menu = screen.getByRole("menu", { name: "계정 메뉴" });
    // 메뉴 안의 [는 메뉴가 씀 — 왼쪽 메뉴를 접지 않는다.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "[", code: "BracketLeft" });
    expect(navToggle().getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(within(menu).getByRole("menuitem", { name: "단축키 도움말" }));
    const help = await screen.findByRole("dialog", { name: "단축키" });
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(help.contains(document.activeElement)).toBe(true));
    expect(within(help).getByRole("cell", { name: "왼쪽 메뉴 접기·펼치기" })).toBeTruthy();

    // 도움말 창 안의 [도 왼쪽 메뉴를 접지 않는다.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "[", code: "BracketLeft" });
    expect(navToggle().getAttribute("aria-pressed")).toBe("false");

    fireEvent.keyDown(help, { key: "Escape" });
    expect(helpDialog()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(accountTrigger()));
  });

  it("?를 누르면 같은 '단축키' 창이 열린다 — 검색 자료는 읽지 않는다(닫힌 팔레트)", () => {
    stubWide(true);
    renderShell();
    const before = api.apiGetShared.mock.calls.map(([path]) => String(path));
    expect(pressInBody("?", { shiftKey: true })).toBe(false);
    expect(helpDialog()).toBeTruthy();
    const after = api.apiGetShared.mock.calls.map(([path]) => String(path));
    expect(after.slice(before.length).filter((path) => /overview|institutions|universe|symbols/.test(path))).toEqual([]);
  });
});

describe("덮개 위의 Ctrl+K — 팔레트를 겹쳐 열지 않는다", () => {
  it("계정 메뉴가 열린 채 Ctrl+K: 팔레트를 열지 않고(브라우저 기본 동작만 막음) 메뉴가 포커스를 그대로 가진다 — Esc로 닫은 뒤에는 연다", async () => {
    stubWide(true);
    renderShell();
    fireEvent.keyDown(accountTrigger(), { key: "Enter" });
    const menu = screen.getByRole("menu", { name: "계정 메뉴" });
    const focused = document.activeElement as HTMLElement;
    expect(menu.contains(focused)).toBe(true);

    expect(fireEvent.keyDown(focused, { key: "k", ctrlKey: true })).toBe(false);
    expect(palette()).toBeNull();
    expect(screen.getByRole("menu", { name: "계정 메뉴" })).toBe(menu);
    expect(document.activeElement).toBe(focused);

    fireEvent.keyDown(focused, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(accountTrigger()));
    expect(fireEvent.keyDown(accountTrigger(), { key: "k", ctrlKey: true })).toBe(false);
    expect(palette()).toBeTruthy();
  });

  it("단축키 도움말 창이 열린 채 Ctrl+K: 도움말을 닫고 팔레트를 연다 — 대상을 골라 옮긴 뒤 덮개가 남지 않고 뒤 화면이 막히지 않는다", async () => {
    stubWide(true);
    renderShell();
    expect(pressInBody("?", { shiftKey: true })).toBe(false);
    const help = helpDialog() as HTMLElement;
    await waitFor(() => expect(help.contains(document.activeElement)).toBe(true));

    expect(fireEvent.keyDown(document.activeElement as HTMLElement, { key: "k", ctrlKey: true })).toBe(false);
    const dialog = palette() as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(helpDialog()).toBeNull();
    const input = within(dialog).getByRole("combobox", { name: "검색어" });
    await waitFor(() => expect(document.activeElement).toBe(input));

    fireEvent.change(input, { target: { value: "순유동성" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(router.push).toHaveBeenCalledWith("/liquidity");
    expect(palette()).toBeNull();
    expect(helpDialog()).toBeNull();
    expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(0);
    await waitFor(() => expect(document.body.style.pointerEvents).toBe(""));
  });
});

describe("쓰기 동작은 팔레트 밖", () => {
  it("운영자 셸: 상단바에 '데이터 수동 새로고침' 단추가 있어도 팔레트 안에는 없고, '새로고침'을 쳐도 명령 결과가 없다", async () => {
    stubWide(true);
    renderShell();
    const refresh = screen.getByRole("button", { name: "데이터 수동 새로고침" });
    expect(refresh.closest("header")).not.toBeNull();

    fireEvent.click(paletteTrigger());
    const dialog = palette() as HTMLElement;
    await act(async () => {});
    fireEvent.change(within(dialog).getByRole("combobox", { name: "검색어" }), { target: { value: "새로고침" } });
    expect(within(dialog).queryByRole("button", { name: /새로고침/ })).toBeNull();
    expect(within(dialog).queryByRole("group", { name: "명령" })).toBeNull();
    expect(signal.requestRefresh).not.toHaveBeenCalled();
    expect(api.apiPost).not.toHaveBeenCalled();
  });
});
