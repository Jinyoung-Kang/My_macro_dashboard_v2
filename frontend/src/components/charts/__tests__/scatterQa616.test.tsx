/**
 * QA-616 — 산점도(ScatterPlot, /correlation)가 보조기기에서 뺀(aria-hidden) 감싸개 안에 Tab 정지점(svg tabindex=0)을 남기던 것
 * (D1 넘김 'chart-application-role-unnamed'의 산점도 몫).
 *
 * 산점도는 점마다 이름 없는 그림이 되어 통째로 aria-hidden 상자 안에 둡니다(상관계수·표본 수는 옆에 글로 있음). 그런데 Recharts 3.10.1 접근성 층
 * (accessibilityLayer — 기본 켬)이 그림(svg)에 role="application"·tabindex=0을 달아, 키보드 사용자는 읽어 주지 않는(이름도 역할도 없는) 자리에
 * 멈췄습니다(WCAG 4.1.2 — aria-hidden 안의 포커스 받는 요소). 그림 안에 포커스 받는 요소가 하나도 없어야 합니다.
 *
 * jsdom에는 크기가 없어 ResponsiveContainer가 너비를 모르므로 관찰을 시작하면 정한 크기를 바로 알려 주는 가짜를 씁니다(wrappers.test와 같음).
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScatterPlot } from "@/components/charts";

function observeAs(width: number, height: number) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe() {
        this.callback([{ contentRect: { width, height } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    },
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 포커스를 받는(Tab 차례에 드는) 요소 — tabindex가 0 이상이거나 본래 포커스를 받는 요소(tabindex −1이 아니면). */
const FOCUSABLE = '[tabindex]:not([tabindex^="-"]), a[href], button, input, select, textarea, [contenteditable="true"]';

describe("QA-616 산점도의 숨은 Tab 정지점", () => {
  // 고치기 전: 감싸개 안에 'svg tabindex=0 role=application' 하나(Recharts 접근성 층) — 재현 커밋에서는 it.fails. 고침은 accessibilityLayer={false}.
  it("aria-hidden 감싸개 안에 포커스 받는 요소가 없고, 그림(svg)에 role=application이 없다", () => {
    observeAs(600, 320);
    const { container } = render(
      <ScatterPlot data={[{ x: 1, y: 2, date: "2026-01-02" }, { x: -1, y: 0.5, date: "2026-01-09" }]} xLabel="금리 변화" yLabel="지수 변화" />,
    );
    const hidden = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(hidden).not.toBeNull();
    // 점이 실제로 그려진 그림을 봅니다(빈 그림이면 시험이 뜻이 없음).
    expect(hidden.querySelectorAll("path.recharts-symbols")).toHaveLength(2);
    const stops = [...hidden.querySelectorAll(FOCUSABLE)].map(
      (element) => `${element.tagName.toLowerCase()} tabindex=${element.getAttribute("tabindex")} role=${element.getAttribute("role")}`,
    );
    expect(stops).toEqual([]);
    expect(hidden.querySelector("svg.recharts-surface")?.getAttribute("role")).toBeNull();
  });
});
