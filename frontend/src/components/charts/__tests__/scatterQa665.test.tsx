/**
 * QA-665 — 산점도(ScatterPlot, /correlation)에 Y축 이름·단위가 없던 것(X축만 '연준 순유동성 (조 달러)'). Y 값(±50 — 나스닥 100 $ 변화)이 무엇인지는
 * '고른 쌍' 패널이나 마우스 툴팁으로만 알 수 있었습니다(QA 스택 390·1024·1440 모두 text.recharts-label 하나). 산점도를 처음 만든 때부터 YAxis에 label이
 * 없었습니다(yLabel은 툴팁 이름으로만 씀).
 *
 * 실제 Recharts로 그린 축 이름(text.recharts-label)을 읽습니다. jsdom에는 크기가 없어 ResponsiveContainer가 너비를 모르므로 관찰을 시작하면 정한 크기를
 * 바로 알려 주는 가짜를 씁니다(scatterQa615·wrappers.test와 같음).
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

const POINTS = [{ x: 1, y: 2, date: "2026-01-02" }, { x: -1, y: 0.5, date: "2026-01-09" }];

/** 그린 축 이름 — text.recharts-label의 글과 글자 크기(속성 또는 인라인 style). */
function axisLabels(container: HTMLElement): { text: string; size: number }[] {
  return [...container.querySelectorAll("text.recharts-label")].map((node) => ({
    text: node.textContent ?? "",
    size: Number(node.getAttribute("font-size") ?? (node as SVGElement).style.fontSize.replace("px", "")),
  }));
}

describe("QA-665 산점도의 Y축 이름·단위", () => {
  // 수정 전(재현 커밋에서는 it.fails) 축 이름은 X축 하나('금리 변화 (%p)')뿐이었습니다.
  it.fails("Y축 이름이 단위와 함께 X축 이름과 같은 12px 이상으로 그려진다", () => {
    observeAs(600, 320);
    const { container } = render(<ScatterPlot data={POINTS} xLabel="금리 변화" yLabel="지수 변화" xUnit="%p" yUnit="$" />);
    const labels = axisLabels(container);
    expect(labels.map((label) => label.text)).toEqual(expect.arrayContaining(["금리 변화 (%p)", "지수 변화 ($)"]));
    const y = labels.find((label) => label.text === "지수 변화 ($)");
    expect(y?.size).toBeGreaterThanOrEqual(12);
    expect(y?.size).toBe(labels.find((label) => label.text === "금리 변화 (%p)")?.size);
  });

  // 수정 전(재현 커밋에서는 it.fails) Y축 이름이 없었습니다.
  it.fails("Y 단위가 빈 글이면 괄호 없이 이름만", () => {
    observeAs(600, 320);
    const { container } = render(<ScatterPlot data={POINTS} xLabel="금리 변화" yLabel="지수 변화" xUnit="%p" yUnit="" />);
    const texts = axisLabels(container).map((label) => label.text);
    expect(texts).toContain("지수 변화");
    expect(texts.some((text) => text.startsWith("지수 변화 ("))).toBe(false);
  });
});
