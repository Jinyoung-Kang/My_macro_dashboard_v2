/**
 * 순유동성·섹터·COT 화면의 글·KPI 규칙(lib/liquidity·lib/sectorScreen·lib/cotScreen) — React 없이 시험합니다(ADR 0004 규칙 3).
 */
import { describe, expect, it } from "vitest";
import { formatSignedCount } from "@/lib/cotScreen";

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
