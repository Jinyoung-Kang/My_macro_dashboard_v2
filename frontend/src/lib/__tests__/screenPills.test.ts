/**
 * 알약 모양이 남지 않게 — 모서리는 4px 하나(rounded-control·rounded-card·rounded-sm)이고, rounded-full은 상태 점·토글 손잡이·아바타에만 씁니다
 * (작업대 실행 명세 docs/specs/2026-11-15-v2-workbench-ui.md §3-8, ADR 0042 결정 4). 처음에는 화면(components/screens·app)만 봤고, 2026-11-16 결정으로
 * 공용 부품·셸까지(components 전체·app) 넓혔습니다.
 * rounded-full이 통과하는 것은 두 가지입니다 —
 *  - 상태 점: 같은 클래스 글에 12px 이하 정사각 크기(size-N 또는 h-N과 w-N, N ≤ 3)가 함께 있음.
 *  - 장식 원판(아바타 등): 아래 허용 목록(TRUE_CIRCLES)의 파일·정사각 크기(size-N)와 같은 글. 누르는 것(아이콘만 있는 단추 포함)은 원판이 아니라 4px입니다 —
 *    새 원판을 들이려면 그것이 누르는 것이 아니고(aria-hidden 장식) 정사각인지 보고 목록에 까닭과 함께 더합니다. 목록의 항목이 소스에서 사라지면 걸립니다.
 * 문자열·템플릿 조각 하나 안의 클래스를 봅니다(변수로 나눠 붙인 클래스는 보지 않음 — themeTokens.test.ts의 소스 검사와 같은 한계).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../..");
/** 보는 폴더 — 공용 부품·패턴·차트·셸·화면(components 전체)과 app. */
const SCAN_DIRS = [resolve(SRC, "components"), resolve(SRC, "app")];

/** 원으로 남기는 장식 원판 — src 기준 파일, 정사각 크기, 그 파일에서 나오는 수, 까닭. */
const TRUE_CIRCLES: readonly { file: string; size: string; count: number; why: string }[] = [
  { file: "components/patterns/Avatar.tsx", size: "size-8", count: 1, why: "아바타(계좌·종목 머리글자 — 공용 패턴, 장식)" },
  { file: "components/shell/AccountBox.tsx", size: "size-8", count: 1, why: "계정 머리글자 아바타(장식)" },
  { file: "components/shell/MoreMenu.tsx", size: "size-10", count: 1, why: "더보기 메뉴의 메뉴 아이콘 원판(장식 — 줄 전체가 링크)" },
  { file: "components/shell/SearchCommand.tsx", size: "size-8", count: 2, why: "통합 검색 결과·정보 검색 줄의 종류 원판(아바타와 같은 꼴, 장식)" },
];
const SKIP_DIRS = new Set(["__tests__", "__checks__", "node_modules"]);
/** 화면 소스 전체를 구문 분석하는 검사의 시간 한도 — 보통 1초 남짓이지만 바쁜 기계(병렬 시험)에서 5초 기본 한도를 넘길 수 있습니다(검사 내용 그대로). */
const SOURCE_SCAN_TIMEOUT_MS = 30_000;

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

/** 정사각 크기 낱말(size-N) — 원판 허용 목록과 맞춰 봅니다. */
const squareSize = (names: string[]) => names.find((name) => /^size-[\d.]+$/.test(name)) ?? null;

type PillHit = { line: number; text: string; size: string | null };

/** rounded-full이 점이 아닌 자리에 붙은 글(줄·글·정사각 크기). */
function pillCandidates(fileName: string, text: string): PillHit[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  return textPieces(source)
    .filter((piece) => {
      const names = utilities(piece.text);
      return names.includes("rounded-full") && !isDot(names);
    })
    .map((piece) => ({
      line: source.getLineAndCharacterOfPosition(piece.getStart(source)).line + 1,
      text: piece.text.trim(),
      size: squareSize(utilities(piece.text)),
    }));
}

/** 점도 허용 원판도 아닌 rounded-full 글 — "줄: 클래스 글". `file`은 src 기준 경로(허용 목록과 맞춤). */
function pillHits(file: string, text: string, circles = TRUE_CIRCLES): string[] {
  return pillCandidates(file, text)
    .filter((hit) => !circles.some((circle) => circle.file === file && circle.size === hit.size))
    .map((hit) => `${hit.line}: ${hit.text}`);
}

/** 검사할 파일(src 기준 경로, 구분자 /)과 글. */
function scannedSources(): { file: string; text: string }[] {
  return SCAN_DIRS.flatMap((dir) => sourceFiles(dir)).map((path) => ({
    file: relative(SRC, path).split("\\").join("/"),
    text: readFileSync(path, "utf8"),
  }));
}

describe("알약 모양 — 소스 검사(명세 §3-8)", () => {
  it("검사기: 상태 점은 통과, 알약 배지·칩·단추는 걸린다", () => {
    expect(pillHits("a.tsx", 'const a = <span className="mt-1.5 size-2 shrink-0 rounded-full border border-text-3" />;')).toEqual([]);
    expect(pillHits("a.tsx", 'const a = <span className="h-2 w-2 rounded-full" />;')).toEqual([]);
    expect(pillHits("a.tsx", 'const a = <span className="rounded-full border px-2 py-px text-xs" />;')).toHaveLength(1);
    expect(pillHits("a.tsx", "const a = `whitespace-nowrap hover:rounded-full ${tone}`;")).toHaveLength(1);
    expect(pillHits("a.tsx", 'const a = <span className="size-8 rounded-full" />;')).toHaveLength(1);
  });

  it("검사기: 허용 목록의 원판은 같은 파일·같은 정사각 크기일 때만 통과한다", () => {
    const circles = [{ file: "x/Avatar.tsx", size: "size-8", count: 1, why: "시험" }];
    const avatar = 'const a = <span aria-hidden="true" className="inline-flex size-8 rounded-full bg-surface-2" />;';
    expect(pillHits("x/Avatar.tsx", avatar, circles)).toEqual([]);
    // 다른 파일·다른 크기·정사각이 아닌 알약은 걸립니다.
    expect(pillHits("x/Other.tsx", avatar, circles)).toHaveLength(1);
    expect(pillHits("x/Avatar.tsx", 'const a = <span className="size-11 rounded-full" />;', circles)).toHaveLength(1);
    expect(pillHits("x/Avatar.tsx", 'const a = <span className="h-11 px-4 rounded-full" />;', circles)).toHaveLength(1);
  });

  it("components(공용 부품·패턴·차트·셸·화면)·app에는 상태 점과 허용한 원판 말고 rounded-full이 없다", () => {
    const sources = scannedSources();
    expect(sources.length).toBeGreaterThan(100);
    const hits = sources.flatMap(({ file, text }) => pillHits(file, text).map((hit) => `${file}:${hit}`));
    expect(hits).toEqual([]);
  }, SOURCE_SCAN_TIMEOUT_MS);

  it("허용 목록의 원판은 지금 소스에 그 수만큼 있다(사라졌거나 늘었으면 목록을 고친다)", () => {
    const byFile = new Map(scannedSources().map(({ file, text }) => [file, text]));
    for (const circle of TRUE_CIRCLES) {
      const text = byFile.get(circle.file);
      expect(text, circle.file).toBeTruthy();
      const found = pillCandidates(circle.file, text ?? "").filter((hit) => hit.size === circle.size);
      expect(found, `${circle.file} ${circle.size} — ${circle.why}`).toHaveLength(circle.count);
    }
  }, SOURCE_SCAN_TIMEOUT_MS);
});
