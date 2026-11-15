/**
 * 관심 대상 등록 503 partial(계약 §6-4)의 '다시 해 볼 때' 글을 백엔드 소스의 상수와 대조합니다(검토 지적).
 *
 * 같은 안내가 두 곳에 있습니다 — 백엔드 `SearchWatchService.RETRY_LATER`·`RETRY_DART_STORE`(503 본문 `message`의 뒤쪽, `failed`를 읽지 않는
 * API 사용자·예전 화면이 봄)와 화면 `lib/infoSearch`의 `WATCH_PARTIAL_RETRY_LATER`·`WATCH_PARTIAL_RETRY_DART_STORE`(`failed`로 출처를 적은 글의
 * 끝). 한쪽만 고치면 화면과 API가 다른 시점을 말하게 되어 이 시험이 막습니다(선례: realtradeCodes.test.ts가 백엔드 코드 상수를 읽음).
 * DART 저장본 출처 키(`dart_store`)도 같이 봅니다 — 화면이 그 키로 안내를 고릅니다.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WATCH_PARTIAL_DART_STORE, WATCH_PARTIAL_RETRY_DART_STORE, WATCH_PARTIAL_RETRY_LATER, watchPartialText } from "@/lib/infoSearch";

const SERVICE = readFileSync(
  resolve(__dirname, "../../../../backend/src/main/java/com/macrodash/feature/search/SearchWatchService.java"),
  "utf8",
);

/** `static final String 이름 = "값";` 한 줄 상수의 값 — 없으면(소스 모양이 바뀜) null. */
function javaString(name: string): string | null {
  const match = SERVICE.match(new RegExp(`static final String ${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*;`));
  return match ? match[1] : null;
}

describe("관심 대상 등록 partial — 다시 해 볼 때 글이 백엔드와 같다", () => {
  it("대조할 상수를 실제로 읽었다(소스 모양이 바뀌어 빈 값으로 통과하지 않게)", () => {
    for (const name of ["RETRY_LATER", "RETRY_DART_STORE", "DART_STORE", "PARTIAL_HEAD"]) {
      expect(javaString(name), name).toBeTruthy();
    }
    // 503 message가 앞머리 + 이 두 안내로 만들어지는지 — 다른 글로 바뀌면 이 대조가 뜻을 잃습니다.
    expect(SERVICE).toMatch(/static final String PARTIAL\s*=\s*PARTIAL_HEAD \+ " — " \+ RETRY_LATER;/);
    expect(SERVICE).toMatch(/static final String PARTIAL_DART_STORE\s*=\s*PARTIAL_HEAD \+ " — " \+ RETRY_DART_STORE;/);
  });

  it("일반 안내·DART 저장본 안내·저장본 출처 키가 두 쪽에서 같다", () => {
    expect(WATCH_PARTIAL_RETRY_LATER).toBe(javaString("RETRY_LATER"));
    expect(WATCH_PARTIAL_RETRY_DART_STORE).toBe(javaString("RETRY_DART_STORE"));
    expect(WATCH_PARTIAL_DART_STORE).toBe(javaString("DART_STORE"));
  });

  it("화면 글은 그 안내로 끝난다 — 저장본이 섞이면 저장본 안내, 아니면 일반 안내", () => {
    const later = watchPartialText({ reason: "partial", failed: [{ source: "wikidata", message: "합성 사유" }] }) ?? "";
    const store = watchPartialText({ reason: "partial", failed: [{ source: "sec" }, { source: WATCH_PARTIAL_DART_STORE, message: "합성 사유" }] }) ?? "";
    expect(later.endsWith(` ${WATCH_PARTIAL_RETRY_LATER}`), later).toBe(true);
    expect(store.endsWith(` ${WATCH_PARTIAL_RETRY_DART_STORE}`), store).toBe(true);
  });
});
