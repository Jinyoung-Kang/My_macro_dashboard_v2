/**
 * 넓은 화면 왼쪽 메뉴의 폭(lib/navWidth — 작업대 실행 명세 §5 '가변 폭 왼쪽 메뉴', ADR 0042 2026-11-16 사용자 결정): 펼친 폭 180~320px(기본 220),
 * 접으면 48px 레일, 140px 아래로 끌어 놓으면 접힘, 레일을 그 너머로 끌어내면 끈 폭으로 펼침, 손잡이 키(←→ 16·Shift 64, Home·End, Enter),
 * 저장값 검사(숫자 글만, 하한·상한으로 자름).
 */
import { describe, expect, it } from "vitest";
import {
  NAV_DRAG_SLOP,
  NAV_KEY_STEP,
  NAV_KEY_STEP_LARGE,
  NAV_MOTION_MS,
  NAV_RAIL_WIDTH,
  NAV_SNAP_WIDTH,
  NAV_WIDTH_DEFAULT,
  NAV_WIDTH_MAX,
  NAV_WIDTH_MIN,
  clampNavWidth,
  navDragLayout,
  navKeyLayout,
  navSeparatorValue,
  navShownWidth,
  parseNavWidth,
} from "../navWidth";

const key = (name: string, extra: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => ({
  key: name,
  shiftKey: false,
  ...extra,
});

describe("숫자", () => {
  it("펼친 폭 180~320(기본 220), 레일 48, 접히는 문턱 140(하한보다 작음), 키 걸음 16·64, 끌기 문턱 3, 전환 150ms", () => {
    expect([NAV_WIDTH_MIN, NAV_WIDTH_MAX, NAV_WIDTH_DEFAULT, NAV_RAIL_WIDTH]).toEqual([180, 320, 220, 48]);
    expect(NAV_SNAP_WIDTH).toBe(140);
    expect(NAV_SNAP_WIDTH).toBeLessThan(NAV_WIDTH_MIN);
    expect(NAV_SNAP_WIDTH).toBeGreaterThan(NAV_RAIL_WIDTH);
    expect([NAV_KEY_STEP, NAV_KEY_STEP_LARGE, NAV_DRAG_SLOP, NAV_MOTION_MS]).toEqual([16, 64, 3, 150]);
  });
});

describe("clampNavWidth", () => {
  it("하한·상한 안의 정수로 자르고, 숫자가 아니면 기본 폭", () => {
    expect(clampNavWidth(250)).toBe(250);
    expect(clampNavWidth(250.6)).toBe(251);
    expect(clampNavWidth(100)).toBe(180);
    expect(clampNavWidth(-5)).toBe(180);
    expect(clampNavWidth(900)).toBe(320);
    expect(clampNavWidth(Number.NaN)).toBe(220);
    expect(clampNavWidth(Number.POSITIVE_INFINITY)).toBe(220);
  });
});

describe("parseNavWidth — 저장값 검사", () => {
  it("1~4자리 정수 글만 받아 하한·상한으로 자른다", () => {
    expect(parseNavWidth("260")).toBe(260);
    expect(parseNavWidth("180")).toBe(180);
    expect(parseNavWidth("320")).toBe(320);
    expect(parseNavWidth("90")).toBe(180);
    expect(parseNavWidth("9999")).toBe(320);
    expect(parseNavWidth("0")).toBe(180);
  });

  it("없거나 다른 꼴이면 기본 폭(220)", () => {
    for (const raw of [null, undefined, "", " 260", "260 ", "-5", "1e3", "260px", "26.5", "abc", "12345", "NaN", "Infinity"]) {
      expect(parseNavWidth(raw)).toBe(220);
    }
  });
});

describe("navShownWidth — 셸 변수 --shell-nav-w의 값", () => {
  it("접혔으면 레일 48, 아니면 펼친 폭(잘라서)", () => {
    expect(navShownWidth({ collapsed: true, width: 300 })).toBe(48);
    expect(navShownWidth({ collapsed: false, width: 300 })).toBe(300);
    expect(navShownWidth({ collapsed: false, width: 1000 })).toBe(320);
  });
});

describe("navDragLayout — 끄는 동안", () => {
  it("140 이상이면 끈 폭으로 펼친다(180~320으로 자름)", () => {
    expect(navDragLayout(250, 220)).toEqual({ collapsed: false, width: 250 });
    expect(navDragLayout(400, 220)).toEqual({ collapsed: false, width: 320 });
    expect(navDragLayout(160, 220)).toEqual({ collapsed: false, width: 180 });
    expect(navDragLayout(140, 220)).toEqual({ collapsed: false, width: 180 });
  });

  it("140 아래면 레일로 접고 펼친 폭은 끌기 전 값으로 둔다 — 지나며 자른 180이 아님", () => {
    expect(navDragLayout(139, 260)).toEqual({ collapsed: true, width: 260 });
    expect(navDragLayout(48, 300)).toEqual({ collapsed: true, width: 300 });
    expect(navDragLayout(-40, 220)).toEqual({ collapsed: true, width: 220 });
  });
});

describe("navKeyLayout — 손잡이 키", () => {
  const open = (width: number) => ({ collapsed: false, width });
  const shut = (width: number) => ({ collapsed: true, width });

  it("펼친 동안: ←·→ 16px, Shift와 함께 64px — 하한·상한에서 멈춘다", () => {
    expect(navKeyLayout(key("ArrowLeft"), open(220))).toEqual(open(204));
    expect(navKeyLayout(key("ArrowRight"), open(220))).toEqual(open(236));
    expect(navKeyLayout(key("ArrowLeft", { shiftKey: true }), open(220))).toEqual(open(180));
    expect(navKeyLayout(key("ArrowRight", { shiftKey: true }), open(220))).toEqual(open(284));
    expect(navKeyLayout(key("ArrowLeft"), open(180))).toEqual(open(180));
    expect(navKeyLayout(key("ArrowRight"), open(316))).toEqual(open(320));
  });

  it("펼친 동안: Home 최소·End 최대, Enter는 접음(펼친 폭은 기억)", () => {
    expect(navKeyLayout(key("Home"), open(260))).toEqual(open(180));
    expect(navKeyLayout(key("End"), open(260))).toEqual(open(320));
    expect(navKeyLayout(key("Enter"), open(260))).toEqual(shut(260));
  });

  it("접힌 동안: →·Enter는 기억한 폭으로, End는 최대 폭으로 펴고, ←·Home은 그대로(받기는 함)", () => {
    expect(navKeyLayout(key("ArrowRight"), shut(260))).toEqual(open(260));
    expect(navKeyLayout(key("Enter"), shut(260))).toEqual(open(260));
    expect(navKeyLayout(key("End"), shut(260))).toEqual(open(320));
    expect(navKeyLayout(key("ArrowLeft"), shut(260))).toEqual(shut(260));
    expect(navKeyLayout(key("Home"), shut(260))).toEqual(shut(260));
  });

  it("받지 않는 키는 null — 위·아래 화살표, 글자, Ctrl·⌘·Alt와 함께 누른 키", () => {
    for (const name of ["ArrowUp", "ArrowDown", "[", " ", "Tab", "Escape"]) {
      expect(navKeyLayout(key(name), open(220))).toBeNull();
      expect(navKeyLayout(key(name), shut(220))).toBeNull();
    }
    expect(navKeyLayout(key("ArrowLeft", { ctrlKey: true }), open(220))).toBeNull();
    expect(navKeyLayout(key("ArrowRight", { metaKey: true }), open(220))).toBeNull();
    expect(navKeyLayout(key("Enter", { altKey: true }), open(220))).toBeNull();
  });
});

describe("navSeparatorValue — 손잡이의 aria-valuenow·aria-valuetext", () => {
  it("펼쳤으면 그 폭과 'Npx', 접혔으면 하한(가장 왼쪽 자리)과 접힘·펼 때의 폭", () => {
    expect(navSeparatorValue({ collapsed: false, width: 260 })).toEqual({ now: 260, text: "260px" });
    expect(navSeparatorValue({ collapsed: true, width: 260 })).toEqual({ now: 180, text: "접힘(아이콘 레일), 펼치면 260px" });
  });
});
