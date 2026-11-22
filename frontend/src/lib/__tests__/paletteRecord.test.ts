/**
 * 팔레트 기록 — 확정한 계열 색 hex(아래 기대 상수)가 실제 소스와 같은지, 어두운 두 면(bg #111418·surface #1c2127) 위 그래픽 대비 3:1 이상인지 봅니다
 * (작업대 실행 명세 docs/specs/2026-11-15-v2-workbench-ui.md §3-5·§9-4, ADR 0042 '지키는 방법').
 *
 * - 명세 §3-5 표는 dataviz 검증기(저장소 밖) 결과의 기록이라 이 시험은 그 마크다운을 읽지 않습니다 — 버린 값·바꿀 값·아직 돌리지 않은 묶음이 글로 섞여 있어
 *   문서를 고칠 때마다 깨지거나 버린 hex를 기대값으로 잡을 수 있습니다. 색약 ΔE·정상 시각 ΔE는 그 검증기가 재고 §3-5에 적습니다(여기서는 대비만 셈).
 * - 색을 바꾸려면: 검증기를 다시 돌려 §3-5에 적고, 이 기대 상수와 소스를 같은 커밋에서 고칩니다.
 * - 표를 내보내는 모듈(paper/bookColors·charts/frame)은 가져와 대조합니다. 내보내지 않는 자리(Next 페이지 파일은 정해진 이름만 내보낼 수 있음, 화면 안
 *   상수·JSX 속성)는 소스를 구문 분석해 hex 글을 순서대로 읽습니다.
 * - 제품 소스(.ts·.tsx, 시험 제외)의 hex 색 글은 이 기록의 파일에만 있어야 합니다 — 기록 밖에 계열 색이 새로 생기면 걸립니다(계열 색이면 검증기를 돌려
 *   §3-5와 이 기록에 더하고, 계열 색이 아니면 토큰 var(--…)를 씁니다). 주석은 구문 분석이 건너뜁니다.
 * - 순차 팔레트(lib/heatmap — 표 히트맵 칸 바탕, P5b)는 그래픽 3:1 검사 대신 순차 규칙으로 봅니다: 0에 가까운 어두운 단계는 면으로 물러나도 되고(칸마다 숫자가
 *   적혀 있음 — 명세 §3-5), 단계마다 밝아지며, 가장 밝은 단계는 두 면 위 3:1 이상입니다. 칸 글자 대비는 lib/__tests__/heatmap.test.ts가 봅니다.
 * 대비는 WCAG 2.x 상대휘도입니다(themeTokens.test.ts와 같은 식).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { SERIES_COLORS } from "@/components/charts/frame";
import { BOOK_COLORS, REFERENCE_COLOR, SPARE_COLORS, bookColor } from "@/components/screens/paper/bookColors";
import { SEQUENTIAL_STEPS } from "@/lib/heatmap";

const SRC = resolve(__dirname, "../..");

/** 어두운 두 면 — globals.css :root의 --bg·--surface와 같아야 합니다(아래 첫 시험). */
const SURFACES = { bg: "#111418", surface: "#1c2127" } as const;

// ------------------------------------------------------------------ 기대 상수(확정한 값 — 명세 §3-5)

/** 차트 계열 세 색(charts/frame SERIES_COLORS). */
const EXPECTED_SERIES = { blue: "#3987e5", orange: "#d95926", green: "#199e70" } as const;

/** 모의매매 계좌 색(paper/bookColors BOOK_COLORS) — 계좌2는 2026-11-16 #ba5db3(모든 쌍 색약 8 이상), 60/40은 중립 회색. */
const EXPECTED_BOOKS: Readonly<Record<string, string>> = {
  rules: "#3987e5",
  claude: "#d95926",
  claude2: "#ba5db3",
  bench_spy: "#199e70",
  bench_mix: "#6b727e",
  kr_rules: "#3987e5",
  kr_claude: "#d95926",
  kr_claude2: "#ba5db3",
  kr_bench_k200: "#199e70",
  kr_bench_mix: "#6b727e",
};
/** 표에 없는 계좌의 남는 색(순서대로 돌려 씀). */
const EXPECTED_SPARE = ["#a371f7", "#22a2bd", "#db6d28"] as const;
/** 한국 노출 맞춘 참고선(K40) — 옅은 중립 회색 점선(2026-11-16 결정: 색 그대로). */
const EXPECTED_REFERENCE = "#a7b0bd";
/**
 * 순차 팔레트(lib/heatmap SEQUENTIAL_STEPS — 표 히트맵 칸 바탕, P5b QA-692): 보라 단계 다섯 — 명세 §3-5 순차 팔레트, 어두운 단계(0에 가까움) → 밝은 단계(큼).
 * 그래픽 3:1 검사 대신 아래 순차 시험으로 봅니다(머리 주석).
 */
const EXPECTED_SEQUENTIAL = ["#5c255c", "#7c327c", "#9d3f9d", "#bd6bbd", "#d69fd6"] as const;
/** 순차 팔레트가 있는 파일(src 기준) — 기록에는 넣고 그래픽 3:1 검사에서는 뺍니다. */
const SEQUENTIAL_SOURCE = "lib/heatmap.ts";

/**
 * 파일별로 소스에 적힌 hex 색 글(나온 순서대로). 표를 내보내는 두 모듈도 여기에 적어 '기록 밖 hex 없음' 검사가 같은 목록으로 봅니다.
 * 경로는 src 기준입니다.
 */
const RECORDED_SOURCES: Readonly<Record<string, readonly string[]>> = {
  "components/charts/frame.tsx": ["#3987e5", "#d95926", "#199e70"],
  "components/screens/paper/bookColors.ts": ["#ba5db3", "#6b727e", "#ba5db3", "#6b727e", "#a371f7", "#22a2bd", "#db6d28", "#a7b0bd"],
  // 계좌 상세 구성 도넛 — 상위 세 종목은 SERIES_COLORS, 기타(2026-11-15 #6e6e7c)·현금 회색.
  "components/screens/paper/AccountDetailPanel.tsx": ["#6e6e7c", "#9ea7b3"],
  // 기관 비중 추이 선 10색(순서 고정).
  "components/screens/institutions/weightLineColors.ts": [
    "#4798ee", "#1da967", "#c68206", "#eb5070", "#a371f7",
    "#22a2bd", "#dd6836", "#8b8dd1", "#81a022", "#cf7787",
  ],
  // 환율 겹쳐 보기 4색.
  "app/(dashboard)/macro/FxCompareSection.tsx": ["#4798ee", "#d47d0d", "#1caa5e", "#a371f7"],
  // 한국판 COT OI Index 선 하나.
  "app/(dashboard)/krx/page.tsx": ["#A371F7"],
  // COT 비보고(소액) 회색 — 파랑·주황(SERIES_COLORS)과 함께.
  "app/(dashboard)/cot/page.tsx": ["#8B949E"],
  // 표 히트맵 순차 팔레트 다섯 단계(위 EXPECTED_SEQUENTIAL).
  [SEQUENTIAL_SOURCE]: [...EXPECTED_SEQUENTIAL],
};

// ------------------------------------------------------------------ 계산·소스 읽기

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`#rrggbb 꼴이 아닙니다: ${hex}`);
  return [0, 2, 4].map((at) => parseInt(match[1].slice(at, at + 2), 16) / 255) as Rgb;
}

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const HEX = /^#[0-9a-f]{6}$/i;

/** 파일 하나의 hex 색 글(문자열·템플릿 글 전체가 #rrggbb인 것) — 나온 순서대로. 주석은 건너뜁니다. */
function hexLiterals(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && HEX.test(node.text.trim())) found.push(node.text.trim());
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const SKIP_DIRS = new Set(["__tests__", "__checks__", "node_modules"]);
/** 제품 소스 전체를 구문 분석하는 검사의 시간 한도 — 다른 소스 검사 시험과 같은 30초(바쁜 기계에서 5초 기본 한도를 넘긴 적이 있음). */
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

/** 기록한 계열 hex(중복 없이, 소문자) — 그래픽 3:1 검사를 받는 것. 순차 팔레트 파일은 뺍니다(순차 시험이 따로 봄). */
const ALL_RECORDED = [
  ...new Set([
    ...Object.values(EXPECTED_SERIES),
    ...Object.values(EXPECTED_BOOKS),
    ...EXPECTED_SPARE,
    EXPECTED_REFERENCE,
    ...Object.entries(RECORDED_SOURCES)
      .filter(([file]) => file !== SEQUENTIAL_SOURCE)
      .flatMap(([, hexes]) => hexes),
  ].map((hex) => hex.toLowerCase())),
];

// ------------------------------------------------------------------ 시험

describe("팔레트 기록(명세 §3-5·§9-4)", () => {
  it("어두운 두 면은 globals.css :root의 --bg·--surface와 같다", () => {
    const css = readFileSync(resolve(SRC, "app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const root = /(?:^|[;}])\s*:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(/--bg:\s*(#[0-9a-f]{6});/i.exec(root)?.[1]?.toLowerCase()).toBe(SURFACES.bg);
    expect(/--surface:\s*(#[0-9a-f]{6});/i.exec(root)?.[1]?.toLowerCase()).toBe(SURFACES.surface);
  });

  it("차트 계열 세 색(charts/frame)은 기록과 같다", () => {
    expect({ ...SERIES_COLORS }).toEqual(EXPECTED_SERIES);
  });

  it("모의매매 계좌 색·남는 색·K40 참고선(paper/bookColors)은 기록과 같다 — 미국·한국 계좌2는 같은 자주", () => {
    expect({ ...BOOK_COLORS }).toEqual(EXPECTED_BOOKS);
    expect([...SPARE_COLORS]).toEqual([...EXPECTED_SPARE]);
    expect(REFERENCE_COLOR).toBe(EXPECTED_REFERENCE);
    expect(bookColor("claude2", 0)).toBe(bookColor("kr_claude2", 0));
    // 표에 없는 계좌는 남는 색을 자리대로 돌려 씁니다.
    expect(bookColor("모르는 계좌", 4)).toBe(EXPECTED_SPARE[1]);
  });

  it("순차 팔레트(lib/heatmap)는 기록과 같다 — 다섯 단계, 어두운 단계 → 밝은 단계", () => {
    expect([...SEQUENTIAL_STEPS]).toEqual([...EXPECTED_SEQUENTIAL]);
  });

  it("순차 팔레트는 단계마다 밝아지고(상대휘도가 오름), 가장 밝은 단계는 어두운 두 면 위 3:1 이상 — 0에 가까운 단계는 면으로 물러나도 됨", () => {
    const lums = EXPECTED_SEQUENTIAL.map((hex) => luminance(rgb(hex)));
    for (let index = 1; index < lums.length; index += 1) expect(lums[index], EXPECTED_SEQUENTIAL[index]).toBeGreaterThan(lums[index - 1]);
    const lightest = EXPECTED_SEQUENTIAL[EXPECTED_SEQUENTIAL.length - 1];
    for (const [name, back] of Object.entries(SURFACES)) {
      const value = contrast(lightest, back);
      expect(value, `${lightest} on ${name} ${back} = ${value.toFixed(2)}`).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(Object.entries(RECORDED_SOURCES))("%s의 hex 색 글은 기록과 같다(나온 순서대로)", (file, expected) => {
    expect(hexLiterals(resolve(SRC, file))).toEqual(expected);
  });

  it.each(ALL_RECORDED)("%s — 어두운 두 면(bg·surface) 위 그래픽 대비 3:1 이상", (hex) => {
    for (const [name, back] of Object.entries(SURFACES)) {
      const value = contrast(hex, back);
      expect(value, `${hex} on ${name} ${back} = ${value.toFixed(2)}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("제품 소스의 hex 색 글은 기록한 파일에만 있다 — 기록 밖 계열 색이 생기면 검증기를 돌려 §3-5와 이 기록에 더한다", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(100);
    const outside = files
      .filter((path) => !(relative(SRC, path).split("\\").join("/") in RECORDED_SOURCES))
      .flatMap((path) => hexLiterals(path).map((hex) => `${relative(SRC, path)}: ${hex}`));
    expect(outside).toEqual([]);
  }, SOURCE_SCAN_TIMEOUT_MS);
});
