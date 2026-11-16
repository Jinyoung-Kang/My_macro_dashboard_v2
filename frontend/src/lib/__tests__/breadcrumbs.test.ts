/**
 * 넓은 화면 상단바의 빵부스러기(lib/breadcrumbs — 작업대 실행 명세 §5, ADR 0042 결정 5). 주소만으로 계산하고(API 없음), 메뉴 표는 lib/nav 하나.
 * 칸 순서는 탭 → 하위 화면 → 대상이고 마지막 칸이 지금 화면. 탭의 유일한 첫 화면(홈·정보 검색)은 하위 칸을 생략, 묶음('한국 시장')은 글 칸,
 * 형식이 틀린 대상 조각은 대상 칸을 뺌, 메뉴 밖 경로는 빈 목록, 보이지 않는 탭·화면은 링크 없음.
 */
import { describe, expect, it } from "vitest";

import { PAPER_TAB_CRUMBS, breadcrumbs, type Crumb } from "../breadcrumbs";
import { TABS } from "../nav";
import { PAPER_TABS, paperTabInMarket } from "../paper";
import { paperRouteFromPath, paperTabPath } from "../paperRoutes";
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

  it("탭 첫 화면도 하위 화면이 여럿이면 하위 칸이 있다 — /macro는 시장 › 매크로 지표(탭 칸은 지금 화면과 주소가 같아 글 칸 — QA-549)", () => {
    expect(breadcrumbs("/macro", MEMBER)).toEqual([
      { label: "시장", href: null },
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
  it("지표 /markets/i/<키> → 시장(뒤 칸과 주소가 같아 글 칸 — QA-549) › 매크로 지표(→ /macro) › 키", () => {
    expect(breadcrumbs("/markets/i/vix", MEMBER)).toEqual([
      { label: "시장", href: null },
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

  it("기관 /institutions/<CIK> → 기관(뒤 칸과 주소가 같아 글 칸 — QA-549) › 13F 포트폴리오(→ /institutions) › CIK n", () => {
    // 앞 0 없는 CIK는 10자리 정규 CIK·주소로(QA-584 — 화면이 읽는 CIK와 같음)
    expect(breadcrumbs("/institutions/1067983", MEMBER)).toEqual([
      { label: "기관", href: null },
      { label: "13F 포트폴리오", href: "/institutions" },
      { label: "CIK 0001067983", href: "/institutions/0001067983" },
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

describe("대상 이름(상세 화면이 읽은 이름 — P4)", () => {
  it("넘긴 이름의 주소가 대상 칸의 정규 주소와 같으면 그 칸 글만 이름으로(주소·링크 그대로)", () => {
    expect(breadcrumbs("/s/kr/005930", MEMBER, { href: "/s/kr/005930", label: "삼성전자" })).toEqual([
      { label: "시장", href: "/macro" },
      { label: "종목(한국)", href: null },
      { label: "삼성전자", href: "/s/kr/005930" },
    ]);
    // 주소 조각의 대소문자·인코딩이 달라도 정규 주소(stockHref)로 대조
    expect(labels(breadcrumbs("/s/us/nvda", MEMBER, { href: "/s/us/NVDA", label: "엔비디아" }))).toEqual(["시장", "종목(미국)", "엔비디아"]);
    expect(labels(breadcrumbs(`/s/us/${encodeURIComponent("^GSPC")}`, MEMBER, { href: "/s/us/%5EGSPC", label: "S&P 500" }))).toEqual([
      "시장",
      "종목(미국)",
      "S&P 500",
    ]);
    expect(labels(breadcrumbs("/markets/i/vix", MEMBER, { href: "/markets/i/vix", label: "VIX 변동성 지수" }))).toEqual(["시장", "매크로 지표", "VIX 변동성 지수"]);
    // 앞 0 없는 주소도 10자리 정규 주소(QA-584)로 대조 — 화면은 정규 주소로 이름을 넘깁니다.
    expect(breadcrumbs("/institutions/1067983", MEMBER, { href: "/institutions/0001067983", label: "버크셔 해서웨이" }).at(-1)).toEqual({
      label: "버크셔 해서웨이",
      href: "/institutions/0001067983",
    });
  });

  it("다른 주소의 이름은 무시한다 — 앞 화면의 이름이 남지 않음, 다른 CIK의 이름은 쓰지 않음", () => {
    expect(labels(breadcrumbs("/s/kr/005930", MEMBER, { href: "/s/kr/000660", label: "SK하이닉스" }))).toEqual(["시장", "종목(한국)", "005930"]);
    // 앞 0만 다른 주소는 같은 기관(10자리 정규 주소 — QA-584)이라, 다른 CIK로 대조합니다.
    expect(labels(breadcrumbs("/institutions/1067983", MEMBER, { href: "/institutions/0001608046", label: "국민연금" })).at(-1)).toBe("CIK 0001067983");
    expect(labels(breadcrumbs("/markets/i/vix", MEMBER, null))).toEqual(["시장", "매크로 지표", "vix"]);
  });

  it("대상 칸이 없는 주소(형식 틀림·메뉴 화면·모의매매 탭)와 빈 이름은 그대로", () => {
    expect(labels(breadcrumbs("/markets/i/bad%20key!", MEMBER, { href: "/markets/i/bad%20key!", label: "x" }))).toEqual(["시장", "매크로 지표"]);
    expect(labels(breadcrumbs("/macro", MEMBER, { href: "/macro", label: "x" }))).toEqual(["시장", "매크로 지표"]);
    expect(labels(breadcrumbs("/paper/us/holdings", OWNER, { href: "/paper/us/holdings", label: "x" }))).toEqual(["모의매매", "미국", "보유·체결"]);
    expect(labels(breadcrumbs("/s/kr/005930", MEMBER, { href: "/s/kr/005930", label: "  " }))).toEqual(["시장", "종목(한국)", "005930"]);
  });
});

describe("모의매매(운영자)", () => {
  it("개요는 모의매매 › 미국, 탭 주소는 그 탭 이름(PAPER_TABS)까지 — '모의매매'(→ /paper/us)는 뒤 칸 '미국'과 주소가 같아 글 칸(QA-549)", () => {
    expect(breadcrumbs("/paper/us", OWNER)).toEqual([
      { label: "모의매매", href: null },
      { label: "미국", href: "/paper/us" },
    ]);
    expect(breadcrumbs("/paper/us/holdings", OWNER)).toEqual([
      { label: "모의매매", href: null },
      { label: "미국", href: "/paper/us" },
      { label: "보유·체결", href: "/paper/us/holdings" },
    ]);
    expect(labels(breadcrumbs("/paper/kr/settings", OWNER))).toEqual(["모의매매", "한국", "설정"]);
    expect(labels(breadcrumbs("/paper/kr/isa", OWNER))).toEqual(["모의매매", "한국", "ISA 계좌"]);
    // 한국 화면은 탭 칸(→ /paper/us)이 뒤 칸과 겹치지 않아 링크 그대로
    expect(breadcrumbs("/paper/kr/settings", OWNER)[0]).toEqual({ label: "모의매매", href: "/paper/us" });
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

describe("같은 곳으로 가는 링크 칸 없음", () => {
  // QA-549: 탭 칸의 주소가 늘 탭 첫 화면이라, 첫 화면이 하위 화면이기도 한 탭(시장 /macro·기관 /institutions·모의매매 /paper/us·정보 수집
  // /info/overview)에서 탭 칸이 지금 화면이나 바로 뒤 칸과 같은 주소로 가는 링크였습니다 — /macro '시장'(→ /macro)을 눌러도 아무 일이 없고,
  // /paper/us/holdings는 '모의매매'·'미국'이 둘 다 /paper/us, /markets/i/vix는 '시장'·'매크로 지표'가 둘 다 /macro(낭독기는 같은 목적지를 두 번 들음).
  // 같은 셸의 나무 메뉴는 같은 경우에 aria-current를 답니다(nav.ts tabCurrent). 뒤 칸 어느 것과 주소가 같은 칸은 링크 없는 글 칸으로 둡니다 —
  // 더 구체적인 뒤 칸(미국·매크로 지표·13F 포트폴리오)이 링크로 남아 갈 수 있는 곳은 줄지 않습니다.
  // 수정 전(재현 커밋에서는 it.fails)에는 운영자·회원 모두 /macro·/institutions·/paper/us·/info/overview·/markets/i/vix·/institutions/1067983·
  // /paper/us/holdings 등에서 겹치는 링크 칸이 나왔습니다.
  it("링크 칸의 주소는 뒤 칸 어느 것과도 겹치지 않는다 — 운영자·회원 × 모든 탭 하위 화면 + 상세 표본 (QA-549)", () => {
    const paths = [
      ...new Set([
        ...TABS.flatMap((tab) => tab.items.map((item) => item.href)),
        "/markets/i/vix",
        "/institutions/1067983",
        "/paper/us/holdings",
        "/paper/kr/isa",
      ]),
    ];
    const overlaps: string[] = [];
    for (const user of [OWNER, MEMBER]) {
      for (const path of paths) {
        const crumbs = breadcrumbs(path, user);
        crumbs.forEach((crumb, index) => {
          if (crumb.href !== null && crumbs.slice(index + 1).some((later) => later.href === crumb.href)) {
            overlaps.push(`${user.role} ${path} '${crumb.label}' → ${crumb.href}`);
          }
        });
      }
    }
    expect(overlaps).toEqual([]);
  });
});

describe("모의매매 탭 이름표 — 셸이 모의매매 모듈을 싣지 않게 따로 둔 표가 PAPER_TABS·paperRouteFromPath와 같다", () => {
  it("개요 밖 탭의 이름과 시장(ISA는 한국만)이 PAPER_TABS와 같다", () => {
    const expected = Object.fromEntries(
      PAPER_TABS.filter((entry) => entry.key !== "overview").map((entry) => [
        entry.key,
        { label: entry.label, markets: (["us", "kr"] as const).filter((market) => paperTabInMarket(entry.key, market === "us" ? "US" : "KR")) },
      ]),
    );
    expect(PAPER_TAB_CRUMBS).toEqual(expected);
  });

  it("주소 규칙이 paperRouteFromPath와 같다 — 탭 칸이 생기는 주소와 그 이름·주소", () => {
    const paths = [
      "/paper", "/paper/us", "/paper/kr", "/paper/us/", "/paper/us/holdings", "/paper/us/holdings/", "/paper/kr/isa", "/paper/us/isa",
      "/paper/us/overview", "/paper/us/Holdings", "/paper/KR/holdings", "/paper/us/holdings/x", "/paper/jp/holdings", "/paper/us/constructor",
      "/paper/us/toString", "/paper/kr/real",
    ];
    for (const path of paths) {
      const route = paperRouteFromPath(path);
      const expected =
        route && route.tab !== "overview" && paperTabInMarket(route.tab, route.market)
          ? { label: PAPER_TABS.find((entry) => entry.key === route.tab)?.label, href: paperTabPath(route.tab, route.market) }
          : null;
      const crumbs = breadcrumbs(path, OWNER);
      const last = crumbs[crumbs.length - 1];
      const detail = crumbs.length === 3 ? last : null;
      expect(detail, path).toEqual(expected);
    }
  });
});
