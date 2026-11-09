/**
 * ISA 계좌(연결되지 않은 다른 증권사 계좌 — ADR 0029) 화면 모듈의 경계를 소스로 지킵니다(명세 docs/specs/2026-11-06-isa-manual-account.md §7·§8).
 *
 *  - ISA 모듈(components/screens/isa/*, lib/isa.ts, lib/types/isa.ts)을 그 밖에서 가져오는 곳은 PaperScreen.tsx 하나 — 모의 장부·홈·패킷 쪽 모듈로
 *    ISA 자료가 흘러가는 길이 없게(별칭(@/)·상대 경로·동적 import 모두)
 *  - 모의·홈 순수 함수(lib/paper*·lib/home*)와 배럴 lib/types.ts는 ISA 모듈을 가져오지도 내보내지도 않는다
 *  - ISA 모듈은 실제 계좌 조회(brokerage)·실제 매매(realtrade) 모듈을 가져오지 않고, 그 두 모듈도 ISA 모듈을 모른다
 *  - 쓰기(apiPost)는 ISA 모듈 안에서 endpoints.isa.*로만 — apiDelete·fetch는 없고, endpoints.isa를 쓰는 곳도 이 모듈뿐
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const isaDir = join(root, "components", "screens", "isa");
const ISA_LIB = [join(root, "lib", "isa"), join(root, "lib", "types", "isa")];
const OTHER_REAL = [
  { dir: join(root, "components", "screens", "brokerage"), lib: [join(root, "lib", "brokerage"), join(root, "lib", "types", "brokerage")] },
  { dir: join(root, "components", "screens", "realtrade"), lib: [join(root, "lib", "realtrade"), join(root, "lib", "types", "realtrade")] },
];

/** src 아래 제품 소스(.ts·.tsx) — 시험·자가 검증 폴더는 뺍니다. */
function sources(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "__tests__" && name !== "__checks__") walk(path);
      } else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
        files.push(path);
      }
    }
  };
  walk(root);
  return files;
}

const withoutExt = (path: string) => path.replace(/\.tsx?$/, "");

/** ISA 모듈인가(확장자 없는 경로). */
function isIsaModule(path: string): boolean {
  const bare = withoutExt(path);
  return bare.startsWith(isaDir + "/") || ISA_LIB.includes(bare);
}

/** 실제 계좌 조회·실제 매매 모듈인가. */
function isOtherRealModule(path: string): boolean {
  const bare = withoutExt(path);
  return OTHER_REAL.some(({ dir, lib }) => bare.startsWith(dir + "/") || lib.includes(bare));
}

/** 한 파일이 가져오는 모듈의 절대 경로(확장자 없음) — 별칭(@/)·상대 경로만, 패키지는 뺍니다. */
function importsOf(path: string): string[] {
  return [...readFileSync(path, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)]
    .map((match) => match[1])
    .map((spec) => (spec.startsWith("@/") ? join(root, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(path), spec) : null))
    .filter((target): target is string => target !== null);
}

const isaFiles = () => sources().filter(isIsaModule);

/** 주석을 뗀 코드 — 규칙을 설명하는 주석이 걸리지 않게. 이 모듈의 소스에는 '//'가 든 문자열(주소)이 없습니다. */
const codeOf = (path: string) =>
  readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("ISA 계좌 화면 경계(ADR 0029)", () => {
  it("ISA 모듈이 있다 — 칸·표·장부 창·시작 창·쓰기 요청·순수 함수·응답 계약", () => {
    const files = isaFiles().map((path) => relative(root, path)).sort();
    expect(files).toEqual([
      "components/screens/isa/IsaFillsDialog.tsx",
      "components/screens/isa/IsaLedgerDialog.tsx",
      "components/screens/isa/IsaSection.tsx",
      "components/screens/isa/IsaStartDialog.tsx",
      "components/screens/isa/IsaTables.tsx",
      "components/screens/isa/isaRequests.ts",
      "lib/isa.ts",
      "lib/types/isa.ts",
    ]);
  });

  it("밖에서 ISA 모듈을 가져오는 곳은 PaperScreen.tsx 하나(칸)", () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(50);
    const crossings = files
      .filter((path) => !isIsaModule(path))
      .flatMap((path) => importsOf(path)
        .filter(isIsaModule)
        .map((target) => `${relative(root, path)} → ${relative(root, target)}`))
      .sort();
    expect(crossings).toEqual(["components/screens/paper/PaperScreen.tsx → components/screens/isa/IsaSection"]);
  });

  it("모의·홈 순수 함수(lib/paper*·lib/home*)와 배럴 lib/types.ts는 ISA 모듈을 가져오지도 내보내지도 않는다", () => {
    const lib = join(root, "lib");
    const guarded = readdirSync(lib)
      .filter((name) => /^(paper|home).*\.tsx?$/.test(name) || name === "types.ts")
      .map((name) => join(lib, name));
    expect(guarded.length).toBeGreaterThan(5);
    for (const path of guarded) {
      expect(importsOf(path).filter(isIsaModule), relative(root, path)).toEqual([]);
      expect(readFileSync(path, "utf8"), relative(root, path)).not.toMatch(/types\/isa|lib\/isa|\.\/isa["']|screens\/isa/);
    }
  });

  it("ISA 모듈은 실제 계좌 조회·실제 매매 모듈을 가져오지 않고, 그 두 모듈도 ISA 모듈을 모른다", () => {
    const fromIsa = isaFiles().flatMap((path) => importsOf(path)
      .filter(isOtherRealModule)
      .map((target) => `${relative(root, path)} → ${relative(root, target)}`));
    expect(fromIsa).toEqual([]);
    for (const path of isaFiles()) {
      expect(codeOf(path), relative(root, path)).not.toMatch(/endpoints\.(brokerage|realtrade)\b/);
    }
    const others = sources().filter(isOtherRealModule);
    expect(others.length).toBeGreaterThan(5);
    for (const path of others) {
      expect(importsOf(path).filter(isIsaModule), relative(root, path)).toEqual([]);
      expect(codeOf(path), relative(root, path)).not.toMatch(/endpoints\.isa\b|screens\/isa|lib\/isa|types\/isa/);
    }
  });

  it("쓰기는 apiPost(endpoints.isa.*)뿐 — apiDelete·fetch가 없고, apiPost의 첫 인자는 모두 endpoints.isa", () => {
    const offenders: string[] = [];
    const posts: string[] = [];
    for (const path of isaFiles()) {
      const text = codeOf(path);
      const name = relative(root, path);
      if (/\bapiDelete\b/.test(text)) offenders.push(`${name}: apiDelete`);
      if (/\bfetch\s*\(/.test(text)) offenders.push(`${name}: fetch`);
      for (const match of text.matchAll(/\bapiPost\s*(?:<[^>()]*>)?\s*\(\s*([^,)]+)/g)) {
        const target = match[1].trim();
        const leaf = /^endpoints\.isa\.(start|ledger|deleteLedger|skipInstruction|confirmInstructions|fills)\b/.exec(target)?.[1];
        if (leaf) posts.push(leaf);
        else offenders.push(`${name}: apiPost(${target})`);
      }
      // apiPost를 다른 이름으로 넘기거나 감싸 부르는 길(참조만 쓰기)도 막습니다 — 부르는 자리 말고 apiPost가 나오는 곳은 가져오기 한 줄뿐이어야 합니다.
      const mentions = [...text.matchAll(/\bapiPost\b/g)].length;
      const calls = [...text.matchAll(/\bapiPost\s*(?:<[^>()]*>)?\s*\(/g)].length;
      const imports = /import\s*\{[^}]*\bapiPost\b[^}]*\}\s*from\s*["']@\/lib\/api["']/.test(text) ? 1 : 0;
      if (mentions !== calls + imports) offenders.push(`${name}: apiPost를 부르지 않고 참조`);
    }
    expect(offenders).toEqual([]);
    // 시작·장부 행 추가·고치기·지우기·지시 건너뜀·'매매함' 표시가 모두 이 모듈 안에서 나갑니다.
    expect([...new Set(posts)].sort()).toEqual(["confirmInstructions", "deleteLedger", "fills", "ledger", "skipInstruction", "start"]);
  });

  it("endpoints.isa를 쓰는 곳은 ISA 모듈뿐(경로 정의 lib/endpoints.ts 제외)", () => {
    const users = sources()
      .filter((path) => !isIsaModule(path) && withoutExt(path) !== join(root, "lib", "endpoints"))
      .filter((path) => /\bendpoints\.isa\b/.test(codeOf(path)))
      .map((path) => relative(root, path));
    expect(users).toEqual([]);
  });
});
