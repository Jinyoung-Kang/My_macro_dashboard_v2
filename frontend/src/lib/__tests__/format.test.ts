/**
 * 숫자 서식 — PRINCIPLES "없는 숫자를 만들지 않는다"가 실제로 글자가 되는 곳.
 *
 * 그동안 시각(formatKst)만 검사하고 숫자 서식은 테스트가 없었습니다. 경계에서 틀린 네 가지를
 * 고정합니다: Infinity가 "∞"로, 9,999.95억이 "10,000.0억"으로, 0.4원이 "+0 원"으로,
 * NaN 경과 시간이 "NaN일 전"으로 찍히던 것.
 */
import { describe, expect, it } from "vitest";
import {
  deltaColor, deltaDirection, textDeltaDirection, withMinusSign, withoutLeadingIcon, formatAge, formatBillionUsd, formatKrw, formatNumber, formatPercent, formatSampleWindow, formatShares,
  formatSigned, formatSignedKrw, formatTrillionDelta, formatTrillionUsd, formatUsd, formatUsdWithKrw,
  formatChartNumber,
  formatKstSeconds,
  formatLatency,
  formatSignedMinus,
  formatWithUnit,
  koreanScale,
  MINUS,
  statusColor,
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
      expect(deltaColor(value)).toBe("text-text-3");
    }
  });
});

describe("부호와 색은 보이는 숫자 기준", () => {
  it("-0.004는 2자리에서 0.00이고 중립색", () => {
    expect(formatNumber(-0.004)).toBe("0.00");
    expect(formatSigned(-0.004)).toBe("0.00");
    expect(deltaColor(-0.004)).toBe("text-text-2");
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

  it("단위 고르기(koreanScale)는 글 함수와 같은 단위·자릿수 — 반올림이 다음 단위에 닿으면 올린다", () => {
    expect(koreanScale(4.47e10)).toEqual({ scaled: 447, digits: 1, label: "억" });
    expect(koreanScale(8_607_639e9)).toEqual({ scaled: 8_607.639, digits: 0, label: "조" });
    expect(koreanScale(9.9995e11)).toEqual({ scaled: 0.99995, digits: 3, label: "조" });
    expect(koreanScale(-5e8)).toEqual({ scaled: -5, digits: 1, label: "억" });
    expect(koreanScale(999)).toEqual({ scaled: 999, digits: 0, label: "" });
    expect(koreanScale(0)).toEqual({ scaled: 0, digits: 0, label: "" });
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

describe("서버·DB 글의 그림 문자 정리 — 어디에 있든(명세 §8-2, 예전 저장본 표본)", () => {
  it("괄호 안·글 가운데·끝의 기호도 떼고, 기호 뒤 공백을 함께 지워 괄호·문장이 그대로 붙는다", () => {
    expect(withoutLeadingIcon("국면 전환 — 확장 (🧭 시장 국면)")).toBe("국면 전환 — 확장 (시장 국면)");
    expect(withoutLeadingIcon("31행 (⚠️ 추정치 — 누적 제외)")).toBe("31행 (추정치 — 누적 제외)");
    expect(withoutLeadingIcon("채권 시장의 공포 지수. ⚠️ 이 화면의 값은 추정치")).toBe("채권 시장의 공포 지수. 이 화면의 값은 추정치");
    expect(withoutLeadingIcon("역전 (Inversion) ⚠️")).toBe("역전 (Inversion)");
    expect(withoutLeadingIcon("13F 신규 편입 — 🇺🇸 버크셔 해서웨이 (Berkshire Hathaway)")).toBe("13F 신규 편입 — 버크셔 해서웨이 (Berkshire Hathaway)");
  });

  it("AI 엔진 라벨·13F 액션·KRX 성향·기관 이름(국기 쌍)", () => {
    expect(withoutLeadingIcon("⚡ 자동 탐색 — 권장 (Failover)")).toBe("자동 탐색 — 권장 (Failover)");
    expect(withoutLeadingIcon("🟣 Anthropic — Claude Haiku 5.5")).toBe("Anthropic — Claude Haiku 5.5");
    expect(withoutLeadingIcon("🆕 신규 매수 (New)")).toBe("신규 매수 (New)");
    expect(withoutLeadingIcon("📉 비중 축소 (Reduced)")).toBe("비중 축소 (Reduced)");
    expect(withoutLeadingIcon("⚪ 비교 데이터 없음")).toBe("비교 데이터 없음");
    expect(withoutLeadingIcon("🟢 매수 우위(Long)")).toBe("매수 우위(Long)");
    expect(withoutLeadingIcon("🇳🇴 노르웨이 국부펀드 (Norges Bank / GPFG)")).toBe("노르웨이 국부펀드 (Norges Bank / GPFG)");
    expect(withoutLeadingIcon("🇺🇸")).toBe("");
  });

  it("줄바꿈은 그대로(알림 본문), 겹친 공백은 하나로, 글자 기호(↔·↕·▪·©·▲▼·✓)는 남긴다", () => {
    expect(withoutLeadingIcon("첫 줄 ⚠️\n🇺🇸 버크셔  해서웨이")).toBe("첫 줄\n버크셔 해서웨이");
    expect(withoutLeadingIcon("USD↔KRW ▲ 1.2% ✓ ▪ ↕ ©")).toBe("USD↔KRW ▲ 1.2% ✓ ▪ ↕ ©");
    expect(withoutLeadingIcon("👨‍👩‍👧 가족")).toBe("가족");
    expect(withoutLeadingIcon("")).toBe("");
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

describe("QA-941 차트 숫자(formatChartNumber) — formatNumber와 같은 글에 음수 부호만 U+2212", () => {
  it("음수는 −, 양수·0·반올림 뒤 0은 부호 없음, 모르면 —, 천 단위·자릿수는 formatNumber 그대로", () => {
    expect(formatChartNumber(-1.5, 1)).toBe(`${MINUS}1.5`);
    expect(formatChartNumber(-12345.678, 0)).toBe(`${MINUS}12,346`);
    expect(formatChartNumber(2.25)).toBe("2.25");
    expect(formatChartNumber(0)).toBe("0.00");
    expect(formatChartNumber(-0.004)).toBe("0.00");
    expect(formatChartNumber(null)).toBe("—");
    expect(formatChartNumber(Number.NaN)).toBe("—");
    // formatNumber 자체는 그대로(여러 화면·복사 글이 씀).
    expect(formatNumber(-1.5, 1)).toBe("-1.5");
  });
});

describe("QA-525 등락 방향(deltaDirection)과 글 속 음수 부호(withMinusSign) — 공용 지표 칸 Metric", () => {
  it("방향은 보이는 자릿수로 반올림한 값의 부호 — deltaColor와 같은 판정, 모르면 null", () => {
    expect(deltaDirection(1.5)).toBe("up");
    expect(deltaDirection(-1.5)).toBe("down");
    expect(deltaDirection(0.001)).toBe("flat");
    expect(deltaDirection(-0.004)).toBe("flat");
    expect(deltaDirection(-0.004, 3)).toBe("down");
    expect(deltaDirection(0)).toBe("flat");
    for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(deltaDirection(value), String(value)).toBeNull();
    }
    for (const [value, digits] of [[1.5, 2], [-1.5, 2], [-0.004, 2], [-0.004, 3], [null, 2]] as const) {
      const color = { up: "text-up", down: "text-down", flat: "text-text-2" }[deltaDirection(value, digits) ?? "flat"];
      expect(deltaColor(value, digits), `${value}/${digits}`).toBe(value === null ? "text-text-3" : color);
    }
  });

  it("줄 처음·공백·여는 괄호 뒤의 '-'가 숫자·소수점 앞일 때만 −(U+2212)로 — 날짜·코드·낱말 하이픈은 그대로", () => {
    expect(withMinusSign("-1.50%")).toBe(`${MINUS}1.50%`);
    expect(withMinusSign("1주 -1,234")).toBe(`1주 ${MINUS}1,234`);
    expect(withMinusSign("기간 -0.12%")).toBe(`기간 ${MINUS}0.12%`);
    expect(withMinusSign("-0.007%p (-0.14%)")).toBe(`${MINUS}0.007%p (${MINUS}0.14%)`);
    expect(withMinusSign("-.5")).toBe(`${MINUS}.5`);
    expect(withMinusSign("기준 2026-11-10 -3")).toBe(`기준 2026-11-10 ${MINUS}3`);
    expect(withMinusSign("BRK-B -2")).toBe(`BRK-B ${MINUS}2`);
    expect(withMinusSign("+1.50%")).toBe("+1.50%");
    expect(withMinusSign("—")).toBe("—");
    expect(withMinusSign("- 없음")).toBe("- 없음");
    expect(withMinusSign(`${MINUS}1.00`)).toBe(`${MINUS}1.00`);
  });
});

describe("QA-527 글 속 첫 부호 숫자의 방향(textDeltaDirection) — 공용 지표 칸 Metric", () => {
  it("첫 부호 숫자의 부호 — 0이 아닌 자리가 있으면 상승·하락, 모두 0이면 보합", () => {
    expect(textDeltaDirection("+0.004 (+0.09%)")).toBe("up");
    expect(textDeltaDirection("+40.0억 달러")).toBe("up");
    expect(textDeltaDirection("-30.0억 달러")).toBe("down");
    expect(textDeltaDirection(`${MINUS}1.50%`)).toBe("down");
    expect(textDeltaDirection("1주 -1,234")).toBe("down");
    expect(textDeltaDirection("기간 +0.12%")).toBe("up");
    expect(textDeltaDirection("+0.000 (+0.00%)")).toBe("flat");
    expect(textDeltaDirection("-0.00")).toBe("flat");
    expect(textDeltaDirection("(-.5)")).toBe("down");
  });

  it("날짜·코드 하이픈은 부호가 아니고, 부호 숫자가 없으면 null(값으로 판정)", () => {
    expect(textDeltaDirection("기준 2026-11-10 -3")).toBe("down");
    expect(textDeltaDirection("기준 2026-11-10")).toBeNull();
    expect(textDeltaDirection("0.00%")).toBeNull();
    expect(textDeltaDirection("최근 30분 0")).toBeNull();
    expect(textDeltaDirection("—")).toBeNull();
    expect(textDeltaDirection("- 없음")).toBeNull();
    expect(textDeltaDirection("")).toBeNull();
  });
});

describe("해석 색(statusColor) — 강조 파랑을 쓰지 않는 네 단계(명세 원칙 A1)", () => {
  it("green·blue·orange·red와 모름이 서로 다른 클래스이고, 어느 것도 강조색(accent)이 아니다", () => {
    const classes = ["green", "blue", "orange", "red", null].map((color) => statusColor(color));
    expect(classes).toEqual(["text-ok", "text-text", "text-warn", "text-danger", "text-text-2"]);
    expect(new Set(classes).size).toBe(5);
    expect(classes.some((name) => name.includes("accent"))).toBe(false);
  });
});

describe("기준 시각 — 초까지(formatKstSeconds, 명세 2026-11-06-us-costs-backfill §6)", () => {
  it("ISO(시간대 있음)·Date는 서울 시각으로 바꿔 초까지, 소수초는 뗌", () => {
    expect(formatKstSeconds("2026-11-06T05:31:05Z")).toBe("2026-11-06 14:31:05");
    expect(formatKstSeconds("2026-11-06T14:31:05.987+09:00")).toBe("2026-11-06 14:31:05");
    expect(formatKstSeconds("2026-11-06T14:31:05+09:00[Asia/Seoul]")).toBe("2026-11-06 14:31:05");
    expect(formatKstSeconds(new Date("2026-11-06T15:00:09Z"))).toBe("2026-11-07 00:00:09");
  });

  it("이미 서울 시각인 글자는 초까지 그대로, 초가 없는 글자는 초를 지어내지 않음", () => {
    expect(formatKstSeconds("2026-11-06 14:31:05")).toBe("2026-11-06 14:31:05");
    expect(formatKstSeconds("2026-11-06 14:31:05 KST")).toBe("2026-11-06 14:31:05");
    expect(formatKstSeconds("2026-11-06T14:31:05.5")).toBe("2026-11-06 14:31:05");
    expect(formatKstSeconds("2026-11-06 14:31")).toBe("2026-11-06 14:31");
  });

  it("없으면 —, 알아볼 수 없으면 받은 그대로", () => {
    expect(formatKstSeconds(null)).toBe("—");
    expect(formatKstSeconds(undefined)).toBe("—");
    expect(formatKstSeconds("")).toBe("—");
    expect(formatKstSeconds("어제 저녁")).toBe("어제 저녁");
    expect(formatKstSeconds(new Date(Number.NaN))).toBe("—");
  });
});

describe("signedKrwText — 부호 있는 원화 금액의 표 칸 글(P7 검토 — 두 화면의 같은 도우미를 모음)", () => {
  it("양수는 +, 음수는 U+2212, 모르면 null(표가 '—')", async () => {
    const { signedKrwText, formatSignedKrw, withMinusSign } = await import("../format");
    expect(signedKrwText(null)).toBeNull();
    for (const value of [123_400_000_000, -2_611_000_000_000, 0]) expect(signedKrwText(value)).toBe(withMinusSign(formatSignedKrw(value)));
    expect(signedKrwText(-2_611_000_000_000)?.startsWith("\u2212")).toBe(true);
  });
});
