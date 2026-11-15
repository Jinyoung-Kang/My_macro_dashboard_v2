/**
 * 디자인 토큰 대비 행렬 — 작업대 화면 언어의 어두운 한 벌(ADR 0042 결정 2·3, 실행 명세 docs/specs/2026-11-15-v2-workbench-ui.md §3-2·§9-1).
 * 정보 검색의 어두운 범위 토큰 시험(ADR 0041 결정 11 — 옛 이름 searchTheme.test.ts)을 앱 전체 토큰으로 넓혔습니다.
 *
 * globals.css의 토큰 블록(TOKEN_BLOCKS — 지금은 `:root` 하나)을 읽어 허용 쌍의 WCAG 대비를 다시 셉니다.
 *  - 글자 토큰 × 면 토큰(bg·surface·surface-2) 4.5:1. surface-3(덮개 안 hover·눌림) 위에서 4.5:1에 못 미치는 글자 토큰은
 *    금지 목록(FORBIDDEN_ON_SURFACE_3)과 같아야 합니다 — 값을 바꿔 새로 못 미치는 토큰이 생기면 목록과 소스 검사에 더하라는 뜻입니다.
 *  - 경계(border-strong)·포커스 링(focus) 3:1(WCAG 1.4.11), 강조·위험 바탕 위 글자(accent-fg·danger-fg) 4.5:1.
 *  - 틴트(bg-*-tint — color-mix(in oklab, 톤 10%, surface)) 위 같은 톤 글자 4.5:1 — 못 미치는 톤은 FORBIDDEN_TONE_ON_TINT와 같아야 함 — 와 text·text-2·text-3.
 *  - 블록 모양: 맨 바깥 블록(@media·data-theme 안이 아님), color-scheme dark, 토큰 블록에는 사용자 속성과 color-scheme만, 바탕·글자색은 @layer base.
 *  - 정보 검색 범위 블록(`[data-scope="search"]`)은 P7에서 걷어 낼 때까지 `:root`와 같은 값만 다시 적습니다(겉모습 변화 0).
 *  - 금지 쌍(surface-3 위 text-3·neutral·accent·danger 글자, accent 틴트 위 accent 글자)은 소스 검사로 막습니다 — 제품 소스(.ts·.tsx, 시험 제외)의
 *    문자열·템플릿 조각 하나에 바탕 클래스와 글자 클래스가 함께 있으면 걸립니다(변형 접두어 hover: 등과 투명도 /50은 떼고 봄 — 눌렸을 때만 그 바탕이어도
 *    그때 그 글자가 그 위에 놓임). 부모가 칠한 바탕을 물려받는 자식 글자는 따로 봅니다 — className 글에 그 바탕이 있는 JSX 요소와 그 바탕을 칠하는
 *    톤의 <Banner>(ui/index.tsx BANNER_TONES에서 읽음)의 자식 글. 한계: 변수로 나눠 붙인 클래스, 변수로만 넘긴 Banner 톤, 다른 부품이 안에서 칠하는 바탕은 보지 않습니다.
 * 밝은 한 벌을 다시 더하면 TOKEN_BLOCKS에 그 선택자를 넣어 같은 행렬로 잽니다(값 후보: 명세 §3-2-2).
 * 대비는 WCAG 2.x 상대휘도, 틴트는 OKLab 10% 섞기(브라우저 결과와 마지막 자리가 다를 수 있음)입니다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(resolve(__dirname, "../../app/globals.css"), "utf8");
const CSS_NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** 앱의 토큰 블록 선택자 — 블록마다 같은 허용 쌍 행렬을 잽니다. */
const TOKEN_BLOCKS = [":root"] as const;
/** P7까지 남기는 정보 검색 범위 블록(ADR 0041 결정 11 → ADR 0042 결정 2). */
const SCOPE_SELECTOR = '[data-scope="search"]';

/** 주석을 지운 CSS의 맨 바깥 규칙(선택자 → 본문). 안에 블록이 있는 규칙(@media·@layer·@theme)은 본문을 통째로 담습니다. */
function topLevelRules(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  let depth = 0;
  let start = 0;
  let selectorStart = 0;
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        out.push({ selector: css.slice(selectorStart, start).replace(/^[\s;]+|\s+$/g, "").replace(/^@import[^;]*;\s*/, ""), body: css.slice(start + 1, index) });
        selectorStart = index + 1;
      }
    } else if (char === ";" && depth === 0) {
      selectorStart = index + 1;
    }
  }
  return out;
}

const RULES = topLevelRules(CSS_NO_COMMENTS);

function blockBody(selector: string): string {
  const found = RULES.filter((rule) => rule.selector === selector);
  if (found.length !== 1) throw new Error(`${selector} 블록이 globals.css 맨 바깥에 한 번 있어야 합니다(${found.length}번)`);
  return found[0].body;
}

function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  return out;
}

/** 블록 본문에서 사용자 속성(--*)이 아닌 선언의 이름. */
function plainProperties(body: string): string[] {
  return body
    .split(";")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("--"))
    .map((line) => line.split(":")[0].trim());
}

/** @theme(inline 아님) 블록의 선언 — 모서리·글자 단계. */
function themeDeclarations(): Record<string, string> {
  const theme = RULES.find((rule) => rule.selector === "@theme");
  if (!theme) throw new Error("@theme 블록이 없습니다");
  return declarations(theme.body);
}

// ------------------------------------------------------------------ 색 계산

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`#rrggbb 꼴이 아닙니다: ${hex}`);
  return [0, 2, 4].map((at) => parseInt(match[1].slice(at, at + 2), 16) / 255) as Rgb;
}

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function toOklab([r, g, b]: Rgb): Rgb {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, A, B]: Rgb): Rgb {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const out = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return out.map((c) => Math.min(1, Math.max(0, gamma(c)))) as Rgb;
}

/** globals.css @theme inline의 틴트와 같은 계산 — color-mix(in oklab, tone 10%, surface). */
function tint(tone: Rgb, surface: Rgb): Rgb {
  const a = toOklab(tone);
  const b = toOklab(surface);
  return fromOklab([0, 1, 2].map((i) => a[i] * 0.1 + b[i] * 0.9) as Rgb);
}

// ------------------------------------------------------------------ 행렬 정의

const SURFACES = ["--bg", "--surface", "--surface-2"] as const;
const TEXT_TOKENS = ["--text", "--text-2", "--text-3", "--neutral", "--accent", "--accent-hover", "--up", "--down", "--warn", "--ok", "--danger"] as const;
const COLOR_TOKENS = [...SURFACES, "--surface-3", ...TEXT_TOKENS, "--border", "--border-subtle", "--border-strong", "--accent-fg", "--danger-fg", "--focus"] as const;
/** surface-3 위에 두지 않는 글자 — 4.5:1 미만(명세 §3-2 표). neutral은 text-3과 같은 값입니다. */
const FORBIDDEN_ON_SURFACE_3 = ["--text-3", "--neutral", "--accent", "--danger"] as const;
/** 틴트 위에 같은 톤 글자로 두지 않는 톤(accent 틴트 위 accent 4.47 — 명세 §3-2). */
const FORBIDDEN_TONE_ON_TINT = ["--accent"] as const;
const TINT_TONES = ["--accent", "--warn", "--ok", "--danger"] as const;

const ratio = (t: Record<string, string>, fore: string, back: string | Rgb) =>
  contrast(rgb(t[fore]), typeof back === "string" ? rgb(t[back]) : back);

describe.each(TOKEN_BLOCKS)("토큰 블록 %s", (selector) => {
  const body = blockBody(selector);
  const t = declarations(body);

  it("맨 바깥 블록이고(@media·data-theme 안이 아님) color-scheme은 dark, 사용자 속성 말고는 color-scheme만", () => {
    expect(body).toMatch(/color-scheme:\s*dark;/);
    expect(plainProperties(body)).toEqual(["color-scheme"]);
  });

  it("색 토큰을 모두 실제 #rrggbb 값으로 둔다(var() 참조 없음) — 그림자·가림·면 값은 명세 §3-2", () => {
    for (const name of COLOR_TOKENS) expect(t[name], name).toMatch(/^#[0-9a-f]{6}$/i);
    expect(t["--elev-overlay"]).toBeTruthy();
    expect([t["--bg"], t["--surface"], t["--surface-2"], t["--surface-3"]].map((v) => v.toLowerCase())).toEqual([
      "#111418", "#1c2127", "#252a31", "#2f343c",
    ]);
    expect(t["--border-subtle"].toLowerCase()).toBe("#2f343c");
    expect(t["--scrim"]).toBe("rgb(17 20 24 / 0.7)");
    // 상승은 사용자 결정 4의 선명한 빨강, 위험은 그대로(둘은 색만으로 갈리지 않음 — 늘 아이콘·글·기호와 함께).
    expect(t["--up"].toLowerCase()).toBe("#ff6b6b");
    expect(t["--danger"].toLowerCase()).toBe("#e76a6e");
  });

  it.each(TEXT_TOKENS)("%s — bg·surface·surface-2 위 4.5:1 이상", (name) => {
    for (const back of SURFACES) {
      const value = ratio(t, name, back);
      expect(value, `${name} on ${back} = ${value.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("surface-3 위에서 4.5:1에 못 미치는 글자 토큰은 금지 목록과 같다 — 나머지는 4.5:1 이상", () => {
    const below = TEXT_TOKENS.filter((name) => ratio(t, name, "--surface-3") < 4.5);
    expect(below).toEqual([...FORBIDDEN_ON_SURFACE_3]);
    // 상승은 여유 0.01(4.51) — 값을 조금만 바꿔도 여기서 걸립니다(ADR 0042 남은 위험).
    expect(ratio(t, "--up", "--surface-3")).toBeGreaterThanOrEqual(4.5);
  });

  it("입력칸 경계(border-strong)는 bg·surface·surface-2 위 3:1 이상, 포커스 링은 네 면 모두 3:1 이상", () => {
    for (const back of SURFACES) expect(ratio(t, "--border-strong", back), back).toBeGreaterThanOrEqual(3);
    for (const back of [...SURFACES, "--surface-3"]) expect(ratio(t, "--focus", back), back).toBeGreaterThanOrEqual(3);
  });

  it("강조·위험 바탕 위 글자(--accent-fg·--danger-fg)가 4.5:1 이상 — 주 단추 hover 바탕(accent-hover) 위에서도", () => {
    expect(ratio(t, "--accent-fg", "--accent")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t, "--accent-fg", "--accent-hover")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t, "--danger-fg", "--danger")).toBeGreaterThanOrEqual(4.5);
  });

  it("틴트 위 같은 톤 글자가 4.5:1에 못 미치는 톤은 금지 목록과 같다 — 틴트 위 text·text-2·text-3은 4.5:1 이상", () => {
    const surface = rgb(t["--surface"]);
    const below = TINT_TONES.filter((tone) => ratio(t, tone, tint(rgb(t[tone]), surface)) < 4.5);
    expect(below).toEqual([...FORBIDDEN_TONE_ON_TINT]);
    for (const tone of TINT_TONES) {
      const back = tint(rgb(t[tone]), surface);
      for (const fore of ["--text", "--text-2", "--text-3"]) {
        expect(ratio(t, fore, back), `${fore} on ${tone}-tint`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("어두운 한 벌(W1)", () => {
  it("밝은 값·시스템 따름 블록이 없다 — data-theme 선택자와 prefers-color-scheme 미디어 쿼리 0", () => {
    expect(CSS_NO_COMMENTS).not.toMatch(/data-theme/);
    expect(CSS_NO_COMMENTS).not.toMatch(/prefers-color-scheme/);
    expect(RULES.filter((rule) => rule.selector === ":root")).toHaveLength(1);
  });

  it("문서 바탕·글자색은 @layer base에서 토큰으로 — html·body", () => {
    const base = /@layer base\s*\{\s*html,\s*body\s*\{([^}]*)\}/.exec(CSS_NO_COMMENTS);
    expect(base, "@layer base { html, body { … } }").toBeTruthy();
    expect(base?.[1]).toMatch(/background-color:\s*var\(--bg\);/);
    expect(base?.[1]).toMatch(/color:\s*var\(--text\);/);
  });

  it("새 토큰은 @theme inline에서 클래스 이름이 된다 — bg-surface-3·border-border-subtle·bg-scrim", () => {
    const inline = RULES.find((rule) => rule.selector === "@theme inline");
    const names = declarations(inline?.body ?? "");
    expect(names["--color-surface-3"]).toBe("var(--surface-3)");
    expect(names["--color-border-subtle"]).toBe("var(--border-subtle)");
    expect(names["--color-scrim"]).toBe("var(--scrim)");
  });

  it("모서리는 4px 하나(card·control)", () => {
    const theme = themeDeclarations();
    expect(theme["--radius-card"]).toBe("4px");
    expect(theme["--radius-control"]).toBe("4px");
  });

  it("옛 색 별칭 다섯(muted·body·bright·canvas·surface-hover)이 없다 — text-body는 글자 크기만 낸다(ADR 0042 결정 10)", () => {
    const inline = declarations(RULES.find((rule) => rule.selector === "@theme inline")?.body ?? "");
    for (const name of ["muted", "body", "bright", "canvas", "surface-hover"]) expect(inline[`--color-${name}`], name).toBeUndefined();
  });
});

describe("글자 단계(명세 §3-6)", () => {
  it("micro 12/16 · caption 13/18 · body 14/20 · running 15/24 · heading-sm 16/24 · heading 20/28 · value-lg 28/36", () => {
    const theme = themeDeclarations();
    const scale: Record<string, [string, string]> = {
      micro: ["0.75rem", "1rem"],
      caption: ["0.8125rem", "1.125rem"],
      body: ["0.875rem", "1.25rem"],
      running: ["0.9375rem", "1.5rem"],
      "heading-sm": ["1rem", "1.5rem"],
      heading: ["1.25rem", "1.75rem"],
      "value-lg": ["1.75rem", "2.25rem"],
    };
    for (const [name, [size, line]] of Object.entries(scale)) {
      expect(theme[`--text-${name}`], name).toBe(size);
      expect(theme[`--text-${name}--line-height`], name).toBe(line);
    }
  });

  it("식별자 글꼴은 시스템 고정폭 스택(웹폰트 없음)", () => {
    expect(themeDeclarations()["--font-mono"]).toMatch(/^ui-monospace, SFMono-Regular, Menlo, Consolas/);
  });
});

describe("정보 검색 범위 블록(P7에서 걷어 냄)", () => {
  const body = blockBody(SCOPE_SELECTOR);
  const scope = declarations(body);
  const root = declarations(blockBody(":root"));
  const theme = themeDeclarations();

  it("맨 바깥 블록이고 color-scheme은 dark, 사용자 속성 말고는 color-scheme만", () => {
    expect(body).toMatch(/color-scheme:\s*dark;/);
    expect(plainProperties(body)).toEqual(["color-scheme"]);
  });

  it(":root(모서리는 @theme)와 같은 값만 다시 적는다 — 이 화면의 겉모습이 앱과 같다", () => {
    for (const [name, value] of Object.entries(scope)) {
      expect(value, name).toBe(root[name] ?? theme[name]);
    }
  });

  it("바탕색·글자색은 레이어 밖 토큰 블록이 아니라 @layer base에 — 범위 표지를 단 대화상자의 bg-surface 같은 유틸리티가 이긴다", () => {
    // 레이어 밖 선언은 우선순위와 상관없이 @layer utilities를 이깁니다. 토큰 블록에는 사용자 속성(--*)과 color-scheme만 둡니다.
    const base = /@layer base\s*\{\s*\[data-scope="search"\]\s*\{([^}]*)\}\s*\}/.exec(CSS_NO_COMMENTS);
    expect(base, "@layer base { [data-scope=\"search\"] { … } }").toBeTruthy();
    expect(base?.[1]).toMatch(/background-color:\s*var\(--bg\);/);
    expect(base?.[1]).toMatch(/color:\s*var\(--text\);/);
  });
});

// ------------------------------------------------------------------ 금지 쌍 — 소스 검사

const SRC = resolve(__dirname, "../..");
const SKIP_DIRS = new Set(["__tests__", "__checks__", "node_modules"]);

/** 토큰 이름(--text-3) → 글자 클래스(text-text-3). */
const textClass = (token: string) => `text-${token.slice(2)}`;

type PairRule = "surface-3" | "tint";

/** 금지 쌍 — 바탕 클래스 하나와 그 위에 두지 않는 글자 클래스들. */
const FORBIDDEN_PAIRS: readonly { rule: PairRule; back: string; fores: readonly string[] }[] = [
  { rule: "surface-3", back: "bg-surface-3", fores: FORBIDDEN_ON_SURFACE_3.map(textClass) },
  ...FORBIDDEN_TONE_ON_TINT.map((tone) => ({ rule: "tint" as const, back: `bg-${tone.slice(2)}-tint`, fores: [textClass(tone)] })),
];

/** 클래스 낱말 하나의 유틸리티 이름 — 중요 표시(!)·변형 접두어(hover:·[&>svg]: — 대괄호 안의 콜론은 건너뜀)·투명도(/50)를 뗍니다. */
function utilityOf(token: string): string {
  let depth = 0;
  let cut = -1;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index];
    if (char === "[") depth += 1;
    else if (char === "]") depth -= 1;
    else if (char === ":" && depth === 0) cut = index;
  }
  return token.slice(cut + 1).replace(/^!|!$/g, "").replace(/\/\d+$/, "");
}

type TextPiece = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateHead | ts.TemplateMiddle | ts.TemplateTail;

/** 문자열·템플릿 조각 하나(클래스 글이 들어 있을 수 있는 노드). */
function isTextPiece(node: ts.Node): node is TextPiece {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node);
}

/** 노드 아래(자신 포함)의 문자열·템플릿 조각을 모두. */
function textPieces(node: ts.Node, out: TextPiece[] = []): TextPiece[] {
  if (isTextPiece(node)) out.push(node);
  ts.forEachChild(node, (child) => {
    textPieces(child, out);
  });
  return out;
}

/** 글 하나의 유틸리티 이름 모음(변형 접두어·투명도를 뗌). */
const utilitiesOf = (text: string) => new Set(text.split(/\s+/).filter(Boolean).map(utilityOf));

/** 파일마다 한 번만 구문 분석합니다 — 소스 검사 여럿(같은 글 쌍·부모 바탕·모서리)이 같은 파일을 다시 읽어도 글이 같으면 그 나무를 씁니다. */
const PARSED = new Map<string, { text: string; source: ts.SourceFile }>();

function parse(fileName: string, text: string): ts.SourceFile {
  const cached = PARSED.get(fileName);
  if (cached?.text === text) return cached.source;
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  PARSED.set(fileName, { text, source });
  return source;
}

const lineOf = (source: ts.SourceFile, node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

/** .ts·.tsx 한 파일에서 금지 쌍이 있는 글(문자열·템플릿 조각) — "줄: 바탕 + 글자". 주석은 AST가 건너뜁니다. */
function pairHits(fileName: string, text: string, rule: PairRule): string[] {
  const source = parse(fileName, text);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (isTextPiece(node)) {
      const utilities = utilitiesOf(node.text);
      for (const pair of FORBIDDEN_PAIRS.filter((entry) => entry.rule === rule && utilities.has(entry.back))) {
        for (const fore of pair.fores.filter((name) => utilities.has(name))) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          found.push(`${line + 1}: ${pair.back} + ${fore}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** 안내 상자(Banner)의 톤 표 — 상자 바탕(box)을 칠하는 톤을 여기서 읽습니다. */
const UI_INDEX = resolve(SRC, "components/ui/index.tsx");

/**
 * Banner 톤 가운데 상자 바탕에 `back` 클래스를 칠하는 톤의 이름 — ui/index.tsx의 BANNER_TONES 표의 box 글에서 읽습니다.
 * 표를 고치면(예: 안내 톤을 파랑 틴트 없는 중립으로 — 명세 §3-4) 자식 검사도 따라 바뀝니다. 표를 못 찾으면 멈춥니다(검사가 조용히 비지 않게).
 */
function bannerTonesPainting(back: string): string[] {
  const source = parse(UI_INDEX, readFileSync(UI_INDEX, "utf8"));
  let table: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "BANNER_TONES" && node.initializer) {
      const value = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (ts.isObjectLiteralExpression(value)) table = value;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!table) throw new Error("ui/index.tsx에서 BANNER_TONES 표를 찾지 못했습니다 — 바탕을 칠하는 부품을 읽는 bannerTonesPainting을 고치십시오");
  return table.properties.flatMap((tone) => {
    if (!ts.isPropertyAssignment(tone) || !ts.isObjectLiteralExpression(tone.initializer)) return [];
    const box = tone.initializer.properties.find((entry) => ts.isPropertyAssignment(entry) && entry.name.getText(source) === "box");
    const boxText = box && ts.isPropertyAssignment(box) && ts.isStringLiteralLike(box.initializer) ? box.initializer.text : "";
    return utilitiesOf(boxText).has(back) ? [tone.name.getText(source)] : [];
  });
}

/** 바탕 클래스 → 그 바탕을 칠하는 Banner 톤 이름(기본 톤은 Banner의 기본값 warn). */
type BannerTones = Readonly<Record<string, readonly string[]>>;
const BANNER_DEFAULT_TONE = "warn";

/** JSX 여는 꼬리표가 `back` 바탕을 칠하면 그 표시 글(어디서 칠하는지), 아니면 null. */
function painterLabel(opening: ts.JsxOpeningElement, back: string, bannerTones: BannerTones, source: ts.SourceFile): string | null {
  const attribute = (name: string) =>
    opening.attributes.properties.find((entry): entry is ts.JsxAttribute => ts.isJsxAttribute(entry) && entry.name.getText(source) === name);
  if (opening.tagName.getText(source) === "Banner") {
    const tones = bannerTones[back] ?? [];
    const tone = attribute("tone");
    // 톤이 식이면 그 안에 칠하는 톤 이름 글이 있을 때 칠한다고 봅니다(`tone={ok ? "info" : "warn"}`). 변수만 넘기면 보지 않습니다(한계).
    const named = !tone?.initializer ? [BANNER_DEFAULT_TONE] : textPieces(tone.initializer).map((piece) => piece.text);
    return named.some((name) => tones.includes(name)) ? `<Banner${tone ? ` ${tone.getText(source)}` : ""}>(${lineOf(source, opening)}행)` : null;
  }
  const className = attribute("className");
  if (className?.initializer && textPieces(className.initializer).some((piece) => utilitiesOf(piece.text).has(back))) {
    return `${back} 요소(${lineOf(source, opening)}행)`;
  }
  return null;
}

/**
 * 부모가 칠한 바탕 위에 놓이는 자식의 글자 — 바탕은 부모(className 글에 그 바탕 클래스가 있는 요소, 또는 BANNER_TONES에서 그 바탕을 칠하는
 * 톤의 <Banner>)에, 글자색은 자식 쪽 글에 있는 꼴입니다(QA-459의 실제 계좌 탭 안내 상자 안 링크). 부모 자신의 className 안 다른 글은 보지
 * 않습니다(조건식의 다른 갈래일 수 있음 — 같은 글 안의 쌍은 pairHits가 봄). 자식이 스스로 다른 바탕을 칠해도 잡으니, 걸리면 그 자식 바탕을 보고 판단합니다.
 */
function inheritedHits(fileName: string, text: string, rule: PairRule, bannerTones: BannerTones): string[] {
  const source = parse(fileName, text);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node)) {
      for (const pair of FORBIDDEN_PAIRS.filter((entry) => entry.rule === rule)) {
        const painter = painterLabel(node.openingElement, pair.back, bannerTones, source);
        if (!painter) continue;
        for (const piece of node.children.flatMap((child) => textPieces(child))) {
          const utilities = utilitiesOf(piece.text);
          for (const fore of pair.fores.filter((name) => utilities.has(name))) found.push(`${lineOf(source, piece)}: ${painter} 안 ${fore}`);
        }
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
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

/** 금지 쌍의 바탕마다 그 바탕을 칠하는 Banner 톤. */
function bannerTonesByBack(): BannerTones {
  return Object.fromEntries(FORBIDDEN_PAIRS.map((pair) => [pair.back, bannerTonesPainting(pair.back)]));
}

function offenders(rule: PairRule): string[] {
  const files = sourceFiles(SRC);
  expect(files.length).toBeGreaterThan(100);
  const bannerTones = bannerTonesByBack();
  return files.flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return [...pairHits(path, text, rule), ...inheritedHits(path, text, rule, bannerTones)].map((hit) => `${relative(SRC, path)}:${hit}`);
  });
}

describe("금지 쌍 — 소스 검사(명세 §3-2·§9-1)", () => {
  it("검사기 자체 — 한 글 안의 바탕·글자 쌍을 변형 접두어·투명도를 떼고 찾고, 다른 글로 나뉜 쌍·비슷한 이름(accent-hover·accent-fg)·주석은 건너뛴다", () => {
    const sample = [
      "const a = \"hover:bg-accent-tint aria-[current=page]:text-accent/80\";",
      "const b = { box: \"bg-accent-tint text-text\", icon: \"text-accent\" };",
      "const c = `p-2 ${on ? \"bg-surface-3 [&>svg]:text-accent text-text-3\" : \"\"}`;",
      "const d = \"bg-surface-3 text-accent-hover text-accent-fg bg-accent-tint/50 !text-text-2\";",
      "// 주석의 bg-surface-3 text-danger는 건너뜀",
      "const e = <div className=\"bg-surface-3/60 text-neutral\" />;",
    ].join("\n");
    expect(pairHits("sample.tsx", sample, "tint")).toEqual(["1: bg-accent-tint + text-accent"]);
    expect(pairHits("sample.tsx", sample, "surface-3")).toEqual([
      "3: bg-surface-3 + text-text-3",
      "3: bg-surface-3 + text-accent",
      "6: bg-surface-3 + text-neutral",
    ]);
  });

  it("검사기 자체 — 부모가 칠한 바탕(className 글, 그 바탕을 칠하는 톤의 Banner) 위 자식 글자를 찾고, 칠하지 않는 톤·변수 톤·자식 없는 요소는 건너뛴다", () => {
    const sample = [
      "const a = <Banner tone=\"info\"><p className=\"text-xs\"><Link className=\"text-accent underline\">x</Link></p></Banner>;",
      "const b = <Banner tone=\"warn\"><Link className=\"text-accent\">x</Link></Banner>;",
      "const c = <Banner><span className=\"text-accent\" /></Banner>;",
      "const d = <Banner tone={ok ? \"info\" : \"warn\"}><a className=\"hover:text-accent\">x</a></Banner>;",
      "const e = <Banner tone={view.tone}><a className=\"text-accent\">x</a></Banner>;",
      "const f = <li className={`p-2 ${on ? \"bg-accent-tint\" : \"\"}`}><span className=\"text-accent-fg text-text\" /><b className=\"text-accent/80\" /></li>;",
      "const g = <div className=\"bg-accent-tint text-accent\" />;",
      "const h = <div className=\"hover:bg-surface-3\"><span className=\"text-text-3\">x</span></div>;",
    ].join("\n");
    const tones = { "bg-accent-tint": ["info"], "bg-surface-3": [] };
    expect(inheritedHits("sample.tsx", sample, "tint", tones)).toEqual([
      "1: <Banner tone=\"info\">(1행) 안 text-accent",
      "4: <Banner tone={ok ? \"info\" : \"warn\"}>(4행) 안 text-accent",
      "6: bg-accent-tint 요소(6행) 안 text-accent",
    ]);
    expect(inheritedHits("sample.tsx", sample, "surface-3", tones)).toEqual(["8: bg-surface-3 요소(8행) 안 text-text-3"]);
    // 공용 키트(P2)가 안내(info)를 중립(surface-2 바탕)으로 바꿔 지금 표에는 accent 틴트를 칠하는 Banner 톤이 없습니다(QA-459).
    expect(bannerTonesByBack()).toEqual({ "bg-surface-3": [], "bg-accent-tint": [] });
  });

  it("surface-3(덮개 안 hover·눌림) 바탕 위에 text-3·neutral·accent·danger 글자를 두지 않는다", () => {
    expect(offenders("surface-3")).toEqual([]);
  });

  // QA-459: 어두운 한 벌(P1)에서 accent 틴트 위 accent 글자가 4.47:1로 4.5에 못 미쳤다. 고치기 전에 어기던 자리 세 곳:
  //  - components/shell/SideNav.tsx — 현재 메뉴(`bg-accent-tint font-semibold text-accent`, lg 이상 모든 화면) → 글자만 text-text
  //  - components/ui/classes.ts — filterChipClasses 켠 상태(`border-accent bg-accent-tint font-semibold text-accent` — 컨센서스·환율 비교·정보 수집 둘) → 글자만 text-text
  //  - components/screens/brokerage/BrokerageSection.tsx — 실제 계좌 탭 안내 상자(`<Banner tone="info">` — 상자 바탕 bg-accent-tint) 안 링크
  //    '…의 실제 계좌 탭'(`text-accent`, 12px). 바탕은 부모 Banner가 칠해 같은 글 검사로는 안 보였고(P1 검토 지적), 부모 바탕 검사(inheritedHits)가 잡습니다.
  //    실제 계좌 모듈은 겉모양만 공용 키트를 통해 바꾸므로(ADR 0042 결정 8) 그 파일이 아니라 키트에서 — 안내 톤을 중립(surface-2 바탕, 명세 §3-4)으로.
  it("QA-459: accent 틴트 바탕 위에 accent 글자를 두지 않는다", () => {
    expect(offenders("tint")).toEqual([]);
  });
});

describe("모서리 — 소스 검사(명세 §3-8)", () => {
  // 모서리 토큰(card·control)만 4px로 바뀌고 Tailwind 기본 단계(md 6px·lg 8px·xl 12px…)는 그대로 나오므로, 그 이름을 쓰면 4px 하나에서 벗어납니다.
  // 알약(rounded-full)은 상태 점·토글 손잡이·아바타 말고는 공용 키트 단계(P2)에서 정리합니다 — 여기서는 보지 않습니다.
  const WIDE_RADIUS = /^rounded(-(t|r|b|l|s|e|tl|tr|bl|br|ss|se|es|ee))?-(md|lg|xl|2xl|3xl|4xl)$/;

  it("제품 소스의 클래스 글에 rounded-md·lg·xl·2xl·3xl·4xl(변 방향 포함)이 없다 — 모서리는 rounded-card·rounded-control", () => {
    const hits = sourceFiles(SRC).flatMap((path) => {
      const source = parse(path, readFileSync(path, "utf8"));
      return textPieces(source)
        .filter((piece) => [...utilitiesOf(piece.text)].some((name) => WIDE_RADIUS.test(name)))
        .map((piece) => `${relative(SRC, path)}:${lineOf(source, piece)}`);
    });
    expect(hits).toEqual([]);
  });
});
