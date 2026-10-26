/**
 * 선 차트 규칙(lib/lineChart.ts) — 축은 데이터 범위(0 바닥을 지어내지 않음), 0선은 뜻이 있을 때만, 색은 되풀이하지 않음,
 * 모르는 값은 null(선 끊김)·툴팁 "—", 외딴 점은 점으로.
 */
import { describe, expect, it } from "vitest";

import {
  hasLineValues,
  isolatedPointIndexes,
  lineChartLabel,
  lineSeriesColors,
  lineTooltipModel,
  lineValue,
  lineXTicks,
  lineYAxis,
  normalizeLineRows,
  type LineRow,
} from "@/lib/lineChart";

const ONE = [{ key: "v", label: "순유동성" }];
const PALETTE = ["#3987e5", "#d95926", "#199e70"];

describe("lineValue · hasLineValues · normalizeLineRows", () => {
  it("유한한 숫자만 값 — null·'N/A'·NaN·Infinity는 모름, 0은 값", () => {
    const row: LineRow = { date: "d", a: 0, b: null, c: "N/A", d: Number.NaN, e: Number.POSITIVE_INFINITY };
    expect(lineValue(row, "a")).toBe(0);
    for (const key of ["b", "c", "d", "e", "없는 키"]) {
      expect(lineValue(row, key)).toBeNull();
    }
  });

  it("행이 없거나 모든 칸이 모름이면 그릴 값이 없다", () => {
    expect(hasLineValues([], ONE)).toBe(false);
    expect(hasLineValues([{ date: "a", v: null }, { date: "b", v: "N/A" }], ONE)).toBe(false);
    expect(hasLineValues([{ date: "a", v: null }, { date: "b", v: 0 }], ONE)).toBe(true);
  });

  it("Recharts에 넘길 행은 계열 칸을 숫자 아니면 null로 — 글이 좌표(NaN)로 가지 않게", () => {
    expect(normalizeLineRows([{ date: "a", v: "N/A", extra: "무시" }, { date: "b", v: 2 }], ONE)).toEqual([
      { date: "a", v: null },
      { date: "b", v: 2 },
    ]);
  });
});

describe("lineYAxis", () => {
  it("데이터 범위 — 5.85~6.0이면 0 바닥을 만들지 않고, 눈금은 범위 끝값 두 개", () => {
    const axis = lineYAxis([{ date: "a", v: 5.85 }, { date: "b", v: 6.0 }], ONE);
    expect(axis).not.toBeNull();
    const [lower, upper] = axis!.domain;
    expect(lower).toBeGreaterThan(5);
    expect(lower).toBeLessThan(5.85);
    expect(upper).toBeGreaterThan(6.0);
    expect(axis!.ticks).toEqual(axis!.domain);
    expect(axis!.zeroLine).toBe(false);
  });

  it("여러 계열의 값을 모두 모아 범위를 정한다(모르는 칸은 빼고)", () => {
    const axis = lineYAxis(
      [{ date: "a", x: 1, y: null }, { date: "b", x: 2, y: 10 }],
      [{ key: "x", label: "X" }, { key: "y", label: "Y" }],
    );
    expect(axis!.domain[0]).toBeLessThan(1);
    expect(axis!.domain[1]).toBeGreaterThan(10);
  });

  it("includeZero이고 0을 가로지르면 0선, 값이 모두 양수면 0은 축 끝(0선 없음)", () => {
    const crossing = lineYAxis([{ date: "a", v: -0.4 }, { date: "b", v: 1.2 }], ONE, { includeZero: true });
    expect(crossing!.domain[0]).toBeLessThan(0);
    expect(crossing!.domain[1]).toBeGreaterThan(0);
    expect(crossing!.zeroLine).toBe(true);

    const positive = lineYAxis([{ date: "a", v: 1.2 }, { date: "b", v: 1.5 }], ONE, { includeZero: true });
    expect(positive!.domain[0]).toBe(0);
    expect(positive!.zeroLine).toBe(false);
  });

  it("includeZero가 없으면 음수 계열이어도 0선을 긋지 않는다", () => {
    const axis = lineYAxis([{ date: "a", v: -0.4 }, { date: "b", v: 1.2 }], ONE);
    expect(axis!.zeroLine).toBe(false);
  });

  it("nonNegative면 아래 끝이 0 아래로 내려가지 않는다 — 0 근처 값도", () => {
    const axis = lineYAxis([{ date: "a", v: 0.001 }, { date: "b", v: 0.5 }], ONE, { nonNegative: true });
    expect(axis!.domain[0]).toBe(0);
    const far = lineYAxis([{ date: "a", v: 100 }, { date: "b", v: 110 }], ONE, { nonNegative: true });
    expect(far!.domain[0]).toBeGreaterThan(90);
  });

  // 0으로 올리면 [0, -2.84]처럼 아래 끝이 위 끝보다 커져 축이 뒤집혔다.
  it("nonNegative여도 값이 모두 음수면 데이터 범위 그대로 — 축이 뒤집히지 않는다", () => {
    const axis = lineYAxis([{ date: "a", v: -5 }, { date: "b", v: -3 }], ONE, { nonNegative: true });
    const [lower, upper] = axis!.domain;
    expect(lower).toBeLessThan(upper);
    expect(lower).toBeLessThan(-5);
    expect(upper).toBeGreaterThan(-3);
    expect(upper).toBeLessThan(0);
    expect(axis!.ticks).toEqual(axis!.domain);
  });

  it("값이 하나도 없으면 null", () => {
    expect(lineYAxis([{ date: "a", v: null }], ONE)).toBeNull();
    expect(lineYAxis([], ONE)).toBeNull();
  });
});

describe("lineXTicks", () => {
  it("첫 날짜와 마지막 날짜만", () => {
    expect(lineXTicks([{ date: "2026-01-02" }, { date: "2026-05-01" }, { date: "2026-10-26" }])).toEqual([
      "2026-01-02",
      "2026-10-26",
    ]);
    expect(lineXTicks([{ date: "2026-10-26" }])).toEqual(["2026-10-26"]);
    expect(lineXTicks([])).toEqual([]);
  });
});

describe("lineSeriesColors", () => {
  it("넘긴 색이 이기고, 없으면 같은 자리의 기본 색", () => {
    expect(
      lineSeriesColors(
        [{ key: "a", label: "A" }, { key: "b", label: "B", color: "var(--up)" }, { key: "c", label: "C" }],
        PALETTE,
      ),
    ).toEqual(["#3987e5", "var(--up)", "#199e70"]);
  });

  it("기본 색은 되풀이하지 않는다 — 넷째 계열에 색이 없으면 오류", () => {
    const four = ["a", "b", "c", "d"].map((key) => ({ key, label: key.toUpperCase() }));
    expect(() => lineSeriesColors(four, PALETTE)).toThrow(/4번째 계열 "D"/);
    // 넷째에 색을 주면 괜찮다.
    expect(lineSeriesColors([...four.slice(0, 3), { key: "d", label: "D", color: "#606870" }], PALETTE)).toHaveLength(4);
  });
});

describe("isolatedPointIndexes", () => {
  it("앞뒤가 모두 모름인 값만 — 양 끝도 이웃 하나만 보면 됨", () => {
    const rows: LineRow[] = [
      { date: "1", v: 1 },
      { date: "2", v: null },
      { date: "3", v: 3 },
      { date: "4", v: null },
      { date: "5", v: 5 },
      { date: "6", v: 6 },
      { date: "7", v: null },
    ];
    expect(isolatedPointIndexes(rows, "v")).toEqual([0, 2]);
    expect(isolatedPointIndexes([{ date: "1", v: 7 }], "v")).toEqual([0]);
  });
});

describe("lineTooltipModel", () => {
  const series = [{ key: "a", label: "총자산" }, { key: "b", label: "역레포" }];
  const format = (value: number) => `${value.toFixed(1)}T`;

  it("날짜 · 계열마다 이름·색·서식된 값 · 출처 줄", () => {
    const model = lineTooltipModel({ date: "2026-10-24", a: 6.71, b: 0.005 }, series, PALETTE, format, "FRED");
    expect(model.date).toBe("2026-10-24");
    expect(model.items).toEqual([
      { key: "a", label: "총자산", color: "#3987e5", text: "6.7T" },
      { key: "b", label: "역레포", color: "#d95926", text: "0.0T" },
    ]);
    expect(model.sourceLine).toBe("출처 · FRED");
  });

  it("값이 없는 계열은 줄을 남기고 '—', 출처를 모르면 출처 줄 없음", () => {
    const model = lineTooltipModel({ date: "d", a: null, b: "N/A" }, series, PALETTE, format, "N/A");
    expect(model.items.map((item) => item.text)).toEqual(["—", "—"]);
    expect(model.sourceLine).toBeNull();
    expect(lineTooltipModel({ date: "d", a: 1 }, series, PALETTE, format).sourceLine).toBeNull();
  });
});

describe("lineChartLabel", () => {
  it("계열 이름과 기간", () => {
    const series = [{ key: "a", label: "총자산" }, { key: "b", label: "역레포" }];
    expect(lineChartLabel([{ date: "2026-01-02" }, { date: "2026-10-26" }], series)).toBe(
      "선 차트: 총자산, 역레포 · 2026-01-02 ~ 2026-10-26",
    );
  });
});
