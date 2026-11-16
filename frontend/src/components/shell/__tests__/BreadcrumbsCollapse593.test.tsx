/**
 * QA-593: 넓은 화면 상단바 빵부스러기의 가운데 칸이 0px까지 줄어도 그 링크가 Tab 순서에 남았습니다.
 *
 * 새로고침 실패와 로그아웃 실패가 함께 뜬 1280 /paper/us/holdings(QA 스택 — 쿠키 세션 운영자, 장 시계 칩이 '애프터마켓'·'휴장 (주말)'일 때)에서
 * nav 120.4px, 칸 폭 '모의매매' 56 · '미국'(링크 /paper/us) 0 · '보유·체결' 40px — 본문 건너뛰기에서 Tab 한 번이면 이 0폭 링크에 포커스가 갔고(4px 세로 링만),
 * 글은 '모의매매 › › 보…'로 구분 기호 둘이 붙었습니다. 주말 칩이면 로그인 없는 운영자의 새로고침 실패 하나로도 '한국'(/paper/kr)이 0px이었습니다.
 * nav 하한(112px — QA-547 후속)은 첫 칸 + 마지막 칸만 담고 가운데 칸(min-w-0)에는 하한이 없습니다. 가운데 칸에 하한을 두면 1024 주말 두 안내 상태에서
 * 상단바가 9px 넘쳐, 가운데 칸 글이 24px(첫 글자와 말줄임) 아래로 줄면 그 칸을 접습니다(그리지 않음 — 0폭 링크가 Tab 순서·낭독에서 빠지고 '›'도 하나).
 * 접힌 뒤에는 nav나 상단바가 접힐 때의 너비 + 36px(하한 24px + 여유 12px) − 그때 가운데 칸 글이 가졌던 폭(하한까지) 이상이 되어야 다시 펼칩니다(펴면 가운데
 * 칸 글이 적어도 36px — 접고 펴기를 오가며 깜박이지 않게).
 *
 * 검토(QA-593 후속): 실제 상단바에서는 접어서 생긴 폭을 곁의 새로고침 안내 상자가 먼저 가져가(축소 비중 100000) 접힌 nav가 창을 넓혀도 접힌 크기
 * (1280 /paper/us/holdings 129.3px)에 머물렀습니다 — nav 너비만 보던 다시 펴기가 1536에서야 폈고, 펼친 배치면 가운데 칸 글이 이미 다 들어가는
 * 1310~1512에서도 '미국'·'한국' 링크가 없었습니다. 그래서 상단바(nav의 부모) 너비도 함께 봅니다.
 *
 * jsdom은 배치를 재지 않으므로 ResizeObserver 대역(관찰을 시작할 때와 resize()에서 콜백을 바로 부름)과 nav·상단바·가운데 칸 글의 폭(getBoundingClientRect)을
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

/** 가운데 칸(첫 칸·마지막 칸이 아닌 li)의 글 — Breadcrumbs가 재는 그 칸의 마지막 자식(링크·글 칸). */
const MIDDLE_TEXT = 'nav[aria-label="현재 위치"] > ol > li:not(:first-child):not(:last-child) > :last-child';

/**
 * nav·가운데 칸 글('미국' → /paper/us)·상단바(header — 주면)의 폭을 흉내 냅니다 — 값을 바꾸고 resize()를 부르면 ResizeObserver 콜백이 돕니다.
 * 상단바 폭을 주지 않으면 header도 jsdom 그대로(0)입니다.
 */
function stubLayout(initial: { nav: number; middle: number; bar?: number }) {
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
    const width = this.matches('nav[aria-label="현재 위치"]')
      ? size.nav
      : this.matches(MIDDLE_TEXT)
        ? size.middle
        : this.matches("header") && size.bar !== undefined
          ? size.bar
          : null;
    return width === null ? original.call(this) : ({ width, height: 24, top: 0, left: 0, right: width, bottom: 24, x: 0, y: 0 } as DOMRect);
  });
  return {
    resize: (next: { nav?: number; middle?: number; bar?: number }) =>
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
  it("가운데 칸 링크가 0px(nav 120px)이면 그 칸을 그리지 않는다 — '미국' 링크가 없고 '›'가 하나, 마지막 칸은 지금 화면 그대로", () => {
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
  it("접힌 뒤에는 nav가 접힐 때의 너비 + 36px(접힐 때 가운데 칸 0px) 이상이 되어야 다시 펼친다 — 그보다 덜 넓어지면 접힌 채(깜박이지 않게)", () => {
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

  it("가운데 칸이 하한 바로 아래(20px)에서 접혔으면 그만큼 덜 넓어져도 편다 — 접힐 때 너비 + 36 − 20, 펴진 뒤 하한 이상이면 그대로", () => {
    const layout = stubLayout({ nav: 142, middle: 20 });
    render(<Breadcrumbs pathname={PATH} user={LOCAL_OWNER} />);
    expect(within(crumbs()).queryByRole("link", { name: "미국" })).toBeNull();
    layout.resize({ nav: 157, middle: 35 });
    expect(within(crumbs()).queryByRole("link", { name: "미국" })).toBeNull();
    layout.resize({ nav: 158, middle: 36 });
    expect(items()).toEqual(["모의매매", "›미국", "›보유·체결"]);
  });

  // QA-593 후속(검토): 접어서 생긴 폭은 곁의 새로고침 안내 상자가 먼저 가져가므로 창을 넓혀도 접힌 nav는 접힌 크기 그대로입니다. 수정 전(재현 커밋에서는
  // it.fails)에는 nav 너비만 보아, 상단바가 접힐 때보다 14px(= 36 − 22) 넓어져도 '미국' 링크가 돌아오지 않았습니다(접힌 채 — 링크 null).
  it("접힌 뒤 nav 너비가 그대로여도 상단바가 접힐 때 너비 + 36 − 그때 가운데 칸 글 폭 이상 넓어지면 편다 — 덜 넓어지면 접힌 채", () => {
    const layout = stubLayout({ nav: 143, middle: 22, bar: 1304 });
    render(
      <header>
        <Breadcrumbs pathname={PATH} user={LOCAL_OWNER} />
      </header>,
    );
    expect(within(crumbs()).queryByRole("link", { name: "미국" })).toBeNull();
    // 접힌 nav는 접힌 내용 폭(129px)으로 줄고, 창을 넓혀도 그 폭에 머뭅니다(넓어진 폭은 안내 상자가 받음).
    layout.resize({ nav: 129 });
    layout.resize({ bar: 1317 });
    expect(within(crumbs()).queryByRole("link", { name: "미국" })).toBeNull();
    layout.resize({ bar: 1318, middle: 36 });
    expect(within(crumbs()).getByRole("link", { name: "미국" }).getAttribute("href")).toBe("/paper/us");
    expect(items()).toEqual(["모의매매", "›미국", "›보유·체결"]);
  });

  // QA-593 후속(검토): 접어도 '뒤 칸과 주소가 같은 칸은 글 칸'(QA-549)을 숨긴 가운데 칸까지 넣어 계산한 그대로 두어, 접힌 빵부스러기에 위로 가는 링크가
  // 없었습니다 — '모의매매'(→ /paper/us)·'기관'(→ /institutions)·'시장'(→ /macro)은 숨긴 '미국'·'13F 포트폴리오'·'매크로 지표'와 주소가 같아 글 칸,
  // /paper/kr/*에 남는 링크는 다른 시장으로 가는 '모의매매' → /paper/us 하나. 수정 전(재현 커밋에서는 it.fails) /paper/us/holdings의 링크는 [].
  // 이제 첫 칸은 가장 가까운 부모로 가는 링크이고, 전체 글(title)은 숨긴 칸까지 잇습니다(lib/breadcrumbs foldedBreadcrumbs).
  it("접히면 첫 칸이 숨긴 가운데 칸 가운데 가장 가까운 부모로 가는 링크 — 모의매매 미국·한국, 기관 상세, 지표 상세", () => {
    stubLayout({ nav: 120, middle: 0 });
    const cases: [string, string, string, string][] = [
      ["/paper/us/holdings", "모의매매", "/paper/us", "모의매매 › 미국"],
      ["/paper/kr/holdings", "모의매매", "/paper/kr", "모의매매 › 한국"],
      ["/institutions/0001608046", "기관", "/institutions", "기관 › 13F 포트폴리오"],
      ["/markets/i/us10y", "시장", "/macro", "시장 › 매크로 지표"],
    ];
    for (const [path, first, href, title] of cases) {
      render(<Breadcrumbs pathname={path} user={LOCAL_OWNER} />);
      expect(items(), path).toHaveLength(2);
      expect(
        within(crumbs())
          .queryAllByRole("link")
          .map((link) => [link.textContent, link.getAttribute("href")]),
        path,
      ).toEqual([[first, href]]);
      expect(within(crumbs()).getByRole("link").getAttribute("title"), path).toBe(title);
      cleanup();
    }
  });

  it("재기 전이거나 nav 너비가 0이면(좁은 화면에서 숨김·배치 없는 대역) 접지 않는다", () => {
    stubLayout({ nav: 0, middle: 0 });
    render(<Breadcrumbs pathname={PATH} user={LOCAL_OWNER} />);
    expect(within(crumbs()).getByRole("link", { name: "미국" })).toBeTruthy();
    expect(separators()).toBe(2);
  });
});
