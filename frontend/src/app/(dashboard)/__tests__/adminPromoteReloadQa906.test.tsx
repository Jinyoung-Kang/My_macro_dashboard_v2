/**
 * 운영자로 올리기 — 목록을 다시 읽는 동안 다시 보내기(QA-906, 개편 전부터 — 작업대 P8 통합 검토 지적).
 *
 * `save`는 update.run 뒤 `await users.reload()`를 기다리는데, 그 동안 update.busy는 이미 거짓이고 비밀번호 칸은 save가 끝난 뒤에야 비워집니다. 그래서 다시
 * 읽는 동안 '운영자로 올리기'를 다시 누르거나 입력칸에서 Enter를 치면 같은 POST(비밀번호 포함)가 한 번 더 갔습니다.
 * 기대: 다시 읽기까지 요청 중(단추 aria-disabled·누름 무시, 입력칸 읽기 전용, 폼 보내기 무시) — 요청은 한 번. 경로·본문·문구는 그대로(moreWritesKeep).
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 'expected "vi.fn()" to be called 1 times, but got 2 times'.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
/** 참이면 사용자 목록 다시 읽기가 끝나지 않습니다(쓰기가 끝난 뒤의 다시 읽기를 붙잡아 둠). */
let holdUsers = false;

beforeEach(() => {
  holdUsers = false;
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path.startsWith("/api/admin/users")
      ? holdUsers ? new Promise(() => {}) : Promise.resolve({ users: [MEMBER_ROW] })
      : Promise.resolve({ entries: [] }),
  );
  api.apiPost.mockImplementation(async () => {
    holdUsers = true;
    return { ok: true, message: "운영자로 바꿨습니다." };
  });
});
afterEach(() => cleanup());

describe("운영자로 올리기 — 다시 읽는 동안(QA-906)", () => {
  it("쓰기가 끝나고 목록을 다시 읽는 동안 다시 누르거나 보내도 요청은 한 번이고 단추·입력칸은 요청 중", async () => {
    render(<AdminUsersPage />);
    fireEvent.change(await screen.findByLabelText("m@test.local 역할"), { target: { value: "OWNER" } });
    const dialog = within(await screen.findByRole("dialog", { name: "운영자로 올리기" }));
    const password = dialog.getByLabelText("운영자 비밀번호") as HTMLInputElement;
    fireEvent.change(password, { target: { value: "owner pass" } });
    const submit = dialog.getByRole("button", { name: "운영자로 올리기" }) as HTMLButtonElement;
    submit.focus();
    fireEvent.click(submit);
    for (let round = 0; round < 4; round += 1) await act(async () => {});

    // 쓰기는 끝났고(update.busy 거짓) 목록 다시 읽기만 남은 때.
    expect(api.apiPost.mock.calls).toEqual([["/api/admin/users/7", { role: "OWNER", tier: "FREE", password: "owner pass" }]]);
    fireEvent.click(submit);
    fireEvent.submit(password.form as HTMLFormElement);
    await act(async () => {});
    expect(api.apiPost).toHaveBeenCalledTimes(1);
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    expect(submit.disabled).toBe(false);
    expect(password.readOnly).toBe(true);
    expect(document.activeElement).toBe(submit);
  });
});
