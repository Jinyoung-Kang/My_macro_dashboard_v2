/**
 * 정보 검색 화면의 어두운 범위 토큰(globals.css의 [data-scope="search"] 블록 — ADR 0041 결정 11).
 *  - 앱 테마와 상관없이 늘 어두움(color-scheme: dark) — 블록이 미디어 쿼리·data-theme 안에 있지 않다
 *  - 화면이 쓰는 토큰을 모두 다시 선언한다(var()로 정의된 --focus 등은 :root에서 계산된 값이 상속되므로 빠지면 앱 테마 값이 남음)
 *  - WCAG 대비: 글자·상태·강조 색은 bg·surface·surface-2 위 4.5:1 이상, 경계(border-strong)·포커스 링은 surface 위 3:1 이상,
 *    톤 틴트(color-mix oklab 10%) 위 같은 톤 글자 4.5:1 이상, 강조·위험 바탕 위 글자 4.5:1 이상
 * 대비 계산은 명세(docs/specs/2026-10-31-v2-coinbase-ui.md)와 같은 WCAG 상대휘도입니다.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(resolve(__dirname, "../../app/globals.css"), "utf8");

/** 선택자가 정확히 [data-scope="search"]인 블록의 본문. */
function scopeBlock(): string {
  const match = /(^|\n)\[data-scope="search"\]\s*\{([^}]*)\}/.exec(CSS);
  if (!match) throw new Error("[data-scope=\"search\"] 블록이 globals.css에 없습니다");
  return match[2];
}

function tokens(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of scopeBlock().matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  return out;
}

// ------------------------------------------------------------------ 색 계산

function rgb(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`#rrggbb 꼴이 아닙니다: ${hex}`);
  return [0, 2, 4].map((at) => parseInt(match[1].slice(at, at + 2), 16) / 255) as [number, number, number];
}

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function toOklab([r, g, b]: [number, number, number]): [number, number, number] {
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

function fromOklab([L, A, B]: [number, number, number]): [number, number, number] {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const out = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return out.map((c) => Math.min(1, Math.max(0, gamma(c)))) as [number, number, number];
}

/** globals.css @theme inline의 틴트와 같은 계산 — color-mix(in oklab, tone 10%, surface). */
function tint(tone: [number, number, number], surface: [number, number, number]): [number, number, number] {
  const a = toOklab(tone);
  const b = toOklab(surface);
  return fromOklab([0, 1, 2].map((i) => a[i] * 0.1 + b[i] * 0.9) as [number, number, number]);
}

// ------------------------------------------------------------------ 시험

const BACKGROUNDS = ["--bg", "--surface", "--surface-2"] as const;
const TEXT_TOKENS = ["--text", "--text-2", "--text-3", "--accent", "--accent-hover", "--up", "--down", "--warn", "--neutral", "--ok", "--danger"] as const;

describe("어두운 범위 블록", () => {
  it("앱 테마를 따르지 않는다 — 미디어 쿼리·data-theme 밖의 맨 바깥 블록이고 color-scheme은 dark", () => {
    const block = scopeBlock();
    expect(block).toMatch(/color-scheme:\s*dark;/);
    const before = CSS.slice(0, CSS.indexOf('[data-scope="search"]'));
    // 바로 앞의 열린 괄호가 모두 닫혔다 = 다른 블록(@media 등) 안에 있지 않다
    expect((before.match(/\{/g) ?? []).length).toBe((before.match(/\}/g) ?? []).length);
  });

  it("화면이 쓰는 토큰을 모두 다시 선언한다(--focus 등 var() 토큰 포함, 모서리 4px)", () => {
    const t = tokens();
    for (const name of [...BACKGROUNDS, ...TEXT_TOKENS, "--border", "--border-strong", "--accent-fg", "--danger-fg", "--focus", "--elev-overlay"]) {
      expect(t[name], name).toBeTruthy();
    }
    expect(t["--radius-card"]).toBe("4px");
    expect(t["--radius-control"]).toBe("4px");
    // 셸의 :root 값이 따라 들어오지 않게 실제 색 값으로 둡니다(var() 참조 없음).
    for (const name of [...BACKGROUNDS, ...TEXT_TOKENS, "--border", "--border-strong", "--accent-fg", "--danger-fg", "--focus"]) {
      expect(t[name], name).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("바탕색·글자색은 레이어 밖 토큰 블록이 아니라 @layer base에 — 범위 표지를 단 대화상자의 bg-surface 같은 유틸리티가 이긴다", () => {
    // 레이어 밖 선언은 우선순위와 상관없이 @layer utilities를 이깁니다. 토큰 블록에는 사용자 속성(--*)과 color-scheme만 둡니다.
    const plain = scopeBlock()
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(";")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("--"));
    expect(plain.map((line) => line.split(":")[0].trim())).toEqual(["color-scheme"]);
    const base = /@layer base\s*\{\s*\[data-scope="search"\]\s*\{([^}]*)\}\s*\}/.exec(CSS);
    expect(base, "@layer base { [data-scope=\"search\"] { … } }").toBeTruthy();
    expect(base?.[1]).toMatch(/background-color:\s*var\(--bg\);/);
    expect(base?.[1]).toMatch(/color:\s*var\(--text\);/);
  });

  it("바탕·면은 어두운 단계(#111418·#1c2127·#252a31)", () => {
    const t = tokens();
    expect([t["--bg"], t["--surface"], t["--surface-2"]].map((v) => v.toLowerCase())).toEqual(["#111418", "#1c2127", "#252a31"]);
  });
});

describe("WCAG 대비", () => {
  const t = tokens();

  it.each(TEXT_TOKENS)("%s — bg·surface·surface-2 위 4.5:1 이상", (name) => {
    for (const bg of BACKGROUNDS) {
      const ratio = contrast(rgb(t[name]), rgb(t[bg]));
      expect(ratio, `${name} on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("입력칸 경계(border-strong)는 surface 위 3:1 이상, 포커스 링은 bg·surface·surface-2 위 3:1 이상", () => {
    expect(contrast(rgb(t["--border-strong"]), rgb(t["--surface"]))).toBeGreaterThanOrEqual(3);
    for (const bg of BACKGROUNDS) expect(contrast(rgb(t["--focus"]), rgb(t[bg]))).toBeGreaterThanOrEqual(3);
  });

  it("강조·위험 바탕 위 글자(--accent-fg·--danger-fg)가 4.5:1 이상 — 주 단추 hover 바탕(accent-hover) 위에서도", () => {
    expect(contrast(rgb(t["--accent-fg"]), rgb(t["--accent"]))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb(t["--accent-fg"]), rgb(t["--accent-hover"]))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb(t["--danger-fg"]), rgb(t["--danger"]))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["--warn", "--ok", "--danger"] as const)("%s 틴트(배너·배지 바탕) 위 같은 톤 글자 4.5:1 이상, 본문 글자도", (name) => {
    const back = tint(rgb(t[name]), rgb(t["--surface"]));
    expect(contrast(rgb(t[name]), back)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb(t["--text"]), back)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb(t["--text-2"]), tint(rgb(t["--accent"]), rgb(t["--surface"])))).toBeGreaterThanOrEqual(4.5);
  });
});
