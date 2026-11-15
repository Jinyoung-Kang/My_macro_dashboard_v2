/**
 * 13F 보유 비중 표기(QA-454) — 0보다 크지만 보이는 자릿수에서 0이 되는 값은 '<0.01%', 정확히 0은 '0.00%', 모르는 값은 "—".
 */
import { describe, expect, it } from "vitest";
import { formatWeightPercent } from "@/lib/format";

describe("formatWeightPercent", () => {
  it("0보다 크고 0.005 미만이면 '<0.01%' — 반올림하면 0이 되는 값", () => {
    expect(formatWeightPercent(0.0032)).toBe("<0.01%");
    expect(formatWeightPercent(0.0049)).toBe("<0.01%");
    expect(formatWeightPercent(Number.MIN_VALUE)).toBe("<0.01%");
  });

  it("보이는 자릿수에 0이 아닌 숫자가 있으면 그대로", () => {
    expect(formatWeightPercent(0.006)).toBe("0.01%");
    expect(formatWeightPercent(0.01)).toBe("0.01%");
    expect(formatWeightPercent(1.25)).toBe("1.25%");
    expect(formatWeightPercent(21.5)).toBe("21.50%");
    expect(formatWeightPercent(99.9968)).toBe("100.00%");
    expect(formatWeightPercent(1234.5)).toBe("1,234.50%");
  });

  it("정확히 0은 '0.00%', 모르는 값은 '—'(0으로 채우지 않음)", () => {
    expect(formatWeightPercent(0)).toBe("0.00%");
    for (const value of [null, undefined, NaN, Infinity, -Infinity]) expect(formatWeightPercent(value)).toBe("—");
  });

  it("자릿수를 바꾸면 경계도 그 자릿수의 최소 단위", () => {
    expect(formatWeightPercent(0.04, 1)).toBe("<0.1%");
    expect(formatWeightPercent(0.06, 1)).toBe("0.1%");
    expect(formatWeightPercent(0.0004, 3)).toBe("<0.001%");
  });

  it("음수는 '<' 표기를 쓰지 않는다(13F 비중은 음수가 아님 — 보이는 숫자 그대로)", () => {
    expect(formatWeightPercent(-0.003)).toBe("0.00%");
    expect(formatWeightPercent(-1.5)).toBe("-1.50%");
  });
});
