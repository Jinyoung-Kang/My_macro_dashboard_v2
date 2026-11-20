/**
 * 알림 검사 칸 '읽음' 뒤의 포커스 — 넓은 화면 + '읽지 않음' 거르기(QA-881, 작업대 P7 합친 뒤 검토에서 찾음).
 *
 * 넓은 화면(1440)에서 '읽음 상태: 읽지 않음'을 고르고 첫 알림(저절로 고른 줄)의 검사 칸 '읽음'을 누르면, 다시 읽은 알림함에서 그 알림이 읽음이 되어
 * 목록에서 빠지고 옆 검사 칸이 다음 알림으로 바뀝니다. 검사 칸의 '읽음' 단추가 같은 자리에 같은 모양으로 다시 그려져 DOM 노드가 이어 쓰였고, 포커스는
 * 이제 다음 알림의 것이 된 '읽음'에 안내 없이 남았습니다 — Enter를 한 번 더 누르면 다음 알림이 뜻하지 않게 읽음 처리됩니다(POST {ids:[다음 id]}).
 * QA-866 고침은 포커스가 <body>일 때만 옮겨 이 경우를 다루지 않았습니다.
 *
 * 기대: 검사 칸 대상이 바뀌면 포커스는 쓰기 단추가 아니라 남은 다음 줄의 단추로(QA-866의 '그 알림이나 남은 다음 줄' 규칙과 같은 길). 쓰기(POST {ids:[id]})는
 * 누른 한 번뿐이고 켜짐 조건은 그대로입니다.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 'expected <button type="button" …(1)></button> not to be <button type="button" …(1)></button>'
 * (activeElement가 9002의 검사 칸 '읽음' — 9001에서 누른 그 DOM 노드).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const refresh = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => refresh }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/alerts" }));

import { SessionUserProvider } from "@/hooks/useSessionUser";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";
import type { SessionUser } from "@/lib/types";
import AlertsPage from "../alerts/page";

const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };

function item(id: number, title: string) {
  return { id, kind: "REGIME_CHANGE", occurredOn: "2026-11-18", title, body: "본문", late: false, createdAt: "2026-11-18T00:00:00Z", read: false };
}

/** 서버 쪽 읽음 상태 — POST {ids}가 오면 그 알림을 읽음으로 바꿔, 다음 알림함 읽기가 읽은 알림을 돌려줍니다. */
let readIds = new Set<number>();
const BASE = [item(9001, "첫째 알림"), item(9002, "둘째 알림"), item(9003, "셋째 알림")];

beforeEach(() => {
  readIds = new Set();
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path === "/api/alerts/inbox?limit=50") {
      const items = BASE.map((entry) => ({ ...entry, read: readIds.has(entry.id) }));
      return Promise.resolve({ items, unread: items.filter((entry) => !entry.read).length });
    }
    if (path === "/api/alerts/rules") return Promise.resolve({ available: true, limit: 20, rules: [] });
    if (path === "/api/sec13f/institutions") return Promise.resolve({ institutions: [] });
    return new Promise(() => {});
  });
  api.apiPost.mockImplementation((_path: string, body: { ids?: number[] }) => {
    for (const id of body.ids ?? []) readIds.add(id);
    return Promise.resolve({ changed: body.ids?.length ?? 0 });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubWide() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === WIDE_SHELL_MEDIA, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
}

async function settle() {
  for (let round = 0; round < 6; round += 1) await act(async () => {});
}

const rowButton = (key: string) => document.querySelector<HTMLButtonElement>(`[data-item-key="${key}"]`);

describe("알림 검사 칸 '읽음' 뒤의 포커스 — 넓은 화면 + '읽지 않음' 거르기(QA-881)", () => {
  it("읽은 알림이 거르기로 빠져 검사 칸이 다음 알림으로 바뀌면 포커스는 다음 줄 단추로 — 다음 알림의 '읽음'에 남지 않음", async () => {
    stubWide();
    render(<SessionUserProvider user={MEMBER}><AlertsPage /></SessionUserProvider>);
    await screen.findAllByText("첫째 알림");
    await settle();
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "읽음 상태" })).getByRole("radio", { name: "읽지 않음" }));
    await settle();
    // 첫 줄이 저절로 골라져 옆 검사 칸에 보입니다.
    const first = screen.getByRole("region", { name: /첫째 알림/ });
    const button = within(first).getByRole("button", { name: "읽음" });
    button.focus();
    fireEvent.click(button);
    await settle();
    await waitFor(() => expect(rowButton("9001")).toBeNull());
    const next = await screen.findByRole("region", { name: /둘째 알림/ });
    await settle();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(api.apiPost.mock.calls).toEqual([["/api/alerts/inbox/read", { ids: [9001] }]]);
    // 포커스가 다음 알림의 '읽음'(쓰기 단추)에 남으면 Enter 한 번이 9002를 읽음 처리합니다.
    expect(within(next).getByRole("button", { name: "읽음" })).not.toBe(document.activeElement);
    expect(document.activeElement).toBe(rowButton("9002"));
  });
});
