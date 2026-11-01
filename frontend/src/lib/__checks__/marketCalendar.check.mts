/**
 * 거래소 휴장일 계산 자가 검증.
 *
 * 실행: `npm run check` (또는 `make test-frontend`)
 *
 * 왜 테스트 프레임워크를 쓰지 않는가 — 이 프로젝트의 화면에는 아직 단위 테스트
 * 러너가 없습니다. 러너 하나를 들이는 것보다, 순수 함수 하나를 Node가 직접
 * 돌려 검증하는 편이 설치할 것이 없고 실패 메시지도 분명합니다.
 *
 * 무엇을 고정하는가 — 미국 휴장일 계산은 "공휴일"이 아니라 "거래소 휴장일"이며,
 * 주말에 걸린 고정 휴일의 대체 규칙(토→전 금, 일→익 월)까지 맞아야 합니다.
 * 아래 4개 연도는 그 규칙이 모두 걸리도록 고른 표본입니다.
 */
import { usMarketHolidays, krMarketHolidays, krHolidayCoverage } from "../marketCalendar.ts";

/** 실제 NYSE·NASDAQ 정규장 휴장일. */
const EXPECTED_US: Record<number, string[]> = {
  2024: ["2024-01-01", "2024-01-15", "2024-02-19", "2024-03-29", "2024-05-27",
         "2024-06-19", "2024-07-04", "2024-09-02", "2024-11-28", "2024-12-25"],
  2025: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
         "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25"],
  // 2026-07-03: 독립기념일이 토요일 → 전날 금요일 휴장
  2026: ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
         "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"],
  // 2027-06-18(토→금) · 2027-07-05(일→월) · 2027-12-24(토→금)
  2027: ["2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
         "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"],
};

let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}\n     받음: ${a}\n     기대: ${b}`);
    failed++;
  }
}

console.log("미국 거래소 휴장일");
for (const [year, expected] of Object.entries(EXPECTED_US)) {
  check(`${year}년 10일`, [...usMarketHolidays(Number(year))].sort(), expected);
}

console.log("\n공휴일이지만 증시는 열리는 날 (여기 있으면 안 됩니다)");
// 컬럼버스데이·재향군인의 날은 연방 공휴일이지만 증시는 정상 개장합니다.
check("2026-10-12 컬럼버스데이 제외", usMarketHolidays(2026).has("2026-10-12"), false);
check("2026-11-11 재향군인의 날 제외", usMarketHolidays(2026).has("2026-11-11"), false);

console.log("\n공휴일이 아니지만 증시는 닫는 날 (여기 있어야 합니다)");
check("2026-04-03 성금요일 포함", usMarketHolidays(2026).has("2026-04-03"), true);

console.log("\nKRX 양력 고정 휴일");
check("2026-05-01 근로자의 날", krMarketHolidays(2026).has("2026-05-01"), true);
check("2026-12-31 연말 폐장", krMarketHolidays(2026).has("2026-12-31"), true);
check("2026-10-09 한글날", krMarketHolidays(2026).has("2026-10-09"), true);

console.log("\nKRX — 예전 규칙이 놓쳤던 평일 공휴일 14일 (천문연 실제 응답 기준)");
const MISSED_BEFORE = [
  "2025-01-27", "2025-03-03", "2025-06-03",                                   // 임시공휴일·대체공휴일·대선
  "2026-03-02", "2026-06-03", "2026-07-17", "2026-08-17", "2026-10-05",       // 대체공휴일·지방선거·제헌절
  "2027-05-03", "2027-07-19", "2027-08-16", "2027-10-04", "2027-10-11", "2027-12-27",
];
for (const day of MISSED_BEFORE) {
  check(`${day} 휴장`, krMarketHolidays(Number(day.slice(0, 4))).has(day), true);
}
check("2026-09-25 추석 휴장", krMarketHolidays(2026).has("2026-09-25"), true);
check("2026-09-28 추석 다음 월요일은 개장", krMarketHolidays(2026).has("2026-09-28"), false);

console.log("\nKRX — 공식 목록이 오면 그것이 우선");
// 표에 없는 해라도 백엔드가 공식 목록을 주면 그대로 씁니다(임시공휴일 발표 대응).
check("2099 공식 목록 반영", krMarketHolidays(2099, ["2099-02-03"]).has("2099-02-03"), true);
check("2099 공식 목록 + 연말 폐장", krMarketHolidays(2099, ["2099-02-03"]).has("2099-12-31"), true);
check("출처 표시: official", krHolidayCoverage(2099, ["2099-02-03"]), "official");
check("출처 표시: builtin", krHolidayCoverage(2026, null), "builtin");

console.log("\nKRX — 목록이 전혀 없는 해는 '모른다'고 말해야 합니다");
check("출처 표시: rules", krHolidayCoverage(2099, []), "rules");
// 목록이 없어도 양력 휴일은 그대로 나와야 합니다(빈 집합이 아님).
check("2099년에도 양력 휴일은 나옴", krMarketHolidays(2099).has("2099-01-01"), true);

console.log(failed === 0 ? "\n통과" : `\n실패 ${failed}건`);
process.exit(failed === 0 ? 0 : 1);
