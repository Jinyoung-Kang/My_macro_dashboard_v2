/**
 * 정보 검색 연결 그림 — 칸이 그림보다 좁아 가로로 넘길 때(QA-424) 포커스가 간 노드를 칸 안에 들이는 넘김 값(graphFocusScrollLeft, QA 재확인 개선 제안)을
 * 숫자로 대조합니다. 표본은 모두 합성 값입니다(실제 법인·사람의 이름을 쓰지 않음). 칸 226px은 320 화면, 그림 폭 280은 그림의 가장 작은 폭입니다.
 */
import { describe, expect, it } from "vitest";
import { graphFocusScrollLeft, linkGraphLayout, linkGraphSize, linkGroups } from "@/lib/infoSearch";
import type { SearchLink } from "@/lib/types";

/** 글 폭 어림 — infoSearch의 그림 글과 같은 기준(한글·'…'·대문자 M·W 12, 그 밖의 대문자 9, 나머지 7.5). 시험 이름에는 넓은 키릴 글자를 쓰지 않음. */
const WIDE_CHAR = /[ᄀ-ᇿ…⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const textWidth = (text: string) => Array.from(text).reduce((sum, char) => sum + (WIDE_CHAR.test(char) || /[MW]/.test(char) ? 12 : /\p{Lu}/u.test(char) ? 9 : 7.5), 0);

/** 포커스 고리 바깥 반지름(12)과 칸 가장자리 여유(4)를 더한 노드의 가로 범위(칸 좌표 — scale 1). */
function extentOf(node: { x: number; labelX: number; anchor: "start" | "end"; label: string }, labelWidth = textWidth(node.label)) {
  return node.anchor === "start"
    ? { left: node.x - 12 - 4, right: Math.max(node.x + 12, node.labelX + labelWidth) + 4 }
    : { left: Math.min(node.x - 12, node.labelX - labelWidth) - 4, right: node.x + 12 + 4 };
}

describe("연결 그림 — 가로로 넘기는 칸에서 포커스가 간 노드의 고리·이름이 다 보이게 넘김(graphFocusScrollLeft)", () => {
  const box = { scrollLeft: 27, clientWidth: 226 };

  it("오른쪽에 걸친 노드는 이름 끝 + 4px가 칸 오른쪽 끝에, 왼쪽에 걸친 노드는 이름 앞 − 4px가 칸 왼쪽 끝에 오게 — 가장 적게 넘김", () => {
    // 오른쪽 노드(이름이 오른쪽으로): 범위 183.2~279.2 → 279.2 − 226 = 53.2.
    expect(graphFocusScrollLeft({ x: 199.2, labelX: 209.2, anchor: "start", label: "x" }, box, { width: 280, labelWidth: 66 })).toBeCloseTo(53.2, 6);
    // 왼쪽 노드(이름이 왼쪽으로): 범위 0.8~96.8 → 0.8.
    expect(graphFocusScrollLeft({ x: 80.8, labelX: 70.8, anchor: "end", label: "x" }, box, { width: 280, labelWidth: 66 })).toBeCloseTo(0.8, 6);
  });

  it("이미 다 보이면 null(넘기지 않음), 넘김 값은 0 ~ 그림 폭 − 칸 폭으로 자름", () => {
    expect(graphFocusScrollLeft({ x: 177, labelX: 187, anchor: "start", label: "x" }, box, { width: 280, labelWidth: 50 })).toBeNull();
    expect(graphFocusScrollLeft({ x: 140, labelX: 130, anchor: "end", label: "x" }, box, { width: 280, labelWidth: 60 })).toBeNull();
    // 범위가 그림 밖(이름이 뷰박스 끝까지)이어도 0·54를 넘지 않음.
    expect(graphFocusScrollLeft({ x: 80, labelX: 70, anchor: "end", label: "x" }, box, { width: 280, labelWidth: 70 })).toBe(0);
    expect(graphFocusScrollLeft({ x: 200, labelX: 210, anchor: "start", label: "x" }, box, { width: 280, labelWidth: 70 })).toBe(54);
    // 이미 끝까지 넘겨 더 넘길 수 없으면 null.
    expect(graphFocusScrollLeft({ x: 200, labelX: 210, anchor: "start", label: "x" }, { scrollLeft: 54, clientWidth: 226 }, { width: 280, labelWidth: 70 })).toBeNull();
  });

  it("범위가 칸보다 넓으면 노드 원 쪽(이름이 시작하는 쪽)을 맞춤, scale(그린 폭 ÷ 그림 폭)을 곱함, 이름 폭을 재지 못하면 어림 폭", () => {
    const narrow = { scrollLeft: 0, clientWidth: 100 };
    // 오른쪽으로 뻗는 이름: 범위 184~330(146 > 100) → 원 쪽 184.
    expect(graphFocusScrollLeft({ x: 200, labelX: 210, anchor: "start", label: "x" }, narrow, { width: 400, labelWidth: 116 })).toBe(184);
    // 왼쪽으로 뻗는 이름: 범위 70~216 → 원 쪽이 칸 오른쪽 끝에(216 − 100 = 116).
    expect(graphFocusScrollLeft({ x: 200, labelX: 190, anchor: "end", label: "x" }, narrow, { width: 400, labelWidth: 116 })).toBe(116);
    // scale 2: 범위 (100 − 12) × 2 − 4 = 172 ~ (110 + 40) × 2 + 4 = 304 → 304 − 226 = 78.
    expect(graphFocusScrollLeft({ x: 100, labelX: 110, anchor: "start", label: "x" }, { scrollLeft: 0, clientWidth: 226 }, { width: 280, scale: 2, labelWidth: 40 })).toBe(78);
    // 어림 폭: '가상…베트남'(12 × 6 = 72) → 범위 187.2 ~ 285.2 → 59.2이지만 54로 자름.
    expect(graphFocusScrollLeft({ x: 199.2, labelX: 209.2, anchor: "start", label: "가상…베트남" }, box, { width: 280 })).toBe(54);
    expect(graphFocusScrollLeft({ x: 199.2, labelX: 209.2, anchor: "start", label: "가상…" }, box, { width: 280 })).toBeNull();
  });

  it("320 화면(칸 226, 그림 280)의 실제 배치 — 노드마다 포커스하면 그 노드의 고리·이름(어림 폭)이 칸 안", () => {
    const links: SearchLink[] = [
      ["owner_of", "Sample Owned Subsidiary Holdings"],
      ["owned_by", "Sample Owner Investment Fund One"],
      ["founded_by", "Sample Founder Alexander Example"],
      ["founded_by", "Sample Founder Benjamin Example"],
      ["employer", "Sample Employer Corporation"],
      ["ceo", "Sample Chief Executive Person"],
      ["parent", "Sample Parent Holdings Group"],
      ["subsidiary", "Sample Subsidiary One"],
    ].map(([relation, name], at) => ({ relation, key: `wd:Q${700 + at}`, name, kind: "company", source: "wikidata", detail: null }));
    const layout = linkGraphLayout(linkGroups(links), linkGraphSize(226), { centerName: "Sample Center Co." });
    expect(layout.width).toBe(280);
    let scrollLeft = (280 - 226) / 2;
    let clipped = 0;
    for (const node of layout.nodes) {
      const before = extentOf(node);
      if (before.left < scrollLeft || before.right > scrollLeft + 226) clipped += 1;
      scrollLeft = graphFocusScrollLeft(node, { scrollLeft, clientWidth: 226 }, { width: layout.width }) ?? scrollLeft;
      const { left, right } = extentOf(node);
      expect([node.label, left >= scrollLeft - 1e-9, right <= scrollLeft + 226 + 1e-9]).toEqual([node.label, true, true]);
    }
    // 처음 가운데로 넘겨 둔 자리에서는 양쪽 노드가 칸 밖에 걸쳐 있었음(넘길 일이 있었음).
    expect(clipped).toBeGreaterThan(0);
  });
});
