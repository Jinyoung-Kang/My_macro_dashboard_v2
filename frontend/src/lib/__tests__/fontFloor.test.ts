/**
 * 글자 하한 12px(Coinbase 명세 docs/specs/2026-10-31-v2-coinbase-ui.md 원칙 A9·§2-3 표 — `text-micro` 12/16, 10·11px은 없앰. 작업대 화면 언어
 * 실행 명세 docs/specs/2026-11-15-v2-workbench-ui.md §9-2) — QA-457.
 *
 * src의 제품 소스(시험·자가 검증 폴더 제외)에서 소스에 적은 글자 크기 값(리터럴)을 보고, 12px보다 작아질 수 있는 값을 찾습니다. 허용 목록은 없습니다.
 *  - .ts·.tsx: TypeScript AST(createSourceFile)로 문자열·템플릿 조각 안의 임의 크기 클래스(`text-[11px]`·`lg:text-[0.7rem]`·
 *    `text-[0.8em]`·`text-[length:11px]`·`[font-size:11px]`)와, 이름이 글자 크기인 JSX 속성·객체 키·변수·구조 분해 기본값(`fontSize={10}`·
 *    `style={{ fontSize: "0.7rem" }}`·차트 `tick={{ fontSize: 10 }}`·`CHART_FONT = 12`·`CHART_FONT_SM`·`tickFontSize`)의 값을 봅니다.
 *    글자 크기 이름은 낱말(camelCase·snake_case·kebab-case로 가름)에 font가 있고 굵기·글꼴 이름 같은 다른 글꼴 속성 낱말(NOT_SIZE)이 없는 이름입니다.
 *    값은 리터럴과, 조건식의 두 갈래·`??`·`||`·`&&`의 양쪽(`compact ? 10 : 12`, `options.fontSize ?? 10`)까지 따라갑니다. 이름이 글자 크기인
 *    값 뒤의 기본값(`layout(w, options.fontSize ?? 10)`처럼 함수 인자 자리에 있어도)도 봅니다. 주석은 AST가 건너뜁니다.
 *  - .css: 주석을 지운 뒤 `font-size:` 선언, 글자 단계 변수(`--text-micro: 0.75rem` — `--text-*--line-height` 같은 딸린 값은 뺌),
 *    그리고 같은 임의 크기 클래스(@apply 등).
 *  - 한계: 변수·연산·함수 호출로 계산한 크기(`fontSize={base - 2}`·`Math.max(10, x)`)와 글자 크기 이름이 아닌 변수에 담은 값은 보지 않습니다.
 *    상수는 선언 자리에서 이름으로 잡으므로, 글자 크기를 담는 상수에는 font가 든 이름을 붙입니다.
 *
 * 하한 아래로 보는 값: px·단위 없음(React style·SVG의 숫자는 px) 12 미만, rem 0.75 미만, em·% 1(100%) 미만. em·%는 부모 크기에 따라
 * 달라져 소스만으로 12px 이상임을 증명할 수 없습니다 — 부모가 하한(12px)이면 그 아래로 내려갑니다. 실제로 13px 변화 칩 안의 0.8em ▲▼가
 * 10.4px였습니다(홈·모의 개요, QA-457). 변수·calc 같은 숫자가 아닌 값(`text-[var(--x)]`, 글자색 `text-[#fff]`)은 크기를 알 수 없어 보지 않습니다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../..");
const SKIP_DIRS = new Set(["__tests__", "__checks__", "node_modules"]);

type Unit = "px" | "rem" | "em" | "%" | "";

/** 크기 하나가 하한(12px) 아래로 내려갈 수 있는가. */
function belowFloor(value: number, unit: Unit): boolean {
  if (unit === "rem") return value < 0.75;
  if (unit === "em") return value < 1;
  if (unit === "%") return value < 100;
  return value < 12;
}

/** "11px"·"0.7rem"·"0.8em"·"80%"·"10" → 크기, 숫자가 아니면 null. */
function parseSize(text: string): { value: number; unit: Unit } | null {
  const match = /^\s*(\d*\.?\d+)(px|rem|em|%)?\s*$/.exec(text);
  return match ? { value: Number(match[1]), unit: (match[2] ?? "") as Unit } : null;
}

/** 글 안의 임의 크기 클래스(변형 접두어·! 포함)와 임의 속성 [font-size:…]. */
const SIZE_CLASS = /(?<![\w-])text-\[(?:length:)?(\d*\.?\d+)(px|rem|em|%)\]|\[font-size:(\d*\.?\d+)(px|rem|em|%)\]/g;

function classHits(text: string): string[] {
  return [...text.matchAll(SIZE_CLASS)]
    .filter((match) => belowFloor(Number(match[1] ?? match[3]), (match[2] ?? match[4]) as Unit))
    .map((match) => match[0]);
}

/** 글자 크기가 아닌 글꼴 속성 낱말 — 이름에 있으면 크기로 보지 않습니다(fontWeight·FONT_FAMILY·fontVariantNumeric·font line-height 등). */
const NOT_SIZE = new Set(["weight", "family", "style", "variant", "feature", "features", "stretch", "kerning", "synthesis", "smoothing", "display",
  "face", "color", "line", "spacing"]);

/** 이름을 소문자 낱말로 — camelCase·snake_case·kebab-case를 가릅니다(`tickFontSize` → tick·font·size, `CHART_FONT_SM` → chart·font·sm). */
function wordsOf(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_-]+/).filter(Boolean).map((word) => word.toLowerCase());
}

/** 글자 크기를 담는 이름 — 낱말에 font가 있고 다른 글꼴 속성 낱말은 없음(fontSize·font-size·tickFontSize·CHART_FONT·CHART_FONT_SM). */
function isFontName(name: string): boolean {
  const words = wordsOf(name);
  return words.includes("font") && !words.some((word) => NOT_SIZE.has(word));
}

function nameOf(name: ts.Node | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  return null;
}

/** 값을 읽는 식의 이름 — `fontSize`·`options.fontSize`·`opts!.fontSize` → fontSize, 아니면 null. */
function nameOfExpression(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return nameOfExpression(node.expression);
  return null;
}

/** 값이 갈래로 갈리는 연산자 — 양쪽 모두 값이 될 수 있습니다. */
const BRANCH_OPERATORS = new Set<ts.SyntaxKind>([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken]);

/**
 * 식이 낼 수 있는 리터럴 값(숫자·문자열·JSX의 {숫자}) — 조건식의 두 갈래와 ??·||·&&의 양쪽, 괄호·as·satisfies·!를 따라갑니다. 계산한 값은 없음([]).
 */
function literalsOf(node: ts.Node | undefined): string[] {
  if (!node) return [];
  if (ts.isJsxExpression(node)) return literalsOf(node.expression);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) {
    return literalsOf(node.expression);
  }
  if (ts.isNumericLiteral(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isConditionalExpression(node)) return [...literalsOf(node.whenTrue), ...literalsOf(node.whenFalse)];
  if (ts.isBinaryExpression(node) && BRANCH_OPERATORS.has(node.operatorToken.kind)) return [...literalsOf(node.left), ...literalsOf(node.right)];
  return [];
}

/** .ts·.tsx 한 파일에서 하한 아래의 글자 크기 — "줄: 찾은 글". */
function tsFontHits(fileName: string, text: string): string[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  // 같은 줄의 같은 값은 한 번만 — `fontSize: options.fontSize ?? 10`은 키와 기본값 두 규칙이 함께 잡습니다.
  const found = new Set<string>();
  const add = (node: ts.Node, hit: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.add(`${line + 1}: ${hit}`);
  };
  const check = (node: ts.Node, name: string | null, values: string[]) => {
    if (name === null || !isFontName(name)) return;
    for (const value of values) {
      const size = parseSize(value);
      if (size && belowFloor(size.value, size.unit)) add(node, `${name} ${value}`);
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)) {
      for (const hit of classHits(node.text)) add(node, hit);
    }
    if (ts.isJsxAttribute(node)) {
      check(node, nameOf(node.name), literalsOf(node.initializer));
    } else if (ts.isPropertyAssignment(node)) {
      check(node, nameOf(node.name), literalsOf(node.initializer));
    } else if (ts.isBindingElement(node) || ts.isParameter(node) || ts.isVariableDeclaration(node)) {
      check(node, nameOf(ts.isBindingElement(node) && node.propertyName ? node.propertyName : node.name), literalsOf(node.initializer));
    } else if (ts.isBinaryExpression(node) && BRANCH_OPERATORS.has(node.operatorToken.kind)) {
      // 글자 크기 값 뒤의 기본값 — 이름 붙은 자리가 아니어도(함수 인자 등) `options.fontSize ?? 10`의 10.
      check(node, nameOfExpression(node.left), literalsOf(node.right));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found];
}

/** .css 한 파일에서 하한 아래의 글자 크기 — 주석을 지우고(줄 수는 그대로) font-size 선언·글자 단계 변수·임의 크기 클래스. */
function cssFontHits(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  return code.split("\n").flatMap((line, index) => {
    const hits = [
      ...[...line.matchAll(/(?<![\w-])font-size\s*:\s*(\d*\.?\d+)(px|rem|em|%)/g)]
        .filter((match) => belowFloor(Number(match[1]), match[2] as Unit))
        .map((match) => match[0]),
      ...[...line.matchAll(/--text-([a-z0-9-]+)\s*:\s*(\d*\.?\d+)(px|rem|em)\b/g)]
        .filter((match) => !match[1].includes("--") && belowFloor(Number(match[2]), match[3] as Unit))
        .map((match) => match[0]),
      ...classHits(line),
    ];
    return hits.map((hit) => `${index + 1}: ${hit}`);
  });
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) sourceFiles(path, out);
    } else if (/\.(ts|tsx|css)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

function offenders(): string[] {
  const files = sourceFiles(SRC);
  expect(files.length).toBeGreaterThan(100);
  expect(files.some((path) => path.endsWith("globals.css"))).toBe(true);
  return files.flatMap((path) => {
    const text = readFileSync(path, "utf8");
    const hits = path.endsWith(".css") ? cssFontHits(text) : tsFontHits(path, text);
    return hits.map((hit) => `${relative(SRC, path)}:${hit}`);
  });
}

/** 제품 소스 전체를 읽는 검사의 시간 한도 — 바쁜 기계(병렬 시험)에서 5초 기본 한도를 넘긴 적이 있습니다. */
const SOURCE_SCAN_TIMEOUT_MS = 30_000;

describe("글자 하한 12px(QA-457)", () => {
  // 수정 전에는 네 곳이 걸렸다(재현 커밋에서는 it.fails):
  //  - components/patterns/ChangeChip.tsx — ▲▼ text-[0.8em](sm 13px 안에서 10.4px — 홈 27개·모의 개요 6개), 단위 text-[0.85em](sm에서 11.05px)
  //  - components/screens/detail/DetailParts.tsx — AI 요약 근거 번호 [n] 위첨자 text-[11px] 두 곳
  // 지금은 화살표·단위·위첨자 모두 text-xs(12px)다.
  // 제품 소스 전체를 구문 분석해 보통 1~2초 — 여러 시험이 함께 도는 바쁜 기계에서 기본 한도(5초)를 넘긴 적이 있어 한도만 넓힙니다(검사 내용 그대로).
  it("src의 글자 크기는 모두 12px 이상이다 — 허용 목록 없음", () => {
    expect(offenders()).toEqual([]);
  }, SOURCE_SCAN_TIMEOUT_MS);

  it("검사기 자체 — 클래스·글자 크기 이름의 속성·키·기본값·상수와 조건식·??·|| 갈래를 찾고, 주석·12px 이상·1em 이상·숫자가 아닌 값·다른 글꼴 속성은 건너뛴다", () => {
    const sample = [
      "// 주석의 text-[10px]는 건너뜀",
      "const a = \"px-2 text-[11px] lg:text-[13px]\";",
      "const b = `ml-1 ${x} lg:text-[0.7rem] text-[0.75rem]`;",
      "const c = \"text-[0.8em] text-[1em] text-[100%] text-[var(--x)] text-[#fff] text-[12px] text-micro\";",
      "export const View = () => <text fontSize={10} className=\"!text-[length:9px]\">a</text>;",
      "const d = { fontSize: \"0.7rem\", style: { fontSize: 11 } };",
      "function Tick({ fontSize = 10 }: { fontSize?: number }) { return fontSize; }",
      "export const CHART_FONT = 11;",
      "const e = { fontSize: CHART_FONT, lineHeight: 10, fontSize2: 8 };",
      "const f = \"[font-size:11px] [font-size:12px]\";",
      "const g = <svg><text fontSize=\"0.8em\" /><text fontSize={12} /></svg>;",
      "const h = <text fontSize={compact ? 10 : 12} />;",
      "const i = { fontSize: options.fontSize ?? 10, tick: layout(w, options.fontSize ?? 9), size: opts.fontSize || 12 };",
      "export const CHART_FONT_SM = 10, tickFontSize = 11 as number;",
      "const j = { fontWeight: 5, fontLineHeight: 1.2, fontVariantNumeric: \"tabular-nums\", fontSize: big ? 14 : CHART_FONT };",
    ].join("\n");
    expect(tsFontHits("sample.tsx", sample)).toEqual([
      "2: text-[11px]",
      "3: text-[0.7rem]",
      "4: text-[0.8em]",
      "5: fontSize 10",
      "5: text-[length:9px]",
      "6: fontSize 0.7rem",
      "6: fontSize 11",
      "7: fontSize 10",
      "8: CHART_FONT 11",
      "9: fontSize2 8",
      "10: [font-size:11px]",
      "11: fontSize 0.8em",
      "12: fontSize 10",
      "13: fontSize 10",
      "13: fontSize 9",
      "14: CHART_FONT_SM 10",
      "14: tickFontSize 11",
    ]);
  });

  it("검사기 자체(CSS) — 주석을 지우고 font-size·글자 단계 변수만, 딸린 값(--line-height·letter-spacing)과 색 토큰은 건너뛴다", () => {
    const css = [
      "/* 옛 text-[11px] 설명은 건너뜀",
      "   font-size: 9px도 */",
      ".a { font-size: 11px; }",
      ".b { font-size: 0.75rem; letter-spacing: -0.02em; }",
      "@theme { --text-tiny: 0.625rem; --text-micro: 0.75rem; --text-micro--line-height: 0.5rem; }",
      ":root { --text-3: #8f99a8; --text-display--letter-spacing: -0.02em; }",
      ".c { @apply text-[10px]; }",
    ].join("\n");
    expect(cssFontHits(css)).toEqual(["3: font-size: 11px", "5: --text-tiny: 0.625rem", "7: text-[10px]"]);
  });
});
