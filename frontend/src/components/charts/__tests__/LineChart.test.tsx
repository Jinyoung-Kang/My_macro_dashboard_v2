/**
 * 선 차트(LineChart) — 실제 Recharts로 그려 봅니다(설계서 §5 차트 규칙, §6 네 상태).
 *
 *  - 값 있음: 격자 없음, Y축 눈금은 범위 끝값 두 개(valueFormat), X축은 첫·마지막 날짜, 선 2px, 계열 색은 SERIES_COLORS 순서, 이중 축 없음
 *  - 0 기준선은 includeZero이고 범위가 0을 가로지를 때만, null에서 선이 끊기고 외딴 값은 점으로
 *  - 호버 툴팁: 날짜 · 계열 값(모르면 "—") · 출처
 *  - 값 없음: 행이 없거나 전부 모름이면 "표시할 시계열이 없습니다."(옛 래퍼와 같은 문구)
 *  - 추정·오래됨: 배지가 그림 위에 반드시 보인다(빈 상태에서도)
 *  - 히어로(variant="hero", 명세 §5): 중립 잉크 선, 툴팁 상자 없음, 축선 없음·축 글자 12px, 높이 200/lg 260·touch-action pan-y,
 *    Y 끝값은 축 눈금이 아니라 본 계열의 실제 최고(점 위)·최저(점 아래) — 꼬리 계열은 빼고 봄,
 *    문지르기 onScrub(순번 | null) — 마우스 이동·벗어남, 터치를 떼면 null. 범례에서 뺀 계열(legend: false)
 *  - 꼬리 계열(tailOf — 장중 값 단계의 오늘 추정 점선): 점선 "3 3"·범례 없음·본 계열 색, 툴팁 줄은 꼬리 점에만, 앞 값 없는 외딴 꼬리 점은 점
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

describe("LineChart — 히어로 · 문지르기", () => {
  function sizeAs(width: number, height: number) {
    observeAs(width, height);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, x: 0, y: 0, width, height, right: width, bottom: height, toJSON: () => ({}),
    } as DOMRect);
  }

  it("중립 잉크 선(계열 색을 주지 않으면 var(--text)) · 축선 없음 · 축 글자 12px · 높이 200/lg 260 · 세로 스크롤은 브라우저에", () => {
    observeAs(600, 260);
    const { container } = render(<LineChart data={LIQUIDITY} series={ONE_SERIES} variant="hero" valueFormat={pct} />);
    expect(linePaths(container)[0].getAttribute("stroke")).toBe("var(--text)");
    expect(container.querySelector(".recharts-xAxis line.recharts-cartesian-axis-line")).toBeNull();
    expect(container.querySelector(".recharts-cartesian-grid")).toBeNull();
    // Y는 축 눈금 글 없이 실제 최고·최저를 그 점 위·아래에 — 축 범위 끝(여백 8%를 더한, 데이터에 없는 값)을 적지 않음
    expect(yTickTexts(container)).toEqual([]);
    const extremes = [...container.querySelectorAll("[data-hero-extreme]")];
    expect(extremes.map((node) => [node.getAttribute("data-hero-extreme"), node.textContent])).toEqual([["high", pct(6.0)], ["low", pct(5.85)]]);
    const ticks = [...container.querySelectorAll(".recharts-xAxis-tick-labels text"), ...extremes];
    expect(ticks).toHaveLength(4);
    for (const tick of ticks) expect(tick.getAttribute("font-size")).toBe("12");
    // 최고(마지막 점 — 그림 오른쪽 끝)는 끝 맞춤으로 점 위, 최저(첫 점 — 왼쪽 끝)는 시작 맞춤으로 점 아래
    const [high, low] = extremes;
    expect([high.getAttribute("text-anchor"), high.getAttribute("dy")]).toEqual(["end", "-8"]);
    expect([low.getAttribute("text-anchor"), low.getAttribute("dy")]).toEqual(["start", "17"]);
    expect(Number(high.getAttribute("y"))).toBeLessThan(Number(low.getAttribute("y")));
    expect(xTickTexts(container)).toEqual(["2026-01-02", "2026-10-24"]);
    const box = (container.querySelector("svg.recharts-surface") as Element).closest(".touch-pan-y") as HTMLElement;
    expect(box.className.split(/\s+/)).toEqual(expect.arrayContaining(["h-[200px]", "lg:h-[260px]"]));
    // 계열 색을 주면 그 색(계좌 색 등)
    cleanup();
    observeAs(600, 260);
    const colored = render(<LineChart data={LIQUIDITY} series={[{ ...ONE_SERIES[0], color: "#d95926" }]} variant="hero" />);
    expect(linePaths(colored.container)[0].getAttribute("stroke")).toBe("#d95926");
  });

  it("마우스로 문지르면 그 점의 순번을, 벗어나면 null을 알린다 — 툴팁 상자는 없다", async () => {
    sizeAs(600, 240);
    const onScrub = vi.fn();
    const { container } = render(<LineChart data={SPREADS} series={TWO_SERIES} includeZero variant="hero" height={240} onScrub={onScrub} />);
    const wrapper = container.querySelector(".recharts-wrapper") as Element;
    // Recharts는 마우스 이동을 다음 프레임에 반영합니다 — 그 반영을 기다립니다(아래 툴팁 시험의 findByText와 같음).
    await act(async () => {
      fireEvent.mouseMove(wrapper, { clientX: 205, clientY: 100 });
    });
    await vi.waitFor(() => expect(onScrub).toHaveBeenLastCalledWith(1));
    expect(container.querySelector(".recharts-tooltip-cursor")).not.toBeNull();
    expect((container.querySelector(".recharts-tooltip-wrapper") as HTMLElement).textContent).toBe("");
    await act(async () => {
      fireEvent.mouseLeave(wrapper);
    });
    await vi.waitFor(() => expect(onScrub).toHaveBeenLastCalledWith(null));
    expect(container.querySelector(".recharts-tooltip-cursor")).toBeNull();
  });

  it("터치를 떼면 null — 커서를 감추고 지금 값으로 돌아가게", async () => {
    sizeAs(600, 240);
    const onScrub = vi.fn();
    const { container } = render(<LineChart data={LIQUIDITY} series={ONE_SERIES} variant="hero" height={240} onScrub={onScrub} />);
    const wrapper = container.querySelector(".recharts-wrapper") as Element;
    await act(async () => {
      fireEvent.mouseMove(wrapper, { clientX: 590, clientY: 100 });
    });
    await vi.waitFor(() => expect(onScrub).toHaveBeenLastCalledWith(3));
    await act(async () => {
      fireEvent.touchEnd(wrapper);
    });
    expect(onScrub).toHaveBeenLastCalledWith(null);
    expect(container.querySelector(".recharts-tooltip-cursor")).toBeNull();
  });

  it("기본 차트에 onScrub을 주면 툴팁 상자는 그대로 두고 순번도 알린다", async () => {
    sizeAs(600, 240);
    const onScrub = vi.fn();
    const { container } = render(<LineChart data={SPREADS} series={TWO_SERIES} valueFormat={pct} includeZero onScrub={onScrub} />);
    await act(async () => {
      fireEvent.mouseMove(container.querySelector(".recharts-wrapper") as Element, { clientX: 205, clientY: 100 });
    });
    await vi.waitFor(() => expect(onScrub).toHaveBeenLastCalledWith(1));
    expect(await within(container.querySelector(".recharts-tooltip-wrapper") as HTMLElement).findByText("2026-04-01")).toBeTruthy();
  });

  it("범례에서 뺀 계열(legend: false — 장중 값 단계의 추정 꼬리 자리)은 글자 범례에 없고 선은 그린다", () => {
    observeAs(600, 240);
    const three = [...TWO_SERIES, { key: "c", label: "추정 꼬리", color: "#888888", legend: false }];
    const { container } = render(
      <LineChart data={SPREADS.map((row, index) => ({ ...row, c: index === 3 ? 1.0 : null }))} series={three} includeZero />,
    );
    const legend = screen.getByRole("list", { name: "범례" });
    expect(within(legend).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["10년−3개월", "10년−2년"]);
    expect(linePaths(container)).toHaveLength(3);
  });
});

describe("LineChart — 꼬리 계열(tailOf, 장중 값 단계의 오늘 추정 점선)", () => {
  const SERIES = [
    { key: "a", label: "규칙 계좌" },
    { key: "b", label: "SPY 계좌" },
    { key: "a~", label: "규칙 계좌 · 추정 23:58", tailOf: "a" },
  ];
  const ROWS = [
    { date: "2026-10-27", a: 100_000, b: 100_100, "a~": null },
    { date: "2026-10-28", a: 100_400, b: 100_300, "a~": null },
    { date: "2026-10-29", a: 100_200, b: 100_500, "a~": 100_200 },
    { date: "2026-10-30", a: null, b: null, "a~": 100_600 },
  ];
  const money = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function sizeAs(width: number, height: number) {
    observeAs(width, height);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, x: 0, y: 0, width, height, right: width, bottom: height, toJSON: () => ({}),
    } as DOMRect);
  }

  it("꼬리는 점선 3 3·본 계열 색, 글자 범례에 없고, 축 범위에 든다(마지막 날짜는 꼬리 점의 날)", () => {
    observeAs(600, 240);
    const { container } = render(<LineChart data={ROWS} series={SERIES} valueFormat={money} />);
    const legend = screen.getByRole("list", { name: "범례" });
    expect(within(legend).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["규칙 계좌", "SPY 계좌"]);
    const paths = linePaths(container);
    expect(paths).toHaveLength(3);
    expect(paths.map((path) => path.getAttribute("stroke-dasharray"))).toEqual([null, null, "3 3"]);
    expect(paths[2].getAttribute("stroke")).toBe(SERIES_COLORS.blue);
    expect(xTickTexts(container)).toEqual(["2026-10-27", "2026-10-30"]);
    expect(lineYAxis(ROWS, SERIES)!.domain[1]).toBeGreaterThanOrEqual(100_600);
  });

  it("툴팁 — 꼬리 점에서는 꼬리 이름과 값(본 계열 '—' 줄 없음), 꼬리가 시작하는 마지막 줄에서는 꼬리 줄이 없다", async () => {
    sizeAs(600, 240);
    const { container } = render(<LineChart data={ROWS} series={SERIES} valueFormat={money} />);
    const wrapper = container.querySelector(".recharts-wrapper") as Element;
    const tooltip = () => container.querySelector(".recharts-tooltip-wrapper") as HTMLElement;
    await act(async () => {
      fireEvent.mouseMove(wrapper, { clientX: 590, clientY: 100 });
    });
    expect(await within(tooltip()).findByText("2026-10-30")).toBeTruthy();
    expect(within(tooltip()).getByText("규칙 계좌 · 추정 23:58").nextElementSibling?.textContent).toBe("100,600.00");
    expect(within(tooltip()).queryByText("규칙 계좌")).toBeNull();
    // 다른 계열은 그날 값이 없다는 '—'를 그대로
    expect(within(tooltip()).getByText("SPY 계좌").nextElementSibling?.textContent).toBe("—");

    await act(async () => {
      fireEvent.mouseMove(wrapper, { clientX: 400, clientY: 100 });
    });
    expect(await within(tooltip()).findByText("2026-10-29")).toBeTruthy();
    expect(within(tooltip()).getByText("규칙 계좌").nextElementSibling?.textContent).toBe("100,200.00");
    expect(within(tooltip()).queryByText("규칙 계좌 · 추정 23:58")).toBeNull();
  });

  it("앞 값이 없는 외딴 꼬리 점(그 계좌의 마지막 줄이 없음)은 본 계열 색 점으로 남는다", () => {
    observeAs(600, 240);
    const rows = ROWS.map((row, index) => (index === 2 ? { ...row, a: null, "a~": null } : row));
    const { container } = render(<LineChart data={rows} series={SERIES} valueFormat={money} />);
    const dots = [...container.querySelectorAll(".recharts-line-dots circle")];
    // 본 계열 a의 둘째 날(앞뒤 null 아님 — 첫날과 이어짐)은 점이 아니고, 꼬리의 외딴 점 하나만
    expect(dots.map((dot) => dot.getAttribute("fill"))).toEqual([SERIES_COLORS.blue]);
  });

  it("히어로 끝값은 본 계열의 최고·최저 — 꼬리(오늘 추정 점)의 값은 끝값으로 적지 않는다", () => {
    observeAs(600, 260);
    const { container } = render(
      <LineChart data={ROWS.map(({ date, a, "a~": tail }) => ({ date, a, "a~": tail }))} series={[SERIES[0], SERIES[2]]} variant="hero" valueFormat={money} />,
    );
    expect([...container.querySelectorAll("[data-hero-extreme]")].map((node) => node.textContent)).toEqual(["100,400.00", "100,000.00"]);
  });

  it("히어로 — 최고가 꼬리가 시작하는 점이면 끝 맞춤(글이 오른쪽 꼬리 점선 위로 번지지 않게)", () => {
    observeAs(600, 260);
    const rows = [
      { date: "2026-10-23", a: 99_967.28, "a~": null },
      { date: "2026-10-30", a: 100_136.32, "a~": 100_136.32 },
      { date: "2026-11-02", a: null, "a~": 100_556.89 },
    ];
    const { container } = render(<LineChart data={rows} series={[SERIES[0], SERIES[2]]} variant="hero" valueFormat={money} />);
    const [high, low] = [...container.querySelectorAll("[data-hero-extreme]")];
    expect([high.textContent, high.getAttribute("text-anchor"), high.getAttribute("dy")]).toEqual(["100,136.32", "end", "-8"]);
    expect([low.textContent, low.getAttribute("text-anchor"), low.getAttribute("dy")]).toEqual(["99,967.28", "start", "17"]);
  });

  it("히어로 — 꼬리도 중립 잉크(var(--text)) 점선", () => {
    observeAs(600, 260);
    const { container } = render(
      <LineChart data={ROWS.map(({ date, a, "a~": tail }) => ({ date, a, "a~": tail }))} series={[SERIES[0], SERIES[2]]} variant="hero" />,
    );
    const paths = linePaths(container);
    expect(paths.map((path) => [path.getAttribute("stroke"), path.getAttribute("stroke-dasharray")])).toEqual([
      ["var(--text)", null],
      ["var(--text)", "3 3"],
    ]);
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

  it("오래됨이면 '이전 값' + 사유(경고색)", () => {
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
