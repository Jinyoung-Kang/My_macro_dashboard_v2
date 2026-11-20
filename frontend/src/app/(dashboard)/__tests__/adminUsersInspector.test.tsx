/**
 * 사용자 관리(/admin/users) 조밀 표 + 속성 검사 칸(작업대 P7 — 실행 명세 §7 7행 '사용자 관리: 속성 목록').
 *
 * - 이메일이 검사를 여는 줄 단추(좁은 화면 대화상자). 검사 칸: 이메일·역할·등급·메일 인증·가입·사용자 번호(속성 목록) + 그 사용자의 최근 감사 기록(이미 읽은
 *   100건 안, 최근 다섯 줄) — 검사를 열어도 새 요청 0. 기록이 없으면 그 사실.
 * - 메일 인증은 아이콘 + 글(인증됨·대기). 감사 기록 표는 조밀 표·개수 줄, 동작은 고정폭.
 * - 회원 만들기 폼 이름표는 공용 고르기 상자와 같은 13px text-2, 입력칸 폭 상한 22rem(form-label-styles-mixed). 운영자로 올리기 대화상자의 '운영자 비밀번호'
 *   이름표도 같은 공용 FIELD_LABEL·FIELD_INPUT(P8 — 예전 12px text-3).
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

import { FIELD_INPUT, FIELD_LABEL } from "@/components/ui";
import AdminUsersPage from "../admin/users/page";

const USERS = [
  { id: 7, email: "m@test.local", role: "MEMBER", tier: "PRO", verified: true, createdAt: "2026-10-01T00:00:00Z" },
  { id: 8, email: "new@test.local", role: "MEMBER", tier: "FREE", verified: false, createdAt: "2026-11-01T00:00:00Z" },
];
const AUDIT = Array.from({ length: 7 }, (_, index) => ({
  at: `2026-11-1${index}T00:00:00Z`, userId: 7, action: `login_${index}`, detail: `합성 기록 ${index}`,
}));

beforeEach(() => {
  const reads: Record<string, unknown> = {
    "/api/admin/users": { users: USERS },
    "/api/admin/audit?limit=100": { entries: [...AUDIT, { at: "2026-11-18T00:00:00Z", userId: null, action: "signup_fail", detail: "합성" }] },
  };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => cleanup());

const value = (scope: HTMLElement, label: string) => within(scope).getByText(label, { selector: "dt" }).nextElementSibling?.textContent;

describe("사용자 관리 — 표와 검사 칸", () => {
  it("이메일을 누르면 검사 대화상자 — 속성·최근 감사 기록 다섯 줄, 새 요청 0", async () => {
    render(<AdminUsersPage />);
    const trigger = await screen.findByRole("button", { name: "m@test.local" });
    await act(async () => {});
    const before = api.apiGetShared.mock.calls.length;
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "m@test.local" });
    expect(value(dialog, "역할")).toBe("회원");
    expect(value(dialog, "등급")).toBe("유료");
    expect(value(dialog, "메일 인증")).toBe("인증됨");
    expect(value(dialog, "사용자 번호")).toBe("7");
    expect(within(dialog).getAllByText(/^login_\d$/)).toHaveLength(5);
    expect(api.apiGetShared.mock.calls.length).toBe(before);
  });

  it("감사 기록에 없는 사용자는 그 사실, 메일 인증 대기는 아이콘 + 글", async () => {
    render(<AdminUsersPage />);
    const table = await screen.findByRole("region", { name: "사용자 (좌우 스크롤)" });
    const pending = within(table).getByText("대기").closest("span.inline-flex") as HTMLElement;
    expect(pending.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(within(table).getByRole("button", { name: "new@test.local" }));
    const dialog = await screen.findByRole("dialog", { name: "new@test.local" });
    expect(within(dialog).getByText("최근 100건 안에 이 사용자의 기록이 없습니다.")).toBeTruthy();
  });

  it("감사 기록 표는 조밀 표·개수 줄·고정폭 동작, 회원 만들기 이름표·폭은 고르기 상자와 같음", async () => {
    render(<AdminUsersPage />);
    const audit = await screen.findByRole("region", { name: "감사 기록 (좌우 스크롤)" });
    expect(within(audit.closest("section") as HTMLElement).getByText("8건")).toBeTruthy();
    expect(within(audit).getByText("signup_fail").className).toContain("font-mono");
    const email = screen.getByLabelText("이메일");
    const tierLabel = screen.getByLabelText("등급").closest("label") as HTMLElement;
    for (const cls of ["text-[13px]", "text-text-2"]) {
      expect((email.closest("label") as HTMLElement).className, cls).toContain(cls);
      expect(tierLabel.className, cls).toContain(cls);
    }
    expect(email.className).toContain("sm:max-w-[22rem]");
  });

  it("운영자로 올리기 대화상자의 '운영자 비밀번호' 이름표·입력칸은 공용 폼 칸(FIELD_LABEL·FIELD_INPUT) — 12px text-3 아님", async () => {
    render(<AdminUsersPage />);
    fireEvent.change(await screen.findByLabelText("m@test.local 역할"), { target: { value: "OWNER" } });
    const dialog = await screen.findByRole("dialog", { name: "운영자로 올리기" });
    const input = within(dialog).getByLabelText("운영자 비밀번호");
    const label = input.closest("label") as HTMLElement;
    expect(label.className).toBe(FIELD_LABEL);
    expect(label.className).not.toContain("text-text-3");
    expect(input.className).toBe(FIELD_INPUT);
  });
});
