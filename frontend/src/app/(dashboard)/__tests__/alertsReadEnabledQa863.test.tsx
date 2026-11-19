/**
 * 알림 한 건 '읽음'의 켜짐 조건 — QA-863(작업대 P7 검토에서 찾음).
 *
 * 개편 전(0d016ca1) 알림함 줄의 '읽음'은 disabled 속성이 없는 단추였습니다 — 보이는 조건(읽지 않음·데모 아님)만 있고, 그 단추의 요청 중에도 '모두 읽음'
 * 요청 중에도 눌렀습니다(누를 때마다 같은 POST {ids:[id]}). P7(552d65ed)이 '읽음'을 검사 칸으로 옮기며 `disabled={readBusy}`(읽음 처리 요청 중)를
 * 새로 붙여, 쓰기의 켜짐 조건을 바이트 그대로 둔다는 규칙과 '같은 POST·켜짐 조건 — U8' 기록에 어긋났습니다. moreWritesKeep의 알림 사례는 본문만 봐서
 * 이 차이를 잡지 못했습니다.
 *
 * 기대(개편 전과 같음): POST가 끝나지 않은 동안에도 '읽음'은 켜져 있고, 한 번 더 누르면 같은 POST가 한 번 더 갑니다. '모두 읽음' 요청 중에도 켜져 있습니다.
 * 수정 전(재현 커밋에서는 it.fails): 첫 사례 'expected true to be false'(한 번 누른 뒤 disabled), 둘째 사례 'expected true to be false'('모두 읽음' 요청 중
 * disabled).
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

const ITEMS = [
  { id: 7, kind: "REGIME_CHANGE", occurredOn: "2026-11-18", title: "국면 바뀜", body: "본문", late: false, createdAt: "2026-11-18T00:00:00Z", read: false },
];

beforeEach(() => {
  const reads: Record<string, unknown> = {
    "/api/alerts/inbox?limit=50": { items: ITEMS, unread: 1 },
    "/api/alerts/rules": { available: true, limit: 20, rules: [] },
    "/api/sec13f/institutions": { institutions: [] },
  };
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
  // 읽음 처리 POST는 끝나지 않습니다 — 요청 중의 켜짐 조건을 봅니다.
  api.apiPost.mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === WIDE_SHELL_MEDIA, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openPanel(): Promise<HTMLElement> {
  render(<SessionUserProvider user={MEMBER}><AlertsPage /></SessionUserProvider>);
  await screen.findAllByText("국면 바뀜");
  await act(async () => {});
  return screen.getByRole("region", { name: /국면 바뀜/ });
}

describe("알림 한 건 '읽음'의 켜짐 조건(QA-863)", () => {
  it.fails("POST가 끝나지 않은 동안에도 켜져 있고, 한 번 더 누르면 같은 POST가 한 번 더 간다(개편 전과 같음)", async () => {
    const panel = await openPanel();
    fireEvent.click(within(panel).getByRole("button", { name: "읽음" }));
    await act(async () => {});
    const button = within(panel).getByRole("button", { name: "읽음" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await act(async () => {});
    expect(api.apiPost.mock.calls).toEqual([
      ["/api/alerts/inbox/read", { ids: [7] }],
      ["/api/alerts/inbox/read", { ids: [7] }],
    ]);
  });

  it.fails("'모두 읽음' 요청 중에도 켜져 있다", async () => {
    const panel = await openPanel();
    fireEvent.click(screen.getByRole("button", { name: "모두 읽음" }));
    await act(async () => {});
    expect(api.apiPost.mock.calls).toEqual([["/api/alerts/inbox/read", { all: true }]]);
    expect((within(panel).getByRole("button", { name: "읽음" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
