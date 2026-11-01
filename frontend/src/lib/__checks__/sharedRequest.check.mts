/**
 * 동시 GET 묶기 자가 검증.
 *
 * 실행: `npm run check`
 *
 * 무엇을 고정하는가 — 같은 주소를 동시에 부르면 요청은 한 번만 나가고 결과를 함께 씁니다.
 * 끝난 뒤에는 다시 부르면 새로 나갑니다(결과를 보관하지 않음). 실패도 함께 받고, 실패한
 * 요청이 남아 다음 호출을 막지 않습니다.
 */
import { createSharedFetcher } from "../sharedRequest.ts";

let failed = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — 기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)}`}`);
}

console.log("동시 요청 묶기");
{
  const calls: string[] = [];
  const resolvers = new Map<string, (value: string) => void>();
  const get = createSharedFetcher<string>((key) => {
    calls.push(key);
    return new Promise((resolve) => { resolvers.set(key, resolve); });
  });
  const first = get("/api/guru/profiles");
  const second = get("/api/guru/profiles");
  const other = get("/api/status");
  check("같은 주소는 한 번만 요청", calls.filter((key) => key === "/api/guru/profiles").length, 1);
  check("다른 주소는 따로 요청", calls.length, 2);
  resolvers.get("/api/guru/profiles")?.("A");
  resolvers.get("/api/status")?.("B");
  check("같은 주소를 부른 두 쪽이 같은 결과", [await first, await second], ["A", "A"]);
  check("다른 주소 결과", await other, "B");
}
{
  let count = 0;
  const get = createSharedFetcher<number>(async () => { count += 1; return count; });
  const [a, b] = await Promise.all([get("/x"), get("/x")]);
  check("동시에 부른 두 쪽이 같은 결과", [a, b], [1, 1]);
  check("끝난 뒤 다시 부르면 새로 요청", await get("/x"), 2);
}
{
  let count = 0;
  const get = createSharedFetcher<number>(async () => {
    count += 1;
    if (count === 1) throw new Error("일시 오류");
    return count;
  });
  const results = await Promise.allSettled([get("/y"), get("/y")]);
  check("실패도 함께 받음", results.map((r) => r.status), ["rejected", "rejected"]);
  check("실패한 요청이 남아 다음 호출을 막지 않음", await get("/y"), 2);
}

console.log(failed === 0 ? "\n통과" : `\n실패 ${failed}건`);
process.exit(failed === 0 ? 0 : 1);
