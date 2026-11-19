/**
 * 알림 검사 칸 '읽음' 뒤의 포커스 — QA-866(작업대 P7 검토에서 찾음).
 *
 * P7(U8)이 '읽음'을 줄 안에서 검사 칸으로 옮겼는데, 누른 뒤 알림함을 다시 읽어 그 알림이 읽음이 되면 단추가 사라지고(읽지 않은 알림에만 그림) 포커스를
 * 옮기지 않아 <body>로 떨어졌습니다. 넓은 화면 옆 검사 칸, 그리고 좁은 화면에서 '읽음 상태: 읽지 않음' 거르기를 켠 채 대화상자에서 누른 경우(그 알림이
 * 목록에서 빠져 대화상자가 닫히고 되돌아갈 줄 단추도 사라짐) 둘 다입니다. 좁은 화면·거르기 없음은 대화상자가 그대로라 포커스가 대화상자 안에 남습니다.
 *
 * 기대: 넓은 화면은 그 알림의 줄 단추로(목록에서 j/k를 이어 감), 거르기로 줄이 빠지면 다음 줄 단추(없으면 앞 줄)로 — 대화상자는 닫히며 남은 줄로 돌아감.
 * 쓰기(POST {ids:[id]})·켜짐 조건은 그대로입니다.
 * 수정 전(재현 커밋에서는 it.fails): 첫 사례 'expected <body><div>…(1)</div></body> to be <button type="button" …(5)>…(2)</button>'(넓은 화면 —
 * activeElement BODY), 둘째 사례 'expected <body style><div>…(1)</div></body> to be <button type="button" …(5)>…(1)</button>'(좁은 화면 + 거르기 — 대화상자
 * 닫힘, activeElement BODY).
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
const BASE = [item(1, "첫째 알림"), item(3, "셋째 알림")];

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

function stubWide(wide: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: wide && query === WIDE_SHELL_MEDIA, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
}

async function settle() {
  for (let round = 0; round < 6; round += 1) await act(async () => {});
}

const rowButton = (key: string) => document.querySelector<HTMLButtonElement>(`[data-item-key="${key}"]`);

describe("알림 검사 칸 '읽음' 뒤의 포커스(QA-866)", () => {
  it.fails("넓은 화면: 단추가 사라지면 그 알림의 줄 단추로 — <body>가 아님", async () => {
    stubWide(true);
    render(<SessionUserProvider user={MEMBER}><AlertsPage /></SessionUserProvider>);
    await screen.findAllByText("첫째 알림");
    await settle();
    const panel = screen.getByRole("region", { name: /첫째 알림/ });
    const button = within(panel).getByRole("button", { name: "읽음" });
    button.focus();
    fireEvent.click(button);
    await settle();
    await waitFor(() => expect(within(panel).queryByRole("button", { name: "읽음" })).toBeNull());
    await settle();
    expect(api.apiPost.mock.calls).toEqual([["/api/alerts/inbox/read", { ids: [1] }]]);
    expect(document.activeElement).toBe(rowButton("1"));
  });

  it.fails("좁은 화면 + '읽지 않음' 거르기: 대화상자가 닫히면 남은 다음 줄 단추로 — <body>가 아님", async () => {
    stubWide(false);
    render(<SessionUserProvider user={MEMBER}><AlertsPage /></SessionUserProvider>);
    await screen.findAllByText("첫째 알림");
    await settle();
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "읽음 상태" })).getByRole("radio", { name: "읽지 않음" }));
    const opener = rowButton("1") as HTMLButtonElement;
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "첫째 알림" });
    const button = within(dialog).getByRole("button", { name: "읽음" });
    button.focus();
    fireEvent.click(button);
    await settle();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await settle();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(rowButton("1")).toBeNull();
    expect(document.activeElement).toBe(rowButton("3"));
  });
});
