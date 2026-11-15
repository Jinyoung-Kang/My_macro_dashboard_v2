/**
 * 알림 화면의 안내 — 정보 검색 관심 대상의 새 글 알림(SEARCH_WATCH, 계약 §9-5)은 알림 규칙 없이 들어옵니다(QA-443). 응답은 모두 합성 값입니다.
 * 빈 알림함과 규칙 만들기(알림 종류 목록)에 그 알림이 어디서 오고 어떻게 켜고 끄는지 적습니다. 데모 열람은 관심 대상을 읽지 않아 이 안내를 넣지 않습니다.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
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

import AlertsPage from "../alerts/page";

const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "FREE" };

const READS: Record<string, unknown> = {
  "/api/alerts/inbox?limit=50": { items: [], unread: 0 },
  "/api/alerts/rules": { available: true, limit: 20, rules: [] },
  "/api/sec13f/institutions": { institutions: [] },
};

beforeEach(() => {
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in READS ? Promise.resolve(READS[path]) : new Promise(() => {})));
});
afterEach(cleanup);

function renderAs(user: SessionUser) {
  return render(
    <SessionUserProvider user={user}>
      <AlertsPage />
    </SessionUserProvider>,
  );
}

describe("알림 화면 — 관심 대상 새 글 알림의 안내(QA-443)", () => {
  // QA-443: 빈 알림함은 '아래에서 알림 규칙을 만드세요'만 적고 알림 종류 목록에도 관심 대상 알림이 없어, 정보 검색에서 '알림'을 켠 관심 대상의
  // 새 글 알림이 규칙 없이 들어온다는 것(어디서 켜고 끄는지)을 이 화면에서 알 수 없었습니다.
  // 수정 전 실패: 빈 알림함 글과 규칙 만들기 칸 어디에도 정보 검색 관심 대상 알림의 안내가 없음(재현 커밋에서는 it.fails).
  it.fails("빈 알림함과 규칙 만들기에 '정보 검색에서 관심 대상의 알림을 켜면 규칙 없이 들어옴'을 적는다", async () => {
    renderAs(MEMBER);
    const empty = await screen.findByText(/아직 알림이 없습니다/);
    expect(empty.textContent).toBe(
      "아직 알림이 없습니다. 아래에서 알림 규칙을 만들거나, 정보 검색에서 관심 대상의 ‘알림’을 켜면 그 대상의 새 글 알림이 규칙 없이 여기에 들어옵니다.",
    );

    const form = screen.getByRole("heading", { name: "규칙 만들기" }).closest("form") as HTMLElement;
    const note = within(form).getByText(/정보 검색 관심 대상의 새 글 알림은 규칙을 만들지 않습니다/);
    expect(note.textContent).toContain("관심 대상 목록이나 대상 머리에서 ‘알림’ 단추로 대상마다 켜고 끕니다");
    expect(note.textContent).toContain("15분마다 확인");
  });
});
