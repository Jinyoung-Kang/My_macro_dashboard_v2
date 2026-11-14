/**
 * 정보 검색 연결 그림(계약 §9-3·§9-7)의 QA 결함 재현·고정 시험(QA-423·QA-424) — 순수 함수(linkGraphLayout)를 숫자로 대조합니다.
 * 표본은 모두 합성 값입니다(실제 법인·사람의 이름을 쓰지 않음). 폭 296은 390 화면, 570은 1440 화면에서 잰 그림 칸의 폭입니다.
 */
import { describe, expect, it } from "vitest";
import { fitGraphLabel, fitGraphLabelFrom, graphLabels, linkGraphLayout, linkGraphSize, linkGroups } from "@/lib/infoSearch";
import type { SearchLink } from "@/lib/types";

/** 글 폭 어림 — infoSearch의 그림 글과 같은 기준(12px 글자에서 한글·한자·가나·전각은 12, 그 밖은 7.5). */
const WIDE_CHAR = /[ᄀ-ᇿ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const textWidth = (text: string) => Array.from(text).reduce((sum, char) => sum + (WIDE_CHAR.test(char) ? 12 : 7.5), 0);

const link =(over: Partial<SearchLink>): SearchLink => ({ relation: "subsidiary", key: null, name: "X", kind: "company", source: "wikidata", detail: null, ...over });
const named = (relation: string, names: readonly string[], source: string, keyed: boolean) =>
  names.map((name, at) => link({ relation, name, source, key: keyed ? `wd:Q${relation.length * 100 + at + 1}` : null }));

/**
 * QA C-02의 자료 꼴 — Yahoo 내부자 25, GLEIF 모회사·최상위 모회사·자회사 넷, Wikidata 8줄(소유한 곳·소유자·창업자 둘·소속·대표·모회사·자회사).
 * 관계 9종, 39개 가운데 30개를 그리고 9개는 '목록에서 9개 더'.
 */
function c02Links(): SearchLink[] {
  return [
    ...named("insider", Array.from({ length: 25 }, (_, at) => `Fictional Insider ${at + 1}`), "yahoo", false),
    ...named("parent", ["Example Parent Holdings Ltd"], "gleif", false),
    ...named("ultimate_parent", ["Example Ultimate Parent Ltd"], "gleif", false),
    ...named("subsidiary", [1, 2, 3, 4].map((n) => `Example Subsidiary ${n} Ltd`), "gleif", false),
    ...named("owner_of", ["Example Owned Co"], "wikidata", true),
    ...named("owned_by", ["Example Owner Fund"], "wikidata", true),
    ...named("founded_by", ["Example Founder A", "Example Founder B"], "wikidata", true),
    ...named("employer", ["Example Employer"], "wikidata", true),
    ...named("ceo", ["Example Chief"], "wikidata", true),
    ...named("parent", ["Example Wikidata Parent"], "wikidata", true),
    ...named("subsidiary", ["Example Wikidata Child"], "wikidata", true),
  ];
}

describe("연결 그림 — 앞머리가 같은 이름의 노드도 보이는 글이 서로 다름(QA-423)", () => {
  // QA-423: 노드 글(fitGraphLabel)이 늘 이름 끝을 잘라 앞부분만 남겨, 앞 14자(1440)·8자(390)가 같은 이름은 그림에서 똑같은 글이 됐습니다
  // ('Example Subsid…' 넷, 'Fictional Insi…' 여럿). 전체 이름은 <title>·낭독 이름·목록에 있었지만 눈으로는 노드를 가를 수 없었습니다.
  // 수정 전 실패: 자회사 넷의 글이 모두 'Example Subsid…'(570)·'Example…'(296)로 같아 서로 다른 글의 수가 1(재현 커밋에서는 it.fails).
  it("이름이 다르면 그림 글도 다르다 — 줄인 글은 '…'을 달고, 낭독 이름은 전체 이름", () => {
    const subsidiaries = [1, 2, 3, 4].map((n) => link({ name: `Example Subsidiary ${n} Ltd`, source: "gleif" }));
    for (const width of [296, 570, 760]) {
      const layout = linkGraphLayout(linkGroups(subsidiaries), linkGraphSize(width), { centerName: "Example Corp" });
      const labels = layout.nodes.map((node) => node.label);
      expect(new Set(labels).size).toBe(4);
      for (const label of labels) expect(label).toContain("…");
      expect(layout.nodes.map((node) => node.ariaLabel)).toEqual(subsidiaries.map((entry) => `${entry.name} · 자회사 · 이름으로 찾기`));
    }
    // 관계 9종·노드 30개(내부자 여럿 + 'Example …'로 시작하는 법인·사람 여럿)에서도 서로 다른 이름은 서로 다른 글.
    for (const width of [296, 330, 390, 570, 760]) {
      const layout = linkGraphLayout(linkGroups(c02Links()), linkGraphSize(width), { centerName: "Example Corp" });
      const byLabel = new Map<string, Set<string>>();
      for (const node of layout.nodes) byLabel.set(node.label, (byLabel.get(node.label) ?? new Set()).add(node.link.name));
      for (const [label, names] of byLabel) expect([label, names.size]).toEqual([label, 1]);
      // 글 폭은 그대로 이름 자리(폭의 26%, 80~130px) − 14 안.
      const budget = Math.min(130, Math.max(80, Math.round(layout.width * 0.26))) - 14;
      for (const node of layout.nodes) expect(textWidth(node.label)).toBeLessThanOrEqual(budget);
    }
  });

  it("가운데 줄임 — 갈리는 낱말부터(번호는 통째로), 겹치지 않는 이름은 끝을 자른 글 그대로, 같은 이름은 같은 글", () => {
    // 뒷부분이 다 들면 앞부분은 남는 폭만큼, 길면 앞부분은 폭의 30%까지이고 끝에도 '…'.
    expect(fitGraphLabelFrom("Example Subsidiary 1 Ltd", 19, 116)).toBe("Example S…1 Ltd");
    expect(fitGraphLabelFrom("Example Subsidiary 1 Ltd", 19, 66)).toBe("Ex…1 Ltd");
    expect(fitGraphLabelFrom("Sample Electronics America, Inc.", 19, 116)).toBe("Samp…America,…");
    // 다 들면 그대로, 앞부분이 from 앞을 다 담으면 끝을 자른 글과 같음.
    expect(fitGraphLabelFrom("Mellanox", 3, 66)).toBe("Mellanox");
    expect(fitGraphLabelFrom("Example Subsidiary 1 Ltd", 3, 116)).toBe(fitGraphLabel("Example Subsidiary 1 Ltd", 116));

    const labels = graphLabels(
      ["Fictional Insider 1", "Fictional Insider 12", "Fictional Insider 13", "Mellanox", " Mellanox ", "Example Owned Co", "Example Owner Fund"],
      116,
    );
    expect([...labels]).toEqual([
      ["Fictional Insider 1", "Fictional Ins…1"],
      ["Fictional Insider 12", "Fictional In…12"], // '…2'가 아니라 번호를 통째로
      ["Fictional Insider 13", "Fictional In…13"],
      ["Mellanox", "Mellanox"],
      ["Example Owned Co", "Example Owned…"], // 끝을 자른 글이 이미 다르면 그대로
      ["Example Owner Fund", "Example Owner…"],
    ]);
    // 한글(글자 12px 어림) — 겹친 이름만 가운데를 줄임.
    expect([...graphLabels(["가상전자 해외법인 1호", "가상전자 해외법인 2호", "가상전자 국내법인", "가상전자"], 116)]).toEqual([
      ["가상전자 해외법인 1호", "가상전자 해외…1호"],
      ["가상전자 해외법인 2호", "가상전자 해외…2호"],
      ["가상전자 국내법인", "가상전자 국내법인"],
      ["가상전자", "가상전자"],
    ]);
    // 한 이름이 다른 이름의 앞부분이어도, 갈리는 자리가 빈칸이어도('…' 뒤에 빈칸 없음).
    expect([...graphLabels(["Example Holdings", "Example Holdings Asia", "Example Holdings Asia Pacific"], 66)]).toEqual([
      ["Example Holdings", "Example…"],
      ["Example Holdings Asia", "Exa…Asia"],
      ["Example Holdings Asia Pacific", "Ex…Asia…"],
    ]);
    // 첫 차례에 같은 글이 남으면(갈리는 낱말 뒤에서 또 갈림) 그 이름들끼리 다시.
    expect([...graphLabels(["Example Alpha One Holdings Ltd", "Example Alpha One Holdings Inc", "Example Alpha Two Holdings Ltd"], 66)]).toEqual([
      ["Example Alpha One Holdings Ltd", "Exam…Ltd"],
      ["Example Alpha One Holdings Inc", "Exam…Inc"],
      ["Example Alpha Two Holdings Ltd", "Ex…Two…"],
    ]);
  });

  it("어떤 이름 묶음이든 서로 다른 이름은 서로 다른 글이고 폭은 예산 안 — 합성 이름 묶음 300개 × 폭 66·87·116", () => {
    let seed = 20261115;
    const pick = (count: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % count;
    };
    const heads = ["Example Holdings", "Example", "Sample Group International", "가상전자", "가상전자 해외법인", "Fictional Insider"];
    const words = ["1", "2", "12", "1 2", "Ltd", "Inc", "Asia", "Asia Pacific", "Alpha", "Alpha1", "A", "B", "&", "Co.", "국내", "해외법인", "1호", "2호", "Ltd."];
    for (let trial = 0; trial < 300; trial += 1) {
      const head = heads[pick(heads.length)];
      const names = Array.from({ length: 2 + pick(29) }, () =>
        [head, ...Array.from({ length: pick(5) }, () => words[pick(words.length)])].join(pick(4) === 0 ? "" : " "),
      );
      for (const maxPx of [66, 87, 116]) {
        const owner = new Map<string, string>();
        for (const [name, label] of graphLabels(names, maxPx)) {
          expect(textWidth(label)).toBeLessThanOrEqual(maxPx);
          expect([label, owner.get(label) ?? name]).toEqual([label, name]);
          owner.set(label, name);
        }
      }
    }
  });
});

type Layout = ReturnType<typeof linkGraphLayout>;

/** 같은 쪽(오른쪽 = start, 왼쪽 = end) 이웃 노드의 가장 좁은 세로 간격. */
function minRowGap(layout: Layout): number {
  let gap = Infinity;
  for (const anchor of ["start", "end"] as const) {
    const ys = layout.nodes.filter((node) => node.anchor === anchor).map((node) => node.y).sort((a, b) => a - b);
    for (let at = 1; at < ys.length; at += 1) gap = Math.min(gap, ys[at] - ys[at - 1]);
  }
  return gap;
}

/** 노드 글 상자 — 12px 글자의 글 폭 × 높이 14(노드 높이 가운데), 오른쪽 노드는 오른쪽으로·왼쪽 노드는 왼쪽으로 뻗음. */
function labelBox(node: Layout["nodes"][number]) {
  const width = textWidth(node.label);
  const left = node.anchor === "start" ? node.labelX : node.labelX - width;
  return { left, right: left + width, top: node.y - 7, bottom: node.y + 7 };
}

/** 겹치는 노드 글 상자 쌍(글 — 실패할 때 어느 둘인지 보이게). */
function labelOverlaps(layout: Layout): string[] {
  const out: string[] = [];
  layout.nodes.forEach((a, at) => {
    for (const b of layout.nodes.slice(at + 1)) {
      const A = labelBox(a);
      const B = labelBox(b);
      if (Math.min(A.right, B.right) > Math.max(A.left, B.left) && Math.min(A.bottom, B.bottom) > Math.max(A.top, B.top)) out.push(`${a.label} / ${b.label}`);
    }
  });
  return out;
}

/** 겹치는 관계 글 상자 쌍 — 상자는 글 폭 + 좌우 4px × 높이 16(LinksGraph의 rect), 다른 쪽(오른쪽·왼쪽) 글끼리도. */
function tagOverlaps(layout: Layout): string[] {
  const out: string[] = [];
  layout.tags.forEach((a, at) => {
    for (const b of layout.tags.slice(at + 1)) {
      if (Math.abs(a.x - b.x) < (a.width + b.width) / 2 + 8 && Math.abs(a.y - b.y) < 16) out.push(`${a.label}(${a.side}) / ${b.label}(${b.side})`);
    }
  });
  return out;
}

/** 그린 것(노드 글 상자·관계 글 상자)이 모두 뷰(그린 세로 범위)와 그림 폭 안. */
function expectInView(layout: Layout) {
  const top = layout.view.y;
  const bottom = layout.view.y + layout.view.height;
  for (const node of layout.nodes) {
    const box = labelBox(node);
    expect(box.top).toBeGreaterThanOrEqual(top);
    expect(box.bottom).toBeLessThanOrEqual(bottom);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(layout.width);
  }
  for (const tag of layout.tags) {
    expect(tag.y - 8).toBeGreaterThanOrEqual(top);
    expect(tag.y + 8).toBeLessThanOrEqual(bottom);
    expect(tag.x - tag.width / 2 - 4).toBeGreaterThanOrEqual(0);
    expect(tag.x + tag.width / 2 + 4).toBeLessThanOrEqual(layout.width);
  }
}

describe("연결 그림 — 좁은 화면에서도 노드 이름·관계 글이 겹치지 않음(QA-424)", () => {
  // QA-424: 폭 296(390 화면)에서 높이가 340에 묶여(linkGraphSize) 타원의 세로 반지름에 상한이 있고, 관계 9종이면 칸 수로 나눈 뒤에도 간격을 다시
  // 재지 않아 같은 쪽 이웃 노드가 10.9·11.4px 간격(< GRAPH_ROW_GAP 14)으로 붙어 노드 글 상자 6쌍이 최대 3.1px 겹쳤습니다. 관계 글은 같은 쪽끼리만
  // 비켜 두어 위쪽 극 근처의 오른쪽 '소유한 곳'과 왼쪽 '자회사' 상자가 겹쳤습니다.
  // 수정 전 실패: 폭 296에서 minRowGap 10.9, 노드 글 겹침 6쌍, 관계 글 겹침 '소유한 곳(right) / 자회사(left)'(재현 커밋에서는 it.fails).
  it("C-02 자료(관계 9종·노드 30개, 9개는 목록으로)를 폭 296·330·390·570에 그려도 같은 쪽 이웃 간격 ≥ 14, 노드 글·관계 글 상자가 겹치지 않음 — 모자라면 그림을 높임", () => {
    for (const width of [296, 330, 390, 570]) {
      const layout = linkGraphLayout(linkGroups(c02Links()), linkGraphSize(width), { centerName: "Example Corp" });
      expect([layout.nodes.length, layout.hidden]).toEqual([30, 9]);
      expect(minRowGap(layout)).toBeGreaterThanOrEqual(14);
      expect(labelOverlaps(layout)).toEqual([]);
      expect(tagOverlaps(layout)).toEqual([]);
      expectInView(layout);
    }
    // 좁은 화면은 글자를 줄이지 않고 그림을 높임(폭 296 → 높이 340보다 큼). 1440(폭 570)은 겹침이 없어 크기 그대로.
    expect(linkGraphLayout(linkGroups(c02Links()), linkGraphSize(296)).height).toBeGreaterThan(340);
    expect(linkGraphLayout(linkGroups(c02Links()), linkGraphSize(570)).height).toBe(linkGraphSize(570).height);
  });

  // 수정 전 실패: 관계 1종(내부자 30)도 폭 296에서 간격이 13.99…(반올림 뒤 14에 닿음), 7~9종은 관계 글이 좌우로 겹침(재현 커밋에서는 it.fails).
  it("관계가 1~9종이어도(노드 30) 폭 296·330·390·453·570에서 같은 쪽 이웃 간격 ≥ 14, 모르는 관계 코드(긴 글)가 있어도 관계 글끼리 겹치지 않음", () => {
    const relations = ["owner_of", "owned_by", "founded_by", "employer", "ceo", "ultimate_parent", "parent", "subsidiary"];
    for (let kinds = 1; kinds <= 9; kinds += 1) {
      const links = [
        ...named("insider", Array.from({ length: 31 - kinds }, (_, at) => `Fictional Insider ${at + 1}`), "yahoo", false),
        ...relations.slice(0, kinds - 1).flatMap((relation) => named(relation, [`Example ${relation}`], "wikidata", true)),
      ];
      for (const width of [296, 330, 390, 453, 570]) {
        const layout = linkGraphLayout(linkGroups(links), linkGraphSize(width), { centerName: "Example Corp" });
        expect([kinds, width, minRowGap(layout) >= 14]).toEqual([kinds, width, true]);
        expect(labelOverlaps(layout)).toEqual([]);
        expect(tagOverlaps(layout)).toEqual([]);
        expectInView(layout);
      }
    }
    // 모르는 관계 코드는 이름 그대로(설계대로) 관계 글이 되고 맨 뒤 묶음(왼쪽 위)에 놓임 — 오른쪽 위 '소유한 곳'과 겹치지 않음.
    const unknown = [...c02Links(), ...named("qa_unknown_rel", ["Example Unknown Relation"], "wikidata", true)];
    for (const width of [296, 330, 390, 570, 760]) {
      const layout = linkGraphLayout(linkGroups(unknown), linkGraphSize(width), { centerName: "Example Corp" });
      expect(layout.tags.some((tag) => tag.label === "qa_unknown_rel")).toBe(true);
      expect(tagOverlaps(layout)).toEqual([]);
      expect(labelOverlaps(layout)).toEqual([]);
      expect(minRowGap(layout)).toBeGreaterThanOrEqual(14);
      expectInView(layout);
    }
  });
});
