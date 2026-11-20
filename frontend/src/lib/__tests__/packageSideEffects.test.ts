/**
 * 패턴 배럴 번들 크기(작업대 P8 결정 거리 '배럴 sideEffects' — 사용자 결정 2026-11-20 '측정 뒤 권장안대로')를 지킵니다.
 *
 * package.json의 `sideEffects`는 부작용이 있는 파일 목록이고, 목록 밖 파일은 번들러가 쓰지 않는 다시 내보내기를 버려도 되는 파일로 봅니다. 여기서는
 * 공용 패턴(`components/patterns`)만 부작용 없음으로 두어, 패턴 배럴(`components/patterns/index.ts`)을 가져오는 화면이 쓰지 않는 패턴 모듈을 받지 않게
 * 합니다(전체를 부작용 없음으로 두면 경로 여섯이 오히려 커짐 — 진행 기록 P8 '번들'). 그래서 src 아래 다른 폴더가 새로 생기면 목록에 함께 넣어야 합니다 —
 * 빠뜨리면 그 폴더도 조용히 부작용 없음이 되므로 이 시험이 막습니다. CSS는 부작용만으로 가져오므로(전역 globals.css) 늘 목록에 있어야 합니다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const SRC = join(ROOT, "src");
const SIDE_EFFECT_FREE = new Set(["components/patterns"]);
const SKIP = new Set(["__tests__", "__checks__"]);

function sideEffects(): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as { sideEffects?: unknown };
  expect(Array.isArray(pkg.sideEffects)).toBe(true);
  return pkg.sideEffects as string[];
}

function dirs(path: string): string[] {
  return readdirSync(path).filter((name) => !SKIP.has(name) && statSync(join(path, name)).isDirectory());
}

describe("package.json sideEffects(패턴만 부작용 없음)", () => {
  it("CSS는 부작용 있음", () => {
    expect(sideEffects()).toContain("**/*.css");
  });

  it("src 아래 패턴 밖의 모든 폴더와 components 바로 아래 파일이 목록에 있음", () => {
    const listed = new Set(sideEffects());
    const expected = [
      ...dirs(SRC).filter((name) => name !== "components").map((name) => `./src/${name}/**`),
      ...dirs(join(SRC, "components"))
        .filter((name) => !SIDE_EFFECT_FREE.has(`components/${name}`))
        .map((name) => `./src/components/${name}/**`),
      "./src/components/*.tsx",
    ];
    expect(expected.filter((glob) => !listed.has(glob))).toEqual([]);
  });

  it("패턴 폴더는 목록에 없음(부작용 없음)", () => {
    expect(sideEffects().filter((glob) => glob.includes("components/patterns") || glob === "./src/components/**")).toEqual([]);
  });

  it("components 바로 아래에는 .tsx 밖의 코드 파일이 없음(있으면 목록의 './src/components/*.tsx'가 덮지 못함)", () => {
    const loose = readdirSync(join(SRC, "components")).filter(
      (name) => /\.(ts|tsx|js|jsx|mts)$/.test(name) && !name.endsWith(".tsx"),
    );
    expect(loose).toEqual([]);
  });
});
