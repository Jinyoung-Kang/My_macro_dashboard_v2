/**
 * 정보 검색 연결 그림 노드 글의 폭 어림(QA-423 후속 — 말줄임표 '…'의 폭) 재현·고정 시험. 순수 함수(fitGraphLabel·fitGraphLabelFrom·graphLabels·
 * linkGraphLayout)를 숫자로 대조합니다. 표본은 모두 합성 값입니다(실제 법인·사람의 이름을 쓰지 않음). 폭 296은 390 화면, 570은 1440 화면에서 잰 그림 칸의 폭입니다.
 */
import { describe, expect, it } from "vitest";
import { fitGraphLabel, fitGraphLabelFrom, graphLabels, linkGraphLayout, linkGraphSize, linkGroups } from "@/lib/infoSearch";
import type { SearchLink } from "@/lib/types";

/**
 * 그린 글의 폭 — QA 스택 브라우저에서 같은 SVG에 12px로 그려 잰 한글 '가'와 말줄임표 '…'(U+2026)는 12px. 한글·한자·가나·전각과 '…'는 12,
 * 그 밖(라틴 글자 등)은 infoSearch의 어림 그대로(대문자 M·W 12, 그 밖의 대문자 9, 나머지 7.5 — 대문자의 잰 폭 대조는 infoSearchQaLabels 시험).
 */
const WIDE = /[ᄀ-ᇿ…⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const renderedWidth = (text: string) => Array.from(text).reduce((sum, char) => sum + (WIDE.test(char) || /[MW]/.test(char) ? 12 : /\p{Lu}/u.test(char) ? 9 : 7.5), 0);

/** QA가 kr:005930의 연결을 한글 이름 16개로 모의한 자료 꼴 — 앞머리 '가상'이 같고 '가상전자…'가 여럿. */
const KOREAN_NAMES = [
  "가상전자디스플레이",
  "가상전자글로벌반도체",
  "가상전자글로벌반도체 미국법인",
  "가상전자글로벌물류",
  "가상바이오로직스",
  "가상바이오에피스",
  "가상전기",
  "가상SDI",
  "가상중공업",
  "가상물산",
  "가상생명보험",
  "가상화재해상보험",
  "가상증권",
  "가상카드",
  "가상에스디에스",
  "가상전자판매",
];
/** 라틴·섞인 이름 — 앞머리가 같은 법인명, 번호, 쉼표, 한글과 라틴이 섞인 이름. */
const LATIN_NAMES = [
  "Example Subsidiary 1 Ltd",
  "Example Subsidiary 12 Ltd",
  "Sample Electronics America, Inc.",
  "Example Holdings Asia Pacific",
  "Fictional Insider 13",
  "가상전자 America, Inc.",
  "Example 가상전자 해외법인 2호",
];

describe("연결 그림 — '…'가 든 노드 글도 그린 폭이 배정 폭 안(QA-423 후속)", () => {
  // QA-423: 노드 글 폭 어림(infoSearch의 charWidth)이 말줄임표 '…'(U+2026)를 라틴 글자처럼 7.5px로 셌지만 그림에서는 12px로 그려져, '…'가
  // 든 글이 배정 폭(이름 자리 − 14px)을 넘었습니다 — 390 화면 '가…디스플…' 72 > 66px, 1280 '가상바이오로직…' 96 > 95px, 1440 '가상전자글로벌반도…'
  // 120 > 116px. fitGraphLabelFrom의 '폭은 maxPx를 넘지 않습니다'가 어림에서만 참이었습니다.
  // 수정 전 실패: graphLabels가 폭 66에서 '가…디스플…'(그린 폭 72)를, 95에서 '가상바이오로직…'(96)을 돌려줌(재현 커밋에서는 it.fails).
  it("QA 자료 꼴(한글 이름 16개)과 라틴 이름을 폭 66·95·116에 맞추면 '…'를 12px로 잰 글 폭이 배정 폭 안", () => {
    for (const maxPx of [66, 95, 116]) {
      for (const names of [KOREAN_NAMES, LATIN_NAMES, [...KOREAN_NAMES, ...LATIN_NAMES]]) {
        const labels = graphLabels(names, maxPx);
        for (const [name, label] of labels) expect([name, label, renderedWidth(label) <= maxPx]).toEqual([name, label, true]);
        // 서로 다른 이름은 서로 다른 글(QA-423 그대로).
        expect(new Set(labels.values()).size).toBe(labels.size);
      }
    }
  });

  // 수정 전 실패: 예산 66~160에서 '…'를 하나 단 글(끝 자름)은 4.5px, 둘 단 글(가운데 줄임 + 끝 자름)은 9px까지 예산을 넘고('가…전자디스…' 84 > 75),
  // 예산이 아주 작으면 '……'(24px)가 예산 12를 넘음(재현 커밋에서는 it.fails).
  it("fitGraphLabel·fitGraphLabelFrom — 한글·라틴 이름, 보이는 자리마다, 예산 12~160px 전부에서 '…'를 12px로 잰 폭이 예산 안", () => {
    for (const name of [...KOREAN_NAMES, ...LATIN_NAMES]) {
      const length = Array.from(name).length;
      for (let maxPx = 12; maxPx <= 160; maxPx += 1) {
        const cut = fitGraphLabel(name, maxPx);
        expect([name, maxPx, cut, renderedWidth(cut) <= maxPx]).toEqual([name, maxPx, cut, true]);
        for (let from = 0; from <= length; from += 1) {
          const label = fitGraphLabelFrom(name, from, maxPx);
          expect([name, from, maxPx, label, renderedWidth(label) <= maxPx]).toEqual([name, from, maxPx, label, true]);
        }
      }
    }
  });

  // 수정 전 실패: 폭 280·296(390 화면)의 노드 글 '가…디스플…'(72)이 이름 자리(80) − 14 = 66을 넘음(재현 커밋에서는 it.fails).
  it("그림 배치 — 노드 글은 이름 자리(폭의 26%, 80~130px) − 14, 가운데 대상 글은 min(160, 가로 반지름 × 1.2) 안이고 가운데 상자 안", () => {
    const links: SearchLink[] = KOREAN_NAMES.map((name, at) => ({
      relation: at < 8 ? "subsidiary" : "owner_of",
      key: `wd:Q${900 + at}`,
      name,
      kind: "company",
      source: "wikidata",
      detail: null,
    }));
    for (const width of [280, 296, 330, 390, 410, 419, 453, 570, 760]) {
      const layout = linkGraphLayout(linkGroups(links), linkGraphSize(width), { centerName: "가상전자주식회사 글로벌반도체 홀딩스" });
      const budget = Math.min(130, Math.max(80, Math.round(layout.width * 0.26))) - 14;
      for (const node of layout.nodes) expect([width, node.label, renderedWidth(node.label) <= budget]).toEqual([width, node.label, true]);
      const centerBudget = Math.min(160, layout.rx * 1.2);
      expect([width, layout.center.label, renderedWidth(layout.center.label) <= centerBudget]).toEqual([width, layout.center.label, true]);
      expect(renderedWidth(layout.center.label)).toBeLessThanOrEqual(layout.center.width - 16);
    }
  });
});
