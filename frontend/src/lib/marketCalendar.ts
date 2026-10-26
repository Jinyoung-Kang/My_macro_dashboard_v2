/**
 * 거래소 휴장일 판정.
 *
 * 왜 공휴일 API를 쓰지 않는가
 * --------------------------
 * 예전에는 브라우저가 date.nager.at의 "공휴일" 목록을 받아 휴장을 판정했습니다.
 * **공휴일과 거래소 휴장일은 다릅니다.**
 *
 *   - 컬럼버스데이·재향군인의 날: 미국 연방 공휴일이지만 증시는 **열립니다**
 *     (채권시장만 휴장). 공휴일 목록으로 판정하면 "휴장"이라고 거짓말합니다.
 *   - 성금요일(Good Friday): 연방 공휴일이 **아니지만** 증시는 닫습니다.
 *     공휴일 목록에 없으므로 "거래 중"이라고 거짓말합니다.
 *
 * 게다가 페이지를 열 때마다 외부 API로 요청이 나갔습니다. 이 프로젝트는
 * "화면이 필요한 데이터는 모두 우리 백엔드를 거친다"를 지켜 왔는데 시계만
 * 예외였습니다.
 *
 * 미국은 규칙으로 계산하고(NYSE/NASDAQ 휴장 규칙은 날짜 규칙이라 계산 가능),
 * 한국은 음력이 섞여 규칙화할 수 없으므로 표로 둡니다.
 */

/** 로컬 날짜를 YYYY-MM-DD로. Date를 UTC로 바꾸지 않습니다. */
function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * 그 달의 n번째 특정 요일 날짜.
 *
 * @param year   연도
 * @param month  1~12
 * @param weekday 0=일 … 6=토
 * @param n      1이면 첫 번째, 3이면 세 번째
 * @returns 일(day) 숫자
 */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const offset = (weekday - first + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

/** 그 달의 마지막 특정 요일 날짜. */
function lastWeekday(year: number, month: number, weekday: number): number {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return lastDay - ((last - weekday + 7) % 7);
}

/**
 * 부활절 일요일 (Anonymous Gregorian algorithm).
 *
 * 성금요일 = 부활절 이틀 전이며, 미국 증시가 닫는 날인데 연방 공휴일이
 * 아니라서 공휴일 목록에는 없습니다.
 *
 * @returns [월, 일]
 */
function easterSunday(year: number): [number, number] {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

/**
 * 고정 날짜 휴일의 실제 휴장일.
 *
 * 미국 증시는 휴일이 토요일이면 **전날 금요일**, 일요일이면 **다음 월요일**에
 * 쉽니다. 이 규칙을 빠뜨리면 7월 4일이 토요일인 해에 7월 3일을 개장으로
 * 판정하게 됩니다.
 *
 * @returns YYYY-MM-DD
 */
function observed(year: number, month: number, day: number): string {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (weekday === 6) {
    return iso(year, month, day - 1);
  }
  if (weekday === 0) {
    return iso(year, month, day + 1);
  }
  return iso(year, month, day);
}

/**
 * NYSE·NASDAQ 정규장 휴장일.
 *
 * 규칙으로 계산하므로 해가 바뀌어도 손댈 필요가 없습니다.
 *
 * 주의: 조기 폐장일(추수감사절 다음 날, 12월 24일 등 13:00 종료)은 담지
 * 않습니다. 이 화면은 "열렸나/닫혔나"만 말하고 조기 폐장은 다루지 않습니다.
 *
 * @param year 연도
 * @returns YYYY-MM-DD 집합
 */
export function usMarketHolidays(year: number): Set<string> {
  const [easterMonth, easterDay] = easterSunday(year);
  const goodFriday = new Date(Date.UTC(year, easterMonth - 1, easterDay - 2));

  return new Set<string>([
    observed(year, 1, 1),                                   // 신정
    iso(year, 1, nthWeekday(year, 1, 1, 3)),                // 마틴 루터 킹 데이 (1월 셋째 월)
    iso(year, 2, nthWeekday(year, 2, 1, 3)),                // 대통령의 날 (2월 셋째 월)
    iso(year, goodFriday.getUTCMonth() + 1, goodFriday.getUTCDate()), // 성금요일
    iso(year, 5, lastWeekday(year, 5, 1)),                  // 메모리얼 데이 (5월 마지막 월)
    observed(year, 6, 19),                                  // 준틴스
    observed(year, 7, 4),                                   // 독립기념일
    iso(year, 9, nthWeekday(year, 9, 1, 1)),                // 노동절 (9월 첫째 월)
    iso(year, 11, nthWeekday(year, 11, 4, 4)),              // 추수감사절 (11월 넷째 목)
    observed(year, 12, 25),                                 // 크리스마스
  ]);
}

/**
 * KRX 휴장일.
 *
 * 세 겹으로 쌓습니다(위가 우선).
 *
 *   1. **공식 목록** — 천문연 특일정보를 수집기가 받아 백엔드가 전달한 날짜.
 *      대체공휴일·선거일·임시공휴일처럼 규칙으로 알 수 없는 날까지 들어 있습니다.
 *   2. **내장 표** — 같은 API의 실제 응답으로 만든 2025~2028년 목록
 *      ({@link KR_PUBLIC_HOLIDAYS}). 키가 없거나 백엔드가 꺼져도 맞게 동작합니다.
 *   3. **양력 고정 규칙** — 위 둘이 모두 없는 해. 설날·추석·대체공휴일은 빠지므로
 *      화면이 {@link krHolidayCoverage}로 안내를 띄웁니다.
 *
 * 어느 겹이든 KRX 고유 휴장일(근로자의 날 5/1, 연말 폐장 12/31)을 더합니다.
 * 5/1은 2026년부터 공휴일(노동절)이기도 하지만, 그 전 해에도 KRX는 쉬었습니다.
 * 12/31이 주말·공휴일이면 그 직전 매매거래일도 더합니다({@link krYearEndClosure}, QA-142).
 *
 * @param year 연도
 * @param official 백엔드가 준 그 해 공휴일(YYYY-MM-DD). 없거나 비면 내장 표·규칙을 씁니다
 * @returns YYYY-MM-DD 집합
 */
export function krMarketHolidays(year: number, official?: readonly string[] | null): Set<string> {
  const days = new Set<string>([iso(year, 5, 1)]);
  const listed = official && official.length > 0 ? official : KR_PUBLIC_HOLIDAYS[year];
  if (listed) {
    listed.forEach((day) => days.add(day));
  } else {
    [
      iso(year, 1, 1),    // 신정
      iso(year, 3, 1),    // 삼일절
      iso(year, 5, 5),    // 어린이날
      iso(year, 6, 6),    // 현충일
      iso(year, 8, 15),   // 광복절
      iso(year, 10, 3),   // 개천절
      iso(year, 10, 9),   // 한글날
      iso(year, 12, 25),  // 성탄절
    ].forEach((day) => days.add(day));
  }
  // 대체일은 12/31을 더하기 전의 공휴일로 셉니다(12/31 자신이 공휴일인지만 봄).
  const yearEnd = krYearEndClosure(year, days);
  days.add(iso(year, 12, 31));
  days.add(yearEnd);
  return days;
}

/**
 * KRX 연말 휴장일 — 12/31, 그날이 토·일·공휴일이면 그 직전 매매거래일.
 *
 * KRX 휴장일 목록의 실례가 2022-12-30(12/31 토)·2023-12-29(12/31 일)이고 다음은 2028-12-29입니다.
 * 12/31만 더하면 그 금요일을 거래일로 봅니다(QA-142). 수집기 `krcalendar.year_end_closure`와 같은 규칙입니다.
 *
 * @param year     연도
 * @param holidays 그 해 공휴일(YYYY-MM-DD) — 12/31 규칙으로 더한 날은 넣지 않습니다
 * @returns YYYY-MM-DD
 */
function krYearEndClosure(year: number, holidays: ReadonlySet<string>): string {
  for (let day = 31; day >= 1; day--) {
    const date = iso(year, 12, day);
    const weekday = new Date(Date.UTC(year, 11, day)).getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !holidays.has(date)) {
      return date;
    }
  }
  return iso(year, 12, 31);
}

/**
 * 그 해 휴장일 판정이 어느 겹에서 왔는지.
 *
 * @returns "official"(공식 목록) · "builtin"(내장 표) · "rules"(양력 규칙만 — 설날·추석
 *          ·대체공휴일이 빠져 있으므로 화면이 안내를 띄워야 함)
 */
export function krHolidayCoverage(
  year: number,
  official?: readonly string[] | null,
): "official" | "builtin" | "rules" {
  if (official && official.length > 0) return "official";
  return KR_PUBLIC_HOLIDAYS[year] ? "builtin" : "rules";
}

/**
 * 한국 공휴일 내장 표 (천문연 특일정보 getRestDeInfo, isHoliday=Y).
 *
 * 손으로 적지 않았습니다. 실제 API 응답(2026-08 관측, tests/fixtures/public의
 * README 참조)에서 날짜만 뽑았습니다. 예전에는 음력 휴일만 기억으로 적어 두었는데,
 * 이 응답과 대조하니 2025~2027년 평일 공휴일 14일이 빠져 있었습니다
 * (대체공휴일·선거일·임시공휴일·2026년 제헌절 공휴일 재지정).
 *
 * 주의사항 — 임시공휴일은 발표가 늦습니다. 키를 설정해 두면 수집기가 매주 공식
 * 목록을 받아 이 표보다 우선합니다. 표를 고칠 때도 API 응답에서 다시 뽑으세요.
 */
const KR_PUBLIC_HOLIDAYS: Record<number, readonly string[]> = {
  2025: [
    "2025-01-01", "2025-01-27", "2025-01-28", "2025-01-29", "2025-01-30", "2025-03-01",
    "2025-03-03", "2025-05-05", "2025-05-06", "2025-06-03", "2025-06-06", "2025-08-15",
    "2025-10-03", "2025-10-05", "2025-10-06", "2025-10-07", "2025-10-08", "2025-10-09",
    "2025-12-25",
  ],
  2026: [
    "2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18", "2026-03-01", "2026-03-02",
    "2026-05-01", "2026-05-05", "2026-05-24", "2026-05-25", "2026-06-03", "2026-06-06",
    "2026-07-17", "2026-08-15", "2026-08-17", "2026-09-24", "2026-09-25", "2026-09-26",
    "2026-10-03", "2026-10-05", "2026-10-09", "2026-12-25",
  ],
  2027: [
    "2027-01-01", "2027-02-06", "2027-02-07", "2027-02-08", "2027-02-09", "2027-03-01",
    "2027-05-01", "2027-05-03", "2027-05-05", "2027-05-13", "2027-06-06", "2027-07-17",
    "2027-07-19", "2027-08-15", "2027-08-16", "2027-09-14", "2027-09-15", "2027-09-16",
    "2027-10-03", "2027-10-04", "2027-10-09", "2027-10-11", "2027-12-25", "2027-12-27",
  ],
  2028: [
    "2028-01-01", "2028-01-26", "2028-01-27", "2028-01-28", "2028-03-01", "2028-04-12",
    "2028-05-01", "2028-05-02", "2028-05-05", "2028-06-06", "2028-07-17", "2028-08-15",
    "2028-10-02", "2028-10-03", "2028-10-04", "2028-10-05", "2028-10-09", "2028-12-25",
  ],
};
