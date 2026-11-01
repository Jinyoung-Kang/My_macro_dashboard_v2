/**
 * 지표별 개장/마감 판정 자가 검증.
 *
 * 실행: `npm run check`
 *
 * 고정하는 것 — 점심·정비 휴식, 자정을 넘기는 야간장(과 그 휴장일 귀속),
 * 주말, KRX·미국 휴장일, 그리고 "개장 시간인데 체결이 멈춘" 휴장 추정.
 * 시각은 모두 UTC로 적고 옆에 현지 시각을 달았습니다.
 */
import { kstYear, sessionStatus, tradeDayFrom, tradeTimeFrom } from "../marketSessions.ts";

let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}\n     받음: ${String(actual)}\n     기대: ${String(expected)}`);
    failed++;
  }
}

const at = (iso: string) => new Date(iso);
const state = (market: string, iso: string) => sessionStatus(market, at(iso))?.state;

console.log("KRX 주식 (KST = UTC+9)");
check("화 10:00 개장", state("krx", "2026-09-22T01:00:00Z"), "open");
check("화 15:30 마감", state("krx", "2026-09-22T06:30:00Z"), "closed");
check("추석 9/25(금) 10:00 휴장", state("krx", "2026-09-25T01:00:00Z"), "holiday");
check("토요일 휴장", state("krx", "2026-09-19T01:00:00Z"), "holiday");

console.log("\nKRX 코스피200 선물 (야간 18:00~06:00)");
check("화 20:00 야간 개장", state("krx_futures", "2026-09-22T11:00:00Z"), "open");
check("수 03:00 야간 개장 (화요일 거래일)", state("krx_futures", "2026-09-22T18:00:00Z"), "open");
check("화 16:30 주·야간 사이 휴식", state("krx_futures", "2026-09-22T07:30:00Z"), "break");
check("토 03:00 금요일 야간장 개장", state("krx_futures", "2026-09-18T18:00:00Z"), "open");
// 9/25(금)가 휴장이면 9/25 저녁 야간장도 없고, 그 뒷부분인 9/26(토) 새벽도 휴장
check("추석 9/26(토) 02:00 휴장", state("krx_futures", "2026-09-25T17:00:00Z"), "holiday");

console.log("\n도쿄 (JST = UTC+9)");
check("12:00 점심 휴식", state("tse", "2026-09-24T03:00:00Z"), "break");
check("15:00 개장 (15:30 연장)", state("tse", "2026-09-24T06:00:00Z"), "open");
check("16:00 마감", state("tse", "2026-09-24T07:00:00Z"), "closed");

console.log("\n홍콩 항셍 선물 (HKT = UTC+8)");
check("16:45 주·야간 사이 휴식", state("hkex_futures", "2026-09-24T08:45:00Z"), "break");
check("금 02:00 야간 개장", state("hkex_futures", "2026-09-24T18:00:00Z"), "open");
check("금 04:00 야간 종료 후 마감", state("hkex_futures", "2026-09-24T20:00:00Z"), "closed");

console.log("\n미국 (EDT = UTC-4)");
check("NYSE 수 10:00 개장", state("nyse", "2026-09-23T14:00:00Z"), "open");
check("NYSE 노동절 9/7 휴장", state("nyse", "2026-09-07T14:00:00Z"), "holiday");
check("CME 수 17:30 정비 휴식", state("cme", "2026-09-23T21:30:00Z"), "break");
check("CME 일 19:00 개장", state("cme", "2026-09-20T23:00:00Z"), "open");
check("CME 일 12:00 휴장", state("cme", "2026-09-20T16:00:00Z"), "holiday");
check("CME 금 17:30 마감", state("cme", "2026-09-25T21:30:00Z"), "closed");
check("외환 일 17:30 개장", state("fx", "2026-09-20T21:30:00Z"), "open");
check("국채 컬럼버스데이 10/12 휴장 (증시는 개장)", state("ust", "2026-10-12T14:00:00Z"), "holiday");
check("NYSE 컬럼버스데이 10/12 개장", state("nyse", "2026-10-12T14:00:00Z"), "open");

console.log("\n런던 ICE 브렌트 (BST = UTC+1)");
check("일 23:30 개장", state("ice_brent", "2026-09-20T22:30:00Z"), "open");
check("화 00:30 마감", state("ice_brent", "2026-09-22T23:30:00Z"), "closed");

console.log("\n휴장 추정 (공휴일 목록이 없는 시장)");
// 상하이 10/1 국경절(목) 10:30 — 마지막 체결이 9/30 15:00에 멈춤
const golden = sessionStatus(
  "sse", at("2026-10-01T02:30:00Z"), null,
  tradeTimeFrom("2026-09-30 16:00"), at("2026-10-01T02:30:00Z"),
);
check("국경절: 개장 시간인데 체결 없음 → 휴장 추정", golden?.state, "idle");
// 개장 직후(09:35)에는 아직 체결이 없어도 판정하지 않음
const justOpened = sessionStatus(
  "sse", at("2026-09-29T01:35:00Z"), null,
  tradeTimeFrom("2026-09-28 16:00"), at("2026-09-29T01:35:00Z"),
);
check("개장 직후에는 휴장 추정하지 않음", justOpened?.state, "open");
check("수집 시각 표기는 체결 시각이 아님", tradeTimeFrom("2026-09-26 03:43 KST (TradingView 수집 시각)"), null);
check("일봉 표기는 체결 시각이 아님", tradeTimeFrom("2026-09-23 일봉 기준"), null);
check("모르는 시장은 배지 없음", sessionStatus("unknown", at("2026-09-23T00:00:00Z")), null);

console.log("\n휴장 추정 — 체결 시각 없이 거래일만 있는 카드 (QA-138)");
check("장 밖 TradingView 표기의 거래일", tradeDayFrom("2026-10-16 거래일 기준 (TradingView · 장 밖)"), "2026-10-16");
check("일봉 표기의 거래일", tradeDayFrom("2026-09-23 일봉 기준"), "2026-09-23");
check("수집 시각 표기는 거래일이 아님", tradeDayFrom("2026-10-19 20:35 KST (TradingView 수집 시각)"), null);
// 홍콩 중양절 대체 휴장 10/19(월) 11:00 — 값의 거래일이 10/16(금)
const hkHoliday = sessionStatus("hkex", at("2026-10-19T03:00:00Z"), null, null, at("2026-10-19T02:55:00Z"), "2026-10-16");
check("홍콩 휴장일: 거래일이 오늘보다 앞 → 휴장 추정", hkHoliday?.state, "idle");
// 개장 30분 뒤(10:00)에는 아직 판정하지 않음 — 첫 수집이 개장 전 값을 들고 있을 수 있습니다
const hkEarly = sessionStatus("hkex", at("2026-10-19T02:00:00Z"), null, null, at("2026-10-19T02:00:00Z"), "2026-10-16");
check("개장 한 시간 안에는 거래일로 휴장 추정하지 않음", hkEarly?.state, "open");
// 밤을 넘기는 시장(외환)은 세션 거래일이 다음 날이라 달력 날짜와 비교하지 않음
const fxEvening = sessionStatus("fx", at("2026-10-19T23:00:00Z"), null, null, at("2026-10-19T23:00:00Z"), "2026-10-16");
check("밤을 넘기는 시장은 거래일로 판정하지 않음", fxEvening?.state, "open");

if (failed > 0) {
  console.error(`\n${failed}건 실패`);
  process.exit(1);
}
console.log("\n모두 통과");console.log("한국 시간 연도");
check("UTC 12/31 16:00 = KST 1/1 01:00 → 새해", kstYear(new Date(Date.UTC(2025, 11, 31, 16, 0))), 2026);
check("UTC 12/31 14:00 = KST 12/31 23:00 → 그해", kstYear(new Date(Date.UTC(2025, 11, 31, 14, 0))), 2025);


