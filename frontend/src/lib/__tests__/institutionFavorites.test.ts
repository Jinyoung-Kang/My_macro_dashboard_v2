/**
 * 13F 즐겨찾기 화면 규칙(ADR 0048) — 찾기 칸의 글 종류, 상한이 백엔드 상수와 같음, 명령 팔레트에 즐겨찾기가 기본 12곳 다음으로.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FAVORITE_LIMIT, FAVORITE_QUERY_MAX, favoriteQueryKind } from "../institutionFavorites";
import { institutionEntries } from "../search";

const BACKEND = resolve(__dirname, "../../../../backend/src/main/java/com/macrodash/feature/institution");

describe("favoriteQueryKind", () => {
  it("숫자 1~10자리는 10자리 CIK, 2~60자는 이름, 그 밖은 까닭", () => {
    expect(favoriteQueryKind(" 1061768 ")).toEqual({ kind: "cik", cik: "0001061768" });
    expect(favoriteQueryKind("0")).toMatchObject({ kind: "invalid" });
    expect(favoriteQueryKind("  baupost   group ")).toEqual({ kind: "name", text: "baupost group" });
    expect(favoriteQueryKind("a")).toMatchObject({ kind: "invalid" });
    expect(favoriteQueryKind("x".repeat(FAVORITE_QUERY_MAX + 1))).toMatchObject({ kind: "invalid" });
    expect(favoriteQueryKind("12345678901")).toMatchObject({ kind: "name" });
  });
});

// QA-983: SEC 등록 이름은 영문뿐 — 한글 검색어는 SEC가 47초쯤 뒤 503(2026-11-23 서버 재현). 찾기 칸에서 바로 까닭을 보여야 합니다.
describe("QA-983 영문이 아닌 이름", () => {
  it("한글이 든 이름은 SEC를 부르지 않고 까닭(영문 이름 앞부분이나 CIK)", () => {
    const kind = favoriteQueryKind("아팔루사");
    expect(kind.kind).toBe("invalid");
    expect(kind.kind === "invalid" ? kind.reason : "").toContain("영문");
  });
});

describe("백엔드와 같은 상수", () => {
  it("상한 20곳·검색어 60자", () => {
    const catalog = readFileSync(resolve(BACKEND, "InstitutionCatalog.java"), "utf8");
    const service = readFileSync(resolve(BACKEND, "Sec13FFavoriteService.java"), "utf8");
    expect(catalog).toContain(`FAVORITE_LIMIT = ${FAVORITE_LIMIT};`);
    expect(service).toContain(`MAX_DISPLAY_NAME = ${FAVORITE_QUERY_MAX};`);
  });
});

describe("명령 팔레트의 기관", () => {
  it("기본 12곳 다음 즐겨찾기 — SEC 등록 이름도 찾는 말", () => {
    const entries = institutionEntries({
      institutions: [{ key: "berkshire", name: "버크셔", cik: "0001067983", desc: "가치" }],
      favorites: [{ key: "fav-0009900001", name: "가짜 운용", cik: "0009900001", desc: "", secName: "FAKE CAPITAL LLC" }],
    });
    expect(entries.map((entry) => entry.href)).toEqual(["/institutions/0001067983", "/institutions/0009900001"]);
    expect(entries[1].keywords).toContain("FAKE CAPITAL LLC");
    expect(institutionEntries({ institutions: [] })).toEqual([]);
  });
});
