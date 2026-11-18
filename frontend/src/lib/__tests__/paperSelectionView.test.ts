/** 기관 선정(미국) 후보 거르기(lib/paperSelectionView — 작업대 P6): 칸마다 받은 줄 수, 고른 칸의 줄만(차례 그대로), 모르는 자격·선정은 들지 않음. */
import { describe, expect, it } from "vitest";

import { candidateFilterOptions, filterCandidates } from "../paperSelectionView";

const rows = [
  { cik: "1", eligible: true, selected: true },
  { cik: "2", eligible: true, selected: false },
  { cik: "3", eligible: false, selected: false },
  { cik: "4", eligible: null as unknown as boolean, selected: null as unknown as boolean },
];

describe("후보 거르기", () => {
  it("칸마다 받은 줄 수", () => {
    expect(candidateFilterOptions(rows).map((option) => [option.key, option.label, option.count])).toEqual([
      ["all", "전체", 4], ["eligible", "자격 있음", 2], ["selected", "선정", 1],
    ]);
    expect(candidateFilterOptions([]).map((option) => option.count)).toEqual([0, 0, 0]);
  });

  it("고른 칸의 줄만 — 서버 차례 그대로, 전체는 모두", () => {
    expect(filterCandidates(rows, "eligible").map((row) => row.cik)).toEqual(["1", "2"]);
    expect(filterCandidates(rows, "selected").map((row) => row.cik)).toEqual(["1"]);
    expect(filterCandidates(rows, "all").map((row) => row.cik)).toEqual(["1", "2", "3", "4"]);
  });
});
