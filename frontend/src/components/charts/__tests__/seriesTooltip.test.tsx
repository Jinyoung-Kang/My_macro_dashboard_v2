/**
 * 공용 선 차트 툴팁의 차례·글자색 — `MultiLineSeries`의 `tooltipOrder="value"`·`tooltipSeriesColors`가 Recharts 툴팁에 넘기는 것
 * (`itemSorter: valueDescKey`, `content: SeriesColorTooltipContent`)을 기본 툴팁 내용으로 그려 봅니다. jsdom은 차트 크기가 0이라 마우스로
 * 툴팁을 띄울 수 없어, 툴팁 내용 부품을 Recharts가 넘기는 꼴의 값으로 바로 그립니다.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SeriesColorTooltipContent } from "../index";
import { valueDescKey } from "@/lib/chartTooltip";

afterEach(() => cleanup());

/** 한 분기의 툴팁 값 — 줄 차례는 계열 차례(선 차례). 이름 차례와 값 차례가 다르게 골랐습니다. */
const PAYLOAD = [
  { name: "APPLE INC", value: 21.4, color: "#4798ee", dataKey: "a", graphicalItemId: "a" },
  { name: "BANK OF AMERICA", value: 11.2, color: "#1da967", dataKey: "b", graphicalItemId: "b" },
  { name: "COCA COLA", value: 9.9, color: "#c68206", dataKey: "c", graphicalItemId: "c" },
  { name: "AMERICAN EXPRESS", value: 15.0, color: "#eb5070", dataKey: "d", graphicalItemId: "d" },
  { name: "CHEVRON", value: 6.3, color: "#a371f7", dataKey: "e", graphicalItemId: "e" },
];

function renderTooltip(itemSorter?: typeof valueDescKey) {
  const { container } = render(
    <SeriesColorTooltipContent
      payload={PAYLOAD}
      label="2026-06-30"
      itemSorter={itemSorter}
      itemStyle={{ padding: 0 }}
      formatter={(value, name) => [`${Number(value).toFixed(2)}%`, String(name)]}
    />,
  );
  return [...container.querySelectorAll<HTMLLIElement>("li.recharts-tooltip-item")];
}

describe("계열 색 툴팁 내용", () => {
  it("valueDescKey면 그 분기 값이 큰 차례로 놓는다(이름 차례가 아님)", () => {
    const names = renderTooltip(valueDescKey).map((li) => li.querySelector(".recharts-tooltip-item-name")?.textContent);
    expect(names).toEqual(["APPLE INC", "AMERICAN EXPRESS", "BANK OF AMERICA", "COCA COLA", "CHEVRON"]);
  });

  it("줄 글자가 선 색 — 대비가 모자란 색(빨강·보라)만 밝힌 같은 색", () => {
    const colorOf = (name: string) =>
      renderTooltip(valueDescKey)
        .find((li) => li.querySelector(".recharts-tooltip-item-name")?.textContent === name)
        ?.style.color;
    cleanup();
    expect(colorOf("APPLE INC")).toBe("rgb(71, 152, 238)");
    cleanup();
    expect(colorOf("BANK OF AMERICA")).toBe("rgb(29, 169, 103)");
    cleanup();
    const red = colorOf("AMERICAN EXPRESS");
    expect(red).not.toBe("rgb(235, 80, 112)");
    expect(red).toMatch(/^rgb\(/);
    cleanup();
    expect(colorOf("CHEVRON")).not.toBe("rgb(163, 113, 247)");
  });

  it("제목(분기)과 값 글은 기본 툴팁 꼴 그대로", () => {
    const items = renderTooltip(valueDescKey);
    expect(items[0].querySelector(".recharts-tooltip-item-value")?.textContent).toBe("21.40%");
    expect(document.querySelector(".recharts-tooltip-label")?.textContent).toBe("2026-06-30");
  });
});
