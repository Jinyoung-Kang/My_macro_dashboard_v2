/**
 * 고르기 조각의 클래스(components/ui/classes.ts — 기간 고르기·세그먼트·밑줄 탭·거르기 칩, 명세 docs/specs/2026-10-31-v2-coinbase-ui.md §4·D9,
 * 작업대 화면 언어 실행 명세 docs/specs/2026-11-15-v2-workbench-ui.md §3-7·§3-8 — 4px 모서리, lg 이상 30px).
 *  - 고른 것은 색만이 아니라 굵기로도 다르고, 고대비(forced-colors)에서는 고른 칸에만 테두리가 생긴다(바탕색·ring 그림자는 그 모드에서 지워짐)
 *  - 데이터 영역의 고르기(기간 알약·세그먼트)는 강조 파랑을 쓰지 않는다(원칙 A1), 탐색(밑줄 탭)의 지금 탭만 강조 파랑 밑줄
 *  - 좁은 화면에서 누르는 자리는 44px, 포커스는 2px 바깥선
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  // QA-464: 정보 검색 피드의 기간 고르기(FeedPanel — 단추 안에 '{이름} '과 건수 span)가 이 조각을 쓰게 되면서 옛 정보 검색 조각의
  // gap-1.5·whitespace-nowrap이 빠졌습니다. inline-flex 안에서는 이름 끝 빈칸이 줄 끝 빈칸으로 접혀 '30일148건'처럼 붙어 보이고, 좁은 칸에서는
  // 단추 글이 접힐 수 있습니다(낭독 이름은 DOM 글이라 '30일 148건' 그대로 — 겉모양만의 문제). 재현 커밋에서는 it.fails였습니다.
  it("칸 안의 글 조각 사이를 띄우고(gap-1.5) 줄을 바꾸지 않는다 (QA-464)", () => {
    for (const active of [true, false]) {
      expect(tokens(pillTabClasses(active))).toEqual(expect.arrayContaining(["gap-1.5", "whitespace-nowrap"]));
    }
  });
});

describe("세그먼트 segmentClasses", () => {
  it("트랙은 4px·1px 경계의 어두운 바탕, 고른 칸은 뜬 칩(surface-2·1px 진한 링)과 굵은 글·고대비 테두리, 포커스 링은 감싼 라벨에", () => {
    expect(tokens(SEGMENT_TRACK)).toEqual(expect.arrayContaining(["rounded-control", "border", "bg-bg"]));
    const checked = tokens(segmentClasses(true));
    const idle = tokens(segmentClasses(false));
    expect(checked).toEqual(expect.arrayContaining(["bg-surface-2", "font-semibold", "ring-1", "ring-border-strong", "forced-colors:border"]));
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

/** globals.css :root의 색 토큰 값(#rrggbb) — 고른 칸 표시의 대비를 세려고 읽습니다. */
const ROOT_TOKENS: Record<string, string> = (() => {
  const css = readFileSync(resolve(__dirname, "../../../app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const root = /(?:^|[;}])\s*:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  return Object.fromEntries([...root.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)].map(([, name, value]) => [name, value.toLowerCase()]));
})();

/** WCAG 2.x 대비 — 두 #rrggbb. */
function contrastOf(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((at) => {
      const c = parseInt(hex.slice(at, at + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** 고른 칸 클래스의 링 색 토큰 이름(ring-border-strong → --border-strong). ring-1·ring-inset 같은 폭·위치 이름은 건너뜁니다. */
function ringToken(classes: string): string | undefined {
  const color = tokens(classes).find((name) => /^ring-(?!\d|inset$)[\w-]+$/.test(name));
  return color ? `--${color.slice("ring-".length)}` : undefined;
}

// QA-484: 세그먼트(홈 시장 고르기·결정 로그 보기·실행 감사 계좌)의 고른 칸은 어두운 트랙(bg) 위에 뜬 칩(surface-2)과 1px 링으로 그리는데,
// 링이 패널 경계(ring-border #383e47)라 트랙 위 1.71:1·칩 바탕과 1.34:1이었고 칩 바탕도 트랙과 1.28:1이었습니다 — 고른 칸을 알리는 표시가 모두
// WCAG 1.4.11(상태를 알리는 그래픽 3:1)에 못 미쳐 굵기(500 → 600)만 남았습니다(캡처에서 홈 '미국/한국'의 고른 칸이 거의 구분되지 않음).
// 같은 키트의 기간 고르기(pillTabClasses)는 고른 칸에 진한 링(ring-border-strong)을 써 3:1을 넘습니다. 링은 칩 바탕(surface-2)과 둘레 면 모두에
// 닿으므로 bg·surface·surface-2 위에서 셉니다. 고대비(forced-colors) 모드의 테두리는 그대로입니다. 재현 커밋에서는 it.fails였습니다.
describe("고른 칸 표시의 대비(WCAG 1.4.11)", () => {
  it("QA-484: 세그먼트·기간 고르기의 고른 칸 링은 bg·surface·surface-2 위 3:1 이상이다", () => {
    for (const [name, classes] of [
      ["segmentClasses", segmentClasses(true)],
      ["pillTabClasses", pillTabClasses(true)],
    ] as const) {
      const ring = ringToken(classes);
      expect(ring, `${name}의 링 색`).toBeDefined();
      const value = ROOT_TOKENS[ring ?? ""];
      expect(value, `${name}의 링 토큰 ${ring}`).toMatch(/^#[0-9a-f]{6}$/);
      for (const back of ["--bg", "--surface", "--surface-2"]) {
        const ratio = contrastOf(value, ROOT_TOKENS[back]);
        expect(ratio, `${name} ${ring} on ${back} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      }
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

  // QA-492: 고대비(forced-colors)에서는 바탕색(틴트)이 지워지고 두 상태의 1px 테두리가 같은 시스템 색이 되어, 켠 칩과 끈 칩이 글 굵기(600·500)로만
  // 갈렸습니다(/info/news·/info/status — 그 두 화면은 체크 아이콘을 붙이지 않음). 켜고 끄는 단추(toggleClasses)처럼 켠 칩만 그 모드에서 2px 테두리.
  // 재현 커밋에서는 it.fails였습니다.
  it("QA-492: 고대비에서는 켠 칩에만 2px 테두리(forced-colors:border-2) — 끈 칩에는 없다", () => {
    expect(tokens(filterChipClasses(true))).toContain("forced-colors:border-2");
    expect(tokens(filterChipClasses(false))).not.toContain("forced-colors:border-2");
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

  // 2026-11-16 사용자 결정 1(가) — 두 줄 허용 탭 줄(홈 시장 묶음). 바꾸기 전에는 wrap 인자가 없어 줄을 바꾸면 첫 줄에서 고른 탭의 2px 밑줄이
  // 둘째 줄 위에 떠 보였습니다(첫 줄 아래에 선이 없음 — P4 QA 스택 확인 390 측정).
  it("wrap — 탭마다 제 줄의 바닥선: 나머지 1px 경계선 + 1px 아래 여백(지금 탭 2px 밑줄과 같은 높이), 지금 탭은 강조 파랑 2px, 둘 다 탭 줄 바닥선과 -mb-px로 겹침", () => {
    const active = tokens(underlineTabClasses(true, "sm", true));
    const idle = tokens(underlineTabClasses(false, "sm", true));
    expect(active).toEqual(expect.arrayContaining(["border-b-2", "border-accent", "font-semibold", "text-text", "-mb-px", "min-h-11", "lg:min-h-[30px]", "whitespace-nowrap"]));
    expect(idle).toEqual(expect.arrayContaining(["border-b", "border-border", "pb-px", "-mb-px", "text-text-2", "min-h-11"]));
    expect(idle).not.toContain("border-transparent");
    expect(idle).not.toContain("font-semibold");
    // 고대비에서도 나머지 탭의 1px 선을 남깁니다(줄마다 바닥선 — 지우면 첫 줄 고른 탭의 밑줄이 다시 둘째 줄 위에 뜸).
    expect(idle).not.toContain("forced-colors:border-b-0");
    // 한 줄 탭(기본)은 그대로입니다.
    expect(tokens(underlineTabClasses(false, "sm"))).toEqual(tokens(underlineTabClasses(false, "sm", false)));
    expect(tokens(underlineTabClasses(false, "sm"))).not.toContain("-mb-px");
  });
});

describe("고른 행 막대 SELECTED_BAR", () => {
  it("잉크 3px 막대(강조 파랑 아님) — 고대비에서는 바탕색이 지워지므로 같은 폭의 왼쪽 테두리로", () => {
    const bar = tokens(SELECTED_BAR);
    expect(bar).toEqual(expect.arrayContaining(["absolute", "w-[3px]", "bg-text", "forced-colors:border-l-[3px]"]));
    expect(bar.some((name) => name.includes("accent"))).toBe(false);
  });
});
