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
 * 파일 목록(DATA_FILES)은 지금 있는 데이터 패턴·차트입니다. 명세 §9-5가 꼽은 것 가운데 PropertyList·KpiStrip은 P4에서, Timeline은 P5a에서 더했고(검사 칸 틀
 * InspectorFrame도 P5a), 그래프는 그 부품이 들어오는 단계(명세 §8-2 '새 부품을 만드는 단계' — P5·P7)에서 이 목록에 더합니다. 공용 표(DataTable)는 값 칸과 정렬 머리·누를 수 있는 행이 같은 파일에
 * 있어 파일 전체를 봅니다 — 누를 수 있는 부분도 데이터 영역이라 중립 바탕·밑줄·focus 링으로 그립니다.
 * 공용 키트(components/ui/index.tsx)는 단추·링크(강조 파랑을 쓰는 것)와 한 파일이라 파일 전체가 아니라 데이터를 그리는 함수 몸통만 봅니다(DATA_FUNCTIONS) —
 * 명세 §6이 DenseTable의 '지금'으로 꼽은 Table과 KpiStrip의 '지금'인 Metric(과 그 변화 값 색을 정하는 lib/format의 deltaColor). 화면 대부분이 이 둘을 씁니다.
 * 함수 몸통 안에서 부르는 다른 함수(EmptyState·SourceLine 등)의 몸통은 보지 않습니다(한계).
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
  // 속성 목록(이름-값 줄 — 값·'—'·배지·고정폭 식별자·줄 출처, P4).
  "components/patterns/PropertyList.tsx",
  // KPI 띠(타일 값·변화 칩·상태 글·배지·대상 링크 타일, P4).
  "components/patterns/KpiStrip.tsx",
  // 대상 머리(주 값·종류·식별자 태그·배지 줄 — 동작은 부르는 쪽이 넘김, P4).
  "components/patterns/EntityHeader.tsx",
  // 목록-검사(줄 단추·고른 줄 막대·검사 칸 — 누르는 줄도 데이터 영역이라 중립 바탕·잉크 막대·focus 링, P4).
  "components/patterns/MasterDetail.tsx",
  // 검사 칸 틀(옆 검사 칸·대화상자·줄 단추 — 줄 단추도 데이터 칸이라 중립 잉크·밑줄·focus 링, P5a).
  "components/patterns/InspectorFrame.tsx",
  // 시각순 목록(시각 열·종류 태그·요약·배지 — 목록-검사 위, P5a 국면 판정 기록·P6 결정 로그).
  "components/patterns/Timeline.tsx",
  // 칸 틀(SplitPane, P4)은 넣지 않습니다 — 색 클래스 없이 칸 자리만 정하는 틀이고, 칸 안의 데이터는 위 패턴들이 그립니다.
  // 긴 화면 목차(SectionIndex, P5a)도 넣지 않습니다 — 같은 화면 절로 가는 내비(누를 수 있는 것)라 지금 칸 막대·가로 줄 밑줄이 강조 파랑이고(셸의 현재 메뉴와
  // 같은 규칙 — 원칙 A1), 데이터 칸이 없습니다(개수는 보조 글색).
  // 차트(래퍼·선 차트·차트 틀 — 축·기준선·격자·툴팁·계열 색).
  "components/charts/index.tsx",
  "components/charts/LineChart.tsx",
  "components/charts/frame.tsx",
] as const;

/**
 * 데이터를 그리는 부품이 강조 파랑을 쓰는 단추·링크와 한 파일에 있는 곳 — 그 이름의 함수 선언 몸통만 봅니다(위 머리 주석). P4에서 DenseTable·KpiStrip으로
 * 바뀌면 그 패턴 파일을 DATA_FILES에 더하고 여기서 뺍니다.
 */
const DATA_FUNCTIONS = [
  // 공용 키트의 표(값 칸·머리·행 hover)와 지표 칸(값·변화·캡션·출처 줄).
  { path: "components/ui/index.tsx", name: "Table" },
  { path: "components/ui/index.tsx", name: "Metric" },
  // 지표 칸 변화 값의 색(상승·하락·보합·없음).
  { path: "lib/format.ts", name: "deltaColor" },
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

function parse(fileName: string, text: string): ts.SourceFile {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
}

/** 노드 하나(파일 전체 또는 함수 몸통) 아래의 강조색 자리 — "줄: 걸린 것". 주석은 건너뜁니다. */
function accentHitsIn(source: ts.SourceFile, root: ts.Node): string[] {
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (isTextPiece(node)) {
      for (const found of accentIn(node.text)) {
        hits.push(`${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${found}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return hits;
}

/** 파일 하나의 강조색 자리. */
function accentHits(fileName: string, text: string): string[] {
  const source = parse(fileName, text);
  return accentHitsIn(source, source);
}

/** 파일 안에서 그 이름으로 선언한 함수(function 이름(…) {…}) — 모두. */
function functionsNamed(source: ts.SourceFile, name: string): ts.FunctionDeclaration[] {
  const found: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** 그 함수 몸통의 강조색 자리. 함수를 못 찾으면 멈춥니다(검사가 조용히 비지 않게). */
function functionAccentHits(fileName: string, text: string, name: string): string[] {
  const source = parse(fileName, text);
  const found = functionsNamed(source, name);
  if (found.length !== 1) throw new Error(`${fileName}에서 함수 ${name}을 한 번 찾아야 합니다(${found.length}번)`);
  return accentHitsIn(source, found[0]);
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

  it("검사기: 함수 몸통만 보고 같은 파일의 다른 함수(단추·링크)는 건너뛰며, 없는 함수는 멈춘다", () => {
    const sample = [
      'export function Table() { return <td className="tabular-nums text-accent" />; }',
      'export function Button() { return <button className="bg-accent text-accent-fg" />; }',
      'export function Metric() { return <div className="text-text" />; }',
    ].join("\n");
    expect(functionAccentHits("sample.tsx", sample, "Table")).toEqual(["1: text-accent"]);
    expect(functionAccentHits("sample.tsx", sample, "Metric")).toEqual([]);
    expect(() => functionAccentHits("sample.tsx", sample, "Hero")).toThrow(/Hero/);
  });

  it.each(DATA_FUNCTIONS)("$name 함수 몸통 — $path — 강조 파랑(accent 토큰·변수·hex)이 없다", ({ path, name }) => {
    expect(functionAccentHits(path, readFileSync(resolve(SRC, path), "utf8"), name)).toEqual([]);
  });
});
