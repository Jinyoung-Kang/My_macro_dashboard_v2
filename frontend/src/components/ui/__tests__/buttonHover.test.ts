/**
 * 단추의 hover 반응(components/ui/classes.ts — buttonClasses·toggleClasses, 작업대 실행 명세 §3-4).
 *  - 비활성 단추(disabled, aria-disabled="true")는 hover에 반응하지 않는다 — 누를 수 없는 단추가 경계를 진하게 하거나 바탕을 밝히면 누를 수
 *    있는 것처럼 보입니다. hover 변형은 모두 앞에 상태 거름(not-disabled·not-aria-disabled)을 둡니다.
 *  - `enabled:`는 쓰지 않습니다 — :enabled는 폼 요소에만 맞아, 단추 모양 링크(<a className={buttonClasses(...)}> — 읽기 창 '원문 열기')가 hover를
 *    잃습니다. not-disabled:는 :not(:disabled)라 링크에도 맞습니다.
 */
import { describe, expect, it } from "vitest";

import { buttonClasses, toggleClasses, type ButtonSize, type ButtonVariant } from "@/components/ui/classes";

const VARIANTS: readonly ButtonVariant[] = ["default", "primary", "danger", "minimal", "secondary", "ghost"];
const SIZES: readonly ButtonSize[] = ["md", "sm", "lg"];

const tokens = (classes: string) => classes.split(/\s+/).filter(Boolean);
/** 변형 접두어 가운데 hover:가 든 낱말. */
const hoverTokens = (classes: string) => tokens(classes).filter((name) => /(^|:)hover:/.test(name));

describe("비활성 단추의 hover", () => {
  // QA-493: BUTTON_KIND의 hover(기본 경계 border-strong·주 바탕 accent-hover·위험 opacity-90·최소 바탕 control-fill)와 켜고 끄는 단추 끈 칸의
  // hover가 :disabled·[aria-disabled=true]를 거르지 않아, 마우스가 있는 화면에서 비활성 '모두 읽음'의 경계가 #383e47 → #738091, 비활성
  // '회원 만들기'의 바탕이 #4c90f0 → #8abbff로 바뀌었습니다(cursor는 not-allowed). 재현 커밋에서는 it.fails입니다.
  it.fails("QA-493: 단추 hover는 모두 not-disabled:not-aria-disabled: 뒤에, 켜고 끄는 단추 hover는 not-aria-disabled: 뒤에 — 맨 hover: 없음", () => {
    for (const variant of VARIANTS) {
      for (const size of SIZES) {
        const classes = buttonClasses(variant, size);
        const hovers = hoverTokens(classes);
        expect(hovers.length, `${variant}/${size}의 hover`).toBeGreaterThan(0);
        expect(tokens(classes).filter((name) => name.startsWith("hover:")), `${variant}/${size}`).toEqual([]);
        for (const name of hovers) expect(name, `${variant}/${size}`).toMatch(/^not-disabled:not-aria-disabled:hover:/);
      }
    }
    for (const compact of [false, true]) {
      const classes = toggleClasses(false, compact);
      const hovers = hoverTokens(classes);
      expect(hovers.length, `toggle compact=${compact}의 hover`).toBeGreaterThan(0);
      expect(tokens(classes).filter((name) => name.startsWith("hover:")), `toggle compact=${compact}`).toEqual([]);
      for (const name of hovers) expect(name, `toggle compact=${compact}`).toMatch(/^not-aria-disabled:hover:/);
    }
  });

  it("enabled: 변형은 쓰지 않는다 — 단추 모양 링크(<a>)가 hover를 잃음", () => {
    for (const variant of VARIANTS) expect(buttonClasses(variant).includes("enabled:"), variant).toBe(false);
    for (const compact of [false, true]) expect(toggleClasses(false, compact).includes("enabled:")).toBe(false);
  });
});
