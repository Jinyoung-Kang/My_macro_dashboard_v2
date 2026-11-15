/**
 * 차트 래퍼의 격자 없는 단일 선 문법(명세 docs/specs/2026-10-31-v2-coinbase-ui.md §5·D9) — 실제 Recharts로 그려 봅니다.
 *
 *  - LineSeries(옛 화면): 격자·면적 그라디언트 없음, Y축은 끝·중간의 둥근 눈금(precision + 단위), X축 첫·마지막과 중간 날짜, 툴팁은 한 자리 더
 *  - MultiLineSeries: 격자·Recharts 범례 없음, 글자 범례(두 계열 이상 — 점선 계열은 점선 표지, 이름은 부르는 쪽 그대로),
 *    Y축 둥근 눈금(데이터 범위를 그 간격의 배수로 — 고정 domain이면 그 안의 둥근 간격, 오른쪽 축도), X축 중간 날짜, 모든 칸이 모름이면 빈 상태
 *  - MultiLineSeries 꼬리 계열(tailOf — 장중 값 단계의 오늘 추정 점선): 범례 없음, 점선 "3 3"(참고선 "6 4"와 다름), 툴팁 줄은 꼬리 점에만
 *    (꼬리가 시작하는 마지막 줄에서는 없음 — Recharts가 formatter의 null을 그리지 않음), 앞 값 없는 외딴 꼬리 점은 점
 *  - 막대(HorizontalBars·SignedBars): 격자 없음, 0 기준선(text-3)
 *  - 산점도는 늘 옅은 격자(border-subtle)
 *  - 격자 선택(grid — 작업대 실행 명세 W6): LineSeries·MultiLineSeries·SignedBars는 grid면 Y 눈금 자리에만 옅은 가로 격자(border-subtle 1px), 세로 격자 없음
 *  - SVG 글자는 모두 12px 이상(축·막대 끝 값·표시선 이름), 툴팁 상자는 덮개 모양(그림자·12px 모서리)
 *
 * jsdom에는 크기가 없어 ResponsiveContainer가 너비를 모릅니다 — 관찰을 시작하면 정한 크기를 바로 알려 주는 가짜를 씁니다(LineChart.test와 같음).
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HorizontalBars, LineSeries, MultiLineSeries, ScatterPlot, SERIES_COLORS, SignedBars } from "@/components/charts";
import { REFERENCE_DASH } from "@/components/charts/frame";

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

const texts = (nodes: Iterable<Element>) => [...nodes].map((node) => node.textContent);
const yTicks = (container: HTMLElement) => texts(container.querySelectorAll(".recharts-yAxis-tick-labels text"));

/** 그림 안 모든 SVG 글자의 크기 — 12px 미만이 없어야 합니다(명세 D9). */
function svgFontSizes(container: HTMLElement): number[] {
  return [...container.querySelectorAll("svg text")]
    .map((node) => Number(node.getAttribute("font-size") ?? (node as SVGElement).style.fontSize.replace("px", "")))
    .filter((size) => Number.isFinite(size) && size > 0);
}

const LIQUIDITY = [
  { date: "2026-01-02", value: 5.85 },
  { date: "2026-04-01", value: null },
  { date: "2026-07-01", value: 5.97 },
  { date: "2026-10-24", value: 6.0 },
];

describe("LineSeries(옛 화면) — 새 선 차트 문법", () => {
  it("격자·면적 그라디언트 없음, Y는 끝·중간의 둥근 눈금(precision + 단위), X는 첫·마지막과 중간 날짜, 글자 12px", () => {
    observeAs(600, 260);
    const { container } = render(<LineSeries data={LIQUIDITY} unit="조" precision={2} />);
    expect(container.querySelector(".recharts-cartesian-grid")).toBeNull();
    expect(container.querySelector("linearGradient")).toBeNull();
    expect(container.querySelector(".recharts-area")).toBeNull();
    expect(yTicks(container)).toEqual(["5.80조", "5.85조", "5.90조", "5.95조", "6.00조", "6.05조"]);
    expect(texts(container.querySelectorAll(".recharts-xAxis-tick-labels text"))).toEqual(["2026-01-02", "04-01", "07-01", "2026-10-24"]);
    const line = container.querySelector("path.recharts-line-curve") as SVGPathElement;
    expect(line.getAttribute("stroke")).toBe(SERIES_COLORS.blue);
    expect(svgFontSizes(container).every((size) => size >= 12)).toBe(true);
  });

  it("툴팁은 눈금보다 한 자리 더(정확한 값 확인) — 상자는 덮개 모양", async () => {
    observeAs(600, 260);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, x: 0, y: 0, width: 600, height: 260, right: 600, bottom: 260, toJSON: () => ({}),
    } as DOMRect);
    const { container } = render(<LineSeries data={LIQUIDITY} unit="조" precision={2} />);
    await act(async () => {
      fireEvent.mouseMove(container.querySelector(".recharts-wrapper") as Element, { clientX: 560, clientY: 100 });
    });
    const tooltip = container.querySelector(".recharts-tooltip-wrapper") as HTMLElement;
    expect(await within(tooltip).findByText("6.000조")).toBeTruthy();
    const box = tooltip.firstElementChild as HTMLElement;
    expect(box.style.boxShadow).toBe("var(--elev-overlay)");
    expect(box.style.borderRadius).toBe("4px");
  });

  it("값이 모두 없으면 빈 상태 문구(0 축을 지어내지 않음)", () => {
    observeAs(600, 260);
    const { container } = render(<LineSeries data={[{ date: "a", value: null }]} />);
    expect(screen.getByText("표시할 시계열이 없습니다.")).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();
  });
});

describe("MultiLineSeries — 격자 없는 여러 선", () => {
  const ROWS = [
    { date: "2026-10-01", a: 100, b: 98, oi: 300_000 },
    { date: "2026-10-02", a: 101, b: 99, oi: 310_000 },
    { date: "2026-10-03", a: 103, b: null, oi: 305_000 },
  ];

  it("격자·Recharts 범례 없음, 글자 범례(점선 표지), 두 축 모두 둥근 눈금, 중간 날짜, 표시선 이름 12px", () => {
    observeAs(600, 300);
    const { container } = render(
      <MultiLineSeries
        data={ROWS}
        series={[
          { key: "a", name: "종가", color: SERIES_COLORS.blue },
          { key: "b", name: "참고선", color: "#a371f7", dashed: true },
          { key: "oi", name: "미결제약정 (우)", color: SERIES_COLORS.orange, axis: "right" },
        ]}
        markers={[{ x: "2026-10-02", label: "프레임 v1" }]}
        ariaLabel="종가와 미결제약정"
      />,
    );
    expect(container.querySelector(".recharts-cartesian-grid")).toBeNull();
    expect(container.querySelector(".recharts-legend-wrapper")).toBeNull();
    const legend = screen.getByRole("list", { name: "범례" });
    const items = within(legend).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["종가", "참고선", "미결제약정 (우)"]);
    const swatch = (item: HTMLElement) => item.querySelector('svg[aria-hidden="true"] line') as SVGLineElement;
    expect(swatch(items[1]).getAttribute("stroke-dasharray")).toBe(REFERENCE_DASH);
    expect(swatch(items[0]).getAttribute("stroke-dasharray")).toBeNull();
    // 왼쪽 축은 데이터 범위 98~103을 2 간격으로(0 바닥을 지어내지 않음), 오른쪽 축은 30만대를 5,000 간격으로
    expect(yTicks(container)).toEqual([
      "96.0", "98.0", "100.0", "102.0", "104.0",
      "295,000", "300,000", "305,000", "310,000", "315,000",
    ]);
    expect(texts(container.querySelectorAll(".recharts-xAxis-tick-labels text"))).toEqual(["2026-10-01", "10-02", "2026-10-03"]);
    expect(screen.getByText("프레임 v1")).toBeTruthy();
    expect(svgFontSizes(container).every((size) => size >= 12)).toBe(true);
    expect(container.querySelector("svg.recharts-surface")?.getAttribute("aria-label")).toBe("종가와 미결제약정");
  });

  // QA-496: 점선 계열(K40 참고선)의 범례 견본은 폭 12px span의 border-top 2px dashed였는데, 크롬은 굵기 2px에서 길이가 토막 6px × 2 이하인
  // dashed 테두리를 실선으로 칠합니다(12px 실선, 14px부터 끊김 — /paper/kr 390·1024·1440). 견본을 그림 선과 같은 SVG 선(stroke-dasharray
  // REFERENCE_DASH '6 4')으로, 한 주기(6 + 4 + 6 = 16px) 이상 길게 그려야 엔진과 무관하게 점선으로 보입니다. 재현 커밋에서는 it.fails였습니다.
  it("QA-496: 점선 계열 견본은 SVG 선(stroke-dasharray '6 4', 길이 16px 이상), 실선 계열 견본은 dasharray 없음", () => {
    observeAs(600, 300);
    render(
      <MultiLineSeries
        data={ROWS}
        series={[
          { key: "a", name: "종가", color: SERIES_COLORS.blue },
          { key: "b", name: "참고선", color: "#a7b0bd", dashed: true },
        ]}
      />,
    );
    const items = within(screen.getByRole("list", { name: "범례" })).getAllByRole("listitem");
    const line = (item: HTMLElement) => item.querySelector('svg[aria-hidden="true"] line');
    const dashed = line(items[1]);
    expect(dashed, "점선 견본 svg line").not.toBeNull();
    expect(dashed?.getAttribute("stroke-dasharray")).toBe(REFERENCE_DASH);
    expect(dashed?.getAttribute("stroke")).toBe("#a7b0bd");
    expect(Number(dashed?.getAttribute("x2")) - Number(dashed?.getAttribute("x1"))).toBeGreaterThanOrEqual(16);
    const solid = line(items[0]);
    expect(solid, "실선 견본 svg line").not.toBeNull();
    expect(solid?.getAttribute("stroke-dasharray")).toBeNull();
    expect(solid?.getAttribute("stroke")).toBe(SERIES_COLORS.blue);
  });

  it("표시선 이름은 선 오른쪽, 마지막 날짜의 선은 왼쪽(그림 끝에서 잘리지 않게)", () => {
    observeAs(600, 300);
    const { container } = render(
      <MultiLineSeries
        data={ROWS}
        series={[{ key: "a", name: "종가", color: SERIES_COLORS.blue }]}
        markers={[{ x: "2026-10-01", label: "프레임 v1" }, { x: "2026-10-03", label: "프레임 v5" }]}
      />,
    );
    const anchorOf = (text: string) =>
      [...container.querySelectorAll("text.recharts-label")].find((node) => node.textContent === text)?.getAttribute("text-anchor");
    expect(anchorOf("프레임 v1")).toBe("start");
    expect(anchorOf("프레임 v5")).toBe("end");
  });

  it("계열 하나면 범례 없음, 고정 domain이면 그 범위 안의 둥근 간격(0~100 → 25)", () => {
    observeAs(600, 300);
    const { container } = render(
      <MultiLineSeries data={ROWS} series={[{ key: "a", name: "노출", color: SERIES_COLORS.blue }]} domain={[0, 100]} unit="%" precision={0} />,
    );
    expect(screen.queryByRole("list", { name: "범례" })).toBeNull();
    expect(texts(container.querySelectorAll(".recharts-yAxis-tick-labels text"))).toEqual(["0%", "25%", "50%", "75%", "100%"]);
  });

  it("행이 없거나 모든 칸이 모름이면 빈 상태 문구", () => {
    observeAs(600, 300);
    render(<MultiLineSeries data={[]} series={[{ key: "a", name: "A", color: SERIES_COLORS.blue }]} />);
    expect(screen.getByText("표시할 시계열이 없습니다.")).toBeTruthy();
    cleanup();
    observeAs(600, 300);
    const { container } = render(
      <MultiLineSeries data={[{ date: "a", x: null }, { date: "b", x: null }]} series={[{ key: "x", name: "X", color: SERIES_COLORS.blue }]} />,
    );
    expect(screen.getByText("표시할 시계열이 없습니다.")).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();
  });
});

describe("MultiLineSeries — 꼬리 계열(tailOf)", () => {
  const ROWS = [
    { date: "2026-10-27", rules: 100_000, spy: 100_100, ref: 100_000, "rules~": null, "spy~": null },
    { date: "2026-10-28", rules: 100_400, spy: 100_300, ref: 100_200, "rules~": null, "spy~": null },
    { date: "2026-10-29", rules: 100_200, spy: null, ref: 100_100, "rules~": 100_200, "spy~": null },
    { date: "2026-10-30", rules: null, spy: null, ref: null, "rules~": 100_600, "spy~": 100_700 },
  ];
  const SERIES = [
    { key: "rules", name: "규칙 계좌", color: SERIES_COLORS.blue },
    { key: "spy", name: "SPY 계좌", color: SERIES_COLORS.green },
    { key: "ref", name: "참고선(계좌 아님)", color: "#a371f7", dashed: true },
    { key: "rules~", name: "규칙 계좌 · 추정 23:58", color: SERIES_COLORS.blue, tailOf: "rules" },
    { key: "spy~", name: "SPY 계좌 · 장부", color: SERIES_COLORS.green, tailOf: "spy" },
  ];

  function sizeAs(width: number, height: number) {
    observeAs(width, height);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, x: 0, y: 0, width, height, right: width, bottom: height, toJSON: () => ({}),
    } as DOMRect);
  }

  it("범례에 꼬리가 없고, 꼬리는 점선 3 3(참고선 6 4와 다름), 앞 값 없는 외딴 꼬리 점은 점", () => {
    observeAs(600, 300);
    const { container } = render(<MultiLineSeries data={ROWS} series={SERIES} precision={0} ariaLabel="순자산 곡선" />);
    const legend = screen.getByRole("list", { name: "범례" });
    expect(within(legend).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["규칙 계좌", "SPY 계좌", "참고선(계좌 아님)"]);
    const curves = [...container.querySelectorAll("path.recharts-line-curve")];
    expect(curves.map((path) => path.getAttribute("stroke-dasharray"))).toEqual([null, null, "6 4", "3 3", "3 3"]);
    // SPY 계좌는 마지막 줄이 없어 꼬리가 점 하나뿐 — 사라지지 않게 그 계좌 색 점으로(본 계열에는 점을 찍지 않던 그대로)
    const dots = [...container.querySelectorAll(".recharts-line-dots circle")];
    expect(dots.map((dot) => dot.getAttribute("fill"))).toEqual([SERIES_COLORS.green]);
  });

  it("툴팁 — 꼬리 점에서는 꼬리 이름과 값, 꼬리가 시작하는 마지막 줄에서는 꼬리 줄이 없다", async () => {
    sizeAs(600, 300);
    const { container } = render(<MultiLineSeries data={ROWS} series={SERIES} precision={0} />);
    const wrapper = container.querySelector(".recharts-wrapper") as Element;
    const tooltip = () => container.querySelector(".recharts-tooltip-wrapper") as HTMLElement;
    // 줄 순서는 Recharts가 이름으로 정렬합니다(기본 itemSorter) — 어떤 줄이 있는지만 봅니다.
    const names = () => texts(tooltip().querySelectorAll(".recharts-tooltip-item-name")).sort();

    await act(async () => {
      fireEvent.mouseMove(wrapper, { clientX: 590, clientY: 100 });
    });
    expect(await within(tooltip()).findByText("2026-10-30")).toBeTruthy();
    expect(names()).toEqual(["SPY 계좌 · 장부", "규칙 계좌 · 추정 23:58"].sort());
    expect(within(tooltip()).getByText("100,600.00")).toBeTruthy();

    await act(async () => {
      fireEvent.mouseMove(wrapper, { clientX: 400, clientY: 100 });
    });
    expect(await within(tooltip()).findByText("2026-10-29")).toBeTruthy();
    expect(names()).toEqual(["규칙 계좌", "참고선(계좌 아님)"].sort());
  });
});

describe("막대·산점도", () => {
  it("가로 막대 — 격자 없음, 0 기준선(text-3), 막대 끝 값 글자 12px", () => {
    observeAs(600, 360);
    const { container } = render(
      <HorizontalBars data={[{ name: "삼성전자", value: 120.5 }, { name: "SK하이닉스", value: -40.2 }]} unit="억" />,
    );
    expect(container.querySelector(".recharts-cartesian-grid")).toBeNull();
    expect(container.querySelector(".recharts-reference-line line")?.getAttribute("stroke")).toBe("var(--text-3)");
    expect(svgFontSizes(container).length).toBeGreaterThan(0);
    expect(svgFontSizes(container).every((size) => size >= 12)).toBe(true);
  });

  it("세로 막대 — 격자 없음, 0 기준선", () => {
    observeAs(600, 320);
    const { container } = render(<SignedBars data={[{ name: "1월", value: 3 }, { name: "2월", value: -2 }]} />);
    expect(container.querySelector(".recharts-cartesian-grid")).toBeNull();
    expect(container.querySelector(".recharts-reference-line line")?.getAttribute("stroke")).toBe("var(--text-3)");
    expect(svgFontSizes(container).every((size) => size >= 12)).toBe(true);
  });

  it("산점도는 늘 옅은 격자(두 축이 다 데이터) — 옅은 경계(border-subtle) 1px", () => {
    observeAs(600, 320);
    const { container } = render(
      <ScatterPlot data={[{ x: 1, y: 2, date: "a" }, { x: -1, y: 0.5, date: "b" }]} xLabel="금리 변화" yLabel="지수 변화" />,
    );
    const grid = container.querySelector(".recharts-cartesian-grid line, .recharts-cartesian-grid-horizontal line") as SVGLineElement;
    expect(grid.getAttribute("stroke")).toBe("var(--border-subtle)");
    expect(grid.getAttribute("stroke-width")).toBe("1");
    expect(container.querySelector(".recharts-cartesian-grid-vertical line")).not.toBeNull();
  });
});

describe("격자 선택(grid) — 큰 분석 차트의 옅은 가로 격자(작업대 실행 명세 W6)", () => {
  const horizontal = (container: HTMLElement) => [...container.querySelectorAll(".recharts-cartesian-grid-horizontal line")];

  it("LineSeries — grid면 Y 눈금마다 가로선 하나(1px border-subtle), 세로 격자 없음", () => {
    observeAs(600, 260);
    const { container } = render(<LineSeries data={LIQUIDITY} unit="조" precision={2} grid />);
    const lines = horizontal(container);
    expect(lines).toHaveLength(yTicks(container).length);
    for (const line of lines) {
      expect(line.getAttribute("stroke")).toBe("var(--border-subtle)");
      expect(line.getAttribute("stroke-width")).toBe("1");
    }
    expect(container.querySelector(".recharts-cartesian-grid-vertical")).toBeNull();
  });

  it("MultiLineSeries — 왼쪽 축 눈금에만 긋고(오른쪽 축 눈금과 섞지 않음), 계열이 모두 오른쪽이면 오른쪽 축 눈금에", () => {
    const ROWS = [
      { date: "2026-10-01", a: 100, oi: 300_000 },
      { date: "2026-10-02", a: 101, oi: 310_000 },
      { date: "2026-10-03", a: 103, oi: 305_000 },
    ];
    observeAs(600, 300);
    const both = render(
      <MultiLineSeries
        data={ROWS}
        series={[
          { key: "a", name: "종가", color: SERIES_COLORS.blue },
          { key: "oi", name: "미결제약정 (우)", color: SERIES_COLORS.orange, axis: "right" },
        ]}
        grid
      />,
    );
    const leftTicks = texts(both.container.querySelectorAll(".recharts-yAxis-tick-labels text")).filter((text) => !String(text).includes(","));
    expect(horizontal(both.container)).toHaveLength(leftTicks.length);
    expect(horizontal(both.container)[0].getAttribute("stroke")).toBe("var(--border-subtle)");
    both.unmount();

    const rightOnly = render(
      <MultiLineSeries data={ROWS} series={[{ key: "oi", name: "미결제약정 (우)", color: SERIES_COLORS.orange, axis: "right" }]} grid />,
    );
    expect(horizontal(rightOnly.container).length).toBeGreaterThan(0);
    expect(horizontal(rightOnly.container)).toHaveLength(yTicks(rightOnly.container).length);
  });

  it("SignedBars — grid면 가로 격자, 주지 않으면 없음(위 시험)", () => {
    observeAs(600, 320);
    const { container } = render(<SignedBars data={[{ name: "1월", value: 3 }, { name: "2월", value: -2 }]} grid />);
    const lines = horizontal(container);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.getAttribute("stroke") === "var(--border-subtle)")).toBe(true);
    expect(container.querySelector(".recharts-cartesian-grid-vertical")).toBeNull();
  });
});
