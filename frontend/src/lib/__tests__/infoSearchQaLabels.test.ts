/**
 * 정보 검색 연결 그림 노드 글(계약 §9-3·§9-7)의 QA-423 후속 재현·고정 시험 — 대문자 라틴 글자의 폭 어림, 둘째 차례 이후의 번호·낱말 물림. 순수
 * 함수(fitGraphLabel·graphLabels·linkGraphLayout)를 숫자로 대조합니다. 표본은 모두 합성 값입니다(실제 법인·사람의 이름을 쓰지 않음).
 */
import { describe, expect, it } from "vitest";
import { fitGraphLabel, graphLabels, linkGraphLayout, linkGraphSize, linkGroups } from "@/lib/infoSearch";
import type { SearchLink } from "@/lib/types";

/**
 * 12px 글자의 실제 폭 상한(px) — 화면 글꼴 스택(globals.css --font-sans: Pretendard, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)에서
 * 쓰일 수 있는 글꼴 여섯(Pretendard Regular, Segoe UI, Arial, Liberation Sans, DejaVu Sans, 맑은 고딕)의 글자 전진 폭을 글꼴 파일에서 읽어, 글자마다
 * 가장 넓은 값을 0.1px 올림한 표입니다(대문자 M 11.1·W 11.9, 그 밖의 대문자 3.6~9.5). QA 브라우저 실측(M 10, W 11.33, A·E 8.02 — Arial·Liberation
 * Sans의 폭과 같음)보다 넓거나 같습니다. 한글·한자·가나·전각과 말줄임표 '…'는 12(QA-423 후속 실측). 표에 없는 글자(소문자 등)는 이 시험의 이름에
 * 쓰지 않습니다.
 */
const MEASURED: Readonly<Record<string, number>> = {
  A: 8.3, B: 8.3, C: 8.7, D: 9.3, E: 8.1, F: 7.4, G: 9.4, H: 9.1, I: 3.6, J: 6.2, K: 8.1, L: 6.7, M: 11.1,
  N: 9.2, O: 9.5, P: 8.1, Q: 9.5, R: 8.7, S: 8.1, T: 7.4, U: 8.8, V: 8.3, W: 11.9, X: 8.3, Y: 8.1, Z: 8.3,
  "0": 7.7, "1": 7.7, "2": 7.7, "3": 7.7, "4": 7.7, "5": 7.7, "6": 7.7, "7": 7.7, "8": 7.7, "9": 7.7,
  " ": 4.3, ",": 3.9, ".": 3.9, "&": 9.9, "-": 5.2, "'": 3.3, "(": 4.7, ")": 4.7, "/": 4.8,
};
const WIDE = /[ᄀ-ᇿ…⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const renderedWidth = (text: string) =>
  Array.from(text).reduce((sum, char) => {
    if (WIDE.test(char)) return sum + 12;
    const width = MEASURED[char];
    if (width === undefined) throw new Error(`잰 폭이 없는 글자 '${char}'`);
    return sum + width;
  }, 0);

/**
 * QA가 kr:005930의 연결로 모의한 대문자 이름 꼴 — GLEIF 법인명(등록된 그대로 대문자로 옴)과 대문자 사람 이름, M·W가 몰린 극단값, 번호·괄호·빗금이 든
 * 이름.
 */
const UPPER_NAMES = [
  "FICTIONAL ELECTRONICS AMERICA, INC.",
  "FICTIONAL SEMICONDUCTOR EUROPE GMBH",
  "FICTIONAL SEMICONDUCTOR EUROPE GMBH & CO. KG",
  "MMMWWW MANAGEMENT WORLDWIDE",
  "WWW MMM MW HOLDINGS",
  "FICTIONAL HOLDINGS MANAGEMENT COMPANY",
  "WOLFGANG MAXIMILIAN EXAMPLEMANN",
  "MICHAEL WILLIAMSON-SAMPLEWOOD",
  "EXAMPLE OVERSEAS HOLDINGS (WORLDWIDE) 12 B.V.",
  "SAMPLE GOODWOOD MOTOR WORKS A/S",
];

describe("연결 그림 — 대문자 라틴 이름의 노드 글도 그린 폭이 배정 폭 안(QA-423 후속)", () => {
  // QA-423: 노드 글 폭 어림(infoSearch의 charWidth)이 라틴 글자를 대소문자 구분 없이 7.5px로 세지만, 12px 대문자는 실제로 M 10·W 11.3·A·E 8px
  // 안팎이라 대문자가 많은 이름(GLEIF 법인명·대문자 내부자 이름)의 글이 배정 폭(이름 자리 − 14px)을 넘었습니다 — 1280 화면(배정 95) 'MMMWWW MANA…'
  // 114px(+19, 뷰박스 왼쪽 밖으로 나가 첫 글자가 잘림), 'WOLFGANG MA…' 103.3px(+8.3), 390 화면(배정 66) 'WWW MMM…' 79.3px(+13.3).
  // 수정 전 실패: graphLabels가 폭 66에서 'MMMWWW…'(잰 폭 상한 81.0)·'WWW MMM…'(85.3)을, 95에서 'MMMWWW MANA…'(122.2)를 돌려줌(재현 커밋에서는 it.fails).
  it("대문자 이름을 폭 66·95·116에 맞추면 잰 글자 폭으로도 배정 폭 안이고, 서로 다른 이름은 서로 다른 글", () => {
    for (const maxPx of [66, 95, 116]) {
      const labels = graphLabels(UPPER_NAMES, maxPx);
      for (const [name, label] of labels) expect([maxPx, name, label, renderedWidth(label) <= maxPx]).toEqual([maxPx, name, label, true]);
      expect(new Set(labels.values()).size).toBe(UPPER_NAMES.length);
      // 이름 하나만 끝을 잘라도(겹치는 이름이 없을 때의 글) 마찬가지.
      for (const name of UPPER_NAMES) {
        const label = fitGraphLabel(name, maxPx);
        expect([maxPx, label, renderedWidth(label) <= maxPx]).toEqual([maxPx, label, true]);
      }
    }
  });

  // 수정 전 실패: 폭 280(그림의 가장 작은 폭 — 320 화면)의 'WOLFGAN…'(잰 폭 상한 74.4)이 배정 폭 66을 넘고, 폭 419(1280 화면)의 왼쪽 노드 글 'MMMWWW MANA…'(122.2)는
  // 배정 폭 95를 넘어 뷰박스 왼쪽 밖(−21.9)에서 시작함(재현 커밋에서는 it.fails).
  it("그림 배치 — 대문자 이름의 노드 글을 잰 폭으로 그려도 배정 폭(이름 자리 − 14) 안이고 그림 폭(뷰박스 0~폭) 안", () => {
    const links: SearchLink[] = UPPER_NAMES.map((name, at) => ({
      relation: at < 6 ? "subsidiary" : "insider",
      key: null,
      name,
      kind: at < 6 ? "company" : "person",
      source: at < 6 ? "gleif" : "yahoo",
      detail: null,
    }));
    for (const width of [280, 296, 330, 390, 410, 419, 453, 570, 760]) {
      const layout = linkGraphLayout(linkGroups(links), linkGraphSize(width), { centerName: "FICTIONAL ELECTRONICS CO., LTD." });
      const budget = Math.min(130, Math.max(80, Math.round(layout.width * 0.26))) - 14;
      for (const node of layout.nodes) {
        const drawn = renderedWidth(node.label);
        const left = node.anchor === "start" ? node.labelX : node.labelX - drawn;
        expect([width, node.label, drawn <= budget, left >= 0, left + drawn <= layout.width]).toEqual([width, node.label, true, true, true]);
      }
    }
  });
});

/** 글에서 '…' 바로 뒤에 보이는 숫자들(가운데를 줄인 글의 뒷부분이 숫자로 시작하면 그 숫자). */
const numbersAfterEllipsis = (label: string) => [...label.matchAll(/…(\d+)/g)].map((match) => match[1]);

describe("연결 그림 — 둘째 차례 이후에도 갈리는 번호·낱말을 통째로 보임(QA-423 후속)", () => {
  // QA-423: graphLabels가 갈리는 자리를 낱말·숫자의 첫 글자로 물리는 처리(GRAPH_WORD_BACK)를 첫 차례에만 해, 첫 차례에 앞머리가 같은 다른 이름과 함께
  // 묶였다가 둘째 차례로 넘어온 이름들은 갈리는 바로 그 글자부터 보였습니다 — 1280 화면(배정 93)에서 'Fictional Example Semiconductor Holdings 1 Ltd'·
  // '… 12 Ltd'가 'Fictio… Ltd'·'Ficti…2 Ltd'로 그려져 번호 1이 빠지고 12가 2로 읽혔습니다('…'를 12px로 센 뒤 세 이름의 끝을 자른 글이 모두
  // 'Fictional…'로 같아져, 첫 차례는 셋을 'Fictional ' 뒤에서 가르고 번호 둘은 둘째 차례로 넘어감).
  // 수정 전 실패: 폭 93에서 'Fictio… Ltd'·'Ficti…2 Ltd'(대문자 어림 9px 뒤 — 87에서는 'Ficti… Ltd'·'Fict…2 Ltd'), 66에서 'Fi… Ltd'·'Fi…2 L…'
  // (재현 커밋에서는 it.fails).
  it("앞머리가 같은 이름 셋(번호 1·12) — 폭 66~116 어디서나 '…1'·'…12'처럼 번호를 통째로, 서로 다른 글", () => {
    const names = ["Fictional Graphics Example Holdings Ltd", "Fictional Example Semiconductor Holdings 1 Ltd", "Fictional Example Semiconductor Holdings 12 Ltd"];
    for (const maxPx of [66, 87, 93, 95, 101, 116]) {
      const labels = graphLabels(names, maxPx);
      expect([maxPx, labels.get(names[1]), numbersAfterEllipsis(labels.get(names[1])!)]).toEqual([maxPx, labels.get(names[1]), ["1"]]);
      expect([maxPx, labels.get(names[2]), numbersAfterEllipsis(labels.get(names[2])!)]).toEqual([maxPx, labels.get(names[2]), ["12"]]);
      expect(new Set(labels.values()).size).toBe(3);
    }
  });

  // 번호들의 첫 자리가 같으면(1·12·13, 2·21·22·23 …) 둘째 차례가 번호 가운데에서 갈림.
  // 수정 전 실패: 폭 66~95에서 번호 21·22·23의 글이 'Fi…1 L…'·'Ficti…2 Ltd'처럼, 10·100이 'Ficti…0 Ltd'·'Fict…00 Ltd'처럼 번호의 뒷자리부터 보이고
  // 번호 2·5의 글에는 번호가 없음('Fictio… Ltd')(재현 커밋에서는 it.fails).
  // 앞자리 셋 이상이 같은 번호(2020·2021, 1001·1002, 100·1000 — 검토 지적)는 폭 66에서 앞부분 몫(폭의 30%) 때문에 '…202…'처럼 번호가 다 들지 않아
  // 갈리는 바로 그 글자부터('Fi…0 L…'·'Fi…1 L…') 보였음 — 이제 앞부분을 첫 글자 하나로 줄여 번호를 통째로('F…2020…').
  it("첫 자리가 같은 번호가 여럿인 법인명 묶음 — '…' 바로 뒤에 번호가 통째로(뒷자리만·앞자리만 보여 다른 번호로 읽히지 않음)", () => {
    const sets = [[1, 12, 13], [2, 21, 22, 23], [10, 11, 100], [5, 51, 52], [2020, 2021], [1001, 1002], [100, 1000], [10, 1009], [1, 1000, 1001]];
    for (const numbers of sets) {
      const numbered = numbers.map((n) => `Fictional Example Semiconductor Holdings ${n} Ltd`);
      const names = ["Fictional Graphics Example Holdings Ltd", ...numbered];
      for (const maxPx of [66, 72, 80, 87, 93, 95, 101, 116]) {
        const labels = graphLabels(names, maxPx);
        numbered.forEach((name, at) => {
          const label = labels.get(name)!;
          const shown = numbersAfterEllipsis(label);
          expect([maxPx, label, shown.length > 0 && shown.every((digits) => digits === String(numbers[at]))]).toEqual([maxPx, label, true]);
        });
        expect(new Set(labels.values()).size).toBe(names.length);
      }
    }
  });

  // 검토 지적: 그림 폭 280~309(320·390 화면, 배정 66)에서 연도·네 자리 번호가 든 이름이 'Ex…0 L…'·'Ex…1 L…'(2020·2021), 'Ex…3 LP'·'Ex…4 LP'
  // (2023·2024), 'Sa…2 B…'·'Sa…100…'(2·1002)로 그려져 번호가 다른 번호로 읽혔음(수정 전 61d09c59의 출력).
  it("좁은 그림(폭 280·300)의 연도·네 자리 번호 이름 — 노드 글에 번호가 통째로", () => {
    const pairs = [
      ["Example Funding 2020 Ltd", "Example Funding 2021 Ltd"],
      ["Example Capital Fund 2023 LP", "Example Capital Fund 2024 LP"],
      ["Example Semiconductor Holdings 1001 Ltd", "Example Semiconductor Holdings 1002 Ltd"],
      ["Sample Holdings Trust Series 2 B.V.", "Sample Holdings Trust Series 1002 LTD"],
    ];
    for (const pair of pairs) {
      const links: SearchLink[] = pair.map((name) => ({ relation: "subsidiary", key: null, name, kind: "company", source: "gleif", detail: null }));
      for (const width of [280, 300]) {
        const layout = linkGraphLayout(linkGroups(links), linkGraphSize(width), { centerName: "Example Center Co." });
        for (const name of pair) {
          const label = layout.nodes.find((node) => node.link.name === name)!.label;
          expect([width, label, numbersAfterEllipsis(label)]).toEqual([width, label, [name.match(/ (\d+) /)![1]]]);
        }
      }
    }
  });
});
