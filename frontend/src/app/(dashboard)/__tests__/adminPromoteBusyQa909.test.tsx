/**
 * '운영자로 올리기' 대화상자의 요청 동안 진짜 disabled — QA-909(`busy-disabled-focus-body`, 인증 화면 주 단추와 같은 결함 — components/auth/__tests__/
 * authBusyFocusQa909.test.tsx).
 *
 * 비밀번호 입력칸은 `disabled={update.busy}`, 보내기 단추는 `disabled={update.busy || !promotePassword}`라 입력칸에서 Enter로 보내거나 단추를 키보드로
 * 누르면 그 순간 포커스를 가진 조작이 꺼져 포커스가 body로 떨어졌습니다(대화상자 안에서 포커스 가둠도 놓침). 실패하면 화면이 비밀번호를 비워 단추가
 * 켜짐 조건으로 꺼지므로 그때도 포커스가 body로 갔습니다.
 * 기대(경로·본문·문구·닫기 단추 없음·비밀번호 단계 그대로 — moreWritesKeep·stateHandling QA-338): 요청 동안 입력칸은 읽기 전용 + aria-disabled, 단추는
 * aria-disabled(둘 다 꺼진 모양 그대로 — 포커스가 남음), 다시 보내도 요청은 한 번. 실패하면 포커스를 비운 비밀번호 입력칸으로(다시 칠 자리 — 오류 글이
 * 그 칸을 설명, QA-868). 비밀번호가 비면 단추가 꺼지는 켜짐 조건과 '취소'는 그대로.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 첫 사례 'expected true to be false'(요청 동안 입력칸 disabled), 둘째 사례
 * 'expected <button …> to be <input …>'(실패 뒤 포커스가 꺼진 단추에 — jsdom은 disabled가 된 단추에서 포커스를 빼지 않음, 크롬은 body).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

async function openPromote() {
  render(<AdminUsersPage />);
  fireEvent.change(await screen.findByLabelText("m@test.local 역할"), { target: { value: "OWNER" } });
  return within(await screen.findByRole("dialog", { name: "운영자로 올리기" }));
}

describe("운영자로 올리기 — 요청 동안 포커스(QA-909)", () => {
  it("입력칸 Enter로 보내면 요청 동안 입력칸·단추가 aria-disabled이고 포커스가 입력칸에 남는다 — 다시 보내도 한 번, 본문 그대로", async () => {
    api.apiPost.mockImplementation(() => new Promise(() => {}));
    const dialog = await openPromote();
    const password = dialog.getByLabelText("운영자 비밀번호") as HTMLInputElement;
    fireEvent.change(password, { target: { value: "owner pass" } });
    password.focus();
    fireEvent.submit(password.form as HTMLFormElement);
    await act(async () => {});

    expect(api.apiPost.mock.calls).toEqual([["/api/admin/users/7", { role: "OWNER", tier: "FREE", password: "owner pass" }]]);
    expect(password.disabled).toBe(false);
    expect(password.getAttribute("aria-disabled")).toBe("true");
    expect(password.readOnly).toBe(true);
    expect(document.activeElement).toBe(password);
    const submit = dialog.getByRole("button", { name: "확인하는 중…" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(submit.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(submit);
    fireEvent.submit(password.form as HTMLFormElement);
    await act(async () => {});
    expect(api.apiPost).toHaveBeenCalledTimes(1);
    // 취소는 지금처럼 요청 동안 꺼짐(닫을 수 없는 동안 — dismissible false와 같음).
    expect((dialog.getByRole("button", { name: "취소" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("틀린 비밀번호: 실패하면 포커스가 비운 비밀번호 입력칸으로 — 단추는 켜짐 조건(빈 비밀번호)으로 꺼짐", async () => {
    api.apiPost.mockRejectedValue(new Error(WRONG));
    const dialog = await openPromote();
    fireEvent.change(dialog.getByLabelText("운영자 비밀번호"), { target: { value: "wrong guess" } });
    const submit = dialog.getByRole("button", { name: "운영자로 올리기" }) as HTMLButtonElement;
    submit.focus();
    fireEvent.click(submit);

    expect(await dialog.findByText(WRONG)).toBeTruthy();
    const password = dialog.getByLabelText("운영자 비밀번호") as HTMLInputElement;
    expect(password.value).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(password));
    expect((dialog.getByRole("button", { name: "운영자로 올리기" }) as HTMLButtonElement).disabled).toBe(true);
    expect(password.readOnly).toBe(false);
    expect(password.getAttribute("aria-disabled")).toBeNull();
  });
});
