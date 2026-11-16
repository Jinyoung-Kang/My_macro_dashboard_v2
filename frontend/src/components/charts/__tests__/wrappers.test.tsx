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
 *  - SVG 글자는 모두 12px 이상(축·막대 끝 값·표시선 이름), 툴팁 상자는 덮개 모양(덮개 경계 border-overlay·그림자·4px 모서리)
 *  - 셸 폭이 바뀌는 동안 폭 잡아 두기(QA-601 — charts/sizeHold): ResponsiveContainer를 두 상자가 감싸고, 쉬는 상태는 폭 100%(인라인 폭·높이·넘침
 *    자르기 없음 — svg 폭은 크기 감시가 알린 그대로), 셸 신호(lib/shellResize)가 켜지면 잰 px로 고정하고 그동안만 가로 넘침을 자름
 *
 * jsdom에는 크기가 없어 ResponsiveContainer가 너비를 모릅니다 — 관찰을 시작하면 정한 크기를 바로 알려 주는 가짜를 씁니다(LineChart.test와 같음).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DonutChart, HorizontalBars, LineSeries, MultiLineSeries, ScatterPlot, SERIES_COLORS, SignedBars } from "@/components/charts";
import { ChartLegend, REFERENCE_DASH } from "@/components/charts/frame";
import { LineChartTooltip } from "@/components/charts/LineChart";
import { resetShellResizingForTest, setShellResizing } from "@/lib/shellResize";

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
    // 경계는 덮개 경계(대화상자·토스트·맨 위로 단추와 같은 토큰 — 명세 §3-3 3층) — 패널 경계(--border)가 아님.
    expect(box.style.border).toBe("1px solid var(--border-overlay)");
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

  // QA-498: 계산한 참고선(K40 — 색은 토큰 밖 hex #a7b0bd)은 고대비(forced-colors)의 밝은 Canvas 위에서 2.19:1이었습니다. 그 선과 범례 견본에 표지
  // 클래스(chart-ref-line)를 달아 globals.css의 고대비 블록이 CanvasText로 칠합니다(실선 계열에는 달지 않음). 재현 커밋에서는 it.fails였습니다.
  it("QA-498: 점선 계열의 선(g.chart-ref-line)과 범례 견본 svg에 참고선 표지 — 실선 계열에는 없다", () => {
    observeAs(600, 300);
    const { container } = render(
      <MultiLineSeries
        data={ROWS}
        series={[
          { key: "a", name: "종가", color: SERIES_COLORS.blue },
          { key: "b", name: "참고선", color: "#a7b0bd", dashed: true },
        ]}
      />,
    );
    const marked = [...container.querySelectorAll("g.chart-ref-line")];
    expect(marked).toHaveLength(1);
    expect(marked[0].querySelector("path.recharts-line-curve")?.getAttribute("stroke-dasharray")).toBe(REFERENCE_DASH);
    expect(container.querySelectorAll(".recharts-line")).toHaveLength(2);
    const items = within(screen.getByRole("list", { name: "범례" })).getAllByRole("listitem");
    const svgClasses = (item: HTMLElement) => (item.querySelector('svg[aria-hidden="true"]')?.getAttribute("class") ?? "").split(/\s+/);
    expect(svgClasses(items[1])).toContain("chart-ref-line");
    expect(svgClasses(items[0])).not.toContain("chart-ref-line");
  });

  // QA-509: 고대비 블록은 참고선(K40)의 선과 범례 견본을 표지 클래스(chart-ref-line)로 CanvasText로 칠하지만, 마우스를 올렸을 때 나오는 그 계열의
  // hover 점(Recharts activeDot — 선과 다른 층의 circle)에는 표지가 없어 #a7b0bd 그대로였습니다(밝은 고대비 흰 Canvas 위 2.19:1 — /paper/kr
  // 1440, D1 QA 재확인). 점선 계열의 hover 점에도 같은 표지를 달아 globals.css 고대비 블록이 칠하게 합니다. 실선 계열의 점에는 달지 않습니다.
  // 재현 커밋에서는 it.fails였습니다.
  it("QA-509: 점선(참고선) 계열의 hover 점에 참고선 표지 — 실선 계열의 hover 점에는 없다", async () => {
    observeAs(600, 300);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, x: 0, y: 0, width: 600, height: 300, right: 600, bottom: 300, toJSON: () => ({}),
    } as DOMRect);
    const { container } = render(
      <MultiLineSeries
        data={ROWS}
        series={[
          { key: "a", name: "종가", color: SERIES_COLORS.blue },
          { key: "b", name: "참고선", color: "#a7b0bd", dashed: true },
        ]}
      />,
    );
    await act(async () => {
      fireEvent.mouseMove(container.querySelector(".recharts-wrapper") as Element, { clientX: 300, clientY: 150 });
    });
    await waitFor(() => expect(container.querySelectorAll(".recharts-active-dot circle")).toHaveLength(2));
    const dots = [...container.querySelectorAll(".recharts-active-dot circle")];
    const marked = dots.filter((dot) => (dot.getAttribute("class") ?? "").split(/\s+/).includes("chart-ref-line"));
    expect(marked).toHaveLength(1);
    expect(marked[0].getAttribute("fill")).toBe("#a7b0bd");
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

// QA-497: 고대비(forced-colors)에서 Recharts SVG 선·조각은 작성자 색을 남기는데(크롬 svg forced-color-adjust: preserve-parent-color), 이름 옆
// CSS 견본(범례 테두리·툴팁 바탕색)은 시스템 색(검정·흰색)으로 바뀌어 이름과 선을 맞출 수 없었습니다(/cot·/paper/us·/paper/kr 1440).
// 견본도 그것이 가리키는 선·조각과 같은 규칙(작성자 색 유지 — forced-color-adjust-none)이어야 합니다. 재현 커밋에서는 it.fails였습니다.
describe("고대비에서 견본은 계열 색 그대로(forced-color-adjust-none)", () => {
  it("QA-497: 글자 범례의 견본마다 forced-color-adjust-none", () => {
    render(
      <ChartLegend
        entries={[
          { key: "a", label: "규칙 계좌", color: SERIES_COLORS.blue },
          { key: "b", label: "참고선(계좌 아님)", color: "#a7b0bd", dashed: true },
        ]}
      />,
    );
    const items = within(screen.getByRole("list", { name: "범례" })).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    for (const item of items) {
      const swatch = item.querySelector(':scope > [aria-hidden="true"]');
      expect(swatch, item.textContent ?? "").not.toBeNull();
      expect((swatch?.getAttribute("class") ?? "").split(/\s+/), item.textContent ?? "").toContain("forced-color-adjust-none");
    }
  });

  it("QA-497: 선 차트 툴팁의 계열 견본마다 forced-color-adjust-none", () => {
    const { container } = render(
      <LineChartTooltip
        model={{
          date: "2026-10-30",
          items: [
            { key: "a", label: "규칙 계좌", color: SERIES_COLORS.blue, text: "100,600" },
            { key: "b", label: "SPY 계좌", color: SERIES_COLORS.green, text: "100,700" },
          ],
          sourceLine: null,
        }}
      />,
    );
    const swatches = [...container.querySelectorAll('[aria-hidden="true"]')];
    expect(swatches).toHaveLength(2);
    for (const swatch of swatches) expect((swatch.getAttribute("class") ?? "").split(/\s+/)).toContain("forced-color-adjust-none");
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

  // QA-499: 가로 막대의 음수 값 라벨은 막대 바깥 끝 왼쪽(패널 면 위)에 있어야 합니다. Recharts 3.10.1의 가로 막대는 음수 막대를 x = 0선 자리,
  // width = 음수로 넘기는데 라벨이 `x - 6`(0선 왼쪽 6px — 막대 안쪽 시작점)에 글 끝을 맞춰, 막대가 글보다 길면 하락 파랑 막대 위에 text-3 글
  // (1.43:1)이 됐습니다(/sector 1M '-9.11%' 37px·'-12.15%' 45px 겹침, 390·1024·1440). 라벨이 막대 바깥으로 가려면 가장 음수인 막대의 바깥 끝과
  // Y축 선 사이에 라벨 자리가 있어야 합니다. 재현 커밋에서는 it.fails였습니다.
  it("QA-499: 음수 막대의 값 라벨은 막대 바깥 끝 왼쪽 — 가장 음수인 막대 바깥 끝과 Y축 선 사이에 라벨 자리", () => {
    /** 음수 막대 왼쪽에 남기는 라벨 자리(px) — charts/index.tsx HorizontalBars의 같은 이름 값(오른쪽 여백 68과 맞춤). */
    const NEG_LABEL_ROOM = 60;
    observeAs(600, 360);
    const { container } = render(
      <HorizontalBars data={[{ name: "삼성전자", value: 120.5 }, { name: "SK하이닉스", value: -40.2 }]} unit="억" />,
    );
    const bars = [...container.querySelectorAll(".recharts-bar-rectangle path")].map((path) => {
      const x = Number(path.getAttribute("x"));
      const width = Number(path.getAttribute("width"));
      return { start: Math.min(x, x + width), end: Math.max(x, x + width), negative: width < 0 };
    });
    expect(bars).toHaveLength(2);
    const negative = bars.find((bar) => bar.negative);
    expect(negative, "음수 막대").toBeDefined();
    const label = [...container.querySelectorAll("text")].find((node) => node.textContent === "-40.2억") as SVGTextElement;
    expect(label.getAttribute("text-anchor")).toBe("end");
    // (a) 라벨 글 끝이 막대 바깥 끝보다 6px 이상 왼쪽 — 막대와 겹치지 않음
    expect(Number(label.getAttribute("x")), "라벨 x").toBeLessThanOrEqual((negative?.start ?? 0) - 6);
    // (b) 가장 음수인 막대의 바깥 끝은 Y축 선에서 라벨 자리만큼 떨어짐 — 옮긴 라벨이 Y축 이름표 위에 겹치지 않음
    const axisX = Number(container.querySelector(".recharts-yAxis line.recharts-cartesian-axis-line")?.getAttribute("x1"));
    expect(Number.isFinite(axisX)).toBe(true);
    expect((negative?.start ?? 0) - axisX, "막대 바깥 끝 - Y축 선").toBeGreaterThanOrEqual(NEG_LABEL_ROOM);
    // 양수 막대 라벨은 그대로 막대 끝 오른쪽 6px
    const positive = bars.find((bar) => !bar.negative);
    const positiveLabel = [...container.querySelectorAll("text")].find((node) => node.textContent === "120.5억") as SVGTextElement;
    expect(positiveLabel.getAttribute("text-anchor")).toBe("start");
    expect(Number(positiveLabel.getAttribute("x"))).toBeCloseTo((positive?.end ?? 0) + 6, 3);
  });

  it("가로 막대 — 모두 양수면 왼쪽 라벨 자리를 두지 않는다(막대가 Y축 선에서 시작)", () => {
    observeAs(600, 360);
    const { container } = render(
      <HorizontalBars data={[{ name: "삼성전자", value: 120.5 }, { name: "SK하이닉스", value: 40.2 }]} unit="억" />,
    );
    const axisX = Number(container.querySelector(".recharts-yAxis line.recharts-cartesian-axis-line")?.getAttribute("x1"));
    const starts = [...container.querySelectorAll(".recharts-bar-rectangle path")].map((path) => Number(path.getAttribute("x")));
    expect(starts).toHaveLength(2);
    for (const start of starts) expect(start).toBeCloseTo(axisX, 3);
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

// QA-500: 래퍼 차트의 툴팁(tooltipStyle()을 펼치는 넷)은 isAnimationActive를 넘기지 않아 Recharts 기본값 'auto'를 따랐습니다 — 움직임 줄이기를
// 켜지 않은 화면에서 툴팁이 'transform 400ms ease'로 미끄러졌습니다(명세 §3-8 '차트 애니메이션 없음' — 새 LineChart는 이미 false).
// 시험 환경의 matchMedia는 움직임 줄이기 꺼짐입니다. 재현 커밋에서는 it.fails였습니다.
describe("툴팁은 미끄러지지 않는다(명세 §3-8)", () => {
  function sizeAs(width: number, height: number) {
    observeAs(width, height);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, x: 0, y: 0, width, height, right: width, bottom: height, toJSON: () => ({}),
    } as DOMRect);
  }
  const ROWS = [
    { date: "2026-10-01", a: 100, b: 98 },
    { date: "2026-10-02", a: 101, b: 99 },
    { date: "2026-10-03", a: 103, b: 97 },
  ];
  const BARS = [{ name: "1월", value: 3 }, { name: "2월", value: -2 }, { name: "3월", value: 5 }];

  /** 그림 위로 마우스를 옮겨(산점도는 점에 올려) 뜬 툴팁 감싸개. */
  async function hoverTooltip(container: HTMLElement, target: "wrapper" | "symbol"): Promise<HTMLElement> {
    await act(async () => {
      if (target === "symbol") fireEvent.mouseEnter(container.querySelector(".recharts-scatter-symbol") as Element);
      else fireEvent.mouseMove(container.querySelector(".recharts-wrapper") as Element, { clientX: 300, clientY: 100 });
    });
    const wrapper = container.querySelector(".recharts-tooltip-wrapper") as HTMLElement;
    // Recharts는 마우스 이동을 다음 프레임에 반영합니다 — 툴팁이 뜰 때까지 기다립니다.
    await waitFor(() => expect(wrapper.style.visibility).toBe("visible"));
    return wrapper;
  }

  it.each([
    ["MultiLineSeries", () => <MultiLineSeries data={ROWS} series={[{ key: "a", name: "A", color: SERIES_COLORS.blue }, { key: "b", name: "B", color: SERIES_COLORS.orange }]} />, "wrapper"],
    ["HorizontalBars", () => <HorizontalBars data={BARS} />, "wrapper"],
    ["SignedBars", () => <SignedBars data={BARS} />, "wrapper"],
    ["ScatterPlot", () => <ScatterPlot data={[{ x: 1, y: 2, date: "a" }, { x: -1, y: 0.5, date: "b" }]} xLabel="X" yLabel="Y" />, "symbol"],
  ] as const)("QA-500: %s 툴팁에 transition이 없다", async (_name, chart, target) => {
    sizeAs(600, 300);
    const { container } = render(chart());
    expect((await hoverTooltip(container, target)).style.transition).toBe("");
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

describe("셸 폭이 바뀌는 동안 폭 잡아 두기(QA-601 — charts/sizeHold)", () => {
  afterEach(() => resetShellResizingForTest());

  const POINTS = [
    { date: "2026-01-02", a: 1, b: 2 },
    { date: "2026-10-24", a: 3, b: 1 },
  ];
  /** ResponsiveContainer를 바로 감싼 상자(고정할 때 px 폭)와 그 바깥 상자(잴 때·자를 때). */
  const boxes = (container: HTMLElement) => {
    const inner = (container.querySelector(".recharts-responsive-container") as HTMLElement).parentElement as HTMLElement;
    return { inner, outer: inner.parentElement as HTMLElement };
  };
  const classList = (element: Element) => element.className.split(/\s+/);
  const svgWidth = (container: HTMLElement) => container.querySelector("svg.recharts-surface")?.getAttribute("width");
  /** 차트를 감싼 바깥 상자(ResponsiveContainer를 품은 요소)만 폭 600을 잼 — 나머지는 jsdom 그대로(0). */
  function measureAs(width: number) {
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (!this.querySelector(".recharts-responsive-container")) return original.call(this);
      return { left: 0, top: 0, x: 0, y: 0, width, height: 260, right: width, bottom: 260, toJSON: () => ({}) } as DOMRect;
    });
  }

  it("쉬는 상태 — 다섯 래퍼 모두 감싼 두 상자는 w-full·min-w-0이고 인라인 폭·높이 지정·넘침 자르기가 없다. svg 폭은 크기 감시가 알린 600 그대로", () => {
    observeAs(600, 300);
    const charts = [
      <LineSeries key="line" data={LIQUIDITY} />,
      <MultiLineSeries key="multi" data={POINTS} series={[{ key: "a", name: "가", color: SERIES_COLORS.blue }]} />,
      <HorizontalBars key="h" data={[{ name: "가", value: 1 }]} />,
      <SignedBars key="s" data={[{ name: "가", value: 1 }]} />,
      <DonutChart key="d" ariaLabel="구성" segments={[{ key: "a", name: "가", value: 1, color: SERIES_COLORS.blue, valueText: "100%" }]} />,
    ];
    for (const chart of charts) {
      const { container, unmount } = render(chart);
      const { inner, outer } = boxes(container);
      for (const box of [inner, outer]) {
        expect(classList(box)).toEqual(["w-full", "min-w-0"]);
        expect(box.getAttribute("style")).toBeNull();
      }
      expect(svgWidth(container)).toBe("600");
      unmount();
    }
    // 산점도는 보조기기에 숨긴 상자 안 — 같은 감싸개
    const scatter = render(<ScatterPlot data={[{ x: 1, y: 2, date: "2026-01-02" }]} xLabel="가" yLabel="나" />);
    expect(classList(boxes(scatter.container).outer)).toEqual(["w-full", "min-w-0"]);
    expect(boxes(scatter.container).outer.parentElement?.getAttribute("aria-hidden")).toBe("true");
  });

  it("신호가 켜지면 바깥 상자의 잰 폭(600px)으로 안쪽 상자를 고정하고 그동안만 가로 넘침을 자른다 — 꺼지면 100%(인라인 폭 없음)로", () => {
    observeAs(600, 260);
    measureAs(600);
    const { container } = render(<MultiLineSeries data={POINTS} series={[{ key: "a", name: "가", color: SERIES_COLORS.blue }]} />);
    act(() => setShellResizing("drag", true));
    expect(boxes(container).inner.style.width).toBe("600px");
    expect(classList(boxes(container).outer)).toContain("overflow-x-clip");
    // 두 원천 가운데 하나만 꺼지면 그대로
    act(() => setShellResizing("motion", true));
    act(() => setShellResizing("drag", false));
    expect(boxes(container).inner.style.width).toBe("600px");
    act(() => setShellResizing("motion", false));
    expect(boxes(container).inner.style.width).toBe("");
    expect(classList(boxes(container).outer)).not.toContain("overflow-x-clip");
    expect(svgWidth(container)).toBe("600");
  });

  it("잰 폭이 0이면(숨긴 탭·배치 전) 고정하지 않는다", () => {
    observeAs(600, 260);
    const { container } = render(<SignedBars data={[{ name: "가", value: 1 }]} />);
    act(() => setShellResizing("drag", true));
    expect(boxes(container).inner.style.width).toBe("");
    expect(classList(boxes(container).outer)).not.toContain("overflow-x-clip");
  });

  it("신호가 켜진 채 새로 그려진 차트는 고정하지 않는다 — 다음에 켜질 때부터 고정", () => {
    observeAs(600, 260);
    measureAs(600);
    act(() => setShellResizing("motion", true));
    const { container } = render(<HorizontalBars data={[{ name: "가", value: 1 }]} />);
    expect(boxes(container).inner.style.width).toBe("");
    act(() => setShellResizing("motion", false));
    act(() => setShellResizing("motion", true));
    expect(boxes(container).inner.style.width).toBe("600px");
  });
});
