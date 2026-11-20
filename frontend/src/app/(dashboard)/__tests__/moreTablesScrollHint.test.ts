/**
 * 더보기 화면(저장소 상태·수급 레이더·국내 파생·알림·AI 리포트·연결 테스트·보안 공지·사용자 관리·내 계정)의 공용 조밀 표는 모두 넘김 안내(`scrollHint`)를 둡니다
 * (작업대 P7 — 표는 스크롤 상자 안에서만 넘치고, 넘치면 늘 안내가 보임). 갈래 끝 브라우저 확인(자기 빌드 390)에서 안내 없이 넘친 표 다섯(스냅샷 신선도 292px·
 * 시장 전체 151px·누적 이력 55px·선물 수급 112px — 알림 규칙·공공 API는 자료에 따라)이 나와, 화면 소스의 `<DataTable` 여는 태그마다 이 속성을 봅니다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const DIRS = ["status", "radar", "krx", "alerts", "ai", "connections", "security", "admin", "account"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : files(full);
    return full.endsWith(".tsx") ? [full] : [];
  });
}

/** `<DataTable`부터 그 태그의 속성 끝(`columns=` 앞)까지 — 속성 목록만 봅니다. */
function openTags(source: string): string[] {
  const out: string[] = [];
  for (let index = source.indexOf("<DataTable"); index >= 0; index = source.indexOf("<DataTable", index + 1)) {
    const end = source.indexOf("columns=", index);
    out.push(source.slice(index, end < 0 ? index + 400 : end));
  }
  return out;
}

describe("더보기 화면의 조밀 표 — 넘김 안내", () => {
  it("모든 <DataTable>에 scrollHint가 있다", () => {
    const missing: string[] = [];
    let count = 0;
    for (const dir of DIRS) {
      for (const file of files(join(ROOT, dir))) {
        for (const tag of openTags(readFileSync(file, "utf8"))) {
          count += 1;
          if (!/scrollHint=/.test(tag)) missing.push(`${file.slice(ROOT.length + 1)}: ${tag.slice(0, 80).replace(/\s+/g, " ")}`);
        }
      }
    }
    expect(count).toBeGreaterThanOrEqual(17);
    expect(missing).toEqual([]);
  });

  // QA-869: 손으로 만든 표(<table> + overflow-x-auto 상자)는 위 검사를 비껴 넘김 안내 없이 넘쳤습니다(AI 리포트 본문 표) — 표는 모두 공용 조밀 표로 그립니다.
  it("손으로 만든 <table>이 없다 — 표는 모두 공용 DataTable(QA-869)", () => {
    const raw: string[] = [];
    for (const dir of DIRS) {
      for (const file of files(join(ROOT, dir))) {
        if (/<table[\s>]/.test(readFileSync(file, "utf8"))) raw.push(file.slice(ROOT.length + 1));
      }
    }
    expect(raw).toEqual([]);
  });
});
