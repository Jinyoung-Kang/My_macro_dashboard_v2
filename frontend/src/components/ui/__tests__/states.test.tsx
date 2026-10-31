/**
 * 배너·상태 조각(ui/index.tsx의 Banner·Loading·EmptyState·ErrorState) — 명세 docs/specs/2026-10-31-v2-coinbase-ui.md §3.
 *  - 배너 네 톤은 모두 불투명 틴트 바탕(놓인 자리와 섞이지 않음)과 톤 글자색 — 안내(info)만 글이 본문색(강조 파랑 글자 아님, 원칙 A1)
 *  - 불러오는 중은 도는 아이콘(움직임 줄이기면 멈춤 — motion-safe에서만) + 글, 강조색 점이 아니다
 *  - 오류는 danger 틴트·장식 아이콘·글, 다시 시도는 공용 단추
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Banner, EmptyState, ErrorState, Loading } from "@/components/ui";

afterEach(() => cleanup());

describe("Banner", () => {
  it.each([
    ["warn", "bg-warn-tint", "text-warn"],
    ["danger", "bg-danger-tint", "text-danger"],
    ["info", "bg-accent-tint", "text-text"],
    ["ok", "bg-ok-tint", "text-ok"],
  ] as const)("%s — 불투명 틴트 %s와 글자색 %s", (tone, tint, text) => {
    const { container } = render(<Banner tone={tone}>값의 성격 안내</Banner>);
    expect(screen.getByText("값의 성격 안내")).toBeTruthy();
    const classes = (container.firstElementChild as HTMLElement).className.split(/\s+/);
    expect(classes).toContain(tint);
    expect(classes).toContain(text);
    expect(classes.some((name) => /\/10$/.test(name) && name.startsWith("bg-"))).toBe(false);
  });

  it("기본 톤은 주의(warn)이고, 안내 톤은 강조 파랑 글자를 쓰지 않는다", () => {
    const { container } = render(
      <>
        <Banner>기본</Banner>
        <Banner tone="info">안내</Banner>
      </>,
    );
    const [basic, info] = [...container.children] as HTMLElement[];
    expect(basic.className).toContain("text-warn");
    expect(info.className).not.toContain("text-accent");
    expect(info.querySelector(".text-accent")?.textContent ?? "").not.toContain("안내");
  });
});

describe("상태 조각", () => {
  it("불러오는 중 — 글과 도는 장식 아이콘(motion-safe에서만 돎), 강조색 점 없음", () => {
    const { container } = render(<Loading label="순자산을 불러오는 중…" />);
    expect(screen.getByText("순자산을 불러오는 중…")).toBeTruthy();
    const spinner = container.querySelector("svg") as SVGSVGElement;
    expect(spinner.getAttribute("aria-hidden")).toBe("true");
    expect(spinner.getAttribute("class")).toContain("motion-safe:animate-spin");
    expect(container.querySelector(".bg-accent")).toBeNull();
  });

  it("빈 상태 — 점선 상자가 아니라 옅은 바탕의 가운데 글", () => {
    render(<EmptyState message="표시할 데이터가 없습니다." />);
    const box = screen.getByText("표시할 데이터가 없습니다.");
    expect(box.className).not.toContain("border-dashed");
    expect(box.className).toContain("text-center");
  });

  it("오류 — danger 틴트·장식 아이콘·글, 다시 시도를 누르면 onRetry", () => {
    const onRetry = vi.fn();
    const { container } = render(<ErrorState message="읽지 못했습니다." onRetry={onRetry} />);
    expect(screen.getByText("읽지 못했습니다.")).toBeTruthy();
    expect((container.firstElementChild as HTMLElement).className).toContain("bg-danger-tint");
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("다시 시도가 없으면 단추도 없다", () => {
    render(<ErrorState message="읽지 못했습니다." />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
