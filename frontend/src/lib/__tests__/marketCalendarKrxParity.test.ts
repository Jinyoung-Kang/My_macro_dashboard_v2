/**
 * 화면 KRX 휴장일과 백엔드 한국 달력(`analytics.KrxCalendar`)이 같은 날을 쉰다고 보는지(v2 2단계 명세 §9 B5 '화면 표 대조').
 *
 * 두 쪽이 한 고정본 `backend/src/test/resources/paper/kr-calendar/krx-closures-2025-2028.json`(KRX 평일 휴장일 2025~2028)과
 * 견줍니다 — 백엔드는 `KrxCalendarScreenParityTest`가 이 파일의 내장 표를 읽어 `KrxCalendar`로 만든 값을, 여기서는
 * `krMarketHolidays`(내장 표 겹)를. 어느 쪽 규칙이 바뀌어도 갈립니다. 고정본의 2026·2027은 KRX 공식 목록과 같습니다.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { krMarketHolidays } from "@/lib/marketCalendar";

type Shared = { years: Record<string, string[]> };

const shared: Shared = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../../backend/src/test/resources/paper/kr-calendar/krx-closures-2025-2028.json"),
    "utf8",
  ),
);

/** 그해 휴장일 집합 중 평일만, 날짜 순 — 고정본(KRX 목록처럼 평일만)과 견주려고. */
function weekdayClosures(year: number): string[] {
  return [...krMarketHolidays(year)]
    .filter((day) => {
      const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
      return weekday !== 0 && weekday !== 6;
    })
    .sort();
}

describe("화면 KRX 휴장일 = 백엔드 KrxCalendar 공유 고정본(2025~2028)", () => {
  it("고정본은 2025~2028 네 해", () => {
    expect(Object.keys(shared.years).sort()).toEqual(["2025", "2026", "2027", "2028"]);
  });

  for (const year of [2025, 2026, 2027, 2028]) {
    it(`${year}년 평일 휴장일이 같음`, () => {
      expect(weekdayClosures(year)).toEqual(shared.years[String(year)]);
    });
  }

  it("2028-12-29(금, 12-31 일) 연말휴장 — QA-142 뒤", () => {
    expect(shared.years["2028"]).toContain("2028-12-29");
    expect(weekdayClosures(2028)).toContain("2028-12-29");
  });
});
