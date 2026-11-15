/**
 * 데이터 칸의 강조색 금지 — 데이터를 그리는 패턴과 차트 소스에 강조 파랑(accent 토큰)이 없는지 봅니다(작업대 실행 명세
 * docs/specs/2026-11-15-v2-workbench-ui.md §9-5, 원칙 A1 — ADR 0042 결정 3).
 * 강조 파랑(#4c90f0)은 누를 수 있는 것(주 단추·링크·현재 메뉴·포커스·알림 수)에만 씁니다. 하락 파랑(#68c1ee)과 OKLab ΔE 14.1로 색만으로 갈리지 않아
 * 값·변화·계열에 강조 파랑이 섞이면 '하락'으로 읽힐 수 있습니다. 고른 행·고른 칸 표시는 잉크(SELECTED_BAR — bg-text)와 중립 바탕(surface-2)으로,
 * 포커스는 focus 토큰(outline-focus)으로 그립니다 — focus는 강조 토큰이 아니라 이 검사에 걸리지 않습니다.
 *
 * 보는 것(문자열·템플릿 조각 — 주석은 구문 분석이 건너뜀):
 *  - 색을 받는 유틸리티의 색 이름이 accent·accent-hover·accent-fg·accent-tint(변형 접두어·중요 표시·투명도를 떼고) — text-accent·bg-accent-tint·
 *    hover:border-accent/40·stroke-accent·fill-accent 등.
 *  - CSS 변수 var(--accent…)·var(--color-accent…)(차트 SVG 속성에 넘기는 색).
 *  - 강조 토큰의 hex 값(globals.css :root의 --accent·--accent-hover — 토큰을 거치지 않고 값을 적은 것).
 *
 * 파일 목록(DATA_FILES)은 지금 있는 데이터 패턴·차트입니다. 명세 §9-5가 꼽은 KpiStrip·PropertyList·Timeline(과 그래프)은 아직 없습니다 — 그 부품이 들어오는
 * 단계(명세 §8-2 '새 부품을 만드는 단계' — P4·P5·P6·P7)에서 이 목록에 더합니다. 공용 표(DataTable)는 값 칸과 정렬 머리·누를 수 있는 행이 같은 파일에
 * 있어 파일 전체를 봅니다 — 누를 수 있는 부분도 데이터 영역이라 중립 바탕·밑줄·focus 링으로 그립니다.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../..");

/** 데이터를 그리는 패턴·차트(src 기준). 새 데이터 패턴은 들어오는 단계에서 여기에 더합니다(위 머리 주석). */
const DATA_FILES = [
  // 공용 표 — 값 칸(칸 글·'—'·태그), 정렬 머리, 고른 행 막대.
  "components/patterns/DataTable.tsx",
  // 지표 칸(값·변화·배지).
  "components/patterns/StatTile.tsx",
  // 자산 행(이름·값·변화 칩·스파크라인·고른 행 막대).
  "components/patterns/AssetRow.tsx",
  // 스파크라인(선 색은 등락·중립 토큰).
  "components/patterns/Sparkline.tsx",
  // 변화 칩(▲▼·부호·sr-only — 상승 빨강·하락 파랑).
  "components/patterns/ChangeChip.tsx",
  // 히어로(큰 값·판정 글·패널 차트 — P4·P6의 KpiStrip으로 바뀜).
  "components/patterns/Hero.tsx",
  // 추정·이전 값 배지·출처 캡션(값에 붙는 표지).
  "components/patterns/badges.tsx",
  // 차트(래퍼·선 차트·차트 틀 — 축·기준선·격자·툴팁·계열 색).
  "components/charts/index.tsx",
  "components/charts/LineChart.tsx",
  "components/charts/frame.tsx",
] as const;

const CSS = readFileSync(resolve(SRC, "app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const ROOT = /(?:^|[;}])\s*:root\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? "";
/** 강조 토큰의 hex 값 — :root의 --accent·--accent-hover(소문자). */
const ACCENT_HEXES = ["--accent", "--accent-hover"].map((name) => {
  const value = new RegExp(`${name}:\\s*(#[0-9a-f]{6});`, "i").exec(ROOT)?.[1];
  if (!value) throw new Error(`globals.css :root에서 ${name} 값을 찾지 못했습니다`);
  return value.toLowerCase();
});

/** 클래스 낱말 하나의 유틸리티 — 변형 접두어(대괄호·괄호 안의 콜론은 건너뜀)·중요 표시·투명도(/40)를 뗍니다. */
function utilityOf(token: string): string {
  let depth = 0;
  let cut = -1;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index];
    if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth -= 1;
    else if (char === ":" && depth === 0) cut = index;
  }
  return token.slice(cut + 1).replace(/^!|!$/g, "").replace(/\/[\w.[\]]+$/, "");
}

/** 강조 토큰을 색으로 받는 유틸리티(text-accent·bg-accent-tint·border-t-accent·accent-accent …). */
const ACCENT_UTILITY = /(^|-)accent(-hover|-fg|-tint)?$/;
/** 강조 토큰 CSS 변수(var(--accent)·var(--color-accent-hover) …). */
const ACCENT_VAR = /var\(\s*--(color-)?accent(-hover|-fg|-tint)?\s*[,)]/;

/** 글 하나에서 강조색으로 걸리는 것들. */
function accentIn(text: string): string[] {
  const found = text
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => ACCENT_UTILITY.test(utilityOf(token)));
  if (ACCENT_VAR.test(text)) found.push(ACCENT_VAR.exec(text)?.[0] ?? "var(--accent)");
  for (const hex of ACCENT_HEXES) if (text.toLowerCase().includes(hex)) found.push(hex);
  return found;
}

type TextPiece = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateHead | ts.TemplateMiddle | ts.TemplateTail;

function isTextPiece(node: ts.Node): node is TextPiece {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node);
}

/** 파일 하나의 강조색 자리 — "줄: 걸린 것". 주석은 건너뜁니다. */
function accentHits(fileName: string, text: string): string[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (isTextPiece(node)) {
      for (const found of accentIn(node.text)) {
        hits.push(`${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${found}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe("데이터 칸의 강조색 금지 — 소스 검사(명세 §9-5)", () => {
  it("검사기: 강조 토큰 클래스·변수·hex를 찾고, 주석·focus 토큰·비슷한 이름은 건너뛴다", () => {
    const sample = [
      'const a = "tabular-nums text-accent";',
      'const b = `p-2 ${on ? "hover:bg-accent-tint/60 border-t-accent" : "text-down"}`;',
      'const c = <line stroke="var(--accent)" fill="var(--color-accent-hover, #000)" />;',
      `const d = { color: "${ACCENT_HEXES[0].toUpperCase()}" };`,
      "// 주석의 text-accent는 건너뜀",
      'const e = "focus-visible:outline-focus text-down bg-surface-2 text-text-2 decoration-text-3";',
      'const f = "[&>svg]:fill-accent-fg";',
    ].join("\n");
    expect(accentHits("sample.tsx", sample)).toEqual([
      "1: text-accent",
      "2: hover:bg-accent-tint/60",
      "2: border-t-accent",
      "3: var(--accent)",
      "3: var(--color-accent-hover,",
      `4: ${ACCENT_HEXES[0]}`,
      "7: [&>svg]:fill-accent-fg",
    ]);
  });

  it("목록의 파일이 모두 있다(옮기거나 이름을 바꾸면 목록을 고친다)", () => {
    for (const file of DATA_FILES) expect(existsSync(resolve(SRC, file)), file).toBe(true);
  });

  it.each(DATA_FILES)("%s에 강조 파랑(accent 토큰·변수·hex)이 없다", (file) => {
    expect(accentHits(file, readFileSync(resolve(SRC, file), "utf8"))).toEqual([]);
  });
});
