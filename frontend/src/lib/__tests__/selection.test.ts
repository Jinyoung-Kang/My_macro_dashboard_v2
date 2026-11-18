import { describe, expect, it } from "vitest";
import { effectiveSelection, toggleSelection } from "../selection";

const ALL = ["a", "b", "c"];

describe("QA-003 기관 필터 — 비우면 전체", () => {
  it("처음에는 전체가 선택된 것으로 보이고 요청도 전체다", () => {
    expect(effectiveSelection(ALL, [])).toEqual(ALL);
    expect(ALL.every((k) => effectiveSelection(ALL, []).includes(k))).toBe(true);
  });

  it("전체에서 하나를 누르면 그 기관만 빠진다 (예전: 그 기관 하나만 남았다)", () => {
    expect(toggleSelection(ALL, [], "b")).toEqual(["a", "c"]);
    expect(effectiveSelection(ALL, ["a", "c"]).includes("b")).toBe(false);
  });

  it("뺐던 기관을 다시 누르면 전체로 돌아간다(빈 목록)", () => {
    expect(toggleSelection(ALL, ["a", "c"], "b")).toEqual([]);
  });

  it("마지막 하나까지 빼면 전체가 된다 — 아무도 없는 교집합은 없다", () => {
    expect(toggleSelection(ALL, ["a"], "a")).toEqual([]);
  });
});
