/**
 * 내 계정 — 로그인 없이 연 로컬 운영자(ADR 0016)는 세션(쿠키)이 없어 로그인한 기기 목록을 부르지 않고 그 카드를
 * 숨긴다. 비밀번호 변경은 남기되 그 비밀번호를 어디서 쓰는지(웹·QA 스택, 복원한 백업) 적는다.
 * 쿠키 세션으로 로그인한 사용자는 지금과 같다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import type { SessionResponse, SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return {
    apiGetShared: vi.fn(),
    UnauthorizedError,
    auth: { changePassword: vi.fn(), logoutOthers: vi.fn(), deleteAccount: vi.fn() },
  };
});
vi.mock("@/lib/api", () => api);

// 매 렌더마다 새 함수를 주면 useApi가 다시 읽기를 반복합니다 — 같은 값을 돌려줍니다.
const refresh = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => refresh }));

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/account" }));

import AccountPage from "../account/page";

const SESSIONS = "/api/auth/sessions";
const LOCAL: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: true };
const COOKIE_OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: false };

function serveSession(user: SessionUser, noLogin: boolean) {
  const session: SessionResponse = { authenticated: true, readMode: "auto", noLogin, user };
  const reads: Record<string, unknown> = {
    "/api/auth/session": session,
    [SESSIONS]: {
      sessions: [{
        id: "s1", current: true, createdAt: "2026-10-19T00:00:00Z", lastSeenAt: "2026-10-19T00:00:00Z",
        expiresAt: "2026-10-19T12:00:00Z", userAgent: "시험 브라우저",
      }],
    },
  };
  api.apiGetShared.mockImplementation((path: string) =>
    path in reads ? Promise.resolve(reads[path]) : new Promise(() => {}),
  );
}

function requested(path: string): boolean {
  return api.apiGetShared.mock.calls.some(([called]) => called === path);
}

beforeEach(() => {
  api.apiGetShared.mockReset();
  router.replace.mockReset();
});

afterEach(() => cleanup());

describe("내 계정 — 로그인 없이 연 로컬 운영자", () => {
  it("기기 목록을 부르지 않고 '로그인한 기기' 카드를 숨기며, 비밀번호 변경은 쓰는 곳을 적어 남긴다", async () => {
    serveSession(LOCAL, true);
    render(<SessionUserProvider user={LOCAL}><AccountPage /></SessionUserProvider>);

    expect(await screen.findByText("비밀번호 변경")).toBeTruthy();
    expect(screen.getByText(/웹·QA 스택에서 로그인하거나 이 DB의 백업을 복원했을 때 씁니다/)).toBeTruthy();
    expect(screen.getByText(/로컬 · 로그인 없음 — /)).toBeTruthy();
    expect(screen.getByRole("button", { name: "비밀번호 바꾸기" })).toBeTruthy();
    expect(screen.queryByText("로그인한 기기")).toBeNull();
    expect(screen.queryByRole("button", { name: "다른 기기 모두 로그아웃" })).toBeNull();
    expect(requested(SESSIONS)).toBe(false);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("레이아웃 밖이라 사용자를 모를 때도 세션 응답이 로컬 운영자면 카드를 숨긴다", async () => {
    serveSession(LOCAL, true);
    render(<AccountPage />);

    expect(await screen.findByText(/로컬 · 로그인 없음 — /)).toBeTruthy();
    expect(screen.queryByText("로그인한 기기")).toBeNull();
    expect(screen.getByText("비밀번호 변경")).toBeTruthy();
  });
});

describe("내 계정 — 쿠키 세션으로 로그인한 사용자(지금과 같음)", () => {
  it("기기 목록을 읽어 '로그인한 기기'와 '다른 기기 모두 로그아웃'을 보이고, 비밀번호 안내도 그대로다", async () => {
    serveSession(COOKIE_OWNER, false);
    render(<SessionUserProvider user={COOKIE_OWNER}><AccountPage /></SessionUserProvider>);

    expect(await screen.findByText("지금 이 기기")).toBeTruthy();
    expect(screen.getByText("로그인한 기기")).toBeTruthy();
    expect(screen.getByRole("button", { name: "다른 기기 모두 로그아웃" })).toBeTruthy();
    expect(screen.getByText(/바꾸면 다른 기기의 로그인은 끊깁니다/)).toBeTruthy();
    expect(screen.queryByText(/로컬 · 로그인 없음/)).toBeNull();
    expect(requested(SESSIONS)).toBe(true);
  });
});
