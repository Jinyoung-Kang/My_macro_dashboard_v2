/**
 * Skeleton — 불러오는 중 자리표시.
 *  - role="status" + aria-busy, 이름·읽는 글은 label(기본 "불러오는 중"), 막대는 aria-hidden
 *  - 줄 수·블록 높이
 *  - 움직임 줄이기면 깜빡이지 않는다(motion-safe에서만 animate-pulse)
 *  - 막대는 놓인 면보다 한 단계 위 면(bg-control-fill — 덮개 안에서도 보임), 고대비(forced-colors)에서는 테두리로 남는다
 *  - 숫자를 그리지 않는다 — 값 있음·없음·추정·오래됨은 값이 도착한 뒤의 상태라 Skeleton은 그 어느 것도 흉내 내지 않는다
 *  - inline — 글줄 안의 짧은 막대 하나(span만, 블록 상자 없음 — QA-605)
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Skeleton } from "../Skeleton";

afterEach(() => cleanup());

function bars(status: HTMLElement): HTMLElement[] {
  return Array.from(status.querySelectorAll<HTMLElement>('[aria-hidden="true"]'));
}

describe("Skeleton", () => {
  it("기본 — role=status·aria-busy, 이름 '불러오는 중', 3줄(마지막 줄은 짧게)", () => {
    render(<Skeleton />);
    const status = screen.getByRole("status", { name: "불러오는 중" });
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("불러오는 중").className).toContain("sr-only");
    const lines = bars(status);
    expect(lines).toHaveLength(3);
    expect(lines[2].className).toContain("w-3/5");
    expect(lines[0].className).toContain("w-full");
    // 4px 모서리(작업대 실행 명세 §3-8 — rounded-full은 상태 점·토글 손잡이·아바타만).
    for (const line of lines) {
      expect(line.className.split(/\s+/)).toContain("rounded-control");
      expect(line.className.split(/\s+/)).not.toContain("rounded-full");
    }
  });

  it("label을 바꾸면 이름과 읽는 글이 함께 바뀐다", () => {
    render(<Skeleton label="순자산을 불러오는 중" />);
    expect(screen.getByRole("status", { name: "순자산을 불러오는 중" })).toBeTruthy();
    expect(screen.getByText("순자산을 불러오는 중")).toBeTruthy();
  });

  it("lines — 정한 줄 수", () => {
    render(<Skeleton lines={5} />);
    expect(bars(screen.getByRole("status"))).toHaveLength(5);
  });

  it("height만 — 그 높이의 블록 하나", () => {
    render(<Skeleton height={260} />);
    const [block, ...rest] = bars(screen.getByRole("status"));
    expect(block.style.height).toBe("260px");
    expect(rest).toHaveLength(0);
  });

  it("height + lines — 블록 뒤에 줄", () => {
    render(<Skeleton height={120} lines={2} />);
    const all = bars(screen.getByRole("status"));
    expect(all).toHaveLength(3);
    expect(all[0].style.height).toBe("120px");
  });

  it("막대 바탕은 조작 바탕(덮개 안에서 한 단계 위), 고대비 모드에서는 1px 테두리 — 블록과 줄 모두", () => {
    render(<Skeleton height={100} lines={2} />);
    for (const bar of bars(screen.getByRole("status"))) {
      const classes = bar.className.split(/\s+/);
      expect(classes).toEqual(expect.arrayContaining(["bg-control-fill", "forced-colors:border"]));
      expect(classes).not.toContain("bg-surface-2");
    }
  });

  it("움직임 줄이기 — 깜빡임은 motion-safe에서만", () => {
    render(<Skeleton height={100} lines={2} />);
    for (const bar of bars(screen.getByRole("status"))) {
      const classes = bar.className.split(/\s+/);
      expect(classes).toContain("motion-safe:animate-pulse");
      expect(classes).not.toContain("animate-pulse");
    }
  });

  it("inline — 글줄 안의 짧은 막대 하나(span만 — 블록 상자·py-1 없음), role=status·이름, 막대 모양은 블록·줄과 같다 (QA-605)", () => {
    const { container } = render(
      <p>
        읽지 않음 <Skeleton inline lines={4} height={80} label="읽지 않은 수 불러오는 중" />
      </p>,
    );
    const status = screen.getByRole("status", { name: "읽지 않은 수 불러오는 중" });
    expect(status.tagName).toBe("SPAN");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.className.split(/\s+/)).toEqual(expect.arrayContaining(["inline-block", "align-middle", "relative"]));
    // 글 요소(p) 안에 둘 수 있게 div가 없고, lines·height는 보지 않습니다(막대 하나).
    expect(container.querySelector("div")).toBeNull();
    const [bar, ...rest] = bars(status);
    expect(rest).toHaveLength(0);
    expect(bar.tagName).toBe("SPAN");
    expect(bar.style.height).toBe("");
    // 12px 높이(text-xs 글줄 16px 안) · 짧은 폭, 바탕·고대비 테두리·깜빡임은 블록·줄과 같은 규칙.
    expect(bar.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["block", "h-3", "w-6", "rounded-control", "bg-control-fill", "motion-safe:animate-pulse", "forced-colors:border"]),
    );
    expect(status.textContent).toBe("읽지 않은 수 불러오는 중");
    expect(screen.getByText("읽지 않은 수 불러오는 중").className).toContain("sr-only");
  });

  it("네 상태를 흉내 내지 않는다 — 숫자·'—'·추정·이전 값 무엇도 그리지 않는다", () => {
    const { container } = render(<Skeleton />);
    expect(container.textContent).toBe("불러오는 중");
    expect(screen.queryByText("—")).toBeNull();
    expect(screen.queryByText("추정")).toBeNull();
    expect(screen.queryByText("이전 값")).toBeNull();
  });
});
