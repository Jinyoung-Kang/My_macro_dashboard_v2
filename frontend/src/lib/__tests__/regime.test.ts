import { describe, expect, it } from "vitest";
import { regimeBandLabel, regimeInputCells, regimeLogSummary, regimeTone, trackRecordRow } from "../regime";

describe("국면 판정 기록의 근거 표기", () => {
  it("단위를 다른 화면과 같게 적고, 기준일은 월-일로 줄인다 — 음수는 −(U+2212, QA-636)", () => {
    const cells = regimeInputCells({
      curve10y3m: { value: 0.42, asOf: "2026-10-08" },
      nfci: { value: -0.48, asOf: "2026-10-02" },
      hyOas: { value: 2.85, asOf: "2026-10-08" },
      liquidity4w: { value: -0.0254, asOf: "2026-10-08" },
    });
    expect(cells.map((c) => [c.label, c.value, c.asOf])).toEqual([
      ["10Y-3M", "+0.42%p", "10-08"],
      ["NFCI", "−0.48", "10-02"],
      ["하이일드", "2.85%p", "10-08"],
      ["순유동성 4주", "−254.0억 달러", "10-08"],
    ]);
  });

  it("값을 모르면 0이 아니라 —", () => {
    const cells = regimeInputCells({ nfci: { value: null, asOf: null } });
    expect(cells.every((c) => c.value === "—")).toBe(true);
    expect(cells[1].asOf).toBe("—");
    expect(cells[1].asOfDate).toBeNull();
  });

  it("타임라인 한 줄 요약 — 근거 넷을 잇고, 판정하지 못한 날은 받지 못한 입력 수를 덧붙인다", () => {
    const inputs = {
      curve10y3m: { value: 0.42, asOf: "2026-10-08" },
      nfci: { value: -0.48, asOf: "2026-10-02" },
      hyOas: { value: null, asOf: null },
      liquidity4w: { value: -0.0254, asOf: "2026-10-08" },
    };
    expect(regimeLogSummary({ inputs, missing: [] })).toBe("10Y-3M +0.42%p · NFCI −0.48 · 하이일드 — · 순유동성 4주 −254.0억 달러");
    expect(regimeLogSummary({ inputs, missing: ["하이일드 스프레드"] })).toBe(
      "10Y-3M +0.42%p · NFCI −0.48 · 하이일드 — · 순유동성 4주 −254.0억 달러 · 받지 못한 입력 1",
    );
    expect(regimeInputCells(inputs)[0].asOfDate).toBe("2026-10-08");
  });
});

describe("판정 성과 표의 한 줄", () => {
  const base = { horizonWeeks: 13, count: 140, independent: 11, sufficient: true, mean: 2.9, median: 3.1,
    winRate: 68, best: 12, worst: -9 };

  it("표본이 충분하면 수익률·상승 비율·초과분, 비교 기준을 함께", () => {
    const row = trackRecordRow({ ...base, count: 42, independent: 4, mean: 1.2, median: 1.0, winRate: 61.9,
      excessMean: -1.7 }, base);
    expect(row).toEqual({
      horizon: "13주 뒤", samples: "42건 · 독립 4", sufficient: true, mean: "+1.20%", median: "+1.00%",
      winRate: "62%", excess: "−1.70%p", baseline: "+2.90% · 68% 상승",
    });
  });

  it("표본이 부족하면 숫자 대신 '표본 부족' — 표본 수는 그대로 적는다", () => {
    const row = trackRecordRow({ ...base, count: 4, independent: 2, sufficient: false, mean: null, median: null,
      winRate: null }, base);
    expect(row.mean).toBe("표본 부족");
    expect(row.samples).toBe("4건 · 독립 2");
    expect(row.median).toBe("—");
  });
});

describe("국면 이력 띠의 이름", () => {
  it("기간·주간 판정 수·구간 수만 — 자세한 구간은 표에 맡긴다, 점이 없으면 띠가 없다", () => {
    const timeline = [
      { date: "2021-11-18", code: "UNKNOWN", label: "판정 불가" },
      { date: "2021-11-25", code: "EXPANSION", label: "확장 (Expansion)" },
    ];
    expect(regimeBandLabel(timeline, 2)).toBe("국면 이력 띠 — 2021-11-18 ~ 2021-11-25, 주간 판정 2번·구간 2개(최근 구간은 아래 표)");
    expect(regimeBandLabel([], 0)).toBeNull();
    expect(regimeBandLabel(undefined, 0)).toBeNull();
  });
});

describe("국면 범주의 톤·아이콘", () => {
  it("네 국면과 판정 불가가 모두 아이콘을 갖는다 — 회복·판정 불가는 중립, 모르는 코드는 판정 불가와 같다", () => {
    expect(["EXPANSION", "LATE", "CONTRACTION", "RECOVERY", "UNKNOWN"].map((code) => regimeTone(code))).toEqual([
      { tone: "ok", icon: "check" },
      { tone: "warn", icon: "alert" },
      { tone: "danger", icon: "alert" },
      { tone: "neutral", icon: "info" },
      { tone: "neutral", icon: "unknown" },
    ]);
    expect(regimeTone("SOMETHING_NEW")).toEqual({ tone: "neutral", icon: "unknown" });
    expect(regimeTone(null)).toEqual({ tone: "neutral", icon: "unknown" });
  });
});
