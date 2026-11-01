/**
 * 선 차트 규칙(lib/lineChart.ts) — 축은 데이터 범위(0 바닥을 지어내지 않음), 0선은 뜻이 있을 때만, 색은 되풀이하지 않음,
 * 모르는 값은 null(선 끊김)·툴팁 "—", 외딴 점은 점으로.
 * 문지르기: Recharts의 활성 자리(숫자·글)를 순번으로 바꾸고 범위를 검사, 그 점의 값·날짜·기간의 첫 유효값 대비 변화(모르면 null), 추정 점 표시.
 * 꼬리 계열(tailOf — 장중 값 단계의 오늘 추정 점선): 범례에서 빠지고, 색은 본 계열 색, 툴팁 줄은 꼬리 자신의 점에만(그 점에서는 본 계열 '—' 줄이 빠짐).
 */
import { describe, expect, it } from "vitest";

import {
  hasLineValues,
  inLegend,
  isolatedPointIndexes,
  lineChartLabel,
  lineSeriesColors,
  lineTooltipModel,
  lineValue,
  lineXTicks,
  lineYAxis,
  normalizeLineRows,
  scrubIndex,
  scrubModel,
  tailPointShown,
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

  it("색을 주지 않은 꼬리 계열은 본 계열 색 — 기본 색 자리를 쓰지 않고, 본 계열이 없으면 오류", () => {
    const three = ["a", "b", "c"].map((key) => ({ key, label: key.toUpperCase() }));
    // 셋째 뒤의 꼬리 둘 — 기본 색이 셋뿐이어도 오류가 아니고, 각자 본 계열 색(넘긴 색이면 그 색)
    expect(
      lineSeriesColors([...three, { key: "a~", label: "A 꼬리", tailOf: "a" }, { key: "c~", label: "C 꼬리", tailOf: "c", color: "#606870" }], PALETTE),
    ).toEqual(["#3987e5", "#d95926", "#199e70", "#3987e5", "#606870"]);
    expect(lineSeriesColors([{ key: "a", label: "A", color: "var(--text)" }, { key: "a~", label: "A 꼬리", tailOf: "a" }], PALETTE)).toEqual([
      "var(--text)",
      "var(--text)",
    ]);
    expect(() => lineSeriesColors([{ key: "a", label: "A" }, { key: "x~", label: "X 꼬리", tailOf: "x" }], PALETTE)).toThrow(/꼬리 계열 "X 꼬리"/);
  });
});

describe("꼬리 계열(tailOf) — 범례·툴팁 자리", () => {
  const tail = { key: "a~", label: "A · 추정 23:58", tailOf: "a" };

  it("범례에서 빠지는 계열 — legend:false와 꼬리", () => {
    expect(inLegend({})).toBe(true);
    expect(inLegend({ legend: false })).toBe(false);
    expect(inLegend({ tailOf: "a" })).toBe(false);
  });

  it("꼬리 줄은 꼬리 자신의 점(본 계열 값이 없는 행)에만 — 꼬리가 시작하는 마지막 줄에서는 아님", () => {
    expect(tailPointShown({ date: "10-30", a: null, "a~": 101_234.56 }, tail)).toBe(true);
    expect(tailPointShown({ date: "10-29", a: 101_200, "a~": 101_200 }, tail)).toBe(false);
    expect(tailPointShown({ date: "10-28", a: 101_000, "a~": null }, tail)).toBe(false);
    expect(tailPointShown({ date: "10-30", a: null, "a~": 1 }, { key: "a" })).toBe(false);
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

  it("꼬리 계열 — 꼬리 점에서는 꼬리 이름과 값(본 계열 '—' 줄은 뺌), 마지막 줄에서는 꼬리 줄 없음, 다른 계열의 '—'는 그대로", () => {
    const withTail = [...series, { key: "a~", label: "총자산 · 추정 23:58", tailOf: "a" }];
    const colors = [...PALETTE.slice(0, 2), PALETTE[0]];
    const point = lineTooltipModel({ date: "10-30", a: null, b: null, "a~": 6.75 }, withTail, colors, format);
    expect(point.items).toEqual([
      { key: "b", label: "역레포", color: "#d95926", text: "—" },
      { key: "a~", label: "총자산 · 추정 23:58", color: "#3987e5", text: "6.8T" },
    ]);
    const last = lineTooltipModel({ date: "10-29", a: 6.71, b: 0.005, "a~": 6.71 }, withTail, colors, format);
    expect(last.items.map((item) => item.label)).toEqual(["총자산", "역레포"]);
    // 꼬리가 없는 옛 날: 꼬리 줄이 없고 본 계열 '—'는 남음(그날 기록이 없음을 보임)
    const old = lineTooltipModel({ date: "10-01", a: null, b: 0.1, "a~": null }, withTail, colors, format);
    expect(old.items.map((item) => `${item.label} ${item.text}`)).toEqual(["총자산 —", "역레포 0.1T"]);
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

describe("scrubIndex — Recharts 활성 자리 → 행 순번", () => {
  it("숫자와 숫자 글(키보드·터치의 \"3\")은 범위 안이면 그 순번", () => {
    expect(scrubIndex(0, 4)).toBe(0);
    expect(scrubIndex(3, 4)).toBe(3);
    expect(scrubIndex("2", 4)).toBe(2);
  });

  it("없음·빈 글·숫자가 아닌 글·소수·음수·범위 밖은 null(문지르지 않음)", () => {
    for (const raw of [null, undefined, "", " ", "abc", Number.NaN, 1.5, "1.5", -1, 4, "4", true, {}]) {
      expect(scrubIndex(raw, 4)).toBeNull();
    }
    expect(scrubIndex(0, 0)).toBeNull();
  });
});

describe("scrubModel — 문지르는 점의 표시 글", () => {
  const NAV: LineRow[] = [
    { date: "2026-10-23", v: null },
    { date: "2026-10-24", v: 100_000 },
    { date: "2026-10-27", v: 101_500 },
    { date: "2026-10-28", v: null },
    { date: "2026-10-29", v: 99_000 },
  ];
  const usd = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  it("값 · 날짜 · 기간의 첫 유효값(첫 행이 비면 그다음) 대비 변화량·변화율", () => {
    expect(scrubModel(NAV, "v", 2, usd)).toEqual({
      valueText: "101,500.00",
      dateText: "2026-10-27",
      change: 1_500,
      changePct: 1.5,
      isEstimated: false,
      estimateNote: null,
    });
    const down = scrubModel(NAV, "v", 4, usd)!;
    expect(down.change).toBe(-1_000);
    expect(down.changePct).toBe(-1);
    // 첫 유효값 자신은 변화 0(지어낸 값이 아니라 실제로 같은 점)
    expect(scrubModel(NAV, "v", 1, usd)).toMatchObject({ change: 0, changePct: 0 });
  });

  it("그 점의 값이 없으면 '—'와 변화 null(칩 생략) — 날짜는 그대로", () => {
    expect(scrubModel(NAV, "v", 3, usd)).toMatchObject({ valueText: "—", dateText: "2026-10-28", change: null, changePct: null });
    expect(scrubModel(NAV, "v", 0, usd)).toMatchObject({ valueText: "—", change: null });
  });

  it("문지르지 않거나(null) 범위 밖·모르는 계열이면", () => {
    expect(scrubModel(NAV, "v", null, usd)).toBeNull();
    expect(scrubModel(NAV, "v", 5, usd)).toBeNull();
    expect(scrubModel([], "v", 0, usd)).toBeNull();
    expect(scrubModel(NAV, "없는 키", 2, usd)).toMatchObject({ valueText: "—", change: null });
  });

  it("기준이 0 이하이면 변화율은 null(비율의 뜻이 없음), 변화량은 그대로", () => {
    const spread: LineRow[] = [{ date: "a", v: -0.4 }, { date: "b", v: 0.2 }];
    expect(scrubModel(spread, "v", 1, String)).toMatchObject({ change: 0.6000000000000001, changePct: null });
    expect(scrubModel([{ date: "a", v: 0 }, { date: "b", v: 2 }], "v", 1, String)).toMatchObject({ change: 2, changePct: null });
  });

  it("추정 점 — 그 날짜를 문지르면 isEstimated와 설명, 다른 날짜는 아님(장중 값 단계의 오늘 추정 점 자리)", () => {
    const rows: LineRow[] = [...NAV, { date: "2026-10-30", v: 100_250 }];
    const estimate = { date: "2026-10-30", note: "장중 14:05" };
    expect(scrubModel(rows, "v", 5, usd, { estimate })).toMatchObject({ valueText: "100,250.00", isEstimated: true, estimateNote: "장중 14:05" });
    expect(scrubModel(rows, "v", 4, usd, { estimate })).toMatchObject({ isEstimated: false, estimateNote: null });
    expect(scrubModel(rows, "v", 5, usd, { estimate: { date: "2026-10-30", note: "N/A" } })).toMatchObject({ isEstimated: true, estimateNote: null });
  });

  it("꼬리 점 — 값은 꼬리 키(그날 본 계열 값 없음)에서 읽고 같은 첫 유효값 대비 변화, 다른 날은 본 키 그대로", () => {
    const rows: LineRow[] = [
      ...NAV.map((row, index) => ({ ...row, tail: index === NAV.length - 1 ? row.v : null })),
      { date: "2026-10-30", v: null, tail: 100_250 },
    ];
    const estimate = { date: "2026-10-30", note: "23:58", valueKey: "tail" };
    expect(scrubModel(rows, "v", 5, usd, { estimate })).toEqual({
      valueText: "100,250.00",
      dateText: "2026-10-30",
      change: 250,
      changePct: 0.25,
      isEstimated: true,
      estimateNote: "23:58",
    });
    // 꼬리가 시작하는 마지막 줄은 본 계열 값 그대로(추정 아님)
    expect(scrubModel(rows, "v", 4, usd, { estimate })).toMatchObject({ valueText: "99,000.00", isEstimated: false, estimateNote: null });
    // 꼬리 키를 주지 않으면 본 키 — 그날 본 계열 값이 없으므로 '—'(짓지 않음)
    expect(scrubModel(rows, "v", 5, usd, { estimate: { date: "2026-10-30" } })).toMatchObject({ valueText: "—", change: null });
  });

  it("장부 값 꼬리 점(현금뿐 계좌 — isEstimated false)은 추정 아님 + 설명 '장부'", () => {
    const rows: LineRow[] = [{ date: "2026-10-29", v: 100_000, tail: 100_000 }, { date: "2026-10-30", v: null, tail: 100_000 }];
    expect(scrubModel(rows, "v", 1, usd, { estimate: { date: "2026-10-30", note: "장부", valueKey: "tail", isEstimated: false } })).toMatchObject({
      valueText: "100,000.00",
      change: 0,
      isEstimated: false,
      estimateNote: "장부",
    });
  });
});
