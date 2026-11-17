/**
 * 차트 툴팁 줄의 차례·글자색(lib/chartTooltip) — 기관 13F 비중 추이 툴팁(2026-11-17 사용자 요구: 그 분기의 보유 순위 차례, 글자는 선 색).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLTIP_BG_HEX, contrastRatio, readableOn, valueDescKey } from "../chartTooltip";

/** 기관 13F 비중 추이 선 색(institutions/page.tsx SERIES_COLORS — 차례 고정). */
const WEIGHT_LINE_COLORS = [
  "#4798ee", "#1da967", "#c68206", "#eb5070", "#a371f7",
  "#22a2bd", "#dd6836", "#8b8dd1", "#81a022", "#cf7787",
];

describe("툴팁 바탕", () => {
  it("globals.css의 --surface-2와 같다(바탕이 바뀌면 대비 계산도 함께 바뀌어야 함)", () => {
    const css = readFileSync(join(__dirname, "../../app/globals.css"), "utf8");
    const match = /--surface-2:\s*(#[0-9a-f]{6})/i.exec(css);
    expect(match?.[1].toLowerCase()).toBe(TOOLTIP_BG_HEX);
  });
});

describe("readableOn", () => {
  it("비중 추이 선 색 열 개 모두 툴팁 바탕에서 글자 대비 4.5 이상이 된다", () => {
    for (const color of WEIGHT_LINE_COLORS) {
      expect(contrastRatio(readableOn(color), TOOLTIP_BG_HEX)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("이미 4.5 이상인 색은 그대로, 모자란 색(빨강·보라·주황)만 밝힌다", () => {
    const changed = WEIGHT_LINE_COLORS.filter((color) => readableOn(color) !== color);
    expect(changed).toEqual(["#eb5070", "#a371f7", "#dd6836"]);
    for (const color of changed) {
      // 흰색과 섞기만 하므로 채널 차례(색상)는 그대로 — 가장 밝은 채널이 같다.
      const before = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
      const after = [1, 3, 5].map((i) => parseInt(readableOn(color).slice(i, i + 2), 16));
      expect(after.indexOf(Math.max(...after))).toBe(before.indexOf(Math.max(...before)));
      expect(contrastRatio(readableOn(color), TOOLTIP_BG_HEX)).toBeLessThan(5.2);
    }
  });

  it("16진수 여섯 자리가 아닌 값은 그대로 돌려준다", () => {
    expect(readableOn("var(--accent)")).toBe("var(--accent)");
    expect(readableOn("#abc")).toBe("#abc");
  });
});

describe("valueDescKey", () => {
  it("값이 큰 차례로, 같은 값은 처음 차례 그대로, 숫자가 아니면 맨 뒤", () => {
    const items = [
      { name: "APPLE", value: 12.5 },
      { name: "BANK", value: 30.1 },
      { name: "CHEVRON", value: "x" },
      { name: "DELTA", value: 12.5 },
      { name: "EBAY", value: 0.4 },
    ];
    const sorted = [...items].sort((a, b) => valueDescKey(a) - valueDescKey(b));
    expect(sorted.map((item) => item.name)).toEqual(["BANK", "APPLE", "DELTA", "EBAY", "CHEVRON"]);
  });
});
