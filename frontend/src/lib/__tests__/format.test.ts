/**
 * 숫자 서식 — PRINCIPLES "없는 숫자를 만들지 않는다"가 실제로 글자가 되는 곳.
 *
 * 그동안 시각(formatKst)만 검사하고 숫자 서식은 테스트가 없었습니다. 경계에서 틀린 네 가지를
 * 고정합니다: Infinity가 "∞"로, 9,999.95억이 "10,000.0억"으로, 0.4원이 "+0 원"으로,
 * NaN 경과 시간이 "NaN일 전"으로 찍히던 것.
 */
import { describe, expect, it } from "vitest";
import {
  deltaColor, withoutLeadingIcon, formatAge, formatBillionUsd, formatKrw, formatNumber, formatPercent, formatSampleWindow, formatShares,
  formatSigned, formatSignedKrw, formatTrillionDelta, formatTrillionUsd, formatUsd, formatUsdWithKrw,
  formatLatency,
  formatSignedMinus,
  formatWithUnit,
  MINUS,
} from "@/lib/format";

describe("값이 없으면 —", () => {
  it("null·undefined·NaN·Infinity 모두 —", () => {
    for (const value of [null, undefined, NaN, Infinity, -Infinity]) {
      expect(formatNumber(value)).toBe("—");
      expect(formatSigned(value)).toBe("—");
      expect(formatPercent(value)).toBe("—");
      expect(formatUsd(value)).toBe("—");
      expect(formatShares(value)).toBe("—");
      expect(formatAge(value)).toBe("—");
      expect(deltaColor(value)).toBe("text-muted");
    }
  });
});

describe("부호와 색은 보이는 숫자 기준", () => {
  it("-0.004는 2자리에서 0.00이고 중립색", () => {
    expect(formatNumber(-0.004)).toBe("0.00");
    expect(formatSigned(-0.004)).toBe("0.00");
    expect(deltaColor(-0.004)).toBe("text-body");
    expect(deltaColor(-0.004, 3)).toBe("text-down");
    expect(formatSigned(0.006)).toBe("+0.01");
  });

  it("원화·주식 수의 +는 0으로 찍힐 때 붙지 않는다", () => {
    expect(formatSignedKrw(0.4)).toBe("0 원");
    expect(formatSignedKrw(1234e8)).toBe("+1,234억 원");
    expect(formatShares(0.4)).toBe("0 주");
    expect(formatShares(292_000)).toBe("+29.2만 주");
    expect(formatShares(-1250)).toBe("-1,250 주");
  });
});

describe("조·억·만 단위", () => {
  it("단위와 자릿수", () => {
    expect(formatUsd(4.47e10)).toBe("447.0억 달러");
    expect(formatUsd(1.2e11)).toBe("1,200억 달러");
    expect(formatKrw(8_607_639e7)).toBe("86.076조 원");     // 100조 미만: 소수 3자리
    expect(formatKrw(8_607_639e8)).toBe("860.8조 원");      // 100조 이상: 1자리
    expect(formatKrw(8_607_639e9)).toBe("8,608조 원");      // 1,000조 이상: 정수
    expect(formatUsd(123_456)).toBe("12만 달러");
    expect(formatUsd(999)).toBe("999 달러");
  });

  it("반올림이 다음 단위에 닿으면 단위를 올린다", () => {
    expect(formatUsd(9.9995e11)).toBe("1.000조 달러");    // 예전: "10,000.0억 달러"
    expect(formatUsd(99_995_000)).toBe("1.0억 달러");       // 예전: "10,000만 달러"
    expect(formatUsd(9_999.6)).toBe("1만 달러");
  });

  it("조·십억 단위로 들어온 값", () => {
    expect(formatTrillionUsd(0.012)).toBe("120.0억 달러");
    expect(formatBillionUsd(877)).toBe("8,770억 달러");
    expect(formatTrillionDelta(-0.0005)).toBe("-5.0억 달러");
    expect(formatTrillionDelta(0)).toBe("0 달러");
  });

  it("환율을 모르면 달러만", () => {
    expect(formatUsdWithKrw(4.47e10, 1382)).toBe("447.0억 달러 (약 61.775조 원)");
    expect(formatUsdWithKrw(4.47e10, null)).toBe("447.0억 달러");
    expect(formatUsdWithKrw(4.47e10, 0)).toBe("447.0억 달러");
  });
});

describe("경과 시간", () => {
  it("초·분·시간·일, 음수는 0으로", () => {
    expect(formatAge(42)).toBe("42초 전");
    expect(formatAge(180)).toBe("3분 전");
    expect(formatAge(7200)).toBe("2시간 전");
    expect(formatAge(172_800)).toBe("2일 전");
    expect(formatAge(-5)).toBe("0초 전");
  });
});

describe("백분위 표본", () => {
  it("시작일·개수·기간을 함께 적는다 — IG(3년)와 10년 지표를 구분해 읽게", () => {
    expect(formatSampleWindow("2023-10-09", 784, 3.0)).toBe("2023-10-09 이후 784개 · 약 3.0년");
    expect(formatSampleWindow("2016-10-07T00:00:00", 2560, 9.96)).toBe("2016-10-07 이후 2,560개 · 약 10.0년");
  });

  it("하나라도 모르면 null — 표본을 지어내지 않는다", () => {
    expect(formatSampleWindow(null, 784, 3.0)).toBeNull();
    expect(formatSampleWindow("2023-10-09", undefined, 3.0)).toBeNull();
    expect(formatSampleWindow("2023-10-09", 784, Number.NaN)).toBeNull();
  });
});

describe("제목 앞 아이콘 떼기", () => {
  it("이모지·국기·이형 선택자를 떼고 글자는 그대로", () => {
    expect(withoutLeadingIcon("💵 통화 및 환율")).toBe("통화 및 환율");
    expect(withoutLeadingIcon("🏛️ 미국 국채 수익률")).toBe("미국 국채 수익률");
    expect(withoutLeadingIcon("🇰🇷 국내 지수")).toBe("국내 지수");
    expect(withoutLeadingIcon("10Y-2Y 스프레드")).toBe("10Y-2Y 스프레드");
  });
});

describe("AI 소요 시간 (화면에서 옮김, 동작 동일)", () => {
  it("1분 미만은 소수 한 자리 초, 1분 이상은 분·초, 모르면 미상", () => {
    expect(formatLatency(4200)).toBe("4.2초");
    expect(formatLatency(222_134)).toBe("3분 42초");
    expect(formatLatency(undefined)).toBe("소요 시간 미상");
  });
});

describe("QA-048 AI 소요 시간의 경계", () => {
  // 수정 전에는 분·초를 따로 반올림해 119.6초가 "1분 60초", 59.96초가 "60.0초"였다.
  it("반올림이 다음 단위로 넘어가면 올린다 — '1분 60초'·'60.0초'가 되지 않는다", () => {
    expect(formatLatency(119_600)).toBe("2분 0초");
    expect(formatLatency(59_960)).toBe("1분 0초");
    expect(formatLatency(60_400)).toBe("1분 0초");
  });
});

describe("QA-049 숫자 + 단위", () => {
  it("모르는 값(null·NaN·Infinity)은 단위 없이 —", () => {
    expect(formatWithUnit(null, 2, "%")).toBe("—");
    expect(formatWithUnit(undefined, 1, "억 원")).toBe("—");
    expect(formatWithUnit(Number.NaN, 0, "일 전 공시")).toBe("—");
    expect(formatWithUnit(Number.POSITIVE_INFINITY, 2, "%p")).toBe("—");
  });

  it("값이 있으면 숫자 서식 그대로 단위를 붙인다", () => {
    expect(formatWithUnit(12.345, 2, "%")).toBe(`${formatNumber(12.345, 2)}%`);
    expect(formatWithUnit(0, 0, "일")).toBe("0일");
  });
});

describe("부호 −(U+2212) — 변화 칩(formatSignedMinus)", () => {
  it("양수 +, 음수 −(U+2212), 하이픈을 쓰지 않는다", () => {
    expect(formatSignedMinus(1.234)).toEqual({ text: "+1.23", sign: 1 });
    expect(formatSignedMinus(-1.234)).toEqual({ text: `${MINUS}1.23`, sign: -1 });
    expect(formatSignedMinus(-1.234).text).not.toContain("-");
    expect(MINUS).toBe("\u2212");
  });

  it("반올림 뒤 0이면 부호 없음(+0.00·−0.00 없음) — formatSigned와 같은 규칙", () => {
    expect(formatSignedMinus(-0.004)).toEqual({ text: "0.00", sign: 0 });
    expect(formatSignedMinus(0.004)).toEqual({ text: "0.00", sign: 0 });
    expect(formatSignedMinus(0)).toEqual({ text: "0.00", sign: 0 });
    expect(formatSignedMinus(-0.004, 3)).toEqual({ text: `${MINUS}0.004`, sign: -1 });
    expect(formatSigned(-0.004)).toBe(formatSignedMinus(-0.004).text);
  });

  it("천 단위 구분과 자릿수", () => {
    expect(formatSignedMinus(-12345.678, 1).text).toBe(`${MINUS}12,345.7`);
    expect(formatSignedMinus(1500, 0).text).toBe("+1,500");
  });
});
