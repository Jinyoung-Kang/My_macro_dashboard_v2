/**
 * 실제 계좌(토스증권, 읽기 전용 — ADR 0025) 화면 모듈의 경계를 소스로 지킵니다(명세 docs/specs/2026-11-05-toss-account-readonly.md §6).
 *
 *  - 실제 계좌 모듈(components/screens/brokerage/*, lib/brokerage.ts, lib/types/brokerage.ts)을 그 밖에서 가져오는 곳은 PaperScreen.tsx의
 *    BrokerageSection 하나 — 모의 장부·홈·패킷 쪽 모듈로 실제 계좌 자료가 흘러가는 길이 없게(별칭(@/)·상대 경로·동적 import 모두)
 *  - 배럴 lib/types.ts는 lib/types/brokerage를 내보내지 않는다(모의 응답 계약과 섞이지 않게)
 *  - 실제 계좌 모듈은 API 클라이언트(lib/api — apiPost·apiDelete·apiGet)·fetch를 직접 쓰지 않는다 — 읽기는 useApi(GET) 하나
 *  - 실제 계좌 모듈은 모의 계좌처럼 읽히는 패턴(Hero·AssetRow·AssetList)과 '출발 이후' 글을 쓰지 않는다
 * 이 시험이나 위 규칙을 고치는 커밋은 쓰기 경로를 여는 결정입니다(ADR 0025 2단계 관문).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const brokerageDir = join(root, "components", "screens", "brokerage");
const LIB_MODULES = [join(root, "lib", "brokerage"), join(root, "lib", "types", "brokerage")];

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

/** 실제 계좌 모듈인가(확장자 없는 경로). */
function isBrokerageModule(path: string): boolean {
  const bare = withoutExt(path);
  return bare.startsWith(brokerageDir + "/") || LIB_MODULES.includes(bare);
}

/** 한 파일이 가져오는 모듈의 절대 경로(확장자 없음) — 별칭(@/)·상대 경로만, 패키지는 뺍니다. */
function importsOf(path: string): string[] {
  return [...readFileSync(path, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)]
    .map((match) => match[1])
    .map((spec) => (spec.startsWith("@/") ? join(root, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(path), spec) : null))
    .filter((target): target is string => target !== null);
}

const brokerageFiles = () => sources().filter(isBrokerageModule);

/** 주석을 뗀 코드 — 규칙을 설명하는 주석("히어로를 쓰지 않음")이 걸리지 않게. 이 폴더의 소스에는 '//'가 든 문자열(주소)이 없습니다. */
const codeOf = (path: string) =>
  readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("실제 계좌 화면 경계(ADR 0025)", () => {
  it("실제 계좌 모듈이 있다 — 섹션·요약·표·순수 함수·응답 계약", () => {
    const files = brokerageFiles().map((path) => relative(root, path)).sort();
    expect(files).toEqual(expect.arrayContaining([
      "components/screens/brokerage/BrokerageSection.tsx",
      "lib/brokerage.ts",
      "lib/types/brokerage.ts",
    ]));
  });

  it("밖에서 실제 계좌 모듈을 가져오는 곳은 PaperScreen.tsx의 BrokerageSection 하나", () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(50);
    const crossings = files
      .filter((path) => !isBrokerageModule(path))
      .flatMap((path) => importsOf(path)
        .filter(isBrokerageModule)
        .map((target) => `${relative(root, path)} → ${relative(root, target)}`))
      .sort();
    expect(crossings).toEqual(["components/screens/paper/PaperScreen.tsx → components/screens/brokerage/BrokerageSection"]);
  });

  it("모의·홈 순수 함수(lib/paper*·lib/home*)와 배럴 lib/types.ts는 실제 계좌 모듈을 가져오지도 내보내지도 않는다", () => {
    const lib = join(root, "lib");
    const guarded = readdirSync(lib)
      .filter((name) => /^(paper|home).*\.tsx?$/.test(name) || name === "types.ts")
      .map((name) => join(lib, name));
    expect(guarded.length).toBeGreaterThan(5);
    for (const path of guarded) {
      expect(importsOf(path).filter(isBrokerageModule), relative(root, path)).toEqual([]);
      expect(readFileSync(path, "utf8"), relative(root, path)).not.toMatch(/types\/brokerage|lib\/brokerage|\.\/brokerage["']/);
    }
  });

  it("실제 계좌 모듈은 API 클라이언트·fetch를 직접 쓰지 않는다 — 쓰기 호출(apiPost·apiDelete)이 없고 읽기는 useApi 하나", () => {
    const offenders = brokerageFiles().flatMap((path) => {
      const text = codeOf(path);
      const found: string[] = [];
      if (importsOf(path).includes(join(root, "lib", "api"))) found.push("lib/api import");
      if (/\bapi(Post|Delete|Get|GetShared)\b/.test(text)) found.push("api 함수");
      if (/\bfetch\s*\(/.test(text)) found.push("fetch");
      if (/useAsyncAction/.test(text)) found.push("useAsyncAction");
      return found.map((what) => `${relative(root, path)}: ${what}`);
    });
    expect(offenders).toEqual([]);
    // 읽기는 섹션 하나의 useApi(GET)뿐입니다.
    const readers = brokerageFiles().filter((path) => importsOf(path).includes(join(root, "hooks", "useApi"))).map((path) => relative(root, path));
    expect(readers).toEqual(["components/screens/brokerage/BrokerageSection.tsx"]);
  });

  it("모의 계좌처럼 읽히는 패턴(Hero·AssetRow·AssetList)과 '출발 이후' 글을 쓰지 않는다", () => {
    const offenders = brokerageFiles().flatMap((path) => {
      const text = codeOf(path);
      return [...text.matchAll(/\b(Hero|AssetRow|AssetList|ChangeChip)\b|출발 이후/g)].map((match) => `${relative(root, path)}: ${match[0]}`);
    });
    expect(offenders).toEqual([]);
  });
});
