/**
 * 정보 검색 AI 요약(계약 §9-6)의 훅(hooks/useInfoSearchSummary.ts).
 *  - 누를 때만 POST /api/search/summary {e, tab, range} 한 번(읽는 동안 다시 눌러도 한 번)
 *  - 서버는 요약을 한 번에 하나만 만들므로(다른 요약을 만드는 중이면 429) 화면도 앞 요청이 끝나기 전에는 새로 보내지 않음 — 대상·탭·기간을
 *    바꿔도, 화면을 다시 그려도(탭 전환) 그대로(busy)
 *  - 대상·탭·기간이 바뀌면 패널을 비움. 읽는 중인 요청의 열쇠로 돌아오면 읽는 중으로 보이고 그 응답을 받음. 이미 끝난 요약은 돌아와도 보이지 않음
 *  - 닫기(clear)도 비우고 그 요청의 응답을 버림(끝날 때까지 잠금은 그대로)
 *  - 수집기·엔진에 닿지 못한 응답(available:false)과 요청 실패는 실패 글, 세션이 끝났으면(401) 로그인으로 보냄
 * 응답은 모두 합성 값이고 실제 AI를 부르지 않습니다(lib/api를 가짜로 둠).
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiPost: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: vi.fn() }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { resetSummaryRequestsForTest, useInfoSearchSummary } from "@/hooks/useInfoSearchSummary";
import { endpoints } from "@/lib/endpoints";
import type { SearchSummaryRequest, SearchSummaryResponse } from "@/lib/types";

const DONE: SearchSummaryResponse = {
  available: true,
  summary: [{ text: "합성 요약 한 줄", refs: ["a"] }],
  basedOn: 3,
  model: "synthetic-model-1",
  generatedAt: "2026-11-14T01:05:00+00:00",
  cached: false,
};

/** 붙잡은 POST — resolve·reject를 시험이 부를 때 끝납니다. */
type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void };
let pending: Pending[];

beforeEach(() => {
  resetSummaryRequestsForTest();
  pending = [];
  api.apiPost.mockReset();
  api.apiPost.mockImplementation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  signal.notifyUnauthorized.mockReset();
});
afterEach(() => cleanup());

const request = (over: Partial<SearchSummaryRequest> = {}): SearchSummaryRequest => ({ e: "us:SYNT", tab: "timeline", range: "30d", ...over });

/** 요청을 바꿔 가며 다시 그리는 훅. */
function renderSwitchable(initial: SearchSummaryRequest | null = request()) {
  return renderHook(({ value }) => useInfoSearchSummary(value), { initialProps: { value: initial } });
}

describe("useInfoSearchSummary — 부르기", () => {
  it("누를 때 한 번 POST {e, tab, range} — 읽는 동안 다시 눌러도 한 번, 받으면 done", async () => {
    const { result } = renderHook(() => useInfoSearchSummary(request()));
    expect(result.current.phase).toBe("idle");
    expect(result.current.busy).toBe(false);
    expect(api.apiPost).not.toHaveBeenCalled();

    act(() => void result.current.summarize());
    act(() => void result.current.summarize());
    expect(result.current.phase).toBe("loading");
    expect(result.current.busy).toBe(true);
    expect(api.apiPost).toHaveBeenCalledTimes(1);
    expect(api.apiPost).toHaveBeenCalledWith(endpoints.search.summary, { e: "us:SYNT", tab: "timeline", range: "30d" });

    await act(async () => pending[0].resolve(DONE));
    expect(result.current.phase).toBe("done");
    expect(result.current.busy).toBe(false);
    expect(result.current.response).toEqual(DONE);
    expect(result.current.error).toBeNull();
  });

  it("요청이 없으면(운영자가 아님) 부르지 않음", () => {
    const { result } = renderHook(() => useInfoSearchSummary(null));
    act(() => void result.current.summarize());
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
  });

  it("수집기·엔진에 닿지 못한 응답(available:false)은 실패 글 — 서버 사유와 함께", async () => {
    const { result } = renderHook(() => useInfoSearchSummary(request()));
    act(() => void result.current.summarize());
    await act(async () => pending[0].resolve({ available: false, message: "오늘 AI 글자 상한을 다 썼습니다." }));
    expect(result.current.phase).toBe("error");
    expect(result.current.error).toBe("요약하지 못했습니다 — 오늘 AI 글자 상한을 다 썼습니다.");
    expect(result.current.response).toBeNull();
    expect(result.current.busy).toBe(false);
  });

  it("요청 실패는 실패 글, 다시 누르면 다시 부름", async () => {
    const { result } = renderHook(() => useInfoSearchSummary(request()));
    act(() => void result.current.summarize());
    await act(async () => pending[0].reject(new Error("네트워크 오류")));
    expect(result.current.phase).toBe("error");
    expect(result.current.error).toBe("요약하지 못했습니다 — 네트워크 오류");
    expect(result.current.busy).toBe(false);

    act(() => void result.current.summarize());
    expect(result.current.phase).toBe("loading");
    expect(result.current.error).toBeNull();
    await act(async () => pending[1].resolve(DONE));
    expect(result.current.phase).toBe("done");
  });

  it("세션이 끝났으면(401) 로그인 화면으로 보냄", async () => {
    const { result } = renderHook(() => useInfoSearchSummary(request()));
    act(() => void result.current.summarize());
    await act(async () => pending[0].reject(new api.UnauthorizedError("로그인이 필요합니다")));
    expect(signal.notifyUnauthorized).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("error");
  });
});

describe("useInfoSearchSummary — 한 번에 하나(서버는 겹치면 429)", () => {
  it("읽는 동안 기간을 바꾸면 비우고 잠금 — 바뀐 기간에서 눌러도 앞 요청이 끝날 때까지 보내지 않음", async () => {
    const { result, rerender } = renderSwitchable();
    act(() => void result.current.summarize());
    rerender({ value: request({ range: "7d" }) });
    expect(result.current.phase).toBe("idle");
    expect(result.current.busy).toBe(true);

    act(() => void result.current.summarize());
    expect(api.apiPost).toHaveBeenCalledTimes(1);

    // 앞 요청이 끝나면 풀림 — 그 응답은 7일 패널에 보이지 않음
    await act(async () => pending[0].resolve(DONE));
    expect(result.current.phase).toBe("idle");
    expect(result.current.response).toBeNull();
    expect(result.current.busy).toBe(false);

    act(() => void result.current.summarize());
    expect(api.apiPost).toHaveBeenCalledTimes(2);
    expect(api.apiPost).toHaveBeenLastCalledWith(endpoints.search.summary, { e: "us:SYNT", tab: "timeline", range: "7d" });
    const second = { ...DONE, basedOn: 9 };
    await act(async () => pending[1].resolve(second));
    expect(result.current.phase).toBe("done");
    expect(result.current.response).toEqual(second);
  });

  it("읽는 동안 다른 기간에 갔다 돌아오면 읽는 중으로 보이고 그 응답을 받음 — 다시 눌러도 보내지 않음", async () => {
    const { result, rerender } = renderSwitchable();
    act(() => void result.current.summarize());
    rerender({ value: request({ range: "7d" }) });
    rerender({ value: request() });
    expect(result.current.phase).toBe("loading");
    expect(result.current.busy).toBe(true);

    act(() => void result.current.summarize());
    expect(api.apiPost).toHaveBeenCalledTimes(1);

    await act(async () => pending[0].resolve(DONE));
    expect(result.current.phase).toBe("done");
    expect(result.current.response).toEqual(DONE);
  });

  it("다른 기간에 가 있는 동안 끝난 요약은 돌아와도 보이지 않음(비움) — 다시 누르면 새로 부름", async () => {
    const { result, rerender } = renderSwitchable();
    act(() => void result.current.summarize());
    rerender({ value: request({ range: "7d" }) });
    await act(async () => pending[0].resolve(DONE));
    rerender({ value: request() });
    expect(result.current.phase).toBe("idle");
    expect(result.current.response).toBeNull();
    expect(result.current.busy).toBe(false);

    act(() => void result.current.summarize());
    expect(api.apiPost).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toBe("loading");
  });

  it("받은 요약은 기간을 바꿨다 돌아오면 보이지 않음(비움)", async () => {
    const { result, rerender } = renderSwitchable();
    act(() => void result.current.summarize());
    await act(async () => pending[0].resolve(DONE));
    expect(result.current.phase).toBe("done");
    rerender({ value: request({ range: "7d" }) });
    expect(result.current.phase).toBe("idle");
    rerender({ value: request() });
    expect(result.current.phase).toBe("idle");
    expect(result.current.response).toBeNull();
  });

  it("대상·탭이 바뀌어도 비우고, 앞 요청이 끝날 때까지 잠금", async () => {
    const { result, rerender } = renderSwitchable();
    act(() => void result.current.summarize());
    rerender({ value: request({ tab: "news" }) });
    expect(result.current.phase).toBe("idle");
    expect(result.current.busy).toBe(true);
    rerender({ value: request({ tab: "news", e: "kr:000001" }) });
    expect(result.current.phase).toBe("idle");
    act(() => void result.current.summarize());
    expect(api.apiPost).toHaveBeenCalledTimes(1);
    await act(async () => pending[0].resolve(DONE));
    expect(result.current.phase).toBe("idle");
    expect(result.current.busy).toBe(false);
  });

  it("닫기(clear)는 비우고 그 응답을 버림 — 끝날 때까지 잠금은 그대로", async () => {
    const { result } = renderHook(() => useInfoSearchSummary(request()));
    act(() => void result.current.summarize());
    act(() => result.current.clear());
    expect(result.current.phase).toBe("idle");
    expect(result.current.busy).toBe(true);
    act(() => void result.current.summarize());
    expect(api.apiPost).toHaveBeenCalledTimes(1);

    await act(async () => pending[0].resolve(DONE));
    expect(result.current.phase).toBe("idle");
    expect(result.current.response).toBeNull();
    expect(result.current.busy).toBe(false);
  });

  it("받은 요약을 닫은 뒤 다시 누르면 새 요청의 응답만 보임", async () => {
    const { result } = renderHook(() => useInfoSearchSummary(request()));
    act(() => void result.current.summarize());
    await act(async () => pending[0].resolve(DONE));
    act(() => result.current.clear());
    expect(result.current.phase).toBe("idle");

    act(() => void result.current.summarize());
    expect(api.apiPost).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toBe("loading");
    const second = { ...DONE, cached: true };
    await act(async () => pending[1].resolve(second));
    expect(result.current.phase).toBe("done");
    expect(result.current.response).toEqual(second);
  });
});

describe("useInfoSearchSummary — 화면을 다시 그릴 때(탭 전환·다른 대상)", () => {
  it("다시 그린 화면이 같은 대상·탭·기간이면 읽는 중으로 보이고 그 응답을 받음 — 두 번 보내지 않음", async () => {
    const first = renderHook(() => useInfoSearchSummary(request()));
    act(() => void first.result.current.summarize());
    first.unmount();

    const again = renderHook(() => useInfoSearchSummary(request()));
    expect(again.result.current.phase).toBe("loading");
    expect(again.result.current.busy).toBe(true);
    act(() => void again.result.current.summarize());
    expect(api.apiPost).toHaveBeenCalledTimes(1);

    await act(async () => pending[0].resolve(DONE));
    expect(again.result.current.phase).toBe("done");
    expect(again.result.current.response).toEqual(DONE);
  });

  it("다시 그린 화면이 다른 탭이면 앞 요청이 끝날 때까지 보내지 않음", async () => {
    const first = renderHook(() => useInfoSearchSummary(request()));
    act(() => void first.result.current.summarize());
    first.unmount();

    const other = renderHook(() => useInfoSearchSummary(request({ tab: "news" })));
    expect(other.result.current.phase).toBe("idle");
    expect(other.result.current.busy).toBe(true);
    act(() => void other.result.current.summarize());
    expect(api.apiPost).toHaveBeenCalledTimes(1);

    await act(async () => pending[0].resolve(DONE));
    expect(other.result.current.phase).toBe("idle");
    expect(other.result.current.busy).toBe(false);
    act(() => void other.result.current.summarize());
    expect(api.apiPost).toHaveBeenCalledTimes(2);
    expect(api.apiPost).toHaveBeenLastCalledWith(endpoints.search.summary, { e: "us:SYNT", tab: "news", range: "30d" });
  });

  it("화면을 떠난 동안 끝난 요약은 다시 열어도 보이지 않음(비움)", async () => {
    const first = renderHook(() => useInfoSearchSummary(request()));
    act(() => void first.result.current.summarize());
    first.unmount();
    await act(async () => pending[0].resolve(DONE));

    const again = renderHook(() => useInfoSearchSummary(request()));
    expect(again.result.current.phase).toBe("idle");
    expect(again.result.current.response).toBeNull();
    expect(again.result.current.busy).toBe(false);
  });
});
