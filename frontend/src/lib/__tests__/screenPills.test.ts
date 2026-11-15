/**
 * 화면(components/screens·app)에 알약 모양이 남지 않게 — 모서리는 4px 하나(rounded-control·rounded-card·rounded-sm)이고, rounded-full은 상태 점·
 * 토글 손잡이·아바타에만 씁니다(작업대 실행 명세 docs/specs/2026-11-15-v2-workbench-ui.md §3-8, ADR 0042 결정 4).
 * 화면 쪽에서 rounded-full이 허용되는 것은 상태 점뿐이라(아바타·토글은 공용 부품이 그림), 같은 클래스 글에 12px 이하 정사각 크기
 * (size-N 또는 h-N과 w-N, N ≤ 3)가 함께 있어야 통과합니다. 공용 키트·패턴·셸·차트의 모양은 그 단계의 시험이 봅니다.
 * 문자열·템플릿 조각 하나 안의 클래스를 봅니다(변수로 나눠 붙인 클래스는 보지 않음 — themeTokens.test.ts의 소스 검사와 같은 한계).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../..");
const SCREEN_DIRS = [resolve(SRC, "components/screens"), resolve(SRC, "app")];
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

/** 변형 접두어(hover: 등)를 뗀 유틸리티 이름들. */
function utilities(text: string): string[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.slice(token.lastIndexOf(":") + 1).replace(/^!|!$/g, ""));
}

/** 클래스 글이 12px 이하 정사각 점인가 — size-N 또는 h-N·w-N(N ≤ 3, 간격 단위 4px). */
function isDot(names: string[]): boolean {
  const small = (prefix: string) => names.some((name) => new RegExp(`^${prefix}-(0\\.5|1|1\\.5|2|2\\.5|3)$`).test(name));
  return small("size") || (small("h") && small("w"));
}

/** rounded-full이 점이 아닌 자리에 붙은 글 — "파일:줄: 클래스 글". */
function pillHits(fileName: string, text: string): string[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  return textPieces(source)
    .filter((piece) => {
      const names = utilities(piece.text);
      return names.includes("rounded-full") && !isDot(names);
    })
    .map((piece) => `${source.getLineAndCharacterOfPosition(piece.getStart(source)).line + 1}: ${piece.text.trim()}`);
}

describe("화면의 알약 모양 — 소스 검사(명세 §3-8)", () => {
  it("검사기: 상태 점은 통과, 알약 배지·칩·단추는 걸린다", () => {
    expect(pillHits("a.tsx", 'const a = <span className="mt-1.5 size-2 shrink-0 rounded-full border border-text-3" />;')).toEqual([]);
    expect(pillHits("a.tsx", 'const a = <span className="h-2 w-2 rounded-full" />;')).toEqual([]);
    expect(pillHits("a.tsx", 'const a = <span className="rounded-full border px-2 py-px text-xs" />;')).toHaveLength(1);
    expect(pillHits("a.tsx", "const a = `whitespace-nowrap hover:rounded-full ${tone}`;")).toHaveLength(1);
    expect(pillHits("a.tsx", 'const a = <span className="size-8 rounded-full" />;')).toHaveLength(1);
  });

  it("components/screens·app에는 상태 점 말고 rounded-full이 없다", () => {
    const hits = SCREEN_DIRS.flatMap((dir) => sourceFiles(dir)).flatMap((path) =>
      pillHits(path, readFileSync(path, "utf8")).map((hit) => `${relative(SRC, path)}:${hit}`),
    );
    expect(hits).toEqual([]);
  });
});
