/**
 * 선 차트(LineChart) — 실제 Recharts로 그려 봅니다(설계서 §5 차트 규칙, §6 네 상태).
 *
 *  - 값 있음: 격자 없음, Y축 눈금은 범위 끝값 두 개(valueFormat), X축은 첫·마지막 날짜, 선 2px, 계열 색은 SERIES_COLORS 순서, 이중 축 없음
 *  - 0 기준선은 includeZero이고 범위가 0을 가로지를 때만, null에서 선이 끊기고 외딴 값은 점으로
 *  - 호버 툴팁: 날짜 · 계열 값(모르면 "—") · 출처
 *  - 값 없음: 행이 없거나 전부 모름이면 "표시할 시계열이 없습니다."(옛 래퍼와 같은 문구)
 *  - 추정·오래됨: 배지가 그림 위에 반드시 보인다(빈 상태에서도)
 *
 * jsdom에는 크기가 없어 ResponsiveContainer가 너비를 모릅니다 — 관찰을 시작하면 정한 크기를 바로 알려 주는 가짜를 씁니다(DonutChart.test와 같음).
 * 호버는 감싼 상자의 getBoundingClientRect를 차트 크기로 맞춘 뒤 mousemove를 보냅니다.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LineChart, MultiLineSeries, SERIES_COLORS } from "@/components/charts";
import { lineYAxis } from "@/lib/lineChart";

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

const pct = (value: number) => `${value.toFixed(1)}%`;

const ONE_SERIES = [{ key: "v", label: "순유동성" }];
const LIQUIDITY = [
  { date: "2026-01-02", v: 5.85 },
  { date: "2026-04-01", v: 5.9 },
  { date: "2026-07-01", v: 5.97 },
  { date: "2026-10-24", v: 6.0 },
];

const TWO_SERIES = [
  { key: "a", label: "10년−3개월" },
  { key: "b", label: "10년−2년" },
];
const SPREADS = [
  { date: "2026-01-02", a: -0.4, b: 0.2 },
  { date: "2026-04-01", a: null, b: 0.3 },
  { date: "2026-07-01", a: 0.5, b: null },
  { date: "2026-10-24", a: 1.2, b: 0.6 },
];

const texts = (nodes: Iterable<Element>) => [...nodes].map((node) => node.textContent);
const xTickTexts = (container: HTMLElement) => texts(container.querySelectorAll(".recharts-xAxis-tick-labels text"));
const yTickTexts = (container: HTMLElement) => texts(container.querySelectorAll(".recharts-yAxis-tick-labels text"));
const linePaths = (container: HTMLElement) => [...container.querySelectorAll("path.recharts-line-curve")];

describe("LineChart — 값 있음", () => {
  it("격자 없음 · Y축은 범위 끝값 두 개(valueFormat) · X축은 첫·마지막 날짜 · 선 2px · 첫 기본 색", () => {
    observeAs(600, 240);
    const { container } = render(<LineChart data={LIQUIDITY} series={ONE_SERIES} valueFormat={pct} />);

    expect(container.querySelector(".recharts-cartesian-grid")).toBeNull();
    const axis = lineYAxis(LIQUIDITY, ONE_SERIES)!;
    expect(yTickTexts(container)).toEqual([pct(axis.domain[0]), pct(axis.domain[1])]);
    // 0 바닥을 지어내지 않는다 — 아래 끝은 5 위.
    expect(axis.domain[0]).toBeGreaterThan(5);
    expect(xTickTexts(container)).toEqual(["2026-01-02", "2026-10-24"]);

    const paths = linePaths(container);
    expect(paths).toHaveLength(1);
    expect(paths[0].getAttribute("stroke")).toBe(SERIES_COLORS.blue);
    expect(paths[0].getAttribute("stroke-width")).toBe("2");
  });

  it("축·눈금 색은 토큰 — 축선 var(--border), 글자 var(--text-3)(Recharts 기본 hex가 아님)", () => {
    observeAs(600, 240);
    const { container } = render(<LineChart data={LIQUIDITY} series={ONE_SERIES} />);
    expect(container.querySelector(".recharts-xAxis line.recharts-cartesian-axis-line")?.getAttribute("stroke")).toBe("var(--border)");
    const ticks = container.querySelectorAll(".recharts-xAxis-tick-labels text, .recharts-yAxis-tick-labels text");
    expect(ticks).toHaveLength(4);
    for (const tick of ticks) {
      expect(tick.getAttribute("fill")).toBe("var(--text-3)");
    }
  });

  it("계열 하나면 범례 없음, SVG에 낭독기 이름(계열 · 기간)", () => {
    observeAs(600, 240);
    const { container } = render(<LineChart data={LIQUIDITY} series={ONE_SERIES} />);
    expect(screen.queryByRole("list", { name: "범례" })).toBeNull();
    expect(container.querySelector("svg.recharts-surface")?.getAttribute("aria-label")).toBe(
      "선 차트: 순유동성 · 2026-01-02 ~ 2026-10-24",
    );
  });

  it("계열이 둘 이상이면 글자 범례, 색은 SERIES_COLORS 순서, Y축은 하나(이중 축 없음)", () => {
    observeAs(600, 240);
    const { container } = render(<LineChart data={SPREADS} series={TWO_SERIES} includeZero />);
    const legend = screen.getByRole("list", { name: "범례" });
    expect(within(legend).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["10년−3개월", "10년−2년"]);
    expect(linePaths(container).map((path) => path.getAttribute("stroke"))).toEqual([SERIES_COLORS.blue, SERIES_COLORS.orange]);
    expect(container.querySelectorAll(".recharts-yAxis")).toHaveLength(1);
  });

  it("계열이 넘긴 색이 기본 색보다 우선한다", () => {
    observeAs(600, 240);
    const { container } = render(
      <LineChart data={SPREADS} series={[TWO_SERIES[0], { ...TWO_SERIES[1], color: "#606870" }]} />,
    );
    expect(linePaths(container).map((path) => path.getAttribute("stroke"))).toEqual([SERIES_COLORS.blue, "#606870"]);
  });

  it("기본 색은 되풀이하지 않는다 — 색 없는 넷째 계열은 오류", () => {
    observeAs(600, 240);
    // React가 렌더 오류를 콘솔에 남깁니다 — 이 테스트에서는 조용히.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const four = ["a", "b", "c", "d"].map((key) => ({ key, label: key.toUpperCase() }));
    expect(() => render(<LineChart data={[{ date: "2026-10-24", a: 1, b: 2, c: 3, d: 4 }]} series={four} />)).toThrow(
      /4번째 계열 "D"/,
    );
  });
});

describe("LineChart — 0 기준선 · 끊김", () => {
  it("includeZero이고 0을 가로지르면 0 기준선(text-3)", () => {
    observeAs(600, 240);
    const { container } = render(<LineChart data={SPREADS} series={TWO_SERIES} includeZero />);
    const lines = container.querySelectorAll(".recharts-reference-line line");
    expect(lines).toHaveLength(1);
    expect(lines[0].getAttribute("stroke")).toBe("var(--text-3)");
  });

  it("includeZero여도 값이 모두 양수면 기준선 없음(0은 축 끝 눈금), includeZero가 없으면 음수가 있어도 없음", () => {
    observeAs(600, 240);
    const positive = render(<LineChart data={LIQUIDITY} series={ONE_SERIES} includeZero valueFormat={pct} />);
    expect(positive.container.querySelector(".recharts-reference-line")).toBeNull();
    expect(yTickTexts(positive.container)[0]).toBe("0.0%");
    cleanup();

    const noZero = render(<LineChart data={SPREADS} series={TWO_SERIES} />);
    expect(noZero.container.querySelector(".recharts-reference-line")).toBeNull();
  });

  it("null에서 선이 끊기고(connectNulls=false), 앞뒤가 모름인 외딴 값은 점으로 남는다", () => {
    observeAs(600, 240);
    const { container } = render(<LineChart data={SPREADS} series={TWO_SERIES} includeZero />);
    // 계열 a: 첫 값 뒤가 null — 첫 점은 외딴 값, 나머지 둘은 선. 경로가 두 번 시작(M)합니다.
    const [first] = linePaths(container);
    expect(first.getAttribute("d")?.match(/M/g)).toHaveLength(2);
    // 계열 b는 셋째가 null이지만 첫·둘째가 이어지고 넷째만 외딴 값 — 점은 계열마다 하나씩.
    const dots = [...container.querySelectorAll(".recharts-line-dots circle")];
    expect(dots.map((dot) => dot.getAttribute("fill"))).toEqual([SERIES_COLORS.blue, SERIES_COLORS.orange]);
  });
});

describe("LineChart — 호버 툴팁", () => {
  it("날짜 · 계열마다 valueFormat 값(모르면 —) · 출처 줄, 바탕은 var(--surface)", async () => {
    observeAs(600, 240);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      x: 0,
      y: 0,
      width: 600,
      height: 240,
      right: 600,
      bottom: 240,
      toJSON: () => ({}),
    } as DOMRect);
    const { container } = render(
      <LineChart data={SPREADS} series={TWO_SERIES} valueFormat={pct} source="FRED" includeZero />,
    );
    // 두 번째 날짜(2026-04-01) 근처 — 계열 a는 그날 값이 없습니다. Recharts는 마우스 이동을 다음 프레임에 반영하므로 기다립니다.
    await act(async () => {
      fireEvent.mouseMove(container.querySelector(".recharts-wrapper") as Element, { clientX: 205, clientY: 100 });
    });
    const tooltip = container.querySelector(".recharts-tooltip-wrapper") as HTMLElement;
    expect(await within(tooltip).findByText("2026-04-01")).toBeTruthy();
    expect(within(tooltip).getByText("10년−3개월").nextElementSibling?.textContent).toBe("—");
    expect(within(tooltip).getByText("10년−2년").nextElementSibling?.textContent).toBe("0.3%");
    expect(within(tooltip).getByText("출처 · FRED")).toBeTruthy();
    expect((tooltip.firstElementChild as HTMLElement).style.backgroundColor).toBe("var(--surface)");
  });
});

describe("LineChart — 값 없음", () => {
  it("행이 없으면 빈 상태 문구, 그림 없음", () => {
    observeAs(600, 240);
    const { container } = render(<LineChart data={[]} series={ONE_SERIES} />);
    expect(screen.getByText("표시할 시계열이 없습니다.")).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("모든 칸이 모름(null·'N/A')이어도 빈 상태 — 0선이나 0 눈금을 지어내지 않는다", () => {
    observeAs(600, 240);
    const { container } = render(
      <LineChart data={[{ date: "2026-10-23", v: null }, { date: "2026-10-24", v: "N/A" }]} series={ONE_SERIES} includeZero />,
    );
    expect(screen.getByText("표시할 시계열이 없습니다.")).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).not.toContain("0.00");
  });
});

describe("LineChart — 추정 · 오래됨 배지", () => {
  it("추정이면 그림 위에 '추정' 배지", () => {
    observeAs(600, 240);
    const { container } = render(<LineChart data={LIQUIDITY} series={ONE_SERIES} estimated />);
    const badge = screen.getByText("추정");
    // 배지는 그림(SVG)보다 앞에 놓입니다.
    const svg = container.querySelector("svg.recharts-surface") as SVGElement;
    expect(badge.compareDocumentPosition(svg) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("이전 값")).toBeNull();
  });

  it("오래됨이면 '⚠️ 이전 값' + 사유(경고색)", () => {
    observeAs(600, 240);
    render(<LineChart data={LIQUIDITY} series={ONE_SERIES} stale staleReason="이번 수집 실패 — 직전 저장본" />);
    const label = screen.getByText("이전 값");
    expect((label.parentElement as HTMLElement).className).toContain("text-warn");
    expect(screen.getByText("· 이번 수집 실패 — 직전 저장본")).toBeTruthy();
    expect(screen.queryByText("추정")).toBeNull();
  });

  it("플래그가 없으면 배지 없음, 빈 상태에서도 플래그가 있으면 배지는 보인다", () => {
    observeAs(600, 240);
    render(<LineChart data={LIQUIDITY} series={ONE_SERIES} />);
    expect(screen.queryByText("추정")).toBeNull();
    expect(screen.queryByText("이전 값")).toBeNull();
    cleanup();

    render(<LineChart data={[]} series={ONE_SERIES} estimated stale />);
    expect(screen.getByText("표시할 시계열이 없습니다.")).toBeTruthy();
    expect(screen.getByText("추정")).toBeTruthy();
    expect(screen.getByText("이전 값")).toBeTruthy();
  });
});

describe("여러 계열(MultiLineSeries) — 점선 참고선", () => {
  it("dashed 계열만 strokeDasharray(6 4), 기본 계열에는 없음 — 왼쪽 축 폭은 axisWidth", () => {
    observeAs(600, 300);
    const { container } = render(
      <MultiLineSeries
        data={[
          { date: "2026-10-29", a: 100_000_000, ref: 100_000_000 },
          { date: "2026-10-30", a: 100_312_450, ref: 100_100_000 },
          { date: "2026-11-02", a: 100_500_000, ref: null },
        ]}
        series={[
          { key: "a", name: "한국 규칙 계좌", color: SERIES_COLORS.blue, valueDigits: 0 },
          { key: "ref", name: "노출 맞춘 참고선(계좌 아님)", color: "#a371f7", dashed: true, valueDigits: 0 },
        ]}
        precision={0}
        axisWidth={84}
        ariaLabel="순자산 곡선"
      />,
    );
    const curves = [...container.querySelectorAll("path.recharts-line-curve")];
    expect(curves).toHaveLength(2);
    const byColor = (color: string) => curves.find((path) => path.getAttribute("stroke") === color);
    expect(byColor("#a371f7")?.getAttribute("stroke-dasharray")).toBe("6 4");
    expect(byColor(SERIES_COLORS.blue)?.getAttribute("stroke-dasharray")).toBeNull();
  });
});
