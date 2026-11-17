/**
 * 긴 화면 목차의 순수 규칙(lib/sectionIndex) — 고르는 차례(하위 칸이 부모보다 앞), 지금 절 판정(띠에 걸친 것 가운데 차례가 가장 앞, 없으면 앞 값),
 * 하위 칸의 부모, 개수 글(숫자일 때만).
 */
import { describe, expect, it } from "vitest";

import { pickActiveSection, pickEndSection, scrolledToEnd, sectionCountText, sectionOrder, sectionParent, type SectionIndexItem } from "../sectionIndex";

const ITEMS: SectionIndexItem[] = [
  { id: "top", label: "맨 위" },
  { id: "ind", label: "지표", children: [{ id: "cat-a", label: "A" }, { id: "cat-b", label: "B" }] },
  { id: "fx", label: "환율 비교" },
];

describe("sectionOrder", () => {
  it("첫 단계 칸마다 하위 칸(문서 차례)을 먼저, 그다음 그 칸 — 형제 사이는 문서 차례", () => {
    expect(sectionOrder(ITEMS)).toEqual(["top", "cat-a", "cat-b", "ind", "fx"]);
  });

  it("같은 id는 처음 것만, 빈 목록은 빈 차례", () => {
    expect(sectionOrder([{ id: "a", label: "가" }, { id: "a", label: "가" }])).toEqual(["a"]);
    expect(sectionOrder([])).toEqual([]);
  });
});

describe("pickActiveSection", () => {
  const order = sectionOrder(ITEMS);

  it("띠에 걸친 것 가운데 차례가 가장 앞 — 하위 칸이 걸치면 하위 칸, 부모 머리만 걸치면 부모", () => {
    expect(pickActiveSection(order, new Set(["ind", "cat-b"]), null)).toBe("cat-b");
    expect(pickActiveSection(order, new Set(["ind"]), "top")).toBe("ind");
    // 앞 절의 끝과 다음 절의 처음이 함께 걸치면 위쪽(문서 차례가 앞)
    expect(pickActiveSection(order, new Set(["top", "ind", "cat-a"]), null)).toBe("top");
    expect(pickActiveSection(order, new Set(["ind", "cat-b", "fx"]), null)).toBe("cat-b");
  });

  it("걸친 것이 없으면 앞 값 그대로, 앞 값이 차례에 없으면 null", () => {
    expect(pickActiveSection(order, new Set(), "fx")).toBe("fx");
    expect(pickActiveSection(order, new Set(), null)).toBeNull();
    expect(pickActiveSection(order, new Set(), "gone")).toBeNull();
    // 차례에 없는 id만 걸치면 걸친 것이 없는 것과 같음
    expect(pickActiveSection(order, new Set(["other"]), "ind")).toBe("ind");
  });
});

describe("sectionParent", () => {
  it("하위 칸이면 첫 단계 부모, 첫 단계·모르는 id·null이면 null", () => {
    expect(sectionParent(ITEMS, "cat-b")).toBe("ind");
    expect(sectionParent(ITEMS, "ind")).toBeNull();
    expect(sectionParent(ITEMS, "gone")).toBeNull();
    expect(sectionParent(ITEMS, null)).toBeNull();
  });
});

describe("sectionCountText", () => {
  it("유한한 숫자만 글(천 단위 쉼표, 0 포함) — null·undefined·NaN·무한은 null", () => {
    expect(sectionCountText(1234)).toBe("1,234");
    expect(sectionCountText(0)).toBe("0");
    expect(sectionCountText(null)).toBeNull();
    expect(sectionCountText(undefined)).toBeNull();
    expect(sectionCountText(Number.NaN)).toBeNull();
    expect(sectionCountText(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("끝까지 내려갔을 때의 지금 절(QA-645)", () => {
  it("scrolledToEnd — 넘침이 있고 남은 거리 1px 이하, 넘침이 없으면 거짓", () => {
    expect(scrolledToEnd({ scrollTop: 9832, scrollHeight: 10676, clientHeight: 844 })).toBe(true);
    expect(scrolledToEnd({ scrollTop: 9831.4, scrollHeight: 10676, clientHeight: 844 })).toBe(true);
    expect(scrolledToEnd({ scrollTop: 9800, scrollHeight: 10676, clientHeight: 844 })).toBe(false);
    expect(scrolledToEnd({ scrollTop: 0, scrollHeight: 600, clientHeight: 844 })).toBe(false);
  });

  it("pickEndSection — 위 끝이 뷰포트 아래 끝보다 위인 절 가운데 위 끝이 가장 아래인 것, 없으면 null", () => {
    const tops = [
      { id: "ind", top: -9000 },
      { id: "cat-a", top: -8900 },
      { id: "fx", top: -300 },
      { id: "calendar", top: 543 },
    ];
    expect(pickEndSection(tops, 844)).toBe("calendar");
    expect(pickEndSection(tops, 500)).toBe("fx");
    expect(pickEndSection([{ id: "x", top: 900 }, { id: "y", top: Number.POSITIVE_INFINITY }], 844)).toBeNull();
  });
});
