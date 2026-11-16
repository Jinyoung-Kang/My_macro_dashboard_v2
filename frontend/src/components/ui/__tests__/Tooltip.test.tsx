/**
 * 공용 툴팁(ui/Tooltip — Radix Tooltip 1.4.1을 감쌈, 작업대 실행 명세 §6 '메뉴·툴팁', ADR 0042 결정 9).
 *  - 키보드 포커스로 열리고 role=tooltip 글을 보인다 — 열린 동안 트리거는 그 글을 설명(aria-describedby)으로 잇는다
 *  - TooltipProvider 밖에서도 스스로 감싸 동작한다
 *  - labelOnly면(툴팁 글 = 접근 이름) 트리거에 aria-describedby를 두지 않는다 — Radix Slot이 자식의 undefined를 이어 붙여 지우지 못하므로 감싼 부품이 뺌
 *  - disabled면 열리지 않고, 자식의 처리기·클래스·ref는 그대로 산다
 *  - 상자는 덮개 3층(surface-2·밝은 경계·그림자·4px), 글은 caption
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Tooltip, TooltipProvider } from "../Tooltip";

afterEach(() => cleanup());

function focus(element: HTMLElement) {
  act(() => element.focus());
}

describe("열기와 설명 연결", () => {
  it("포커스로 열려 role=tooltip 글을 보이고, 열린 동안 트리거가 그 글을 설명으로 잇는다 — Provider 없이도 동작", () => {
    render(
      <Tooltip content="메뉴 접기 ([)">
        <button type="button" aria-label="왼쪽 메뉴 접기">
          접기
        </button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "왼쪽 메뉴 접기" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(trigger.getAttribute("aria-describedby")).toBeNull();

    focus(trigger);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toBe("메뉴 접기 ([)");
    expect(trigger.getAttribute("aria-describedby")).toBe(tooltip.id);

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("labelOnly면 열려도 트리거에 aria-describedby가 없다 — 같은 글을 이름과 설명으로 두 번 읽지 않게", () => {
    render(
      <TooltipProvider>
        <Tooltip content="시장" side="right" labelOnly>
          <a href="/macro">
            <span className="sr-only">시장</span>
          </a>
        </Tooltip>
      </TooltipProvider>,
    );
    const link = screen.getByRole("link", { name: "시장" });
    focus(link);
    expect(screen.getByRole("tooltip").textContent).toBe("시장");
    expect(link.hasAttribute("aria-describedby")).toBe(false);
    // 자식에 aria-describedby가 따로 있으면 그것은 남긴다(툴팁 연결만 뺌).
    cleanup();
    render(
      <Tooltip content="시장" labelOnly>
        <a href="/macro" aria-describedby="note">
          시장
        </a>
      </Tooltip>,
    );
    const described = screen.getByRole("link", { name: "시장" });
    focus(described);
    expect(described.getAttribute("aria-describedby")).toBe("note");
  });

  it("labelOnly로 감싸도 자식의 처리기·클래스·ref는 그대로 산다", () => {
    const onClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(
      <Tooltip content="새로고침" labelOnly>
        <button ref={ref} type="button" aria-label="새로고침" className="size-[30px]" onClick={onClick}>
          x
        </button>
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "새로고침" });
    expect(ref.current).toBe(button);
    expect(button.className.split(/\s+/)).toContain("size-[30px]");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disabled면 포커스해도 열리지 않고, 풀린 뒤 다시 포커스하면 열린다", () => {
    const { rerender } = render(
      <Tooltip content="홈" disabled>
        <button type="button">홈</button>
      </Tooltip>,
    );
    const link = screen.getByRole("button", { name: "홈" });
    focus(link);
    expect(screen.queryByRole("tooltip")).toBeNull();

    // 막힌 동안 받은 열림을 쥐고 있다가 풀릴 때 뜬금없이 열지 않는다.
    rerender(
      <Tooltip content="홈">
        <button type="button">홈</button>
      </Tooltip>,
    );
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => link.blur());
    focus(link);
    expect(screen.getByRole("tooltip").textContent).toBe("홈");
  });
});

describe("모양", () => {
  it("상자는 덮개 3층(surface-2·밝은 경계·그림자·4px), 글은 caption(13px)·본문색", () => {
    render(
      <Tooltip content="데이터 수동 새로고침">
        <button type="button">x</button>
      </Tooltip>,
    );
    focus(screen.getByRole("button"));
    const box = screen.getByRole("tooltip");
    expect(box.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["z-50", "rounded-control", "border-border-overlay", "bg-surface-2", "shadow-overlay", "text-caption", "text-text"]),
    );
  });
});
