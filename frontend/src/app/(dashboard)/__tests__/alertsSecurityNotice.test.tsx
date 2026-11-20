/**
 * 알림함의 보안 공지 해당 알림(SECURITY_NOTICE — ADR 0046 결정 7, 운영자·규칙 없음). 응답은 모두 가짜 값입니다.
 *  - 종류 태그 '보안 공지'
 *  - 검사 칸의 '보안 공지에서 보기'는 payload.href(`/security?ntt=<번호>` — 보안 공지 화면 안쪽 주소만)
 *  - 주소가 바깥·다른 꼴이면 링크가 없음
 *  - 홈의 알림 요약도 같은 규칙(제목이 링크)
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const refresh = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => refresh }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/alerts" }));

import { AlertsSummary } from "@/components/screens/home/AlertsSummary";
import { alertKindTag } from "@/lib/alerts";
import AlertsPage from "../alerts/page";

const OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: false };

function inboxItem(over: Record<string, unknown>) {
  return { id: 1, kind: "REGIME_CHANGE", occurredOn: "2026-11-21", title: "제목", body: "본문", late: false, createdAt: "2026-11-21T00:00:00Z", read: false, ...over };
}

const ITEMS = [
  inboxItem({ id: 21, kind: "SECURITY_NOTICE", title: "보안 공지 해당 — 가짜DB", body: "CVE 1건 · 화면: 보안 공지", payload: { href: "/security?ntt=900001" } }),
  inboxItem({ id: 22, kind: "SECURITY_NOTICE", title: "보안 공지 해당 — 바깥 주소", payload: { href: "https://evil.example/security?ntt=1" } }),
  inboxItem({ id: 23, kind: "SECURITY_NOTICE", title: "보안 공지 해당 — 주소 없음" }),
];

beforeEach(() => {
  const reads: Record<string, unknown> = {
    "/api/alerts/inbox?limit=50": { items: ITEMS, unread: 3 },
    "/api/alerts/inbox?limit=3": { items: ITEMS, unread: 3 },
    "/api/alerts/unread-count": { unread: 3 },
    "/api/alerts/rules": { available: true, limit: 20, rules: [] },
    "/api/sec13f/institutions": { institutions: [] },
  };
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => cleanup());

const renderAs = (node: React.ReactNode) => render(<SessionUserProvider user={OWNER}>{node}</SessionUserProvider>);

async function openInbox(title: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByText(title));
  return screen.findByRole("dialog", { name: title });
}

describe("알림 화면 — 보안 공지 알림", () => {
  it("종류 태그는 '보안 공지'", () => {
    expect(alertKindTag("SECURITY_NOTICE")).toBe("보안 공지");
  });

  it("검사 칸의 '보안 공지에서 보기'가 그 공지의 검사 칸을 여는 주소(/security?ntt=<번호>)로 간다", async () => {
    renderAs(<AlertsPage />);
    const dialog = await openInbox("보안 공지 해당 — 가짜DB");
    const link = within(dialog).getByRole("link", { name: "보안 공지에서 보기" });
    expect(link.getAttribute("href")).toBe("/security?ntt=900001");
    expect(within(dialog).queryByRole("link", { name: "정보 검색에서 보기" })).toBeNull();
  });

  it("주소가 바깥이거나 없으면 링크가 없다", async () => {
    renderAs(<AlertsPage />);
    for (const title of ["보안 공지 해당 — 바깥 주소", "보안 공지 해당 — 주소 없음"]) {
      const dialog = await openInbox(title);
      expect(within(dialog).queryByRole("link"), title).toBeNull();
      fireEvent.keyDown(dialog, { key: "Escape" });
      await screen.findByText(title);
    }
  });
});

describe("홈의 알림 요약 — 보안 공지 알림", () => {
  it("보안 공지 화면 주소인 줄의 제목만 링크", async () => {
    renderAs(<AlertsSummary />);
    const list = await screen.findByRole("list");
    const link = within(list).getByRole("link", { name: "보안 공지 해당 — 가짜DB" });
    expect(link.getAttribute("href")).toBe("/security?ntt=900001");
    expect(within(list).getAllByRole("link")).toHaveLength(1);
  });
});
