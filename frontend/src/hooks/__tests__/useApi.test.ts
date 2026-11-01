/**
 * useApi 훅 — 화면 전체가 기대는 데이터 읽기 규칙 (CODE-01).
 *
 * 예전에는 훅을 실제로 렌더링해 보는 도구가 없어서, 아래 규칙이 깨져도 빌드·린트는
 * 통과했습니다. 고정하는 것
 *  - BUG-05: 값이 있는데 다시 읽기가 실패하면 값을 지우지 않는다 (refreshError만)
 *  - BUG-01: followRefresh:false면 수동 새로고침 신호에 반응하지 않는다 (세션 확인)
 *  - 경로가 바뀐 뒤 늦게 온 이전 응답이 화면을 되돌리지 않는다
 *  - 401이면 unauthorized, path가 null이면 요청하지 않는다
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);

const signal = vi.hoisted(() => ({ token: 0, notifyUnauthorized: vi.fn() }));
vi.mock("@/hooks/useRefreshSignal", () => ({
  useRefreshSignal: () => ({ token: signal.token, notifyUnauthorized: signal.notifyUnauthorized }),
}));

import { useApi } from "@/hooks/useApi";

/** 밖에서 끝낼 수 있는 응답. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  signal.token = 0;
  signal.notifyUnauthorized.mockReset();
  api.apiGetShared.mockReset();
});

afterEach(() => {
  cleanup();   // vitest는 전역 afterEach가 없어 Testing Library가 스스로 정리하지 않습니다
  vi.useRealTimers();
});

describe("useApi", () => {
  it("path가 null이면 요청하지 않는다", () => {
    const { result } = renderHook(() => useApi(null));
    expect(api.apiGetShared).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ data: null, loading: false, error: null });
  });

  it("값을 받으면 data·loadedAt을 채운다", async () => {
    api.apiGetShared.mockResolvedValue({ v: 1 });
    const { result } = renderHook(() => useApi<{ v: number }>("/api/a"));
    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }));
    expect(result.current.loading).toBe(false);
    expect(result.current.loadedAt).toBeInstanceOf(Date);
  });

  it("BUG-05: 다시 읽기가 실패해도 이전 값을 지우지 않고 refreshError만 알린다", async () => {
    api.apiGetShared.mockResolvedValueOnce({ v: 1 }).mockRejectedValueOnce(new Error("일시 오류"));
    const { result } = renderHook(() => useApi<{ v: number }>("/api/a"));
    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }));

    await act(() => result.current.reload());

    expect(result.current.data).toEqual({ v: 1 });
    expect(result.current.error).toBeNull();
    expect(result.current.refreshError).toBe("일시 오류");
  });

  it("QA-163: 실패할 때마다 failedAt이 새 값 — 같은 문구로 연달아 실패해도 바뀌고, 성공하면 비운다", async () => {
    api.apiGetShared
      .mockResolvedValueOnce({ v: 1 })
      .mockRejectedValueOnce(new Error("일시 오류"))
      .mockRejectedValueOnce(new Error("일시 오류"))
      .mockResolvedValueOnce({ v: 2 });
    const { result } = renderHook(() => useApi<{ v: number }>("/api/a"));
    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }));
    expect(result.current.failedAt).toBeNull();

    await act(() => result.current.reload());
    const first = result.current.failedAt;
    expect(first).toBeInstanceOf(Date);
    await act(() => result.current.reload());
    expect(result.current.refreshError).toBe("일시 오류");
    expect(result.current.failedAt).not.toBe(first);

    await act(() => result.current.reload());
    expect(result.current).toMatchObject({ data: { v: 2 }, refreshError: null, failedAt: null });
  });

  it("경로가 바뀐 뒤의 실패에는 이전 경로의 값을 남기지 않는다", async () => {
    api.apiGetShared.mockResolvedValueOnce({ v: 1 }).mockRejectedValueOnce(new Error("없음"));
    const { result, rerender } = renderHook(({ path }) => useApi<{ v: number }>(path), {
      initialProps: { path: "/api/a" },
    });
    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }));

    rerender({ path: "/api/b" });

    await waitFor(() => expect(result.current.error).toBe("없음"));
    expect(result.current.data).toBeNull();
  });

  it("경로가 바뀐 뒤 늦게 도착한 이전 응답은 버린다", async () => {
    const slow = deferred<{ v: string }>();
    api.apiGetShared.mockImplementation((path: string) =>
      path === "/api/old" ? slow.promise : Promise.resolve({ v: "new" }),
    );
    const { result, rerender } = renderHook(({ path }) => useApi<{ v: string }>(path), {
      initialProps: { path: "/api/old" },
    });

    rerender({ path: "/api/new" });
    await waitFor(() => expect(result.current.data).toEqual({ v: "new" }));

    await act(async () => slow.resolve({ v: "old" }));
    expect(result.current.data).toEqual({ v: "new" });
  });

  it("401이면 unauthorized가 서고 data는 비운다", async () => {
    api.apiGetShared.mockRejectedValue(new api.UnauthorizedError("401"));
    const { result } = renderHook(() => useApi("/api/a"));
    await waitFor(() => expect(result.current.unauthorized).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("수동 새로고침 신호가 바뀌면 다시 읽는다", async () => {
    api.apiGetShared.mockResolvedValue({ v: 1 });
    const { rerender } = renderHook(() => useApi("/api/a"));
    await waitFor(() => expect(api.apiGetShared).toHaveBeenCalledTimes(1));

    signal.token = 1;
    rerender();

    await waitFor(() => expect(api.apiGetShared).toHaveBeenCalledTimes(2));
  });

  it("BUG-01: followRefresh:false면 새로고침 신호에 반응하지 않는다 (세션 확인이 화면을 초기화하지 않게)", async () => {
    api.apiGetShared.mockResolvedValue({ authenticated: true });
    const { result, rerender } = renderHook(() =>
      useApi("/api/auth/session", 0, { followRefresh: false }),
    );
    await waitFor(() => expect(result.current.data).not.toBeNull());

    signal.token = 1;
    rerender();

    expect(result.current.loading).toBe(false);
    expect(api.apiGetShared).toHaveBeenCalledTimes(1);
  });

  it("자동 갱신은 탭이 숨으면 멈추고 돌아오면 즉시 한 번 읽는다", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    api.apiGetShared.mockResolvedValue({ v: 1 });

    renderHook(() => useApi("/api/a", 1_000));
    await act(async () => {});
    expect(api.apiGetShared).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTime(1_000));
    expect(api.apiGetShared).toHaveBeenCalledTimes(2);

    visibility = "hidden";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(api.apiGetShared).toHaveBeenCalledTimes(2);

    visibility = "visible";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(api.apiGetShared).toHaveBeenCalledTimes(3);
  });

  it("경로가 바뀌면 응답이 올 때까지 이전 경로의 값을 내보내지 않는다", async () => {
    // 예전에는 KOSDAQ 응답이 올 때까지 KOSPI 행이 "KOSDAQ" 제목 아래 보였습니다(로딩 표시도 없이).
    const second = deferred<{ v: number }>();
    api.apiGetShared.mockImplementation((path: string) =>
      path === "/api/a" ? Promise.resolve({ v: 1 }) : second.promise,
    );
    const { result, rerender } = renderHook(({ path }) => useApi<{ v: number }>(path), {
      initialProps: { path: "/api/a" },
    });
    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }));

    rerender({ path: "/api/b" });

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();

    await act(async () => second.resolve({ v: 2 }));
    await waitFor(() => expect(result.current.data).toEqual({ v: 2 }));
  });

  it("401을 받으면 세션이 끊겼다고 알린다 — 레이아웃이 로그인으로 보낸다", async () => {
    api.apiGetShared.mockRejectedValue(new api.UnauthorizedError());
    const { result } = renderHook(() => useApi("/api/a"));
    await waitFor(() => expect(result.current.unauthorized).toBe(true));
    expect(signal.notifyUnauthorized).toHaveBeenCalledTimes(1);
  });
});
