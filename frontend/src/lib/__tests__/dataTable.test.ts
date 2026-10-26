/**
 * 표 정렬 규칙(lib/dataTable.ts) — 모르는 값은 방향과 무관하게 맨 뒤, 같은 값은 원래 순서, 원래 배열은 그대로.
 */
import { describe, expect, it } from "vitest";

import { ariaSortOf, compareSortValues, nextSort, sortRows } from "@/lib/dataTable";

type Row = { id: string; v: number | string | null };
const ids = (rows: readonly Row[]) => rows.map((row) => row.id);
const byV = (row: Row) => row.v;

describe("sortRows", () => {
  const rows: Row[] = [
    { id: "a", v: 3 },
    { id: "b", v: null },
    { id: "c", v: -1 },
    { id: "d", v: "N/A" },
    { id: "e", v: 10 },
    { id: "f", v: 0 },
  ];

  it("오름차순 — 숫자 크기, 모르는 값(null·'N/A')은 맨 뒤(원래 순서)", () => {
    expect(ids(sortRows(rows, byV, "asc"))).toEqual(["c", "f", "a", "e", "b", "d"]);
  });

  it("내림차순에서도 모르는 값은 맨 뒤 — 맨 위로 올라와 '가장 큰 값'처럼 읽히지 않게", () => {
    expect(ids(sortRows(rows, byV, "desc"))).toEqual(["e", "a", "f", "c", "b", "d"]);
  });

  it("0은 값이다 — 모르는 값과 섞이지 않는다", () => {
    const sorted = sortRows(rows, byV, "asc");
    expect(sorted.findIndex((row) => row.id === "f")).toBeLessThan(sorted.findIndex((row) => row.id === "b"));
  });

  it("NaN·'—'·빈 글도 모르는 값", () => {
    const odd: Row[] = [
      { id: "x", v: Number.NaN },
      { id: "y", v: "—" },
      { id: "z", v: "" },
      { id: "w", v: 1 },
    ];
    expect(ids(sortRows(odd, byV, "desc"))).toEqual(["w", "x", "y", "z"]);
  });

  it("같은 값은 원래 순서(안정) — 두 방향 모두", () => {
    const ties: Row[] = [
      { id: "1", v: 5 },
      { id: "2", v: 5 },
      { id: "3", v: 1 },
      { id: "4", v: 5 },
    ];
    expect(ids(sortRows(ties, byV, "asc"))).toEqual(["3", "1", "2", "4"]);
    expect(ids(sortRows(ties, byV, "desc"))).toEqual(["1", "2", "4", "3"]);
  });

  it("글은 가나다, 글 속 숫자는 크기로", () => {
    const names: Row[] = [
      { id: "다", v: "다올" },
      { id: "가", v: "가온" },
      { id: "10", v: "10호" },
      { id: "2", v: "2호" },
    ];
    expect(ids(sortRows(names, byV, "asc"))).toEqual(["2", "10", "가", "다"]);
  });

  it("원래 배열을 바꾸지 않고, 정렬 값이 없으면 원래 순서의 복사본", () => {
    const before = ids(rows);
    const same = sortRows(rows, undefined, "desc");
    expect(ids(same)).toEqual(before);
    expect(same).not.toBe(rows);
    sortRows(rows, byV, "desc");
    expect(ids(rows)).toEqual(before);
  });
});

describe("compareSortValues", () => {
  it("숫자끼리는 크기, 섞이면 숫자가 앞", () => {
    expect(compareSortValues(2, 10)).toBeLessThan(0);
    expect(compareSortValues(1, "가")).toBeLessThan(0);
    expect(compareSortValues("가", 1)).toBeGreaterThan(0);
  });
});

describe("nextSort · ariaSortOf", () => {
  it("새 열은 오름차순부터, 같은 열은 오름↔내림", () => {
    expect(nextSort(null, "value")).toEqual({ key: "value", dir: "asc" });
    expect(nextSort({ key: "value", dir: "asc" }, "value")).toEqual({ key: "value", dir: "desc" });
    expect(nextSort({ key: "value", dir: "desc" }, "value")).toEqual({ key: "value", dir: "asc" });
    expect(nextSort({ key: "value", dir: "desc" }, "name")).toEqual({ key: "name", dir: "asc" });
  });

  it("aria-sort는 지금 정렬한 열에만", () => {
    expect(ariaSortOf({ key: "value", dir: "asc" }, "value")).toBe("ascending");
    expect(ariaSortOf({ key: "value", dir: "desc" }, "value")).toBe("descending");
    expect(ariaSortOf({ key: "value", dir: "desc" }, "name")).toBeUndefined();
    expect(ariaSortOf(null, "value")).toBeUndefined();
  });
});
