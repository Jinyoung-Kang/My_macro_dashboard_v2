/**
 * 정보 검색 화면의 훅(hooks/useInfoSearch.ts).
 *  - 주소가 상태: 대상을 바꾸면 기록에 쌓고(뒤로 가기), 탭·기간은 바꿔 씀, 뒤로 가기면 앞 상태로
 *  - 치는 동안의 후보: 멈춘 뒤 한 번만 묻고(앞 요청은 취소), 비면 묻지 않음, 수집기에 닿지 못하면 그 말
 *  - 결과: 받는 중(pending)이면 몇 초 뒤 다시 읽고, 다 받으면 멈춤 · '지금 새로 받기'는 누를 때 한 번만 refresh=1(단계 3)
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
import { FEED_PENDING_REFRESH_MS } from "@/lib/infoSearch";

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
