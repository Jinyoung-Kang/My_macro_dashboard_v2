/**
 * QA-593: 넓은 화면 상단바 빵부스러기의 가운데 칸이 0px까지 줄어도 그 링크가 Tab 순서에 남았습니다.
 *
 * 새로고침 실패와 로그아웃 실패가 함께 뜬 1280 /paper/us/holdings(QA 스택 — 쿠키 세션 운영자, 장 시계 칩이 '애프터마켓'·'휴장 (주말)'일 때)에서
 * nav 120.4px, 칸 폭 '모의매매' 56 · '미국'(링크 /paper/us) 0 · '보유·체결' 40px — 본문 건너뛰기에서 Tab 한 번이면 이 0폭 링크에 포커스가 갔고(4px 세로 링만),
 * 글은 '모의매매 › › 보…'로 구분 기호 둘이 붙었습니다. 주말 칩이면 로그인 없는 운영자의 새로고침 실패 하나로도 '한국'(/paper/kr)이 0px이었습니다.
 * nav 하한(112px — QA-547 후속)은 첫 칸 + 마지막 칸만 담고 가운데 칸(min-w-0)에는 하한이 없습니다. 가운데 칸에 하한을 두면 1024 주말 두 안내 상태에서
 * 상단바가 9px 넘쳐, 가운데 칸 글이 24px(첫 글자와 말줄임) 아래로 줄면 그 칸을 접습니다(그리지 않음 — 0폭 링크가 Tab 순서·낭독에서 빠지고 '›'도 하나).
 * 접힌 뒤에는 nav가 접힐 때의 너비 + 36px(가운데 칸 하나의 자리) 이상이 되어야 다시 펼칩니다(접고 펴기를 오가며 깜박이지 않게).
 *
 * jsdom은 배치를 재지 않으므로 ResizeObserver 대역(관찰을 시작할 때와 resize()에서 콜백을 바로 부름)과 nav·가운데 칸 링크의 폭(getBoundingClientRect)을
 * 고정해 봅니다. 기본 대역(vitest.setup — 콜백 없음, 폭 0)에서는 접지 않습니다(Shell·BreadcrumbsEntity 시험 그대로).
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/types";
import { Breadcrumbs } from "../Breadcrumbs";

const LOCAL_OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: true };
const PATH = "/paper/us/holdings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** nav와 가운데 칸 링크('미국' → /paper/us)의 폭을 흉내 냅니다 — 값을 바꾸고 resize()를 부르면 ResizeObserver 콜백이 돕니다. */
function stubLayout(initial: { nav: number; middle: number }) {
  const size = { ...initial };
  const callbacks = new Set<() => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
      }
      observe() {
        callbacks.add(this.callback);
        this.callback();
      }
      unobserve() {}
      disconnect() {
        callbacks.delete(this.callback);
      }
    },
  );
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = this.matches('nav[aria-label="현재 위치"]') ? size.nav : this.matches('a[href="/paper/us"]') ? size.middle : null;
    return width === null ? original.call(this) : ({ width, height: 24, top: 0, left: 0, right: width, bottom: 24, x: 0, y: 0 } as DOMRect);
  });
  return {
    resize: (next: { nav?: number; middle?: number }) =>
      act(() => {
        Object.assign(size, next);
        for (const callback of [...callbacks]) callback();
      }),
  };
}

const crumbs = () => screen.getByRole("navigation", { name: "현재 위치" });
const items = () => within(crumbs()).getAllByRole("listitem").map((item) => item.textContent);
const separators = () => (crumbs().textContent?.match(/›/g) ?? []).length;

describe("빵부스러기 가운데 칸 — 하한(24px) 아래면 접는다 (QA-593)", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 '미국' 링크가 0px인 채 남아(세 칸, '›' 둘) Tab 순서에 있었습니다.
  it.fails("가운데 칸 링크가 0px(nav 120px)이면 그 칸을 그리지 않는다 — '미국' 링크가 없고 '›'가 하나, 마지막 칸은 지금 화면 그대로", () => {
    stubLayout({ nav: 120, middle: 0 });
    render(<Breadcrumbs pathname={PATH} user={LOCAL_OWNER} />);
    expect(within(crumbs()).queryByRole("link", { name: "미국" })).toBeNull();
    expect(items()).toEqual(["모의매매", "›보유·체결"]);
    expect(separators()).toBe(1);
    expect(within(crumbs()).getByText("보유·체결").getAttribute("aria-current")).toBe("page");
  });

  it("가운데 칸 링크가 하한 이상(28px)이면 세 칸 그대로 — '미국' 링크가 남는다", () => {
    stubLayout({ nav: 120, middle: 28 });
    render(<Breadcrumbs pathname={PATH} user={LOCAL_OWNER} />);
    expect(within(crumbs()).getByRole("link", { name: "미국" }).getAttribute("href")).toBe("/paper/us");
    expect(items()).toEqual(["모의매매", "›미국", "›보유·체결"]);
  });

  // 수정 전(재현 커밋에서는 it.fails)에는 처음부터 접히지 않았습니다.
  it.fails("접힌 뒤에는 nav가 접힐 때의 너비 + 36px 이상이 되어야 다시 펼친다 — 그보다 덜 넓어지면 접힌 채(깜박이지 않게)", () => {
    const layout = stubLayout({ nav: 120, middle: 0 });
    render(<Breadcrumbs pathname={PATH} user={LOCAL_OWNER} />);
    expect(within(crumbs()).queryByRole("link", { name: "미국" })).toBeNull();
    layout.resize({ nav: 150, middle: 30 });
    expect(within(crumbs()).queryByRole("link", { name: "미국" })).toBeNull();
    layout.resize({ nav: 156, middle: 36 });
    expect(within(crumbs()).getByRole("link", { name: "미국" })).toBeTruthy();
    expect(separators()).toBe(2);
    // 펼친 뒤 가운데 칸이 하한 이상이면 그대로 펼친 채
    layout.resize({ nav: 160, middle: 40 });
    expect(items()).toEqual(["모의매매", "›미국", "›보유·체결"]);
  });

  it("재기 전이거나 nav 너비가 0이면(좁은 화면에서 숨김·배치 없는 대역) 접지 않는다", () => {
    stubLayout({ nav: 0, middle: 0 });
    render(<Breadcrumbs pathname={PATH} user={LOCAL_OWNER} />);
    expect(within(crumbs()).getByRole("link", { name: "미국" })).toBeTruthy();
    expect(separators()).toBe(2);
  });
});
