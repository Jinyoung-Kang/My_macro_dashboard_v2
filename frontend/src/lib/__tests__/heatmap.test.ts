/**
 * 표 히트맵의 순차 팔레트와 단계(lib/heatmap.ts — 작업대 실행 명세 §3-5 순차 팔레트, QA-692).
 *  - 단계 경계: 0·모름·max 0 이하는 칠하지 않음(0), (0, 0.2]→1 … (0.8, 1]→5(경계 값은 아래 단계), 최댓값을 넘는 값도 5
 *  - 단계 글자색: 그 단계 바탕 위 WCAG 4.5:1 이상(글자 토큰 값은 globals.css :root에서 읽음)
 *  - 범례 구간: 다섯 구간이 0~1을 빈틈없이 잇는다
 * 팔레트 hex 자체의 기록(기대 상수)과 밝기 차례는 팔레트 기록 시험(paletteRecord.test.ts)이 봅니다.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { heatmapStep, heatmapStepRange, SEQUENTIAL_STEPS, SEQUENTIAL_TEXT } from "../heatmap";

const CSS = readFileSync(resolve(__dirname, "../../app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const ROOT = /(?:^|[;}])\s*:root\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? "";

/** :root의 토큰 hex(var(--text) → #f6f7f9). */
function tokenHex(variable: string): string {
  const name = /^var\((--[\w-]+)\)$/.exec(variable)?.[1];
  const value = name ? new RegExp(`${name}:\\s*(#[0-9a-f]{6});`, "i").exec(ROOT)?.[1] : undefined;
  if (!value) throw new Error(`globals.css :root에서 ${variable} 값을 찾지 못했습니다`);
  return value.toLowerCase();
}

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => linear(parseInt(hex.slice(at, at + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("heatmapStep — 값 ÷ 최댓값의 단계", () => {
  it("칠하지 않음(0): 모름(null·undefined·NaN·무한)·0·음수·max 0 이하·max가 유한하지 않음", () => {
    expect(heatmapStep(null, 10)).toBe(0);
    expect(heatmapStep(undefined, 10)).toBe(0);
    expect(heatmapStep(Number.NaN, 10)).toBe(0);
    expect(heatmapStep(Number.POSITIVE_INFINITY, 10)).toBe(0);
    expect(heatmapStep(0, 10)).toBe(0);
    expect(heatmapStep(-0, 10)).toBe(0);
    expect(heatmapStep(-3, 10)).toBe(0);
    expect(heatmapStep(5, 0)).toBe(0);
    expect(heatmapStep(5, -1)).toBe(0);
    expect(heatmapStep(5, Number.NaN)).toBe(0);
  });

  it("경계: (0, 0.2]→1 · (0.2, 0.4]→2 · (0.4, 0.6]→3 · (0.6, 0.8]→4 · (0.8, 1]→5", () => {
    expect(heatmapStep(Number.MIN_VALUE, 1)).toBe(1);
    expect(heatmapStep(0.003, 1)).toBe(1);
    expect(heatmapStep(0.2, 1)).toBe(1);
    expect(heatmapStep(0.2 + 1e-12, 1)).toBe(2);
    expect(heatmapStep(0.4, 1)).toBe(2);
    expect(heatmapStep(0.4 + 1e-12, 1)).toBe(3);
    expect(heatmapStep(0.6, 1)).toBe(3);
    expect(heatmapStep(0.6 + 1e-12, 1)).toBe(4);
    expect(heatmapStep(0.8, 1)).toBe(4);
    expect(heatmapStep(0.8 + 1e-12, 1)).toBe(5);
    expect(heatmapStep(1, 1)).toBe(5);
  });

  it("최댓값에 견준 비율로 — 값과 최댓값의 단위는 상관없고, 최댓값을 넘는 값도 5", () => {
    expect([10, 8, 6, 4, 2, 0.03].map((value) => heatmapStep(value, 10))).toEqual([5, 4, 3, 2, 1, 1]);
    expect([100, 60, 20].map((value) => heatmapStep(value, 100))).toEqual([5, 3, 1]);
    expect(heatmapStep(3, 5)).toBe(3);
    expect(heatmapStep(12, 10)).toBe(5);
  });
});

describe("순차 팔레트 단계 글자색", () => {
  it("다섯 단계 바탕과 다섯 단계 글자색 — 단계 1~3은 본문색, 4~5는 바탕색", () => {
    expect(SEQUENTIAL_STEPS).toHaveLength(5);
    expect(SEQUENTIAL_TEXT).toEqual(["var(--text)", "var(--text)", "var(--text)", "var(--bg)", "var(--bg)"]);
  });

  it.each([1, 2, 3, 4, 5])("단계 %i — 칸 글자와 바탕이 WCAG 4.5:1 이상", (step) => {
    const back = SEQUENTIAL_STEPS[step - 1];
    const text = tokenHex(SEQUENTIAL_TEXT[step - 1]);
    const value = contrast(text, back);
    expect(value, `${text} on ${back} = ${value.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
  });
});

describe("heatmapStepRange — 범례 구간", () => {
  it("다섯 구간이 0~1을 빈틈없이 잇는다", () => {
    const ranges = ([1, 2, 3, 4, 5] as const).map((step) => heatmapStepRange(step));
    expect(ranges).toEqual([
      [0, 0.2],
      [0.2, 0.4],
      [0.4, 0.6],
      [0.6, 0.8],
      [0.8, 1],
    ]);
  });

  it("구간의 위 끝은 그 단계의 마지막 값이다(단계 경계와 같음)", () => {
    for (const step of [1, 2, 3, 4, 5] as const) {
      const [low, high] = heatmapStepRange(step);
      expect(heatmapStep(high, 1)).toBe(step);
      expect(heatmapStep(low + 1e-12, 1)).toBe(step);
    }
  });
});
