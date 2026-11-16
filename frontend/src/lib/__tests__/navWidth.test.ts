/**
 * 넓은 화면 왼쪽 메뉴의 폭(lib/navWidth — 작업대 실행 명세 §5 '가변 폭 왼쪽 메뉴', ADR 0042 2026-11-16 사용자 결정): 펼친 폭 200~320px(기본 220 — 하한은 180에서 2026-11-16에 올림),
 * 접으면 48px 레일, 140px 아래로 끌어 놓으면 접힘, 레일을 그 너머로 끌어내면 끈 폭으로 펼침, 손잡이 키(←→ 16·Shift 64, Home·End, Enter),
 * 저장값 검사(숫자 글만, 하한·상한으로 자름).
 */
import { describe, expect, it } from "vitest";
import {
  NAV_DRAG_SLOP,
  NAV_KEY_STEP,
  NAV_KEY_STEP_LARGE,
  NAV_MOTION_HOLD_MS,
  NAV_MOTION_MS,
  NAV_RAIL_WIDTH,
  NAV_SNAP_HYSTERESIS,
  NAV_SNAP_WIDTH,
  NAV_WIDTH_DEFAULT,
  NAV_WIDTH_MAX,
  NAV_WIDTH_MIN,
  NAV_WIDTH_PRESETS,
  clampNavWidth,
  navDragLayout,
  navKeyLayout,
  navSeparatorValue,
  navShownWidth,
  navSnapThreshold,
  navWidthPreset,
  parseNavWidth,
} from "../navWidth";

const key = (name: string, extra: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; repeat?: boolean } = {}) => ({
  key: name,
  shiftKey: false,
  ...extra,
});

describe("숫자", () => {
  it("펼친 폭 200~320(기본 220), 레일 48, 접히는 문턱 140(하한보다 작음), 키 걸음 16·64, 끌기 문턱 3, 전환 150ms", () => {
    expect([NAV_WIDTH_MIN, NAV_WIDTH_MAX, NAV_WIDTH_DEFAULT, NAV_RAIL_WIDTH]).toEqual([200, 320, 220, 48]);
    expect(NAV_SNAP_WIDTH).toBe(140);
    expect(NAV_SNAP_WIDTH).toBeLessThan(NAV_WIDTH_MIN);
    expect(NAV_SNAP_WIDTH).toBeGreaterThan(NAV_RAIL_WIDTH);
    expect([NAV_KEY_STEP, NAV_KEY_STEP_LARGE, NAV_DRAG_SLOP, NAV_MOTION_MS]).toEqual([16, 64, 3, 150]);
    // 전환 클래스는 전환보다 조금 더 붙여 둠(끝나기 전에 빠져 튀지 않게)
    expect(NAV_MOTION_HOLD_MS).toBe(200);
    expect(NAV_MOTION_HOLD_MS).toBeGreaterThan(NAV_MOTION_MS);
    // 되돌림 여유 16 — 되돌아가는 문턱(124·156)도 레일보다 넓고 하한보다 좁음
    expect(NAV_SNAP_HYSTERESIS).toBe(16);
    expect(NAV_SNAP_WIDTH - NAV_SNAP_HYSTERESIS).toBeGreaterThan(NAV_RAIL_WIDTH);
    expect(NAV_SNAP_WIDTH + NAV_SNAP_HYSTERESIS).toBeLessThan(NAV_WIDTH_MIN);
  });

  // QA-611: 펼친 폭 200·창 높이 약 648 이하에서는 긴 운영 하위 메뉴가 넘쳐 메뉴에 10px 스크롤 막대가 서고(::-webkit-scrollbar 10px), 하위 칸
  // '외부 API 연결 테스트'가 '외부 API 연결 테스…'로 잘렸습니다(지금 화면 굵은 글씨 Segoe UI + 맑은 고딕에서 0.2px, 다른 글꼴에서 1.2~4.6px 모자람).
  // 206이면 잰 세 글꼴(굵은 글씨 포함) 모두 들어갑니다 — 스크롤 막대가 설 때도 잘리지 않는 폭을 하한으로.
  // 수정 전 실패: AssertionError: expected 200 to be 206(하한 200 — 저장값 '200'도 200, 좁게 200).
  it.fails("QA-611: 하한은 206 — 스크롤 막대가 서도 긴 하위 칸 이름이 잘리지 않는 폭. 저장값 '200'은 206으로 읽고 좁게도 206", () => {
    expect(NAV_WIDTH_MIN).toBe(206);
    expect(parseNavWidth("200")).toBe(206);
    expect(clampNavWidth(205)).toBe(206);
    expect(NAV_WIDTH_PRESETS.find((preset) => preset.label === "좁게")?.width).toBe(206);
    // 접는 문턱(140)·되돌림 여유(16)는 그대로 — 되돌아가는 문턱 156도 하한보다 좁음
    expect([NAV_SNAP_WIDTH, NAV_SNAP_HYSTERESIS]).toEqual([140, 16]);
    expect(NAV_SNAP_WIDTH + NAV_SNAP_HYSTERESIS).toBeLessThan(NAV_WIDTH_MIN);
  });
});

describe("clampNavWidth", () => {
  it("하한·상한 안의 정수로 자르고, 숫자가 아니면 기본 폭", () => {
    expect(clampNavWidth(250)).toBe(250);
    expect(clampNavWidth(250.6)).toBe(251);
    expect(clampNavWidth(100)).toBe(200);
    expect(clampNavWidth(-5)).toBe(200);
    // 하한은 200(처음 180 — 긴 하위 칸 이름이 잘려 올림): 예전 하한 180·199는 200으로
    expect(clampNavWidth(180)).toBe(200);
    expect(clampNavWidth(199)).toBe(200);
    expect(clampNavWidth(200)).toBe(200);
    expect(clampNavWidth(900)).toBe(320);
    expect(clampNavWidth(Number.NaN)).toBe(220);
    expect(clampNavWidth(Number.POSITIVE_INFINITY)).toBe(220);
  });
});

describe("parseNavWidth — 저장값 검사", () => {
  it("1~4자리 정수 글만 받아 하한·상한으로 자른다", () => {
    expect(parseNavWidth("260")).toBe(260);
    expect(parseNavWidth("200")).toBe(200);
    expect(parseNavWidth("320")).toBe(320);
    expect(parseNavWidth("90")).toBe(200);
    expect(parseNavWidth("9999")).toBe(320);
    expect(parseNavWidth("0")).toBe(200);
    // 하한을 올리기 전(180~199)에 저장한 값은 새 하한 200으로
    expect(parseNavWidth("180")).toBe(200);
    expect(parseNavWidth("199")).toBe(200);
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
  it("140 이상이면 끈 폭으로 펼친다(200~320으로 자름)", () => {
    expect(navDragLayout(250, 220)).toEqual({ collapsed: false, width: 250 });
    expect(navDragLayout(400, 220)).toEqual({ collapsed: false, width: 320 });
    expect(navDragLayout(160, 220)).toEqual({ collapsed: false, width: 200 });
    expect(navDragLayout(140, 220)).toEqual({ collapsed: false, width: 200 });
  });

  it("140 아래면 레일로 접고 펼친 폭은 끌기 전 값으로 둔다 — 지나며 자른 200이 아님", () => {
    expect(navDragLayout(139, 260)).toEqual({ collapsed: true, width: 260 });
    expect(navDragLayout(48, 300)).toEqual({ collapsed: true, width: 300 });
    expect(navDragLayout(-40, 220)).toEqual({ collapsed: true, width: 220 });
  });

  it("잡을 때의 접힘에서 벗어나는 첫 문턱은 140 — 펼친 채 잡으면 139에서 접고, 레일에서 잡으면 140에서 편다", () => {
    expect(navDragLayout(139, 260, { startCollapsed: false, collapsed: false })).toEqual({ collapsed: true, width: 260 });
    expect(navDragLayout(140, 260, { startCollapsed: false, collapsed: false })).toEqual({ collapsed: false, width: 200 });
    expect(navDragLayout(139, 260, { startCollapsed: true, collapsed: true })).toEqual({ collapsed: true, width: 260 });
    expect(navDragLayout(140, 260, { startCollapsed: true, collapsed: true })).toEqual({ collapsed: false, width: 200 });
  });

  it("벗어났다가 되돌아가려면 16px 더 — 펼친 채 잡아 접었으면 156부터 펴고, 레일에서 끌어내 폈으면 124 아래에서 접는다", () => {
    const foldedInDrag = { startCollapsed: false, collapsed: true };
    expect(navSnapThreshold(foldedInDrag)).toBe(156);
    expect(navDragLayout(141, 260, foldedInDrag)).toEqual({ collapsed: true, width: 260 });
    expect(navDragLayout(155, 260, foldedInDrag)).toEqual({ collapsed: true, width: 260 });
    expect(navDragLayout(156, 260, foldedInDrag)).toEqual({ collapsed: false, width: 200 });

    const openedInDrag = { startCollapsed: true, collapsed: false };
    expect(navSnapThreshold(openedInDrag)).toBe(124);
    expect(navDragLayout(139, 230, openedInDrag)).toEqual({ collapsed: false, width: 200 });
    expect(navDragLayout(124, 230, openedInDrag)).toEqual({ collapsed: false, width: 200 });
    expect(navDragLayout(123, 230, openedInDrag)).toEqual({ collapsed: true, width: 230 });

    expect(navSnapThreshold()).toBe(140);
    expect(navSnapThreshold({ startCollapsed: true, collapsed: true })).toBe(140);
  });

  it("문턱 근처의 손떨림(139·141을 번갈아)은 한 번만 접는다", () => {
    let collapsed = false;
    let flips = 0;
    for (const pointer of [141, 139, 141, 139, 141, 139, 141]) {
      const next = navDragLayout(pointer, 220, { startCollapsed: false, collapsed });
      if (next.collapsed !== collapsed) flips += 1;
      collapsed = next.collapsed;
    }
    expect(flips).toBe(1);
    expect(collapsed).toBe(true);
  });
});

describe("navKeyLayout — 손잡이 키", () => {
  const open = (width: number) => ({ collapsed: false, width });
  const shut = (width: number) => ({ collapsed: true, width });

  it("펼친 동안: ←·→ 16px, Shift와 함께 64px — 하한·상한에서 멈춘다", () => {
    expect(navKeyLayout(key("ArrowLeft"), open(220))).toEqual(open(204));
    expect(navKeyLayout(key("ArrowRight"), open(220))).toEqual(open(236));
    expect(navKeyLayout(key("ArrowLeft", { shiftKey: true }), open(220))).toEqual(open(200));
    expect(navKeyLayout(key("ArrowRight", { shiftKey: true }), open(220))).toEqual(open(284));
    expect(navKeyLayout(key("ArrowLeft"), open(200))).toEqual(open(200));
    expect(navKeyLayout(key("ArrowLeft"), open(212))).toEqual(open(200));
    expect(navKeyLayout(key("ArrowRight"), open(316))).toEqual(open(320));
  });

  it("펼친 동안: Home 최소·End 최대, Enter는 접음(펼친 폭은 기억)", () => {
    expect(navKeyLayout(key("Home"), open(260))).toEqual(open(200));
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

  it("누르고 있는 키의 반복은 접고 펴지 않는다(받기는 하되 배치 그대로) — 화살표·Home·End의 반복은 폭을 이어서 바꿈", () => {
    expect(navKeyLayout(key("Enter", { repeat: true }), open(260))).toEqual(open(260));
    expect(navKeyLayout(key("Enter", { repeat: true }), shut(260))).toEqual(shut(260));
    expect(navKeyLayout(key("ArrowRight", { repeat: true }), shut(260))).toEqual(shut(260));
    expect(navKeyLayout(key("End", { repeat: true }), shut(260))).toEqual(shut(260));
    expect(navKeyLayout(key("ArrowRight", { repeat: true }), open(220))).toEqual(open(236));
    expect(navKeyLayout(key("ArrowLeft", { repeat: true, shiftKey: true }), open(280))).toEqual(open(216));
    expect(navKeyLayout(key("Home", { repeat: true }), open(260))).toEqual(open(200));
    expect(navKeyLayout(key("ArrowUp", { repeat: true }), open(260))).toBeNull();
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
    expect(navSeparatorValue({ collapsed: true, width: 260 })).toEqual({ now: 200, text: "접힘(아이콘 레일), 펼치면 260px" });
  });
});

describe("NAV_WIDTH_PRESETS·navWidthPreset — 계정 메뉴 '왼쪽 메뉴 폭'의 단계(끌지 않는 포인터 수단)", () => {
  it("좁게 200(하한)·기본 220(기본 폭)·넓게 280 — 모두 하한·상한 안의 정수이고, 넓게는 상한(320)보다 낮다(정보 검색 칸 틀 — 1280에서 317 넘으면 모자람)", () => {
    expect(NAV_WIDTH_PRESETS.map((preset) => [preset.label, preset.width])).toEqual([
      ["좁게", 200],
      ["기본", 220],
      ["넓게", 280],
    ]);
    expect(NAV_WIDTH_PRESETS[0].width).toBe(NAV_WIDTH_MIN);
    expect(NAV_WIDTH_PRESETS[1].width).toBe(NAV_WIDTH_DEFAULT);
    for (const preset of NAV_WIDTH_PRESETS) expect(clampNavWidth(preset.width)).toBe(preset.width);
    expect(NAV_WIDTH_PRESETS[2].width).toBeLessThan(317);
  });

  it("펼친 폭과 같은 단계, 없으면 null(끌어서 정한 폭) — 잘라서 견준다(하한 아래 190은 좁게, 1000은 320이라 없음)", () => {
    expect(navWidthPreset(220)?.label).toBe("기본");
    expect(navWidthPreset(280)?.label).toBe("넓게");
    expect(navWidthPreset(200)?.label).toBe("좁게");
    expect(navWidthPreset(190)?.label).toBe("좁게");
    expect(navWidthPreset(250)).toBeNull();
    expect(navWidthPreset(1000)).toBeNull();
  });
});
