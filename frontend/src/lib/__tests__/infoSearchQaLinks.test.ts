/**
 * 정보 검색 연결 그림(계약 §9-3·§9-7)의 QA 결함 재현·고정 시험(QA-423·QA-424) — 순수 함수(linkGraphLayout)를 숫자로 대조합니다.
 * 표본은 모두 합성 값입니다(실제 법인·사람의 이름을 쓰지 않음). 폭 296은 390 화면, 570은 1440 화면에서 잰 그림 칸의 폭입니다.
 */
import { describe, expect, it } from "vitest";
import { linkGraphLayout, linkGraphSize, linkGroups } from "@/lib/infoSearch";
import type { SearchLink } from "@/lib/types";

const link = (over: Partial<SearchLink>): SearchLink => ({ relation: "subsidiary", key: null, name: "X", kind: "company", source: "wikidata", detail: null, ...over });
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
  // 수정 전 실패: 자회사 넷의 글이 모두 'Example Subsid…'(570)·'Example…'(296)로 같아 서로 다른 글의 수가 1.
  it.fails("이름이 다르면 그림 글도 다르다 — 줄인 글은 '…'을 달고, 낭독 이름은 전체 이름", () => {
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
    }
  });
});
