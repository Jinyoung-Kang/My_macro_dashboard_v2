/**
 * QA-941(작업대 결정 거리 chart-negative-ascii-hyphen-cot-correlation — P8): 공용 차트(LineSeries·MultiLineSeries·ScatterPlot·HorizontalBars·SignedBars, 새 선 차트
 * LineChart의 기본 서식)의 눈금·툴팁·막대 끝 값의 음수가 ASCII 하이픈 '-'입니다 — `lib/format formatNumber`(toLocaleString 글)를 그대로 써서. 화면의 다른 음수
 * (변화 칩·KPI·표 칸 — U+2212 '−')와 기호가 섞였습니다.
 *
 * 기대: 차트가 그리는 음수는 U+2212(−). formatNumber 자체는 그대로 두고 차트 전용 서식(formatChartNumber)으로 좁힙니다 — formatNumber는 63곳이 쓰고 그 글이
 * formatSigned·복사 글 등으로 이어집니다. 양수·0·모름은 예전 글 그대로.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 사례마다 '-' 글이 남음 — 예 'expected [ '-2.00조', … ] to deeply equal …'.
 */
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HorizontalBars, LineSeries, MultiLineSeries, ScatterPlot, SERIES_COLORS, SignedBars } from "@/components/charts";
import { LineChart } from "@/components/charts/LineChart";

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

const texts = (nodes: Iterable<Element>) => [...nodes].map((node) => node.textContent ?? "");
const yTicks = (container: HTMLElement) => texts(container.querySelectorAll(".recharts-yAxis-tick-labels text"));
const xTicks = (container: HTMLElement) => texts(container.querySelectorAll(".recharts-xAxis-tick-labels text"));
/** 숫자 앞 ASCII 하이픈이 있는 글 — 날짜('2026-01-02')의 하이픈은 숫자 사이라 걸리지 않음. */
const asciiNegative = (values: readonly string[]) => values.filter((value) => /(^|[^\d])-\d/.test(value));
const unicodeNegative = (values: readonly string[]) => values.filter((value) => value.includes("−"));

const SPREAD = [
  { date: "2026-01-02", value: -1.5 },
  { date: "2026-04-01", value: 0.4 },
  { date: "2026-07-01", value: -0.8 },
  { date: "2026-10-24", value: 1.2 },
];

describe("QA-941 차트 음수는 U+2212(−)", () => {
  it.fails("LineSeries — Y 눈금과 툴팁", async () => {
    observeAs(600, 260);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, x: 0, y: 0, width: 600, height: 260, right: 600, bottom: 260, toJSON: () => ({}),
    } as DOMRect);
    const { container } = render(<LineSeries data={SPREAD} unit="%p" precision={1} zeroLine />);
    const ticks = yTicks(container);
    expect(asciiNegative(ticks)).toEqual([]);
    expect(unicodeNegative(ticks).length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.mouseMove(container.querySelector(".recharts-wrapper") as Element, { clientX: 45, clientY: 100 });
    });
    const tooltip = container.querySelector(".recharts-tooltip-wrapper") as HTMLElement;
    expect(await within(tooltip).findByText("−1.50%p")).toBeTruthy();
  });

  it.fails("LineChart 기본 서식 — Y 눈금", () => {
    observeAs(600, 260);
    const { container } = render(
      <LineChart data={SPREAD.map((row) => ({ date: row.date, v: row.value }))} series={[{ key: "v", label: "합성", color: SERIES_COLORS.blue }]} includeZero />,
    );
    const ticks = yTicks(container);
    expect(asciiNegative(ticks)).toEqual([]);
    expect(unicodeNegative(ticks).length).toBeGreaterThan(0);
  });

  it.fails("MultiLineSeries — 왼쪽·오른쪽 축 눈금", () => {
    observeAs(600, 300);
    const { container } = render(
      <MultiLineSeries
        data={SPREAD.map((row) => ({ date: row.date, a: row.value * 1_000, b: row.value }))}
        series={[
          { key: "a", name: "합성 왼쪽", color: SERIES_COLORS.blue },
          { key: "b", name: "합성 오른쪽", color: SERIES_COLORS.orange, axis: "right" },
        ]}
        zeroLine
        precision={0}
      />,
    );
    const ticks = yTicks(container);
    expect(asciiNegative(ticks)).toEqual([]);
    expect(unicodeNegative(ticks).length).toBeGreaterThan(1);
  });

  it.fails("HorizontalBars — 막대 끝 값", () => {
    observeAs(600, 360);
    const { container } = render(<HorizontalBars data={[{ name: "가상 하나", value: 120.5 }, { name: "가상 둘", value: -40.2 }]} unit="억" />);
    const labels = texts(container.querySelectorAll("text"));
    expect(labels).toContain("−40.2억");
    expect(asciiNegative(labels)).toEqual([]);
  });

  it.fails("SignedBars — 값 축 눈금", () => {
    observeAs(600, 300);
    const { container } = render(<SignedBars data={[{ name: "1월", value: 3 }, { name: "2월", value: -2 }]} unit="%" />);
    const ticks = yTicks(container);
    expect(asciiNegative(ticks)).toEqual([]);
    expect(unicodeNegative(ticks).length).toBeGreaterThan(0);
  });

  it.fails("ScatterPlot — 두 축 눈금", () => {
    observeAs(600, 300);
    const { container } = render(
      <ScatterPlot data={[{ x: 1, y: 2, date: "a" }, { x: -1, y: -0.5, date: "b" }]} xLabel="합성 가로" yLabel="합성 세로" />,
    );
    const ticks = [...xTicks(container), ...yTicks(container)];
    expect(asciiNegative(ticks)).toEqual([]);
    expect(unicodeNegative(ticks).length).toBeGreaterThan(1);
  });

  it("양수·0 눈금은 예전 글 그대로(부호 없음)", () => {
    observeAs(600, 260);
    const { container } = render(<LineSeries data={[{ date: "2026-01-02", value: 0 }, { date: "2026-10-24", value: 2 }]} unit="조" precision={1} />);
    expect(yTicks(container).every((tick) => !tick.includes("−") && !tick.startsWith("-"))).toBe(true);
  });
});
