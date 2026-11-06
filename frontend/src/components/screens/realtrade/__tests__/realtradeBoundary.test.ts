/**
 * 실제 매매(실제 계좌가 모의 한국 책을 따라 하기 — ADR 0028) 화면 모듈의 경계를 소스로 지킵니다(명세 docs/specs/2026-11-06-real-trade-mirror.md §8).
 *
 *  - 실제 매매 모듈(components/screens/realtrade/*, lib/realtrade.ts, lib/types/realtrade.ts)을 그 밖에서 가져오는 곳은 PaperScreen.tsx 하나 —
 *    모의 장부·홈·패킷 쪽 모듈로 실제 매매 자료가 흘러가는 길이 없게(별칭(@/)·상대 경로·동적 import 모두)
 *  - 모의·홈 순수 함수(lib/paper*·lib/home*)와 배럴 lib/types.ts는 실제 매매 모듈을 가져오지도 내보내지도 않는다
 *  - 실제 매매 모듈은 실제 계좌 조회(brokerage) 모듈을 가져오지 않는다(둘을 잇는 곳은 PaperScreen의 extraActions 하나)
 *  - 쓰기(apiPost)는 실제 매매 모듈 안에서 endpoints.realtrade.*로만 — apiDelete·fetch는 없고, endpoints.realtrade를 쓰는 곳도 이 모듈뿐
 * 실제 계좌 조회의 경계(brokerageBoundary.test.ts — 조회 모듈은 쓰기 함수를 가져오지 않음)는 그대로입니다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const realtradeDir = join(root, "components", "screens", "realtrade");
const LIB_MODULES = [join(root, "lib", "realtrade"), join(root, "lib", "types", "realtrade")];
const brokerageDir = join(root, "components", "screens", "brokerage");
const BROKERAGE_LIB = [join(root, "lib", "brokerage"), join(root, "lib", "types", "brokerage")];

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

/** 실제 매매 모듈인가(확장자 없는 경로). */
function isRealtradeModule(path: string): boolean {
  const bare = withoutExt(path);
  return bare.startsWith(realtradeDir + "/") || LIB_MODULES.includes(bare);
}

/** 실제 계좌 조회 모듈인가. */
function isBrokerageModule(path: string): boolean {
  const bare = withoutExt(path);
  return bare.startsWith(brokerageDir + "/") || BROKERAGE_LIB.includes(bare);
}

/** 한 파일이 가져오는 모듈의 절대 경로(확장자 없음) — 별칭(@/)·상대 경로만, 패키지는 뺍니다. */
function importsOf(path: string): string[] {
  return [...readFileSync(path, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)]
    .map((match) => match[1])
    .map((spec) => (spec.startsWith("@/") ? join(root, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(path), spec) : null))
    .filter((target): target is string => target !== null);
}

const realtradeFiles = () => sources().filter(isRealtradeModule);

/** 주석을 뗀 코드 — 규칙을 설명하는 주석이 걸리지 않게. 이 모듈의 소스에는 '//'가 든 문자열(주소)이 없습니다. */
const codeOf = (path: string) =>
  readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("실제 매매 화면 경계(ADR 0028)", () => {
  it("실제 매매 모듈이 있다 — 칸·단추·켜기 창·상태 공급자·순수 함수·응답 계약", () => {
    const files = realtradeFiles().map((path) => relative(root, path)).sort();
    expect(files).toEqual(expect.arrayContaining([
      "components/screens/realtrade/RealTradeEnableDialog.tsx",
      "components/screens/realtrade/RealTradePanel.tsx",
      "components/screens/realtrade/RealTradeProvider.tsx",
      "components/screens/realtrade/RealTradeToggle.tsx",
      "lib/realtrade.ts",
      "lib/types/realtrade.ts",
    ]));
  });

  it("밖에서 실제 매매 모듈을 가져오는 곳은 PaperScreen.tsx 하나(공급자·칸·단추)", () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(50);
    const crossings = files
      .filter((path) => !isRealtradeModule(path))
      .flatMap((path) => importsOf(path)
        .filter(isRealtradeModule)
        .map((target) => `${relative(root, path)} → ${relative(root, target)}`))
      .sort();
    expect(crossings).toEqual([
      "components/screens/paper/PaperScreen.tsx → components/screens/realtrade/RealTradePanel",
      "components/screens/paper/PaperScreen.tsx → components/screens/realtrade/RealTradeProvider",
      "components/screens/paper/PaperScreen.tsx → components/screens/realtrade/RealTradeToggle",
    ]);
  });

  it("모의·홈 순수 함수(lib/paper*·lib/home*)와 배럴 lib/types.ts는 실제 매매 모듈을 가져오지도 내보내지도 않는다", () => {
    const lib = join(root, "lib");
    const guarded = readdirSync(lib)
      .filter((name) => /^(paper|home).*\.tsx?$/.test(name) || name === "types.ts")
      .map((name) => join(lib, name));
    expect(guarded.length).toBeGreaterThan(5);
    for (const path of guarded) {
      expect(importsOf(path).filter(isRealtradeModule), relative(root, path)).toEqual([]);
      expect(readFileSync(path, "utf8"), relative(root, path)).not.toMatch(/types\/realtrade|lib\/realtrade|\.\/realtrade["']/);
    }
  });

  it("실제 매매 모듈은 실제 계좌 조회(brokerage) 모듈을 가져오지 않고, 조회 모듈도 실제 매매 모듈을 모른다", () => {
    const fromRealtrade = realtradeFiles().flatMap((path) => importsOf(path)
      .filter(isBrokerageModule)
      .map((target) => `${relative(root, path)} → ${relative(root, target)}`));
    expect(fromRealtrade).toEqual([]);
    const brokerageFiles = sources().filter(isBrokerageModule);
    expect(brokerageFiles.length).toBeGreaterThan(2);
    for (const path of brokerageFiles) {
      expect(codeOf(path), relative(root, path)).not.toMatch(/realtrade|RealTrade/);
    }
  });

  it("쓰기는 apiPost(endpoints.realtrade.*)뿐 — apiDelete·fetch가 없고, apiPost의 첫 인자는 모두 endpoints.realtrade", () => {
    const offenders: string[] = [];
    const posts: string[] = [];
    for (const path of realtradeFiles()) {
      const text = codeOf(path);
      const name = relative(root, path);
      if (/\bapiDelete\b/.test(text)) offenders.push(`${name}: apiDelete`);
      if (/\bfetch\s*\(/.test(text)) offenders.push(`${name}: fetch`);
      for (const match of text.matchAll(/\bapiPost\s*(?:<[^>()]*>)?\s*\(\s*([^,)]+)/g)) {
        posts.push(match[1].trim());
        if (!/^endpoints\.realtrade\.(enable|disable|update|resume)$/.test(match[1].trim())) offenders.push(`${name}: apiPost(${match[1].trim()})`);
      }
      // apiPost를 다른 이름으로 넘기거나 감싸 부르는 길(참조만 쓰기)도 막습니다 — 부르는 자리 말고 apiPost가 나오는 곳은 가져오기 한 줄뿐이어야 합니다.
      const mentions = [...text.matchAll(/\bapiPost\b/g)].length;
      const calls = [...text.matchAll(/\bapiPost\s*(?:<[^>()]*>)?\s*\(/g)].length;
      const imports = /import\s*\{[^}]*\bapiPost\b[^}]*\}\s*from\s*["']@\/lib\/api["']/.test(text) ? 1 : 0;
      if (mentions !== calls + imports) offenders.push(`${name}: apiPost를 부르지 않고 참조`);
    }
    expect(offenders).toEqual([]);
    // 켜기·끄기·설정 바꾸기·멈춤 해제 넷이 모두 이 모듈 안에서 나갑니다.
    expect([...new Set(posts)].sort()).toEqual([
      "endpoints.realtrade.disable", "endpoints.realtrade.enable", "endpoints.realtrade.resume", "endpoints.realtrade.update",
    ]);
  });

  it("endpoints.realtrade를 쓰는 곳은 실제 매매 모듈뿐(경로 정의 lib/endpoints.ts 제외)", () => {
    const users = sources()
      .filter((path) => !isRealtradeModule(path) && withoutExt(path) !== join(root, "lib", "endpoints"))
      .filter((path) => /\bendpoints\.realtrade\b/.test(codeOf(path)))
      .map((path) => relative(root, path));
    expect(users).toEqual([]);
  });
});
