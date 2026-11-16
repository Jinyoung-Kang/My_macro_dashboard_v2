/**
 * 공용 메뉴(ui/DropdownMenu — Radix DropdownMenu 2.2.1을 감쌈, 작업대 실행 명세 §6 '메뉴·툴팁', ADR 0042 결정 9).
 *  - 여는 단추에서 Enter로 열리고, 항목은 menuitem이며 화살표로 옮기고, Esc로 닫히면 여는 단추로 포커스가 돌아온다
 *  - 상자는 덮개 범위 표지(data-overlay)를 단다 — 안의 조작 바탕이 한 단계 위(surface-3)가 되게(명세 §3-4)
 *  - 링크 항목은 a[role=menuitem][href], 항목은 좁은 화면 44px·넓은 화면 32px, 항목 글에 text-3이 없다(surface-3 위 금지 쌍)
 *  - 닫힌 뒤 포커스 처리(onCloseAutoFocus)를 부르는 쪽에 넘긴다
 *  - 항목이 아닌 글(description)은 항목 아래에 두고 메뉴의 설명(aria-describedby)으로 잇는다 — 화살표는 그 글에 서지 않는다
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuLinkItem, DropdownMenuSeparator } from "../DropdownMenu";

afterEach(() => cleanup());

function renderMenu({ onSelect = vi.fn(), onCloseAutoFocus }: { onSelect?: (event: Event) => void; onCloseAutoFocus?: (event: Event) => void } = {}) {
  render(
    <DropdownMenu
      label="예시 메뉴"
      onCloseAutoFocus={onCloseAutoFocus}
      trigger={
        <button type="button" aria-label="메뉴 열기">
          열기
        </button>
      }
    >
      <DropdownMenuLabel>묶음</DropdownMenuLabel>
      <DropdownMenuLinkItem href="/account">내 계정</DropdownMenuLinkItem>
      <DropdownMenuItem onSelect={onSelect} keyshortcuts="?">
        단축키 도움말
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled>못 고르는 항목</DropdownMenuItem>
    </DropdownMenu>,
  );
  return screen.getByRole("button", { name: "메뉴 열기" });
}

function open(trigger: HTMLElement): HTMLElement {
  fireEvent.keyDown(trigger, { key: "Enter" });
  return screen.getByRole("menu", { name: "예시 메뉴" });
}

describe("열고 닫기", () => {
  it("닫혀 있으면 메뉴가 DOM에 없고, 여는 단추는 aria-haspopup=menu·aria-expanded=false", () => {
    const trigger = renderMenu();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("Enter로 열리고 항목은 menuitem — 이름표·구분선은 항목이 아니다", () => {
    const trigger = renderMenu();
    const menu = open(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["내 계정", "단축키 도움말", "못 고르는 항목"]);
    expect(within(menu).getByRole("separator")).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "단축키 도움말" }).getAttribute("aria-keyshortcuts")).toBe("?");
  });

  it("키보드로 열면 첫 항목에 포커스, 아래 화살표로 다음 항목, 끝에서 처음으로 돌아간다(못 고르는 항목은 건너뜀)", async () => {
    const trigger = renderMenu();
    const menu = open(trigger);
    const [account, help] = within(menu).getAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(account));
    // Radix 로빙 포커스는 화살표 다음 칸으로 옮기는 일을 다음 차례(setTimeout)에 합니다.
    fireEvent.keyDown(account, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(help));
    fireEvent.keyDown(help, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(account));
  });

  it("Esc로 닫히고 포커스는 여는 단추로 돌아온다", async () => {
    const trigger = renderMenu();
    const menu = open(trigger);
    fireEvent.keyDown(within(menu).getAllByRole("menuitem")[0], { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("항목을 고르면 onSelect가 불리고 닫힌다 — 닫힌 뒤 포커스 처리(onCloseAutoFocus)는 부르는 쪽에 넘어간다", async () => {
    const onSelect = vi.fn();
    const onCloseAutoFocus = vi.fn();
    const trigger = renderMenu({ onSelect, onCloseAutoFocus });
    fireEvent.click(within(open(trigger)).getByRole("menuitem", { name: "단축키 도움말" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(onCloseAutoFocus).toHaveBeenCalledTimes(1));
  });

  it("onSelect에서 기본 동작을 막으면 메뉴가 열린 채 남는다(결과를 메뉴 안에 보일 때)", () => {
    const trigger = renderMenu({ onSelect: (event) => event.preventDefault() });
    fireEvent.click(within(open(trigger)).getByRole("menuitem", { name: "단축키 도움말" }));
    expect(screen.getByRole("menu", { name: "예시 메뉴" })).toBeTruthy();
  });
});

describe("설명 칸(description — 항목이 아닌 글)", () => {
  function renderWithDescription(description?: ReactNode) {
    render(
      <DropdownMenu
        label="예시 메뉴"
        description={description}
        trigger={
          <button type="button" aria-label="메뉴 열기">
            열기
          </button>
        }
      >
        <DropdownMenuItem>첫 항목</DropdownMenuItem>
        <DropdownMenuItem>둘째 항목</DropdownMenuItem>
      </DropdownMenu>,
    );
    return open(screen.getByRole("button", { name: "메뉴 열기" }));
  }

  it("항목 아래(마지막 자식)에 그리고 메뉴의 aria-describedby로 잇는다 — 항목이 아니라 화살표가 건너뛴다", async () => {
    const menu = renderWithDescription(<p>읽기 모드: auto</p>);
    const id = menu.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    const note = document.getElementById(id as string) as HTMLElement;
    expect(note.textContent).toBe("읽기 모드: auto");
    expect(menu.lastElementChild).toBe(note);
    expect(note.hasAttribute("role")).toBe(false);
    expect(note.className.split(/\s+/)).toEqual(expect.arrayContaining(["border-t", "border-border"]));
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["첫 항목", "둘째 항목"]);

    const [first, second] = within(menu).getAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.keyDown(first, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(second));
    fireEvent.keyDown(second, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(first));
  });

  it("설명이 없으면 aria-describedby도 칸도 없다", () => {
    const menu = renderWithDescription();
    expect(menu.hasAttribute("aria-describedby")).toBe(false);
    expect(menu.lastElementChild?.getAttribute("role")).toBe("menuitem");
  });
});

describe("모양", () => {
  it("상자는 덮개 3층(surface-2·밝은 경계·그림자·4px)이고 덮개 범위 표지(data-overlay)를 단다", () => {
    const menu = open(renderMenu());
    expect(menu.hasAttribute("data-overlay")).toBe(true);
    expect(menu.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["z-50", "rounded-card", "border-border-overlay", "bg-surface-2", "shadow-overlay"]),
    );
  });

  it("링크 항목은 a[role=menuitem][href] — 항목 칸은 좁은 화면 44px·넓은 화면 32px, 가리키면 조작 바탕", () => {
    const menu = open(renderMenu());
    const link = within(menu).getByRole("menuitem", { name: "내 계정" });
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/account");
    for (const item of within(menu).getAllByRole("menuitem")) {
      const classes = item.className.split(/\s+/);
      expect(classes).toEqual(expect.arrayContaining(["min-h-11", "lg:min-h-8", "rounded-control", "data-[highlighted]:bg-control-fill"]));
      // 키보드 포커스 링이 보이게 — outline-none은 Tailwind 4에서 focus-visible:outline-2의 선 모양까지 none으로 만듭니다.
      expect(classes).toContain("focus-visible:outline-2");
      expect(classes).not.toContain("outline-none");
      // 고대비에서는 가리킨 항목 바탕이 지워지므로 그 모드에서만 안쪽 2px 시스템 강조색 테두리(마우스로 가리켜도 지금 항목이 보이게)
      expect(classes).toEqual(
        expect.arrayContaining([
          "forced-colors:data-[highlighted]:outline-2",
          "forced-colors:data-[highlighted]:-outline-offset-2",
          "forced-colors:data-[highlighted]:outline-[Highlight]",
        ]),
      );
    }
  });

  it("항목 글은 text·text-2만 — 가리킨 항목 바탕(덮개 안 surface-3) 위에 text-3·accent·danger 글자를 두지 않는다", () => {
    const menu = open(renderMenu());
    for (const item of within(menu).getAllByRole("menuitem")) {
      const nodes = [item, ...item.querySelectorAll("*")];
      for (const node of nodes) {
        const classes = (node.getAttribute("class") ?? "").split(/\s+/);
        expect(classes.some((name) => ["text-text-3", "text-accent", "text-danger", "text-neutral"].includes(name))).toBe(false);
      }
    }
  });
});
