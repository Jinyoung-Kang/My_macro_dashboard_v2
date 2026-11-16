/**
 * QA-594: 탭 제목에 붙일 대상 이름 — 빵부스러기 마지막 칸과 같은 대조(lib/breadcrumbs entityCrumbLabel).
 *
 * 상세 화면(지표·종목·기관)이 넘긴 이름(hooks/useEntityCrumb)의 주소가 지금 주소의 대상 칸 정규 주소와 같고 이름이 비어 있지 않으면 그 이름, 아니면 대상 칸 글
 * (지표 키·종목 코드·'CIK …'). 대상 칸이 없는 주소(모의매매 탭·목록 화면·형식이 틀린 주소·메뉴 밖)는 null — 제목은 메뉴 이름 그대로입니다.
 * breadcrumbs()의 마지막 칸과 같은 규칙이라 두 결과를 함께 봅니다. 시험의 CIK는 늘 10자리입니다(주소 정규화와 상관없게).
 */
import { describe, expect, it } from "vitest";
import { breadcrumbs, entityCrumbLabel } from "@/lib/breadcrumbs";
import type { SessionUser } from "@/lib/types";

const OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO" };

const lastCrumb = (pathname: string, entity?: { href: string; label: string } | null) => breadcrumbs(pathname, OWNER, entity).at(-1)?.label;

describe("entityCrumbLabel — 상세 화면 대상 칸 글 (QA-594)", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 함수가 없었습니다.
  it("이름의 주소가 대상 칸의 정규 주소와 같으면 그 이름(앞뒤 공백 없이), 다르거나 비었으면 주소의 식별자 — 빵부스러기 마지막 칸과 같다", () => {
    const cases: [string, { href: string; label: string } | null | undefined, string][] = [
      ["/institutions/0001608046", { href: "/institutions/0001608046", label: "국민연금 (National Pension Service)" }, "국민연금 (National Pension Service)"],
      ["/institutions/0001608046", { href: "/institutions/0001767640", label: "사우디 국부펀드" }, "CIK 0001608046"],
      ["/institutions/0001608046", { href: "/institutions/0001608046", label: "  " }, "CIK 0001608046"],
      ["/institutions/0001608046", undefined, "CIK 0001608046"],
      ["/markets/i/sp500", { href: "/markets/i/sp500", label: "S&P 500" }, "S&P 500"],
      ["/markets/i/sp500", null, "sp500"],
      ["/s/us/AAPL", null, "AAPL"],
      ["/s/kr/005930", { href: "/s/kr/005930", label: " 삼성전자 " }, "삼성전자"],
    ];
    for (const [path, entity, want] of cases) {
      expect(entityCrumbLabel(path, entity), path).toBe(want);
      expect(lastCrumb(path, entity), `${path} — 빵부스러기`).toBe(want);
    }
  });

  // 수정 전(재현 커밋에서는 it.fails)에는 함수가 없었습니다.
  it("대상 칸이 없는 주소는 null — 모의매매 탭·목록 화면·형식이 틀린 주소·메뉴 밖", () => {
    for (const path of ["/paper/us/holdings", "/paper/kr", "/macro", "/institutions", "/markets/i/", "/s/jp/7203", "/institutions/abc", "/login", "/"]) {
      expect(entityCrumbLabel(path, { href: path, label: "이름" }), path).toBeNull();
    }
  });
});
