/**
 * 색 클래스는 globals.css의 토큰 이름만 씁니다(작업대 실행 명세 docs/specs/2026-11-15-v2-workbench-ui.md §3-2·§4 — 색은 CSS 변수 토큰으로만,
 * 원색 클래스 0). Tailwind는 모르는 색 이름(`border-line` 같은)을 오류 없이 건너뛰므로, 그 요소는 아무 색도 받지 못한 채 그려집니다 —
 * 테두리라면 CSS 기본값(currentColor, 곧 둘레 글자색)으로 칠해져 어두운 면 위에 밝은 선이 됩니다.
 *
 * 제품 소스(.ts·.tsx, 시험 제외)의 문자열·템플릿 조각에서 색을 받는 유틸리티(bg·text·border와 변 방향·divide·ring·ring-offset·outline·
 * fill·stroke·decoration·caret·accent·from·via·to)의 이름이 `@theme inline`의 `--color-*` 토큰이거나 CSS 낱말(transparent·current·inherit)인지
 * 봅니다. 변형 접두어(hover: 등)·중요 표시(!)·음수(-)·투명도(/50)는 떼고, 임의 값([…]·(…))과 숫자로 시작하는 이름(크기·굵기)은 색이 아니라 건너뜁니다.
 * 색이 아닌 낱말(text-center·bg-cover·border-dashed·outline-offset-2 등)은 접두어마다 아래 표로 거릅니다 — 새 낱말을 쓰다 걸리면 표에 더합니다.
 * 기본 팔레트(red-500 등)도 토큰이 아니라 걸립니다(밝은 한 벌을 다시 더할 때 토큰 블록만 늘면 되게).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../..");
const CSS = readFileSync(resolve(SRC, "app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** `@theme inline`의 색 토큰 이름(--color-surface-2 → surface-2). */
const COLOR_TOKENS = new Set([...CSS.matchAll(/--color-([\w-]+)\s*:/g)].map((match) => match[1]));
const CSS_KEYWORDS = new Set(["transparent", "current", "inherit"]);
/** `@theme`의 글자 단계 이름(--text-caption → caption) — 줄 높이·굵기 같은 딸린 값(--text-x--line-height)은 뺍니다. */
const TEXT_SIZES = [...CSS.matchAll(/--text-([\w-]+)\s*:/g)].map((match) => match[1]).filter((name) => !name.includes("--"));

/** 색을 받는 유틸리티 접두어와 그 접두어의 색이 아닌 낱말. 긴 접두어(ring-offset)를 먼저 봅니다. */
const FAMILIES: readonly { prefix: RegExp; notColor: RegExp }[] = [
  { prefix: /^ring-offset-/, notColor: /^$/ },
  { prefix: /^text-/, notColor: new RegExp(`^(xs|sm|base|lg|xl|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip|${TEXT_SIZES.join("|")})$`) },
  {
    prefix: /^bg-/,
    notColor:
      /^(none|fixed|local|scroll|auto|cover|contain|center|top|bottom|left|right|(left|right)-(top|bottom)|(top|bottom)-(left|right)|repeat(-.+)?|no-repeat|origin-.+|clip-.+|blend-.+|linear(-.+)?|radial(-.+)?|conic(-.+)?|gradient-.+|size-.+|position-.+)$/,
  },
  { prefix: /^border-((x|y|t|r|b|l|s|e|tl|tr|bl|br|ss|se|es|ee)-)?/, notColor: /^(x|y|t|r|b|l|s|e|solid|dashed|dotted|double|hidden|none|collapse|separate|spacing(-.+)?)$/ },
  { prefix: /^divide-/, notColor: /^(x|y|x-reverse|y-reverse|solid|dashed|dotted|double|hidden|none)$/ },
  { prefix: /^ring-/, notColor: /^(inset)$/ },
  { prefix: /^outline-/, notColor: /^(none|hidden|solid|dashed|dotted|double|offset-.+)$/ },
  { prefix: /^(fill|stroke)-/, notColor: /^(none)$/ },
  { prefix: /^decoration-/, notColor: /^(solid|double|dotted|dashed|wavy|from-font|auto|clone|slice)$/ },
  { prefix: /^(caret|accent)-/, notColor: /^(auto)$/ },
  { prefix: /^(from|via|to)-/, notColor: /^$/ },
];

/** 클래스 낱말 하나의 유틸리티 — 변형 접두어(대괄호 안의 콜론은 건너뜀)·중요 표시·음수 기호·투명도를 뗍니다. */
function utilityOf(token: string): string {
  let depth = 0;
  let cut = -1;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index];
    if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth -= 1;
    else if (char === ":" && depth === 0) cut = index;
  }
  return token
    .slice(cut + 1)
    .replace(/^!|!$/g, "")
    .replace(/^-/, "")
    .replace(/\/[\w.[\]]+$/, "");
}

/** 색 유틸리티인데 토큰이 아닌 이름이면 그 이름, 아니면 null. */
function unknownColor(token: string): string | null {
  const utility = utilityOf(token);
  for (const family of FAMILIES) {
    const prefix = family.prefix.exec(utility);
    if (!prefix) continue;
    const name = utility.slice(prefix[0].length);
    if (!/^[a-z]/.test(name) || family.notColor.test(name)) return null;
    return COLOR_TOKENS.has(name) || CSS_KEYWORDS.has(name) ? null : name;
  }
  return null;
}

type TextPiece = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateHead | ts.TemplateMiddle | ts.TemplateTail;

function textPieces(node: ts.Node, out: TextPiece[] = []): TextPiece[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
    out.push(node);
  }
  ts.forEachChild(node, (child) => {
    textPieces(child, out);
  });
  return out;
}

const SKIP_DIRS = new Set(["__tests__", "__checks__", "node_modules"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) sourceFiles(path, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

/** 제품 소스에서 토큰이 아닌 색 이름을 쓴 자리 — "파일:줄: 클래스". */
function offenders(): string[] {
  return sourceFiles(SRC).flatMap((path) => {
    const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, kind);
    return textPieces(source).flatMap((piece) =>
      piece.text
        .split(/\s+/)
        .filter((token) => token && unknownColor(token) !== null)
        .map((token) => `${relative(SRC, path)}:${source.getLineAndCharacterOfPosition(piece.getStart(source)).line + 1}: ${token}`),
    );
  });
}

describe("색 클래스 — 토큰 이름만(소스 검사)", () => {
  it("검사기: 토큰·CSS 낱말·색이 아닌 낱말은 통과, 모르는 이름과 기본 팔레트는 걸린다", () => {
    for (const ok of [
      "border-border",
      "hover:bg-surface-2",
      "bg-warn-tint",
      "border-warn/40",
      "text-text-3",
      "[&>svg]:text-accent",
      "border-t-border-subtle",
      "border-transparent",
      "text-xs",
      "text-[13px]",
      "text-caption",
      "text-heading-sm",
      "text-center",
      "border",
      "border-t",
      "border-x",
      "border-b-2",
      "border-dashed",
      "-outline-offset-2",
      "focus-visible:outline-focus",
      "bg-[color-mix(in_oklab,var(--text)_8%,var(--surface-2))]",
      "fill-current",
      "ring-offset-surface",
      "accent-accent",
    ]) {
      expect(unknownColor(ok), ok).toBeNull();
    }
    expect(unknownColor("border-line")).toBe("line");
    expect(unknownColor("lg:border-t-line")).toBe("line");
    expect(unknownColor("bg-black/50")).toBe("black");
    expect(unknownColor("text-red-500")).toBe("red-500");
    expect(unknownColor("hover:bg-muted")).toBe("muted");
  });

  // QA-471: 모의매매 결정 탭의 '장중 판단' 칸(components/screens/paper/IntradayPlansPanel.tsx)이 없는 토큰 `border-line`을 써서 테두리 색이
  // 나오지 않음 — 1px 테두리가 둘레 글자색(currentColor)으로 칠해져, 어두운 한 벌에서는 패널 경계(border #383e47)가 아니라 거의 흰 선(text #f6f7f9)이 됨.
  it.fails("QA-471: 제품 소스의 색 클래스는 모두 globals.css 토큰 이름이다", () => {
    expect(offenders()).toEqual([]);
  });
});
