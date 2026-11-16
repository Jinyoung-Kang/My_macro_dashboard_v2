/**
 * 순유동성·섹터·COT 화면의 글·KPI 규칙(lib/liquidity·lib/sectorScreen·lib/cotScreen) — React 없이 시험합니다(ADR 0004 규칙 3).
 */
import { describe, expect, it } from "vitest";
import { cotKpis, formatSignedCount } from "@/lib/cotScreen";
import { formatSignedMinus, formatTrillionDelta, withMinusSign } from "@/lib/format";
import { liquidityKpis, trillionDeltaChip, type UsdKrwConvert } from "@/lib/liquidity";
import { sectorKpis, sectorRowTitle, signedPercentText } from "@/lib/sectorScreen";
import type { CotSummary, SectorRow } from "@/lib/types";

describe("cotScreen formatSignedCount", () => {
  it("양수는 '+', 음수는 −(U+2212), 0은 부호 없이, 모르면 '—'", () => {
    expect(formatSignedCount(108749)).toBe("+108,749");
    expect(formatSignedCount(-134368)).toBe("−134,368");
    expect(formatSignedCount(0)).toBe("0");
    expect(formatSignedCount(-0.4)).toBe("0");
    expect(formatSignedCount(null)).toBe("—");
    expect(formatSignedCount(undefined)).toBe("—");
    expect(formatSignedCount(Number.NaN)).toBe("—");
  });
});

describe("cotScreen cotKpis", () => {
  const summary: CotSummary = {
    asset: "S&P 500 E-Mini", available: true, date: "2026-10-27", ncNet: -134368, commNet: 17301, nrNet: 117067,
    change1w: 8303, change4w: 8131, percentile: 34.94, ageDays: 21,
  };

  it("넷 — 스마트머니(값 부호·1주 변화 칩·출처·기준일) · 상업 헤저 · 소액 · 3년 백분위(%·메모)", () => {
    const items = cotKpis(summary, "CFTC");
    expect(items.map((item) => [item.key, item.label, item.value])).toEqual([
      ["ncNet", "스마트머니 순포지션", "−134,368"],
      ["commNet", "상업 헤저 순포지션", "+17,301"],
      ["nrNet", "소액/비보고", "+117,067"],
      ["percentile", "3년 표본 백분위", 34.94],
    ]);
    expect(items[0]).toMatchObject({ change: { change: 8303, digits: 0, caption: "1주" }, source: "CFTC", asOf: "2026-10-27" });
    expect(items.slice(1).every((item) => item.source === undefined)).toBe(true);
    expect(items[3].format?.(34.94)).toBe("34.9%");
    expect(items[3].note).toBe("100%에 가까울수록 역사적 최대 롱");
  });

  it("모르는 값은 '—'·null(0으로 채우지 않음), 1주 변화를 모르면 칩 없음, 요약이 없으면 빈 목록", () => {
    const items = cotKpis({ ...summary, ncNet: null, change1w: null, percentile: null, date: undefined }, "CFTC");
    expect(items[0]).toMatchObject({ value: "—", change: undefined, asOf: null });
    expect(items[3].value).toBeNull();
    expect(cotKpis(null, "CFTC")).toEqual([]);
  });
});

describe("liquidity trillionDeltaChip", () => {
  /** 칩이 그리는 글(부호 붙은 변화량 + 단위) — 공용 변화 칩과 같은 서식(lib/format formatSignedMinus). */
  const chipText = (deltaT: number) => {
    const chip = trillionDeltaChip(deltaT);
    return chip ? `${formatSignedMinus(chip.change, chip.digits).text}${chip.unit}` : null;
  };

  it("단위·자릿수가 예전 변화 글(formatTrillionDelta)과 같다 — 억·조·만, 반올림이 1조에 닿으면 조로 올림", () => {
    for (const deltaT of [0.0047, -0.0047, 0.048, -0.094, 0.1234, 0.5, 1.5, -2.25, 0.99996, -0.99994, 0.000003, 150, 1200]) {
      // 칩은 변화량과 단위를 따로 그리므로(단위는 작은 글) 띄어쓰기만 빼고 견줍니다.
      expect(chipText(deltaT)?.replace(/\s/g, "")).toBe(withMinusSign(formatTrillionDelta(deltaT)).replace(/\s/g, ""));
    }
  });

  it("조 경계: 9,999.95억은 1.000조로 올리고, 9,999.4억은 억 그대로", () => {
    expect(trillionDeltaChip(0.999995)).toMatchObject({ unit: "조 달러", digits: 3 });
    expect(chipText(0.999995)).toBe("+1.000조 달러");
    expect(trillionDeltaChip(0.99994)).toMatchObject({ unit: "억 달러", digits: 0 });
    expect(chipText(0.99994)).toBe("+9,999억 달러");
  });

  it("모르는 값은 null(칩 없음), 0은 부호 없는 0", () => {
    expect(trillionDeltaChip(null)).toBeNull();
    expect(trillionDeltaChip(undefined)).toBeNull();
    expect(trillionDeltaChip(Number.NaN)).toBeNull();
    expect(chipText(0)).toBe("0달러");
  });
});

describe("liquidity liquidityKpis", () => {
  const usdKrw: UsdKrwConvert = {
    trillionToKrw: (value) => (value === null || value === undefined ? null : `약 ${(value * 1339).toFixed(1)}조 원`),
    billionToKrw: (value) => (value === null || value === undefined ? null : `약 ${(value * 1.339).toFixed(1)}조 원`),
    note: "원/달러 1,339.00 기준",
  };
  const response = {
    isEstimated: false,
    latest: { date: "2026-11-03", netLiquidityT: 5.745, previousT: 5.74, deltaT: 0.0047, pct: 0.08, walclT: 6.745, tgaB: 999.7, rrpB: 0.427 },
    momentum: { change4w: -0.048, change12w: -0.094 },
  };

  it("여섯 타일 — 순유동성만 변화 칩·출처·기준일, 4주·12주는 값이 부호 −", () => {
    const items = liquidityKpis(response, usdKrw, "FRED");
    expect(items.map((item) => item.key)).toEqual(["net", "walcl", "tga", "rrp", "change4w", "change12w"]);
    expect(items[0]).toMatchObject({
      value: "5.745조 달러", source: "FRED", asOf: "2026-11-03",
      change: { digits: 1, unit: "억 달러", caption: "전주 대비" }, note: "약 7692.6조 원 · 원/달러 1,339.00 기준",
    });
    expect(items[0].change?.change).toBeCloseTo(47);
    expect(items.slice(1).every((item) => item.change === undefined && item.source === undefined)).toBe(true);
    expect(items[4]).toMatchObject({ value: "−480.0억 달러", note: "약 −64.3조 원 · 유동성은 방향과 속도가 함께 중요합니다." });
    expect(items[5]).toMatchObject({ value: "−940.0억 달러", note: "약 −125.9조 원" });
    expect(items[2].note).toBe("약 1338.6조 원 · TGA 증가 = 시장에서 자금 흡수");
  });

  it("추정치 모드면 모든 타일이 추정, 환율을 모르면 원화 메모를 뺌, 묶음이 없으면 그 타일들도 없음", () => {
    expect(liquidityKpis({ ...response, isEstimated: true }, usdKrw, "FRED").every((item) => item.isEstimated)).toBe(true);
    const noRate: UsdKrwConvert = { trillionToKrw: () => null, billionToKrw: () => null, note: "원/달러 값이 없어 원화 환산은 생략했습니다." };
    const items = liquidityKpis(response, noRate, "FRED");
    expect(items[0].note).toBe("원/달러 값이 없어 원화 환산은 생략했습니다.");
    expect(items[1].note).toBeNull();
    expect(liquidityKpis({ ...response, momentum: undefined }, usdKrw, "FRED")).toHaveLength(4);
    expect(liquidityKpis({ ...response, latest: undefined }, usdKrw, "FRED").map((item) => item.key)).toEqual(["change4w", "change12w"]);
    expect(liquidityKpis(null, usdKrw, "FRED")).toEqual([]);
  });

  it("모르는 값은 '—'(0으로 채우지 않음)", () => {
    const items = liquidityKpis({ latest: { ...response.latest, netLiquidityT: null, deltaT: null, tgaB: null } }, usdKrw, "FRED");
    expect(items[0].value).toBe("—");
    expect(items[0].change).toBeUndefined();
    expect(items[2].value).toBe("—");
  });
});

describe("sectorScreen sectorKpis", () => {
  it("응답 기간 차례대로 벤치마크 수익률 — 값은 부호 −·'%', 모르는 기간은 null, 출처는 첫 타일만", () => {
    const items = sectorKpis(
      { benchmark: "SPY", periods: ["1W", "1M", "YTD"], benchmarkReturns: { "1W": -1.9891, "1M": 0, YTD: 11.4855 } },
      "Yahoo",
    );
    expect(items.map((item) => [item.key, item.label, item.value])).toEqual([
      ["1W", "S&P 500 (SPY) 1W", -1.9891],
      ["1M", "S&P 500 (SPY) 1M", 0],
      ["YTD", "S&P 500 (SPY) YTD", 11.4855],
    ]);
    expect(items.map((item) => (item.value === null ? null : item.format(item.value)))).toEqual(["−1.99%", "0.00%", "+11.49%"]);
    expect(items.map((item) => item.source ?? null)).toEqual(["Yahoo", null, null]);
  });

  it("기간 목록이 없으면 기본 여섯, 값이 없으면 null(0으로 채우지 않음), 벤치마크 이름이 없으면 SPY", () => {
    const items = sectorKpis({ benchmark: "", periods: [], benchmarkReturns: { "1W": null } }, "Yahoo");
    expect(items.map((item) => item.key)).toEqual(["1W", "1M", "3M", "6M", "YTD", "1Y"]);
    expect(items.every((item) => item.value === null)).toBe(true);
    expect(items[0].label).toBe("S&P 500 (SPY) 1W");
    expect(sectorKpis(null, "Yahoo")).toEqual([]);
    expect(signedPercentText(-0.004)).toBe("0.00%");
  });

  it("검사 칸 제목은 '이름 (티커)', 표에 없는 티커는 null", () => {
    const rows = [{ ticker: "XLK", name: "정보기술" }] as SectorRow[];
    expect(sectorRowTitle(rows, "XLK")).toBe("정보기술 (XLK)");
    expect(sectorRowTitle(rows, "XLE")).toBeNull();
  });
});
