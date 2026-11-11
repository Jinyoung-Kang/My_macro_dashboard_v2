/**
 * 수급 레이더 순수 로직 — 순위 카드의 기준 한 줄은 응답이 밝힌 실제 기간과 기준일을 적는다(QA-396·397).
 */
import { describe, expect, it } from "vitest";
import { radarBasis, radarIntervalLabel } from "../radar";

describe("레이더 기준 한 줄", () => {
  it("기간 이름표 — 모르는 값은 그대로", () => {
    expect(radarIntervalLabel("TODAY")).toBe("당일");
    expect(radarIntervalLabel("DAYS_5")).toBe("5거래일");
    expect(radarIntervalLabel("DAYS_20")).toBe("20거래일");
    expect(radarIntervalLabel("DAYS_60")).toBe("DAYS_60");
  });

  it("응답의 기간과, 있으면 기준일을 적는다 — 없는 날짜는 만들지 않는다", () => {
    expect(radarBasis({ intervalType: "TODAY", dataDate: "2026-11-10" })).toBe("기간 당일 · 기준일 2026-11-10");
    expect(radarBasis({ intervalType: "DAYS_5", dataDate: null })).toBe("기간 5거래일");
    expect(radarBasis({ intervalType: "DAYS_20" })).toBe("기간 20거래일");
  });
});
