/**
 * QA-555: 넓은 화면 왼쪽 나무 메뉴는 메뉴(nav)만 스크롤 상자이고 맨 아래 접기 영역은 그 밖이라, 낮은 창에서 메뉴 끝 쪽의 지금 칸이 메뉴 아래에 가려진 채
 * 열릴 수 있습니다(QA 스택 1024x600 /krx — 고친 배치를 페이지에 얹어 잼: 지금 칸 '파생·투기세력(KRX)' 560~592px, 메뉴 보이는 끝 551px).
 * hooks/useScrollNavActive가 그릴 때와 주소·접힘·넓은 화면 여부가 바뀔 때, 메뉴 높이가 줄어 지금 칸이 가려질 때 메뉴의 scrollTop만 옮겨 그 칸을
 * 보이게 하는지 봅니다(shell/SideNav를 그대로 그림).
 *
 * jsdom은 배치를 계산하지 않으므로 사각형을 정해 둡니다(SubNavScrollQa510.test와 같은 방식 — 여기서는 getBoundingClientRect·clientHeight):
 * 메뉴(nav)는 화면 위 48px에서 보이는 높이 503px, 칸은 글 이름별 위치(높이 32px). 메뉴의 scrollTop은 jsdom이 기억합니다.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SideNav } from "@/components/shell/SideNav";
import { resetNavCollapsedForTest } from "@/hooks/useNavCollapsed";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";
import type { SessionUser } from "@/lib/types";

const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };

const NAV_TOP = 48;
const NAV_HEIGHT = 503;
/** 메뉴의 보이는 높이 — 창 높이를 바꾸는 시험만 고칩니다. */
let navHeight = NAV_HEIGHT;
/** 칸의 화면 위치(위 끝 px) — 글 이름으로 정합니다. 여기 없는 요소는 0 사각형. */
let rowTops: Record<string, number> = {};
/** false면 배치 전(사각형 0)처럼 굽니다. */
let laidOut = true;

function rect(top: number, height: number): DOMRect {
  return { x: 0, y: top, top, left: 0, right: 220, bottom: top + height, width: 220, height, toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
  laidOut = true;
  rowTops = {};
  navHeight = NAV_HEIGHT;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (!laidOut) return rect(0, 0);
    if (this.tagName === "NAV") return rect(NAV_TOP, navHeight);
    const top = rowTops[this.textContent ?? ""];
    return top === undefined ? rect(0, 0) : rect(top, 32);
  });
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return laidOut && this.tagName === "NAV" ? navHeight : 0;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  resetNavCollapsedForTest();
});

const menu = () => screen.getByRole("navigation", { name: "주 메뉴" });

describe("QA-555 — 왼쪽 나무 메뉴가 지금 칸을 메뉴 안으로 스크롤한다(메뉴의 scrollTop만)", () => {
  it("메뉴 끝 쪽의 지금 칸(/krx — 마지막 aria-current)이 메뉴 아래에 가려지면 그 칸 아래가 여백 16px 안쪽에 오게 스크롤해 둔다", () => {
    // 탭 칸 '더보기'(aria-current=true)는 위에 보이고, 가장 깊은 지금 칸 'KRX'(page)가 메뉴 보이는 끝(551px) 아래
    rowTops = { 더보기: 240, "파생·투기세력(KRX)": 560 };
    render(<SideNav pathname="/krx" user={MEMBER} />);
    expect(screen.getByRole("link", { name: "파생·투기세력(KRX)" }).getAttribute("aria-current")).toBe("page");
    // (560 − 48) + 32 + 16 − 503
    expect(menu().scrollTop).toBe(57);
  });

  it("지금 칸이 다 보이면 그대로 — 같은 주소로 다시 그릴 때는 사람이 굴려 둔 메뉴를 되돌리지 않는다", () => {
    rowTops = { 더보기: 240, 알림: 272 };
    const { rerender } = render(<SideNav pathname="/alerts" user={MEMBER} />);
    expect(menu().scrollTop).toBe(0);
    menu().scrollTop = 120;
    rerender(<SideNav pathname="/alerts" user={MEMBER} />);
    expect(menu().scrollTop).toBe(120);
  });

  it("주소가 바뀌면 다시 본다 — 위로 가려진 칸은 그 칸 위가 여백 16px 안쪽에 오게", () => {
    rowTops = { 더보기: 240, 알림: 272 };
    const { rerender } = render(<SideNav pathname="/alerts" user={MEMBER} />);
    menu().scrollTop = 200;
    // 굴려 둔 메뉴에서 '내 계정'이 메뉴 위 끝(48px)보다 위(30px)에 가려진 채 그 화면으로 옮김 — 내용 안 위치 30 − 48 + 200 = 182
    rowTops = { 더보기: 0, "내 계정": 30 };
    rerender(<SideNav pathname="/account" user={MEMBER} />);
    expect(menu().scrollTop).toBe(166);
  });

  it("배치 전(사각형·보이는 높이 0 — 좁은 화면에서 메뉴가 숨음)에는 아무것도 하지 않고, 창 스크롤을 건드리는 scrollIntoView는 쓰지 않는다", () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    laidOut = false;
    render(<SideNav pathname="/krx" user={MEMBER} />);
    expect(menu().scrollTop).toBe(0);
    cleanup();

    laidOut = true;
    rowTops = { 더보기: 240, "파생·투기세력(KRX)": 560 };
    render(<SideNav pathname="/krx" user={MEMBER} />);
    expect(menu().scrollTop).toBe(57);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  // QA-555 후속(검토): 훅이 그릴 때와 주소·접힘이 바뀔 때만 돌아, 좁은 폭(lg 미만 — 메뉴가 display:none이라 아무것도 하지 않음)에서 연 화면을 넓은
  // 화면으로 바꾸거나 창 높이를 줄이면 다시 보지 않았습니다 — 메뉴 끝 쪽의 지금 칸이 메뉴 아래에 가려진 채 남았습니다(tip 8b7524ab 정적 하네스 —
  // 낮은 창 20건, 예: /info/mechanism 1024x420 칸 아래 끝 530 대 메뉴 보이는 끝 371, /admin/users 1440x500 462 대 451).
  // 수정 전(재현 커밋에서는 it.fails)에는 넓혀도·높이를 줄여도 메뉴 scrollTop이 0 그대로였습니다(기대 57·160).
  it("좁은 폭에서 연 뒤 넓은 화면(lg 이상)으로 바뀌면 그 그리기에서 지금 칸을 다시 본다 (QA-555)", () => {
    let wide = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        return wide && query === WIDE_SHELL_MEDIA;
      },
      media: query,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }));
    laidOut = false;
    rowTops = { 더보기: 240, "파생·투기세력(KRX)": 560 };
    render(<SideNav pathname="/krx" user={MEMBER} />);
    expect(menu().scrollTop).toBe(0);

    // 창을 넓힘 — 메뉴가 보이고(배치됨) 폭 신호가 바뀜
    laidOut = true;
    act(() => {
      wide = true;
      listeners.forEach((listener) => listener());
    });
    // (560 − 48) + 32 + 16 − 503
    expect(menu().scrollTop).toBe(57);
  });

  it("창 높이가 줄어 보이던 지금 칸이 가려지면 다시 보인다 — 사람이 굴려 가려 둔 칸은 그대로 (QA-555)", () => {
    const observers: Array<() => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observers.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const resize = (height: number) =>
      act(() => {
        navHeight = height;
        observers.forEach((callback) => callback());
      });
    rowTops = { 더보기: 240, "파생·투기세력(KRX)": 460 };
    render(<SideNav pathname="/krx" user={MEMBER} />);
    // 503px 메뉴에서는 다 보임(칸 아래 끝 460 + 32 − 48 = 444)
    expect(menu().scrollTop).toBe(0);
    resize(300);
    // (460 − 48) + 32 + 16 − 300
    expect(menu().scrollTop).toBe(160);
    cleanup();

    // 사람이 굴려 지금 칸을 위로 가려 둔 뒤 높이가 바뀌면 그대로 둔다(되돌리지 않음)
    observers.length = 0;
    navHeight = NAV_HEIGHT;
    rowTops = { 더보기: 240, "파생·투기세력(KRX)": 460 };
    render(<SideNav pathname="/krx" user={MEMBER} />);
    // 450px 굴림 — 칸의 화면 위치도 그만큼 올라감(460 − 450 = 10, 메뉴 위 끝 48보다 위)
    menu().scrollTop = 450;
    rowTops = { 더보기: 240 - 450, "파생·투기세력(KRX)": 10 };
    resize(300);
    expect(menu().scrollTop).toBe(450);
  });
});
