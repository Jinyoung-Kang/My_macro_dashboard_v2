/**
 * KRX 연말 휴장일의 주말·공휴일 대체(QA-142).
 *
 * KRX 연말 휴장일은 12-31이고, 그날이 토·일·공휴일이면 그 직전 매매거래일을 쉽니다. KRX 휴장일 목록의 실례가
 * 2022-12-30(금, 12-31 토)·2023-12-29(금, 12-31 일)이고, 앞으로는 2028-12-29(금, 12-31 일)·2033-12-30·2034-12-29입니다
 * (v2 2단계 명세 §4-4·K27). `krMarketHolidays`가 12-31만 더해 그 금요일을 거래일로 보고, 시계·카드 배지가 휴장일에
 * '개장'을 띄웁니다. 2026·2027은 12-31이 평일이라 영향이 없습니다.
 */
import { describe, expect, it } from "vitest";

import { krMarketHolidays } from "@/lib/marketCalendar";
import { sessionStatus } from "@/lib/marketSessions";

describe("QA-142 KRX 연말 휴장일은 12-31, 주말·공휴일이면 직전 매매거래일", () => {
  it.fails("2028-12-31(일) → 2028-12-29(금) 휴장, 12-28(목)은 개장 — 내장 표", () => {
    const days = krMarketHolidays(2028);
    expect(days.has("2028-12-29")).toBe(true);
    expect(days.has("2028-12-28")).toBe(false);
  });

  it.fails("2028-12-29 10:00 KST 한국 주식 배지는 휴장", () => {
    expect(sessionStatus("krx", new Date("2028-12-29T01:00:00Z"))?.state).toBe("holiday");
  });

  it.fails("KRX 실례 2022-12-30(12-31 토)·2023-12-29(12-31 일) — 공식 목록이 와도 같음", () => {
    expect(krMarketHolidays(2022).has("2022-12-30")).toBe(true);
    expect(krMarketHolidays(2023, ["2023-01-01", "2023-12-25"]).has("2023-12-29")).toBe(true);
    expect(krMarketHolidays(2023, ["2023-01-01", "2023-12-25"]).has("2023-12-28")).toBe(false);
  });

  it.fails("표 없는 해(양력 규칙 겹)도 주말 대체는 앎 — 2033-12-30·2034-12-29", () => {
    expect(krMarketHolidays(2033).has("2033-12-30")).toBe(true);
    expect(krMarketHolidays(2034).has("2034-12-29")).toBe(true);
  });

  it.fails("12-31이 평일 공휴일이면 직전 매매거래일 — 가상의 2029-12-31(월) 임시공휴일 → 12-28(금)", () => {
    const days = krMarketHolidays(2029, ["2029-01-01", "2029-12-25", "2029-12-31"]);
    expect(days.has("2029-12-28")).toBe(true);
    expect(days.has("2029-12-27")).toBe(false);
  });

  it("12-31이 평일인 2026·2027은 그날만 쉬고 12-30은 개장", () => {
    expect(krMarketHolidays(2026).has("2026-12-31")).toBe(true);
    expect(krMarketHolidays(2026).has("2026-12-30")).toBe(false);
    expect(krMarketHolidays(2027).has("2027-12-31")).toBe(true);
    expect(krMarketHolidays(2027).has("2027-12-30")).toBe(false);
    expect(sessionStatus("krx", new Date("2027-12-30T01:00:00Z"))?.state).toBe("open");
  });
});
