import { describe, expect, it } from "vitest";
import {
  isNumericCell, numericColumns, parseInline, parseMarkdown, sectionKind, sectionName, splitRow, splitSections, splitVerdicts,
} from "../markdown";

const REPORT = `## 1. 핵심 요약
- **[금리]** 실질금리가 높습니다 (2.91%)
- **[유동성]** 순유동성 5.792조 달러

## 2. 데이터 신뢰도
| 항목 | 상태 | 영향 |
|---|---|---|
| MOVE | ⚠️ 추정치 | 임계치 적용 안 함 |

## 3. 금리와 달러
문단 첫 줄
이어지는 줄

---
> 인용문`;

describe("parseMarkdown", () => {
  it("제목·목록·표·문단·구분선·인용을 읽는다", () => {
    const blocks = parseMarkdown(REPORT);
    expect(blocks.map((b) => b.type)).toEqual([
      "heading", "list", "heading", "table", "heading", "paragraph", "hr", "quote",
    ]);
    expect(blocks[1]).toEqual({
      type: "list", ordered: false,
      items: ["**[금리]** 실질금리가 높습니다 (2.91%)", "**[유동성]** 순유동성 5.792조 달러"],
    });
    expect(blocks[3]).toEqual({
      type: "table", header: ["항목", "상태", "영향"], rows: [["MOVE", "⚠️ 추정치", "임계치 적용 안 함"]],
    });
    expect(blocks[5]).toEqual({ type: "paragraph", text: "문단 첫 줄 이어지는 줄" });
  });

  it("구분선 줄이 없으면 파이프가 든 문장은 표가 아니다", () => {
    expect(parseMarkdown("A | B 비교")).toEqual([{ type: "paragraph", text: "A | B 비교" }]);
  });

  it("칸 수가 다른 행은 머리에 맞춘다 — 모자라면 빈 칸, 넘치면 마지막 칸에 합친다", () => {
    const [table] = parseMarkdown("| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |");
    expect(table).toEqual({ type: "table", header: ["a", "b", "c"], rows: [["1", "", ""], ["1", "2", "3 | 4"]] });
  });

  it("번호 목록과 코드 울타리", () => {
    expect(parseMarkdown("1. 첫째\n2) 둘째")).toEqual([{ type: "list", ordered: true, items: ["첫째", "둘째"] }]);
    expect(parseMarkdown("```\n안의 줄\n```")).toEqual([{ type: "paragraph", text: "안의 줄" }]);
  });

  it("HTML은 해석하지 않고 글자로 남긴다", () => {
    expect(parseMarkdown("<script>alert(1)</script>")).toEqual([
      { type: "paragraph", text: "<script>alert(1)</script>" },
    ]);
  });

  it("빈 입력과 CRLF", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("## 제목\r\n본문")).toEqual([
      { type: "heading", level: 2, text: "제목" }, { type: "paragraph", text: "본문" },
    ]);
  });
});

describe("parseInline", () => {
  it("굵게와 코드를 나누고, 닫히지 않은 표시는 글자로 둔다", () => {
    expect(parseInline("**[금리]** 상승 `5.33%`")).toEqual([
      { text: "[금리]", bold: true }, { text: " 상승 " }, { text: "5.33%", code: true },
    ]);
    expect(parseInline("**닫히지 않음")).toEqual([{ text: "**닫히지 않음" }]);
  });
});

describe("splitSections", () => {
  it("## 기준으로 절을 나누고 번호를 뗀 이름을 붙인다", () => {
    const sections = splitSections(parseMarkdown(REPORT));
    expect(sections.map((s) => s.name)).toEqual(["핵심 요약", "데이터 신뢰도", "금리와 달러"]);
    expect(sections.map((s) => s.id)).toEqual(["section-1", "section-2", "section-3"]);
    expect(sections[0].blocks[0].type).toBe("list");
  });

  it("모델이 ###로 절을 쓰고 맨 위에 # 제목을 하나 두어도 같은 모양으로 나눈다", () => {
    const sections = splitSections(parseMarkdown("# 브리핑\n### 1. 핵심 요약\n- a\n### 2. 시나리오\n- b"));
    expect(sections.map((s) => s.title)).toEqual(["1. 핵심 요약", "2. 시나리오"]);
  });

  it("첫 제목 앞의 내용은 제목 없는 절로 남긴다", () => {
    const sections = splitSections(parseMarkdown("머리말\n## 1. 요약\n- a"));
    expect(sections[0]).toMatchObject({ title: null, blocks: [{ type: "paragraph", text: "머리말" }] });
  });

  it("제목이 하나도 없으면 한 절", () => {
    expect(splitSections(parseMarkdown("그냥 문단"))).toHaveLength(1);
  });
});

describe("절 이름과 종류", () => {
  it("번호를 떼고 요약·신뢰도를 알아본다", () => {
    expect(sectionName("1. 핵심 요약")).toBe("핵심 요약");
    expect(sectionName("② 시나리오")).toBe("시나리오");
    expect(sectionKind("핵심 요약")).toBe("summary");
    expect(sectionKind("데이터 신뢰도")).toBe("reliability");
    expect(sectionKind("시나리오")).toBe("normal");
    expect(splitRow("| a | b |")).toEqual(["a", "b"]);
  });
});

describe("숫자 열 판정", () => {
  it("두 단어 단위·부호·괄호 설명·방향 기호가 붙은 값도 숫자로 본다", () => {
    for (const cell of ["5.792조 달러", "-19.2억 달러", "+0.042%p", "1,339.98", "🔴 -2.83%", "-8,384계약", "**3.03**", "2.91% (10-06)"]) {
      expect(isNumericCell(cell), cell).toBe(true);
    }
    for (const cell of ["전 섹터 상위", "데이터 없음", "102.34 / 1,339.98", "🟢 정상", "10-07"]) {
      expect(isNumericCell(cell), cell).toBe(false);
    }
  });

  it("첫 열은 제외하고, 빈 칸은 무시하고, 한 칸이라도 글이면 그 열은 왼쪽", () => {
    expect(numericColumns(["지표", "값", "의미"], [["A", "5.792조 달러", "설명"], ["B", "", "설명"], ["C", "-0.09", "설명"]]))
      .toEqual([false, true, false]);
    expect(numericColumns(["지표", "값"], [["A", "1.0"], ["B", "데이터 없음"]])).toEqual([false, false]);
  });
});

describe("QA-100 제목·표 구분선 해석은 줄 길이에 선형", () => {
  // 바꾼 해석기가 예전 정규식과 같은 결과를 내는지 — 경계(꼬리의 #·공백, 공백만 남은 제목, # 다섯 개)까지 고정합니다.
  it("제목 판정은 예전과 같다", () => {
    const cases: [string, unknown][] = [
      ["### 제목 ###", { type: "heading", level: 3, text: "제목" }],
      ["## C#", { type: "heading", level: 2, text: "C" }],
      ["## 제목#", { type: "heading", level: 2, text: "제목" }],
      ["## a # b ##  ", { type: "heading", level: 2, text: "a # b" }],
      ["#### 넷 ####", { type: "heading", level: 4, text: "넷" }],
      ["#\t탭 제목\t#", { type: "heading", level: 1, text: "탭 제목" }],
      ["#\u3000전각 공백", { type: "heading", level: 1, text: "전각 공백" }],
      ["# #", { type: "heading", level: 1, text: "#" }],
      ["# ###", { type: "heading", level: 1, text: "#" }],
      ["#  ", { type: "heading", level: 1, text: "" }],
      ["# ", { type: "paragraph", text: "#" }],
      ["#nospace", { type: "paragraph", text: "#nospace" }],
      ["##### 다섯", { type: "paragraph", text: "##### 다섯" }],
      ["  ## 앞에 공백", { type: "paragraph", text: "## 앞에 공백" }],
    ];
    for (const [line, block] of cases) {
      expect(parseMarkdown(line), JSON.stringify(line)).toEqual([block]);
    }
  });

  it("표 구분선 판정은 예전과 같다", () => {
    const table = (divider: string) => parseMarkdown(`| a | b |\n${divider}\n| 1 | 2 |`)[0].type;
    expect(table("|---|---|")).toBe("table");
    expect(table("| :-- | --: |")).toBe("table");
    expect(table("  |:--:|  ")).toBe("table");
    expect(table("--- | ---")).toBe("table");
    expect(table("|--|")).toBe("table");
    expect(table("| - | - |")).toBe("paragraph");
    expect(table("|---|x|")).toBe("paragraph");
    expect(table("||")).toBe("paragraph");
  });

  // 수정 전에는 게으른 `.+?` 뒤의 `\s*#*\s*`가 3제곱으로 역추적해, 공백 1,500칸 제목 줄 하나에 약 2초가 걸렸다
  // (4,000칸이면 수십 초). 생성 중에는 경과 초 표시 때문에 1초마다 다시 해석해 탭이 멈췄다.
  it("공백이 길게 이어진 제목 줄도 바로 해석한다", () => {
    // 1,500칸은 수정 전 재현용(수정 전 약 2초), 4,000·20,000칸은 수정 뒤에도 줄 길이에 선형인지 봅니다.
    for (const spaces of [1500, 4000, 20000]) {
      const text = "1. 핵심 요약" + " ".repeat(spaces) + "x";
      const started = performance.now();
      const blocks = parseMarkdown(`## ${text}`);
      expect(performance.now() - started, `${spaces}칸`).toBeLessThan(50);
      expect(blocks).toEqual([{ type: "heading", level: 2, text }]);
    }
  });

  // 수정 전에는 구분선 정규식의 이웃한 `\s*\|?\s*`가 2제곱으로 역추적해, 표 머리 다음 줄의 공백 20,000칸에 1초 가까이 걸렸다.
  it("공백이 길게 이어진 표 구분선 후보 줄도 바로 판정한다", () => {
    const started = performance.now();
    const blocks = parseMarkdown("| a | b |\n|--" + " ".repeat(20000) + "x|");
    expect(performance.now() - started).toBeLessThan(50);
    expect(blocks.map((block) => block.type)).toEqual(["paragraph"]);
  });
});

describe("판정 기호 — 값의 방향이 아니라 우호·비우호·중립·보류(명세 D8 e)", () => {
  it("세 기호를 판정 조각으로, 나머지는 글 조각으로 — 기호 뒤 공백은 배지가 대신한다", () => {
    expect(splitVerdicts("🟢 정상")).toEqual([{ verdict: "favorable" }, { text: "정상" }]);
    expect(splitVerdicts("VIX 상승 → 🔴 -2.83%")).toEqual([{ text: "VIX 상승 → " }, { verdict: "unfavorable" }, { text: "-2.83%" }]);
    expect(splitVerdicts("⚪️ 판단 보류")).toEqual([{ verdict: "neutral" }, { text: "판단 보류" }]);
    expect(splitVerdicts("🟢🔴")).toEqual([{ verdict: "favorable" }, { verdict: "unfavorable" }]);
  });

  it("기호가 없으면 글 하나 그대로(빈 글도)", () => {
    expect(splitVerdicts("전 섹터 상위")).toEqual([{ text: "전 섹터 상위" }]);
    expect(splitVerdicts("")).toEqual([{ text: "" }]);
  });
});
