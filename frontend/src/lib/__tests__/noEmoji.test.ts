/**
 * 화면 소스에 이모지가 다시 들어오지 않게 지킵니다(명세 docs/specs/2026-10-31-v2-coinbase-ui.md §8-5, 결정 D8 g).
 *
 * 화면은 이모지 대신 components/ui/icons의 인라인 SVG 아이콘과 글을 씁니다(원칙 A7). 이 시험은 TypeScript AST
 * (createSourceFile)로 src의 .ts·.tsx(시험·자가 검증 폴더 제외)에서 화면에 나갈 수 있는 글 — 문자열 리터럴·템플릿 조각·
 * JSX 글 — 만 봅니다. 주석과 정규식 리터럴은 건너뜁니다(날 스캐너는 정규식과 나눗셈을 가르지 못함). 서버·DB에서 오는 글은
 * 여기서 지킬 수 없어 화면이 lib/format.withoutLeadingIcon으로 정리합니다. 원문에 그림 문자도 이스케이프도 없는 파일은 파싱하지 않습니다
 * (mayHoldPictograph — 판정은 같음).
 *
 * 찾는 글자: 그림 문자(Extended_Pictographic — 이형 선택자 없는 경고 삼각형 U+26A0도 포함), 지역 표시 문자(국기),
 * 이형 선택자 U+FE0F, 결합자 U+200D. 글자 기호로 쓰는 것(▲▼·화살표·체크·⌘·↔·↕·▪·©)은 허용합니다.
 *
 * 아래 두 번째 시험은 같은 글자 정의로 저장소의 스크립트·Makefile·compose·env 예시·주요 문서를 줄마다 봅니다(전체 글 —
 * 스크립트 출력과 문서 본문이라 주석을 가르지 않음). 지난 기록(docs/qa·docs/reviews·docs/improve)과 코드 주석은 넣지 않습니다
 * — 서버·AI 입력 글을 그대로 옮긴 인용이 남아 있습니다. Claude 프롬프트·패킷 원문과 그 고정본은 실험 조건이라 대상이 아닙니다.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../..");
const REPO = resolve(SRC, "../..");
const SKIP_DIRS = new Set(["__tests__", "__checks__", "node_modules"]);
const PICTOGRAPH = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}]/u;
/** 그림 문자 속성이 있거나 비슷해 보여도 글자 기호로 쓰는 것. */
const ALLOWED = new Set([..."▲▼↑↓↕→←↻✓✗⌘↔▪©"]);

const PICTOGRAPH_ALL = new RegExp(PICTOGRAPH.source, "gu");
/** 원문에 없는 글자를 글 값에 만들 수 있는 표기 — 문자열 이스케이프(\u·\x·8진)와 문자 참조(&#…;·&이름;). */
const ESCAPE = /\\[ux0-7]|&[#A-Za-z]/;

/**
 * 파싱해 볼 까닭이 있는 원문인가 (QA-1037). 원문에 허용 목록 밖의 그림 문자가 하나도 없고 그런 글자를 만들 표기도 없으면 문자열·템플릿·
 * JSX 글에도 있을 수 없으므로 파싱을 건너뜁니다 — 판정은 같고, src 전체를 파싱하던 CPU 일만 줄어듭니다(전체 시험을 여러 벌 돌릴 때 한도에 걸리던 자리).
 */
function mayHoldPictograph(text: string): boolean {
  return ESCAPE.test(text) || (text.match(PICTOGRAPH_ALL) ?? []).some((char) => !ALLOWED.has(char));
}

/** 한 파일의 글에서 허용 목록 밖의 그림 문자를 찾습니다 — "줄: 코드 포인트 · 글 앞부분". */
function pictographsIn(fileName: string, text: string): string[] {
  return mayHoldPictograph(text) ? parsedPictographs(fileName, text) : [];
}

/** 미리 거르지 않고 늘 파싱하는 판 — 검사기 자체 시험이 pictographsIn과 대조합니다. */
function parsedPictographs(fileName: string, text: string): string[] {
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

  it("검사기 자체 — 원문에 그림 문자도 이스케이프도 없는 파일만 파싱을 건너뛰고, 판정은 늘 파싱한 것과 같다(QA-1037)", () => {
    const cases: [text: string, parses: boolean][] = [
      ["const plain = \"정상 ▲ 1.2% ✓\";\nexport const View = () => <p>글 {a && b}</p>;", false],   // 허용한 글자 기호뿐
      ["const warn = \"\\u26A0 바로\";", true],                    // 원문에는 없고 이스케이프가 만드는 글자
      ["const mark = \"\\xAE\";", true],
      ["const flag = `\\u{1F1FA}\\u{1F1F8} ${name}`;", true],
      ["const lock = \"\u{1F512}\";", true],
      ["// 주석의 \u{1F512}\nconst a = 1;", true],                  // 주석뿐이어도 원문에 있으면 파싱(결과는 없음)
      ["export const View = () => <p title=\"&#x1F512;\">&reg;</p>;", true],
      ["export const View = () => <p>\u{1F9EA} 실험</p>;", true],
    ];
    for (const [text, parses] of cases) {
      expect(mayHoldPictograph(text), text).toBe(parses);
      expect(pictographsIn("sample.tsx", text), text).toEqual(parsedPictographs("sample.tsx", text));
    }
    expect(cases.map(([text]) => pictographsIn("sample.tsx", text).length)).toEqual([0, 1, 1, 1, 1, 0, 0, 1]);
  });
});

/** 문서 본문에서 글자 기호로 쓰는 ®·™까지 허용합니다(상표 표기). */
const ALLOWED_TEXT = new Set([...ALLOWED, ..."®™"]);
const REPO_FILES = ["Makefile", "README.md", "CLAUDE.md", "docker-compose.yml", "compose.vultr.yml", ".env.example",
  ".env.vultr.example", "deploy/vultr/Caddyfile"];

/** 한 글에서 허용 목록 밖의 그림 문자가 있는 줄을 찾습니다 — "줄: 코드 포인트". */
function pictographLines(text: string): string[] {
  return text.split("\n").flatMap((line, index) => {
    const bad = [...line].filter((char) => PICTOGRAPH.test(char) && !ALLOWED_TEXT.has(char));
    return bad.length > 0 ? [`${index + 1}: ${bad.map((char) => `U+${char.codePointAt(0)?.toString(16).toUpperCase()}`).join(",")}`] : [];
  });
}

function repoFiles(dir: string, pattern: RegExp, skip: Set<string>, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!skip.has(name)) repoFiles(path, pattern, skip, out);
    } else if (pattern.test(name)) {
      out.push(path);
    }
  }
  return out;
}

describe("저장소 스크립트·문서에 이모지가 없다", () => {
  it("Makefile·scripts·compose·env 예시·README·CLAUDE.md·docs(지난 기록 제외)의 줄에 그림 문자·국기·이형 선택자가 없다", () => {
    const files = [
      ...REPO_FILES.map((name) => join(REPO, name)),
      ...repoFiles(join(REPO, "scripts"), /\.(sh|ya?ml)$/, new Set()),
      ...repoFiles(join(REPO, "docs"), /\.md$/, new Set(["qa", "reviews", "improve"])),
    ];
    expect(files.filter((path) => !existsSync(path))).toEqual([]);
    expect(files.length).toBeGreaterThan(60);
    const offenders = files.flatMap((path) =>
      pictographLines(readFileSync(path, "utf8")).map((hit) => `${relative(REPO, path)}:${hit}`));
    expect(offenders).toEqual([]);
  });

  it("검사기 자체 — 글자 기호(✓·✗·→·△·©·®·™)는 두고 그림 문자 줄만 찾는다", () => {
    expect(pictographLines("✓ 배포했습니다 → 끝\n경고: 스키마\n✅ 끝\n© ® ™ △\n# ⚠️ 주의")).toEqual(["3: U+2705", "5: U+26A0,U+FE0F"]);
  });
});
