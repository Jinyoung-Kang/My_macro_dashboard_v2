/**
 * 정보 검색 연결 그림 노드 글(계약 §9-3·§9-7)의 QA-423 후속 재현·고정 시험 — 대문자 라틴 글자의 폭 어림. 순수 함수(fitGraphLabel·graphLabels·
 * linkGraphLayout)를 숫자로 대조합니다. 표본은 모두 합성 값입니다(실제 법인·사람의 이름을 쓰지 않음).
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
