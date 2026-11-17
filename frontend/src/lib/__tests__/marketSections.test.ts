/**
 * 매크로 절 주소의 정본(lib/marketSections) — 다른 화면이 매크로 절로 잇는 링크의 기준.
 *  - id는 서로 다르고 소문자·하이픈만, 'macro-'로 시작한다(주소 조각 그대로 — 인코딩 없음)
 *  - 다른 화면이 잇는 주소는 절 조각 없는 화면 경로(QA-641) — 경로는 lib/nav TABS에서 찾는다
 */
import { describe, expect, it } from "vitest";

import { macroIndexItems } from "../macroScreen";
import { MACRO_SECTION_LABELS, MACRO_SECTIONS, macroPath } from "../marketSections";
import { TABS } from "../nav";

describe("MACRO_SECTIONS", () => {
  it("id는 서로 다르고 소문자·하이픈만, 'macro-'로 시작한다", () => {
    const ids = Object.values(MACRO_SECTIONS);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z-]+$/);
      expect(id.startsWith("macro-")).toBe(true);
    }
  });

  it("절은 여덟 — 지표·환율 비교·금리차·위험·심화·단독 차트·비공식 시세·경제 캘린더", () => {
    expect(Object.keys(MACRO_SECTIONS)).toEqual(["indicators", "fx", "spreads", "risk", "advanced", "single", "scraped", "calendar"]);
  });
});

describe("MACRO_SECTION_LABELS", () => {
  it("절마다 이름 하나 — 매크로 목차 칸 이름이 이 이름이다(다른 화면 링크 글이 같은 이름으로 절을 가리킴)", () => {
    expect(Object.keys(MACRO_SECTION_LABELS)).toEqual(Object.keys(MACRO_SECTIONS));
    const items = macroIndexItems(null, true);
    expect(items.map((item) => [item.id, item.label])).toEqual(
      (Object.keys(MACRO_SECTIONS) as (keyof typeof MACRO_SECTIONS)[]).map((section) => [MACRO_SECTIONS[section], MACRO_SECTION_LABELS[section]]),
    );
  });
});

describe("macroPath", () => {
  it("절 조각 없는 매크로 화면 경로 — 메뉴 표(시장 탭 '매크로 지표')의 경로, 다른 화면이 매크로로 잇는 링크(QA-641)", () => {
    const macro = TABS.find((tab) => tab.key === "markets")?.items.find((item) => item.label === "매크로 지표");
    expect(macro?.href).toBe("/macro");
    expect(macroPath()).toBe("/macro");
  });
});
