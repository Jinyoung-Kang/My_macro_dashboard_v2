/**
 * 정보 검색 연결 그림 노드 글(계약 §9-3·§9-7)의 QA-423 후속 재현·고정 시험 — 대문자(라틴·키릴·그리스) 글자의 폭 어림, 둘째 차례 이후의 번호·낱말 물림, 다시
 * 줄여도 가르는 낱말이 남는 한글 법인명(QA 재확인 개선 제안). 순수 함수(fitGraphLabel·graphLabels·linkGraphLayout)를 숫자로 대조합니다. 표본은 모두 합성
 * 값입니다(실제 법인·사람의 이름을 쓰지 않음).
 */
import { describe, expect, it } from "vitest";
import { fitGraphLabel, graphLabels, linkGraphLayout, linkGraphSize, linkGroups } from "@/lib/infoSearch";
import type { SearchLink } from "@/lib/types";

/**
 * 12px 글자의 실제 폭 상한(px) — 화면 글꼴 스택(globals.css --font-sans: Pretendard, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)에서
 * 쓰일 수 있는 글꼴 여섯(Pretendard Regular, Segoe UI, Arial, Liberation Sans, DejaVu Sans, 맑은 고딕)의 글자 전진 폭을 글꼴 파일에서 읽어, 글자마다
 * 가장 넓은 값을 0.1px 올림한 표입니다(대문자 M 11.1·W 11.9, 그 밖의 대문자 3.6~9.5). QA 브라우저 실측(M 10, W 11.33, A·E 8.02 — Arial·Liberation
 * Sans의 폭과 같음)보다 넓거나 같습니다. 한글·한자·가나·전각과 말줄임표 '…'는 12(QA-423 후속 실측). 키릴·그리스 대문자와 Æ·Œ·따옴표도 같은
 * 방법으로 읽었습니다(키릴 Щ 13.2·Ж·Ю 13.0·Ш 12.9 — DejaVu Sans, 검토 지적). 키릴·그리스 글자 가운데 라틴 글자와 모양이 같은 것(А·Α 등)도 코드
 * 포인트가 달라 따로 적습니다. 표에 없는 글자(소문자 등)는 이 시험의 이름에 쓰지 않습니다.
 */
const MEASURED: Readonly<Record<string, number>> = {
  A: 8.3, B: 8.3, C: 8.7, D: 9.3, E: 8.1, F: 7.4, G: 9.4, H: 9.1, I: 3.6, J: 6.2, K: 8.1, L: 6.7, M: 11.1,
  N: 9.2, O: 9.5, P: 8.1, Q: 9.5, R: 8.7, S: 8.1, T: 7.4, U: 8.8, V: 8.3, W: 11.9, X: 8.3, Y: 8.1, Z: 8.3,
  "0": 7.7, "1": 7.7, "2": 7.7, "3": 7.7, "4": 7.7, "5": 7.7, "6": 7.7, "7": 7.7, "8": 7.7, "9": 7.7,
  " ": 4.3, ",": 3.9, ".": 3.9, "&": 9.9, "-": 5.2, "'": 3.3, "(": 4.7, ")": 4.7, "/": 4.8,
  "\"": 5.6, "«": 7.4, "»": 7.4, Æ: 12.0, Œ: 12.9,
  // 키릴 대문자(U+0410~U+042F, Ё).
  А: 8.3, Б: 8.3, В: 8.3, Г: 7.4, Д: 9.4, Е: 8.1, Ё: 8.1, Ж: 13.0, З: 7.7, И: 9.2, Й: 9.2, К: 8.6, Л: 9.1, М: 11.1, Н: 9.1, О: 9.5,
  П: 9.1, Р: 8.1, С: 8.7, Т: 7.4, У: 7.7, Ф: 10.4, Х: 8.3, Ц: 9.4, Ч: 8.3, Ш: 12.9, Щ: 13.2, Ъ: 10.0, Ы: 10.7, Ь: 8.3, Э: 8.7, Ю: 13.0,
  Я: 8.7,
  // 그리스 대문자.
  Α: 8.3, Β: 8.3, Γ: 6.7, Δ: 8.3, Ε: 8.1, Ζ: 8.3, Η: 9.1, Θ: 9.5, Ι: 3.6, Κ: 8.1, Λ: 8.3, Μ: 11.1, Ν: 9.2, Ξ: 7.8, Ο: 9.5, Π: 9.1,
  Ρ: 8.1, Σ: 7.6, Τ: 7.4, Υ: 8.1, Φ: 9.6, Χ: 8.3, Ψ: 10.1, Ω: 9.3,
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

/**
 * 라틴이 아닌 대문자 이름 꼴(검토 지적) — GLEIF 법인명은 등록한 나라의 글자로 올 수 있어(러시아·그리스 등 — 실제 응답으로는 확인하지 못함), 키릴·
 * 그리스 대문자 법인명과 넓은 글자가 몰린 극단값, 라틴 Æ·Œ가 든 이름. 모두 합성 값입니다.
 */
const NON_LATIN_UPPER_NAMES = [
  "ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ \"ПРИМЕР ЭЛЕКТРОНИКС РУС\"",
  "ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ \"ВЫМЫШЛЕННЫЙ СЕРВИС\"",
  "АКЦИОНЕРНОЕ ОБЩЕСТВО \"ОБРАЗЕЦ ЖИЛИЩНЫЙ ФОНД\"",
  "ЖИЛИЩНО-ЭКСПЛУАТАЦИОННАЯ КОМПАНИЯ \"ПРИМЕР\"",
  "МЕЖДУНАРОДНЫЙ ЦЕНТР ОБРАЗЦА",
  "ООО «ОДНОДНЕВНЫЙ ОБРАЗЕЦ»",
  "ЩЮЖШ ЩЮЖШ ФЫЪМ",
  "ΠΑΡΑΔΕΙΓΜΑ ΨΗΦΙΑΚΗ ΜΟΝΟΠΡΟΣΩΠΗ Α.Ε.",
  "ŒUVRE ÆSTHETIC EXAMPLE SA",
];

describe("연결 그림 — 키릴·그리스 대문자 이름의 노드 글도 그린 폭이 배정 폭 안(QA-423 후속, 검토 지적)", () => {
  // 넓은 대문자 표가 라틴 M·W뿐이라 키릴 Ж·Ш·Щ·Ю(DejaVu Sans에서 12.8~13.1px)·М(10~11)·Ы·Ф를 9px로 세어, 폭 66에서 'ЖИЛИЩН…'이
  // DejaVu Sans로 74.0px(+8), 101에서 'ЖИЛИЩНО-ЭК…'이 104.7px로 그려졌음(검토에서 잰 값) — 뷰박스 가장자리 여유 4px를 넘으면 잘림.
  // 수정 전(6ac24a1e) 실패: 폭 66에서 'ЖИЛИЩН…'(잰 폭 상한 74.8)·'МЕЖДУН…'(70.4)·'ЩЮЖШ Щ…'(81.6)·'АКЦИОН…'(66.1)이 배정 폭을 넘음.
  it("키릴·그리스 대문자 이름을 폭 66·80·95·101·116에 맞추면 잰 글자 폭으로도 배정 폭 안이고, 서로 다른 이름은 서로 다른 글", () => {
    for (const maxPx of [66, 80, 95, 101, 116]) {
      const labels = graphLabels(NON_LATIN_UPPER_NAMES, maxPx);
      for (const [name, label] of labels) expect([maxPx, name, label, renderedWidth(label) <= maxPx]).toEqual([maxPx, name, label, true]);
      expect(new Set(labels.values()).size).toBe(NON_LATIN_UPPER_NAMES.length);
      for (const name of NON_LATIN_UPPER_NAMES) {
        const label = fitGraphLabel(name, maxPx);
        expect([maxPx, label, renderedWidth(label) <= maxPx]).toEqual([maxPx, label, true]);
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

/**
 * 노드 글이 그 이름으로 읽힐 수 있는가 — '…'로 나눈 조각이 이름 안에 차례로 있음(첫 조각은 앞머리, 끝에 '…'가 없으면 마지막 조각은 끝). 읽는 사람이 글만
 * 보고 이름을 짐작하는 방식.
 */
function readsAs(label: string, name: string): boolean {
  const parts = label.split("…");
  if (parts.length === 1) return label === name;
  if (!name.startsWith(parts[0])) return false;
  let at = parts[0].length;
  for (let index = 1; index < parts.length; index += 1) {
    if (parts[index] === "") continue;
    if (index === parts.length - 1) return name.endsWith(parts[index]) && name.length - parts[index].length >= at;
    const found = name.indexOf(parts[index], at);
    if (found < 0) return false;
    at = found + parts[index].length;
  }
  return true;
}

/**
 * 글만 보고 가를 수 없는 이름의 수 — 읽힐 수 있는 이름이 하나뿐인 글부터 그 이름에 붙이고 지우기를 되풀이한 뒤 남는 이름(글이 제 이름이 아닌 이름에
 * 붙으면 모두).
 */
function unresolvedCount(labels: ReadonlyMap<string, string>): number {
  const open = new Set(labels.keys());
  let progress = true;
  while (progress && open.size > 0) {
    progress = false;
    for (const owner of [...open]) {
      const candidates = [...open].filter((name) => readsAs(labels.get(owner)!, name));
      if (candidates.length !== 1) continue;
      if (candidates[0] !== owner) return labels.size;
      open.delete(owner);
      progress = true;
    }
  }
  return open.size;
}

/** 글만 보고 이름을 다 가를 수 있는가 — 모든 글이 제 이름에 붙음. */
const resolvable = (labels: ReadonlyMap<string, string>) => unresolvedCount(labels) === 0;

describe("연결 그림 — 다시 줄여도 가르는 낱말이 남는 한글 법인명 노드 글(QA 재확인 개선 제안)", () => {
  // QA 재확인(kr:005930 모의 — 390·1024·1280 화면): 글은 모두 서로 달랐지만, 둘째 차례 이후 다시 줄이면서 첫 차례에 보이던 가르는 낱말이 빠졌습니다 —
  // 배정 66에서 '가상전자디스플레이 주식회사'가 '가상전자…'(가상전자로 시작하는 다섯 이름과 맞음), '…글로벌반도체 주식회사'가 '가…주식…', '…주식회사
  // 베트남'이 '가… 베…', 80~83에서 '…글로벌반도체 주식회사'가 '가상…주식…', 87~101에서 '…베트남'이 '가상…주식회…'·'가상…주식회사…'(디스플레이도
  // 베트남도 없음). 낱말 경계(' 베트남')에서 갈리면 앞의 같은 낱말('주식회사')로 물리고, 갈린 뒤 보일 낱말이 없는 이름까지 새로 줄였기 때문입니다.
  // 이제 낱말 경계에서는 이어지는 이름을 다음 낱말부터 보이고, 가르는 낱말이 없는 이름 하나는 묶음 밖 이름들과 가른 글을 둡니다.
  // 바꾸기 전 실패: 배정 66·72·87·93·95·101에서 글만으로 이름을 다 가를 수 없고, 66~83·116 등에서 '글로'·'베트남'이 든 글이 아님.
  const KO = [
    "가상전자디스플레이 주식회사",
    "가상전자글로벌반도체 주식회사",
    "가상바이오로직스 주식회사",
    "가상전자디스플레이 주식회사 베트남",
    "가상전자글로벌반도체파운드리솔루션즈코리아",
    "가상전자로지텍",
  ];
  /** 이름마다 다른 이름들과 가르는 낱말의 앞부분 — 글에 들어 있어야 함. */
  const WORDS = ["디스", "글로", "바이", "베트남", "파운", "로"];
  /** 같은 그림에 함께 그려진 Wikidata·GLEIF 이름(QA 모의) — 섞여도 한글 이름의 글은 같음. */
  const OTHERS = [
    "Example Global Semiconductor Holdings Ltd",
    "Example Global Semiconductor Holdings 1 Ltd",
    "Example Global Semiconductor Holdings 12 Ltd",
    "김민수",
    "Alexander Fictional-Example Montgomery III",
    "Fictional Electronics America Incorporated",
    "Fictional Electronics Americas Incorporated",
  ];

  it("배정 66·80~83·93·101·116 — 가르는 낱말이 든 글(줄인 앞머리 + '…' + 갈리는 낱말)", () => {
    const expected: Record<number, string[]> = {
      66: ["가…디스…", "가…글로…", "가상바이…", "가…베트남", "가…파운…", "가…로지텍"],
      // 둔 글(디스플레이·글로벌반도체)은 가르는 낱말이 통째로 들지 않으면 앞부분을 첫 글자로 줄여 더 보임(검토 지적 — 80에서 '가상…글로…' 대신 '가…글로벌…').
      80: ["가…디스플…", "가…글로벌…", "가상바이오…", "가상…베트남", "가상…파운…", "가상전자로…"],
      93: ["가…디스플레…", "가…글로벌반…", "가상바이오로…", "가상전…베트남", "가상…파운드…", "가상전자로지텍"],
      101: ["가…디스플레이…", "가…글로벌반도…", "가상바이오로직…", "가상전자…베트남", "가상…파운드리…", "가상전자로지텍"],
      116: ["가상…디스플레이…", "가…글로벌반도체…", "가상바이오로직스…", "가상전자디…베트남", "가상…파운드리솔…", "가상전자로지텍"],
    };
    for (const px of [81, 82, 83]) expected[px] = expected[80];
    for (const [px, labels] of Object.entries(expected)) {
      for (const names of [KO, [...OTHERS, ...KO]]) {
        const got = graphLabels(names, Number(px));
        expect([px, KO.map((name) => got.get(name))]).toEqual([px, labels]);
      }
    }
  });

  it("둔 글은 가르는 낱말을 앞부분 몫보다 먼저 — 배정 80~83에서 '글로벌', 101부터 '디스플레이', 116에서 '글로벌반도체'가 통째로(검토 지적)", () => {
    // 검토 지적: 배정 80~83의 '가상전자글로벌반도체 주식회사'가 '가상…글로…'라 '글로벌'이 통째로 보이지 않았습니다 — 앞부분(폭의 30%, '가상')이 뒷부분
    // 몫을 먹음. 묶음 밖 이름들과 가르는 자리부터의 낱말이 통째로 들지 않으면 앞부분을 첫 글자로 줄입니다(줄인 앞머리는 모든 이름에서 같은 '가상'이라
    // 가르는 데 쓰이지 않음). 바꾸기 전 실패: 80~83 '가상…글로…', 101 '가상…디스플레…', 116 '가상…글로벌반도…'.
    const cases: [number, string, string][] = [
      [80, "가상전자글로벌반도체 주식회사", "글로벌"],
      [81, "가상전자글로벌반도체 주식회사", "글로벌"],
      [82, "가상전자글로벌반도체 주식회사", "글로벌"],
      [83, "가상전자글로벌반도체 주식회사", "글로벌"],
      [101, "가상전자디스플레이 주식회사", "디스플레이"],
      [116, "가상전자디스플레이 주식회사", "디스플레이"],
      [116, "가상전자글로벌반도체 주식회사", "글로벌반도체"],
    ];
    for (const [px, name, word] of cases) {
      const label = graphLabels(KO, px).get(name)!;
      expect([px, label, label.includes(word), renderedWidth(label) <= px]).toEqual([px, label, true, true]);
    }
  });

  it("배정 66~116(그림의 모든 폭 — 이름 자리 80~130 − 14) 어디서나 — 글마다 가르는 낱말이 들고, 글만으로 이름을 다 가를 수 있으며, 서로 다르고 폭(12px 글자) 안", () => {
    for (let px = 66; px <= 116; px += 1) {
      for (const names of [KO, [...OTHERS, ...KO]]) {
        const labels = graphLabels(names, px);
        KO.forEach((name, at) => {
          const label = labels.get(name)!;
          expect([px, label, label.includes(WORDS[at]), Array.from(label).length * 12 <= px]).toEqual([px, label, true, true]);
        });
        expect([px, resolvable(labels)]).toEqual([px, true]);
        expect(new Set(labels.values()).size).toBe(labels.size);
      }
    }
  });

  it("낱말 경계에서 갈리면 끝나는 이름은 끝 낱말로('…Ltd'), 이어지는 이름은 다음 낱말부터('…Asia'·'…Europe')", () => {
    const names = ["Example Holdings Ltd", "Example Holdings Ltd Asia", "Example Holdings Ltd Europe", "Example Group"];
    for (const px of [93, 101, 116]) {
      const labels = graphLabels(names, px);
      expect(labels.get(names[0])).toMatch(/…Ltd$/);
      expect(labels.get(names[1])).toMatch(/…Asia$/);
      expect(labels.get(names[2])).toMatch(/…Europe$/);
      expect(resolvable(labels)).toBe(true);
    }
  });
});

describe("연결 그림 — 지킬 글이 다른 묶음과 번갈아 바뀌지 않고, 기본 글보다 가르기 어려워지지 않음(검토 지적)", () => {
  // 검토 지적: 지킬 글(묶음 밖 이름들과 가른 앞 차례의 글)을 둘 때 다른 이름의 새 글이 묶음 밖 이름이 쓰는 글과 같아지는 것을 막지 않아, 다음 차례에
  // 그 둘을 다시 가르면 둔 글로 돌아오고 두 묶음이 차례마다 같은 글을 주고받다 상한(8차례)에 닿았습니다 — 마지막 겹침 풀기가 '샘플그룹…'·'예시금융…'처럼
  // 모든 이름과 맞는 글을 줘, 바꾸기 전(기본 글)에는 글만으로 다 가를 수 있던 묶음을 가를 수 없게 됐습니다. 또 지킬 글을 둘 조건(다른 이름들의 글이 그
  // 이름으로 읽히지 않음)을 그 차례에 한 번만 봐, 다음 차례에 상대 이름의 글이 바뀌어 그 이름으로도 읽히게 돼도('가상전자글…') 그대로 뒀습니다.
  // 바꾸기 전 실패: 아래 세 묶음에서 가를 수 없는 이름이 3·3·2개.
  it("두 묶음이 같은 글을 주고받던 이름들 — 기본 글처럼 글만으로 다 가름", () => {
    const sample = ["샘플그룹디스플레이 아메리카", "샘플그룹바이오로직스생명과학 아메리카", "샘플그룹디스플레이전자 주식회사 베트남", "샘플그룹전자 주식회사 미국"];
    const got = graphLabels(sample, 66);
    expect(sample.map((name) => got.get(name))).toEqual(["샘…아메…", "샘…바이…", "샘…디스…", "샘…전자…"]);
    const finance = [
      "예시금융지주파운드리솔루션즈 홀딩스",
      "예시금융지주증권 홀딩스",
      "예시금융지주중공업파운드리솔루션즈",
      "예시금융지주바이오로직스 주식회사 베트남",
      "예시금융지주중공업 주식회사 베트남",
      "예시금융지주 유한회사",
    ];
    for (const px of [66, 72, 80, 87, 95]) {
      const labels = graphLabels(finance, px);
      expect([px, resolvable(labels)]).toEqual([px, true]);
      expect([px, finance.filter((name) => finance.every((other) => readsAs(labels.get(name)!, other)))]).toEqual([px, []]);
    }
  });

  it("지킬 글을 둔 뒤 상대 이름의 글이 그 이름으로도 읽히게 되면 지킬 글을 거둠 — 한글 표본 + '가상전자로지텍파운드리솔루션즈'", () => {
    const names = [
      "가상전자디스플레이 주식회사",
      "가상전자글로벌반도체 주식회사",
      "가상바이오로직스 주식회사",
      "가상전자디스플레이 주식회사 베트남",
      "가상전자글로벌반도체파운드리솔루션즈코리아",
      "가상전자로지텍",
      "가상전자로지텍파운드리솔루션즈",
    ];
    for (const px of [80, 81, 82, 83]) {
      const labels = graphLabels(names, px);
      expect([px, resolvable(labels), new Set(labels.values()).size]).toEqual([px, true, names.length]);
      expect(labels.get("가상전자디스플레이 주식회사 베트남")).toBe("가상…베트남");
    }
  });

  it("기본 글(refine: false)은 낱말 경계의 물림·지킬 글이 없는 글 — QA 재확인 때의 배정 66 글", () => {
    const names = ["가상전자디스플레이 주식회사", "가상전자글로벌반도체 주식회사", "가상바이오로직스 주식회사", "가상전자디스플레이 주식회사 베트남", "가상전자글로벌반도체파운드리솔루션즈코리아", "가상전자로지텍"];
    const plain = graphLabels(names, 66, { refine: false });
    expect(names.map((name) => plain.get(name))).toEqual(["가상전자…", "가…주식…", "가상바이…", "가… 베…", "가…파운…", "가…로지텍"]);
  });

  it("앞머리를 함께 쓰는 한글 이름 묶음 무작위 240개 x 배정 7개 — 글이 서로 다르고 폭 안이며, 글만으로 가를 수 없는 이름이 기본 글보다 많지 않음", () => {
    // 시드를 정한 의사 난수(mulberry32) — 늘 같은 묶음.
    let seed = 20261115;
    const random = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)];
    const HEADS = ["가상전자", "샘플그룹", "예시금융지주", "가상"];
    const WORDS = ["디스플레이", "글로벌반도체", "바이오로직스", "로지텍", "중공업", "파운드리솔루션즈", "증권", "전자", "생명과학", "디스플레이전자", "글로벌"];
    const TAILS = [" 주식회사", " 홀딩스", " 아메리카", " 베트남", " 미국", " 유한회사", " 주식회사 베트남", " 주식회사 미국", "", ""];
    for (let index = 0; index < 240; index += 1) {
      const head = pick(HEADS);
      const size = 3 + Math.floor(random() * 5);
      const names = new Set<string>();
      while (names.size < size) {
        let name = random() < 0.8 ? head : pick(HEADS);
        for (let count = Math.floor(random() * 3); count > 0; count -= 1) name += pick(WORDS);
        names.add(`${name}${pick(TAILS)}`);
      }
      for (const px of [66, 72, 80, 87, 93, 101, 116]) {
        const labels = graphLabels([...names], px);
        const plain = graphLabels([...names], px, { refine: false });
        expect(new Set(labels.values()).size).toBe(names.size);
        for (const label of labels.values()) expect([px, label, renderedWidth(label) <= px]).toEqual([px, label, true]);
        expect([px, [...names], unresolvedCount(labels) <= unresolvedCount(plain)]).toEqual([px, [...names], true]);
      }
    }
  });
});
