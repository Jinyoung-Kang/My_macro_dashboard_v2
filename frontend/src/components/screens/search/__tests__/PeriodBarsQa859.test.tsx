/**
 * 정보 검색 기간 막대 — 넓은 화면(lg 이상)에 막대 말고는 날·주를 고를 조작이 없음(QA-859, D1 결정 거리 1 '정보 검색 기간 막대(lg 이상)' — 사용자 결정 거리 U3
 * 권장안: 넓은 화면에도 '날로/주로 좁히기' 고르기를 함께 두고 막대는 지름길로).
 *
 * 넓은 화면의 막대 하나는 4~18.7px 폭의 누르는 단추라 WCAG 2.5.8(24px)에 못 미치고, 좁은 화면에만 있던 44px 고르기 상자(lg:hidden)가 넓은 화면에는
 * 없었습니다(개편 전부터). 같은 일을 하는 24px 이상의 조작이 있으면 2.5.8의 '같은 일을 하는 다른 조작' 예외에 듭니다. 기대: 고르기 상자를 모든 폭에 두고
 * (lg 미만은 지금처럼 44px 줄, lg 이상은 이름표 옆 작은 상자), 막대는 그대로 지름길(도구 막대·←→·누르기)입니다. 고르면 막대를 누른 것과 같은 좁히기입니다.
 * jsdom은 미디어 쿼리를 풀지 않으므로 숨김 클래스로 봅니다.
 * 수정 전(재현 커밋에서는 첫 사례 it.fails): "expected [ 'w-full', 'max-w-full', …(36) ] to not include 'lg:hidden'".
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PeriodBarsView } from "@/lib/infoSearch";
import { PeriodBars } from "../PeriodBars";

const BARS: PeriodBarsView = {
  unit: "day",
  bins: [
    { start: "2026-11-12", end: "2026-11-12", count: 2 },
    { start: "2026-11-13", end: "2026-11-13", count: 0 },
    { start: "2026-11-14", end: "2026-11-14", count: 3 },
  ],
  max: 3,
  offChart: 0,
};

afterEach(() => cleanup());

/** 요소에서 PeriodBars 뿌리까지 조상(자신 포함)의 클래스. */
function ancestorClasses(element: HTMLElement, root: HTMLElement): string[] {
  const out: string[] = [];
  for (let node: HTMLElement | null = element; node && node !== root.parentElement; node = node.parentElement) {
    out.push(...(node.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));
  }
  return out;
}

describe("기간 막대의 넓은 화면 대체 고르기(QA-859)", () => {
  it.fails("'날로 좁히기' 고르기 상자는 모든 폭에 있다 — 조상에 lg:hidden 없음, 막대 줄(도구 막대)도 그대로", () => {
    const { container } = render(<PeriodBars bars={BARS} active={null} onToggle={() => {}} onClear={() => {}} />);
    const select = screen.getByLabelText("날로 좁히기");
    expect(select.tagName).toBe("SELECT");
    expect(ancestorClasses(select, container.firstElementChild as HTMLElement)).not.toContain("lg:hidden");
    expect(screen.getByRole("toolbar", { name: /기간 막대/ })).toBeTruthy();
  });

  it("고르면 막대를 누른 것과 같은 좁히기 — 건수가 있는 칸만 최근부터", () => {
    const onToggle = vi.fn();
    render(<PeriodBars bars={BARS} active={null} onToggle={onToggle} onClear={() => {}} />);
    const select = screen.getByLabelText("날로 좁히기") as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(["", "2026-11-14", "2026-11-12"]);
    fireEvent.change(select, { target: { value: "2026-11-12" } });
    expect(onToggle).toHaveBeenCalledWith(BARS.bins[0]);
  });
});
