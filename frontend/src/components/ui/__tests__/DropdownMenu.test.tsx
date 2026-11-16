/**
 * 공용 메뉴(ui/DropdownMenu — Radix DropdownMenu 2.2.1을 감쌈, 작업대 실행 명세 §6 '메뉴·툴팁', ADR 0042 결정 9).
 *  - 여는 단추에서 Enter로 열리고, 항목은 menuitem이며 화살표로 옮기고, Esc로 닫히면 여는 단추로 포커스가 돌아온다
 *  - 상자는 덮개 범위 표지(data-overlay)를 단다 — 안의 조작 바탕이 한 단계 위(surface-3)가 되게(명세 §3-4)
 *  - 링크 항목은 a[role=menuitem][href], 항목은 좁은 화면 44px·넓은 화면 32px, 항목 글에 text-3이 없다(surface-3 위 금지 쌍)
 *  - 닫힌 뒤 포커스 처리(onCloseAutoFocus)를 부르는 쪽에 넘긴다
 *  - 항목이 아닌 글(description)은 항목 아래에 두고 메뉴의 설명(aria-describedby)으로 잇는다 — 화살표는 그 글에 서지 않는다
 *  - tooltip을 주면 여는 단추가 이름 툴팁(공용 Tooltip labelOnly)과 메뉴 트리거를 함께 가진다 — 열림은 aria-expanded로 본다(data-state는 툴팁 것)
 *  - open·onOpenChange를 주면 열림을 부르는 쪽이 쥐고(제어), tooltipDisabled면 이름 툴팁을 열지 않는다(넓은 화면 전용 메뉴가 폭이 줄 때 — QA-554)
 *  - 단일 선택 묶음(RadioGroup·RadioItem — 작업대 P3 추가 '왼쪽 메뉴 폭'): 이름표가 묶음(role=group)의 이름, 항목은 menuitemradio·aria-checked, 고른 항목은
 *    색이 아닌 체크 아이콘, 값이 어느 항목과도 같지 않으면 고른 항목 없음, 고르면(이미 고른 항목이어도) onValueChange 뒤 닫힘, 다른 항목과 같은 화살표 순서
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "../DropdownMenu";

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

describe("이름 툴팁(tooltip — 아이콘 여는 단추)", () => {
  function renderWithTooltip() {
    render(
      <DropdownMenu
        label="예시 메뉴"
        tooltip="메뉴 열기"
        trigger={
          <button type="button" aria-label="메뉴 열기" className="aria-expanded:border-border-strong">
            M
          </button>
        }
      >
        <DropdownMenuItem>첫 항목</DropdownMenuItem>
      </DropdownMenu>,
    );
    return screen.getByRole("button", { name: "메뉴 열기" });
  }

  it("포커스하면 이름과 같은 글의 툴팁 — 설명(aria-describedby)으로 잇지 않고, 메뉴 트리거 속성(aria-haspopup·aria-expanded)과 클래스는 그대로", () => {
    const trigger = renderWithTooltip();
    act(() => trigger.focus());
    expect(screen.getByRole("tooltip").textContent).toBe("메뉴 열기");
    expect(trigger.hasAttribute("aria-describedby")).toBe(false);
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.className).toBe("aria-expanded:border-border-strong");
  });

  it("Enter로 메뉴가 열리고(aria-expanded=true — 툴팁은 닫힘) 포커스가 항목으로, Esc로 닫히면 여는 단추로 돌아온다", async () => {
    const trigger = renderWithTooltip();
    act(() => trigger.focus());
    const menu = open(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(within(menu).getByRole("menuitem")));
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("마우스로 누르면(pointerdown) 메뉴가 열린다", () => {
    const trigger = renderWithTooltip();
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    expect(screen.getByRole("menu", { name: "예시 메뉴" })).toBeTruthy();
  });
});

describe("열림 제어(open·onOpenChange)·이름 툴팁 끄기(tooltipDisabled) — 넓은 화면 전용 메뉴가 폭이 줄 때 닫으려고(QA-554)", () => {
  const trigger = () => screen.getByRole("button", { name: "메뉴 열기" });

  it("open을 주면 부르는 쪽이 열림을 쥔다 — 여는 단추·Esc는 onOpenChange로 알리기만 하고, 부르는 쪽이 open을 바꿔야 열고 닫힌다", async () => {
    const onOpenChange = vi.fn();
    const view = (open: boolean) => (
      <DropdownMenu
        label="예시 메뉴"
        open={open}
        onOpenChange={onOpenChange}
        trigger={
          <button type="button" aria-label="메뉴 열기">
            열기
          </button>
        }
      >
        <DropdownMenuItem>첫 항목</DropdownMenuItem>
      </DropdownMenu>
    );
    const { rerender } = render(view(false));
    // 열린 메뉴는 모달이라 뒤 화면(여는 단추)이 aria-hidden — 요소를 먼저 쥐어 둡니다.
    const button = trigger();
    fireEvent.keyDown(button, { key: "Enter" });
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(screen.queryByRole("menu")).toBeNull();

    rerender(view(true));
    const menu = screen.getByRole("menu", { name: "예시 메뉴" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(within(menu).getByRole("menuitem"), { key: "Escape" });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("menu", { name: "예시 메뉴" })).toBeTruthy();

    // 부르는 쪽이 스스로 닫을 수도 있다(폭이 lg 아래로 바뀔 때 — 계정 메뉴)
    rerender(view(false));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("tooltipDisabled면 이름 툴팁을 열지 않는다 — 메뉴 트리거 속성과 Enter로 열기는 그대로", () => {
    render(
      <DropdownMenu
        label="예시 메뉴"
        tooltip="메뉴 열기"
        tooltipDisabled
        trigger={
          <button type="button" aria-label="메뉴 열기">
            M
          </button>
        }
      >
        <DropdownMenuItem>첫 항목</DropdownMenuItem>
      </DropdownMenu>,
    );
    act(() => trigger().focus());
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(screen.getByRole("menu", { name: "예시 메뉴" })).toBeTruthy();
  });
});

describe("단일 선택 묶음(RadioGroup·RadioItem)", () => {
  function renderRadio(value: string | undefined, onValueChange: (value: string) => void = vi.fn()) {
    render(
      <DropdownMenu
        label="예시 메뉴"
        trigger={
          <button type="button" aria-label="메뉴 열기">
            열기
          </button>
        }
      >
        <DropdownMenuItem>첫 항목</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup label="크기" value={value} onValueChange={onValueChange}>
          <DropdownMenuRadioItem value="s">작게</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="m">보통</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="l">크게</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenu>,
    );
    return open(screen.getByRole("button", { name: "메뉴 열기" }));
  }
  const radios = (menu: HTMLElement) => within(menu).getAllByRole("menuitemradio");

  it("이름표가 묶음(role=group)의 이름 — 항목은 menuitemradio이고 고른 하나만 aria-checked=true, 그 항목에만 체크 아이콘(색이 아닌 모양)", () => {
    const menu = renderRadio("m");
    const group = within(menu).getByRole("group", { name: "크기" });
    expect(within(group).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["작게", "보통", "크게"]);
    expect(radios(menu).map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(radios(menu).map((item) => item.querySelectorAll("svg").length)).toEqual([0, 1, 0]);
    // 아이콘은 장식 — 고름은 aria-checked가 나름
    expect(radios(menu)[1].querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    // 이름표 글은 항목이 아님(menuitem 목록에 없음)
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["첫 항목"]);
  });

  it("값이 어느 항목과도 같지 않으면(undefined·다른 값) 고른 항목이 없다", () => {
    for (const value of [undefined, "xl"]) {
      const menu = renderRadio(value);
      expect(radios(menu).every((item) => item.getAttribute("aria-checked") === "false")).toBe(true);
      expect(menu.querySelectorAll('[role="menuitemradio"] svg')).toHaveLength(0);
      cleanup();
    }
  });

  it("고르면 onValueChange(그 값) 뒤 닫힌다 — 이미 고른 항목을 다시 골라도 불린다", async () => {
    const onValueChange = vi.fn();
    fireEvent.click(within(renderRadio("m", onValueChange)).getByRole("menuitemradio", { name: "크게" }));
    expect(onValueChange).toHaveBeenLastCalledWith("l");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    cleanup();

    fireEvent.click(within(renderRadio("m", onValueChange)).getByRole("menuitemradio", { name: "보통" }));
    expect(onValueChange).toHaveBeenLastCalledWith("m");
    expect(onValueChange).toHaveBeenCalledTimes(2);
  });

  it("다른 항목과 같은 화살표 순서에 선다(이름표·구분선은 건너뜀)", async () => {
    const menu = renderRadio("m");
    const first = within(menu).getByRole("menuitem", { name: "첫 항목" });
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.keyDown(first, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(radios(menu)[0]));
    fireEvent.keyDown(radios(menu)[0], { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(radios(menu)[1]));
  });

  it("항목 칸은 다른 항목과 같다(44px·32px, 가리킨 바탕, 포커스 링, 고대비 윤곽선) — 글에 text-3·accent가 없고 체크 칸은 16px로 늘 있다", () => {
    const menu = renderRadio("s");
    for (const item of radios(menu)) {
      const classes = item.className.split(/\s+/);
      expect(classes).toEqual(
        expect.arrayContaining([
          "min-h-11", "lg:min-h-8", "rounded-control", "data-[highlighted]:bg-control-fill", "focus-visible:outline-2",
          "forced-colors:data-[highlighted]:outline-[Highlight]",
        ]),
      );
      expect(classes).not.toContain("outline-none");
      expect(item.querySelector(".size-4")).not.toBeNull();
      for (const node of [item, ...item.querySelectorAll("*")]) {
        const names = (node.getAttribute("class") ?? "").split(/\s+/);
        expect(names.some((name) => ["text-text-3", "text-accent", "text-danger", "text-neutral"].includes(name))).toBe(false);
      }
    }
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
