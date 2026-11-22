/**
 * 화면 메뉴(정보 구조) — 홈·시장·기관·모의매매·정보 검색·더보기(ADR 0041 결정 1, 2026-11-18 정보 수집은 더보기 안 묶음으로), 하위 화면, 지금 탭,
 * 탭 제목, 검색 메뉴 항목.
 */
import { describe, expect, it } from "vitest";
import { INFO_TAB_SLUGS } from "../info";
import {
  INFO_GROUP,
  KR_MARKET_GROUP,
  TABS,
  activeItem,
  activeTab,
  documentTitle,
  menuTitle,
  navSearchItems,
  subNav,
  tabCurrent,
  visibleItems,
  visibleTabs,
} from "../nav";
import type { SessionUser } from "../types";

const OWNER: SessionUser = { email: "o@x", role: "OWNER", tier: "PRO" };
const MEMBER: SessionUser = { email: "m@x", role: "MEMBER", tier: "FREE" };
const DEMO: SessionUser = { email: null, role: "MEMBER", tier: "PRO", demo: true };

const tab = (key: string) => {
  const found = TABS.find((entry) => entry.key === key);
  if (!found) throw new Error(`탭 없음: ${key}`);
  return found;
};

describe("탭 표(브리프 §1.3 그대로)", () => {
  it("홈·시장·기관·모의매매·정보 검색·더보기의 키·이름·이동 경로 — 한국 탭(ADR 0041 결정 1)·정보 수집 탭(2026-11-18)은 없다", () => {
    expect(TABS.map((entry) => [entry.key, entry.label, entry.href])).toEqual([
      ["home", "홈", "/"],
      ["markets", "시장", "/macro"],
      ["institutions", "기관", "/institutions"],
      ["paper", "모의매매", "/paper/us"],
      ["search", "정보 검색", "/search"],
      ["more", "더보기", "/more"],
    ]);
  });

  it("탭마다 하위 화면(순서·이름·경로)", () => {
    const items = (key: string) => tab(key).items.map((item) => `${item.label} ${item.href}`);
    expect(items("home")).toEqual(["홈 /"]);
    expect(items("markets")).toEqual([
      "매크로 지표 /macro", "순유동성 /liquidity", "섹터·자산군 /sector", "상관관계 /correlation", "투기세력(COT) /cot", "국면 판정 /regime",
    ]);
    expect(items("institutions")).toEqual([
      "13F 포트폴리오 /institutions", "Money 교집합 /consensus", "스타일·위험 /style", "종목 스코어카드 /scorecard",
    ]);
    expect(items("search")).toEqual(["정보 검색 /search"]);
    // 한국 책 화면(2단계 명세 §4-16, F2) — 예전 '한국 · 준비 중' 표시는 없어지고 링크가 됨.
    expect(items("paper")).toEqual(["미국 /paper/us", "한국 /paper/kr"]);
    expect(tab("paper").upcoming).toBeUndefined();
    // 묶음 차례: 묶음 없는 화면 → 한국 시장 → 정보 수집(2026-11-18 — 운영자 전용 여덟 칸을 맨 뒤에). 묶음 안은 글자순(2026-11-22 사용자 요청).
    expect(items("more")).toEqual([
      "내 계정 /account", "데이터 저장소 상태 /status", "보안 공지 /security", "사용자 관리 /admin/users", "알림 /alerts",
      "외부 API 연결 테스트 /connections", "AI 종합 분석 /ai/report", "수급 레이더 /radar", "파생·투기세력(KRX) /krx",
      "개요 /info/overview", "국내 시장·수급 /info/kr", "기관·공시 /info/filings", "뉴스·글 /info/news",
      "모의매매 입력 /info/paper", "정보(메커니즘) /info/mechanism", "출처 상태 /info/status", "해외 시장·거시 /info/global",
    ]);
  });

  it("옛 한국 탭의 두 화면은 주소 그대로 더보기의 '한국 시장' 묶음 — 나머지 더보기 화면은 묶음 없음", () => {
    const grouped = tab("more").items.filter((item) => item.group === KR_MARKET_GROUP).map((item) => item.href);
    expect(KR_MARKET_GROUP).toBe("한국 시장");
    expect(grouped).toEqual(["/radar", "/krx"]);
    for (const other of TABS.filter((entry) => entry.key !== "more")) {
      expect(other.items.every((item) => item.group === undefined)).toBe(true);
    }
    expect(tab("more").items.filter((item) => !item.group).map((item) => item.href)).toEqual([
      "/account", "/status", "/security", "/admin/users", "/alerts", "/connections", "/ai/report",
    ]);
  });

  // 2026-11-18 사용자 요청: 정보 수집을 맨 위 단계 탭에서 빼 더보기 안의 묶음으로(한국 시장과 같은 방식). 주소·제목·검색어는 그대로입니다.
  it("정보 수집은 맨 위 단계 탭이 아니라 더보기의 '정보 수집' 묶음 여덟 화면 — 주소는 /info/<분류> 그대로(lib/info 탭 조각과 같은 순서)", () => {
    expect(INFO_GROUP).toBe("정보 수집");
    expect(TABS.map((entry) => entry.label)).not.toContain("정보 수집");
    expect(TABS.some((entry) => entry.href.startsWith("/info"))).toBe(false);
    const info = tab("more").items.filter((item) => item.group === INFO_GROUP);
    expect(info.map((item) => item.href)).toEqual(INFO_TAB_SLUGS.map((slug) => `/info/${slug}`));
    // 하위 화면이 /info로 시작하는 것은 이 묶음뿐(다른 탭·묶음 없는 화면에 섞이지 않음).
    expect(TABS.flatMap((entry) => entry.items).filter((item) => item.href.startsWith("/info"))).toEqual(info);
    // 묶음 차례는 '한국 시장' 다음(맨 뒤).
    const groups = [...new Set(tab("more").items.map((item) => item.group ?? null))];
    expect(groups).toEqual([null, KR_MARKET_GROUP, INFO_GROUP]);
  });
});

describe("지금 탭·화면", () => {
  it("경로가 속한 탭 — 하위 화면과 그 아래 경로, 탭 첫 화면, 탭 영역(/paper 아래 전부)", () => {
    const keyOf = (path: string) => activeTab(path)?.key ?? null;
    expect(keyOf("/")).toBe("home");
    expect(keyOf("/macro")).toBe("markets");
    expect(keyOf("/liquidity")).toBe("markets");
    expect(keyOf("/regime")).toBe("markets");
    expect(keyOf("/institutions")).toBe("institutions");
    expect(keyOf("/scorecard")).toBe("institutions");
    expect(keyOf("/radar")).toBe("more");
    expect(keyOf("/krx")).toBe("more");
    expect(keyOf("/search")).toBe("search");
    expect(keyOf("/paper")).toBe("paper");
    expect(keyOf("/paper/us")).toBe("paper");
    expect(keyOf("/paper/us/settings")).toBe("paper");
    expect(keyOf("/paper/kr")).toBe("paper");
    expect(keyOf("/more")).toBe("more");
    expect(keyOf("/alerts")).toBe("more");
    expect(keyOf("/ai/report")).toBe("more");
    expect(keyOf("/admin/users")).toBe("more");
    expect(keyOf("/account")).toBe("more");
    // 정보 수집 여덟 화면과 옛 /info(next.config가 /info/overview로 보냄)는 더보기 탭(2026-11-18).
    expect(keyOf("/info")).toBe("more");
    for (const slug of INFO_TAB_SLUGS) expect(keyOf(`/info/${slug}`)).toBe("more");
    expect(activeItem("/info/news")?.group).toBe(INFO_GROUP);
    expect(activeTab("/infox")).toBeNull();
  });

  it("메뉴에 없는 경로와 앞부분만 같은 경로는 어느 탭도 아니다(/macroeconomics·/paperclip — '/' 경계)", () => {
    expect(activeTab("/login")).toBeNull();
    expect(activeTab("/macroeconomics")).toBeNull();
    expect(activeTab("/paperclip")).toBeNull();
    // /search는 시장 탭 영역 /s(종목 상세)의 아래가 아니다 — 조각 경계.
    expect(activeTab("/searchx")).toBeNull();
    expect(activeTab("/search")?.key).toBe("search");
    expect(activeItem("/login")).toBeNull();
  });

  it("하위 화면은 그 아래 경로까지(/paper/us/holdings → 미국), 옛 /paper는 하위 화면이 아니라 탭 영역", () => {
    expect(activeItem("/paper/us/holdings")?.href).toBe("/paper/us");
    expect(activeItem("/paper/us")?.href).toBe("/paper/us");
    // 옛 /paper는 next.config가 /paper/us로 보냅니다 — 화면이 아니라 모의매매 탭 영역(section)일 뿐입니다.
    expect(activeItem("/paper")).toBeNull();
    expect(activeTab("/paper")?.key).toBe("paper");
    expect(activeItem("/")?.href).toBe("/");
    expect(activeItem("/x")).toBeNull();
  });

  it("검색 상세 화면 — 지표 /markets/i/…·종목 /s/…는 시장 탭 영역, 기관 /institutions/<CIK>는 13F 포트폴리오 아래", () => {
    expect(activeTab("/markets/i/dxy")?.key).toBe("markets");
    expect(activeTab("/s/us/AAPL")?.key).toBe("markets");
    expect(activeTab("/s/kr/005930")?.key).toBe("markets");
    expect(activeItem("/s/us/AAPL")).toBeNull();
    // /s는 경로 조각 경계로만 — /style·/scorecard는 기관 탭 화면 그대로
    expect(activeTab("/style")?.key).toBe("institutions");
    expect(activeTab("/scorecard")?.key).toBe("institutions");
    expect(activeItem("/institutions/0001067983")?.href).toBe("/institutions");
    expect(activeTab("/institutions/0001067983")?.key).toBe("institutions");
  });

  it("탭 링크의 aria-current — 탭 첫 화면이면 page, 같은 탭의 다른 화면이면 true, 다른 탭이면 없음", () => {
    expect(tabCurrent(tab("markets"), "/macro")).toBe("page");
    expect(tabCurrent(tab("markets"), "/liquidity")).toBe("true");
    expect(tabCurrent(tab("markets"), "/radar")).toBeUndefined();
    expect(tabCurrent(tab("home"), "/")).toBe("page");
    expect(tabCurrent(tab("home"), "/macro")).toBeUndefined();
    expect(tabCurrent(tab("paper"), "/paper/us")).toBe("page");
    expect(tabCurrent(tab("paper"), "/paper/us/holdings")).toBe("true");
    expect(tabCurrent(tab("more"), "/alerts")).toBe("true");
    expect(tabCurrent(tab("more"), "/more")).toBe("page");
    // 더보기로 옮긴 한국 화면에서는 더보기 탭이 '이 탭 안'(true)
    expect(tabCurrent(tab("more"), "/radar")).toBe("true");
    expect(tabCurrent(tab("more"), "/krx")).toBe("true");
    expect(tabCurrent(tab("search"), "/search")).toBe("page");
    // 정보 수집 화면에서도 더보기 탭이 '이 탭 안'(true) — 좁은 화면 아래 탭 바의 더보기가 지금 탭으로 보입니다.
    expect(tabCurrent(tab("more"), "/info/overview")).toBe("true");
    expect(tabCurrent(tab("more"), "/info/mechanism")).toBe("true");
  });
});

describe("보이는 탭·하위 화면(lib/access 앞부분 일치)", () => {
  it("운영자는 여섯 탭, 회원·데모·모르는 사용자는 모의매매 탭이 빠지고 정보 검색은 보인다(D-1)", () => {
    expect(visibleTabs(OWNER).map((entry) => entry.label)).toEqual(["홈", "시장", "기관", "모의매매", "정보 검색", "더보기"]);
    for (const user of [MEMBER, DEMO, undefined]) {
      expect(visibleTabs(user).map((entry) => entry.label)).toEqual(["홈", "시장", "기관", "정보 검색", "더보기"]);
    }
  });

  it("더보기의 운영자 화면(저장소 상태·연결 테스트·보안 공지·사용자 관리·정보 수집 묶음)은 운영자에게만, 내 계정은 데모 열람에게 없다", () => {
    expect(visibleItems(tab("more"), MEMBER).map((item) => item.href)).toEqual(["/account", "/alerts", "/ai/report", "/radar", "/krx"]);
    expect(visibleItems(tab("more"), DEMO).map((item) => item.href)).toEqual(["/alerts", "/ai/report", "/radar", "/krx"]);
    expect(visibleItems(tab("more"), undefined).map((item) => item.href)).toEqual(["/account", "/alerts", "/ai/report", "/radar", "/krx"]);
    expect(visibleItems(tab("more"), OWNER).map((item) => item.href)).toEqual([
      "/account", "/status", "/security", "/admin/users", "/alerts", "/connections", "/ai/report", "/radar", "/krx",
      ...INFO_TAB_SLUGS.map((slug) => `/info/${slug}`),
    ]);
  });
});

describe("하위 메뉴 줄", () => {
  it("화면이 둘 이상인 탭에서만, 지금 화면을 current로", () => {
    const markets = subNav("/liquidity", MEMBER);
    expect(markets?.tab.key).toBe("markets");
    expect(markets?.items).toHaveLength(6);
    expect(markets?.current).toBe("/liquidity");
    expect(markets?.currentAria).toBe("page");
    // 더보기 탭이지만 하위 메뉴 줄은 같은 묶음('한국 시장')만 — 알림·운영 화면이 섞이지 않는다.
    expect(subNav("/radar", MEMBER)?.items.map((item) => item.label)).toEqual(["수급 레이더", "파생·투기세력(KRX)"]);
    expect(subNav("/radar", MEMBER)?.label).toBe("한국 시장");
    expect(subNav("/krx", OWNER)?.current).toBe("/krx");
    expect(subNav("/search", MEMBER)).toBeNull();
    expect(subNav("/", OWNER)).toBeNull();
    expect(subNav("/login", OWNER)).toBeNull();
  });

  it("모의매매: 운영자에게는 미국 + 한국(모두 링크), 주소로 연 회원에게는 줄이 없다", () => {
    const paper = subNav("/paper/us", OWNER);
    expect(paper?.items.map((item) => item.href)).toEqual(["/paper/us", "/paper/kr"]);
    expect(paper?.upcoming).toEqual([]);
    expect(paper?.current).toBe("/paper/us");
    expect(paper?.currentAria).toBe("page");
    // 탭 주소(/paper/us/settings)에서도 미국이 지금 화면입니다 — 다만 "미국" 링크는 개요(/paper/us)로 가므로 "현재 페이지"가 아니라
    // "이 화면 안"(true)입니다(tabCurrent와 같은 규칙).
    const settings = subNav("/paper/us/settings", OWNER);
    expect(settings?.current).toBe("/paper/us");
    expect(settings?.currentAria).toBe("true");
    expect(subNav("/paper/us", MEMBER)).toBeNull();
    // 한국 화면과 그 탭 주소 — 지금 화면은 "한국", 탭 주소에서는 aria-current true(미국과 같은 규칙).
    expect(subNav("/paper/kr", OWNER)?.current).toBe("/paper/kr");
    expect(subNav("/paper/kr", OWNER)?.currentAria).toBe("page");
    expect(subNav("/paper/kr/holdings", OWNER)?.current).toBe("/paper/kr");
    expect(subNav("/paper/kr/holdings", OWNER)?.currentAria).toBe("true");
    expect(subNav("/paper/kr", MEMBER)).toBeNull();
  });

  it("정보 수집(운영자): /info/news의 하위 메뉴 줄은 '정보 수집' 묶음 여덟 칸 — 더보기의 다른 화면·한국 시장이 섞이지 않는다", () => {
    const info = subNav("/info/news", OWNER);
    expect(info?.tab.key).toBe("more");
    expect(info?.label).toBe("정보 수집");
    expect(info?.items.map((item) => item.label)).toEqual([
      "개요", "국내 시장·수급", "기관·공시", "뉴스·글", "모의매매 입력", "정보(메커니즘)", "출처 상태", "해외 시장·거시",
    ]);
    expect(info?.current).toBe("/info/news");
    expect(info?.currentAria).toBe("page");
    // 반대로 더보기·한국 시장 화면의 줄에는 정보 수집 화면이 없다.
    expect(subNav("/alerts", OWNER)?.items.map((item) => item.href)).toEqual(["/account", "/status", "/security", "/admin/users", "/alerts", "/connections", "/ai/report"]);
    expect(subNav("/radar", OWNER)?.items.map((item) => item.href)).toEqual(["/radar", "/krx"]);
  });

  it("정보 수집은 회원·데모·모르는 사용자에게 보이지 않는다 — 주소로 열어도 하위 메뉴 줄이 없다(운영자 전용 /info 앞부분 일치)", () => {
    for (const user of [MEMBER, DEMO, undefined]) {
      expect(subNav("/info/news", user)).toBeNull();
      expect(visibleItems(tab("more"), user).some((item) => item.href.startsWith("/info"))).toBe(false);
    }
  });

  it("더보기: 회원에게는 운영자 화면이 빠지고, 더보기 화면 자체(/more)에서는 고른 것이 없다", () => {
    expect(subNav("/alerts", MEMBER)?.items.map((item) => item.href)).toEqual(["/account", "/alerts", "/ai/report"]);
    expect(subNav("/alerts", MEMBER)?.label).toBe("더보기");
    expect(subNav("/more", OWNER)?.current).toBeNull();
    expect(subNav("/more", OWNER)?.currentAria).toBeNull();
    expect(subNav("/more", OWNER)?.items).toHaveLength(7);
  });
});

describe("브라우저 탭 제목", () => {
  it("하위 화면 이름(없으면 탭 이름) + ' · 매크로 대시보드'", () => {
    expect(menuTitle("/liquidity")).toBe("순유동성");
    expect(documentTitle("/liquidity")).toBe("순유동성 · 매크로 대시보드");
    expect(documentTitle("/")).toBe("홈 · 매크로 대시보드");
    expect(documentTitle("/account")).toBe("내 계정 · 매크로 대시보드");
    expect(documentTitle("/more")).toBe("더보기 · 매크로 대시보드");
    // 더보기로 옮긴 한국 화면의 제목은 그대로
    expect(documentTitle("/radar")).toBe("수급 레이더 · 매크로 대시보드");
    expect(documentTitle("/krx")).toBe("파생·투기세력(KRX) · 매크로 대시보드");
    expect(documentTitle("/search")).toBe("정보 검색 · 매크로 대시보드");
    // 더보기로 옮긴 정보 수집 화면의 제목도 그대로(제목용 이름에 '정보 수집'이 들어 있음)
    expect(documentTitle("/info/overview")).toBe("정보 수집 개요 · 매크로 대시보드");
    expect(documentTitle("/info/news")).toBe("정보 수집 · 뉴스·글 · 매크로 대시보드");
    expect(documentTitle("/info/mechanism")).toBe("정보 수집 · 작동 방식 · 매크로 대시보드");
  });

  it("짧은 이름만으로 뜻이 모자라면 제목용 이름을 쓴다 — 모의매매 미국 화면은 '미국'이 아니라 '모의매매(미국)'", () => {
    expect(menuTitle("/paper/us")).toBe("모의매매(미국)");
    expect(documentTitle("/paper/us")).toBe("모의매매(미국) · 매크로 대시보드");
    expect(documentTitle("/paper/us/decisions")).toBe("모의매매(미국) · 매크로 대시보드");
    expect(menuTitle("/paper/kr")).toBe("모의매매(한국)");
    expect(documentTitle("/paper/kr/holdings")).toBe("모의매매(한국) · 매크로 대시보드");
  });

  it("메뉴에 없는 경로는 앱 이름만", () => {
    expect(menuTitle("/login")).toBeNull();
    expect(documentTitle("/login")).toBe("매크로 대시보드");
  });

  // QA-594: 상세 화면 탭 제목에 대상 이름이 없어 상세 탭 여러 개를 구분할 수 없었습니다 — 대상 이름(빵부스러기 마지막 칸 글)을 앞에 붙입니다.
  // 수정 전(재현 커밋에서는 it.fails)에는 두 번째 인자를 무시해 '13F 포트폴리오 · 매크로 대시보드'였습니다.
  it("대상 이름을 주면 제목 앞에 붙인다 — 없거나 비면 그대로 (QA-594)", () => {
    expect(documentTitle("/institutions/0001608046", "국민연금 (National Pension Service)")).toBe("국민연금 (National Pension Service) · 13F 포트폴리오 · 매크로 대시보드");
    expect(documentTitle("/markets/i/sp500", "S&P 500")).toBe("S&P 500 · 시장 · 매크로 대시보드");
    expect(documentTitle("/s/us/AAPL", "AAPL")).toBe("AAPL · 시장 · 매크로 대시보드");
    expect(documentTitle("/institutions/0001608046", null)).toBe("13F 포트폴리오 · 매크로 대시보드");
    expect(documentTitle("/institutions/0001608046", "  ")).toBe("13F 포트폴리오 · 매크로 대시보드");
    expect(documentTitle("/institutions/0001608046")).toBe("13F 포트폴리오 · 매크로 대시보드");
  });
});

describe("통합 검색의 메뉴 항목", () => {
  it("보이는 화면 전부 + 더보기 화면, 탭 이름을 보조 글·검색어로", () => {
    const items = navSearchItems(MEMBER);
    expect(items.map((item) => item.href)).toEqual([
      "/", "/macro", "/liquidity", "/sector", "/correlation", "/cot", "/regime",
      "/institutions", "/consensus", "/style", "/scorecard", "/search",
      "/account", "/alerts", "/ai/report", "/radar", "/krx", "/more",
    ]);
    const liquidity = items.find((item) => item.href === "/liquidity");
    expect(liquidity).toEqual({
      href: "/liquidity", label: "순유동성", section: "시장", tab: "markets", keywords: ["시장", "연준 순유동성 트래커"], locked: false,
    });
  });

  it("정보 수집 여덟 화면은 운영자에게만 — 보조 글은 묶음 이름(정보 수집), 아이콘 원은 더보기 탭, '정보 수집'으로 찾힌다", () => {
    const items = navSearchItems(OWNER);
    const info = items.filter((item) => item.href.startsWith("/info"));
    expect(info.map((item) => item.href)).toEqual(INFO_TAB_SLUGS.map((slug) => `/info/${slug}`));
    for (const item of info) {
      expect(item.section).toBe("정보 수집");
      expect(item.tab).toBe("more");
      expect(item.keywords).toEqual(expect.arrayContaining(["더보기", "정보 수집"]));
    }
    expect(info.find((item) => item.href === "/info/news")?.label).toBe("정보 수집 · 뉴스·글");
    // 더보기 화면 항목은 한 번(맨 끝)
    expect(items.filter((item) => item.href === "/more")).toHaveLength(1);
    for (const user of [MEMBER, DEMO, undefined]) {
      expect(navSearchItems(user).some((item) => item.href.startsWith("/info"))).toBe(false);
    }
  });

  it("옛 한국 탭의 두 화면은 '한국'으로 계속 찾힌다 — 보조 글은 묶음 이름(한국 시장), 아이콘 원은 더보기 탭", () => {
    const radar = navSearchItems(MEMBER).find((item) => item.href === "/radar");
    expect(radar?.section).toBe("한국 시장");
    expect(radar?.tab).toBe("more");
    expect(radar?.keywords).toContain("한국");
    expect(navSearchItems(DEMO).find((item) => item.href === "/krx")?.keywords).toContain("한국");
  });

  it("유료 화면(AI 종합 분석)은 무료 회원에게만 잠김 — 하위 메뉴·더보기와 같은 규칙(lib/access lockedFor)", () => {
    const aiLocked = (user: SessionUser | undefined) => navSearchItems(user).find((item) => item.href === "/ai/report")?.locked;
    expect(aiLocked(MEMBER)).toBe(true);
    expect(aiLocked({ ...MEMBER, tier: "PRO" })).toBe(false);
    expect(aiLocked(OWNER)).toBe(false);
    expect(aiLocked(undefined)).toBe(false);
    expect(navSearchItems(MEMBER).filter((item) => item.locked).map((item) => item.href)).toEqual(["/ai/report"]);
  });

  it("운영자에게는 모의매매(미국)와 운영자 화면도 — 이름은 제목용 이름", () => {
    const items = navSearchItems(OWNER);
    expect(items.find((item) => item.href === "/paper/us")?.label).toBe("모의매매(미국)");
    expect(items.find((item) => item.href === "/paper/kr")?.label).toBe("모의매매(한국)");
    expect(navSearchItems(MEMBER).map((item) => item.href)).not.toContain("/paper/kr");
    expect(items.map((item) => item.href)).toEqual(expect.arrayContaining(["/status", "/connections", "/security", "/admin/users"]));
    expect(navSearchItems(DEMO).map((item) => item.href)).not.toContain("/status");
    expect(navSearchItems(DEMO).map((item) => item.href)).not.toContain("/account");
  });
});
