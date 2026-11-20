/**
 * 사용자 관리 '운영자로 올리기' 대화상자의 오류 글 낭독과 입력칸 연결 — QA-868(작업대 P8, 인증 다섯 화면과 같은 결함 — components/auth/__tests__/
 * authAnnounceQa868.test.tsx).
 *
 * 틀린 비밀번호·연속 실패 지연의 오류 Banner가 보낸 뒤에야 붙는 보통 상자라 낭독되지 않았고, '운영자 비밀번호' 입력칸과 이어지지 않았습니다.
 * 기대(경로·본문·확인 문구·비밀번호 단계 그대로 — moreWritesKeep·stateHandling QA-338): 오류 Banner는 대화상자를 열 때부터 있는 role="alert" 영역 안에
 * 그리고, 비밀번호 입력칸이 그 오류 글로 aria-describedby(오류가 없으면 풀림).
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 'Unable to find an accessible element with the role "alert"'(열 때 영역 없음).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError, auth: { logout: vi.fn() } };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/admin/users", useRouter: () => router }));

import AdminUsersPage from "../admin/users/page";

const MEMBER_ROW = { id: 7, email: "m@test.local", role: "MEMBER", tier: "FREE", verified: true, createdAt: "2026-10-01T00:00:00Z" };
const WRONG = "운영자 비밀번호가 올바르지 않습니다 — 역할을 바꾸지 않았습니다.";

beforeEach(() => {
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    Promise.resolve(path.startsWith("/api/admin/users") ? { users: [MEMBER_ROW] } : { entries: [] }),
  );
});
afterEach(() => cleanup());

function described(input: HTMLElement): string {
  const ids = (input.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? `(없는 id ${id})`).join(" | ");
}

describe("운영자로 올리기 — 오류 글의 낭독과 입력칸 연결(QA-868)", () => {
  it.fails("틀린 비밀번호: 열 때부터 있던 role=alert 영역 안에 서버 글, 비밀번호 입력칸이 그 글로 설명됨 — 본문 그대로", async () => {
    api.apiPost.mockRejectedValue(new Error(WRONG));
    render(<AdminUsersPage />);
    fireEvent.change(await screen.findByLabelText("m@test.local 역할"), { target: { value: "OWNER" } });
    const dialog = within(await screen.findByRole("dialog", { name: "운영자로 올리기" }));
    const region = dialog.getByRole("alert");
    expect(region.textContent).toBe("");
    const password = dialog.getByLabelText("운영자 비밀번호");
    expect(password.getAttribute("aria-describedby")).toBeNull();

    fireEvent.change(password, { target: { value: "wrong guess" } });
    fireEvent.click(dialog.getByRole("button", { name: "운영자로 올리기" }));

    await waitFor(() => expect(region.textContent).toContain(WRONG));
    expect(api.apiPost.mock.calls).toEqual([["/api/admin/users/7", { role: "OWNER", tier: "FREE", password: "wrong guess" }]]);
    expect(described(dialog.getByLabelText("운영자 비밀번호"))).toContain(WRONG);
  });
});
