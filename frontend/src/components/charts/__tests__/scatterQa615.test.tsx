/**
 * QA-615 — 산점도(ScatterPlot, /correlation) 점의 불투명도 0.55가 놓인 면 위 그래픽 대비 3:1(WCAG 1.4.11)에 못 미치던 것(D1 넘김 'scatter-dot-opacity-contrast').
 *
 * 점은 계열 첫 색(#3987e5)을 불투명도로 옅게 칠합니다. 브라우저는 점 색과 바탕을 sRGB 값으로 섞어(알파 합성) 그리므로, 보이는 점 색은
 * `불투명도 × 점 색 + (1 − 불투명도) × 바탕`이고 그 색과 바탕의 대비가 점이 보이는 정도입니다. 0.55면 패널 면(surface #1c2127) 위 2.27:1,
 * 페이지 바탕(bg #111418) 위 2.37:1이었습니다. 계열 색 자체(paletteRecord가 지키는 hex)는 그대로 두고 불투명도만 봅니다.
 *
 * 실제 Recharts로 그린 점(.recharts-symbols)의 fill·fill-opacity를 읽고, 두 면의 색은 globals.css의 토큰 선언(첫 블록 — 어두운 한 벌)에서 읽습니다.
 * jsdom에는 크기가 없어 ResponsiveContainer가 너비를 모르므로 관찰을 시작하면 정한 크기를 바로 알려 주는 가짜를 씁니다(wrappers.test와 같음).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`#rrggbb 꼴이 아닙니다: ${hex}`);
  return [0, 2, 4].map((at) => parseInt(match[1].slice(at, at + 2), 16) / 255) as Rgb;
}

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** 불투명도 alpha로 칠한 색이 바탕 위에 보이는 색(sRGB 값 알파 합성). */
function over(color: Rgb, alpha: number, back: Rgb): Rgb {
  return color.map((channel, index) => alpha * channel + (1 - alpha) * back[index]) as Rgb;
}

/** globals.css에서 처음 나오는 토큰 선언 값(#rrggbb) — 첫 블록이 어두운 한 벌(:root)입니다. */
function token(name: string): string {
  const css = readFileSync(resolve(__dirname, "../../../app/globals.css"), "utf8");
  const match = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(css);
  if (!match) throw new Error(`globals.css에 --${name} 선언이 없습니다`);
  return match[1];
}

describe("QA-615 산점도 점의 대비", () => {
  // 고치기 전: 두 점 모두 surface 위 2.27:1·bg 위 2.37:1(fill #3987e5 × fill-opacity 0.55) — 재현 커밋에서는 it.fails.
  it.fails("그린 점의 색과 불투명도로 섞인 색이 패널 면(surface)·페이지 바탕(bg) 위 모두 3:1 이상이다", () => {
    observeAs(600, 320);
    const { container } = render(
      <ScatterPlot data={[{ x: 1, y: 2, date: "2026-01-02" }, { x: -1, y: 0.5, date: "2026-01-09" }]} xLabel="금리 변화" yLabel="지수 변화" />,
    );
    const dots = [...container.querySelectorAll("path.recharts-symbols")];
    expect(dots).toHaveLength(2);
    // 3:1에 못 미치는 (면, 점 색 × 불투명도, 대비) — 비어 있어야 합니다.
    const short = dots.flatMap((dot) => {
      const fill = dot.getAttribute("fill") as string;
      const opacity = Number(dot.getAttribute("fill-opacity") ?? "1");
      return ["surface", "bg"].flatMap((surface) => {
        const back = rgb(token(surface));
        const ratio = contrast(over(rgb(fill), opacity, back), back);
        return ratio >= 3 ? [] : [`${surface} 위 ${fill} × ${opacity} = ${ratio.toFixed(2)}:1`];
      });
    });
    expect(short).toEqual([]);
  });
});
