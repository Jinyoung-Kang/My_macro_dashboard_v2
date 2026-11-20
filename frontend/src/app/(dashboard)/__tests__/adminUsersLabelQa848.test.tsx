/**
 * QA-848 — 사용자 관리 표의 역할·등급 고르기가 칸마다 보이는 이름표 '{이메일} 역할'·'{이메일} 등급'을 그려 한 행에 이메일이 세 번 찍힘
 * (D1 QA `admin-users-select-label-repeats-email`, S4, 개편 전부터).
 *
 * 기대: 행에 보이는 이메일 글은 한 번(이메일 칸). 고르기의 이름은 보이지 않는 이름(aria-label '{이메일} 역할|등급')으로 — 낭독기는 그대로 '{이메일} 역할'.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import AdminUsersPage from "../admin/users/page";

const EMAIL = "m@test.local";

beforeEach(() => {
  const reads: Record<string, unknown> = {
    "/api/admin/users": { users: [{ id: 7, email: EMAIL, role: "MEMBER", tier: "FREE", verified: true, createdAt: "2026-10-01T00:00:00Z" }] },
    "/api/admin/audit?limit=100": { entries: [] },
  };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => cleanup());

describe("QA-848 사용자 관리 — 행에 보이는 이메일은 한 번", () => {
  it("역할·등급 고르기는 보이지 않는 이름('{이메일} 역할|등급') — 행의 보이는 글에 이메일 한 번", async () => {
    render(<AdminUsersPage />);
    const role = await screen.findByLabelText(`${EMAIL} 역할`);
    expect(role.tagName).toBe("SELECT");
    expect(screen.getByLabelText(`${EMAIL} 등급`).tagName).toBe("SELECT");
    const row = role.closest("tr") as HTMLTableRowElement;
    expect(row.textContent?.split(EMAIL).length).toBe(2);
  });
});
