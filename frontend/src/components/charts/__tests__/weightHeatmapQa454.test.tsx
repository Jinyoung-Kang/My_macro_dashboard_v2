/**
 * 13F 포트폴리오 화면의 '상위 종목 분기별 비중 히트맵'(WeightHeatmap) 칸 글(QA-454 검토 지적). 값은 합성입니다(가상 종목 이름).
 *
 * 칸은 소수 한 자리로 적어, 그 분기에 들고 있었지만 0.05% 미만인 비중이 '0.0%'로 보였습니다. 범례는 '·'(보유하지 않음)와 '—'(값을 모름)를
 * 구별하는데, 실제로 든 칸이 '0.0%'면 없는 값처럼 읽힙니다(QA-454). 보이는 자릿수에서 0이 되는 양수는 '<0.1%'로 적고, 미보유·모름은 그대로입니다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WeightHeatmap } from "@/components/charts";

afterEach(cleanup);

/** 칸의 보이는 글 — 낭독 전용 글(sr-only)은 뺍니다. */
function visibleText(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  copy.querySelectorAll(".sr-only").forEach((node) => node.remove());
  return copy.textContent ?? "";
}

describe("비중 히트맵 — 0보다 크고 0.05% 미만이면 '<0.1%'(QA-454)", () => {
  it("보유 중인 아주 작은 비중·보통 비중·미보유·모름을 서로 다르게 적는다", () => {
    render(
      <WeightHeatmap
        dates={["2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30"]}
        series={{ "SYNTHETIC SMALL CO": [0.03, 5, 0, null] }}
      />,
    );
    const row = screen.getByText("SYNTHETIC SMALL CO").closest("tr") as HTMLTableRowElement;
    // 종목 이름 칸은 행 머리(th), 값 칸은 td — 보이는 글(낭독 전용 '값 없음' 뺌)을 견줍니다.
    const cells = Array.from(row.querySelectorAll("td")).map(visibleText);
    expect(cells).toEqual(["<0.1%", "5.0%", "·", "—"]);
  });
});
