/**
 * 공용 조작 조각의 좁은 화면 누르는 자리 44px(원칙 A8, 작업대 화면 언어 실행 명세 docs/specs/2026-11-15-v2-workbench-ui.md §9-3) — QA-458.
 *
 * components/ui/classes.ts와 정보 검색 조각(components/screens/search/parts.tsx)이 내보내는 것을 모두 '누르는 조각'과 '아닌 것'으로 나눠 둡니다.
 * 새로 내보낸 이름이 어느 쪽에도 없으면 실패합니다 — 새 조각을 만들 때 이 표에 넣으며 44px을 따지게 합니다. 누르는 조각은 받을 수 있는 인자를
 * 모두 넣어 본 클래스가 lg 미만 44px(`min-h-11`·`h-11`·`size-11` 등, lg: 이상 변형은 더 작아도 됨)을 갖는지 봅니다(touchTargetAudit).
 * 화면에서 그린 DOM의 누름 자리는 app/(dashboard)/__tests__/touchTargetsQa458.test.tsx가 봅니다(정보 수집·수급 레이더 몫은 P7에서 화면별 파일로 나눔 —
 * components/screens/info/__tests__/infoTouchTargetsQa458.test.tsx, app/(dashboard)/__tests__/radarTouchTargetsQa458.test.tsx).
 */
import { describe, expect, it } from "vitest";

import * as uiClasses from "@/components/ui/classes";
import * as searchParts from "@/components/screens/search/parts";
import { belowLgTarget, smallTargets } from "./touchTargetAudit";

const {
  buttonClasses,
  filterChipClasses,
  inputClasses,
  LINK_CLASSES,
  pillTabClasses,
  ROW_TRIGGER,
  segmentClasses,
  TEXT_TARGET,
  TEXT_TARGET_SHORT,
  toggleClasses,
  underlineTabClasses,
} = uiClasses;
const { BUTTON, BUTTON_PRIMARY, LINK, segmentClass, toggleClass } = searchParts;

const BOTH = [true, false] as const;

/** 누르는 조각 — 이름 → 받을 수 있는 인자를 모두 넣은 클래스 문자열(이름표 붙임). */
const UI_CONTROLS: Record<string, () => [string, string][]> = {
  buttonClasses: () =>
    (["default", "primary", "danger", "minimal", "secondary", "ghost"] as const).flatMap((variant) =>
      (["md", "sm", "lg"] as const).map((size): [string, string] => [`${variant}/${size}`, buttonClasses(variant, size)])),
  inputClasses: () => (["md", "sm", "lg"] as const).map((size): [string, string] => [size, inputClasses(size)]),
  pillTabClasses: () => BOTH.map((active): [string, string] => [String(active), pillTabClasses(active)]),
  segmentClasses: () => BOTH.map((checked): [string, string] => [String(checked), segmentClasses(checked)]),
  filterChipClasses: () => BOTH.map((pressed): [string, string] => [String(pressed), filterChipClasses(pressed)]),
  TEXT_TARGET: () => [["", TEXT_TARGET]],
  TEXT_TARGET_SHORT: () => [["", TEXT_TARGET_SHORT]],
  underlineTabClasses: () =>
    BOTH.flatMap((active) =>
      (["md", "sm"] as const).flatMap((size) =>
        BOTH.map((wrap): [string, string] => [`${active}/${size}/${wrap ? "wrap" : "row"}`, underlineTabClasses(active, size, wrap)]))),
  toggleClasses: () =>
    BOTH.flatMap((pressed) => BOTH.map((compact): [string, string] => [`${pressed}/${compact}`, toggleClasses(pressed, compact)])),
  LINK_CLASSES: () => [["", LINK_CLASSES]],
  ROW_TRIGGER: () => [["", ROW_TRIGGER]],
};

/** 누르는 조각이 아닌 것 — 까닭. */
const UI_OTHERS: Record<string, string> = {
  PANEL_CLASSES: "면(패널) 테두리 — 누르지 않음",
  ENTITY_FRAME: "대상 화면 칸 틀(격자) — 누르지 않음",
  ENTITY_FRAME_LEFT: "대상 화면 칸 틀의 왼쪽 칸 — 누르지 않음",
  FOCUS_RING: "포커스 링 조각 — 혼자 쓰지 않고 누르는 조각에 붙음",
  SEGMENT_TRACK: "세그먼트의 트랙(바탕) — 누르는 칸은 segmentClasses",
  SELECTED_BAR: "고른 행의 장식 막대 — 누르는 자리는 감싼 행",
  SKELETON_BAR: "읽는 중 자리표시 막대(장식) — 누르지 않음",
};

const SEARCH_CONTROLS: Record<string, () => [string, string][]> = {
  BUTTON: () => [["", BUTTON]],
  BUTTON_PRIMARY: () => [["", BUTTON_PRIMARY]],
  LINK: () => [["", LINK]],
  segmentClass: () => BOTH.map((active): [string, string] => [String(active), segmentClass(active)]),
  toggleClass: () =>
    BOTH.flatMap((pressed) => BOTH.map((compact): [string, string] => [`${pressed}/${compact}`, toggleClass(pressed, compact)])),
};

const SEARCH_OTHERS: Record<string, string> = {
  PANEL: "면(패널) 테두리 — 누르지 않음",
  PaneHeading: "구획 제목",
  KindIcon: "장식 아이콘",
  KindBadge: "종류 표지(글)",
  ItemKindTag: "결과 줄의 종류 표지(글)",
  Tag: "별칭·식별자 꼬리표(글)",
  SourceStatusLine: "출처 상태 줄(글)",
};

const MODULES = [
  { name: "components/ui/classes", module: uiClasses as Record<string, unknown>, controls: UI_CONTROLS, others: UI_OTHERS },
  { name: "components/screens/search/parts", module: searchParts as Record<string, unknown>, controls: SEARCH_CONTROLS, others: SEARCH_OTHERS },
];

describe("공용 조작 조각의 좁은 화면 누르는 자리(QA-458)", () => {
  it("내보낸 이름은 모두 '누르는 조각'과 '아닌 것' 가운데 한쪽에 있다 — 새 조각은 여기서 44px을 따진다", () => {
    for (const { name, module, controls, others } of MODULES) {
      expect(Object.keys(module).sort(), name).toEqual([...Object.keys(controls), ...Object.keys(others)].sort());
    }
  });

  // 수정 전에는 세그먼트 칸(segmentClasses)이 높이를 부르는 쪽에 맡겨 클래스에 44px이 없었다(재현 커밋에서는 it.fails — 부르는 네 곳은
  // 저마다 붙였지만 새 화면이 빠뜨릴 수 있음). 지금은 segmentClasses가 min-h-11 lg:min-h-8을 갖는다.
  it("누르는 조각은 받을 수 있는 모든 인자에서 lg 미만 44px — lg 이상 변형만 더 작다", () => {
    const offenders = MODULES.flatMap(({ name, controls }) =>
      Object.entries(controls).flatMap(([control, variants]) =>
        variants().flatMap(([label, classes]) => {
          const reason = belowLgTarget(classes);
          return reason === null ? [] : [`${name}.${control}${label ? `(${label})` : ""} — ${reason}`];
        })));
    expect(offenders).toEqual([]);
  });

  it("검사기 자체 — 변형 없는 44px 이상만 인정하고, lg 이상 변형은 작아도 되며, sm·md 변형이 낮추면 잡는다", () => {
    expect(belowLgTarget("inline-flex min-h-11 items-center lg:min-h-8")).toBeNull();
    expect(belowLgTarget("h-11 lg:h-8")).toBeNull();
    expect(belowLgTarget("size-11 xl:size-8")).toBeNull();
    expect(belowLgTarget("min-h-[44px] has-[:focus-visible]:outline-2")).toBeNull();
    expect(belowLgTarget("min-h-16 hover:bg-surface-2")).toBeNull();
    expect(belowLgTarget("!min-h-12")).toBeNull();
    expect(belowLgTarget("min-h-9 px-3")).toContain("없음");
    expect(belowLgTarget("text-accent hover:underline")).toContain("없음");
    expect(belowLgTarget("lg:min-h-11")).toContain("없음");
    expect(belowLgTarget("min-h-11 sm:min-h-8")).toContain("sm:min-h-8");
    expect(belowLgTarget("min-h-11 md:h-9")).toContain("md:h-9");
    // 음수 아래 여백은 다음 줄이 덮어 누르는 자리가 그만큼 줄어듭니다(줄을 바꾸는 탭 줄 — 2026-11-16 결정 1 검토 지적: 첫 줄 탭 실효 43px).
    expect(belowLgTarget("min-h-11 -mb-px lg:min-h-[30px]")).toContain("-mb-px을 빼면 43px");
    expect(belowLgTarget("min-h-[45px] -mb-px lg:min-h-[31px]")).toBeNull();
    expect(belowLgTarget("min-h-12 -my-px")).toBeNull();
    expect(belowLgTarget("min-h-[45px] -mb-0.5")).toContain("43px");
    // 위 여백(뒤에 오는 이 요소가 앞 줄을 덮음)과 lg 이상 변형은 빼지 않습니다.
    expect(belowLgTarget("min-h-11 -mt-px")).toBeNull();
    expect(belowLgTarget("min-h-11 lg:-mb-px")).toBeNull();
  });

  it("DOM 검사기 자체 — 문장 안 링크·보이지 않는 요소는 빼고, 번호·머리말만 붙은 링크는 세고, 체크 상자는 감싼 label로 따진다", () => {
    const root = document.createElement("div");
    root.innerHTML = [
      "<p>설명 글 <a href='/x' class='text-accent'>안의 링크</a>는 뺀다.</p>",
      "<p><a href='/y' class='text-accent'>따로 선 링크</a></p>",
      "<a href='/z' class='inline-flex min-h-11 items-center lg:min-h-0'>44px 링크</a>",
      "<button type='button' class='text-accent'>번역</button>",
      "<label class='inline-flex min-h-11 items-center lg:min-h-0'><input type='checkbox'> 예</label>",
      "<label class='flex items-center'><input type='checkbox' aria-label='작은 상자'> 아니오</label>",
      "<label class='min-h-11'><input type='radio' class='sr-only'>고르기</label>",
      "<details><summary class='cursor-pointer text-xs'>더 보기</summary></details>",
      "<a class='text-accent'>주소 없는 a</a>",
      "<ol><li>[1] <a href='/s' class='text-text'>근거 출처 이름</a></li></ol>",
      "<p>출처: <a href='/t' class='text-accent'>합성 출처 사이트</a></p>",
      "<p>자세한 뜻은 <a href='/v' class='text-accent'>용어 풀이<span class='sr-only'> (새 창)</span></a>에 있습니다.</p>",
    ].join("");
    expect(smallTargets(root)).toEqual([
      "a「따로 선 링크」 — lg 미만 44px 높이 클래스(min-h-11 등) 없음",
      "button「번역」 — lg 미만 44px 높이 클래스(min-h-11 등) 없음",
      "input[checkbox]「작은 상자」 — lg 미만 44px 높이 클래스(min-h-11 등) 없음",
      "summary「더 보기」 — lg 미만 44px 높이 클래스(min-h-11 등) 없음",
      "a「근거 출처 이름」 — lg 미만 44px 높이 클래스(min-h-11 등) 없음",
      "a「합성 출처 사이트」 — lg 미만 44px 높이 클래스(min-h-11 등) 없음",
    ]);
  });

  // 짧은 글 단추(P7 — '번역'·'원문'·'읽음' 등 3글자 안팎): TEXT_TARGET은 높이만 44px이라 두 글자 단추의 폭은 글 폭뿐입니다(D2 QA에서 '접기' 28px). 짧은 글 단추용
  // 클래스는 좁은 화면에서 높이와 폭 모두 44px(글은 가운데 — 포커스 링이 글 양쪽으로 고르게), 넓은 화면은 높이·폭 모두 글 크기로 돌아갑니다.
  it("짧은 글 단추(TEXT_TARGET_SHORT)는 lg 미만 높이·폭 44px, lg 이상은 글 크기 — 기존 TEXT_TARGET은 그대로", () => {
    const words = TEXT_TARGET_SHORT.split(/\s+/);
    expect(words).toEqual(expect.arrayContaining(["inline-flex", "min-h-11", "min-w-11", "items-center", "justify-center", "lg:min-h-0", "lg:min-w-0"]));
    expect(belowLgTarget(TEXT_TARGET_SHORT)).toBeNull();
    expect(TEXT_TARGET).toBe("inline-flex min-h-11 items-center lg:min-h-0");
  });
});
