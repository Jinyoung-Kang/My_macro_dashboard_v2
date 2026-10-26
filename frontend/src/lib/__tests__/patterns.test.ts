/**
 * 화면 패턴의 표시 규칙(lib/patterns.ts).
 *  - 값 없음: null·NaN·Infinity·빈 글·"—"·"N/A"는 없음, 0과 React 요소는 있음
 *  - 덧붙이는 글(사유·설명·판정·보조): 비었거나 "N/A"면 null, 앞뒤 공백을 뗌
 *  - 변화 칩: 둘 다 모르면 null(0.00%를 만들지 않음), 부호·방향은 반올림 뒤 보이는 숫자 기준, 음수는 −(U+2212 — lib/format.ts formatSignedMinus)
 *  - 출처 글: 모르는 부분은 빼고, 전부 모르면 "출처 —"
 *  - 추정 배지 라벨: "추정" / "대리 지표" / 둘 다, 둘 다 아니면 null
 *  - 타일 값: 모르면 null(단위를 붙이지 않게), format이 "—"를 돌려줘도 없음
 */
import { describe, expect, it } from "vitest";

import { MINUS } from "../format";
import {
  changeChipModel,
  estimateLabel,
  isMissingValue,
  presentText,
  provenanceText,
  skeletonLineCount,
  statValueText,
} from "../patterns";

describe("isMissingValue", () => {
  it("null·undefined·false·NaN·±Infinity는 값 없음", () => {
    for (const value of [null, undefined, false, NaN, Infinity, -Infinity]) {
      expect(isMissingValue(value)).toBe(true);
    }
  });

  it("빈 글·공백·'—'·'-'·수집기의 'N/A'(대소문자 무관)는 값 없음", () => {
    for (const value of ["", "  ", "—", "-", "N/A", "n/a", " N/A "]) {
      expect(isMissingValue(value)).toBe(true);
    }
  });

  it("0·음수·글·객체는 값 있음 — 0은 '모름'이 아니다", () => {
    for (const value of [0, -1.5, "0", "12.3", "판정 불가", { type: "span" }]) {
      expect(isMissingValue(value)).toBe(false);
    }
  });
});

describe("presentText", () => {
  it("글은 앞뒤 공백만 떼고 그대로", () => {
    expect(presentText(" 이번 수집 실패 ")).toBe("이번 수집 실패");
    expect(presentText("0")).toBe("0");
  });

  it("null·undefined·빈 글·공백·'—'·'-'·'N/A'는 null — 사유처럼 찍지 않는다", () => {
    for (const text of [null, undefined, "", "   ", "—", "-", "N/A", " n/a "]) {
      expect(presentText(text)).toBeNull();
    }
  });
});

describe("changeChipModel", () => {
  it("둘 다 모르면 null — 칩을 생략한다", () => {
    expect(changeChipModel(null, null)).toBeNull();
    expect(changeChipModel(undefined, undefined)).toBeNull();
    expect(changeChipModel(NaN, Infinity)).toBeNull();
  });

  it("상승·하락 방향과 글", () => {
    expect(changeChipModel(1.5, 0.42)).toEqual({ direction: "up", change: "+1.50", changePct: "+0.42%" });
    expect(changeChipModel(-1.5, -0.42)).toEqual({ direction: "down", change: `${MINUS}1.50`, changePct: `${MINUS}0.42%` });
  });

  it("한쪽만 알면 그쪽만", () => {
    expect(changeChipModel(null, -2.345)).toEqual({ direction: "down", change: null, changePct: `${MINUS}2.35%` });
    expect(changeChipModel(3, undefined)).toEqual({ direction: "up", change: "+3.00", changePct: null });
  });

  it("보이는 값이 0이면 flat — 화살표·색이 없다", () => {
    expect(changeChipModel(-0.004, -0.001)).toEqual({ direction: "flat", change: "0.00", changePct: "0.00%" });
    expect(changeChipModel(null, 0)).toEqual({ direction: "flat", change: null, changePct: "0.00%" });
  });

  it("한쪽만 0으로 찍히면 다른 쪽의 방향을 따른다", () => {
    expect(changeChipModel(0.01, 0.0004)?.direction).toBe("up");
  });

  it("두 부호가 어긋나면(자료 오류) 방향을 단정하지 않는다", () => {
    expect(changeChipModel(1, -1)?.direction).toBe("flat");
  });

  it("digits는 둘에 함께 쓰인다", () => {
    expect(changeChipModel(12.3456, 1.23456, 1)).toEqual({ direction: "up", change: "+12.3", changePct: "+1.2%" });
    expect(changeChipModel(-0.04, null, 1)).toEqual({ direction: "flat", change: "0.0", changePct: null });
  });

  it("pctDigits를 주면 변화율만 그 자릿수 — 금리 −0.007 (−0.14%)", () => {
    expect(changeChipModel(-0.007, -0.1402, 3, 2)).toEqual({ direction: "down", change: `${MINUS}0.007`, changePct: `${MINUS}0.14%` });
    // 셋째 자리로 찍으면 0.004는 방향이 있는 값입니다(둘째 자리면 0.00 — flat).
    expect(changeChipModel(0.004, 0.09, 3, 2)?.direction).toBe("up");
    expect(changeChipModel(0.004, 0.09)).toEqual({ direction: "up", change: "0.00", changePct: "+0.09%" });
  });
});

describe("provenanceText", () => {
  it("출처 · 지연 · 시각", () => {
    expect(provenanceText({ source: "FRED", delayMin: 15, asOf: "2026-10-26 14:20" })).toBe("FRED · 15분 지연 · 2026-10-26 14:20");
  });

  it("live면 '실시간', 지연 0분도 '실시간'", () => {
    expect(provenanceText({ source: "TradingView", live: true, delayMin: 15 })).toBe("TradingView · 실시간");
    expect(provenanceText({ source: "TradingView", delayMin: 0 })).toBe("TradingView · 실시간");
  });

  it("시각은 formatKst로 한 형식에 — ISO(UTC)는 KST로", () => {
    expect(provenanceText({ asOf: "2026-10-26T05:20:00Z" })).toBe("2026-10-26 14:20");
    expect(provenanceText({ asOf: "2026-10-26 14:20:59 KST" })).toBe("2026-10-26 14:20");
  });

  it("모르는 부분은 뺀다", () => {
    expect(provenanceText({ source: "KRX", delayMin: null, asOf: null })).toBe("KRX");
    expect(provenanceText({ source: null, delayMin: 10 })).toBe("10분 지연");
    expect(provenanceText({ source: "  ", asOf: "2026-10-26 09:00" })).toBe("2026-10-26 09:00");
  });

  it("전부 모르면 '출처 —'", () => {
    expect(provenanceText({})).toBe("출처 —");
    expect(provenanceText({ source: "N/A", asOf: "", delayMin: NaN })).toBe("출처 —");
  });
});

describe("estimateLabel", () => {
  it("추정·대리 지표·둘 다", () => {
    expect(estimateLabel(true, false)).toBe("추정");
    expect(estimateLabel(false, true)).toBe("대리 지표");
    expect(estimateLabel(true, true)).toBe("추정 · 대리 지표");
  });

  it("둘 다 아니면 null — 배지를 그리지 않는다", () => {
    expect(estimateLabel()).toBeNull();
    expect(estimateLabel(false, false)).toBeNull();
  });
});

describe("statValueText", () => {
  it("숫자는 기본 소수 둘째 자리, format이 있으면 그것으로", () => {
    expect(statValueText(1.2345)).toBe("1.23");
    expect(statValueText(0)).toBe("0.00");
    expect(statValueText(784, (v) => v.toLocaleString("ko-KR"))).toBe("784");
  });

  it("글은 받은 그대로(앞뒤 공백만 뗌)", () => {
    expect(statValueText(" 3.0년 ")).toBe("3.0년");
  });

  it("모르면 null — null·NaN·'N/A'·빈 글", () => {
    for (const value of [null, undefined, NaN, Infinity, "N/A", "", "—"]) {
      expect(statValueText(value)).toBeNull();
    }
  });

  it("format이 '—'를 돌려줘도 값 없음", () => {
    expect(statValueText(5, () => "—")).toBeNull();
  });
});

describe("skeletonLineCount", () => {
  it("기본 3줄, 높이만 있으면 0줄", () => {
    expect(skeletonLineCount(undefined, undefined)).toBe(3);
    expect(skeletonLineCount(undefined, 200)).toBe(0);
    expect(skeletonLineCount(undefined, 0)).toBe(3);
  });

  it("줄 수를 주면 그대로 — 음수·소수·NaN은 0 이상의 정수", () => {
    expect(skeletonLineCount(5, 200)).toBe(5);
    expect(skeletonLineCount(2.7, undefined)).toBe(2);
    expect(skeletonLineCount(-1, undefined)).toBe(0);
    expect(skeletonLineCount(NaN, undefined)).toBe(0);
  });
});
