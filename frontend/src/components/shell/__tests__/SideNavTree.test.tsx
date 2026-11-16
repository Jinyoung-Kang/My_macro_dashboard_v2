/**
 * 넓은 화면 왼쪽 나무 메뉴(shell/SideNav — 작업대 실행 명세 §5, ADR 0042 결정 5). 모델(펼침·묶음·aria-current·막대)은 lib/__tests__/navTree.test가 고정하고,
 * 여기서는 그린 모양을 봅니다: 지금 탭의 하위 칸을 같은 nav 안에 펼침, '한국 시장' 묶음 글 머리와 그 목록, 잠금 아이콘, aria-current,
 * 하위 목록 이름이 '…하위 메뉴'가 아님(좁은 화면 줄과 겹치지 않게), 32px 칸·16px 아이콘, 고대비 테두리는 막대 칸 하나.
 * 접힘(48px 아이콘 레일): 링크 이름은 그대로(sr-only 글), 하위 칸 없음, 포커스로 이름 툴팁(설명 연결 없음), 접기 단추(aria-pressed·aria-keyshortcuts '['),
 * 셸 명령 toggle-nav로 접고 폄, 저장값 '1'이면 접힌 채 시작, 사라지는 칸에 있던 포커스는 접기 단추로.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { resetNavCollapsedForTest } from "@/hooks/useNavCollapsed";
import { sendShellCommand } from "@/lib/shellCommands";
import type { SessionUser } from "@/lib/types";

import { SideNav } from "../SideNav";

const OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: true };
const MEMBER_FREE: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "FREE" };
const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  resetNavCollapsedForTest();
});

const mainNav = () => screen.getByRole("navigation", { name: "주 메뉴" });
const labels = (scope: HTMLElement) => within(scope).getAllByRole("link").map((link) => link.textContent);

describe("펼친 하위 화면", () => {
  it("지금 탭(시장)만 하위 화면 여섯을 '시장 화면' 목록으로 펼치고, 하위 칸 링크는 지금 화면에 aria-current=page", () => {
    render(<SideNav pathname="/liquidity" user={MEMBER} />);
    const screens = within(mainNav()).getByRole("list", { name: "시장 화면" });
    expect(labels(screens)).toEqual(["매크로 지표", "순유동성", "섹터·자산군", "상관관계", "투기세력(COT)", "국면 판정"]);
    expect(within(screens).getByRole("link", { name: "순유동성" }).getAttribute("aria-current")).toBe("page");
    expect(within(screens).getByRole("link", { name: "매크로 지표" }).getAttribute("aria-current")).toBeNull();
    expect(within(mainNav()).getByRole("link", { name: "시장" }).getAttribute("aria-current")).toBe("true");
    // 다른 탭은 펼치지 않는다
    expect(within(mainNav()).queryByRole("list", { name: "기관 화면" })).toBeNull();
    expect(within(mainNav()).getAllByRole("list")).toHaveLength(2);
  });

  it("더보기(/radar): 묶음 없는 화면 다음 '한국 시장' 글 머리와 그 목록 — 무료 회원에게 유료 화면은 잠금 아이콘(이름 있음)·title", () => {
    render(<SideNav pathname="/radar" user={MEMBER_FREE} />);
    const screens = within(mainNav()).getByRole("list", { name: "더보기 화면" });
    expect(labels(screens)).toEqual(["알림", "AI 종합 분석", "내 계정", "수급 레이더", "파생·투기세력(KRX)"]);
    const kr = within(screens).getByRole("list", { name: "한국 시장" });
    expect(labels(kr)).toEqual(["수급 레이더", "파생·투기세력(KRX)"]);
    expect(within(kr).getByRole("link", { name: "수급 레이더" }).getAttribute("aria-current")).toBe("page");
    // 글 머리는 누르지 않는 글
    expect(within(screens).getByText("한국 시장").closest("a")).toBeNull();
    const ai = within(screens).getByRole("link", { name: /AI 종합 분석/ });
    expect(within(ai).getByRole("img", { name: "유료 등급 기능" })).toBeTruthy();
    expect(ai.querySelector('[title="유료 등급 기능"]')).not.toBeNull();
    // 잠금 아이콘에는 <title>이 없어 링크 글은 메뉴 이름 그대로(명세 D8 c)
    expect(ai.textContent).toBe("AI 종합 분석");
  });

  it("모의매매 탭 주소(/paper/us/holdings)에서 하위 칸 '미국'은 aria-current=true(아래 주소) — 탭 링크도 true", () => {
    render(<SideNav pathname="/paper/us/holdings" user={OWNER} />);
    const screens = within(mainNav()).getByRole("list", { name: "모의매매 화면" });
    expect(within(screens).getByRole("link", { name: "미국" }).getAttribute("aria-current")).toBe("true");
    expect(within(screens).getByRole("link", { name: "한국" }).getAttribute("aria-current")).toBeNull();
    expect(within(mainNav()).getByRole("link", { name: "모의매매" }).getAttribute("aria-current")).toBe("true");
  });

  it("하위 목록·묶음 목록의 이름은 '…하위 메뉴'가 아니고 nav도 아니다 — 그 이름의 내비는 좁은 화면 하위 메뉴 줄 하나", () => {
    render(<SideNav pathname="/radar" user={MEMBER} />);
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(screen.queryAllByRole("navigation", { name: /하위 메뉴/ })).toHaveLength(0);
    for (const list of within(mainNav()).getAllByRole("list")) {
      expect(list.getAttribute("aria-label") ?? "").not.toMatch(/하위 메뉴/);
    }
  });

  it("탭 링크에만 data-nav-tab — 탭 이름 순서 그대로(펼친 하위 칸은 빠짐)", () => {
    render(<SideNav pathname="/info/kr" user={OWNER} />);
    expect([...mainNav().querySelectorAll("a[data-nav-tab]")].map((link) => link.textContent)).toEqual([
      "홈", "시장", "기관", "모의매매", "정보 검색", "정보 수집", "더보기",
    ]);
    expect(labels(within(mainNav()).getByRole("list", { name: "정보 수집 화면" }))).toHaveLength(8);
  });
});

describe("모양", () => {
  it("메뉴 폭 220px, 칸 높이 32px, 탭 아이콘 16px, 하위 칸은 탭 이름과 같은 세로줄로 들여 씀", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    expect((mainNav().closest("aside") as HTMLElement).className.split(/\s+/)).toContain("w-[220px]");
    const tab = within(mainNav()).getByRole("link", { name: "시장" });
    expect(tab.className.split(/\s+/)).toEqual(expect.arrayContaining(["h-8", "rounded-control", "text-sm"]));
    expect(tab.querySelector("svg")?.getAttribute("width")).toBe("16");
    const leaf = within(mainNav()).getByRole("link", { name: "순유동성" });
    expect(leaf.className.split(/\s+/)).toEqual(expect.arrayContaining(["h-8", "pl-8"]));
  });

  it("고대비에서 남는 같은 폭의 왼쪽 테두리는 막대 칸(가장 깊은 지금 칸) 하나에만 — 나머지 칸에는 테두리 변형이 없다", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    const withForced = [...mainNav().querySelectorAll("a")].filter((link) => link.className.includes("forced-colors:"));
    expect(withForced.map((link) => link.textContent)).toEqual(["매크로 지표"]);
    expect(withForced[0].className.split(/\s+/)).toContain("forced-colors:before:border-l-[3px]");
  });

  it("지금 탭에 하위 칸이 없으면(/more) 탭 칸이 막대를 갖는다", () => {
    render(<SideNav pathname="/more" user={MEMBER} />);
    const more = within(mainNav()).getByRole("link", { name: "더보기" });
    expect(more.className.split(/\s+/)).toEqual(expect.arrayContaining(["before:bg-accent", "bg-surface-2", "font-semibold"]));
    expect(more.getAttribute("aria-current")).toBe("page");
    expect(labels(within(mainNav()).getByRole("list", { name: "더보기 화면" }))).toEqual(["알림", "AI 종합 분석", "내 계정", "수급 레이더", "파생·투기세력(KRX)"]);
  });
});

describe("접힘(48px 아이콘 레일)", () => {
  const toggleButton = () => screen.getByRole("button", { name: "왼쪽 메뉴 접기" });

  it("접기 단추 — 이름 '왼쪽 메뉴 접기'(보이는 글 '메뉴 접기'), aria-pressed가 접힘, 단축키 [, 주 메뉴를 가리킴(aria-controls)", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    const button = toggleButton();
    expect(button.textContent).toBe("메뉴 접기");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("aria-keyshortcuts")).toBe("[");
    expect(button.getAttribute("aria-controls")).toBe(mainNav().id);

    fireEvent.click(button);
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    expect(toggleButton().textContent).toBe("");
    expect(window.localStorage.getItem("shell.navCollapsed")).toBe("1");
    expect((mainNav().closest("aside") as HTMLElement).className.split(/\s+/)).toContain("w-12");
  });

  it("접히면 탭 아이콘(20px)만 — 링크 이름은 그대로(sr-only 글), 하위 칸은 없고, 막대는 지금 탭 칸", () => {
    window.localStorage.setItem("shell.navCollapsed", "1");
    render(<SideNav pathname="/macro" user={MEMBER} />);
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    expect([...mainNav().querySelectorAll("a[data-nav-tab]")].map((link) => link.textContent)).toEqual(["홈", "시장", "기관", "정보 검색", "더보기"]);
    const markets = within(mainNav()).getByRole("link", { name: "시장" });
    expect(markets.querySelector("span")?.className).toBe("sr-only");
    expect(markets.querySelector("svg")?.getAttribute("width")).toBe("20");
    expect(markets.getAttribute("aria-current")).toBe("page");
    expect(markets.className.split(/\s+/)).toEqual(expect.arrayContaining(["before:bg-accent", "forced-colors:before:border-l-[3px]"]));
    expect(within(mainNav()).queryByRole("list", { name: "시장 화면" })).toBeNull();
    expect(within(mainNav()).queryByRole("link", { name: "매크로 지표" })).toBeNull();
  });

  it("접힌 탭 링크에 포커스하면 오른쪽에 이름 툴팁 — 이름과 같은 글이라 설명(aria-describedby)으로 잇지 않는다. 펼친 동안은 툴팁이 없다", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    const home = within(mainNav()).getByRole("link", { name: "홈" });
    act(() => home.focus());
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => home.blur());

    fireEvent.click(toggleButton());
    act(() => home.focus());
    expect(screen.getByRole("tooltip").textContent).toBe("홈");
    expect(home.hasAttribute("aria-describedby")).toBe(false);
  });

  it("접기 단추의 툴팁은 접힘과 상관없이 이름과 같은 글에 단축키 — '왼쪽 메뉴 접기 ([)', 설명(aria-describedby)으로 잇지 않는다", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    for (const pressed of ["false", "true"]) {
      const button = toggleButton();
      expect(button.getAttribute("aria-pressed")).toBe(pressed);
      act(() => button.focus());
      expect(screen.getByRole("tooltip").textContent).toBe("왼쪽 메뉴 접기 ([)");
      expect(button.hasAttribute("aria-describedby")).toBe(false);
      act(() => button.blur());
      fireEvent.click(button);
    }
  });

  it("셸 명령 toggle-nav([ 키·명령 팔레트가 넓은 화면에서 보냄)로 접고 편다", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    act(() => sendShellCommand("toggle-nav"));
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    act(() => sendShellCommand("toggle-nav"));
    expect(toggleButton().getAttribute("aria-pressed")).toBe("false");
    // 다른 명령은 받지 않는다
    act(() => sendShellCommand("open-shortcut-help"));
    expect(toggleButton().getAttribute("aria-pressed")).toBe("false");
  });

  it("접을 때 포커스가 사라지는 하위 칸에 있었으면 접기 단추로, 탭 칸에 있었으면 그 탭 링크에 그대로 남는다", () => {
    render(<SideNav pathname="/macro" user={MEMBER} />);
    const leaf = within(mainNav()).getByRole("link", { name: "순유동성" });
    act(() => leaf.focus());
    act(() => sendShellCommand("toggle-nav"));
    expect(document.activeElement).toBe(toggleButton());

    act(() => sendShellCommand("toggle-nav"));
    const tab = within(mainNav()).getByRole("link", { name: "기관" });
    act(() => tab.focus());
    act(() => sendShellCommand("toggle-nav"));
    expect(document.activeElement).toBe(tab);
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
  });
});
