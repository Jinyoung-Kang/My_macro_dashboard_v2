/**
 * 관심 대상 목록의 차례 — 이름 글자순(사용자 요청 2026-11-22, lib/infoSearch watchItemsByName): 한글 다음 영문(대소문자 무시), 숫자는 수의 크기대로,
 * 이름이 같으면 대상 키 순. 받은 배열은 바꾸지 않습니다. 이름은 모두 합성 값.
 */
import { describe, expect, it } from "vitest";
import { watchItemsByName } from "../infoSearch";

describe("watchItemsByName", () => {
  it("한글 → 영문(대소문자 무시), 숫자는 수 크기대로, 같은 이름은 키 순 — 받은 배열은 그대로", () => {
    const items = [
      { name: "zeta fake", key: "us:ZZZ" },
      { name: "가나 테스트", key: "kr:000002" },
      { name: "Alpha Fake", key: "us:AAA" },
      { name: "가나 테스트", key: "kr:000001" },
      { name: "다라 10호", key: "topic:다라10" },
      { name: "다라 9호", key: "topic:다라9" },
      { name: "beta fake", key: "us:BBB" },
    ];
    const before = items.map((item) => item.key);
    expect(watchItemsByName(items).map((item) => item.key)).toEqual([
      "kr:000001",
      "kr:000002",
      "topic:다라9",
      "topic:다라10",
      "us:AAA",
      "us:BBB",
      "us:ZZZ",
    ]);
    expect(items.map((item) => item.key)).toEqual(before);
  });
});
