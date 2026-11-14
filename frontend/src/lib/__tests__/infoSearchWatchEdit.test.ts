/**
 * 정보 검색 단계 6 묶음 2(계약 §9-4·9-5)의 화면 규칙 — 관심 대상 별칭 편집(서버와 같은 검사: 1~12개, 하나 1~60자, 제어 글자 없음,
 * 대소문자 무시 중복은 하나), 알림 켬·끔 칸 읽기, 알림함의 관심 대상 줄이 가는 주소(정보 검색 화면 안쪽만). 표본은 모두 합성 값입니다.
 */
import { describe, expect, it } from "vitest";
import {
  ALIAS_MERGE_NOTE,
  ALIAS_SHORT_NOTE,
  NOTIFY_LABEL,
  WATCH_ALIAS_CHARS,
  WATCH_ALIAS_MAX,
  aliasDraft,
  aliasesForSave,
  notifyStateText,
  sameAliases,
  searchWatchInboxHref,
  watchAliasesOf,
  watchNotifyOf,
} from "@/lib/infoSearch";

const twelve = Array.from({ length: 12 }, (_, at) => `합성 별칭 ${at}`);

describe("별칭 하나 더하기(aliasDraft)", () => {
  it("앞뒤 공백을 떼고 가운데 이어진 공백을 하나로", () => {
    expect(aliasDraft("  Example   Holdings  ", [])).toEqual({ ok: true, alias: "Example Holdings" });
  });

  it("비면 거절", () => {
    expect(aliasDraft("   ", [])).toEqual({ ok: false, message: "별칭을 넣어 주세요" });
  });

  it("60자까지(글자 단위 — 한글·서로게이트 쌍도 한 글자)", () => {
    expect(WATCH_ALIAS_CHARS).toBe(60);
    expect(aliasDraft("가".repeat(60), []).ok).toBe(true);
    expect(aliasDraft("가".repeat(61), [])).toEqual({ ok: false, message: "별칭은 60자까지입니다" });
    // UTF-16으로는 120칸이지만 60글자
    expect(aliasDraft("\u{1D400}".repeat(60), []).ok).toBe(true);
  });

  it("제어 글자(C0·DEL·C1)가 있으면 거절", () => {
    for (const bad of ["합성\u0000별칭", "합성\u0007", "합성\u007f", "합성\u0085x", "합성\u009f"]) {
      expect(aliasDraft(bad, [])).toEqual({ ok: false, message: "별칭에 쓸 수 없는 글자가 있습니다" });
    }
  });

  it("대소문자만 다른 같은 별칭은 다시 넣지 않음", () => {
    expect(aliasDraft("example corp", ["Example Corp"])).toEqual({ ok: false, message: "이미 있는 별칭입니다(대소문자 무시)" });
  });

  it("12개를 넘지 않음", () => {
    expect(WATCH_ALIAS_MAX).toBe(12);
    expect(aliasDraft("하나 더", twelve)).toEqual({ ok: false, message: "별칭은 12개까지입니다" });
    expect(aliasDraft("하나 더", twelve.slice(0, 11))).toEqual({ ok: true, alias: "하나 더" });
  });
});

describe("저장할 목록(aliasesForSave)", () => {
  it("다듬고 대소문자 무시 중복은 앞의 것 하나만(서버와 같음)", () => {
    expect(aliasesForSave([" Example Corp ", "EXAMPLE CORP", "예시 회사"])).toEqual({ ok: true, aliases: ["Example Corp", "예시 회사"] });
  });

  it("하나도 없으면 저장하지 않음", () => {
    expect(aliasesForSave([])).toEqual({ ok: false, message: "별칭은 하나 이상이어야 합니다" });
    expect(aliasesForSave(["  "])).toEqual({ ok: false, message: "빈 별칭이 있습니다 — 빼고 저장하세요" });
  });

  it("12개를 넘으면 저장하지 않음(중복을 하나로 줄인 뒤에 셈)", () => {
    expect(aliasesForSave([...twelve, "열세째"])).toEqual({ ok: false, message: "별칭은 12개까지입니다" });
    expect(aliasesForSave([...twelve, twelve[0].toUpperCase()])).toEqual({ ok: true, aliases: twelve });
  });

  it("서버에 이미 있던 긴 별칭·제어 글자도 그 별칭을 짚어 막음(서버가 400으로 거절할 값)", () => {
    expect(aliasesForSave(["좋은 별칭", "가".repeat(61)])).toEqual({
      ok: false,
      message: `별칭 '${"가".repeat(20)}…'이(가) 60자를 넘습니다 — 빼고 저장하세요`,
    });
    expect(aliasesForSave(["좋은 별칭", "나쁜\u0001별칭"])).toEqual({ ok: false, message: "별칭 '나쁜 별칭'에 쓸 수 없는 글자가 있습니다 — 빼고 저장하세요" });
  });
});

describe("바뀌었나(sameAliases)", () => {
  it("순서·글자가 같으면 같음, 하나라도 다르면 다름", () => {
    expect(sameAliases(["A", "B"], ["A", "B"])).toBe(true);
    expect(sameAliases(["A", "B"], ["B", "A"])).toBe(false);
    expect(sameAliases(["A"], ["A", "B"])).toBe(false);
    expect(sameAliases(["A"], ["a"])).toBe(false);
  });
});

describe("관심 대상 줄의 별칭·알림 칸", () => {
  it("별칭은 문자열 배열일 때만 — 칸이 없거나 모양이 틀리면 null(모름 — 빈 목록으로 채우지 않음)", () => {
    expect(watchAliasesOf({ aliases: ["A", "B"] })).toEqual(["A", "B"]);
    expect(watchAliasesOf({ aliases: [] })).toEqual([]);
    expect(watchAliasesOf({ aliases: null })).toBeNull();
    expect(watchAliasesOf({})).toBeNull();
    expect(watchAliasesOf(null)).toBeNull();
    expect(watchAliasesOf({ aliases: ["A", 3, null, "B"] as unknown as string[] })).toEqual(["A", "B"]);
  });

  it("알림은 true·false일 때만, 모르면 null(끔으로 채우지 않음)", () => {
    expect(watchNotifyOf({ notify: true })).toBe(true);
    expect(watchNotifyOf({ notify: false })).toBe(false);
    expect(watchNotifyOf({ notify: null })).toBeNull();
    expect(watchNotifyOf({})).toBeNull();
  });

  it("알림 단추 — 이름은 상태와 상관없이 같고(aria-pressed가 상태), 보이는 상태 글은 켬·끔", () => {
    expect(NOTIFY_LABEL).toBe("알림");
    expect(notifyStateText(true)).toBe("켬");
    expect(notifyStateText(false)).toBe("끔");
  });

  it("4글자 미만 별칭 안내(계약 §4 규칙 5)", () => {
    expect(ALIAS_SHORT_NOTE).toContain("4글자 미만");
    expect(ALIAS_SHORT_NOTE).toContain("대상 이름은 길이와 상관없이");
  });

  it("합쳐 쓰는 안내(계약 §9-4) — 결과 검색은 대상 별칭에 더해 쓰므로 표의 별칭은 빼도 쓰인다", () => {
    expect(ALIAS_MERGE_NOTE).toContain("표에 있는 별칭은 여기서 빼도 결과 검색에 쓰입니다");
    expect(ALIAS_MERGE_NOTE).toContain("모든 사용자의 목록을 합쳐 씁니다");
  });
});

describe("알림함의 관심 대상 줄이 가는 주소(searchWatchInboxHref)", () => {
  const item = (href: unknown, kind = "SEARCH_WATCH") => ({ kind, payload: { href } });

  it("SEARCH_WATCH의 payload.href가 정보 검색 화면이면 그대로", () => {
    expect(searchWatchInboxHref(item("/search?e=us:NVDA&tab=timeline"))).toBe("/search?e=us:NVDA&tab=timeline");
    expect(searchWatchInboxHref(item("/search?e=topic%3A%ED%95%A9%EC%84%B1&tab=timeline&range=7d"))).toBe(
      "/search?e=topic%3A%ED%95%A9%EC%84%B1&tab=timeline&range=7d",
    );
    expect(searchWatchInboxHref(item("/search"))).toBe("/search");
  });

  it("다른 종류의 알림은 주소를 쓰지 않음(그대로 둠)", () => {
    expect(searchWatchInboxHref(item("/search?e=us:NVDA", "REGIME_CHANGE"))).toBeNull();
    expect(searchWatchInboxHref({ kind: "INSTITUTION_NEW" })).toBeNull();
  });

  it("payload가 없거나 href가 글이 아니면 null", () => {
    expect(searchWatchInboxHref({ kind: "SEARCH_WATCH" })).toBeNull();
    expect(searchWatchInboxHref({ kind: "SEARCH_WATCH", payload: null })).toBeNull();
    expect(searchWatchInboxHref({ kind: "SEARCH_WATCH", payload: "/search" })).toBeNull();
    expect(searchWatchInboxHref(item(42))).toBeNull();
    expect(searchWatchInboxHref(item(null))).toBeNull();
  });

  it("정보 검색 화면 밖·바깥 주소·꼼수 모양은 받지 않음", () => {
    for (const bad of [
      "https://evil.example/search",
      "//evil.example/search",
      "/\\evil.example",
      "/searchx?e=us:NVDA",
      "/search/../alerts",
      "/search/x",
      "/alerts",
      "javascript:alert(1)",
      " /search?e=us:NVDA",
      "/search?e=us:NVDA\n",
      "/search?e=a b",
      "/search\\x",
      "",
      `/search?e=${"a".repeat(3000)}`,
    ]) {
      expect(searchWatchInboxHref(item(bad))).toBeNull();
    }
  });
});
