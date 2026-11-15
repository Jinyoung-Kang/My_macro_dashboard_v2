/**
 * Avatar — 자산 행 왼쪽 원 안의 모노그램(명세 docs/specs/2026-10-31-v2-coinbase-ui.md §4, 크기는 작업대 실행 명세 §3-7).
 *  - 장식(aria-hidden): 글자는 보이지만 읽어 주기·이름 계산에 들어가지 않는다
 *  - 글자가 없으면(null·빈 글·"N/A") 그리지 않는다 — 빈 원을 두지 않는다
 *  - 고리 색을 주면 2px 고리(그 색), 없으면 고리 없음
 *  - 크기: 모든 폭 32px(원 — rounded-full은 아바타에 남음, 명세 §3-8)
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Avatar } from "../Avatar";

afterEach(() => cleanup());

describe("Avatar", () => {
  it("글자 — 원 안의 모노그램, 장식(aria-hidden), 32px 원", () => {
    const { container } = render(<Avatar text="SPY" />);
    const avatar = container.firstElementChild as HTMLElement;
    expect(avatar.textContent).toBe("SPY");
    expect(avatar.getAttribute("aria-hidden")).toBe("true");
    const classes = avatar.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["rounded-full", "size-8", "bg-surface-2", "text-text-2"]));
    expect(classes.some((name) => name.endsWith(":size-10") || name === "size-9")).toBe(false);
    expect(classes).not.toContain("ring-2");
    expect(avatar.getAttribute("style")).toBeNull();
    // 장식이라 글로 찾아도 접근성 트리에는 없습니다.
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("글자가 없으면(null·빈 글·'N/A') 그리지 않는다", () => {
    for (const text of [null, undefined, "", "  ", "N/A"]) {
      const { container } = render(<Avatar text={text} ring="#3987e5" />);
      expect(container.innerHTML).toBe("");
      cleanup();
    }
  });

  it("고리 색을 주면 그 색의 2px 고리, 빈 색은 고리 없음", () => {
    const { container, rerender } = render(<Avatar text="C1" ring="#d95926" />);
    const avatar = container.firstElementChild as HTMLElement;
    expect(avatar.className.split(/\s+/)).toContain("ring-2");
    expect(avatar.style.getPropertyValue("--avatar-ring")).toBe("#d95926");
    rerender(<Avatar text="C1" ring="" />);
    expect((container.firstElementChild as HTMLElement).className.split(/\s+/)).not.toContain("ring-2");
  });
});
