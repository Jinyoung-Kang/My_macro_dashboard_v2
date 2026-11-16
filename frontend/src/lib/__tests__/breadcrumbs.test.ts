/**
 * 넓은 화면 상단바의 빵부스러기(lib/breadcrumbs — 작업대 실행 명세 §5, ADR 0042 결정 5). 주소만으로 계산하고(API 없음), 메뉴 표는 lib/nav 하나.
 * 칸 순서는 탭 → 하위 화면 → 대상이고 마지막 칸이 지금 화면. 탭의 유일한 첫 화면(홈·정보 검색)은 하위 칸을 생략, 묶음('한국 시장')은 글 칸,
 * 형식이 틀린 대상 조각은 대상 칸을 뺌, 메뉴 밖 경로는 빈 목록, 보이지 않는 탭·화면은 링크 없음.
 */
import { describe, expect, it } from "vitest";

import { breadcrumbs, type Crumb } from "../breadcrumbs";
import type { SessionUser } from "../types";

const OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: true };
const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };
const DEMO: SessionUser = { email: null, role: "MEMBER", tier: "PRO", demo: true };

const labels = (crumbs: Crumb[]) => crumbs.map((crumb) => crumb.label);

describe("메뉴 화면", () => {
  it("홈·정보 검색은 탭 한 칸 — 탭의 유일한 첫 화면이라 하위 칸을 생략한다", () => {
    expect(breadcrumbs("/", OWNER)).toEqual([{ label: "홈", href: "/" }]);
    expect(breadcrumbs("/search", MEMBER)).toEqual([{ label: "정보 검색", href: "/search" }]);
  });

  it("탭 첫 화면도 하위 화면이 여럿이면 하위 칸이 있다 — /macro는 시장 › 매크로 지표", () => {
    expect(breadcrumbs("/macro", MEMBER)).toEqual([
      { label: "시장", href: "/macro" },
      { label: "매크로 지표", href: "/macro" },
    ]);
    expect(breadcrumbs("/liquidity", MEMBER)).toEqual([
      { label: "시장", href: "/macro" },
      { label: "순유동성", href: "/liquidity" },
    ]);
    expect(labels(breadcrumbs("/institutions", MEMBER))).toEqual(["기관", "13F 포트폴리오"]);
    expect(labels(breadcrumbs("/info/kr", OWNER))).toEqual(["정보 수집", "국내 시장·수급"]);
  });

  it("더보기 — /more는 탭 한 칸, /alerts는 더보기 › 알림, /radar는 묶음 '한국 시장'이 링크 없는 글 칸", () => {
    expect(breadcrumbs("/more", MEMBER)).toEqual([{ label: "더보기", href: "/more" }]);
    expect(labels(breadcrumbs("/alerts", MEMBER))).toEqual(["더보기", "알림"]);
    expect(breadcrumbs("/radar", MEMBER)).toEqual([
      { label: "더보기", href: "/more" },
      { label: "한국 시장", href: null },
      { label: "수급 레이더", href: "/radar" },
    ]);
  });

  it("메뉴에 없는 경로(/login 등)는 빈 목록", () => {
    expect(breadcrumbs("/login", MEMBER)).toEqual([]);
    expect(breadcrumbs("/privacy", undefined)).toEqual([]);
  });
});

describe("대상(상세)", () => {
  it("지표 /markets/i/<키> → 시장 › 매크로 지표(→ /macro) › 키", () => {
    expect(breadcrumbs("/markets/i/vix", MEMBER)).toEqual([
      { label: "시장", href: "/macro" },
      { label: "매크로 지표", href: "/macro" },
      { label: "vix", href: "/markets/i/vix" },
    ]);
  });

  it("종목 /s/<시장>/<코드> → 시장 › 종목(미국|한국)(링크 없음) › 대문자 코드", () => {
    expect(breadcrumbs("/s/us/nvda", MEMBER)).toEqual([
      { label: "시장", href: "/macro" },
      { label: "종목(미국)", href: null },
      { label: "NVDA", href: "/s/us/NVDA" },
    ]);
    expect(labels(breadcrumbs("/s/kr/005930", MEMBER))).toEqual(["시장", "종목(한국)", "005930"]);
    expect(labels(breadcrumbs(`/s/us/${encodeURIComponent("^GSPC")}`, MEMBER))).toEqual(["시장", "종목(미국)", "^GSPC"]);
  });

  it("기관 /institutions/<CIK> → 기관 › 13F 포트폴리오(→ /institutions) › CIK n", () => {
    expect(breadcrumbs("/institutions/1067983", MEMBER)).toEqual([
      { label: "기관", href: "/institutions" },
      { label: "13F 포트폴리오", href: "/institutions" },
      { label: "CIK 1067983", href: "/institutions/1067983" },
    ]);
  });

  it("형식이 틀린 대상 조각은 대상 칸을 빼고 그 앞 칸에서 끝난다", () => {
    expect(labels(breadcrumbs("/markets/i/bad%20key!", MEMBER))).toEqual(["시장", "매크로 지표"]);
    expect(labels(breadcrumbs("/s/kr/ABC", MEMBER))).toEqual(["시장", "종목(한국)"]);
    expect(labels(breadcrumbs("/s/jp/7203", MEMBER))).toEqual(["시장"]);
    expect(labels(breadcrumbs("/institutions/berkshire", MEMBER))).toEqual(["기관", "13F 포트폴리오"]);
    expect(labels(breadcrumbs("/institutions/123/holdings", MEMBER))).toEqual(["기관", "13F 포트폴리오"]);
  });
});

describe("모의매매(운영자)", () => {
  it("개요는 모의매매 › 미국, 탭 주소는 그 탭 이름(PAPER_TABS)까지", () => {
    expect(breadcrumbs("/paper/us", OWNER)).toEqual([
      { label: "모의매매", href: "/paper/us" },
      { label: "미국", href: "/paper/us" },
    ]);
    expect(breadcrumbs("/paper/us/holdings", OWNER)).toEqual([
      { label: "모의매매", href: "/paper/us" },
      { label: "미국", href: "/paper/us" },
      { label: "보유·체결", href: "/paper/us/holdings" },
    ]);
    expect(labels(breadcrumbs("/paper/kr/settings", OWNER))).toEqual(["모의매매", "한국", "설정"]);
    expect(labels(breadcrumbs("/paper/kr/isa", OWNER))).toEqual(["모의매매", "한국", "ISA 계좌"]);
  });

  it("그 시장에 없는 탭(미국 isa)·모르는 조각은 탭 칸을 빼고 시장에서 끝난다", () => {
    expect(labels(breadcrumbs("/paper/us/isa", OWNER))).toEqual(["모의매매", "미국"]);
    expect(labels(breadcrumbs("/paper/us/overview", OWNER))).toEqual(["모의매매", "미국"]);
    expect(labels(breadcrumbs("/paper/us/holdings/extra", OWNER))).toEqual(["모의매매", "미국"]);
  });

  it("보이지 않는 탭(회원이 주소로 연 /paper/us)은 칸을 남기되 링크가 없다", () => {
    expect(breadcrumbs("/paper/us/holdings", MEMBER)).toEqual([
      { label: "모의매매", href: null },
      { label: "미국", href: null },
      { label: "보유·체결", href: null },
    ]);
  });

  it("보이지 않는 화면(데모의 내 계정)도 링크 없이", () => {
    expect(breadcrumbs("/account", DEMO)).toEqual([
      { label: "더보기", href: "/more" },
      { label: "내 계정", href: null },
    ]);
  });
});
