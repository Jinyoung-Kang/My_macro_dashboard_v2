/**
 * Sparkline — 작은 추이 선(설계서 §6).
 * 값 있음(선 하나, 보조 글자색), 값 없음(알려진 점 2개 미만이면 그리지 않음), null에서 끊김(조각 여럿·혼자 남은 점),
 * 추정·오래됨(선은 같은 모양 — 판정을 전하지 않으므로 배지는 옆에서), a11y(기본 aria-hidden, label이면 role="img" + 이름).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { EstimateBadge, StaleBadge } from "../badges";
import { Sparkline } from "../Sparkline";

afterEach(() => cleanup());

describe("Sparkline", () => {
  it("값 있음 — 선 하나, 색은 var(--text-2), 읽어 주기에서 뺀다", () => {
    const { container } = render(<Sparkline values={[1, 3, 2, 4]} width={80} height={24} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
    expect(svg!.getAttribute("role")).toBeNull();
    expect(svg!.getAttribute("width")).toBe("80");
    expect(svg!.getAttribute("viewBox")).toBe("0 0 80 24");
    const lines = container.querySelectorAll("polyline");
    expect(lines).toHaveLength(1);
    expect(lines[0].getAttribute("points")!.split(" ")).toHaveLength(4);
    expect(lines[0].getAttribute("style")).toContain("var(--text-2)");
    expect(lines[0].getAttribute("fill")).toBe("none");
  });

  it("값 없음 — 알려진 점이 2개 미만이면 아무것도 그리지 않는다", () => {
    for (const values of [[], [5], [null, null], [null, 7, null]]) {
      const { container } = render(<Sparkline values={values} />);
      expect(container.innerHTML).toBe("");
      cleanup();
    }
  });

  it("null에서 선을 끊는다 — 조각마다 polyline, 혼자 남은 점은 circle", () => {
    const { container } = render(<Sparkline values={[1, 2, null, 3, 4, null, 5]} />);
    expect(container.querySelectorAll("polyline")).toHaveLength(2);
    const dots = container.querySelectorAll("circle");
    expect(dots).toHaveLength(1);
    expect(dots[0].getAttribute("style")).toContain("var(--text-2)");
  });

  it("추정·오래됨 — 선은 같은 모양·같은 색, 옆 배지가 함께 보인다", () => {
    const { container } = render(
      <span>
        <Sparkline values={[1, 3, 2]} />
        <EstimateBadge estimated />
        <StaleBadge stale reason="이번 수집 실패" />
      </span>,
    );
    const lines = container.querySelectorAll("polyline");
    expect(lines).toHaveLength(1);
    expect(lines[0].getAttribute("style")).toContain("var(--text-2)");
    expect(screen.getByText("추정")).toBeTruthy();
    expect(screen.getByText("이전 값")).toBeTruthy();
  });

  it("label이 있으면 role=img + 그 이름으로 읽힌다", () => {
    render(<Sparkline values={[1, 2, 3]} label="S&P 500 최근 30일 추이" />);
    const img = screen.getByRole("img", { name: "S&P 500 최근 30일 추이" });
    expect(img.getAttribute("aria-hidden")).toBeNull();
  });

  it("빈 label은 없는 것으로 — aria-hidden 유지", () => {
    const { container } = render(<Sparkline values={[1, 2]} label="  " />);
    expect(container.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("img")).toBeNull();
  });
});
