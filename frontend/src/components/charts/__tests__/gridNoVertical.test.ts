/**
 * 세로 격자를 그리지 않는 CartesianGrid는 빈 세로 좌표 생성기(NO_VERTICAL_GRID)를 받는다(ADR 0047 결정 8, 성능 개선 작업 B2).
 * Recharts 3.10.1은 `vertical={false}`여도 세로 좌표를 만들려고 X축 눈금 글을 DOM에 넣어 잽니다 — 매크로 화면 첫 그리기의 큰 몫이었음.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { NO_VERTICAL_GRID } from "../frame";

const CHART_FILES = ["components/charts/index.tsx", "components/charts/LineChart.tsx"];
const SRC = resolve(__dirname, "../../..");

describe("CartesianGrid의 세로 좌표", () => {
  it("생성기는 늘 빈 목록", () => {
    expect(NO_VERTICAL_GRID()).toEqual([]);
  });

  it.each(CHART_FILES)("%s — vertical={false}인 격자는 모두 NO_VERTICAL_GRID를 받는다", (file) => {
    const grids = [...readFileSync(resolve(SRC, file), "utf8").matchAll(/<CartesianGrid\b[^>]*>/g)].map((m) => m[0]);
    const withoutVertical = grids.filter((tag) => tag.includes("vertical={false}"));
    expect(withoutVertical.length).toBeGreaterThan(0);
    expect(withoutVertical.filter((tag) => !tag.includes("verticalCoordinatesGenerator={NO_VERTICAL_GRID}"))).toEqual([]);
  });
});
