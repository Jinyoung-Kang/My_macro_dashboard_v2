/**
 * 더보기 메뉴의 차례(사용자 요청 2026-11-22) — 묶음 없는 화면·'한국 시장'·'정보 수집' 묶음마다 이름 글자순(한국어 정렬: 한글 다음 영문).
 * 묶음 차례(묶음 없는 화면 → 한국 시장 → 정보 수집)는 그대로입니다. 나무 메뉴·더보기 화면·하위 메뉴 줄·통합 검색이 이 차례를 그대로 씁니다.
 */
import { describe, expect, it } from "vitest";
import { INFO_GROUP, KR_MARKET_GROUP, TABS } from "../nav";

const more = TABS.find((tab) => tab.key === "more");
const order = new Intl.Collator("ko");

describe("더보기 메뉴 차례", () => {
  it("묶음마다 이름 글자순", () => {
    const items = more?.items ?? [];
    for (const group of [undefined, KR_MARKET_GROUP, INFO_GROUP]) {
      const labels = items.filter((item) => item.group === group).map((item) => item.label);
      expect(labels.length, String(group)).toBeGreaterThan(0);
      expect(labels, String(group)).toEqual([...labels].sort(order.compare));
    }
  });

  it("묶음 차례는 묶음 없는 화면 → 한국 시장 → 정보 수집", () => {
    const groups: (string | undefined)[] = [];
    for (const item of more?.items ?? []) {
      if (!groups.includes(item.group)) groups.push(item.group);
    }
    expect(groups).toEqual([undefined, KR_MARKET_GROUP, INFO_GROUP]);
  });
});
