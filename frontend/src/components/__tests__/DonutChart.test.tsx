/**
 * 구성 도넛(DonutChart) — 실제 Recharts로 그려 봅니다.
 *
 *  - Tab으로 닿는 SVG(role="application", tabindex=0)에 이름이 붙는다(바깥 figure가 아니라) — A11Y-2
 *  - 직접 라벨은 차트 너비가 넉넉할 때만 — 좁으면 SVG 끝에서 잘리므로 끄고 범례·툴팁·표에 맡긴다 — DV-2
 *  - 조각 사이 틈은 바탕색 선 — 기본은 테마 토큰 var(--surface), 다른 바탕 위면 넘긴 값(라이트·다크를 CSS가 바꿈)
 *
 * jsdom에는 ResizeObserver가 없어 ResponsiveContainer가 크기를 모릅니다 — 관찰을 시작하면 정한 크기를 바로 알려 주는 가짜를 씁니다.
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DonutChart, type DonutSegment } from "@/components/charts";

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

const SEGMENTS: DonutSegment[] = [
  { key: "a", name: "NVDA", value: 35, color: "#3987e5", valueText: "35.0%", label: "NVDA 35.0%" },
  { key: "b", name: "MSFT", value: 30, color: "#d95926", valueText: "30.0%", label: "MSFT 30.0%" },
  { key: "c", name: "AAPL", value: 25, color: "#199e70", valueText: "25.0%", label: "AAPL 25.0%" },
  { key: "d", name: "현금", value: 10, color: "#9ea7b3", valueText: "10.0%", label: "현금 10.0%" },
];
const NAME = "규칙 계좌 구성 도넛: NVDA 35.0%, MSFT 30.0%, AAPL 25.0%, 현금 10.0%";

describe("DonutChart", () => {
  it("A11Y-2: Tab으로 닿는 SVG 자체에 이름이 있고, figure에는 같은 이름을 다시 달지 않는다", () => {
    observeAs(480, 220);
    const { container } = render(<DonutChart segments={SEGMENTS} ariaLabel={NAME} />);
    const surface = container.querySelector("svg.recharts-surface");
    expect(surface).not.toBeNull();
    expect(surface?.getAttribute("tabindex")).toBe("0");
    expect(surface?.getAttribute("role")).toBe("application");
    expect(surface?.getAttribute("aria-label")).toBe(NAME);
    expect(container.querySelector("figure")?.getAttribute("aria-label")).toBeNull();
  });

  it("DV-2: 넓으면 고리 밖에 직접 라벨을, 휴대폰 너비면 라벨 없이(잘리지 않게) 그린다", () => {
    observeAs(480, 220);
    const wide = render(<DonutChart segments={SEGMENTS} ariaLabel={NAME} />);
    const wideTexts = [...wide.container.querySelectorAll("text")].map((node) => node.textContent);
    expect(wideTexts).toEqual(expect.arrayContaining(["NVDA 35.0%", "현금 10.0%"]));
    cleanup();

    observeAs(260, 220);
    const narrow = render(<DonutChart segments={SEGMENTS} ariaLabel={NAME} />);
    expect(narrow.container.querySelector("svg.recharts-surface")).not.toBeNull();
    expect([...narrow.container.querySelectorAll("text")].map((node) => node.textContent)).not.toContain("NVDA 35.0%");
  });

  it("조각 사이 틈은 바탕색 선 — 기본은 var(--surface), 페이지 바탕 위면 넘긴 var(--bg)", () => {
    observeAs(480, 220);
    const strokes = (container: HTMLElement) =>
      [...container.querySelectorAll("path.recharts-sector")].map((node) => node.getAttribute("stroke"));

    const card = render(<DonutChart segments={SEGMENTS} ariaLabel={NAME} />);
    expect(strokes(card.container)).toHaveLength(SEGMENTS.length);
    expect(new Set(strokes(card.container))).toEqual(new Set(["var(--surface)"]));
    cleanup();

    const page = render(<DonutChart segments={SEGMENTS} surface="var(--bg)" ariaLabel={NAME} />);
    expect(new Set(strokes(page.container))).toEqual(new Set(["var(--bg)"]));
  });

  // QA-497: 고대비(forced-colors)에서 조각(SVG fill)은 작성자 색을 남기는데 툴팁의 조각 견본(CSS 바탕색)은 Canvas로 지워졌습니다(툴팁 상자
  // 바탕도 Canvas라 견본이 사라짐 — 계좌 상세 1440). 견본도 조각과 같은 규칙(forced-color-adjust-none)이어야 합니다. 재현 커밋에서는 it.fails였습니다.
  // QA-500: 도넛 툴팁은 tooltipStyle()을 펼치지 않고 wrapperStyle만 따로 주어 isAnimationActive가 Recharts 기본값 'auto'였습니다 — 움직임 줄이기를
  // 켜지 않은 화면에서 'transform 400ms ease'로 미끄러졌습니다(계좌 상세 구성 도넛, 명세 §3-8). 재현 커밋에서는 it.fails였습니다.
  it("QA-500: 조각을 가리키면 뜨는 툴팁에 transition이 없다", async () => {
    observeAs(480, 220);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, x: 0, y: 0, width: 480, height: 220, right: 480, bottom: 220, toJSON: () => ({}),
    } as DOMRect);
    const { container } = render(<DonutChart segments={SEGMENTS} ariaLabel={NAME} />);
    await act(async () => {
      fireEvent.mouseEnter(container.querySelector(".recharts-pie-sector") as Element);
    });
    const tooltip = container.querySelector(".recharts-tooltip-wrapper") as HTMLElement;
    await waitFor(() => expect(tooltip.style.visibility).toBe("visible"));
    expect(tooltip.style.transition).toBe("");
  });

  it("QA-497: 조각을 가리키면 뜨는 툴팁의 조각 견본은 forced-color-adjust-none(조각 색 그대로)", async () => {
    observeAs(480, 220);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, x: 0, y: 0, width: 480, height: 220, right: 480, bottom: 220, toJSON: () => ({}),
    } as DOMRect);
    const { container } = render(<DonutChart segments={SEGMENTS} ariaLabel={NAME} />);
    await act(async () => {
      fireEvent.mouseEnter(container.querySelector(".recharts-pie-sector") as Element);
    });
    const tooltip = container.querySelector(".recharts-tooltip-wrapper") as HTMLElement;
    const swatch = tooltip.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(swatch, "툴팁 견본").not.toBeNull();
    expect(swatch.style.backgroundColor).toBe("rgb(57, 135, 229)");
    expect((swatch.getAttribute("class") ?? "").split(/\s+/)).toContain("forced-color-adjust-none");
  });
});
