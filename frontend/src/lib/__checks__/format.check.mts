/**
 * 시각 표기 자가 검증 — 화면의 모든 시각은 "YYYY-MM-DD HH:mm"(한국 시간, 초 없음).
 *
 * 실행: `npm run check`
 *
 * 무엇을 고정하는가 — 값은 여러 모양으로 옵니다. DB에 남은 옛 형식(초·"KST" 포함),
 * 실행 기록의 ISO(UTC), 자바 ZonedDateTime, 문장 속 시각. 어느 것이 와도 같은 모양으로
 * 보여야 하고, 알아볼 수 없는 값은 지어내지 않고 그대로 둡니다.
 */
import { delayLabel, formatKst } from "../format.ts";

let failed = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — 기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)}`}`);
}

console.log("시각 표기");
check("옛 형식(초·KST) → 분", formatKst("2026-09-25 23:43:09 KST"), "2026-09-25 23:43");
check("새 형식 → 그대로(KST만 뗌)", formatKst("2026-09-25 23:43 KST"), "2026-09-25 23:43");
check("ISO UTC → KST로 변환", formatKst("2026-09-25T14:20:59.123Z"), "2026-09-25 23:20");
check("ISO +00:00 → KST", formatKst("2026-09-25T15:30:00+00:00"), "2026-09-26 00:30");
check("자바 ZonedDateTime", formatKst("2026-09-25T23:23:16.354977589+09:00[Asia/Seoul]"), "2026-09-25 23:23");
check("문장 속 시각만 바꿈", formatKst("2026-09-25 23:43:09 KST (TradingView 수집 시각)"), "2026-09-25 23:43 (TradingView 수집 시각)");
check("날짜 없는 옛 형식은 날짜를 지어내지 않음", formatKst("23:33:00 KST"), "23:33");
check("일봉 문구는 그대로", formatKst("2026-09-24 일봉 기준"), "2026-09-24 일봉 기준");
check("Date 객체", formatKst(new Date(Date.UTC(2026, 8, 25, 14, 43, 9))), "2026-09-25 23:43");
check("알 수 없는 값은 그대로", formatKst("알 수 없음"), "알 수 없음");
check("빈 값 → —", formatKst(null), "—");

console.log("\n시세 지연 배지 (QA-137)");
check("0분은 실시간", delayLabel(0), "실시간");
check("20분 지연", delayLabel(20), "20분 지연");
check("모르면 표시하지 않음", delayLabel(null), null);

console.log(failed === 0 ? "\n통과" : `\n실패 ${failed}건`);
process.exit(failed === 0 ? 0 : 1);
