/**
 * 대시보드 레이아웃의 세션 처리 — 로그인 모드와 로그인 없는 로컬 실행(ADR 0016).
 *
 * 로그인 모드(noLogin이 없거나 false — AWS 웹 데모·QA 스택·이전 백엔드)는 지금처럼 세션이 없거나 화면 요청이
 * 401이면 로그인 화면으로 보낸다. noLogin이 true면 로그인 화면으로 보내지 않는다. 운영자 계정이 없으면
 * 안내를 보이고 5초마다 다시 확인하며, localhost가 아니라 운영자로 풀리지 않은 요청만 로그인으로 보낸다.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApi } from "@/hooks/useApi";
import type { SessionResponse } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return {
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    apiGetShared: vi.fn(),
    apiBase: () => "",
    UnauthorizedError,
    auth: { logout: vi.fn() },
  };
});
vi.mock("@/lib/api", () => api);

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/macro" }));

import DashboardLayout from "../layout";

const SESSION = "/api/auth/session";
const UNREAD = "/api/alerts/unread-count";
/** 화면(자식)이 읽는 경로 — 401 시험에 씁니다. */
const PAGE = "/api/test/page";

const OWNER = { email: "owner@test.local", role: "OWNER", tier: "PRO" } as const;

const LOGIN_NONE: SessionResponse = { authenticated: false, mailAvailable: false, noLogin: false };
const LOGIN_OWNER: SessionResponse = { authenticated: true, readMode: "auto", noLogin: false, user: { ...OWNER, local: false } };
const LOCAL_OWNER: SessionResponse = { authenticated: true, readMode: "auto", noLogin: true, user: { ...OWNER, local: true } };
const OWNER_MISSING: SessionResponse = { authenticated: false, mailAvailable: false, noLogin: true, ownerMissing: true };
const NOT_LOCAL: SessionResponse = { authenticated: false, mailAvailable: false, noLogin: true, ownerMissing: false };

/** 경로별 응답. 함수면 부를 때마다 계산합니다(세션 응답을 바꾸는 시험). 없는 경로는 끝나지 않습니다. */
let reads: Record<string, unknown>;

function serve(path: string): Promise<unknown> {
  if (!(path in reads)) return new Promise(() => {});
  const value = reads[path];
  const resolved = typeof value === "function" ? (value as () => unknown)() : value;
  return resolved instanceof Error ? Promise.reject(resolved) : Promise.resolve(resolved);
}

function sessionCalls(): number {
  return api.apiGetShared.mock.calls.filter(([path]) => path === SESSION).length;
}

/** 화면 하나 — 자기 데이터를 읽는 대시보드 화면처럼 useApi를 씁니다. */
function Page() {
  useApi(PAGE);
  return <p>대시보드 본문</p>;
}

function renderLayout() {
  return render(
    <DashboardLayout>
      <Page />
    </DashboardLayout>,
  );
}

beforeEach(() => {
  reads = { [UNREAD]: { unread: 0 }, [PAGE]: { ok: true } };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => serve(path));
  router.replace.mockReset();
  router.push.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("로그인 모드(noLogin 없음·false) — 지금과 같다", () => {
  it("세션이 없으면(authenticated:false) 로그인 화면으로 보낸다", async () => {
    reads[SESSION] = LOGIN_NONE;
    renderLayout();

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByText("대시보드 본문")).toBeNull();
  });

  it("noLogin을 보내지 않는 이전 백엔드도 로그인 화면으로 보낸다", async () => {
    reads[SESSION] = { authenticated: false, mailAvailable: false };
    renderLayout();

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });

  it("로그인한 뒤 화면 요청이 401이면 로그인 화면으로 보낸다", async () => {
    reads[SESSION] = LOGIN_OWNER;
    reads[PAGE] = new api.UnauthorizedError("로그인이 필요합니다");
    renderLayout();

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });

  it("로그인돼 있으면 화면을 그리고 셸 계정 영역에 로그아웃을 보인다", async () => {
    reads[SESSION] = LOGIN_OWNER;
    renderLayout();

    expect(await screen.findByText("대시보드 본문")).toBeTruthy();
    expect(screen.getByRole("button", { name: "로그아웃" })).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("로그인 없는 로컬 실행(noLogin: true)", () => {
  it("로컬 운영자로 풀렸으면 로그인 화면 없이 화면을 그리고, 셸 계정 영역에 로그아웃 대신 '로컬 · 로그인 없음'", async () => {
    reads[SESSION] = LOCAL_OWNER;
    renderLayout();

    expect(await screen.findByText("대시보드 본문")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "로그아웃" })).toBeNull();
    expect(document.querySelector('a[href="/account"]')?.textContent).toContain("로컬 · 로그인 없음");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("화면 요청이 401이어도 로그인으로 보내지 않고 세션을 한 번 다시 확인한다", async () => {
    reads[SESSION] = LOCAL_OWNER;
    reads[PAGE] = new api.UnauthorizedError("로그인이 필요합니다");
    renderLayout();

    expect(await screen.findByText("대시보드 본문")).toBeTruthy();
    await waitFor(() => expect(sessionCalls()).toBe(2));
    await act(async () => {});
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByText("대시보드 본문")).toBeTruthy();
  });

  it("401 뒤 다시 확인해 보니 백엔드가 로그인 모드로 바뀌었으면 지금처럼 로그인 화면으로 보낸다", async () => {
    let calls = 0;
    reads[SESSION] = () => (++calls === 1 ? LOCAL_OWNER : LOGIN_NONE);
    reads[PAGE] = new api.UnauthorizedError("로그인이 필요합니다");
    renderLayout();

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
    expect(sessionCalls()).toBe(2);
  });

  it("운영자 계정이 없으면 만드는 방법을 안내하고 로그인으로 보내지 않으며, 5초마다 다시 확인해 계정이 생기면 화면을 연다", async () => {
    vi.useFakeTimers();
    let ownerCreated = false;
    reads[SESSION] = () => (ownerCreated ? LOCAL_OWNER : OWNER_MISSING);
    renderLayout();
    await act(async () => {});

    expect(screen.getByText("⚠️ 운영자 계정이 아직 없습니다")).toBeTruthy();
    expect(screen.getByText(/\.env에 OWNER_EMAIL·APP_PASSWORD를 넣고 make up 하세요/)).toBeTruthy();
    expect(screen.getByText(/make logs S=backend/)).toBeTruthy();
    expect(screen.queryByText("세션을 확인하는 중…")).toBeNull();
    expect(sessionCalls()).toBe(1);

    await act(async () => vi.advanceTimersByTime(4_999));
    expect(sessionCalls()).toBe(1);
    await act(async () => vi.advanceTimersByTime(1));
    expect(sessionCalls()).toBe(2);
    expect(screen.getByText("⚠️ 운영자 계정이 아직 없습니다")).toBeTruthy();

    // 응답마다 다음 확인을 다시 겁니다(한 번만 확인하고 멈추지 않음).
    ownerCreated = true;
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(sessionCalls()).toBe(3);
    expect(screen.getByText("대시보드 본문")).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("운영자 계정이 없을 때 알림 벨의 읽지 않은 수 401이 세션 응답보다 먼저 와도 로그인으로 보내지 않는다", async () => {
    let answer!: (value: SessionResponse) => void;
    reads[UNREAD] = new api.UnauthorizedError("로그인이 필요합니다");
    api.apiGetShared.mockImplementation((path: string) =>
      path === SESSION ? new Promise<SessionResponse>((resolve) => (answer = resolve)) : serve(path),
    );
    renderLayout();
    await act(async () => {});
    expect(router.replace).not.toHaveBeenCalled();

    await act(async () => answer(OWNER_MISSING));
    expect(screen.getByText("⚠️ 운영자 계정이 아직 없습니다")).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("운영자를 기다리던 때 401을 이미 받았어도, 그 뒤의 401마다 세션을 다시 확인해 로그인 모드로 바뀌었으면 로그인 화면으로 보낸다", async () => {
    // 401 신호(sessionLost)는 한 번 켜지면 내려가지 않습니다. 예전에는 그것만 보고 다시 확인해, 운영자 계정을 기다리던 때의
    // 401(알림 수) 뒤로는 화면 요청이 401이어도 세션을 다시 묻지 않고 '로그인이 필요합니다' 오류에 머물렀습니다.
    vi.useFakeTimers();
    let phase: "missing" | "local" | "login" = "missing";
    reads[SESSION] = () => {
      if (phase === "local") {
        phase = "login";   // 운영자로 연 바로 다음 확인부터는 로그인 모드(LOCAL_NO_LOGIN=false로 make up 한 경우)
        return LOCAL_OWNER;
      }
      return phase === "missing" ? OWNER_MISSING : LOGIN_NONE;
    };
    reads[UNREAD] = new api.UnauthorizedError("로그인이 필요합니다");
    reads[PAGE] = new api.UnauthorizedError("로그인이 필요합니다");
    renderLayout();
    await act(async () => {});
    expect(screen.getByText("⚠️ 운영자 계정이 아직 없습니다")).toBeTruthy();

    phase = "local";
    await act(async () => vi.advanceTimersByTime(5_000));   // 운영자 계정이 생김 → 화면이 열리고 화면 요청이 401
    await act(async () => {});
    await act(async () => {});

    expect(router.replace).toHaveBeenCalledWith("/login");
  });

  it("localhost가 아닌 주소로 열어 운영자로 풀리지 않았으면(ownerMissing 아님) 지금처럼 로그인 화면으로 보낸다", async () => {
    reads[SESSION] = NOT_LOCAL;
    renderLayout();

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByText("⚠️ 운영자 계정이 아직 없습니다")).toBeNull();
  });
});
