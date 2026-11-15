/**
 * 고르기 조각의 클래스(components/ui/classes.ts — 기간 고르기·세그먼트·밑줄 탭·거르기 칩, 명세 docs/specs/2026-10-31-v2-coinbase-ui.md §4·D9,
 * 작업대 화면 언어 실행 명세 docs/specs/2026-11-15-v2-workbench-ui.md §3-7·§3-8 — 4px 모서리, lg 이상 30px).
 *  - 고른 것은 색만이 아니라 굵기로도 다르고, 고대비(forced-colors)에서는 고른 칸에만 테두리가 생긴다(바탕색·ring 그림자는 그 모드에서 지워짐)
 *  - 데이터 영역의 고르기(기간 알약·세그먼트)는 강조 파랑을 쓰지 않는다(원칙 A1), 탐색(밑줄 탭)의 지금 탭만 강조 파랑 밑줄
 *  - 좁은 화면에서 누르는 자리는 44px, 포커스는 2px 바깥선
 */
import { describe, expect, it } from "vitest";

import {
  filterChipClasses,
  FOCUS_RING,
  pillTabClasses,
  SEGMENT_TRACK,
  segmentClasses,
  SELECTED_BAR,
  underlineTabClasses,
} from "@/components/ui/classes";

const tokens = (classes: string) => classes.split(/\s+/);

describe("기간 알약 pillTabClasses", () => {
  it("고른 칸은 중립 바탕·굵은 글·고대비 테두리, 나머지는 보조 글 — 강조 파랑 없음", () => {
    const active = tokens(pillTabClasses(true));
    const idle = tokens(pillTabClasses(false));
    expect(active).toEqual(expect.arrayContaining(["rounded-control", "bg-surface-2", "text-text", "font-semibold", "forced-colors:border"]));
    expect(idle).toEqual(expect.arrayContaining(["rounded-control", "text-text-2", "font-medium"]));
    expect(idle).not.toContain("forced-colors:border");
    expect(idle).not.toContain("bg-surface-2");
    for (const classes of [active, idle]) {
      expect(classes.some((name) => name.includes("accent"))).toBe(false);
      expect(classes).toEqual(expect.arrayContaining(["min-h-11", "lg:min-h-[30px]", "tabular-nums", ...tokens(FOCUS_RING)]));
    }
  });
});

describe("세그먼트 segmentClasses", () => {
  it("트랙은 4px·1px 경계의 어두운 바탕, 고른 칸은 뜬 칩(surface-2·1px 링)과 굵은 글·고대비 테두리, 포커스 링은 감싼 라벨에", () => {
    expect(tokens(SEGMENT_TRACK)).toEqual(expect.arrayContaining(["rounded-control", "border", "bg-bg"]));
    const checked = tokens(segmentClasses(true));
    const idle = tokens(segmentClasses(false));
    expect(checked).toEqual(expect.arrayContaining(["bg-surface-2", "font-semibold", "ring-1", "forced-colors:border"]));
    // 칸 24px + 트랙 안쪽 여백 2px×2 + 경계 1px×2 = 30px(lg 이상), lg 미만 44px.
    expect(checked).toEqual(expect.arrayContaining(["min-h-11", "lg:min-h-6"]));
    expect(idle).not.toContain("forced-colors:border");
    expect(idle).not.toContain("font-semibold");
    for (const classes of [checked, idle]) {
      expect(classes).toContain("has-[:focus-visible]:outline-2");
      expect(classes.some((name) => name.includes("accent"))).toBe(false);
    }
  });
});

describe("거르기 칩 filterChipClasses", () => {
  it("켠 칩은 강조 파랑 테두리·틴트(누를 수 있는 것) + 굵은 본문색 글, 끈 칩은 중립 — 두 상태 모두 테두리(고대비에서 경계가 남음), 44px·포커스 링", () => {
    const on = tokens(filterChipClasses(true));
    const off = tokens(filterChipClasses(false));
    // 켠 칩 글자는 본문색 — accent 틴트 위 accent 글자는 4.47:1(QA-459).
    expect(on).toEqual(expect.arrayContaining(["rounded-control", "border", "border-accent", "bg-accent-tint", "text-text", "font-semibold"]));
    expect(on).not.toContain("text-accent");
    expect(off).toEqual(expect.arrayContaining(["rounded-control", "border", "border-border", "text-text-2", "font-medium"]));
    expect(off.some((name) => name.includes("accent"))).toBe(false);
    for (const classes of [on, off]) {
      expect(classes).toEqual(expect.arrayContaining(["min-h-11", "lg:min-h-[30px]", ...tokens(FOCUS_RING)]));
    }
  });
});

describe("밑줄 탭 underlineTabClasses", () => {
  it("지금 탭은 강조 파랑 2px 밑줄과 굵은 글, 나머지는 투명 밑줄 — sm은 한 단계 작게(lg 이상 40px·30px)", () => {
    const active = tokens(underlineTabClasses(true));
    const idle = tokens(underlineTabClasses(false));
    expect(active).toEqual(expect.arrayContaining(["border-b-2", "border-accent", "font-semibold", "text-text", "min-h-12", "text-[15px]", "lg:min-h-10", "lg:text-sm"]));
    expect(idle).toEqual(expect.arrayContaining(["border-b-2", "border-transparent", "text-text-2"]));
    expect(idle).not.toContain("font-semibold");
    expect(tokens(underlineTabClasses(true, "sm"))).toEqual(expect.arrayContaining(["min-h-11", "text-sm", "lg:min-h-[30px]"]));
    expect(active).toContain("whitespace-nowrap");
  });

  it("고대비(forced-colors)에서는 나머지 탭의 투명 밑줄을 지운다 — 그 모드는 투명 테두리를 글자색으로 칠해 모든 탭에 밑줄이 생김", () => {
    expect(tokens(underlineTabClasses(false))).toContain("forced-colors:border-b-0");
    expect(tokens(underlineTabClasses(true))).not.toContain("forced-colors:border-b-0");
  });
});

describe("고른 행 막대 SELECTED_BAR", () => {
  it("잉크 3px 막대(강조 파랑 아님) — 고대비에서는 바탕색이 지워지므로 같은 폭의 왼쪽 테두리로", () => {
    const bar = tokens(SELECTED_BAR);
    expect(bar).toEqual(expect.arrayContaining(["absolute", "w-[3px]", "bg-text", "forced-colors:border-l-[3px]"]));
    expect(bar.some((name) => name.includes("accent"))).toBe(false);
  });
});
