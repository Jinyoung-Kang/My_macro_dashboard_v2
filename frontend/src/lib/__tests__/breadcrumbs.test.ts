/**
 * 넓은 화면 상단바의 빵부스러기(lib/breadcrumbs — 작업대 실행 명세 §5, ADR 0042 결정 5). 주소만으로 계산하고(API 없음), 메뉴 표는 lib/nav 하나.
 * 칸 순서는 탭 → 하위 화면 → 대상이고 마지막 칸이 지금 화면. 탭의 유일한 첫 화면(홈·정보 검색)은 하위 칸을 생략, 묶음('한국 시장')은 글 칸이고
 * 묶음 첫 화면이 있는 묶음('정보 수집' → 개요)은 그 화면 링크,
 * 형식이 틀린 대상 조각은 대상 칸을 뺌, 메뉴 밖 경로는 빈 목록, 보이지 않는 탭·화면은 링크 없음.
 */
import { describe, expect, it } from "vitest";

import { PAPER_TAB_CRUMBS, breadcrumbs, foldedBreadcrumbs, type Crumb } from "../breadcrumbs";
import { GROUP_HOMES, INFO_GROUP, KR_MARKET_GROUP, TABS } from "../nav";
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

  // 2026-11-18 사용자 요청: 정보 수집을 맨 위 단계 탭에서 더보기 안의 묶음으로 — 한국 시장과 같은 꼴. 다만 정보 수집에는 묶음 이름이 곧 제목인 첫 화면
  // (개요 /info/overview — 머리 제목 '정보 수집')이 있어 묶음 칸은 그 화면 링크입니다(lib/nav GROUP_HOMES). 탭이던 때 '정보 수집'(→ /info/overview) 칸으로
  // 개요에 한 번에 올라가던 길을 잃지 않게(검토 지적). 개요에서는 지금 화면이라 글 칸, 회원이 주소로 열면 보이지 않는 화면이라 글 칸입니다.
  it("정보 수집 — /info/kr은 더보기 › 정보 수집(→ 개요) › 국내 시장·수급, /info/overview에서는 묶음 칸이 글 칸, 회원이 주소로 열면 링크 없이", () => {
    expect(breadcrumbs("/info/kr", OWNER)).toEqual([
      { label: "더보기", href: "/more" },
      { label: "정보 수집", href: "/info/overview" },
      { label: "국내 시장·수급", href: "/info/kr" },
    ]);
    expect(breadcrumbs("/info/overview", OWNER)).toEqual([
      { label: "더보기", href: "/more" },
      { label: "정보 수집", href: null },
      { label: "개요", href: "/info/overview" },
    ]);
    expect(breadcrumbs("/info/kr", MEMBER)).toEqual([
      { label: "더보기", href: "/more" },
      { label: "정보 수집", href: null },
      { label: "국내 시장·수급", href: null },
    ]);
    // 접으면 첫 칸 '더보기'는 /more — 묶음 칸('정보 수집' → 개요)은 부모 후보가 아님(QA-687 — 글과 도착이 같게). 개요도 같음(위로 가는 링크가 남음).
    expect(foldedBreadcrumbs("/info/kr", OWNER)).toEqual([
      { label: "더보기", href: "/more", title: "더보기 › 정보 수집" },
      { label: "국내 시장·수급", href: "/info/kr" },
    ]);
    expect(foldedBreadcrumbs("/info/overview", OWNER)).toEqual([
      { label: "더보기", href: "/more", title: "더보기 › 정보 수집" },
      { label: "개요", href: "/info/overview" },
    ]);
  });

  it("묶음 첫 화면(GROUP_HOMES)은 그 묶음의 첫 화면이고, 첫 화면이 없는 '한국 시장'은 늘 글 칸", () => {
    const more = TABS.find((tab) => tab.key === "more");
    for (const [group, home] of Object.entries(GROUP_HOMES)) {
      expect(more?.items.find((item) => item.group === group)?.href).toBe(home);
    }
    expect(Object.hasOwn(GROUP_HOMES, KR_MARKET_GROUP)).toBe(false);
    for (const path of ["/radar", "/krx"]) {
      expect(breadcrumbs(path, OWNER)[1]).toEqual({ label: KR_MARKET_GROUP, href: null });
    }
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

  // 보안 공지(ADR 0046 결정 9의 5) — 더보기 '묶음 없음'의 운영자 화면. 알림함 링크의 ?ntt=는 빵부스러기에 칸을 더하지 않음(주소 경로만 봄).
  it("보안 공지 — /security는 더보기 › 보안 공지, 회원이 주소로 열면 링크 없이", () => {
    expect(breadcrumbs("/security", OWNER)).toEqual([
      { label: "더보기", href: "/more" },
      { label: "보안 공지", href: "/security" },
    ]);
    expect(breadcrumbs("/security", MEMBER)).toEqual([
      { label: "더보기", href: "/more" },
      { label: "보안 공지", href: null },
    ]);
  });

  it("보안 공지 상세 — /security/<번호>는 더보기 › 보안 공지(목록 링크) › 공지 <번호>, 넘겨받은 제목이 있으면 그 제목, 형식이 틀리면 목록 칸에서 끝", () => {
    expect(breadcrumbs("/security/900001", OWNER)).toEqual([
      { label: "더보기", href: "/more" },
      { label: "보안 공지", href: "/security" },
      { label: "공지 900001", href: "/security/900001" },
    ]);
    expect(breadcrumbs("/security/0900001", OWNER, { href: "/security/900001", label: "[가짜] 합성 공지" }).at(-1)).toEqual({
      label: "[가짜] 합성 공지",
      href: "/security/900001",
    });
    expect(breadcrumbs("/security/900001", MEMBER)).toEqual([
      { label: "더보기", href: "/more" },
      { label: "보안 공지", href: null },
      { label: "공지 900001", href: null },
    ]);
    for (const path of ["/security/abc", "/security/0", "/security/900001/x"]) {
      expect(breadcrumbs(path, OWNER), path).toEqual([
        { label: "더보기", href: "/more" },
        { label: "보안 공지", href: "/security" },
      ]);
    }
  });

  it("보이지 않는 화면(데모의 내 계정)도 링크 없이", () => {
    expect(breadcrumbs("/account", DEMO)).toEqual([
      { label: "더보기", href: "/more" },
      { label: "내 계정", href: null },
    ]);
  });
});

describe("같은 곳으로 가는 링크 칸 없음", () => {
  // QA-549: 탭 칸의 주소가 늘 탭 첫 화면이라, 첫 화면이 하위 화면이기도 한 탭(시장 /macro·기관 /institutions·모의매매 /paper/us·그때의 정보 수집
  // /info/overview — 2026-11-18부터 더보기 안 묶음)에서 탭 칸이 지금 화면이나 바로 뒤 칸과 같은 주소로 가는 링크였습니다 — /macro '시장'(→ /macro)을 눌러도 아무 일이 없고,
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

describe("가운데 칸을 접은 빵부스러기(foldedBreadcrumbs — 셸이 가운데 칸 글이 24px 아래로 줄면 그림, QA-593)", () => {
  // 검토(QA-593 후속): 접어도 QA-549 처리를 숨긴 가운데 칸까지 넣어 계산한 그대로라 접힌 빵부스러기에 위로 가는 링크가 없었습니다. 첫 칸은 숨긴 가운데 칸
  // 가운데 가장 가까운 부모로 가는 링크이고, 전체 글(title)은 숨긴 칸까지 잇습니다.
  it("첫 칸은 숨긴 가운데 칸 가운데 가장 가까운 부모로 가는 링크 — 모의매매 미국·한국, 기관 상세, 지표 상세", () => {
    expect(foldedBreadcrumbs("/paper/us/holdings", OWNER)).toEqual([
      { label: "모의매매", href: "/paper/us", title: "모의매매 › 미국" },
      { label: "보유·체결", href: "/paper/us/holdings" },
    ]);
    expect(foldedBreadcrumbs("/paper/kr/holdings", OWNER)[0]).toEqual({ label: "모의매매", href: "/paper/kr", title: "모의매매 › 한국" });
    // 기관 주소는 10자리 정규 CIK로 읽습니다(QA-584 — 화면이 넘기는 대상 주소도 institutionHref(10자리)).
    expect(foldedBreadcrumbs("/institutions/0001067983", MEMBER, { href: "/institutions/0001067983", label: "버크셔 해서웨이" })).toEqual([
      { label: "기관", href: "/institutions", title: "기관 › 13F 포트폴리오" },
      { label: "버크셔 해서웨이", href: "/institutions/0001067983" },
    ]);
    // 앞 0 없는 주소로 와도 대상 칸은 정규 주소이고 화면이 넘기는 이름이 붙습니다.
    expect(foldedBreadcrumbs("/institutions/1067983", MEMBER, { href: "/institutions/0001067983", label: "버크셔 해서웨이" })[1]).toEqual({
      label: "버크셔 해서웨이",
      href: "/institutions/0001067983",
    });
    expect(foldedBreadcrumbs("/markets/i/vix", MEMBER)[0]).toEqual({ label: "시장", href: "/macro", title: "시장 › 매크로 지표" });
  });

  it("숨긴 가운데 칸에 링크가 없으면(종목 시장 칸·묶음 이름) 첫 칸 자신의 주소, 보이지 않는 탭은 링크 없이", () => {
    expect(foldedBreadcrumbs("/s/kr/005930", MEMBER)[0]).toEqual({ label: "시장", href: "/macro", title: "시장 › 종목(한국)" });
    expect(foldedBreadcrumbs("/radar", MEMBER)[0]).toEqual({ label: "더보기", href: "/more", title: "더보기 › 한국 시장" });
    expect(foldedBreadcrumbs("/paper/us/holdings", MEMBER)).toEqual([
      { label: "모의매매", href: null, title: "모의매매 › 미국" },
      { label: "보유·체결", href: null },
    ]);
  });

  // QA-687(11-18 요청 QA 스택 확인, qa@06f93335): 접힌 첫 칸은 글이 탭 이름('더보기')인데 링크는 숨긴 가운데 칸 가운데 링크가 있는 마지막 칸(QA-593 규칙)이라,
  // 묶음 칸 '정보 수집'이 개요 링크(GROUP_HOMES — 4facb214)를 얻은 뒤 /info/<분류>에서 '더보기'를 누르면 /info/overview로 갔습니다(글과 도착이 다름).
  // 결정(2026-11-18, 사용자 위임 — 권장안): 접을 때 묶음 칸을 부모 후보에서 빼 '더보기' → /more. 첫 칸 글을 '정보 수집'으로 바꾸는 안은 접힌 nav 하한
  // 112px를 넘을 수 있어 택하지 않음. 펼친 빵부스러기의 '정보 수집' 개요 링크는 그대로. 수정 전(재현 커밋에서는 it.fails) /info/overview였습니다.
  it("QA-687 접으면 묶음 칸은 부모 후보가 아니다 — 정보 수집 화면의 첫 칸 '더보기'는 /more(글과 도착이 같게), 펼친 '정보 수집' 개요 링크는 그대로", () => {
    expect(foldedBreadcrumbs("/info/kr", OWNER)).toEqual([
      { label: "더보기", href: "/more", title: "더보기 › 정보 수집" },
      { label: "국내 시장·수급", href: "/info/kr" },
    ]);
    const info = TABS.find((tab) => tab.key === "more")?.items.filter((item) => item.group === INFO_GROUP) ?? [];
    expect(info.length).toBeGreaterThan(1);
    for (const item of info) {
      expect(foldedBreadcrumbs(item.href, OWNER)[0], item.href).toEqual({ label: "더보기", href: "/more", title: "더보기 › 정보 수집" });
    }
    expect(breadcrumbs("/info/kr", OWNER)[1]).toEqual({ label: "정보 수집", href: "/info/overview" });
  });

  it("가운데 칸이 없으면 breadcrumbs와 같다 — 접을 칸이 없음", () => {
    for (const path of ["/", "/macro", "/paper/us", "/account", "/login"]) {
      expect(foldedBreadcrumbs(path, OWNER), path).toEqual(breadcrumbs(path, OWNER));
    }
  });

  it("접힌 두 칸은 같은 곳으로 가지 않고, 첫 칸의 링크는 탭 주소이거나 펼친 칸 가운데 하나의 주소 — 운영자·회원 × 모든 탭 하위 화면 + 상세 표본", () => {
    const paths = [
      ...new Set([...TABS.flatMap((tab) => tab.items.map((item) => item.href)), "/markets/i/vix", "/institutions/1067983", "/paper/us/holdings", "/paper/kr/isa", "/s/us/NVDA"]),
    ];
    const problems: string[] = [];
    for (const user of [OWNER, MEMBER]) {
      for (const path of paths) {
        const [first, last] = foldedBreadcrumbs(path, user);
        if (last === undefined) continue;
        if (first.href !== null && first.href === last.href) problems.push(`${user.role} ${path} 같은 곳`);
        const hrefs = breadcrumbs(path, user).map((crumb) => crumb.href);
        if (first.href !== null && !hrefs.includes(first.href) && first.href !== TABS.find((tab) => tab.label === first.label)?.href) {
          problems.push(`${user.role} ${path} '${first.label}' → ${first.href}`);
        }
      }
    }
    expect(problems).toEqual([]);
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
