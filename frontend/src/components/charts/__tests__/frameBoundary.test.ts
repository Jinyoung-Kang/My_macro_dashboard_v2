/**
 * 차트는 `@/components/charts`에서만 가져온다 — 예외 하나(ADR 0004 Coinbase식 덧붙임): 차트가 없는 화면이 계열 색 상수만 쓸 때는 recharts를
 * 가져오지 않는 차트 틀 `@/components/charts/frame`. 이 예외가 서는 두 조건(틀이 recharts를 가져오지 않음, 하위 경로를 가져오는 곳은 그 예외뿐)을
 * 소스로 지킵니다 — 어긋나면 홈 '/'가 계좌 행 색 고리 때문에 recharts 조각을 다시 싣지만(장중 명세 §4-1) 다른 시험은 그대로 통과합니다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");

/** src 아래 제품 소스(.ts·.tsx) — 시험 폴더는 뺍니다(시험은 vi.mock("@/components/charts")로 차트를 바꿔 끼움). */
function sources(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "__tests__" && name !== "__checks__") walk(path);
      } else if (/\.tsx?$/.test(name)) {
        files.push(path);
      }
    }
  };
  walk(root);
  return files;
}

describe("차트 경계(ADR 0004)", () => {
  it("차트 폴더 밖에서 차트 하위 경로를 가져오는 곳은 계좌 색 표의 차트 틀 하나 — 별칭(@/)·상대 경로 모두", () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(50);
    const charts = join(root, "components", "charts");
    const subpaths = files
      .filter((path) => !path.startsWith(charts + "/"))
      .flatMap((path) => [...readFileSync(path, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)]
        .map((match) => match[1])
        .map((spec) => spec.startsWith("@/") ? join(root, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(path), spec) : null)
        .filter((target): target is string => target !== null && target.startsWith(charts + "/") && target !== join(charts, "index"))
        .map((target) => `${relative(root, path)} → ${relative(charts, target)}`))
      .sort();
    expect(subpaths).toEqual(["components/screens/paper/bookColors.ts → frame"]);
  });

  it("차트 틀(frame.tsx)은 recharts를 가져오지 않는다 — 가져오는 모듈은 react 하나", () => {
    const text = readFileSync(join(root, "components", "charts", "frame.tsx"), "utf8");
    expect(text).not.toMatch(/["']recharts["']/);
    expect([...text.matchAll(/^import\b[^;]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1])).toEqual(["react"]);
  });
});
