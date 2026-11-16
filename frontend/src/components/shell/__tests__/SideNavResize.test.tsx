/**
 * 넓은 화면 왼쪽 메뉴의 가변 폭(작업대 P3 추가 — 실행 명세 §5 '가변 폭 왼쪽 메뉴', ADR 0042 2026-11-16 사용자 결정): 오른쪽 경계선의 폭 손잡이(shell/SideNav +
 * hooks/useNavResize). 숫자·규칙은 lib/__tests__/navWidth.test, 기억은 hooks/__tests__/useNavWidth.test가 보고, 여기서는 그린 손잡이를 봅니다.
 *
 * - 접근성: role=separator '왼쪽 메뉴 폭', 세로, 주 메뉴를 가리킴, 값 180~320·지금 폭·px 읽는 글(접혔으면 하한과 '접힘…'), Tab 순서는 접기 단추 다음, 포커스 링,
 *   글 없음(12px 하한과 무관), 고대비에서 가리킨·잡은 동안 Highlight 윤곽선.
 * - 키보드: ←·→ 16px(Shift 64)·Home·End는 바로 저장, Enter는 접기·펼치기(기억한 폭으로), 받은 키는 기본 동작을 막고 받지 않는 키는 그대로.
 * - 두 번 누르기: 접기·펼치기. 끌고 바로 한 번 더 눌러 생긴 두 번 누르기는 받지 않음.
 * - 끌기(jsdom 포인터 이벤트 — setPointerCapture는 jsdom에 없어 대역): 3px 문턱, 한 프레임에 한 번(requestAnimationFrame 대역), 끄는 동안은 저장하지 않고
 *   놓을 때 한 번, 140px 아래로 끌면 레일(끌기 전 폭 기억), 레일을 끌어내면 끈 폭으로 펼침, 놓을 때 기다리던 프레임 반영, pointercancel·lostpointercapture도
 *   끝냄, 잡은 동안 html의 data-nav-resizing(커서·글 고르기 — globals.css)과 툴팁 막기, 끄는 도중 사라지면 표지를 떼고 그린 폭을 저장.
 * - 전환: 접힘이 바뀌는 때(단추·[·두 번 누르기·Enter·끌기 중 문턱)만 motion-safe:transition-[width](150ms) — 처음 그릴 때·끄는 동안·키 걸음에는 없음
 *   (단추로 접고 편 직후 끌기를 시작해도 그때 끔).
 * - 저장소가 던져도 기본 폭으로 그려지고 끌기·키가 동작.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNavCollapsedForTest } from "@/hooks/useNavCollapsed";
import { NAV_RESIZING_ATTR } from "@/hooks/useNavResize";
import { resetNavWidthForTest } from "@/hooks/useNavWidth";
import { WIDE_SHELL_MEDIA, sendShellCommand } from "@/lib/shellCommands";
import type { SessionUser } from "@/lib/types";

import { SideNav } from "../SideNav";

const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };

/** requestAnimationFrame 대역 — 부른 처리기를 모아 두었다가 runFrames로 한꺼번에 돌립니다(한 프레임에 한 번인지 셈). */
let frames: FrameRequestCallback[] = [];
let capture: ReturnType<typeof vi.fn>;

beforeEach(() => {
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  capture = vi.fn();
  // jsdom 29에는 setPointerCapture가 없습니다(hasPointerCapture·releasePointerCapture는 vitest.setup 대역).
  Object.defineProperty(Element.prototype, "setPointerCapture", { value: capture, configurable: true, writable: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (Element.prototype as Partial<Element>).setPointerCapture;
  window.localStorage.clear();
  resetNavCollapsedForTest();
  resetNavWidthForTest();
  document.documentElement.removeAttribute(NAV_RESIZING_ATTR);
});

function runFrames() {
  act(() => {
    const pending = frames.splice(0);
    pending.forEach((callback) => callback(0));
  });
}

function stubWide() {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === WIDE_SHELL_MEDIA, media: query }) as MediaQueryList);
}

const handle = () => screen.getByRole("separator", { name: "왼쪽 메뉴 폭" });
const mainNav = () => screen.getByRole("navigation", { name: "주 메뉴" });
const box = () => mainNav().closest("[data-shell-sidenav]") as HTMLElement;
const toggleButton = () => screen.getByRole("button", { name: "왼쪽 메뉴 접기" });
const classes = (element: Element) => element.className.split(/\s+/);
const hasMotion = () => classes(box()).includes("motion-safe:transition-[width]");
const value = () => ({ now: handle().getAttribute("aria-valuenow"), text: handle().getAttribute("aria-valuetext") });

const down = (clientX: number, pointerId = 1) => fireEvent.pointerDown(handle(), { pointerId, clientX, button: 0, isPrimary: true });
const move = (clientX: number, pointerId = 1) => fireEvent.pointerMove(handle(), { pointerId, clientX, isPrimary: true });
const up = (clientX: number, pointerId = 1) => fireEvent.pointerUp(handle(), { pointerId, clientX, button: 0, isPrimary: true });

describe("접근성", () => {
  it("role=separator '왼쪽 메뉴 폭' — 세로, 주 메뉴를 가리키고, 값 180~320·지금 폭 220·'220px', 포커스 가능", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    const separator = handle();
    expect(separator.getAttribute("aria-orientation")).toBe("vertical");
    expect(separator.getAttribute("aria-controls")).toBe(mainNav().id);
    expect(separator.getAttribute("aria-valuemin")).toBe("180");
    expect(separator.getAttribute("aria-valuemax")).toBe("320");
    expect(value()).toEqual({ now: "220", text: "220px" });
    expect(separator.tabIndex).toBe(0);
    // 글이 없어 12px 하한과 상관없고, 이름은 aria-label이 나름
    expect(separator.textContent).toBe("");
  });

  it("왼쪽 메뉴 상자 안 맨 끝 — Tab 순서는 접기 단추 다음(본문 앞), 메뉴 상자는 손잡이의 위치 기준(relative)", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    expect(box().lastElementChild).toBe(handle());
    expect(toggleButton().compareDocumentPosition(handle()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(classes(box())).toContain("relative");
  });

  it("모양 — 경계선에 걸친 8px(-right-1 w-2), col-resize, touch-none, 포커스 링(FOCUS_RING), 고대비에서 가리킨·잡은 동안 Highlight 윤곽선", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    expect(classes(handle())).toEqual(
      expect.arrayContaining([
        "absolute", "inset-y-0", "-right-1", "w-2", "cursor-col-resize", "touch-none", "select-none",
        "focus-visible:outline-2", "focus-visible:outline-offset-2", "focus-visible:outline-focus",
        "hover:before:bg-border-strong", "data-[dragging]:before:bg-accent",
        "forced-colors:hover:outline-[Highlight]", "forced-colors:data-[dragging]:outline-[Highlight]",
      ]),
    );
  });

  it("접혔으면 값은 하한 180(가장 왼쪽 자리)이고 읽는 글은 접힘과 펼 때의 폭", () => {
    window.localStorage.setItem("shell.navCollapsed", "1");
    window.localStorage.setItem("shell.navWidth", "260");
    render(<SideNav pathname="/macro" user={MEMBER} />);
    expect(value()).toEqual({ now: "180", text: "접힘(아이콘 레일), 펼치면 260px" });
  });
});

describe("키보드", () => {
  it("←·→ 16px, Shift와 함께 64px, Home 180·End 320 — 바로 저장하고 기본 동작(스크롤)을 막는다. 폭 걸음에는 전환이 없다", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    expect(fireEvent.keyDown(handle(), { key: "ArrowRight" })).toBe(false);
    expect(value().now).toBe("236");
    expect(window.localStorage.getItem("shell.navWidth")).toBe("236");
    fireEvent.keyDown(handle(), { key: "ArrowRight", shiftKey: true });
    expect(value().now).toBe("300");
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    expect(value()).toEqual({ now: "284", text: "284px" });
    expect(fireEvent.keyDown(handle(), { key: "Home" })).toBe(false);
    expect(value().now).toBe("180");
    // 하한에서 ←는 그대로 — 받기는 함(스크롤하지 않음)
    expect(fireEvent.keyDown(handle(), { key: "ArrowLeft" })).toBe(false);
    expect(value().now).toBe("180");
    fireEvent.keyDown(handle(), { key: "End" });
    expect(value().now).toBe("320");
    expect(window.localStorage.getItem("shell.navWidth")).toBe("320");
    expect(hasMotion()).toBe(false);
  });

  it("받지 않는 키(↑·↓·Ctrl+←)는 기본 동작을 막지 않고 폭도 그대로", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    expect(fireEvent.keyDown(handle(), { key: "ArrowUp" })).toBe(true);
    expect(fireEvent.keyDown(handle(), { key: "ArrowDown" })).toBe(true);
    expect(fireEvent.keyDown(handle(), { key: "ArrowLeft", ctrlKey: true })).toBe(true);
    expect(value().now).toBe("220");
  });

  it("Enter는 접기·펼치기 — 접으면 접기 단추가 눌림, 펴면 기억한 폭으로. 접힌 동안 →는 펴고 End는 최대 폭으로. 포커스는 손잡이에 남는다", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    act(() => handle().focus());
    expect(fireEvent.keyDown(handle(), { key: "Enter" })).toBe(false);
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    expect(value()).toEqual({ now: "180", text: "접힘(아이콘 레일), 펼치면 236px" });
    expect(window.localStorage.getItem("shell.navCollapsed")).toBe("1");
    expect(document.activeElement).toBe(handle());

    fireEvent.keyDown(handle(), { key: "Enter" });
    expect(toggleButton().getAttribute("aria-pressed")).toBe("false");
    expect(value().now).toBe("236");

    fireEvent.keyDown(handle(), { key: "Enter" });
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(toggleButton().getAttribute("aria-pressed")).toBe("false");
    expect(value().now).toBe("236");
    fireEvent.keyDown(handle(), { key: "Enter" });
    fireEvent.keyDown(handle(), { key: "End" });
    expect(value().now).toBe("320");
    expect(window.localStorage.getItem("shell.navWidth")).toBe("320");
  });
});

describe("접기·펼치기의 전환(150ms)", () => {
  it("처음 그릴 때는 전환이 없다 — 저장값(접힘 '1')으로 시작해도 메뉴가 움직이지 않음", () => {
    window.localStorage.setItem("shell.navCollapsed", "1");
    render(<SideNav pathname="/macro" user={MEMBER} />);
    expect(hasMotion()).toBe(false);
  });

  it("단추·[(셸 명령)·Enter로 접힘이 바뀔 때 전환을 켜고, 키 걸음에서는 끈다 — 전환 클래스는 모두 motion-safe(움직임 줄이기면 없음)", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    fireEvent.click(toggleButton());
    expect(hasMotion()).toBe(true);
    expect(classes(box())).toContain("motion-safe:duration-150");
    // 움직임 줄이기면 없음 — 상자의 전환·지속 클래스는 모두 motion-safe: 변형
    expect(classes(box()).filter((name) => /transition|duration/.test(name)).every((name) => name.startsWith("motion-safe:"))).toBe(true);

    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(hasMotion()).toBe(true); // 접힌 동안 →는 펼침(접힘이 바뀜)
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(hasMotion()).toBe(false);

    act(() => sendShellCommand("toggle-nav"));
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    expect(hasMotion()).toBe(true);
    fireEvent.keyDown(handle(), { key: "Enter" });
    expect(toggleButton().getAttribute("aria-pressed")).toBe("false");
    expect(hasMotion()).toBe(true);
  });
});

describe("두 번 누르기", () => {
  it("접기·펼치기(전환 켬) — 펴면 기억한 폭으로", () => {
    window.localStorage.setItem("shell.navWidth", "250");
    render(<SideNav pathname="/macro" user={MEMBER} />);
    fireEvent.doubleClick(handle());
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    expect(hasMotion()).toBe(true);
    fireEvent.doubleClick(handle());
    expect(toggleButton().getAttribute("aria-pressed")).toBe("false");
    expect(value().now).toBe("250");
  });

  it("끌고 바로 한 번 더 눌러 생긴 두 번 누르기는 받지 않는다 — 움직이지 않은 두 번은 받음", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    down(220);
    move(260);
    up(260);
    down(260);
    up(260);
    fireEvent.doubleClick(handle());
    expect(toggleButton().getAttribute("aria-pressed")).toBe("false");
    expect(value().now).toBe("260");

    down(260);
    up(260);
    down(261);
    up(261);
    fireEvent.doubleClick(handle());
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
  });
});

describe("끌기", () => {
  it("잡으면 포인터를 붙잡고(setPointerCapture) html에 끄는 표지 — 3px 안의 움직임은 폭을 바꾸지 않는다", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    down(220, 7);
    expect(capture).toHaveBeenCalledWith(7);
    expect(document.documentElement.hasAttribute(NAV_RESIZING_ATTR)).toBe(true);
    expect(handle().hasAttribute("data-dragging")).toBe(true);
    move(222, 7);
    expect(frames).toHaveLength(0);
    up(222, 7);
    expect(value().now).toBe("220");
    expect(document.documentElement.hasAttribute(NAV_RESIZING_ATTR)).toBe(false);
    expect(handle().hasAttribute("data-dragging")).toBe(false);
    expect(window.localStorage.getItem("shell.navWidth")).toBeNull();
  });

  it("끈 만큼 폭이 따라오고(한 프레임에 한 번) 끄는 동안은 저장하지 않으며 전환도 없다 — 놓을 때 한 번 저장", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    down(220);
    move(260);
    move(275);
    expect(frames).toHaveLength(1);
    expect(value().now).toBe("220");
    runFrames();
    expect(value().now).toBe("275");
    expect(hasMotion()).toBe(false);
    expect(window.localStorage.getItem("shell.navWidth")).toBeNull();
    move(500);
    runFrames();
    expect(value().now).toBe("320");
    up(500);
    expect(window.localStorage.getItem("shell.navWidth")).toBe("320");
    expect(window.localStorage.getItem("shell.navCollapsed")).toBe("0");
  });

  it("단추로 접고 편 뒤(전환 켜짐) 끌기를 시작하면 전환을 끈다 — 끄는 동안 폭은 포인터를 바로 따라감", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    fireEvent.click(toggleButton());
    fireEvent.click(toggleButton());
    expect(hasMotion()).toBe(true);
    down(220);
    move(260);
    expect(hasMotion()).toBe(false);
    runFrames();
    expect(value().now).toBe("260");
    expect(hasMotion()).toBe(false);
    up(260);
    expect(hasMotion()).toBe(false);
  });

  it("끄는 도중 메뉴가 사라지면(로그아웃 등) html의 끄는 표지를 떼고 그때까지 그린 폭을 저장한다", () => {
    const { unmount } = render(<SideNav pathname="/macro" user={MEMBER} />);
    down(220);
    move(260);
    runFrames();
    move(280);
    expect(frames).toHaveLength(1);
    expect(document.documentElement.hasAttribute(NAV_RESIZING_ATTR)).toBe(true);
    expect(window.localStorage.getItem("shell.navWidth")).toBeNull();
    unmount();
    expect(document.documentElement.hasAttribute(NAV_RESIZING_ATTR)).toBe(false);
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
    // 기다리던 프레임(280)은 그리지 않았으므로 마지막으로 그린 260
    expect(window.localStorage.getItem("shell.navWidth")).toBe("260");
    expect(window.localStorage.getItem("shell.navCollapsed")).toBe("0");
  });

  it("놓을 때 기다리던 프레임은 바로 반영한다(프레임 처리기를 기다리지 않음)", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    down(220);
    move(200);
    expect(frames).toHaveLength(1);
    up(200);
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
    expect(value().now).toBe("200");
    expect(window.localStorage.getItem("shell.navWidth")).toBe("200");
  });

  it("140px 아래로 끌면 레일로 접히고(그 바뀜에만 150ms 전환) 펼친 폭은 끌기 전 값 — 다시 끌어내면 펼침", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    window.localStorage.setItem("shell.navWidth", "260");
    render(<SideNav pathname="/macro" user={MEMBER} />);
    down(260);
    move(170);
    runFrames();
    expect(value().now).toBe("180");
    expect(toggleButton().getAttribute("aria-pressed")).toBe("false");
    move(120);
    runFrames();
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    expect(value()).toEqual({ now: "180", text: "접힘(아이콘 레일), 펼치면 260px" });
    expect(hasMotion()).toBe(true);
    act(() => vi.advanceTimersByTime(150));
    expect(hasMotion()).toBe(false);
    // 끄는 동안이라 아직 저장하지 않음
    expect(window.localStorage.getItem("shell.navCollapsed")).toBeNull();

    move(150);
    runFrames();
    expect(toggleButton().getAttribute("aria-pressed")).toBe("false");
    expect(value().now).toBe("180");
    expect(hasMotion()).toBe(true);
    move(60);
    runFrames();
    up(60);
    expect(window.localStorage.getItem("shell.navCollapsed")).toBe("1");
    expect(window.localStorage.getItem("shell.navWidth")).toBe("260");

    // 접기 단추로 펴면 끌기 전 폭(260)으로
    fireEvent.click(toggleButton());
    expect(value().now).toBe("260");
  });

  it("레일(48px)을 140px 너머로 끌어내면 끈 폭으로 펼친다 — 140 아래에서는 레일 그대로", () => {
    window.localStorage.setItem("shell.navCollapsed", "1");
    window.localStorage.setItem("shell.navWidth", "230");
    render(<SideNav pathname="/macro" user={MEMBER} />);
    down(48);
    move(120);
    runFrames();
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    move(290);
    runFrames();
    expect(toggleButton().getAttribute("aria-pressed")).toBe("false");
    expect(value().now).toBe("290");
    expect(hasMotion()).toBe(true);
    up(290);
    expect(window.localStorage.getItem("shell.navCollapsed")).toBe("0");
    expect(window.localStorage.getItem("shell.navWidth")).toBe("290");
  });

  it("pointercancel·lostpointercapture도 끌기를 끝내고 그때까지의 폭을 저장한다 — 다른 포인터의 이벤트는 무시", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    down(220, 1);
    move(250, 2);
    expect(frames).toHaveLength(0);
    move(250, 1);
    fireEvent.pointerCancel(handle(), { pointerId: 1, isPrimary: true });
    expect(value().now).toBe("250");
    expect(window.localStorage.getItem("shell.navWidth")).toBe("250");
    expect(document.documentElement.hasAttribute(NAV_RESIZING_ATTR)).toBe(false);

    down(250, 3);
    move(270, 3);
    fireEvent.lostPointerCapture(handle(), { pointerId: 3, isPrimary: true });
    expect(value().now).toBe("270");
    expect(handle().hasAttribute("data-dragging")).toBe(false);
    // 같은 끌기의 pointerup이 뒤에 와도 아무 일 없음
    up(400, 3);
    expect(value().now).toBe("270");
  });

  it("주 단추가 아닌 누름(오른쪽 단추)·주 포인터가 아닌 것은 잡지 않는다", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    fireEvent.pointerDown(handle(), { pointerId: 1, clientX: 220, button: 2, isPrimary: true });
    fireEvent.pointerDown(handle(), { pointerId: 2, clientX: 220, button: 0, isPrimary: false });
    expect(handle().hasAttribute("data-dragging")).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });

  it("끄는 동안에는 레일의 탭 이름·접기 단추 툴팁이 열리지 않는다 — 놓으면 다시 열림", () => {
    stubWide();
    window.localStorage.setItem("shell.navCollapsed", "1");
    render(<SideNav pathname="/macro" user={MEMBER} />);
    const home = within(mainNav()).getByRole("link", { name: "홈" });
    down(48);
    act(() => home.focus());
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => toggleButton().focus());
    expect(screen.queryByRole("tooltip")).toBeNull();
    up(48);
    act(() => home.focus());
    expect(screen.getByRole("tooltip").textContent).toBe("홈");
  });
});

describe("저장소를 못 쓸 때", () => {
  it("읽기·쓰기가 던져도 기본 폭으로 그려지고 끌기·키가 이 창 안에서 동작한다", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("막힌 저장소");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("막힌 저장소");
    });
    render(<SideNav pathname="/macro" user={MEMBER} />);
    expect(value().now).toBe("220");
    down(220);
    move(280);
    up(280);
    expect(value().now).toBe("280");
    fireEvent.keyDown(handle(), { key: "Enter" });
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggleButton());
    expect(value().now).toBe("280");
  });
});
