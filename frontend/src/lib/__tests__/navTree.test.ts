/**
 * 넓은 화면 왼쪽 나무 메뉴의 모델(lib/nav navTree — 작업대 실행 명세 §5, ADR 0042 결정 5). 메뉴 표(TABS)·지금 탭·하위 메뉴 줄 규칙은 nav.test가 고정하고,
 * 여기서는 나무 모양만 봅니다: 보이는 탭 전부, 지금 탭만 펼침(하위 메뉴 줄과 같은 '둘 이상' 조건), 묶음 없는 화면 먼저·묶음은 그 이름 아래,
 * aria-current(page/true), 막대(marked)는 가장 깊은 지금 칸 하나.
 */
import { describe, expect, it } from "vitest";

import { navTree, type NavTreeNode } from "../nav";
import type { SessionUser } from "../types";

const OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: true };
const MEMBER_FREE: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "FREE" };
const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };

/** 막대를 가진 칸의 이름 — 탭 칸이면 탭 이름, 하위 칸이면 하위 화면 이름. */
function markedLabels(tree: NavTreeNode[]): string[] {
  return tree.flatMap((node) => [
    ...(node.marked ? [node.tab.label] : []),
    ...(node.groups ?? []).flatMap((group) => group.leaves.filter((leaf) => leaf.marked).map((leaf) => leaf.item.label)),
  ]);
}

const expanded = (tree: NavTreeNode[]) => tree.filter((node) => node.groups !== null).map((node) => node.tab.label);

describe("탭과 펼침", () => {
  it("운영자는 탭 여섯, 회원은 다섯 — TABS 순서 그대로(정보 수집은 맨 위 단계에 없음 — 2026-11-18 더보기 안 묶음으로)", () => {
    expect(navTree("/macro", OWNER).map((node) => node.tab.label)).toEqual(["홈", "시장", "기관", "모의매매", "정보 검색", "더보기"]);
    expect(navTree("/macro", MEMBER).map((node) => node.tab.label)).toEqual(["홈", "시장", "기관", "정보 검색", "더보기"]);
  });

  it("지금 탭만 펼친다 — 화면이 하나뿐인 탭(홈·정보 검색)은 펼치지 않고, 메뉴 밖 경로는 아무것도 펼치지 않는다", () => {
    expect(expanded(navTree("/liquidity", MEMBER))).toEqual(["시장"]);
    expect(expanded(navTree("/info/kr", OWNER))).toEqual(["더보기"]);
    expect(expanded(navTree("/", MEMBER))).toEqual([]);
    expect(expanded(navTree("/search", MEMBER))).toEqual([]);
    expect(expanded(navTree("/login", MEMBER))).toEqual([]);
  });

  it("펼친 시장 탭의 하위 칸 여섯 — 묶음 없음", () => {
    const markets = navTree("/liquidity", MEMBER).find((node) => node.tab.key === "markets");
    expect(markets?.groups?.map((group) => group.label)).toEqual([null]);
    expect(markets?.groups?.[0].leaves.map((leaf) => leaf.item.label)).toEqual(["매크로 지표", "순유동성", "섹터·자산군", "상관관계", "투기세력(COT)", "국면 판정"]);
  });

  it("더보기는 묶음 없는 화면이 먼저, '한국 시장' 묶음이 그다음 — 하위 메뉴 줄과 달리 두 묶음을 함께 펼친다", () => {
    const more = navTree("/radar", MEMBER_FREE).find((node) => node.tab.key === "more");
    expect(more?.groups?.map((group) => group.label)).toEqual([null, "한국 시장"]);
    expect(more?.groups?.[0].leaves.map((leaf) => leaf.item.label)).toEqual(["알림", "AI 종합 분석", "내 계정"]);
    expect(more?.groups?.[1].leaves.map((leaf) => leaf.item.label)).toEqual(["수급 레이더", "파생·투기세력(KRX)"]);
    // 무료 회원에게 유료 화면은 잠금
    expect(more?.groups?.[0].leaves.find((leaf) => leaf.item.href === "/ai/report")?.locked).toBe(true);
    expect(more?.groups?.[0].leaves.find((leaf) => leaf.item.href === "/alerts")?.locked).toBe(false);
  });

  // 2026-11-18 사용자 요청: 정보 수집을 더보기 안의 묶음으로. 묶음 차례는 묶음 없는 화면 → 한국 시장 → 정보 수집(운영자 전용 여덟 칸을 맨 뒤에).
  it("운영자의 더보기는 묶음 없는 화면 → '한국 시장' → '정보 수집'(여덟 화면) — /info/kr에서 그 칸이 지금 칸(page)이고 막대", () => {
    const more = navTree("/info/kr", OWNER).find((node) => node.tab.key === "more");
    expect(more?.current).toBe("true");
    expect(more?.marked).toBe(false);
    expect(more?.groups?.map((group) => group.label)).toEqual([null, "한국 시장", "정보 수집"]);
    const info = more?.groups?.[2];
    expect(info?.leaves.map((leaf) => leaf.item.label)).toEqual([
      "개요", "뉴스·글", "국내 시장·수급", "해외 시장·거시", "기관·공시", "모의매매 입력", "출처 상태", "정보(메커니즘)",
    ]);
    expect(info?.leaves.map((leaf) => leaf.current)).toEqual([undefined, undefined, "page", undefined, undefined, undefined, undefined, undefined]);
    expect(markedLabels(navTree("/info/kr", OWNER))).toEqual(["국내 시장·수급"]);
    // 다른 더보기 화면에 있어도 세 묶음을 함께 펼친다(하위 메뉴 줄과 다름).
    expect(navTree("/alerts", OWNER).find((node) => node.tab.key === "more")?.groups?.map((group) => group.label)).toEqual([null, "한국 시장", "정보 수집"]);
  });

  it("회원·무료 회원의 나무에는 '정보 수집' 묶음이 없다 — 주소로 연 /info/kr에서도 더보기 묶음은 둘(운영자 전용 /info)", () => {
    for (const user of [MEMBER, MEMBER_FREE]) {
      const more = navTree("/info/kr", user).find((node) => node.tab.key === "more");
      expect(more?.groups?.map((group) => group.label)).toEqual([null, "한국 시장"]);
      // 보이지 않는 화면이라 하위 칸 막대가 없고, 더보기 탭 칸이 막대(지금 탭 영역).
      expect(markedLabels(navTree("/info/kr", user))).toEqual(["더보기"]);
    }
  });

  it("운영자의 더보기에는 운영 화면도 — 회원의 나무에는 없다", () => {
    const labelsOf = (user: SessionUser) =>
      navTree("/more", user).find((node) => node.tab.key === "more")?.groups?.[0].leaves.map((leaf) => leaf.item.label);
    expect(labelsOf(OWNER)).toEqual(["알림", "AI 종합 분석", "데이터 저장소 상태", "외부 API 연결 테스트", "보안 공지", "사용자 관리", "내 계정"]);
    expect(labelsOf(MEMBER)).toEqual(["알림", "AI 종합 분석", "내 계정"]);
  });
});

describe("aria-current", () => {
  it("탭 칸은 tabCurrent 그대로(첫 화면 page·다른 화면 true), 하위 칸은 지금 화면만(주소 그대로 page·아래 주소 true)", () => {
    const tree = navTree("/macro", MEMBER);
    const markets = tree.find((node) => node.tab.key === "markets");
    expect(markets?.current).toBe("page");
    expect(markets?.groups?.[0].leaves.map((leaf) => leaf.current)).toEqual(["page", undefined, undefined, undefined, undefined, undefined]);
    expect(tree.find((node) => node.tab.key === "home")?.current).toBeUndefined();

    const paper = navTree("/paper/us/holdings", OWNER).find((node) => node.tab.key === "paper");
    expect(paper?.current).toBe("true");
    expect(paper?.groups?.[0].leaves.map((leaf) => [leaf.item.label, leaf.current])).toEqual([
      ["미국", "true"],
      ["한국", undefined],
    ]);
  });
});

describe("막대 — 가장 깊은 지금 칸 하나", () => {
  it.each([
    ["/macro", MEMBER, ["매크로 지표"]],
    ["/liquidity", MEMBER, ["순유동성"]],
    ["/institutions/123", MEMBER, ["13F 포트폴리오"]],
    ["/markets/i/x", MEMBER, ["시장"]],
    ["/s/us/NVDA", MEMBER, ["시장"]],
    ["/more", MEMBER, ["더보기"]],
    ["/radar", MEMBER, ["수급 레이더"]],
    ["/paper/us/holdings", OWNER, ["미국"]],
    ["/", MEMBER, ["홈"]],
    ["/search", MEMBER, ["정보 검색"]],
    ["/login", MEMBER, []],
  ] as const)("%s → %j", (path, user, marked) => {
    expect(markedLabels(navTree(path, user))).toEqual(marked);
  });

  it("회원이 주소로 연 /paper/us는 나무에 모의매매 탭이 없어 펼침·막대가 없다", () => {
    const tree = navTree("/paper/us", MEMBER);
    expect(tree.some((node) => node.tab.key === "paper")).toBe(false);
    expect(expanded(tree)).toEqual([]);
    expect(markedLabels(tree)).toEqual([]);
  });

  it("펼친 지금 탭 칸은 막대가 없다(그 아래 지금 하위 칸이 막대를 가짐)", () => {
    const markets = navTree("/macro", MEMBER).find((node) => node.tab.key === "markets");
    expect(markets?.marked).toBe(false);
    expect(markets?.groups?.[0].leaves[0].marked).toBe(true);
  });
});
