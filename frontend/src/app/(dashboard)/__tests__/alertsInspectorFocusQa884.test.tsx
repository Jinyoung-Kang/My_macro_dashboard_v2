/**
 * 알림 검사 칸 안의 포커스 — '읽음'을 누르지 않았는데 검사 칸 대상이 바뀌는 길(QA-884, 작업대 P7 합친 뒤 고침의 반박 확인에서 찾음).
 *
 * 넓은 화면(1440)에서 검사 칸 안(저절로 고른 첫 알림의 '읽음' 등)에 포커스를 둔 채, 자동 갱신(5분)이나 탭 복귀(visibilitychange)로 알림함을 다시 읽어
 * 검사 칸 대상이 바뀌면(새 알림이 맨 위에 와 autoSelectFirst가 그 알림을 고름 · 다른 곳에서 읽어 '읽지 않음' 거르기에서 빠짐) 검사 칸 내용이 새로
 * 그려져(QA-881의 key) 포커스가 <body>로 떨어졌습니다. 같은 알림이 다른 곳에서 읽음이 되어 '읽음' 단추만 사라질 때도 같습니다. QA-866 규칙은 이 화면에서
 * '읽음'을 누른 뒤(pendingRead)에만 움직였습니다. QA-881 전에는 같은 경우 포커스가 새 알림의 '읽음'에 안내 없이 남아 Enter 한 번이 그 알림을 읽음
 * 처리했으므로, 쓰기 안전은 그대로 두고 포커스를 잃는 길만 막습니다.
 *
 * 기대: 포커스가 검사 칸 안에 있다가 그 요소가 사라져 <body>로 떨어지면 지금 고른 줄 단추로(없으면 앞 대상의 줄, 그것도 없으면 '읽음 상태' 고른 줄).
 * 포커스가 검사 칸 밖에 있었거나 빈 곳을 눌러 검사 칸을 떠났으면 옮기지 않습니다. 쓰기는 없습니다(서버로 POST 0).
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 앞 세 사례 모두 activeElement가 BODY —
 * 'expected <body><div>…(1)</div></body> to be <button type="button" …(5)>…(2)</button>'.
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

/** 서버 쪽 알림함 — 다른 곳에서 들어온 새 알림(맨 위)과 다른 곳에서 읽은 알림을 시험이 바꿉니다. 이 화면의 쓰기는 없어야 합니다. */
let serverItems: ReturnType<typeof item>[] = [];
let readIds = new Set<number>();

beforeEach(() => {
  serverItems = [item(9001, "첫째 알림"), item(9002, "둘째 알림"), item(9003, "셋째 알림")];
  readIds = new Set();
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path === "/api/alerts/inbox?limit=50") {
      const items = serverItems.map((entry) => ({ ...entry, read: readIds.has(entry.id) }));
      return Promise.resolve({ items, unread: items.filter((entry) => !entry.read).length });
    }
    if (path === "/api/alerts/rules") return Promise.resolve({ available: true, limit: 20, rules: [] });
    if (path === "/api/sec13f/institutions") return Promise.resolve({ institutions: [] });
    return new Promise(() => {});
  });
  api.apiPost.mockImplementation(() => Promise.resolve({ changed: 0 }));
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

/** 탭 복귀 — useApi가 보이는 탭으로 돌아오면 알림함을 한 번 다시 읽습니다. */
async function returnToTab() {
  expect(document.visibilityState).toBe("visible");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await settle();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

const rowButton = (key: string) => document.querySelector<HTMLButtonElement>(`[data-item-key="${key}"]`);

async function openWide(unreadOnly: boolean) {
  stubWide();
  render(<SessionUserProvider user={MEMBER}><AlertsPage /></SessionUserProvider>);
  await screen.findAllByText("첫째 알림");
  await settle();
  if (unreadOnly) {
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "읽음 상태" })).getByRole("radio", { name: "읽지 않음" }));
    await settle();
  }
  // 첫 줄이 저절로 골라져 옆 검사 칸에 보입니다 — 그 '읽음'에 포커스(누르지 않음).
  const first = screen.getByRole("region", { name: /첫째 알림/ });
  const button = within(first).getByRole("button", { name: "읽음" });
  act(() => button.focus());
  expect(document.activeElement).toBe(button);
  return button;
}

describe("알림 검사 칸 안의 포커스 — 누르지 않았는데 대상이 바뀜(QA-884)", () => {
  it.fails("새 알림이 맨 위에 와 저절로 고른 줄이 바뀌면 포커스는 지금 고른 줄(새 알림) 단추로 — <body>가 아님", async () => {
    await openWide(false);
    serverItems = [item(9000, "새 알림 영"), ...serverItems];
    await returnToTab();
    await screen.findByRole("region", { name: /새 알림 영/ });
    await waitFor(() => expect(rowButton("9000")).not.toBeNull());
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(rowButton("9000"));
  });

  it.fails("'읽지 않음' 거르기에서 다른 곳에서 읽은 알림이 빠지면 포커스는 지금 고른 줄(다음 알림) 단추로", async () => {
    await openWide(true);
    readIds.add(9001);
    await returnToTab();
    await waitFor(() => expect(rowButton("9001")).toBeNull());
    await screen.findByRole("region", { name: /둘째 알림/ });
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(rowButton("9002"));
  });

  it.fails("거르기 없이 같은 알림이 다른 곳에서 읽음이 되어 '읽음'만 사라지면 포커스는 그 알림의 줄 단추로", async () => {
    await openWide(false);
    readIds.add(9001);
    await returnToTab();
    const panel = screen.getByRole("region", { name: /첫째 알림/ });
    await waitFor(() => expect(within(panel).queryByRole("button", { name: "읽음" })).toBeNull());
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(rowButton("9001"));
  });

  it("빈 곳을 눌러 검사 칸을 떠난 뒤에 대상이 바뀌면 포커스를 옮기지 않음", async () => {
    const button = await openWide(false);
    act(() => button.blur());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    serverItems = [item(9000, "새 알림 영"), ...serverItems];
    await returnToTab();
    await screen.findByRole("region", { name: /새 알림 영/ });
    expect(document.activeElement).toBe(document.body);
  });

  it("포커스가 검사 칸 밖('읽음 상태' 거르기)에 있으면 대상이 바뀌어도 그대로", async () => {
    await openWide(false);
    const radio = within(screen.getByRole("radiogroup", { name: "읽음 상태" })).getByRole("radio", { name: "전체" });
    act(() => radio.focus());
    serverItems = [item(9000, "새 알림 영"), ...serverItems];
    await returnToTab();
    await screen.findByRole("region", { name: /새 알림 영/ });
    expect(document.activeElement).toBe(radio);
  });
});
