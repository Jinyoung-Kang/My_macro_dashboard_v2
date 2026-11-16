/**
 * 넓은 화면 왼쪽 메뉴의 가변 폭(작업대 P3 추가 — 실행 명세 §5 '가변 폭 왼쪽 메뉴', ADR 0042 2026-11-16 사용자 결정): 오른쪽 경계선의 폭 손잡이(shell/SideNav +
 * hooks/useNavResize). 숫자·규칙은 lib/__tests__/navWidth.test, 기억은 hooks/__tests__/useNavWidth.test가 보고, 여기서는 그린 손잡이를 봅니다.
 *
 * - 접근성: role=separator '왼쪽 메뉴 폭', 세로, 주 메뉴를 가리킴, 값 206~320·지금 폭·px 읽는 글(접혔으면 하한과 '접힘…'), Tab 순서는 접기 단추 다음, 포커스 링,
 *   글 없음(12px 하한과 무관), 고대비에서 가리킨·잡은 동안 Highlight 윤곽선, 고대비에서 ::before 숨김(QA-602 — 클래스를 Tailwind로 컴파일해 확인).
 * - 키보드: ←·→ 16px(Shift 64)·Home·End는 바로 저장, Enter는 접기·펼치기(기억한 폭으로 — 누르고 있는 반복은 받지 않음), 받은 키는 기본 동작을 막고
 *   받지 않는 키는 그대로.
 * - 두 번 누르기: 접기·펼치기. 끌고 바로 한 번 더 눌러 생긴 두 번 누르기는 받지 않음.
 * - 끌기(jsdom 포인터 이벤트 — setPointerCapture는 jsdom에 없어 대역): 3px 문턱, 한 프레임에 한 번(requestAnimationFrame 대역), 끄는 동안은 저장하지 않고
 *   놓을 때 한 번, 140px 아래로 끌면 레일(끌기 전 폭 기억), 레일을 끌어내면 끈 폭으로 펼침, 같은 끌기에서 되돌아가는 문턱은 16px 여유(손떨림),
 *   놓을 때 기다리던 프레임 반영, pointercancel·lostpointercapture도 끝냄, 잡은 동안 html의 data-nav-resizing(커서·글 고르기 — globals.css)과
 *   툴팁 막기, 끄는 도중 사라지면 표지를 떼고 그린 폭을 저장.
 * - 전환: 접힘이 바뀌는 때(단추·[·두 번 누르기·Enter·끌기 중 레일로 접힘)만 motion-safe:transition-[width](150ms) — 처음 그릴 때·끄는 동안·키 걸음·
 *   끌어내 펼 때에는 없음(단추로 접고 편 직후 끌기를 시작해도 그때 끔).
 * - 저장소가 던져도 기본 폭으로 그려지고 끌기·키가 동작.
 * - 차트 폭 잡아 두기 신호(QA-601 — lib/shellResize): 끌기 문턱을 넘은 뒤 끝날 때까지와 접힘이 바뀐 뒤 전환 유지 시간(NAV_MOTION_HOLD_MS) 동안만 켜짐 —
 *   키 걸음·다른 탭의 폭 바뀜·움직임 줄이기의 접고 펴기에는 켜지 않고, 끄는 도중 레일로 접혀 켠 전환의 타이머가 끝나도 끌기가 이어지면 켜진 채.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import postcss, { type AtRule, type Rule } from "postcss";
import { compile } from "tailwindcss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNavCollapsedForTest } from "@/hooks/useNavCollapsed";
import { NAV_RESIZING_ATTR } from "@/hooks/useNavResize";
import { resetNavWidthForTest } from "@/hooks/useNavWidth";
import { NAV_MOTION_HOLD_MS, NAV_MOTION_MS } from "@/lib/navWidth";
import { isShellResizing, resetShellResizingForTest } from "@/lib/shellResize";
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
  resetShellResizingForTest();
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

/**
 * 넓은 화면 여부를 바꿀 수 있는 matchMedia 대역 — change 처리기(useWideShell)를 모아 두었다가, 돌려준 함수로 값을 바꾸고 act 안에서 알립니다
 * (stubWide에는 addEventListener가 없어 바뀜을 알릴 수 없음).
 */
function stubWideSwitch(initial: boolean): (next: boolean) => void {
  let wide = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        get matches() {
          return query === WIDE_SHELL_MEDIA && wide;
        },
        media: query,
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      }) as unknown as MediaQueryList,
  );
  return (next: boolean) => {
    wide = next;
    act(() => listeners.forEach((listener) => listener()));
  };
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
  it("role=separator '왼쪽 메뉴 폭' — 세로, 주 메뉴를 가리키고, 값 206~320·지금 폭 220·'220px', 포커스 가능", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    const separator = handle();
    expect(separator.getAttribute("aria-orientation")).toBe("vertical");
    expect(separator.getAttribute("aria-controls")).toBe(mainNav().id);
    expect(separator.getAttribute("aria-valuemin")).toBe("206");
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

  it("모양 — 경계선부터 밖으로 8px(-right-2 w-2 — 메뉴 스크롤 막대를 덮지 않음), 선은 띠 왼쪽(경계선 자리), col-resize, touch-none, 포커스 링(FOCUS_RING), 고대비에서 가리킨·잡은 동안 Highlight 윤곽선", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    // 위치 기준은 상자의 테두리 안쪽 가장자리 — right:-8px·폭 8px이면 띠의 왼쪽 끝이 경계선(1px)의 왼쪽 끝이고, 그 안쪽(메뉴의 세로 스크롤 막대)에는 걸치지 않음
    expect(classes(handle())).not.toContain("-right-1");
    expect(classes(handle())).toEqual(
      expect.arrayContaining([
        "absolute", "inset-y-0", "-right-2", "w-2", "cursor-col-resize", "touch-none", "select-none",
        "before:left-0", "before:w-0.5",
        "focus-visible:outline-2", "focus-visible:outline-offset-2", "focus-visible:outline-focus",
        "hover:before:bg-border-strong", "data-[dragging]:before:bg-accent",
        "forced-colors:hover:outline-[Highlight]", "forced-colors:data-[dragging]:outline-[Highlight]",
      ]),
    );
  });

  // QA-602: 고대비(forced-colors)에서 가리킨·잡은 동안·포커스 때 ::before의 불투명 바탕(border-strong·accent)이 Canvas로 강제되어 메뉴 경계선(219px —
  // 메뉴 높이 전체)과 손잡이 윤곽선의 왼쪽 띠를 덮었습니다(QA 스택 1440 /macro — 가리킴 219~220 Canvas, Highlight는 225~226 한 줄). bg-transparent는
  // 명시도에서 hover:before:… 규칙에 져서 효과가 없으므로 고대비에서는 ::before를 숨깁니다. 재현 커밋에서는 it.fails였습니다(실패 값:
  // AssertionError: expected [ 'absolute', 'inset-y-0', …(26) ] to include 'forced-colors:before:hidden').
  it("QA-602: 고대비에서는 ::before(가리킴·잡음·포커스 선)를 숨긴다 — 경계선과 Highlight 윤곽선을 덮지 않음", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    expect(classes(handle())).toContain("forced-colors:before:hidden");
  });

  // QA-602 후속(검토 지적): 위 시험은 클래스 글자만 봐서, 그 변형이 CSS로 만들어지지 않거나 같은 손잡이의 다른 ::before display 규칙에 덮여도
  // 통과했습니다(예: hover:before:flex는 :hover 때문에 명시도가 (0,2,1)이라 고대비 규칙 (0,1,1)을 이김). 그래서
  // 그린 손잡이의 클래스를 이 저장소와 같은 Tailwind(4.3.5)로 컴파일해, ::before의 display를 정하는 규칙이 고대비 미디어 안의 none 하나뿐인지
  // 봅니다. 바탕색 토큰(border-strong 등)은 globals.css의 테마에 있어 여기서는 만들어지지 않지만 display와는 무관합니다.
  it("QA-602: 손잡이 클래스를 컴파일하면 ::before의 display 규칙은 @media (forced-colors: active) 안의 none 하나뿐", async () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    const compiler = await compile("@tailwind utilities;");
    const found: string[] = [];
    postcss.parse(compiler.build(classes(handle()))).walkDecls("display", (decl) => {
      const rule = decl.parent;
      if (rule?.type !== "rule" || !(rule as Rule).selector.includes("::before")) return;
      const at: string[] = [];
      for (let node = rule.parent; node && node.type !== "root"; node = node.parent) {
        if (node.type === "atrule") at.unshift(`@${(node as AtRule).name} ${(node as AtRule).params}`);
      }
      found.push([...at, `${(rule as Rule).selector} { display: ${decl.value} }`].join(" "));
    });
    expect(found).toEqual(["@media (forced-colors: active) .forced-colors\\:before\\:hidden::before { display: none }"]);
  });

  it("접혔으면 값은 하한 206(가장 왼쪽 자리)이고 읽는 글은 접힘과 펼 때의 폭", () => {
    window.localStorage.setItem("shell.navCollapsed", "1");
    window.localStorage.setItem("shell.navWidth", "260");
    render(<SideNav pathname="/macro" user={MEMBER} />);
    expect(value()).toEqual({ now: "206", text: "접힘(아이콘 레일), 펼치면 260px" });
  });
});

describe("키보드", () => {
  it("←·→ 16px, Shift와 함께 64px, Home 206·End 320 — 바로 저장하고 기본 동작(스크롤)을 막는다. 폭 걸음에는 전환이 없다", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    expect(fireEvent.keyDown(handle(), { key: "ArrowRight" })).toBe(false);
    expect(value().now).toBe("236");
    expect(window.localStorage.getItem("shell.navWidth")).toBe("236");
    fireEvent.keyDown(handle(), { key: "ArrowRight", shiftKey: true });
    expect(value().now).toBe("300");
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    expect(value()).toEqual({ now: "284", text: "284px" });
    expect(fireEvent.keyDown(handle(), { key: "Home" })).toBe(false);
    expect(value().now).toBe("206");
    expect(window.localStorage.getItem("shell.navWidth")).toBe("206");
    // 하한에서 ←는 그대로 — 받기는 함(스크롤하지 않음)
    expect(fireEvent.keyDown(handle(), { key: "ArrowLeft" })).toBe(false);
    expect(value().now).toBe("206");
    fireEvent.keyDown(handle(), { key: "End" });
    expect(value().now).toBe("320");
    expect(window.localStorage.getItem("shell.navWidth")).toBe("320");
    expect(hasMotion()).toBe(false);
  });

  it("누르고 있는 Enter의 반복은 접고 펴지 않는다(기본 동작은 막음) — 누르고 있는 →는 폭을 이어서 넓힘", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    expect(fireEvent.keyDown(handle(), { key: "Enter" })).toBe(false);
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    for (let index = 0; index < 4; index += 1) {
      expect(fireEvent.keyDown(handle(), { key: "Enter", repeat: true })).toBe(false);
      expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    }
    expect(window.localStorage.getItem("shell.navCollapsed")).toBe("1");

    // 접힌 동안 누르고 있는 →: 처음 한 번에 펴고 반복마다 16px
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    fireEvent.keyDown(handle(), { key: "ArrowRight", repeat: true });
    fireEvent.keyDown(handle(), { key: "ArrowRight", repeat: true });
    expect(toggleButton().getAttribute("aria-pressed")).toBe("false");
    expect(value().now).toBe("252");
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
    expect(value()).toEqual({ now: "206", text: "접힘(아이콘 레일), 펼치면 236px" });
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

  it("접힘이 바뀐 뒤 200ms(전환 + 여유)가 지나면 전환을 뗀다 — 그 뒤 다른 탭이 폭만 바꾼 storage 이벤트는 전환 없이 그림", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(<SideNav pathname="/macro" user={MEMBER} />);
    fireEvent.click(toggleButton());
    fireEvent.click(toggleButton());
    expect(hasMotion()).toBe(true);
    act(() => vi.advanceTimersByTime(NAV_MOTION_HOLD_MS));
    expect(hasMotion()).toBe(false);
    act(() => {
      window.localStorage.setItem("shell.navWidth", "300");
      window.dispatchEvent(new StorageEvent("storage", { key: "shell.navWidth", newValue: "300" }));
    });
    expect(value().now).toBe("300");
    expect(hasMotion()).toBe(false);
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
    move(210);
    expect(frames).toHaveLength(1);
    up(210);
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
    expect(value().now).toBe("210");
    expect(window.localStorage.getItem("shell.navWidth")).toBe("210");
  });

  it("140px 아래로 끌면 레일로 접히고(그 바뀜에만 150ms 전환) 펼친 폭은 끌기 전 값 — 같은 끌기에서 156px 너머로 다시 끌어내면 펼침", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    window.localStorage.setItem("shell.navWidth", "260");
    render(<SideNav pathname="/macro" user={MEMBER} />);
    down(260);
    move(170);
    runFrames();
    expect(value().now).toBe("206");
    expect(toggleButton().getAttribute("aria-pressed")).toBe("false");
    move(120);
    runFrames();
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    expect(value()).toEqual({ now: "206", text: "접힘(아이콘 레일), 펼치면 260px" });
    expect(hasMotion()).toBe(true);
    // 전환(150ms)이 끝날 때까지는 붙여 두고 여유(50ms) 뒤에 뗌
    act(() => vi.advanceTimersByTime(NAV_MOTION_MS));
    expect(hasMotion()).toBe(true);
    act(() => vi.advanceTimersByTime(NAV_MOTION_HOLD_MS - NAV_MOTION_MS));
    expect(hasMotion()).toBe(false);
    // 끄는 동안이라 아직 저장하지 않음
    expect(window.localStorage.getItem("shell.navCollapsed")).toBeNull();

    // 되돌림 여유 — 잡을 때의 펼침으로 돌아가려면 156 이상
    move(150);
    runFrames();
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    move(156);
    runFrames();
    expect(toggleButton().getAttribute("aria-pressed")).toBe("false");
    expect(value().now).toBe("206");
    // 끌어내 펼 때는 전환 없이 포인터를 바로 따라감
    expect(hasMotion()).toBe(false);
    move(60);
    runFrames();
    up(60);
    expect(window.localStorage.getItem("shell.navCollapsed")).toBe("1");
    expect(window.localStorage.getItem("shell.navWidth")).toBe("260");

    // 접기 단추로 펴면 끌기 전 폭(260)으로
    fireEvent.click(toggleButton());
    expect(value().now).toBe("260");
  });

  it("레일(48px)을 140px 너머로 끌어내면 끈 폭으로 바로 펼친다(전환 없이 포인터를 따라감) — 140 아래에서는 레일 그대로", () => {
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
    expect(hasMotion()).toBe(false);
    // 끌어내 편 뒤 되돌아가 접는 문턱은 124 — 130에서는 펼친 채 206
    move(130);
    runFrames();
    expect(toggleButton().getAttribute("aria-pressed")).toBe("false");
    expect(value().now).toBe("206");
    move(290);
    runFrames();
    up(290);
    expect(window.localStorage.getItem("shell.navCollapsed")).toBe("0");
    expect(window.localStorage.getItem("shell.navWidth")).toBe("290");
  });

  it("손가락으로 끌어 접어도(손잡이가 포커스를 받지 않음) 사라지는 하위 칸에 있던 포커스는 접기 단추로 옮긴다 — 문서(body)로 빠지지 않음", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    const leaf = within(within(mainNav()).getByRole("list", { name: "시장 화면" })).getAllByRole("link")[0];
    act(() => leaf.focus());
    down(220);
    move(100);
    runFrames();
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    expect(leaf.isConnected).toBe(false);
    expect(document.activeElement).toBe(toggleButton());
    up(100);
    expect(document.activeElement).toBe(toggleButton());
  });

  it("문턱 근처의 손떨림(139·141을 번갈아)은 한 번만 접는다 — 접힘이 프레임마다 바뀌지 않음", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    const pressed: (string | null)[] = [];
    down(220);
    for (const x of [141, 139, 141, 139, 141, 139, 141]) {
      move(x);
      runFrames();
      pressed.push(toggleButton().getAttribute("aria-pressed"));
    }
    expect(pressed).toEqual(["false", "true", "true", "true", "true", "true", "true"]);
    up(141);
    expect(window.localStorage.getItem("shell.navCollapsed")).toBe("1");
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

  // QA-603: QA 스택 1440 /macro에서 손잡이를 잡고 30px 끈 뒤 창을 900으로 줄이면 표지(data-nav-resizing — col-resize·글 고르기 끔)가 좁은 화면 전체에
  // 남았고, 숨은 손잡이가 포인터 잡기를 유지해 좁은 화면의 움직임으로 폭이 바뀌어 저장됐습니다(x=60에서 놓으면 레일로 접혀 navCollapsed '1').
  // 재현 커밋에서는 it.fails였습니다(실패 값: AssertionError: expected true to be false — 좁아진 뒤에도 html의 표지가 남음. 놓은 뒤 navCollapsed '1'·
  // navWidth '220'·aria-valuenow 200).
  it("QA-603: 끄는 도중 넓은 화면이 좁아지면(lg 아래) 끌기를 끝낸다 — 표지를 떼고 그때까지의 폭을 저장, 그 뒤 움직임은 숨은 메뉴를 바꾸지 않음", () => {
    const setWide = stubWideSwitch(true);
    const release = vi.spyOn(Element.prototype, "releasePointerCapture");
    render(<SideNav pathname="/macro" user={MEMBER} />);
    down(224);
    move(254);
    runFrames();
    expect(value().now).toBe("250");
    expect(document.documentElement.hasAttribute(NAV_RESIZING_ATTR)).toBe(true);
    expect(isShellResizing()).toBe(true);

    setWide(false);
    expect(document.documentElement.hasAttribute(NAV_RESIZING_ATTR)).toBe(false);
    expect(handle().hasAttribute("data-dragging")).toBe(false);
    expect(release).toHaveBeenCalledWith(1);
    expect(window.localStorage.getItem("shell.navWidth")).toBe("250");
    // 차트 폭 잡아 두기 신호(QA-601)도 끔 — 좁은 화면의 차트가 앞 폭에 묶이지 않음
    expect(isShellResizing()).toBe(false);

    move(60);
    runFrames();
    up(60);
    expect(window.localStorage.getItem("shell.navCollapsed")).not.toBe("1");
    expect(window.localStorage.getItem("shell.navWidth")).toBe("250");
    expect(value().now).toBe("250");
    expect(toggleButton().getAttribute("aria-pressed")).toBe("false");

    // 다시 넓어지면 끌기가 그대로 됨
    setWide(true);
    down(250);
    move(270);
    runFrames();
    up(270);
    expect(window.localStorage.getItem("shell.navWidth")).toBe("270");
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

describe("차트 폭 잡아 두기 신호(QA-601 — lib/shellResize)", () => {
  it("끌기 — 문턱(3px) 전에는 꺼짐, 넘으면 첫 프레임 앞에 켜지고 놓으면 꺼짐", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    down(220);
    expect(isShellResizing()).toBe(false);
    move(222);
    expect(isShellResizing()).toBe(false);
    move(260);
    expect(frames).toHaveLength(1);
    expect(isShellResizing()).toBe(true);
    runFrames();
    expect(isShellResizing()).toBe(true);
    up(260);
    expect(isShellResizing()).toBe(false);
    // 움직이지 않은 누름은 켜지 않음
    down(260);
    up(260);
    expect(isShellResizing()).toBe(false);
  });

  it("pointercancel·lostpointercapture·끄는 도중 사라짐(언마운트)도 끈다", () => {
    const { unmount } = render(<SideNav pathname="/macro" user={MEMBER} />);
    down(220, 1);
    move(250, 1);
    expect(isShellResizing()).toBe(true);
    fireEvent.pointerCancel(handle(), { pointerId: 1, isPrimary: true });
    expect(isShellResizing()).toBe(false);

    down(250, 3);
    move(270, 3);
    expect(isShellResizing()).toBe(true);
    fireEvent.lostPointerCapture(handle(), { pointerId: 3, isPrimary: true });
    expect(isShellResizing()).toBe(false);

    down(270, 4);
    move(300, 4);
    runFrames();
    expect(isShellResizing()).toBe(true);
    unmount();
    expect(isShellResizing()).toBe(false);
  });

  it("단추·[(셸 명령)·Enter·두 번 누르기로 접고 펼 때는 전환 유지 시간(NAV_MOTION_HOLD_MS) 동안만 켜짐", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(<SideNav pathname="/macro" user={MEMBER} />);
    const flips: [string, () => void][] = [
      ["단추", () => fireEvent.click(toggleButton())],
      ["[", () => act(() => sendShellCommand("toggle-nav"))],
      ["Enter", () => fireEvent.keyDown(handle(), { key: "Enter" })],
      ["두 번 누르기", () => fireEvent.doubleClick(handle())],
    ];
    for (const [name, flip] of flips) {
      const pressed = toggleButton().getAttribute("aria-pressed");
      flip();
      expect([name, toggleButton().getAttribute("aria-pressed")]).not.toEqual([name, pressed]);
      expect([name, isShellResizing()]).toEqual([name, true]);
      act(() => vi.advanceTimersByTime(NAV_MOTION_HOLD_MS - 1));
      expect([name, isShellResizing()]).toEqual([name, true]);
      act(() => vi.advanceTimersByTime(1));
      expect([name, isShellResizing()]).toEqual([name, false]);
    }
  });

  it("움직임 줄이기면 접고 펼 때 켜지 않는다(전환 없이 폭이 한 번에 바뀜) — 끌기는 그대로 켬", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)", media: query }) as MediaQueryList);
    render(<SideNav pathname="/macro" user={MEMBER} />);
    fireEvent.click(toggleButton());
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    expect(isShellResizing()).toBe(false);
    fireEvent.keyDown(handle(), { key: "Enter" });
    expect(isShellResizing()).toBe(false);
    down(220);
    move(260);
    expect(isShellResizing()).toBe(true);
    // 끄는 도중 레일로 접혀도 끌기 원천으로 켜진 채, 놓으면 바로 꺼짐(전환 원천은 켜지 않았음)
    move(100);
    runFrames();
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    up(100);
    expect(isShellResizing()).toBe(false);
  });

  it("키 걸음(←·→·Home·End)·다른 탭의 폭 바뀜은 켜지 않는다 — 전환 중 키 걸음은 전환과 함께 끔", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
      fireEvent.keyDown(handle(), { key });
      expect([key, isShellResizing()]).toEqual([key, false]);
    }
    act(() => {
      window.localStorage.setItem("shell.navWidth", "250");
      window.dispatchEvent(new StorageEvent("storage", { key: "shell.navWidth", newValue: "250" }));
    });
    expect(value().now).toBe("250");
    expect(isShellResizing()).toBe(false);

    fireEvent.click(toggleButton());
    expect(isShellResizing()).toBe(true);
    fireEvent.keyDown(handle(), { key: "ArrowRight" }); // 접힌 동안 →는 펼침(접힘이 바뀜 — 전환)
    expect(isShellResizing()).toBe(true);
    fireEvent.keyDown(handle(), { key: "ArrowRight" }); // 폭 걸음 — 전환을 끔
    expect(hasMotion()).toBe(false);
    expect(isShellResizing()).toBe(false);
  });

  it("끄는 도중 레일로 접혀 켠 전환의 타이머가 끝나도 끌기가 이어지면 켜진 채 — 놓으면 꺼짐. 접히자마자 놓으면 전환이 끝날 때 꺼짐", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(<SideNav pathname="/macro" user={MEMBER} />);
    down(220);
    move(100);
    runFrames();
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    expect(hasMotion()).toBe(true);
    act(() => vi.advanceTimersByTime(NAV_MOTION_HOLD_MS));
    expect(hasMotion()).toBe(false);
    expect(isShellResizing()).toBe(true);
    move(90);
    runFrames();
    up(90);
    expect(isShellResizing()).toBe(false);

    // 레일에서 끌어내 펴고(전환 없음) 다시 접히자마자 놓음 — 전환이 끝날 때까지 켜진 채
    down(48);
    move(250);
    runFrames();
    expect(toggleButton().getAttribute("aria-pressed")).toBe("false");
    move(80);
    runFrames();
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    up(80);
    expect(isShellResizing()).toBe(true);
    act(() => vi.advanceTimersByTime(NAV_MOTION_HOLD_MS));
    expect(isShellResizing()).toBe(false);
  });
});
