/**
 * 정보 수집 뉴스 탭 — catalog가 답하지 않을 때 거르기 줄·글 목록 — QA-929(결정 거리 `info-news-catalog-hang` — D6 전 QA 두 번째 고침의 반박 확인에서 찾음).
 *
 * 뉴스 탭은 catalog를 처음 받기 전에 거르기 줄·목록 대신 읽는 중 한 줄을 둡니다(QA-894 — '보류한 출처' 안내 상자와 출처 고르기가 catalog로 정해져,
 * 목록이 먼저 오면 안내 상자가 뒤늦게 끼어 목록을 밀었음). 그런데 그 조건(`firstLoadPending(catalog)`)에 시간 상한이 없어, catalog가 답하지 않고 연결도
 * 끊기지 않으면(hooks/useApi에는 시간 제한이 없음) 이미 받은 글 목록과 검색 칸이 끝없이 '불러오는 중' 한 줄에 머물렀습니다. QA-897의 2초 상한은 아래
 * 출처 패널(InfoHub AfterSettled)만 덮었습니다.
 *
 * 기대: catalog가 2초(QA-897과 같은 상한) 안에 답하지 않으면 catalog 없이 거르기 줄(검색 칸)·글 목록을 보입니다. 출처 고르기는 catalog가 오면 채웁니다.
 * 2초 안에 답하면 답한 때 보이는 것은 그대로입니다(QA-894의 이득).
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 첫 사례 'expected null to be truthy'(2초가 지나도 검색 칸이 없음). 둘째 사례(2초 안에 답함)는
 * 고치기 전에도 통과 — 이득을 지키는지 보는 지킴입니다.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import InfoHub from "../InfoHub";

const ITEM = {
  id: "0123456789abcdef01234567", source: "blog.synthetic", sourceLabel: "Synthetic Blog", kind: "article", url: "https://blog.example/1/", title: "Rates Spike",
  titleKo: null, author: null, publishedAt: "2026-11-19 09:00 KST", firstSeenAt: "2026-11-19 09:30 KST", summary: null, bodyStatus: "none", fetchTier: null, category: null,
};
const LIST = { available: true, items: [ITEM], page: 1, size: 10, total: 1, pages: 1 };
const SOURCE = {
  task: "blogs", key: "blog.synthetic", label: "Synthetic Blog", tab: "news", kind: "blog", siteUrl: null, origin: "합성", access: "unofficial", screen: null,
  speed: null, lastStatus: "OK", lastRunAt: null, lastDetail: null, politeStatus: null, streak: null, lastOkAt: null, nextDueAt: null, items: 1, incident: null,
  tone: "ok",
};
const CATALOG = { checkedAt: "2026-11-19 10:00 KST", collectorReachable: true, tabs: [], sources: [SOURCE], incidents: [] };

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** catalog를 읽는 훅이 둘(뉴스 패널·아래 출처 패널)이라 기다리는 읽기를 모두 모아 함께 답합니다. */
let waiting: ((value: unknown) => void)[] = [];
const answerCatalog = (value: unknown) => waiting.splice(0).forEach((resolve) => resolve(value));
beforeEach(() => {
  waiting = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.startsWith("/api/info/catalog")) return new Promise((resolve) => { waiting.push(resolve); });
    if (path.startsWith("/api/info/items?kind=blog")) return Promise.resolve(LIST);
    return new Promise(() => {});
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("정보 수집 뉴스 탭 catalog가 답하지 않을 때(QA-929)", () => {
  it.fails("catalog가 2초 안에 답하지 않으면 검색 칸·글 목록이 보이고, catalog가 오면 출처 고르기가 채워진다", async () => {
    render(<InfoHub tab="news" />);
    await advance(1_999);
    // 상한 전 — 예전처럼 읽는 중 한 줄(QA-894).
    expect(screen.queryByRole("searchbox")).toBeNull();
    await advance(1);
    // 상한 뒤 — catalog 없이 검색 칸과 받은 글 목록. 출처 고르기는 아직 없음(catalog로 정해짐).
    expect(screen.queryByRole("searchbox")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rates Spike" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: /출처/ })).toBeNull();
    const search = screen.getByRole("searchbox");
    // catalog가 늦게 옴 — 같은 검색 칸 그대로, 출처 고르기가 채워짐.
    await act(async () => answerCatalog(CATALOG));
    await advance(1);
    expect(screen.getByRole("searchbox")).toBe(search);
    expect(screen.getByRole("combobox", { name: /출처/ })).toBeTruthy();
  });

  it("catalog가 2초 안에 답하면 그때 거르기 줄·목록·출처 고르기가 함께 보인다(QA-894 그대로)", async () => {
    render(<InfoHub tab="news" />);
    await advance(500);
    expect(screen.queryByRole("searchbox")).toBeNull();
    await act(async () => answerCatalog(CATALOG));
    await advance(1);
    expect(screen.queryByRole("searchbox")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: /출처/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rates Spike" })).toBeTruthy();
  });
});
