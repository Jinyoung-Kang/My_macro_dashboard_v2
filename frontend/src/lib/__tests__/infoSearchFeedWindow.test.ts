/**
 * 결과 목록의 이어 그리기(성능 3차 작업 C, ADR 0052 결정 8) — 지금 그릴 날짜 묶음 수와 그 줄 수. 묶음을 자르지 않고, 줄이 있으면 적어도 한 묶음.
 */
import { describe, expect, it } from "vitest";
import { FEED_WINDOW_INITIAL_ROWS, FEED_WINDOW_STEP_ROWS, feedWindowGroupCount, feedWindowRowCount } from "../infoSearch";

const groups = (...sizes: number[]) => sizes.map((size) => ({ entries: Array.from({ length: size }, (_, index) => index) }));

describe("feedWindowGroupCount · feedWindowRowCount", () => {
  it("앞에서부터 줄 수가 목표 이상이 될 때까지의 묶음 — 묶음을 자르지 않는다", () => {
    const list = groups(25, 25, 25, 25, 25);
    expect(feedWindowGroupCount(list, 60)).toBe(3);
    expect(feedWindowRowCount(list, 3)).toBe(75);
    expect(feedWindowGroupCount(list, 75)).toBe(3);
    expect(feedWindowGroupCount(list, 76)).toBe(4);
  });

  it("첫 묶음이 목표보다 커도 그 묶음은 통째로", () => {
    const list = groups(400, 10);
    expect(feedWindowGroupCount(list, 60)).toBe(1);
    expect(feedWindowRowCount(list, 1)).toBe(400);
  });

  it("줄이 목표보다 적으면 전부, 묶음이 없으면 0", () => {
    expect(feedWindowGroupCount(groups(3, 4), 60)).toBe(2);
    expect(feedWindowRowCount(groups(3, 4), 2)).toBe(7);
    expect(feedWindowGroupCount([], 60)).toBe(0);
    expect(feedWindowRowCount([], 0)).toBe(0);
    expect(feedWindowRowCount(groups(3, 4), 99)).toBe(7);
  });

  it("처음 60줄, 이어서 120줄씩", () => {
    expect(FEED_WINDOW_INITIAL_ROWS).toBe(60);
    expect(FEED_WINDOW_STEP_ROWS).toBe(120);
  });
});
