/**
 * HeatmapTable — 표 히트맵(작업대 실행 명세 §3-5 순차 팔레트, P5b — 13F 비중 히트맵·기관 간 유사도 행렬, P6·P7이 다시 씀). 값은 합성입니다(가상 이름).
 * 네 상태: 값(칠한 칸 data-step·순차 단계 바탕), 모름(공용 '—' — 낭독 '값 없음'), 0(zeroText — 보이는 기호 + 낭독 글, 칠하지 않음), 빈 행·열(emptyText 한 줄 — 표 없음).
 * 칸·범례·DOM 고정·넘김 안내의 자세한 사례는 components/charts/__tests__의 HeatmapTable·weightHeatmapQa713 시험(비중 히트맵 감싸개와 함께)에 있습니다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { HeatmapTable } from "../HeatmapTable";

afterEach(cleanup);

const COLUMNS = [
  { key: "a", label: "가" },
  { key: "b", label: "나" },
  { key: "c", label: "다" },
];

function renderTable(rows: { key: string; label: string; values: (number | null)[] }[], columns = COLUMNS) {
  return render(
    <HeatmapTable
      caption="합성 행렬"
      rowHeader="이름"
      columns={columns}
      rows={rows}
      max={10}
      format={(value) => value.toFixed(1)}
      zeroText={{ text: "·", sr: "합성 영" }}
      legend={{ stepLabel: (step) => `단계 ${step}` }}
    />,
  );
}

describe("HeatmapTable — 네 상태", () => {
  it("값: 칠한 칸에 data-step(값 ÷ 최댓값 — (0.8,1]→5, (0,0.2]→1)과 숫자 글, 영역 이름 '{표 이름} (좌우 스크롤)'", () => {
    renderTable([{ key: "r", label: "가상 행", values: [10, 1, 5] }]);
    expect(screen.getByRole("region", { name: "합성 행렬 (좌우 스크롤)" })).toBeTruthy();
    const cells = [...screen.getByRole("row", { name: /가상 행/ }).querySelectorAll("td")];
    expect(cells.map((cell) => [cell.textContent, cell.getAttribute("data-step")])).toEqual([
      ["10.0", "5"],
      ["1.0", "1"],
      ["5.0", "3"],
    ]);
  });

  it("모름: 공용 '—'(낭독 '값 없음') — 칠하지 않음, 0으로 채우지 않음", () => {
    renderTable([{ key: "r", label: "가상 행", values: [null, 4, null] }]);
    const cells = [...screen.getByRole("row", { name: /가상 행/ }).querySelectorAll("td")];
    expect(cells.map((cell) => [cell.textContent, cell.hasAttribute("data-step")])).toEqual([
      ["—값 없음", false],
      ["4.0", true],
      ["—값 없음", false],
    ]);
  });

  it("0: zeroText의 보이는 기호(읽기에서 뺌)와 낭독 글 — 칠하지 않음", () => {
    renderTable([{ key: "r", label: "가상 행", values: [0, 2, 0] }]);
    const zero = screen.getByRole("row", { name: /가상 행/ }).querySelector("td") as HTMLElement;
    expect([zero.textContent, zero.hasAttribute("data-step"), zero.querySelector('[aria-hidden="true"]')?.textContent]).toEqual(["·합성 영", false, "·"]);
  });

  it("빈 행·열: 표·범례 없이 emptyText 한 줄(기본 '표시할 값이 없습니다.')", () => {
    const { unmount } = renderTable([]);
    expect(screen.getByText("표시할 값이 없습니다.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("list", { name: "칸 색 단계" })).toBeNull();
    unmount();
    renderTable([{ key: "r", label: "가상 행", values: [] }], []);
    expect(screen.getByText("표시할 값이 없습니다.")).toBeTruthy();
    expect(screen.queryByRole("region")).toBeNull();
  });
});
