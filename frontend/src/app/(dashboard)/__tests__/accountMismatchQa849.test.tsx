/**
 * QA-849 — 내 계정 비밀번호 변경의 '새 비밀번호가 서로 다릅니다.'가 위험색 글만(아이콘 없음)
 * (D1 QA `auth-error-message-no-icon`의 계정 몫, S4, 개편 전부터 — 인증 화면 몫은 인증 갈래).
 *
 * 위험색(#e76a6e)은 상승 빨강과 색만으로 갈리지 않고 고대비에서는 색이 지워집니다 — 상태·위험은 늘 아이콘 + 글(명세 §3-2-1).
 * 기대: 불일치 글은 공용 상태 글(위험 아이콘 + 낭독 머리말 '오류:' + 글).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

beforeEach(() => {
  const reads: Record<string, unknown> = {
    "/api/auth/session": { authenticated: true, readMode: "auto", noLogin: false, user: MEMBER },
    "/api/auth/sessions": { sessions: [] },
  };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => cleanup());

describe("QA-849 내 계정 — 새 비밀번호 불일치는 아이콘 + 글", () => {
  it.fails("'새 비밀번호가 서로 다릅니다.'에 위험 아이콘과 낭독 머리말 '오류:'", async () => {
    render(<SessionUserProvider user={MEMBER}><AccountPage /></SessionUserProvider>);
    fireEvent.change(await screen.findByLabelText("새 비밀번호"), { target: { value: "first pass word" } });
    fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: "second pass word" } });
    const message = screen.getByText("새 비밀번호가 서로 다릅니다.");
    const status = message.closest(".text-danger") as HTMLElement;
    expect(status.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(status.textContent).toBe("오류: 새 비밀번호가 서로 다릅니다.");
  });
});
