/**
 * 장중 시장가·장중 감시 스탑의 체결 시점 글이 옛 정의로 되살아나지 않게 지킵니다(ADR 0044 — 2026-11 작업 2).
 *
 * 장중 시장가(MARKET)의 기준 시각은 '주문 생성 뒤 처음 시작하는 분'(1분 안)입니다. 예전 정의 글(OLD_PHRASES — 화면에 있던 '(생성 + 60초) 뒤
 * 첫 분'·'감지 + 60초', 백엔드 AI 입력·설명에 있던 '생성 + 60초가 지난 첫 분'(끈 판 프롬프트에 그대로 남음 — ADR 0044 결정 7)·'(생성 + 60초)를
 * 분으로 내린 뒤'·'감지 2분 뒤')이 화면 소스(src의 .ts·.tsx — 시험·자가 검증 폴더 제외, 주석 포함 전체 글)에 남으면 실패합니다. 늦은 주문 가드
 * 글('생성 + 60초보다 늦지 않음' — LATE_FOR_TIMING 설명)은 이 문구들에 걸리지 않아 그대로 둡니다.
 *
 * 허용 목록은 작업대 개편(P6)이 고치고 있는 보유 화면 한 줄뿐입니다(ADR 0044 결정 D15 (나′)). 그 줄이 다른 파일로 옮겨 가거나 횟수가 달라지면
 * 실패해, 옛 글이 조용히 되살아나지 않습니다. P6이 main에 합쳐진 뒤 그 줄을 새 정의로 고치고 허용 목록을 비웁니다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../..");
const SKIP_DIRS = new Set(["__tests__", "__checks__", "node_modules"]);
const OLD_PHRASES = ["60초 뒤 첫 분", "감지 + 60초", "60초가 지난 첫 분", "60초)를 분으로 내린", "감지 2분 뒤"];
/** 아직 옛 글이 남아 있어도 되는 파일과 그 횟수(src 기준 경로). */
const ALLOWED: Record<string, number> = { "components/screens/paper/HoldingsSection.tsx": 1 };

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) {
        sources(path, out);
      }
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

function count(text: string, phrase: string): number {
  return text.split(phrase).length - 1;
}

describe("장중 시장가 체결 시점 글(ADR 0044)", () => {
  it("화면 소스에 옛 정의 글(OLD_PHRASES)이 허용 목록 밖에서 나오지 않음", () => {
    const found: Record<string, number> = {};
    for (const path of sources(SRC)) {
      const text = readFileSync(path, "utf-8");
      const n = OLD_PHRASES.reduce((sum, phrase) => sum + count(text, phrase), 0);
      if (n > 0) {
        found[relative(SRC, path).split("\\").join("/")] = n;
      }
    }
    expect(found).toEqual(ALLOWED);
  });

  it("스탑 설명 글(미국·한국)은 새 정의 '감지 뒤 처음 시작하는 분(1분 안)'을 씀", () => {
    for (const file of ["lib/paper.ts", "lib/paperKrProfiles.ts"]) {
      expect(readFileSync(join(SRC, file), "utf-8"), file).toContain("감지 뒤 처음 시작하는 분(1분 안)");
    }
  });
});
