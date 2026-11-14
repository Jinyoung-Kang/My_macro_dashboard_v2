/**
 * 정보 검색 화면의 훅(hooks/useInfoSearch.ts).
 *  - 주소가 상태: 대상을 바꾸면 기록에 쌓고(뒤로 가기), 탭·기간은 바꿔 씀, 뒤로 가기면 앞 상태로
 *  - 치는 동안의 후보: 멈춘 뒤 한 번만 묻고(앞 요청은 취소), 비면 묻지 않음, 수집기에 닿지 못하면 그 말
 *  - 결과: 받는 중(pending)이면 몇 초 뒤 다시 읽고, 다 받으면 멈춤 · '지금 새로 받기'는 누를 때 한 번만 refresh=1(단계 3)
 *  - 받는 중 다시 읽기(단계 5 — 계약 §8-6): 5초마다 최대 12번, 겹치지 않음, 보이던 줄을 두고 바꿔 끼움, 대상·탭이 바뀌거나 화면을 떠나면 멈춤,
 *    그 뒤에는 '다시 확인'(누를 때 한 번 읽고 아직이면 다시 12번)
 *  - '/'로 검색창 — 다른 입력칸에서 칠 때는 아님
 * 응답은 모두 합성 값입니다.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: vi.fn() }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("next/navigation", () => import("@/components/screens/search/__tests__/fakeNavigation"));

import { setLocation } from "@/components/screens/search/__tests__/fakeNavigation";
import { useInfoSearchFeed, useInfoSearchSuggest, useInfoSearchUrl, useSlashShortcut } from "@/hooks/useInfoSearch";
import { endpoints } from "@/lib/endpoints";
import { FEED_PENDING_MAX_POLLS, FEED_PENDING_REFRESH_MS } from "@/lib/infoSearch";

beforeEach(() => {
  api.apiGet.mockReset();
  api.apiGetShared.mockReset();
  signal.notifyUnauthorized.mockReset();
  setLocation("/search");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useInfoSearchUrl", () => {
  it("주소를 읽고, 대상을 바꾸면 기록에 쌓고(뒤로 가기 됨) 탭·기간은 바꿔 쓴다", async () => {
    setLocation("/search?q=NVIDIA");
    const { result } = renderHook(() => useInfoSearchUrl());
    expect(result.current.state).toMatchObject({ q: "NVIDIA", e: null });
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");

    act(() => result.current.openEntity("us:NVDA"));
    expect(window.location.search).toBe("?e=us:NVDA&tab=timeline&range=30d");
    expect([push.mock.calls.length, replace.mock.calls.length]).toEqual([1, 0]);
    expect(result.current.state).toMatchObject({ e: "us:NVDA", tab: "timeline", range: "30d" });

    act(() => result.current.setTab("news"));
    act(() => result.current.setRange("1y"));
    expect(window.location.search).toBe("?e=us:NVDA&tab=news&range=1y");
    expect([push.mock.calls.length, replace.mock.calls.length]).toEqual([1, 2]);
    expect(result.current.state).toMatchObject({ tab: "news", range: "1y" });

    // 뒤로 가기 — 앞의 후보 보기로
    act(() => window.history.back());
    await waitFor(() => expect(result.current.state).toMatchObject({ q: "NVIDIA", e: null }));
  });

  it("검색어로 가면 기록에 쌓고, 자동으로 연 대상은 그 자리를 바꿔 씀(뒤로 가기가 다시 자동으로 열지 않게)", () => {
    const { result } = renderHook(() => useInfoSearchUrl());
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");
    act(() => result.current.openQuery("Ken Griffin"));
    expect(window.location.search).toBe(`?q=${encodeURIComponent("Ken Griffin")}`);
    act(() => result.current.replaceEntity("wd:Q3195170"));
    expect(window.location.search).toBe("?e=wd:Q3195170&tab=timeline&range=30d");
    expect([push.mock.calls.length, replace.mock.calls.length]).toEqual([1, 1]);
  });

  it("모양이 틀린 키로는 넘어가지 않는다", () => {
    const { result } = renderHook(() => useInfoSearchUrl());
    act(() => result.current.openEntity("us:bad key"));
    expect(window.location.search).toBe("");
  });
});

describe("useInfoSearchSuggest", () => {
  it("치는 동안은 기다렸다가 멈춘 뒤 한 번 — 앞 요청은 취소하고 지금 검색어의 결과만", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    api.apiGet.mockImplementation((path: string, abort: AbortSignal) => {
      signals.push(abort);
      // 첫 요청만 답하고, 그 뒤 요청은 끝나지 않음(진행 중에 검색어가 바뀜)
      return signals.length === 1
        ? Promise.resolve({ available: true, items: [{ key: "us:NVDA", kind: "company", name: "NVIDIA", sub: "NVDA · 미국", source: "sec" }] })
        : new Promise(() => {});
    });
    const { result, rerender } = renderHook(({ q }) => useInfoSearchSuggest(q, true), { initialProps: { q: "N" } });
    rerender({ q: "NV" });
    rerender({ q: "NVID" });
    expect(api.apiGet).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(api.apiGet).toHaveBeenCalledTimes(1);
    expect(api.apiGet.mock.calls[0][0]).toBe(endpoints.search.suggest("NVID"));
    expect(result.current.items.map((item) => item.name)).toEqual(["NVIDIA"]);

    rerender({ q: "NVIDI" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(signals[1].aborted).toBe(false);
    // 앞 검색어의 결과를 새 검색어 아래 남기지 않음
    expect(result.current.items).toEqual([]);
    expect(result.current.loading).toBe(true);
    rerender({ q: "" });
    expect(signals[1].aborted).toBe(true);
    expect(result.current.items).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it("비었거나 꺼져 있으면 묻지 않고, 수집기에 닿지 못하면 그 말", async () => {
    vi.useFakeTimers();
    api.apiGet.mockResolvedValue({ available: false, message: "수집기에서 응답을 받지 못했습니다." });
    const { result, rerender } = renderHook(({ q, on }) => useInfoSearchSuggest(q, on), { initialProps: { q: "   ", on: true } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(api.apiGet).not.toHaveBeenCalled();
    rerender({ q: "삼성", on: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(api.apiGet).not.toHaveBeenCalled();
    rerender({ q: "삼성", on: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(result.current.message).toBe("수집기에서 응답을 받지 못했습니다.");
    expect(result.current.items).toEqual([]);
  });
});

describe("useInfoSearchFeed", () => {
  it("받는 중인 출처가 있으면 몇 초 뒤 다시 읽고, 다 받으면 멈춘다", async () => {
    vi.useFakeTimers();
    const path = endpoints.search.feed("us:NVDA", "news");
    api.apiGetShared
      .mockResolvedValueOnce({ available: true, items: [], pending: true })
      .mockResolvedValueOnce({ available: true, items: [], pending: false })
      .mockResolvedValue({ available: true, items: [], pending: false });
    const { result } = renderHook(() => useInfoSearchFeed(path));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.data?.pending).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS + 10);
    });
    expect(api.apiGetShared).toHaveBeenCalledTimes(2);
    expect(result.current.data?.pending).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS * 3);
    });
    expect(api.apiGetShared).toHaveBeenCalledTimes(2);
  });

  it("'지금 새로 받기'는 누를 때 한 번만 refresh=1로 부르고 그 응답을 보이며, 뒤이은 보통 읽기(받는 중 다시 읽기)는 refresh 없이 간다", async () => {
    vi.useFakeTimers();
    const path = endpoints.search.feed("us:NVDA", "timeline");
    const refreshPath = endpoints.search.feed("us:NVDA", "timeline", true);
    api.apiGetShared
      .mockResolvedValueOnce({ available: true, items: [], pending: false, fetchedAt: "a" })
      .mockResolvedValue({ available: true, items: [], pending: false, fetchedAt: "c" });
    api.apiGet.mockResolvedValueOnce({ available: true, items: [], pending: true, fetchedAt: "b", refreshNote: "새로 받음" });
    const { result } = renderHook(() => useInfoSearchFeed(path, refreshPath));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.data?.fetchedAt).toBe("a");
    expect(result.current.refreshed).toBeNull();

    await act(async () => {
      await result.current.refresh();
    });
    expect(api.apiGet).toHaveBeenCalledTimes(1);
    expect(api.apiGet).toHaveBeenCalledWith(refreshPath);
    expect(result.current.data?.fetchedAt).toBe("b");
    expect(result.current.refreshed?.refreshNote).toBe("새로 받음");

    // 새로 받은 응답이 받는 중이면 몇 초 뒤 보통 경로로 다시 읽고(refresh 없음), 그 응답이 보입니다.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS + 10);
    });
    expect(api.apiGet).toHaveBeenCalledTimes(1);
    expect(api.apiGetShared.mock.calls.every(([called]) => called === path)).toBe(true);
    expect(result.current.data?.fetchedAt).toBe("c");
    expect(result.current.refreshed).toBeNull();
  });

  it("쓰기 뒤 다시 읽기(reloadAfterWrite)는 그 전에 나간 받는 중 다시 읽기에 합류하지 않고 새로 읽는다 — 늦게 온 앞 응답은 버림", async () => {
    vi.useFakeTimers();
    const path = endpoints.search.feed("us:NVDA", "timeline");
    let late: (value: unknown) => void = () => {};
    let reads = 0;
    api.apiGetShared.mockImplementation(() => {
      reads += 1;
      if (reads === 1) return Promise.resolve({ available: true, items: [{ id: "a" }], pending: true, fetchedAt: "a" });
      // 받는 중 다시 읽기 — 쓰기 전에 나가 쓰기가 끝난 뒤에 옴(옛 별칭으로 만든 결과)
      return new Promise((resolve) => (late = resolve));
    });
    api.apiGet.mockResolvedValue({ available: true, items: [{ id: "new" }], pending: false, fetchedAt: "new" });
    const { result } = renderHook(() => useInfoSearchFeed(path));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS + 10);
    });
    expect(api.apiGetShared).toHaveBeenCalledTimes(2);

    await act(async () => {
      await result.current.reloadAfterWrite();
    });
    expect(api.apiGet).toHaveBeenCalledTimes(1);
    expect(api.apiGet).toHaveBeenCalledWith(path);
    expect(result.current.data?.fetchedAt).toBe("new");
    // 쓰기 뒤의 새 응답은 '새로 받기'가 아님
    expect(result.current.refreshed).toBeNull();

    await act(async () => {
      late({ available: true, items: [{ id: "old" }], pending: true, fetchedAt: "old" });
      await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS * 3);
    });
    expect(result.current.data?.fetchedAt).toBe("new");
    expect(result.current.pendingPhase).toBe("none");
    expect(api.apiGetShared).toHaveBeenCalledTimes(2);
  });

  it("쓰기 뒤 다시 읽기 — 처음 읽기가 아직 오는 중이면 그것이 먼저 도착하게 기다린 뒤 새로 읽어, 늦게 온 처음 읽기가 새 응답을 덮지 않음", async () => {
    const path = endpoints.search.feed("us:NVDA", "timeline");
    let first: (value: unknown) => void = () => {};
    const running = new Promise((resolve) => (first = resolve));
    // 진짜처럼 진행 중인 같은 경로의 GET은 함께 씀
    api.apiGetShared.mockImplementation(() => running);
    api.apiGet.mockResolvedValue({ available: true, items: [{ id: "new" }], pending: false, fetchedAt: "new" });
    const { result } = renderHook(() => useInfoSearchFeed(path));
    await waitFor(() => expect(result.current.loading).toBe(true));

    let done = false;
    let call: Promise<void> = Promise.resolve();
    act(() => {
      call = result.current.reloadAfterWrite().then(() => {
        done = true;
      });
    });
    await act(async () => {
      first({ available: true, items: [{ id: "old" }], pending: false, fetchedAt: "old" });
      await call;
    });
    expect(done).toBe(true);
    expect(api.apiGet).toHaveBeenCalledTimes(1);
    expect(result.current.data?.fetchedAt).toBe("new");
  });

  it("새로 받기 응답이 available:false(수집기에 닿지 못함)면 보이던 묶음을 그대로 두고 실패 사유를 낸다", async () => {
    const path = endpoints.search.feed("us:NVDA", "timeline");
    const refreshPath = endpoints.search.feed("us:NVDA", "timeline", true);
    api.apiGetShared.mockResolvedValue({ available: true, items: [], pending: false, fetchedAt: "a" });
    api.apiGet.mockResolvedValueOnce({ available: false, message: "수집기에서 응답을 받지 못했습니다.", refreshNote: null });
    const { result } = renderHook(() => useInfoSearchFeed(path, refreshPath));
    await waitFor(() => expect(result.current.data?.fetchedAt).toBe("a"));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.data?.available).toBe(true);
    expect(result.current.data?.fetchedAt).toBe("a");
    expect(result.current.refreshed).toBeNull();
    expect(result.current.refreshError).toBe("수집기에서 응답을 받지 못했습니다.");
  });

  it("받는 중이면 5초마다 다시 읽되 12번(1분)까지만 — 그 뒤에는 멈추고 stalled", async () => {
    vi.useFakeTimers();
    const path = endpoints.search.feed("us:NVDA", "news");
    api.apiGetShared.mockResolvedValue({ available: true, items: [], pending: true });
    const { result } = renderHook(() => useInfoSearchFeed(path));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(api.apiGetShared).toHaveBeenCalledTimes(1);
    expect(result.current.pendingPhase).toBe("polling");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS - 100);
    });
    expect(api.apiGetShared).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(api.apiGetShared).toHaveBeenCalledTimes(2);
    for (let at = 0; at < FEED_PENDING_MAX_POLLS + 3; at += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS);
      });
    }
    expect(api.apiGetShared).toHaveBeenCalledTimes(1 + FEED_PENDING_MAX_POLLS);
    expect(api.apiGetShared.mock.calls.every(([called]) => called === path)).toBe(true);
    expect(result.current.pendingPhase).toBe("stalled");
    expect(result.current.data?.pending).toBe(true);
  });

  it("다시 읽는 동안 보이던 줄은 그대로 두고, 새 응답이 오면 바꿔 끼운다 — 앞 요청이 끝나기 전에는 다음 요청을 보내지 않는다", async () => {
    vi.useFakeTimers();
    const path = endpoints.search.feed("us:NVDA", "timeline");
    let finish: (value: unknown) => void = () => {};
    api.apiGetShared
      .mockResolvedValueOnce({ available: true, items: [{ id: "a" }], pending: true })
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      .mockResolvedValue({ available: true, items: [{ id: "a" }, { id: "b" }, { id: "c" }], pending: false });
    const { result } = renderHook(() => useInfoSearchFeed(path));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS + 10);
    });
    expect(api.apiGetShared).toHaveBeenCalledTimes(2);
    expect(result.current.data?.items?.map((item) => item.id)).toEqual(["a"]);
    // 응답이 오지 않는 동안에는 다음 요청을 보내지 않음(겹치지 않음)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS * 4);
    });
    expect(api.apiGetShared).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(false);
    await act(async () => {
      finish({ available: true, items: [{ id: "a" }, { id: "b" }], pending: true });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.data?.items?.map((item) => item.id)).toEqual(["a", "b"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS + 10);
    });
    expect(api.apiGetShared).toHaveBeenCalledTimes(3);
    expect(result.current.data?.items?.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(result.current.pendingPhase).toBe("none");
  });

  it("다시 읽기가 실패하거나 수집기에 닿지 못하면(available:false) 보이던 묶음을 두고 횟수만 센다", async () => {
    vi.useFakeTimers();
    const path = endpoints.search.feed("us:NVDA", "news");
    api.apiGetShared
      .mockResolvedValueOnce({ available: true, items: [{ id: "a" }], pending: true, fetchedAt: "a" })
      .mockResolvedValueOnce({ available: false, message: "수집기에서 응답을 받지 못했습니다." })
      .mockRejectedValueOnce(new Error("네트워크 오류"))
      .mockResolvedValue({ available: true, items: [{ id: "a" }], pending: true, fetchedAt: "a" });
    const { result } = renderHook(() => useInfoSearchFeed(path));
    for (const ms of [10, FEED_PENDING_REFRESH_MS + 10, FEED_PENDING_REFRESH_MS + 10]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    }
    expect(api.apiGetShared).toHaveBeenCalledTimes(3);
    expect(result.current.data?.available).toBe(true);
    expect(result.current.data?.fetchedAt).toBe("a");
    expect(result.current.error).toBeNull();
    for (let at = 0; at < FEED_PENDING_MAX_POLLS; at += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS);
      });
    }
    expect(api.apiGetShared).toHaveBeenCalledTimes(1 + FEED_PENDING_MAX_POLLS);
    expect(result.current.pendingPhase).toBe("stalled");
  });

  it("경로(대상·탭)가 바뀌면 앞 경로의 다시 읽기를 멈추고, 화면을 떠나면 더 부르지 않는다", async () => {
    vi.useFakeTimers();
    const news = endpoints.search.feed("us:NVDA", "news");
    const timeline = endpoints.search.feed("us:NVDA", "timeline");
    api.apiGetShared.mockImplementation((called: string) =>
      Promise.resolve({ available: true, items: [], pending: called === news, fetchedAt: called }),
    );
    const { result, rerender, unmount } = renderHook(({ path }) => useInfoSearchFeed(path), { initialProps: { path: news } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.pendingPhase).toBe("polling");
    rerender({ path: timeline });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS * 3);
    });
    expect(api.apiGetShared.mock.calls.map(([called]) => called)).toEqual([news, timeline]);
    expect(result.current.data?.fetchedAt).toBe(timeline);

    rerender({ path: news });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    const before = api.apiGetShared.mock.calls.length;
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS * 3);
    });
    expect(api.apiGetShared.mock.calls.length).toBe(before);
  });

  it("탭이 숨어 있으면 다시 읽기를 미루고, 보이면 그때 읽는다", async () => {
    vi.useFakeTimers();
    const path = endpoints.search.feed("us:NVDA", "news");
    api.apiGetShared.mockResolvedValue({ available: true, items: [], pending: true });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      renderHook(() => useInfoSearchFeed(path));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS * 3);
      });
      expect(api.apiGetShared).toHaveBeenCalledTimes(1);
      visibility.mockReturnValue("visible");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(api.apiGetShared).toHaveBeenCalledTimes(2);
    } finally {
      visibility.mockRestore();
    }
  });

  it("'다시 확인'은 멈춘 뒤 한 번 읽고, 아직 받는 중이면 다시 12번까지 — 읽는 동안 또 누르면 보내지 않음", async () => {
    vi.useFakeTimers();
    const path = endpoints.search.feed("us:NVDA", "news");
    api.apiGetShared.mockResolvedValue({ available: true, items: [], pending: true });
    const { result } = renderHook(() => useInfoSearchFeed(path));
    for (let at = 0; at <= FEED_PENDING_MAX_POLLS + 1; at += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS);
      });
    }
    expect(result.current.pendingPhase).toBe("stalled");
    const stalledCalls = api.apiGetShared.mock.calls.length;
    let finish: (value: unknown) => void = () => {};
    api.apiGetShared.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await act(async () => {
      void result.current.recheck();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.rechecking).toBe(true);
    await act(async () => {
      void result.current.recheck();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(api.apiGetShared.mock.calls.length).toBe(stalledCalls + 1);
    await act(async () => {
      finish({ available: true, items: [{ id: "x" }], pending: true });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.rechecking).toBe(false);
    expect(result.current.pendingPhase).toBe("polling");
    expect(result.current.data?.items?.map((item) => item.id)).toEqual(["x"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS + 10);
    });
    expect(api.apiGetShared.mock.calls.length).toBe(stalledCalls + 2);
  });

  it("'다시 확인'이 실패하면 사유를 내고 멈춘 상태 그대로", async () => {
    vi.useFakeTimers();
    const path = endpoints.search.feed("us:NVDA", "news");
    api.apiGetShared.mockResolvedValue({ available: true, items: [], pending: true });
    const { result } = renderHook(() => useInfoSearchFeed(path));
    for (let at = 0; at <= FEED_PENDING_MAX_POLLS + 1; at += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS);
      });
    }
    api.apiGetShared.mockRejectedValueOnce(new Error("네트워크 오류"));
    await act(async () => {
      await result.current.recheck();
    });
    expect(result.current.recheckError).toBe("네트워크 오류");
    expect(result.current.pendingPhase).toBe("stalled");
  });

  it("'다시 확인'의 실패 사유는 그 멈춤에만 — 새로 받기나 대상·탭 바꿈 뒤 다시 멈추면 앞의 실패를 보이지 않는다", async () => {
    vi.useFakeTimers();
    const news = endpoints.search.feed("us:NVDA", "news");
    const timeline = endpoints.search.feed("us:NVDA", "timeline");
    const refreshPath = endpoints.search.feed("us:NVDA", "news", true);
    api.apiGetShared.mockResolvedValue({ available: true, items: [], pending: true });
    api.apiGet.mockResolvedValue({ available: true, items: [], pending: true, fetchedAt: "fresh" });
    const { result, rerender } = renderHook(({ path }) => useInfoSearchFeed(path, refreshPath), { initialProps: { path: news } });
    const stall = async () => {
      for (let at = 0; at <= FEED_PENDING_MAX_POLLS + 1; at += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS);
        });
      }
      expect(result.current.pendingPhase).toBe("stalled");
    };
    const failRecheck = async () => {
      api.apiGetShared.mockRejectedValueOnce(new Error("네트워크 오류"));
      await act(async () => {
        await result.current.recheck();
      });
      expect(result.current.recheckError).toBe("네트워크 오류");
    };

    await stall();
    await failRecheck();
    // 새로 받기 — 받는 중이라 다시 12번 읽고 멈춤(이번 멈춤에는 '다시 확인'을 누르지 않음)
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.pendingPhase).toBe("polling");
    await stall();
    expect(result.current.recheckError).toBeNull();

    await failRecheck();
    rerender({ path: timeline });
    await stall();
    expect(result.current.recheckError).toBeNull();
  });

  it("다시 읽기 응답을 기다리는 동안 경로가 바뀌거나 화면을 떠나면, 늦게 온 응답은 버리고 더 부르지 않는다", async () => {
    vi.useFakeTimers();
    const news = endpoints.search.feed("us:NVDA", "news");
    const timeline = endpoints.search.feed("us:NVDA", "timeline");
    const late: ((value: unknown) => void)[] = [];
    let first = true;
    api.apiGetShared.mockImplementation((called: string) => {
      if (called === timeline) return Promise.resolve({ available: true, items: [{ id: "t" }], pending: false, fetchedAt: "t" });
      if (first) {
        first = false;
        return Promise.resolve({ available: true, items: [{ id: "a" }], pending: true, fetchedAt: "a" });
      }
      // 다시 읽기는 끝나지 않고 기다림 — 아래에서 경로를 바꾼 뒤에 답함
      return new Promise((resolve) => late.push(resolve));
    });
    const { result, rerender, unmount } = renderHook(({ path }) => useInfoSearchFeed(path), { initialProps: { path: news } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS + 10);
    });
    expect(late).toHaveLength(1);

    rerender({ path: timeline });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.data?.fetchedAt).toBe("t");
    await act(async () => {
      late[0]({ available: true, items: [{ id: "late" }], pending: true, fetchedAt: "late" });
      await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS * 3);
    });
    expect(result.current.data?.items?.map((item) => item.id)).toEqual(["t"]);
    expect(result.current.pendingPhase).toBe("none");
    expect(api.apiGetShared.mock.calls.filter(([called]) => called === news)).toHaveLength(2);

    // 같은 경로로 돌아와(처음 읽기 = late[1]) 다시 읽기(late[2])를 기다리는 중에 화면을 떠남 — 늦은 응답이 와도 더 부르지 않음
    rerender({ path: news });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(late).toHaveLength(2);
    await act(async () => {
      late[1]({ available: true, items: [{ id: "a" }], pending: true, fetchedAt: "again" });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.pendingPhase).toBe("polling");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS + 10);
    });
    expect(late).toHaveLength(3);
    const before = api.apiGetShared.mock.calls.length;
    unmount();
    await act(async () => {
      late[2]({ available: true, items: [], pending: true, fetchedAt: "gone" });
      await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS * 3);
    });
    expect(api.apiGetShared.mock.calls.length).toBe(before);
  });

  it("새로 받기로 보이는 응답이 바뀌면 다시 읽기 횟수를 0부터 센다(아직 받는 중이면 다시 12번까지)", async () => {
    vi.useFakeTimers();
    const path = endpoints.search.feed("us:NVDA", "news");
    const refreshPath = endpoints.search.feed("us:NVDA", "news", true);
    api.apiGetShared.mockResolvedValue({ available: true, items: [], pending: true });
    api.apiGet.mockResolvedValue({ available: true, items: [], pending: true, fetchedAt: "fresh" });
    const { result } = renderHook(() => useInfoSearchFeed(path, refreshPath));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    const polled = 4;
    for (let at = 0; at < polled; at += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS);
      });
    }
    expect(api.apiGetShared).toHaveBeenCalledTimes(1 + polled);
    await act(async () => {
      await result.current.refresh();
    });
    for (let at = 0; at <= FEED_PENDING_MAX_POLLS + 2; at += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FEED_PENDING_REFRESH_MS);
      });
    }
    // 처음 1번 + 새로 받기 앞 4번 + 새로 받기 뒤 12번(새로 받기 자체는 apiGet — refresh=1)
    expect(api.apiGetShared).toHaveBeenCalledTimes(1 + polled + FEED_PENDING_MAX_POLLS);
    expect(api.apiGet).toHaveBeenCalledTimes(1);
    expect(result.current.pendingPhase).toBe("stalled");
  });

  it("새로 받기 경로가 없으면(데모) 부르지 않는다", async () => {
    api.apiGetShared.mockResolvedValue({ available: true, items: [], pending: false });
    const { result } = renderHook(() => useInfoSearchFeed(endpoints.search.feed("us:NVDA", "news")));
    await act(async () => {
      await result.current.refresh();
    });
    expect(api.apiGet).not.toHaveBeenCalled();
  });
});

describe("useSlashShortcut", () => {
  function Harness() {
    const ref = useRef<HTMLInputElement>(null);
    useSlashShortcut(ref);
    return (
      <>
        <input aria-label="검색" ref={ref} />
        <textarea aria-label="메모" />
      </>
    );
  }

  it("'/'를 누르면 검색창으로 — 다른 입력칸에서 친 '/'는 그대로 글자", () => {
    render(<Harness />);
    const memo = screen.getByLabelText("메모");
    memo.focus();
    fireEvent.keyDown(memo, { key: "/" });
    expect(document.activeElement).toBe(memo);

    (document.activeElement as HTMLElement).blur();
    const prevented = !fireEvent.keyDown(document.body, { key: "/" });
    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText("검색"));
  });
});
