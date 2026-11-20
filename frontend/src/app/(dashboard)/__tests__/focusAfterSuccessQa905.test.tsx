/**
 * 성공 뒤 켜짐 조건으로 꺼지는 쓰기 단추의 포커스 — QA-905(QA-899 후속, 작업대 P8 키보드 경로).
 *
 * QA-899는 요청 동안 누른 단추를 aria-disabled(busy)로 두어 포커스를 지켰지만, 성공하면 화면이 입력·수를 비워 그 단추의 켜짐 조건(disabled)이 참이 됩니다 —
 * 내 계정 '비밀번호 바꾸기'(세 칸을 비움 → disabled={!current || !next || mismatch}), 사용자 관리 '회원 만들기'(비밀번호를 비움 → disabled={!email ||
 * !password}), 알림 '모두 읽음'(다시 읽은 읽지 않은 수 0 → disabled={demo || !inbox.data?.unread}). 포커스가 있던 단추가 진짜 disabled가 되어 크롬이
 * 포커스를 body로 보냈고, 다음 Tab은 문서 처음부터 시작했습니다.
 *
 * 기대: 성공 뒤 포커스가 body가 아니고 꺼진 단추도 아님 — 결과 글(비밀번호 변경·회원 만들기 — tabIndex -1 상자), 알림함 제목('모두 읽음' — 알림 목록
 * 머리). 경로·본문·확인 문구는 그대로(moreWritesKeep).
 * jsdom은 포커스가 있는 단추가 disabled가 되어도 포커스를 빼지 않으므로, 크롬의 포커스 바로잡기(포커스 가진 요소가 꺼지면 body로)를 MutationObserver로
 * 흉내 냅니다 — 그래서 '포커스가 body가 아님'이 실제 크롬과 같은 뜻이 됩니다.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 세 사례 모두 'expected <body><div>…(1)</div></body> not to be <body><div>…(1)</div></body>'(성공 뒤 포커스가 body).
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return {
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    apiDelete: vi.fn(),
    apiGetShared: vi.fn(),
    UnauthorizedError,
    auth: { changePassword: vi.fn(), logoutOthers: vi.fn(), deleteAccount: vi.fn(), logout: vi.fn() },
  };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/account" }));

import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { SessionUser } from "@/lib/types";
import AccountPage from "../account/page";
import AdminUsersPage from "../admin/users/page";
import AlertsPage from "../alerts/page";

const OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: false };
const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };

let reads: Record<string, unknown> = {};
const never = () => new Promise<never>(() => {});

/** 크롬의 포커스 바로잡기 흉내 — 포커스를 가진 요소에 disabled가 붙으면 포커스를 뺍니다(document.activeElement → body). */
let fixup: MutationObserver | null = null;

beforeEach(() => {
  reads = {};
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared, ...Object.values(api.auth)]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : never()));
  api.apiPost.mockImplementation(never);
  api.apiGet.mockImplementation(never);
  for (const fn of Object.values(api.auth)) fn.mockImplementation(never);
  fixup = new MutationObserver((records) => {
    for (const record of records) {
      const node = record.target as HTMLElement;
      if (node !== document.activeElement || !node.hasAttribute("disabled")) continue;
      // jsdom의 blur()는 포커스할 수 없는(꺼진) 요소에서 아무것도 하지 않으므로, 잠깐 둔 단추로 포커스를 옮긴 뒤 그 단추를 떼어 body로 보냅니다.
      const sink = document.createElement("button");
      document.body.appendChild(sink);
      sink.focus();
      sink.remove();
    }
  });
  fixup.observe(document.body, { attributes: true, attributeFilter: ["disabled"], subtree: true });
});
afterEach(() => {
  fixup?.disconnect();
  fixup = null;
  cleanup();
  vi.restoreAllMocks();
});

async function settled() {
  for (let round = 0; round < 8; round += 1) await act(async () => {});
}
const renderAs = (user: SessionUser, page: ReactElement) => render(<SessionUserProvider user={user}>{page}</SessionUserProvider>);

/** 키보드로 누른 것처럼 포커스를 둔 채 누르고 끝까지 기다린 뒤, 단추가 켜짐 조건으로 꺼졌고 포커스가 body가 아닌지(그리고 꺼진 단추도 아닌지) 봅니다. */
async function pressAndSettle(button: HTMLButtonElement): Promise<Element | null> {
  expect(button.disabled, "누르기 전 켜짐").toBe(false);
  button.focus();
  fireEvent.click(button);
  await settled();
  expect(button.disabled, "성공 뒤 켜짐 조건으로 꺼짐(이 결함의 조건)").toBe(true);
  const active = document.activeElement;
  expect(active).not.toBe(document.body);
  expect(active).not.toBe(button);
  return active;
}

describe("성공 뒤 꺼지는 쓰기 단추의 포커스(QA-905)", () => {
  it.fails("내 계정 '비밀번호 바꾸기' — 성공하면 포커스가 결과 글로", async () => {
    reads = {
      [endpoints.auth.session]: { authenticated: true, readMode: "auto", noLogin: false, user: MEMBER },
      [endpoints.auth.sessions]: { sessions: [] },
    };
    api.auth.changePassword.mockResolvedValue({ ok: true, message: "비밀번호를 바꿨습니다." });
    renderAs(MEMBER, <AccountPage />);
    await screen.findByText("비밀번호 변경");
    await settled();

    fireEvent.change(screen.getByLabelText("지금 비밀번호"), { target: { value: "old pass word" } });
    fireEvent.change(screen.getByLabelText("새 비밀번호"), { target: { value: "new pass word 1" } });
    fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: "new pass word 1" } });
    const active = await pressAndSettle(screen.getByRole("button", { name: "비밀번호 바꾸기" }) as HTMLButtonElement);

    expect(api.auth.changePassword.mock.calls).toEqual([["old pass word", "new pass word 1"]]);
    expect(active?.getAttribute("tabindex")).toBe("-1");
    expect(active?.textContent).toContain("비밀번호를 바꿨습니다.");
  });

  it.fails("사용자 관리 '회원 만들기' — 성공하면 포커스가 결과 글로", async () => {
    reads = {
      [endpoints.admin.users]: { users: [{ id: 7, email: "m@test.local", role: "MEMBER", tier: "FREE", verified: true, createdAt: "2026-10-01T00:00:00Z" }] },
      [endpoints.admin.audit(100)]: { entries: [] },
    };
    api.apiPost.mockResolvedValue({ ok: true, message: "회원을 만들었습니다." });
    renderAs(OWNER, <AdminUsersPage />);
    const panel = (await screen.findByRole("heading", { name: "회원 만들기" })).closest("section") as HTMLElement;
    fireEvent.change(within(panel).getByLabelText("이메일"), { target: { value: "new@test.local" } });
    fireEvent.change(within(panel).getByLabelText("처음 비밀번호(10자 이상)"), { target: { value: "Abcdefgh1234!" } });
    const active = await pressAndSettle(within(panel).getByRole("button", { name: "회원 만들기" }) as HTMLButtonElement);

    expect(api.apiPost.mock.calls).toEqual([[endpoints.admin.users, { email: "new@test.local", password: "Abcdefgh1234!", tier: "FREE" }]]);
    expect(active?.getAttribute("tabindex")).toBe("-1");
    expect(active?.textContent).toContain("회원을 만들었습니다.");
  });

  it.fails("알림 '모두 읽음' — 다시 읽어 읽지 않은 수가 0이면 포커스가 알림함 제목으로", async () => {
    const item = { id: 7, kind: "REGIME_CHANGE", occurredOn: "2026-11-18", title: "[국면 전환] 확장", body: "본문", late: false, createdAt: "2026-11-18" };
    reads = {
      [endpoints.alerts.inbox(50)]: { available: true, unread: 1, items: [{ ...item, read: false }] },
      [endpoints.alerts.rules]: { available: true, limit: 5, rules: [] },
      [endpoints.institution.institutions]: { institutions: [] },
    };
    api.apiPost.mockImplementation(async () => {
      reads[endpoints.alerts.inbox(50)] = { available: true, unread: 0, items: [{ ...item, read: true }] };
      return { changed: 1 };
    });
    renderAs(MEMBER, <AlertsPage />);
    await screen.findAllByText("[국면 전환] 확장");
    await settled();
    const active = await pressAndSettle(screen.getByRole("button", { name: "모두 읽음" }) as HTMLButtonElement);

    expect(api.apiPost.mock.calls).toEqual([[endpoints.alerts.read, { all: true }]]);
    expect(active).toBe(screen.getByRole("heading", { name: "알림함" }));
  });
});
