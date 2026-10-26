/**
 * 더보기 화면(/more) — 좁은 화면에서 계정·읽기 모드·새로고침·테마·빌드 정보를 쓰는 곳. 하위 화면 행은 운영자 전용·유료 잠금·데모 규칙을 따른다.
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

const rows = () => {
  const section = screen.getByRole("region", { name: "메뉴" });
  return within(section).getAllByRole("link").map((link) => [link.textContent?.replace("🔒", "") ?? "", link.getAttribute("href")]);
};

beforeEach(() => router.push.mockReset());
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear();
});

describe("더보기 화면", () => {
  it("회원: 알림·AI 종합 분석·내 계정 행, 이메일·등급 링크와 로그아웃, 새로고침 없음, 테마 전환·빌드 정보", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "main@1ccad1c");
    renderMore({ email: "member@test.local", role: "MEMBER", tier: "PRO" });

    expect(screen.getByRole("heading", { level: 1, name: "더보기" })).toBeTruthy();
    expect(rows()).toEqual([["알림", "/alerts"], ["AI 종합 분석", "/ai/report"], ["내 계정", "/account"]]);
    expect(screen.getByRole("button", { name: "로그아웃" })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "계정" })).getByRole("link").textContent).toContain("member@test.local");
    expect(screen.queryByRole("button", { name: /수동 새로고침/ })).toBeNull();
    expect(screen.getByRole("radiogroup", { name: "화면 테마" })).toBeTruthy();
    expect(screen.getByText(/main@1ccad1c/)).toBeTruthy();
  });

  it("무료 회원에게는 AI 종합 분석에 🔒", () => {
    renderMore({ email: "member@test.local", role: "MEMBER", tier: "FREE" });
    const ai = screen.getByRole("link", { name: /AI 종합 분석/ });
    expect(within(ai).getByRole("img", { name: "유료 등급 기능" })).toBeTruthy();
  });

  it("로컬 운영자: 운영자 화면까지 여섯 행, 로그아웃 대신 '로컬 · 로그인 없음', 수동 새로고침", () => {
    renderMore({ email: "owner@test.local", role: "OWNER", tier: "PRO", local: true });

    expect(rows().map(([, href]) => href)).toEqual(["/alerts", "/ai/report", "/status", "/connections", "/admin/users", "/account"]);
    expect(screen.queryByRole("button", { name: "로그아웃" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "계정" })).getByRole("link").textContent).toContain("로컬 · 로그인 없음");
    expect(screen.getByRole("button", { name: "데이터 수동 새로고침 🚀" })).toBeTruthy();
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
