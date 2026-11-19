/**
 * 알림함의 관심 대상 새 글 알림(정보 검색 단계 6 묶음 2 — 계약 §9-5). 응답은 모두 합성 값입니다.
 *  - 종류 SEARCH_WATCH 줄은 payload.href(그 대상의 타임라인 — 정보 검색 화면 안쪽 경로만)로 가는 링크가 있습니다
 *  - 주소가 없거나 정보 검색 화면이 아니면(바깥 주소·다른 화면) 링크가 없습니다
 *  - 다른 종류의 알림은 지금과 같습니다(payload가 있어도 링크가 아님)
 *  - 홈의 알림 요약도 같은 규칙(홈은 제목이 링크)
 *
 * 작업대 P7: 알림 화면의 알림함이 시각순 목록 + 검사 칸이 되어(줄 전체가 검사를 여는 단추 — 단추 안에 링크를 둘 수 없음), 링크는 그 알림의 검사 칸
 * '정보 검색에서 보기'로 옮겼습니다(같은 주소 규칙). 좁은 화면(jsdom)에서는 줄을 누르면 검사 대화상자가 열립니다.
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
import AlertsPage from "../alerts/page";

const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "FREE" };

function inboxItem(over: Record<string, unknown>) {
  return { id: 1, kind: "REGIME_CHANGE", occurredOn: "2026-11-15", title: "제목", body: "본문", late: false, createdAt: "2026-11-15T00:00:00Z", read: false, ...over };
}

const ITEMS = [
  inboxItem({
    id: 11, kind: "SEARCH_WATCH", title: "관심 대상 '합성 회사' 새 글 3건", body: "합성 제목 하나\n합성 제목 둘\n합성 제목 셋",
    payload: { href: "/search?e=us:SYNT&tab=timeline" },
  }),
  inboxItem({ id: 12, kind: "SEARCH_WATCH", title: "관심 대상 '바깥 주소' 새 글 1건", payload: { href: "https://evil.example/search" } }),
  inboxItem({ id: 13, kind: "SEARCH_WATCH", title: "관심 대상 '주소 없음' 새 글 1건" }),
  inboxItem({ id: 14, kind: "REGIME_CHANGE", title: "국면 바뀜", payload: { href: "/search?e=us:SYNT" } }),
];

let reads: Record<string, unknown>;

beforeEach(() => {
  reads = {
    "/api/alerts/inbox?limit=50": { items: ITEMS, unread: 4 },
    "/api/alerts/inbox?limit=3": { items: ITEMS.slice(0, 3), unread: 4 },
    "/api/alerts/unread-count": { unread: 4 },
    "/api/alerts/rules": { available: true, limit: 20, rules: [] },
    "/api/sec13f/institutions": { institutions: [] },
  };
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => cleanup());

function renderAs(node: React.ReactNode) {
  return render(<SessionUserProvider user={MEMBER}>{node}</SessionUserProvider>);
}

/** 알림함의 한 줄을 골라 검사 대화상자(좁은 화면)를 엽니다 — 대화상자 이름은 알림 제목. */
async function openInbox(title: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByText(title));
  return screen.findByRole("dialog", { name: title });
}

describe("알림 화면 — 관심 대상 새 글 알림", () => {
  it("SEARCH_WATCH 알림에는 그 대상의 정보 검색 주소로 가는 링크", async () => {
    renderAs(<AlertsPage />);
    const dialog = await openInbox("관심 대상 '합성 회사' 새 글 3건");
    const link = within(dialog).getByRole("link", { name: "정보 검색에서 보기" });
    expect(link.getAttribute("href")).toBe("/search?e=us:SYNT&tab=timeline");
    // 본문(최근 제목 셋)은 그대로 글
    expect(within(dialog).getByText(/합성 제목 하나/)).toBeTruthy();
  });

  it("주소가 바깥이거나 없으면 링크가 아님, 다른 종류의 알림은 payload가 있어도 지금처럼 글", async () => {
    renderAs(<AlertsPage />);
    await screen.findByText("관심 대상 '합성 회사' 새 글 3건");
    // 목록에는 링크가 없습니다(줄 전체가 검사를 여는 단추).
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    for (const title of ["관심 대상 '바깥 주소' 새 글 1건", "관심 대상 '주소 없음' 새 글 1건", "국면 바뀜"]) {
      const dialog = await openInbox(title);
      expect(within(dialog).queryByRole("link"), title).toBeNull();
      fireEvent.keyDown(dialog, { key: "Escape" });
      await screen.findByText(title);
    }
  });
});

describe("홈의 알림 요약 — 관심 대상 새 글 알림", () => {
  it("SEARCH_WATCH 줄의 제목만 링크, 나머지 줄은 지금처럼 글", async () => {
    renderAs(<AlertsSummary />);
    const list = await screen.findByRole("list");
    const link = within(list).getByRole("link", { name: "관심 대상 '합성 회사' 새 글 3건" });
    expect(link.getAttribute("href")).toBe("/search?e=us:SYNT&tab=timeline");
    expect(within(list).getAllByRole("link")).toHaveLength(1);
    expect(within(list).getByText("관심 대상 '바깥 주소' 새 글 1건")).toBeTruthy();
  });
});
