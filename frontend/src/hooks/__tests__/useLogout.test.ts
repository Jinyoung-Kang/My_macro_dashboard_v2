/**
 * useLogout · useTaskRunner — 세션이 이미 끝난 뒤의 쓰기(QA-1028).
 *
 * 서버는 세션 없는 `POST /api/auth/logout`에 401을 줍니다(공개 경로가 아님). 수정 전에는 그 401도 다른 실패와 같은 "로그아웃 실패" 글만 남기고 로그인
 * 화면으로 가지 않았고, 수동 태스크 실행(useTaskRunner)은 401을 받아도 세션 만료를 알리지 않았습니다(useApi·useAsyncAction만 알림 — QA-044).
 * 로그인 모드(QA 스택 등)에서만 해당합니다. 'QA-1028:' 두 시험은 재현 커밋에서 it.fails였습니다.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { useLogout } from "@/hooks/useLogout";
import { RefreshProvider, useRefreshSignal } from "@/hooks/useRefreshSignal";
import { useTaskRunner } from "@/hooks/useTaskRunner";
import { auth, NetworkError, UnauthorizedError } from "@/lib/api";

beforeEach(() => {
  router.push.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useLogout", () => {
  it("성공하면 로그인 화면으로", async () => {
    vi.spyOn(auth, "logout").mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useLogout());

    await act(() => result.current.logout());

    expect(router.push).toHaveBeenCalledWith("/login");
    expect(result.current.error).toBeNull();
  });

  it("QA-1028: 세션이 이미 끝났으면(401) 실패 글 없이 로그인 화면으로 보낸다", async () => {
    vi.spyOn(auth, "logout").mockRejectedValue(new UnauthorizedError());
    const { result } = renderHook(() => useLogout());

    await act(() => result.current.logout());

    expect(router.push).toHaveBeenCalledWith("/login");
    expect(result.current.error).toBeNull();
  });

  it("연결 실패(상태 0)는 글을 남기고 화면을 옮기지 않는다 — 세션이 그대로일 수 있다", async () => {
    vi.spyOn(auth, "logout").mockRejectedValue(new NetworkError("백엔드 API(http://localhost:8080)에 연결하지 못했습니다"));
    const { result } = renderHook(() => useLogout());

    await act(() => result.current.logout());

    expect(router.push).not.toHaveBeenCalled();
    expect(result.current.error).toBe("로그아웃 실패 — 백엔드 API(http://localhost:8080)에 연결하지 못했습니다");
  });
});

describe("useTaskRunner", () => {
  const wrapper = ({ children }: { children: ReactNode }) => createElement(RefreshProvider, null, children);
  const stubStatus = (status: number, body: unknown) =>
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })));

  it("QA-1028: 실행 요청이 401이면 세션 만료로 알린다 — 레이아웃이 로그인으로 보낸다", async () => {
    stubStatus(401, { message: "로그인이 필요합니다." });
    const { result } = renderHook(() => ({ runner: useTaskRunner(() => {}), signal: useRefreshSignal() }), { wrapper });

    await act(() => result.current.runner.runTask("macro"));

    expect(result.current.signal.sessionLost).toBe(true);
    expect(result.current.runner.messageTone).toBe("danger");
    expect(result.current.runner.running).toBeNull();
  });

  it("그 밖의 실패(500)는 글만 남기고 세션 만료로 알리지 않는다", async () => {
    stubStatus(500, { message: "수집기에 연결하지 못했습니다." });
    const { result } = renderHook(() => ({ runner: useTaskRunner(() => {}), signal: useRefreshSignal() }), { wrapper });

    await act(() => result.current.runner.runTask("macro"));

    expect(result.current.signal.sessionLost).toBe(false);
    expect(result.current.runner.message).toBe("수집기에 연결하지 못했습니다.");
    expect(result.current.runner.messageTone).toBe("danger");
  });
});
