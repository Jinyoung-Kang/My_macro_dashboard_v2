/**
 * 화면 소스에 이모지가 다시 들어오지 않게 지킵니다(명세 docs/specs/2026-10-31-v2-coinbase-ui.md §8-5, 결정 D8 g).
 *
 * 화면은 이모지 대신 components/ui/icons의 인라인 SVG 아이콘과 글을 씁니다(원칙 A7). 이 시험은 TypeScript AST
 * (createSourceFile)로 src의 .ts·.tsx(시험·자가 검증 폴더 제외)에서 화면에 나갈 수 있는 글 — 문자열 리터럴·템플릿 조각·
 * JSX 글 — 만 봅니다. 주석과 정규식 리터럴은 건너뜁니다(날 스캐너는 정규식과 나눗셈을 가르지 못함). 서버·DB에서 오는 글은
 * 여기서 지킬 수 없어 화면이 lib/format.withoutLeadingIcon으로 정리합니다.
 *
 * 찾는 글자: 그림 문자(Extended_Pictographic — 이형 선택자 없는 경고 삼각형 U+26A0도 포함), 지역 표시 문자(국기),
 * 이형 선택자 U+FE0F, 결합자 U+200D. 글자 기호로 쓰는 것(▲▼·화살표·체크·⌘·↔·↕·▪·©)은 허용합니다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../..");
const SKIP_DIRS = new Set(["__tests__", "__checks__", "node_modules"]);
const PICTOGRAPH = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}]/u;
/** 그림 문자 속성이 있거나 비슷해 보여도 글자 기호로 쓰는 것. */
const ALLOWED = new Set([..."▲▼↑↓↕→←↻✓✗⌘↔▪©"]);

/** 한 파일의 글에서 허용 목록 밖의 그림 문자를 찾습니다 — "줄: 코드 포인트 · 글 앞부분". */
function pictographsIn(fileName: string, text: string): string[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const value =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) || ts.isJsxText(node)
        ? node.text
        : null;
    if (value) {
      const bad = [...value].filter((char) => PICTOGRAPH.test(char) && !ALLOWED.has(char));
      if (bad.length > 0) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        const codes = bad.map((char) => `U+${char.codePointAt(0)?.toString(16).toUpperCase()}`).join(",");
        found.push(`${line + 1}: ${codes} · ${value.replace(/\s+/g, " ").trim().slice(0, 40)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) sourceFiles(path, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

describe("화면 소스에 이모지가 없다", () => {
  it("src의 문자열·템플릿·JSX 글에 그림 문자·국기·이형 선택자가 없다(주석·정규식 제외, 글자 기호 허용)", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.flatMap((path) =>
      pictographsIn(path, readFileSync(path, "utf8")).map((hit) => `${relative(SRC, path)}:${hit}`));
    expect(offenders).toEqual([]);
  });

  it("검사기 자체 — 문자열·템플릿·JSX 글·속성 값의 기호를 찾고, 주석·정규식·허용한 글자 기호는 건너뛴다", () => {
    const sample = [
      "// 주석의 ⚠️는 건너뜀",
      "const plain = \"정상 ▲ 1.2% ✓ ↔ ↕ ▪ © → ⌘\";",
      "const warn = \"\\u26A0 바로\";",              // 이형 선택자 없는 경고 삼각형(이스케이프도 실제 글자로 봄)
      "const flag = `기관 ${name} 🇺🇸`;",
      "const re = /[🟢🔴]/u;",
      "const ratio = a / b / c;",
      "export const View = () => <p title=\"🔒\">🧪 실험</p>;",
    ].join("\n");
    const hits = pictographsIn("sample.tsx", sample);
    expect(hits.map((hit) => hit.split(":")[0])).toEqual(["3", "4", "7", "7"]);
    expect(hits[0]).toContain("U+26A0");
    expect(hits[1]).toContain("U+1F1FA,U+1F1F8");
  });
});
