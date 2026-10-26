/**
 * 자산 행·스파크라인·기간 탭의 표시 규칙(lib/patternRows.ts).
 *  - 값 글: valueText가 이기고, 그 글이 "N/A"면 숫자가 있어도 "—"(null). 0은 값, NaN은 없음
 *  - 행 모델: 플래그·경고·출처가 하나라도 있으면 배지 줄, 빈 보조·경고 글은 버림, 스파크라인은 알려진 점 2개 이상
 *  - 스파크라인: 알려진 점 2개 미만이면 null, null에서 끊고 순번 간격을 지킴, 큰 값이 위(작은 y)
 *  - 기간 탭: 허용 밖은 그리지 않음, 고른 값이 허용 밖이면 첫 허용 키, ←·→ 돎·Home·End
 */
import { describe, expect, it } from "vitest";

import { allowedRangeKey, assetRowModel, assetValueText, rangeKeyAfter, sparklineSegments, visibleRanges } from "../patternRows";

describe("assetValueText", () => {
  it("숫자는 소수 둘째 자리·천 단위 구분, 0은 값이다", () => {
    expect(assetValueText(1234.567)).toBe("1,234.57");
    expect(assetValueText(0)).toBe("0.00");
    expect(assetValueText(-3.2)).toBe("-3.20");
  });

  it("모르면 null — null·undefined·NaN·Infinity", () => {
    for (const value of [null, undefined, NaN, Infinity, -Infinity]) {
      expect(assetValueText(value)).toBeNull();
    }
  });

  it("valueText가 오면 숫자 서식보다 우선(앞뒤 공백만 뗌)", () => {
    expect(assetValueText(5800.1234, "5,800.1")).toBe("5,800.1");
    expect(assetValueText(null, " 1,420.50 ")).toBe("1,420.50");
    expect(assetValueText(1, "수집 실패")).toBe("수집 실패");
  });

  it("valueText가 'N/A'·빈 글·'—'면 숫자가 있어도 값 없음 — 수집기가 없다고 한 값을 되살리지 않는다", () => {
    for (const text of ["N/A", "n/a", " N/A ", "", "  ", "—", "-"]) {
      expect(assetValueText(42, text)).toBeNull();
    }
  });

  it("valueText가 null·undefined면 숫자를 서식", () => {
    expect(assetValueText(42, null)).toBe("42.00");
    expect(assetValueText(42, undefined)).toBe("42.00");
  });
});

describe("assetRowModel", () => {
  it("플래그가 없으면 배지 줄 없음", () => {
    expect(assetRowModel({ value: 1 })).toEqual({
      valueText: "1.00",
      sub: null,
      warning: null,
      showSpark: false,
      hasBadges: false,
    });
  });

  it("추정·대리·이전 값·경고·출처 가운데 하나라도 있으면 배지 줄", () => {
    expect(assetRowModel({ value: 1, isEstimated: true }).hasBadges).toBe(true);
    expect(assetRowModel({ value: 1, isProxy: true }).hasBadges).toBe(true);
    expect(assetRowModel({ value: 1, isStale: true }).hasBadges).toBe(true);
    expect(assetRowModel({ value: 1, warning: "수집 실패" }).hasBadges).toBe(true);
    expect(assetRowModel({ value: 1 }, true).hasBadges).toBe(true);
  });

  it("보조·경고 글이 비었거나 'N/A'면 버린다 — 빈 경고로 배지 줄을 만들지 않음", () => {
    const model = assetRowModel({ value: null, sub: " N/A ", warning: "  " });
    expect(model.sub).toBeNull();
    expect(model.warning).toBeNull();
    expect(model.hasBadges).toBe(false);
    expect(model.valueText).toBeNull();
    expect(assetRowModel({ value: null, sub: " SPX ", warning: " 수집 실패 " })).toMatchObject({ sub: "SPX", warning: "수집 실패" });
  });

  it("스파크라인은 알려진 점이 2개 이상일 때만", () => {
    expect(assetRowModel({ value: 1, spark: [1, 2] }).showSpark).toBe(true);
    expect(assetRowModel({ value: 1, spark: [1, null, NaN] }).showSpark).toBe(false);
    expect(assetRowModel({ value: 1, spark: [] }).showSpark).toBe(false);
  });
});

describe("sparklineSegments", () => {
  it("알려진 점이 2개 미만이면 null", () => {
    expect(sparklineSegments([], 80, 24)).toBeNull();
    expect(sparklineSegments([5], 80, 24)).toBeNull();
    expect(sparklineSegments([null, 5, null], 80, 24)).toBeNull();
    expect(sparklineSegments([NaN, 5, Infinity], 80, 24)).toBeNull();
  });

  it("크기가 inset보다 작으면 null", () => {
    expect(sparklineSegments([1, 2], 2, 24)).toBeNull();
    expect(sparklineSegments([1, 2], 80, 0)).toBeNull();
  });

  it("두 점 — 한 조각, X는 inset부터 width−inset까지, 큰 값이 위(작은 y)", () => {
    const segments = sparklineSegments([1, 2], 80, 24);
    expect(segments).toHaveLength(1);
    const [first, last] = segments![0];
    expect(first.x).toBe(1.5);
    expect(last.x).toBe(78.5);
    expect(last.y).toBeLessThan(first.y);
    for (const point of segments![0]) {
      expect(point.y).toBeGreaterThanOrEqual(1.5);
      expect(point.y).toBeLessThanOrEqual(22.5);
    }
  });

  it("null에서 선을 끊고, 빈 자리만큼 X 간격을 남긴다(이어 붙이지 않음)", () => {
    const segments = sparklineSegments([1, 2, null, 3, 4], 41, 24, 0.5)!;
    expect(segments).toHaveLength(2);
    expect(segments[0].map((point) => point.x)).toEqual([0.5, 10.5]);
    expect(segments[1].map((point) => point.x)).toEqual([30.5, 40.5]);
  });

  it("혼자 남은 점은 점 하나짜리 조각", () => {
    const segments = sparklineSegments([1, null, 2, 3], 80, 24)!;
    expect(segments.map((segment) => segment.length)).toEqual([1, 2]);
  });

  it("값이 모두 같으면 수평선(가운데)", () => {
    const segments = sparklineSegments([100, 100, 100], 80, 24)!;
    const ys = segments[0].map((point) => point.y);
    expect(new Set(ys).size).toBe(1);
    expect(ys[0]).toBe(12);
  });

  it("0을 억지로 넣지 않는다 — 100~101 사이 움직임이 높이를 넓게 쓴다", () => {
    const [low, high] = sparklineSegments([100, 101], 80, 24)![0];
    expect(low.y - high.y).toBeGreaterThan(15);
  });
});

const RANGES = [
  { key: "1y", label: "1년" },
  { key: "3y", label: "3년" },
  { key: "5y", label: "5년" },
  { key: "10y", label: "10년" },
] as const;
type Key = (typeof RANGES)[number]["key"];

describe("visibleRanges", () => {
  it("allowed가 없으면 전부", () => {
    expect(visibleRanges(RANGES).map((range) => range.key)).toEqual(["1y", "3y", "5y", "10y"]);
  });

  it("allowed 안의 것만, 순서는 ranges를 따른다", () => {
    expect(visibleRanges(RANGES, ["3y", "1y"]).map((range) => range.key)).toEqual(["1y", "3y"]);
  });

  it("allowed가 비면 아무것도 없다", () => {
    expect(visibleRanges(RANGES, [])).toEqual([]);
  });
});

describe("allowedRangeKey", () => {
  it("고른 값이 허용 안이면 그대로", () => {
    expect(allowedRangeKey("3y", RANGES, ["1y", "3y"])).toBe("3y");
    expect(allowedRangeKey("10y", RANGES)).toBe("10y");
  });

  it("허용 밖이면 그려지는 첫 탭(ranges 순서)", () => {
    expect(allowedRangeKey("10y", RANGES, ["3y", "1y"])).toBe("1y");
    expect(allowedRangeKey(null, RANGES, ["5y"])).toBe("5y");
    expect(allowedRangeKey(undefined, RANGES)).toBe("1y");
  });

  it("그려지는 탭이 없으면 null", () => {
    expect(allowedRangeKey("1y", RANGES, [])).toBeNull();
    expect(allowedRangeKey("1y", [] as { key: string }[])).toBeNull();
  });
});

describe("rangeKeyAfter", () => {
  const keys: Key[] = ["1y", "3y", "5y"];

  it("→는 다음, 끝에서 처음으로 돈다", () => {
    expect(rangeKeyAfter(keys, "1y", "ArrowRight")).toBe("3y");
    expect(rangeKeyAfter(keys, "5y", "ArrowRight")).toBe("1y");
  });

  it("←는 이전, 처음에서 끝으로 돈다", () => {
    expect(rangeKeyAfter(keys, "3y", "ArrowLeft")).toBe("1y");
    expect(rangeKeyAfter(keys, "1y", "ArrowLeft")).toBe("5y");
  });

  it("Home·End", () => {
    expect(rangeKeyAfter(keys, "3y", "Home")).toBe("1y");
    expect(rangeKeyAfter(keys, "3y", "End")).toBe("5y");
  });

  it("지금 탭이 목록에 없으면 →는 처음, ←는 끝", () => {
    expect(rangeKeyAfter(keys, null, "ArrowRight")).toBe("1y");
    expect(rangeKeyAfter(keys, "10y", "ArrowLeft")).toBe("5y");
  });

  it("다른 키·빈 목록은 null", () => {
    expect(rangeKeyAfter(keys, "1y", "Enter")).toBeNull();
    expect(rangeKeyAfter(keys, "1y", "ArrowDown")).toBeNull();
    expect(rangeKeyAfter([], "1y", "ArrowRight")).toBeNull();
  });
});
