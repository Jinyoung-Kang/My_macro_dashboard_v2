/**
 * 수동 실행 대기 자가 검증 — "다시 실행"이 끝난 것을 실행 이력으로 알아내는 규칙.
 *
 * 실행: `npm run check`
 *
 * 무엇을 고정하는가 — 기준 시각보다 늦게 시작한 기록만 "끝남"으로 봅니다. 백엔드(자바
 * Instant)와 수집기(파이썬 isoformat)가 시각을 다른 모양으로 적어도 같은 순간으로 비교합니다.
 * 한 번 못 읽었다고 멈추지 않고, 시간이 지나거나 화면을 떠나면 조용히 멈춥니다.
 */
import { isNewerRun, waitForTaskRun, type TaskRunRow } from "../taskRun.ts";

let failed = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — 기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)}`}`);
}

const row = (startedAt: string | null, status: TaskRunRow["status"] = "ok"): TaskRunRow => ({
  task: "sec_13f", status, startedAt, durationMs: 1000, detail: null,
});

console.log("끝난 실행 가리기");
const baseline = "2026-09-27T00:00:00.123Z";            // 백엔드(자바 Instant)
check("같은 기록(표기만 다름)은 새 기록이 아님", isNewerRun(row("2026-09-27T00:00:00.123000+00:00"), baseline), false);
check("더 늦게 시작한 기록은 끝난 것", isNewerRun(row("2026-09-27T09:10:00.5+09:00"), baseline), true);
check("기준이 없으면(처음 실행) 기록이 있기만 하면 끝난 것", isNewerRun(row("2026-09-27T00:00:00Z"), null), true);
check("기록이 없으면 아직", isNewerRun(null, baseline), false);
check("시작 시각이 없는 기록은 판단하지 않음", isNewerRun(row(null), baseline), false);

console.log("기다리기");
const noSleep = async () => {};
{
  let calls = 0;
  const answers: (TaskRunRow | null)[] = [row("2026-09-27T00:00:00.123Z"), null, row("2026-09-27T00:05:00Z", "error")];
  const result = await waitForTaskRun(baseline, {
    fetchLatest: async () => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      if (calls === 2) throw new Error("일시 오류");       // 한 번 실패해도 계속
      return answer;
    },
    sleep: noSleep,
  });
  check("새 기록이 나올 때까지 기다린다(중간 실패 무시)", result?.status, "error");
  check("세 번 물어봄", calls, 3);
}
{
  let clock = 0;
  const result = await waitForTaskRun(baseline, {
    fetchLatest: async () => row(baseline),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    timeoutMs: 10_000,
    intervalMs: 3_000,
  });
  check("시간이 지나면 null", result, null);
}
{
  let asked = 0;
  const result = await waitForTaskRun(baseline, {
    fetchLatest: async () => { asked += 1; return row("2026-09-27T01:00:00Z"); },
    sleep: noSleep,
    isCancelled: () => true,
  });
  check("화면을 떠나면 더 묻지 않고 null", [result, asked], [null, 0]);
}

console.log(failed === 0 ? "\n통과" : `\n실패 ${failed}건`);
process.exit(failed === 0 ? 0 : 1);
