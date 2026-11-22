/**
 * 더보기 화면(/more) — 좁은 화면에서 계정·읽기 모드·새로고침·빌드 정보를 쓰는 곳(테마 전환은 없음 — ADR 0042 결정 2). 하위 화면 행은 운영자 전용·유료 잠금·데모 규칙을 따른다.
 * 옛 한국 탭의 두 화면은 '한국 시장' 묶음으로 따로(ADR 0041 결정 1) — '메뉴' 묶음 다음. 정보 수집 여덟 화면은 그다음 '정보 수집' 묶음(운영자에게만 —
 * 2026-11-18 사용자 요청으로 맨 위 단계 탭에서 옮김, 그 전에는 '메뉴' 맨 위 행 하나).
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadModeProvider } from "@/components/shell/ReadMode";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => ({ auth: { logout: vi.fn() } }));
vi.mock("@/lib/api", () => api);

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/more", useRouter: () => router }));

vi.mock("@/hooks/useRefreshSignal", () => ({
  useRefreshSignal: () => ({ requestRefresh: vi.fn(), collecting: false, message: null }),
}));

import MorePage from "@/app/(dashboard)/more/page";

function renderMore(user: SessionUser | undefined, readMode?: string) {
  return render(
    <ReadModeProvider readMode={readMode}>
      <SessionUserProvider user={user}>
        <MorePage />
      </SessionUserProvider>
    </ReadModeProvider>,
  );
}

const rows = (name = "메뉴") => {
  const section = screen.getByRole("region", { name });
  return within(section).getAllByRole("link").map((link) => [link.textContent ?? "", link.getAttribute("href")]);
};

const KR_ROWS = [["수급 레이더", "/radar"], ["파생·투기세력(KRX)", "/krx"]];
const INFO_ROWS = [
  ["개요", "/info/overview"], ["국내 시장·수급", "/info/kr"], ["기관·공시", "/info/filings"], ["뉴스·글", "/info/news"],
  ["모의매매 입력", "/info/paper"], ["정보(메커니즘)", "/info/mechanism"], ["출처 상태", "/info/status"], ["해외 시장·거시", "/info/global"],
];

beforeEach(() => router.push.mockReset());
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  window.localStorage.clear();
});

describe("더보기 화면", () => {
  it("회원: 알림·AI 종합 분석·내 계정 행, 이메일·등급 링크와 로그아웃, 새로고침 없음, 빌드 정보 — 테마 전환은 없음(어두운 한 벌)", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "main@1ccad1c");
    renderMore({ email: "member@test.local", role: "MEMBER", tier: "PRO" });

    expect(screen.getByRole("heading", { level: 1, name: "더보기" })).toBeTruthy();
    expect(rows()).toEqual([["내 계정", "/account"], ["알림", "/alerts"], ["AI 종합 분석", "/ai/report"]]);
    expect(screen.getByRole("button", { name: "로그아웃" })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "계정" })).getByRole("link").textContent).toContain("member@test.local");
    expect(screen.queryByRole("button", { name: /수동 새로고침/ })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "화면 테마" })).toBeNull();
    expect(screen.getByText(/main@1ccad1c/)).toBeTruthy();
  });

  it("한국 시장 묶음: 회원·데모·운영자 모두 수급 레이더·파생·투기세력 두 행, '메뉴' 묶음 다음 자리, 장식 아이콘", () => {
    for (const user of [
      { email: "member@test.local", role: "MEMBER", tier: "FREE" },
      { email: null, role: "MEMBER", tier: "PRO", demo: true },
      { email: "owner@test.local", role: "OWNER", tier: "PRO", local: true },
    ] as SessionUser[]) {
      renderMore(user);
      expect(rows("한국 시장")).toEqual(KR_ROWS);
      const sections = screen.getAllByRole("region").map((section) => section.getAttribute("aria-labelledby"));
      expect(sections.indexOf("more-kr")).toBe(sections.indexOf("more-menus") + 1);
      for (const link of within(screen.getByRole("region", { name: "한국 시장" })).getAllByRole("link")) {
        expect(link.querySelector("span[aria-hidden='true'] svg")).toBeTruthy();
      }
      cleanup();
    }
  });

  // 작업대 P7: 원판(40px 원) 없이 20px 아이콘만 — 장식(aria-hidden)이라는 뜻은 그대로, 줄은 좁은 화면 48px·넓은 화면 40px.
  it("행마다 왼쪽 아이콘은 장식(aria-hidden) — 링크 이름은 화면 이름 그대로, 줄은 좁은 화면 48px·넓은 화면 40px", () => {
    renderMore({ email: "owner@test.local", role: "OWNER", tier: "PRO", local: true });
    const links = within(screen.getByRole("region", { name: "메뉴" })).getAllByRole("link");
    expect(links).toHaveLength(7);
    for (const link of links) {
      expect(link.querySelector("span[aria-hidden='true'] svg")).toBeTruthy();
      expect(link.querySelector(".rounded-full")).toBeNull();
      expect(link.className).toContain("min-h-12");
      expect(link.className).toContain("lg:min-h-10");
    }
    expect(screen.getByRole("link", { name: "데이터 저장소 상태" }).getAttribute("href")).toBe("/status");
  });

  // 2026-11-18 사용자 요청: 정보 수집을 맨 위 단계 탭에서 더보기 안의 묶음으로 — 한국 시장 묶음과 같은 꼴(제목 아래 화면마다 행).
  it("운영자: '한국 시장' 다음 '정보 수집' 묶음 — 여덟 분류 행(주소 /info/<분류> 그대로), 장식 아이콘", () => {
    renderMore({ email: "owner@test.local", role: "OWNER", tier: "PRO", local: true });
    expect(rows("정보 수집")).toEqual(INFO_ROWS);
    const sections = screen.getAllByRole("region").map((section) => section.getAttribute("aria-labelledby"));
    expect(sections.slice(0, 3)).toEqual(["more-menus", "more-kr", "more-info"]);
    for (const link of within(screen.getByRole("region", { name: "정보 수집" })).getAllByRole("link")) {
      expect(link.querySelector("span[aria-hidden='true'] svg")).toBeTruthy();
    }
  });

  // 검토 지적: 머리 설명이 '알림·한국 시장·계정·운영 화면과 빌드 정보' 그대로라 운영자에게 가장 큰 묶음이 된 '정보 수집'을 말하지 않았습니다.
  // 설명의 묶음 이름은 보이는 묶음 그대로 — 운영자에게만 '정보 수집', 회원은 전과 같은 글.
  it("머리 설명의 묶음 이름은 보이는 묶음 그대로 — 운영자는 정보 수집까지, 회원은 전과 같은 글", () => {
    renderMore({ email: "owner@test.local", role: "OWNER", tier: "PRO", local: true });
    expect(screen.getByText("알림·한국 시장·정보 수집·계정·운영 화면과 빌드 정보")).toBeTruthy();
    cleanup();

    renderMore({ email: "member@test.local", role: "MEMBER", tier: "PRO" });
    expect(screen.getByText("알림·한국 시장·계정·운영 화면과 빌드 정보")).toBeTruthy();
    expect(screen.queryByText(/정보 수집/)).toBeNull();
  });

  it("회원·데모에게는 '정보 수집' 묶음이 없고 /info 링크도 없다(운영자 전용)", () => {
    for (const user of [
      { email: "member@test.local", role: "MEMBER", tier: "PRO" },
      { email: null, role: "MEMBER", tier: "PRO", demo: true },
    ] as SessionUser[]) {
      renderMore(user);
      expect(screen.queryByRole("region", { name: "정보 수집" })).toBeNull();
      expect(document.querySelector('a[href^="/info"]')).toBeNull();
      cleanup();
    }
  });

  it("무료 회원에게는 AI 종합 분석에 잠금 아이콘", () => {
    renderMore({ email: "member@test.local", role: "MEMBER", tier: "FREE" });
    const ai = screen.getByRole("link", { name: /AI 종합 분석/ });
    expect(within(ai).getByRole("img", { name: "유료 등급 기능" })).toBeTruthy();
  });

  it("로컬 운영자: '메뉴'는 운영자 화면까지 일곱 행(정보 수집 행 없음), 로그아웃 대신 '로컬 · 로그인 없음', 수동 새로고침", () => {
    renderMore({ email: "owner@test.local", role: "OWNER", tier: "PRO", local: true });

    expect(rows().map(([, href]) => href)).toEqual(["/account", "/status", "/security", "/admin/users", "/alerts", "/connections", "/ai/report"]);
    expect(screen.queryByRole("button", { name: "로그아웃" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "계정" })).getByRole("link").textContent).toContain("로컬 · 로그인 없음");
    expect(screen.getByRole("button", { name: "데이터 수동 새로고침" })).toBeTruthy();
  });

  // D1 QA 넘김(more-refresh-primary-sm-24px): 홀로 선 주 동작(새로고침)과 로그아웃이 표 안용 작은 크기(sm — 넓은 화면 24px)였습니다.
  // 기본 크기(md — 좁은 화면 44px, 로그아웃은 넓은 화면 30px)로 둡니다(명세 §3-7). 결함 번호 없는 겉모양 고침. 새로고침은 lg 미만에서만 보입니다(QA-564).
  it("새로고침·로그아웃은 홀로 선 단추라 기본 크기(좁은 화면 44px·로그아웃은 넓은 화면 30px) — 표 안용 작은 크기(24px)가 아니다", () => {
    renderMore({ email: "owner@test.local", role: "OWNER", tier: "PRO", local: false });
    for (const name of ["데이터 수동 새로고침", "로그아웃"]) {
      const classes = screen.getByRole("button", { name }).className.split(/\s+/);
      expect(classes).toEqual(expect.arrayContaining(["min-h-11", "lg:min-h-[30px]", "w-full"]));
      expect(classes).not.toContain("lg:min-h-6");
    }
  });

  // QA-564: 넓은 화면(lg 이상)에는 상단바의 새로고침 아이콘 단추와 그 안내(role=status)가 이미 있습니다. /more의 '데이터 읽기' 묶음까지 모든 폭에
  // 그리면 넓은 화면 /more에 단추 둘·같은 글의 live region 둘이 보였습니다(명세 §5 — lg 이상은 상단바, lg 미만은 더보기). 읽기 모드 글은 모든 폭.
  // 수정 전(재현 커밋에서는 it.fails)에는 단추·안내의 closest('.lg\:hidden')이 null — 넓은 화면에서도 보임.
  it("QA-564 — 새로고침 단추와 그 안내(role=status)는 좁은 화면(lg 미만)에서만 보이고, 읽기 모드 글은 모든 폭에 보인다", () => {
    renderMore({ email: "owner@test.local", role: "OWNER", tier: "PRO", local: true });
    const data = screen.getByRole("region", { name: "데이터 읽기" });
    const button = within(data).getByRole("button", { name: "데이터 수동 새로고침" });
    const status = within(data).getByRole("status");
    expect(button.closest(".lg\\:hidden")).not.toBeNull();
    expect(status.closest(".lg\\:hidden")).not.toBeNull();
    expect(within(data).getByText(/읽기 모드:/).closest(".lg\\:hidden")).toBeNull();
  });

  it("데모 열람: 내 계정 행·로그아웃이 없고 '데모 열람' 표시", () => {
    renderMore({ email: null, role: "MEMBER", tier: "PRO", demo: true });

    expect(rows()).toEqual([["알림", "/alerts"], ["AI 종합 분석", "/ai/report"]]);
    expect(document.querySelector('a[href="/account"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "로그아웃" })).toBeNull();
    expect(screen.getByText("데모 열람")).toBeTruthy();
  });

  // 좁은 화면에는 왼쪽 내비가 없어, 여기 말고는 읽기 모드를 볼 곳이 없다(옛 사이드바는 좁은 화면 메뉴 안에서 보였다).
  it("읽기 모드를 보이고, store_only면 저장본만 쓴다는 안내", () => {
    renderMore({ email: "member@test.local", role: "MEMBER", tier: "PRO" }, "store_only");
    const data = screen.getByRole("region", { name: "데이터 읽기" });
    expect(within(data).getByText("store_only")).toBeTruthy();
    expect(within(data).getByText("저장본만 사용합니다. 화면이 외부 수집을 기다리지 않습니다.")).toBeTruthy();
    cleanup();

    renderMore({ email: "member@test.local", role: "MEMBER", tier: "PRO" }, "auto");
    expect(within(screen.getByRole("region", { name: "데이터 읽기" })).getByText("auto")).toBeTruthy();
    expect(screen.queryByText(/저장본만 사용합니다/)).toBeNull();
  });
});
