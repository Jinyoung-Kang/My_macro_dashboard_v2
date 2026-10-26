/**
 * 화면 메뉴(정보 구조) — 다섯 탭 + 더보기, 하위 화면, 지금 탭, 탭 제목, 검색 메뉴 항목(브리프 §1.3).
 */
import { describe, expect, it } from "vitest";
import {
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
  it("다섯 탭 + 더보기의 키·이름·이동 경로", () => {
    expect(TABS.map((entry) => [entry.key, entry.label, entry.href])).toEqual([
      ["home", "홈", "/"],
      ["markets", "시장", "/macro"],
      ["institutions", "기관", "/institutions"],
      ["korea", "한국", "/radar"],
      ["paper", "모의매매", "/paper/us"],
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
    expect(items("korea")).toEqual(["수급 레이더 /radar", "파생·투기세력(KRX) /krx"]);
    expect(items("paper")).toEqual(["미국 /paper/us"]);
    expect(tab("paper").upcoming).toEqual([{ label: "한국", note: "준비 중" }]);
    expect(items("more")).toEqual([
      "알림 /alerts", "AI 종합 분석 /ai/report", "데이터 저장소 상태 /status", "외부 API 연결 테스트 /connections",
      "사용자 관리 /admin/users", "내 계정 /account",
    ]);
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
    expect(keyOf("/radar")).toBe("korea");
    expect(keyOf("/krx")).toBe("korea");
    expect(keyOf("/paper")).toBe("paper");
    expect(keyOf("/paper/us")).toBe("paper");
    expect(keyOf("/paper/us/settings")).toBe("paper");
    expect(keyOf("/paper/kr")).toBe("paper");
    expect(keyOf("/more")).toBe("more");
    expect(keyOf("/alerts")).toBe("more");
    expect(keyOf("/ai/report")).toBe("more");
    expect(keyOf("/admin/users")).toBe("more");
    expect(keyOf("/account")).toBe("more");
  });

  it("메뉴에 없는 경로와 앞부분만 같은 경로는 어느 탭도 아니다(/macroeconomics·/paperclip — '/' 경계)", () => {
    expect(activeTab("/login")).toBeNull();
    expect(activeTab("/macroeconomics")).toBeNull();
    expect(activeTab("/paperclip")).toBeNull();
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
  });
});

describe("보이는 탭·하위 화면(lib/access 앞부분 일치)", () => {
  it("운영자는 여섯 탭, 회원·데모·모르는 사용자는 모의매매 탭이 빠진다", () => {
    expect(visibleTabs(OWNER).map((entry) => entry.label)).toEqual(["홈", "시장", "기관", "한국", "모의매매", "더보기"]);
    for (const user of [MEMBER, DEMO, undefined]) {
      expect(visibleTabs(user).map((entry) => entry.label)).toEqual(["홈", "시장", "기관", "한국", "더보기"]);
    }
  });

  it("더보기의 운영자 화면(저장소 상태·연결 테스트·사용자 관리)은 운영자에게만, 내 계정은 데모 열람에게 없다", () => {
    expect(visibleItems(tab("more"), MEMBER).map((item) => item.href)).toEqual(["/alerts", "/ai/report", "/account"]);
    expect(visibleItems(tab("more"), DEMO).map((item) => item.href)).toEqual(["/alerts", "/ai/report"]);
    expect(visibleItems(tab("more"), OWNER).map((item) => item.href)).toEqual([
      "/alerts", "/ai/report", "/status", "/connections", "/admin/users", "/account",
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
    expect(subNav("/radar", MEMBER)?.items.map((item) => item.label)).toEqual(["수급 레이더", "파생·투기세력(KRX)"]);
    expect(subNav("/", OWNER)).toBeNull();
    expect(subNav("/login", OWNER)).toBeNull();
  });

  it("모의매매: 운영자에게는 미국 + '한국 · 준비 중'(링크 없음), 주소로 연 회원에게는 줄이 없다", () => {
    const paper = subNav("/paper/us", OWNER);
    expect(paper?.items.map((item) => item.href)).toEqual(["/paper/us"]);
    expect(paper?.upcoming).toEqual([{ label: "한국", note: "준비 중" }]);
    expect(paper?.current).toBe("/paper/us");
    expect(paper?.currentAria).toBe("page");
    // 탭 주소(/paper/us/settings)에서도 미국이 지금 화면입니다 — 다만 "미국" 링크는 개요(/paper/us)로 가므로 "현재 페이지"가 아니라
    // "이 화면 안"(true)입니다(tabCurrent와 같은 규칙).
    const settings = subNav("/paper/us/settings", OWNER);
    expect(settings?.current).toBe("/paper/us");
    expect(settings?.currentAria).toBe("true");
    expect(subNav("/paper/us", MEMBER)).toBeNull();
  });

  it("더보기: 회원에게는 운영자 화면이 빠지고, 더보기 화면 자체(/more)에서는 고른 것이 없다", () => {
    expect(subNav("/alerts", MEMBER)?.items.map((item) => item.href)).toEqual(["/alerts", "/ai/report", "/account"]);
    expect(subNav("/more", OWNER)?.current).toBeNull();
    expect(subNav("/more", OWNER)?.currentAria).toBeNull();
    expect(subNav("/more", OWNER)?.items).toHaveLength(6);
  });
});

describe("브라우저 탭 제목", () => {
  it("하위 화면 이름(없으면 탭 이름) + ' · 매크로 대시보드'", () => {
    expect(menuTitle("/liquidity")).toBe("순유동성");
    expect(documentTitle("/liquidity")).toBe("순유동성 · 매크로 대시보드");
    expect(documentTitle("/")).toBe("홈 · 매크로 대시보드");
    expect(documentTitle("/account")).toBe("내 계정 · 매크로 대시보드");
    expect(documentTitle("/more")).toBe("더보기 · 매크로 대시보드");
  });

  it("짧은 이름만으로 뜻이 모자라면 제목용 이름을 쓴다 — 모의매매 미국 화면은 '미국'이 아니라 '모의매매(미국)'", () => {
    expect(menuTitle("/paper/us")).toBe("모의매매(미국)");
    expect(documentTitle("/paper/us")).toBe("모의매매(미국) · 매크로 대시보드");
    expect(documentTitle("/paper/us/decisions")).toBe("모의매매(미국) · 매크로 대시보드");
  });

  it("메뉴에 없는 경로는 앱 이름만", () => {
    expect(menuTitle("/login")).toBeNull();
    expect(documentTitle("/login")).toBe("매크로 대시보드");
  });
});

describe("통합 검색의 메뉴 항목", () => {
  it("보이는 화면 전부 + 더보기 화면, 탭 이름을 보조 글·검색어로", () => {
    const items = navSearchItems(MEMBER);
    expect(items.map((item) => item.href)).toEqual([
      "/", "/macro", "/liquidity", "/sector", "/correlation", "/cot", "/regime",
      "/institutions", "/consensus", "/style", "/scorecard", "/radar", "/krx",
      "/alerts", "/ai/report", "/account", "/more",
    ]);
    const liquidity = items.find((item) => item.href === "/liquidity");
    expect(liquidity).toEqual({
      href: "/liquidity", label: "순유동성", section: "시장", keywords: ["시장", "연준 순유동성 트래커"], locked: false,
    });
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
    expect(items.map((item) => item.href)).toEqual(expect.arrayContaining(["/status", "/connections", "/admin/users"]));
    expect(navSearchItems(DEMO).map((item) => item.href)).not.toContain("/status");
    expect(navSearchItems(DEMO).map((item) => item.href)).not.toContain("/account");
  });
});
