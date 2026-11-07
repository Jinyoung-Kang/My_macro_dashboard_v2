/**
 * 장중 판단 결정 종류(INTRADAY_<순번>)를 화면 소스에 하나씩 박지 않게 지킵니다(ADR 0031 — 세션당 최대 3회, 그 전 2회).
 *
 * 순번이 2에서 3으로 늘 때 'INTRADAY_1 || INTRADAY_2'처럼 적힌 곳은 셋째를 조용히 빠뜨립니다(이름표·재시도 없음 표시). 그래서 src의 .ts·.tsx(시험·
 * 자가 검증 폴더 제외)에서 INTRADAY_<숫자> 글자를 찾아, 그 글자가 있는 파일은 순번 전부(1~3)를 함께 담고(이름표 표처럼 목록 전체를 적는 곳), 한 종류와
 * 같은지 비교하는 코드(=== "INTRADAY_n")는 없게 합니다 — 종류 판정은 lib/paper의 isIntradayKind로 합니다. 백엔드 쪽 같은 시험은
 * IntradayKindsLockTest입니다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decisionKindLabel, decisionStatusBadge, isIntradayKind } from "@/lib/paper";

const SRC = resolve(__dirname, "../..");
const SKIP_DIRS = new Set(["__tests__", "__checks__", "node_modules"]);
/** 코드가 부를 수 있는 장중 판단 순번 수 — 백엔드 RuleBookService.INTRADAY_MAX와 같은 값. */
const INTRADAY_MAX = 3;

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

describe("장중 판단 종류 글자", () => {
  it("INTRADAY_<숫자>를 적은 파일은 순번 전부(1~3)를 담고, 한 종류와 같은지 비교하지 않는다", () => {
    const problems: string[] = [];
    const everyKind = Array.from({ length: INTRADAY_MAX }, (_, index) => String(index + 1));
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      const slots = new Set([...text.matchAll(/INTRADAY_(\d+)\b/g)].map((match) => match[1]));
      const name = relative(SRC, file);
      if (slots.size > 0 && everyKind.some((slot) => !slots.has(slot))) {
        problems.push(`${name}: INTRADAY_${[...slots].sort().join("·")}만 적음 — 순번 전부를 적거나 isIntradayKind로`);
      }
      if (/[!=]==?\s*["'`]INTRADAY_\d/.test(text) || /["'`]INTRADAY_\d+["'`]\s*[!=]==?/.test(text)) {
        problems.push(`${name}: 장중 판단 종류 하나와 비교함 — isIntradayKind로`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("셋째 장중 판단의 이름과 '재시도 없음' 표시, 종류 판정", () => {
    expect(decisionKindLabel("INTRADAY_3")).toBe("장중 판단 3");
    expect(decisionStatusBadge("API_ERROR", "INTRADAY_3").label).toContain("재시도 없음");
    expect(decisionStatusBadge("FORMAT_ERROR", "INTRADAY_2").label).toContain("재시도 없음");
    expect(isIntradayKind("INTRADAY_3")).toBe(true);
    expect(isIntradayKind("INTRADAY_")).toBe(false);
    expect(isIntradayKind("CHECKPOINT")).toBe(false);
    expect(isIntradayKind(null)).toBe(false);
  });
});
