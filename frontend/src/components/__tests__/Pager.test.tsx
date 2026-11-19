/**
 * 쪽 넘기기(components/Pager.tsx — 정보 수집 화면들) — 이전 · 번호 · 다음.
 *  - 지금 쪽 번호 단추는 aria-current="page"이고 주 단추(강조 바탕), 나머지 번호는 최소 단추
 *  - 고대비(forced-colors)에서는 바탕색이 지워지고 모든 번호 단추에 같은 1px 시스템 색 테두리가 남으므로, 지금 쪽에만 2px 테두리(QA-492)
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Pager } from "@/components/Pager";

afterEach(() => cleanup());

const tokens = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/);

describe("Pager", () => {
  it("한 쪽뿐이면 그리지 않는다", () => {
    const { container } = render(<Pager page={1} pages={1} onChange={() => {}} label="뉴스" />);
    expect(container.firstChild).toBeNull();
  });

  it("지금 쪽은 aria-current=page의 주 단추, 나머지 번호는 최소 단추", () => {
    render(<Pager page={2} pages={3} onChange={() => {}} label="뉴스" />);
    const nav = screen.getByRole("navigation", { name: "뉴스 쪽" });
    const current = within(nav).getByRole("button", { name: "2" });
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(tokens(current)).toContain("bg-accent");
    for (const name of ["1", "3"]) {
      const other = within(nav).getByRole("button", { name });
      expect(other.getAttribute("aria-current")).toBeNull();
      expect(tokens(other)).toContain("bg-transparent");
    }
  });

  // QA-492: 고대비에서 지금 쪽은 바탕(강조 파랑)이 지워지고 테두리는 모든 번호 단추와 같은 1px 시스템 색이라 글 굵기(600·500)로만 갈렸습니다.
  // 재현 커밋에서는 it.fails였습니다.
  it("QA-492: 고대비에서는 지금 쪽 단추에만 2px 테두리(forced-colors:border-2)", () => {
    render(<Pager page={2} pages={3} onChange={() => {}} label="뉴스" />);
    const nav = screen.getByRole("navigation", { name: "뉴스 쪽" });
    const numbers = within(nav)
      .getAllByRole("button")
      .filter((button) => /^\d+$/.test(button.textContent ?? ""));
    expect(numbers).toHaveLength(3);
    for (const button of numbers) {
      const current = button.getAttribute("aria-current") === "page";
      expect(tokens(button).includes("forced-colors:border-2"), `${button.textContent}쪽`).toBe(current);
    }
  });

  // QA-835(D1 pager-number-button-narrower, S4): lg 미만에서 쪽 번호 단추가 작은 단추(sm — 좌우 여백 px-2.5)의 글 폭뿐이라 높이만 44px이고 폭은 모자랐습니다
  // (D1 기록 — 작업대 개편 전후 33.2 → 29.2px). 좁은 화면은 번호 단추 폭도 44px, 넓은 화면은 24px(작은 조작 — 명세 §3-7).
  // 재현 커밋에서는 it.fails입니다(고치는 커밋에서 it으로).
  it.fails("QA-835: 쪽 번호 단추는 lg 미만 폭 44px(min-w-11)·넓은 화면 24px(lg:min-w-6) — 지금 쪽·다른 쪽 모두", () => {
    render(<Pager page={2} pages={3} onChange={() => {}} label="뉴스" />);
    const nav = screen.getByRole("navigation", { name: "뉴스 쪽" });
    const numbers = within(nav)
      .getAllByRole("button")
      .filter((button) => /^\d+$/.test(button.textContent ?? ""));
    expect(numbers).toHaveLength(3);
    for (const button of numbers) {
      expect(tokens(button), `${button.textContent}쪽`).toContain("min-w-11");
      expect(tokens(button), `${button.textContent}쪽`).toContain("lg:min-w-6");
    }
  });
});
