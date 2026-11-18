/**
 * 표 히트맵(components/charts/HeatmapTable.tsx) — 13F 포트폴리오 화면의 '상위 종목 분기별 비중 히트맵'(WeightHeatmap). 값은 합성입니다(가상 종목 이름).
 *
 * DOM 고정: 합성 자료 하나로 그린 표의 요소마다 태그·클래스·인라인 모양·속성·글을 줄로 적어 둡니다. 히트맵 몸통을 옮기거나 일반 표 히트맵으로 바꾸는
 * 커밋이 같은 DOM을 내는지 이 목록으로 봅니다(겉모양을 바꾸는 커밋은 같은 커밋에서 이 목록을 고칩니다).
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WeightHeatmap } from "@/components/charts";

afterEach(cleanup);

const DATES = ["2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30"];
/** 최댓값 10 — 비율 1·0.8·0.6·0.4·0.003·0.2와 미보유(0)·모름(null). */
const SERIES = {
  "SYNTHETIC ALPHA CO": [10, 8, 6, 4],
  "SYNTHETIC BETA CO": [0.03, 2, 0, null],
};

/** 요소 하나를 한 줄로 — 깊이·태그·속성(이름 차례)·바로 아래 글 마디. */
function pinLines(root: Element): string[] {
  const lines: string[] = [];
  const visit = (element: Element, depth: number) => {
    const attributes = [...element.attributes]
      .map((attribute) => `${attribute.name}=${JSON.stringify(attribute.value)}`)
      .sort();
    const text = [...element.childNodes]
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent ?? "")
      .join("");
    lines.push(`${"  ".repeat(depth)}${element.tagName.toLowerCase()}${attributes.length > 0 ? ` ${attributes.join(" ")}` : ""}${text ? ` ${JSON.stringify(text)}` : ""}`);
    for (const child of element.children) visit(child, depth + 1);
  };
  visit(root, 0);
  return lines;
}

describe("비중 히트맵 DOM 고정(합성 자료)", () => {
  it("요소마다 태그·클래스·인라인 모양·속성·글이 아래 목록과 같다", () => {
    const { container } = render(<WeightHeatmap dates={DATES} series={SERIES} />);
    expect(pinLines(container.firstElementChild as Element)).toEqual([
      "div aria-label=\"비중 히트맵 (좌우 스크롤)\" class=\"overflow-x-auto\" role=\"region\" tabindex=\"0\"",
      "  table class=\"w-full min-w-[640px] border-collapse text-xs\"",
      "    thead",
      "      tr class=\"text-xs text-text-3\"",
      "        th class=\"sticky left-0 bg-surface px-3 py-2 text-left font-medium\" \"종목\"",
      "        th class=\"px-2 py-2 text-right font-medium tabular-nums\" \"25-12-31\"",
      "        th class=\"px-2 py-2 text-right font-medium tabular-nums\" \"26-03-31\"",
      "        th class=\"px-2 py-2 text-right font-medium tabular-nums\" \"26-06-30\"",
      "        th class=\"px-2 py-2 text-right font-medium tabular-nums\" \"26-09-30\"",
      "    tbody",
      "      tr",
      "        td class=\"sticky left-0 bg-surface px-3 py-1.5 text-left text-text-2\" \"SYNTHETIC ALPHA CO\"",
      "        td class=\"px-2 py-1.5 text-right tabular-nums\" style=\"background-color: rgba(57, 135, 229, 0.7); color: var(--text);\" title=\"SYNTHETIC ALPHA CO · 2025-12-31\" \"10.0%\"",
      "        td class=\"px-2 py-1.5 text-right tabular-nums\" style=\"background-color: rgba(57, 135, 229, 0.576); color: var(--text);\" title=\"SYNTHETIC ALPHA CO · 2026-03-31\" \"8.0%\"",
      "        td class=\"px-2 py-1.5 text-right tabular-nums\" style=\"background-color: rgba(57, 135, 229, 0.452); color: var(--text);\" title=\"SYNTHETIC ALPHA CO · 2026-06-30\" \"6.0%\"",
      "        td class=\"px-2 py-1.5 text-right tabular-nums\" style=\"background-color: rgba(57, 135, 229, 0.328); color: var(--text);\" title=\"SYNTHETIC ALPHA CO · 2026-09-30\" \"4.0%\"",
      "      tr",
      "        td class=\"sticky left-0 bg-surface px-3 py-1.5 text-left text-text-2\" \"SYNTHETIC BETA CO\"",
      "        td class=\"px-2 py-1.5 text-right tabular-nums\" style=\"background-color: rgba(57, 135, 229, 0.082); color: var(--text);\" title=\"SYNTHETIC BETA CO · 2025-12-31\" \"<0.1%\"",
      "        td class=\"px-2 py-1.5 text-right tabular-nums\" style=\"background-color: rgba(57, 135, 229, 0.204); color: var(--text);\" title=\"SYNTHETIC BETA CO · 2026-03-31\" \"2.0%\"",
      "        td class=\"px-2 py-1.5 text-right tabular-nums\" style=\"background-color: transparent;\" title=\"SYNTHETIC BETA CO · 2026-06-30\" \"·\"",
      "        td class=\"px-2 py-1.5 text-right tabular-nums\" style=\"background-color: transparent;\" title=\"SYNTHETIC BETA CO · 2026-09-30\" \"—\"",
      "  p class=\"mt-2 text-xs text-text-3\" \"색이 진할수록 비중이 큽니다. \\\"·\\\"는 그 분기에 는 뜻이고, \\\"—\\\"는 는 뜻입니다 — 둘은 다릅니다.\"",
      "    b \"보유하지 않았다\"",
      "    b \"값을 모른다\"",
    ]);
  });
});
