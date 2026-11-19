/**
 * 내 계정(/account) 속성 목록·폼·기기 표(작업대 P7 — 실행 명세 §7 7행 '내 계정: 속성 목록').
 *
 * - '계정' 속성 목록: 이메일·역할·등급·로그인 방식(세션은 '이메일·비밀번호(세션)', 로그인 없이 연 운영자는 '로컬 · 로그인 없음'·'Tailscale · 로그인 없음').
 *   모르는 값은 '—'.
 * - 폼 이름표는 공용 고르기 상자와 같은 13px text-2, 입력칸 폭 상한 22rem(form-label-styles-mixed).
 * - 로그인한 기기: 공용 조밀 표·개수 줄, 시각 칸 줄바꿈 없음.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGetShared: vi.fn(), UnauthorizedError, auth: { changePassword: vi.fn(), logoutOthers: vi.fn(), deleteAccount: vi.fn() } };
});
vi.mock("@/lib/api", () => api);
const refresh = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => refresh }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/account" }));

import AccountPage from "../account/page";

const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };
const TAILNET: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: true, tailnet: true };

function serve(user: SessionUser, noLogin: boolean) {
  const reads: Record<string, unknown> = {
    "/api/auth/session": { authenticated: true, readMode: "auto", noLogin, user },
    "/api/auth/sessions": {
      sessions: [
        { id: "s1", current: true, createdAt: "2026-11-18T00:00:00Z", lastSeenAt: "2026-11-18T01:00:00Z", expiresAt: "2026-11-19T00:00:00Z", userAgent: "합성 브라우저" },
        { id: "s2", current: false, createdAt: "2026-11-17T00:00:00Z", lastSeenAt: "2026-11-17T01:00:00Z", expiresAt: "2026-11-18T00:00:00Z", userAgent: null },
      ],
    },
  };
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
}

beforeEach(() => {
  api.apiGetShared.mockReset();
});
afterEach(() => cleanup());

const value = (scope: HTMLElement, label: string) => within(scope).getByText(label, { selector: "dt" }).nextElementSibling?.textContent;

describe("내 계정 — 속성 목록", () => {
  it("세션 회원: 이메일·역할·등급·로그인 방식, 기기 표는 조밀 표·개수 줄", async () => {
    serve(MEMBER, false);
    render(<SessionUserProvider user={MEMBER}><AccountPage /></SessionUserProvider>);
    const account = (await screen.findByRole("heading", { name: "계정" })).closest("section") as HTMLElement;
    expect(value(account, "이메일")).toBe("member@test.local");
    expect(value(account, "역할")).toBe("유료 회원");
    expect(value(account, "등급")).toBe("유료");
    expect(value(account, "로그인 방식")).toBe("이메일·비밀번호(세션)");
    const devices = await screen.findByRole("region", { name: "로그인한 기기 목록 (좌우 스크롤)" });
    expect(within(devices.closest("section") as HTMLElement).getByText("2건")).toBeTruthy();
    expect(within(devices).getByText("알 수 없음")).toBeTruthy();
  });

  it("Tailscale로 로그인 없이 연 운영자: 로그인 방식 'Tailscale · 로그인 없음', 안내는 중립 안내 상자", async () => {
    serve(TAILNET, true);
    render(<SessionUserProvider user={TAILNET}><AccountPage /></SessionUserProvider>);
    const account = (await screen.findByRole("heading", { name: "계정" })).closest("section") as HTMLElement;
    expect(value(account, "로그인 방식")).toBe("Tailscale · 로그인 없음");
    expect(screen.getByText(/Tailscale 계정\(운영자로 정한 사용자\)으로 연 서버 화면이라/).closest(".bg-surface-2")).not.toBeNull();
  });

  it("비밀번호 폼 이름표는 13px text-2·입력칸 폭 상한 22rem", async () => {
    serve(MEMBER, false);
    render(<SessionUserProvider user={MEMBER}><AccountPage /></SessionUserProvider>);
    const input = await screen.findByLabelText("지금 비밀번호");
    const label = input.closest("label") as HTMLElement;
    expect(label.className).toContain("text-[13px]");
    expect(label.className).toContain("text-text-2");
    expect(input.className).toContain("sm:max-w-[22rem]");
  });
});
