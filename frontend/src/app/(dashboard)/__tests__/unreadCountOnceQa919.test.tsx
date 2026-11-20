/**
 * 운영자 홈(/) 첫 적재에서 `/api/alerts/unread-count`가 한 번만 나간다(QA-919).
 *
 * 셸 레이아웃(알림 벨·탭 제목)과 홈의 알림 구역이 같은 경로를 읽습니다. 요청 합치기(lib/sharedRequest)는 **진행 중인** 요청만 묶는데, 셸이 세션 확인과 함께
 * 읽지 않은 수를 먼저 요청하고 홈은 세션 확인이 끝나야 그려지므로, 읽지 않은 수 응답이 세션 응답보다 먼저 끝나면 홈이 같은 경로를 다시 요청했습니다
 * (2026-10-26부터 — 진행 기록 §P4 '다음 단계로 넘긴 것').
 *
 * 공용 요청 함수(lib/api — 진짜 apiGetShared·요청 합치기)를 그대로 두고 fetch만 바꿔, 셸 + 홈을 그린 뒤 나간 fetch를 경로별로 셉니다. 응답은 모두 바로
 * 끝납니다(세션 확인보다 읽지 않은 수가 먼저 끝날 수 있는 순서 — 실제 브라우저에서 본 순서).
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 'expected 2 to be 1'.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionResponse } from "@/lib/types";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/" }));

import DashboardLayout from "../layout";
import HomePage from "../page";

const SESSION = "/api/auth/session";
const UNREAD = "/api/alerts/unread-count";

const LOCAL_OWNER: SessionResponse = {
  authenticated: true,
  readMode: "auto",
  noLogin: true,
  user: { email: "owner@test.local", role: "OWNER", tier: "PRO", local: true },
};

/**
 * 경로(쿼리 포함) → 응답 본문. 없는 경로는 바로 404로 답합니다(그 구역은 오류 상자 — 이 시험은 요청 수만 봄). 끝나지 않는 요청으로 두면 요청 합치기의
 * 진행 중 목록(모듈 상태)에 남아 다음 사례의 같은 경로가 fetch 없이 그 요청을 함께 씁니다.
 */
const BODIES: Record<string, unknown> = {
  [SESSION]: LOCAL_OWNER,
  [UNREAD]: { unread: 2 },
};

let fetchMock: ReturnType<typeof vi.fn>;

function pathOf(input: unknown): string {
  const url = new URL(String(input), "http://localhost");
  return `${url.pathname}${url.search}`;
}

function calls(path: string): number {
  return fetchMock.mock.calls.filter(([input]) => pathOf(input) === path).length;
}

function reply(path: string): Response {
  const known = path in BODIES;
  return new Response(JSON.stringify(known ? BODIES[path] : { message: "없음" }), {
    status: known ? 200 : 404,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock = vi.fn((input: unknown) => Promise.resolve(reply(pathOf(input))));
  vi.stubGlobal("fetch", fetchMock);
  router.replace.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("운영자 홈 첫 적재의 읽지 않은 알림 수 요청(QA-919)", () => {
  it.fails("셸과 홈이 같은 경로를 읽어도 /api/alerts/unread-count는 한 번만 나간다", async () => {
    render(
      <DashboardLayout>
        <HomePage />
      </DashboardLayout>,
    );
    // 홈이 그려지고(세션 확인 뒤) 홈의 첫 요청들이 나간 뒤에 셉니다.
    await screen.findByRole("heading", { name: "홈", level: 1 });
    await waitFor(() => expect(calls("/api/alerts/inbox?limit=3")).toBe(1));
    // 탭 제목에 읽지 않은 수가 붙음 — 셸이 값을 받았음.
    await waitFor(() => expect(document.title.startsWith("(2)")).toBe(true));
    expect(calls(SESSION)).toBe(1);
    expect(calls(UNREAD)).toBe(1);
  });

  it("세션 응답이 먼저 끝나 읽지 않은 수가 아직 진행 중이어도 한 번만 나간다(다른 순서)", async () => {
    let answer!: () => void;
    fetchMock.mockImplementation((input: unknown) => {
      const path = pathOf(input);
      return path === UNREAD
        ? new Promise<Response>((resolve) => (answer = () => resolve(reply(path))))
        : Promise.resolve(reply(path));
    });
    render(
      <DashboardLayout>
        <HomePage />
      </DashboardLayout>,
    );
    await screen.findByRole("heading", { name: "홈", level: 1 });
    await waitFor(() => expect(calls("/api/alerts/inbox?limit=3")).toBe(1));
    answer();
    await waitFor(() => expect(document.title.startsWith("(2)")).toBe(true));
    expect(calls(UNREAD)).toBe(1);
  });
});
