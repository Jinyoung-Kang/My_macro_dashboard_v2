/**
 * 사용자 검사 칸의 감사 기록 '읽는 중' — QA-874(작업대 P7 검토에서 찾음).
 *
 * 사용자 관리의 검사 칸(UserDetail)은 이미 읽은 감사 기록 100건에서 그 사용자의 줄을 고르는데, 화면이 `audit.data?.entries ?? null`을 넘겨 읽는 중과 실패가
 * 모두 null이었습니다. 사용자 목록이 먼저 오고 감사 기록이 아직 오지 않은 사이 검사 칸을 열면 '감사 기록을 받지 못했습니다.' — 읽는 중을 실패로 알렸습니다
 * (수급 레이더 검사 칸은 둘을 가름).
 *
 * 기대: 읽는 중이면 '감사 기록을 불러오는 중입니다.', 실패(오류)면 '감사 기록을 받지 못했습니다.'. 검사를 열어도 새 요청은 없습니다.
 * 수정 전(재현 커밋에서는 it.fails): 첫 사례 'Unable to find an element with the text: 감사 기록을 불러오는 중입니다.'(보이는 글은 '받지 못했습니다'). 둘째 사례(실패)는 고치기 전에도 통과하는 고정 사례.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import AdminUsersPage from "../admin/users/page";

const USERS = [{ id: 7, email: "m@test.local", role: "MEMBER", tier: "PRO", verified: true, createdAt: "2026-10-01T00:00:00Z" }];

let audit: () => Promise<unknown>;
beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path === "/api/admin/users") return Promise.resolve({ users: USERS });
    if (path === "/api/admin/audit?limit=100") return audit();
    return new Promise(() => {});
  });
});
afterEach(() => cleanup());

async function openUser(): Promise<HTMLElement> {
  render(<AdminUsersPage />);
  const trigger = await screen.findByRole("button", { name: "m@test.local" });
  for (let round = 0; round < 3; round += 1) await act(async () => {});
  const before = api.apiGetShared.mock.calls.length;
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "m@test.local" });
  expect(api.apiGetShared.mock.calls.length).toBe(before);
  return dialog;
}

describe("사용자 검사 칸 — 감사 기록 읽는 중과 실패(QA-874)", () => {
  it.fails("감사 기록을 읽는 중이면 '불러오는 중' — '받지 못했습니다'가 아님", async () => {
    audit = () => new Promise(() => {});
    const dialog = await openUser();
    expect(within(dialog).getByText("감사 기록을 불러오는 중입니다.")).toBeTruthy();
    expect(within(dialog).queryByText("감사 기록을 받지 못했습니다.")).toBeNull();
  });

  it("감사 기록 읽기에 실패하면 '받지 못했습니다'", async () => {
    audit = () => Promise.reject(new Error("합성 실패"));
    const dialog = await openUser();
    expect(within(dialog).getByText("감사 기록을 받지 못했습니다.")).toBeTruthy();
  });
});
