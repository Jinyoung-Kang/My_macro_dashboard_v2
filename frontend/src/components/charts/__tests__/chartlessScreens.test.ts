/**
 * 차트가 없는 화면의 첫 로딩에 recharts가 들지 않게 — 가져오기 그래프를 소스로 따라갑니다(ADR 0047 결정 6, 성능 개선 작업 C3).
 *
 * 홈('/')과 정보 개요('/info/[tab]')는 차트를 그리지 않습니다. 이 화면들(과 모든 화면이 함께 싣는 대시보드 레이아웃·셸)에서 별칭(@/)·상대 경로로
 * 닿는 모듈 가운데 recharts를 가져오거나 차트 배럴(`@/components/charts` — recharts를 가져옴)을 가져오는 것이 없어야 합니다. 차트 색만 필요하면
 * `@/components/charts/frame`(recharts 없음)에서 가져옵니다(bookColors.ts 선례). 2026-11-22 분석: 홈 첫 로딩 스크립트 23개 약 415 KB(gzip),
 * recharts 묶음(원본 432 KB)은 정적 가져오기로는 들지 않았고 보이는 링크의 미리 받기로 왔음 — 미리 받기를 가리킬 때만으로 바꾼 뒤 이 시험이 그 상태를 지킵니다.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");

/** 확장자 없는 모듈 경로를 실제 파일로(.ts·.tsx·/index.ts·/index.tsx). 없으면 null(패키지·자산). */
function fileOf(bare: string): string | null {
  for (const candidate of [bare, `${bare}.ts`, `${bare}.tsx`, join(bare, "index.ts"), join(bare, "index.tsx")]) {
    if (existsSync(candidate) && /\.tsx?$/.test(candidate)) return candidate;
  }
  return null;
}

/** 한 파일이 가져오는 것 — 패키지 이름과 별칭·상대 경로 파일. `import type`은 묶음에 들지 않아 뺍니다. */
function importsOf(path: string): { packages: string[]; files: string[] } {
  const code = readFileSync(path, "utf8");
  const packages: string[] = [];
  const files: string[] = [];
  for (const match of code.matchAll(/(?:^|\n)\s*(import|export)\s+(type\s+)?[^"';]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s+["']([^"']+)["']/g)) {
    if (match[2]) continue;
    const spec = match[3] ?? match[4] ?? match[5];
    if (spec.startsWith("@/")) {
      const file = fileOf(join(root, spec.slice(2)));
      if (file) files.push(file);
    } else if (spec.startsWith(".")) {
      const file = fileOf(resolve(dirname(path), spec));
      if (file) files.push(file);
    } else {
      packages.push(spec);
    }
  }
  return { packages, files };
}

/** 시작 파일들에서 닿는 모든 파일과, recharts에 닿는 길(시작 → … → recharts를 가져오는 파일). */
function reach(starts: string[]): { files: Set<string>; chartPaths: string[] } {
  const seen = new Set<string>();
  const parent = new Map<string, string | null>();
  const queue = starts.map((start) => {
    parent.set(start, null);
    return start;
  });
  const chartPaths: string[] = [];
  while (queue.length) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const { packages, files } = importsOf(file);
    if (packages.some((name) => name === "recharts" || name.startsWith("recharts/"))) {
      const chain: string[] = [];
      for (let at: string | null = file; at; at = parent.get(at) ?? null) chain.unshift(relative(root, at));
      chartPaths.push(chain.join(" → "));
    }
    for (const next of files) {
      if (!parent.has(next)) parent.set(next, file);
      queue.push(next);
    }
  }
  return { files: seen, chartPaths };
}

const entry = (path: string) => join(root, path);

describe("차트가 없는 화면은 recharts에 닿지 않는다", () => {
  it.each([
    ["대시보드 레이아웃·셸(모든 화면이 함께 실음)", ["app/layout.tsx", "app/(dashboard)/layout.tsx"]],
    ["홈('/')", ["app/(dashboard)/page.tsx"]],
    ["정보 개요('/info/[tab]')", ["app/(dashboard)/info/[tab]/page.tsx"]],
  ])("%s", (_name, starts) => {
    const { files, chartPaths } = reach(starts.map(entry));
    expect(files.size).toBeGreaterThan(starts.length);
    expect(chartPaths).toEqual([]);
  });

  it("검사가 비어 통과하지 않는다 — 차트가 있는 매크로 화면은 recharts에 닿는다", () => {
    expect(reach([entry("app/(dashboard)/macro/page.tsx")]).chartPaths.length).toBeGreaterThan(0);
  });
});
