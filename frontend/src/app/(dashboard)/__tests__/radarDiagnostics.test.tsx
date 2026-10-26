/**
 * 수급 레이더의 '데이터 소스 연결 테스트'(QA-098).
 *
 * 진단 경로(GET /api/radar/diagnostics)는 운영자 전용입니다(ADR 0010). 일반 회원·데모 방문자가 눌러 봐야 403만 받는
 * 버튼은 처음부터 보이지 않게 합니다(lib/access.ts, 셸의 수동 새로고침과 같은 규칙). 운영자가 열었을 때 진단이
 * 실패하면 빈 카드가 아니라 오류를 그립니다.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import RadarPage from "../radar/page";

const OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO" };
const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };
const DEMO: SessionUser = { email: null, role: "MEMBER", tier: "PRO", demo: true };
const TOGGLE = "데이터 소스 연결 테스트";

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path === "/api/radar/diagnostics"
      ? Promise.reject(new Error("운영자만 쓸 수 있는 기능입니다."))
      : new Promise(() => {}));
});
afterEach(() => cleanup());

describe("QA-098 레이더 데이터 소스 연결 테스트는 운영자에게만", () => {
  // 수정 전에는 역할을 보지 않고 버튼을 그려, 회원·데모 방문자가 누르면 403을 받고 빈 카드만 보였다.
  it.each([
    ["일반 회원", MEMBER],
    ["데모 방문자", DEMO],
    ["사용자를 아직 모름", undefined],
  ])("%s: 버튼이 없다", (_name, user) => {
    render(<SessionUserProvider user={user}><RadarPage /></SessionUserProvider>);

    expect(screen.queryByRole("button", { name: TOGGLE })).toBeNull();
  });

  // 수정 전에는 진단 패널이 오류를 받지 않아 제목과 '다시 검사' 버튼만 남은 빈 카드였다.
  it("운영자가 연 진단이 실패하면 오류 문구와 다시 시도를 보인다", async () => {
    render(<SessionUserProvider user={OWNER}><RadarPage /></SessionUserProvider>);

    fireEvent.click(screen.getByRole("button", { name: TOGGLE }));

    expect(await screen.findByText("운영자만 쓸 수 있는 기능입니다.", {}, { timeout: 500 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
  });
});
