/**
 * 13F 포트폴리오 화면의 '상위 종목 분기별 비중 히트맵'(WeightHeatmap) 칸 바탕(QA-692). 값은 합성입니다(가상 종목 이름).
 *
 * 칸 바탕이 차트 계열 파랑(#3987e5 — 강조 파랑 #4c90f0과 OKLab ΔE 3.4)의 rgba 농도였습니다. 작업대 실행 명세 §3-5는 순차(히트맵)를 강조·상승·하락과
 * 다른 계열의 한 색 밝기 단계로 정하는데, 농도 칠하기는 그 규칙과 다르고 소스에 hex가 없어 팔레트 기록 시험(paletteRecord)도 보지 못했습니다.
 * 고친 뒤에는 칠한 칸마다 값 ÷ 최댓값으로 정한 다섯 단계(data-step 1~5 — (0,0.2]→1 … (0.8,1]→5)의 순차 팔레트 바탕입니다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WeightHeatmap } from "@/components/charts";

afterEach(cleanup);

/** 순차 팔레트 다섯 단계(어두운 단계 = 0에 가까움 → 밝은 단계 = 큼) — 보라 단계 다섯, 명세 §3-5 순차 팔레트. */
const STEPS = ["#5c255c", "#7c327c", "#9d3f9d", "#bd6bbd", "#d69fd6"];

/** jsdom이 인라인 바탕을 적는 꼴(rgb(r, g, b)). */
function rgbOf(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

describe("비중 히트맵 칸은 순차 팔레트 다섯 단계로 칠한다(QA-692)", () => {
  // 수정 전 실패(plain it으로 돌린 값): 첫 칸(10 ÷ 10 = 1, 단계 5)의 data-step이 null이고 바탕이 'rgba(57, 135, 229, 0.7)'.
  it.fails("칠한 칸마다 data-step 1~5와 그 단계의 바탕 — 계열 파랑 rgba가 없다", () => {
    render(
      <WeightHeatmap
        dates={["2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30"]}
        series={{ "SYNTHETIC ALPHA CO": [10, 8, 6, 4], "SYNTHETIC BETA CO": [0.03, 2, 0, null] }}
      />,
    );
    // 최댓값 10 — 비율 1·0.8·0.6·0.4 → 단계 5·4·3·2, 0.003·0.2 → 단계 1·1, 미보유(0)·모름(null)은 칠하지 않음.
    const expected: Record<string, (number | null)[]> = {
      "SYNTHETIC ALPHA CO": [5, 4, 3, 2],
      "SYNTHETIC BETA CO": [1, 1, null, null],
    };
    for (const [name, steps] of Object.entries(expected)) {
      const row = screen.getByText(name).closest("tr") as HTMLTableRowElement;
      const cells = Array.from(row.querySelectorAll("td")).filter((cell) => cell.textContent !== name);
      expect(cells).toHaveLength(steps.length);
      steps.forEach((step, index) => {
        const cell = cells[index];
        if (step === null) return;
        expect({ step: cell.getAttribute("data-step"), background: cell.style.backgroundColor }, `${name} ${index}`).toEqual({
          step: String(step),
          background: rgbOf(STEPS[step - 1]),
        });
      });
    }
    expect(document.body.innerHTML).not.toContain("rgba(57, 135, 229");
  });
});
