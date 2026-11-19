/**
 * 정보 수집 뉴스 탭의 첫 적재 이동 — QA-894(D6 전 QA 스택 확인에서 찾음, 개편 전부터 — 기준 빌드도 같은 꼴).
 *
 * 뉴스 탭은 catalog보다 글 목록이 먼저 오면 그 위에 '보류한 출처' 안내 상자가 뒤늦게 끼어 거르기 줄·목록을 밀었고(1024 첫 적재 CLS 0.11 — QA 자료
 * 글 0편), 글이 10편이면(운영 꼴 합성) 목록이 자라며 아래 출처 패널도 밀어 0.24였습니다.
 *
 * 기대: catalog가 오기 전에는 거르기 줄·목록 대신 읽는 중 한 줄(안내 상자와 목록이 같은 프레임에 나타남). 목록이 처음 답할 때까지(값이든 오류든) 아래
 * 출처 패널은 그리되 보이지 않게(hidden — 요청은 처음부터 함께, 경로·횟수 그대로), 답한 뒤 처음 나타납니다(국내 탭 QA-893과 같은 틀).
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 첫 사례 'expected <button type="button" …(4)></button> to be null'(catalog 전에 목록이 보임),
 * 둘째 사례 'expected null to be truthy'(출처 패널이 처음부터 보임).
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

const DEFERRED = {
  task: "info_saveticker", key: "saveticker", label: "합성 보류 출처", tab: "news", kind: "news", siteUrl: null, origin: "합성", access: "deferred", screen: null,
  speed: null, lastStatus: null, lastRunAt: null, lastDetail: null, politeStatus: null, streak: null, lastOkAt: null, nextDueAt: null, items: null, incident: null, tone: "neutral",
};
const CATALOG = { checkedAt: "2026-11-19 10:00 KST", collectorReachable: true, tabs: [], sources: [DEFERRED], incidents: [] };
const ITEM = {
  id: "0123456789abcdef01234567", source: "blog.synthetic", sourceLabel: "Synthetic Blog", kind: "article", url: "https://blog.example/1/", title: "Rates Spike",
  titleKo: null, author: null, publishedAt: "2026-11-19 09:00 KST", firstSeenAt: "2026-11-19 09:30 KST", summary: null, bodyStatus: "none", fetchTier: null, category: null,
};

/** 경로 앞부분마다 직접 풀 수 있는 응답 — 풀기 전에는 기다리는 중. */
function deferredRoutes(prefixes: string[]) {
  const resolvers = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const promises = new Map<string, Promise<unknown>>();
  for (const prefix of prefixes) {
    promises.set(prefix, new Promise((resolve, reject) => resolvers.set(prefix, { resolve, reject })));
  }
  api.apiGetShared.mockImplementation((path: string) => {
    const hit = prefixes.find((prefix) => path.startsWith(prefix));
    return hit ? (promises.get(hit) as Promise<unknown>) : new Promise(() => {});
  });
  return resolvers;
}
const called = (prefix: string) => api.apiGetShared.mock.calls.map(([path]) => String(path)).filter((path) => path.startsWith(prefix));
/** 제목(h2)이 든 패널이 hidden 안에 있는가. */
const hiddenPanel = (title: string) => screen.getByText(title, { selector: "h2" }).closest("[hidden]");

beforeEach(() => {
  api.apiGetShared.mockReset();
});
afterEach(() => cleanup());

describe("정보 수집 뉴스 탭 첫 적재(QA-894)", () => {
  it.fails("catalog 전에는 거르기 줄·목록 대신 읽는 중 — 목록이 먼저 와도 안내 상자와 목록이 함께 나타난다", async () => {
    const routes = deferredRoutes(["/api/info/catalog", "/api/info/items?kind=blog"]);
    render(<InfoHub tab="news" />);
    await act(async () => routes.get("/api/info/items?kind=blog")?.resolve({ available: true, items: [ITEM], page: 1, size: 10, total: 1, pages: 1 }));
    expect(screen.queryByRole("button", { name: "Rates Spike" })).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    await act(async () => routes.get("/api/info/catalog")?.resolve(CATALOG));
    expect(await screen.findByRole("button", { name: "Rates Spike" })).toBeTruthy();
    expect(screen.getByText("보류한 출처")).toBeTruthy();
  });

  it.fails("목록이 답하기 전에는 아래 출처 패널을 보이지 않게(요청은 처음부터), 답하면 나타난다", async () => {
    const routes = deferredRoutes(["/api/info/catalog", "/api/info/items?kind=blog"]);
    render(<InfoHub tab="news" />);
    await act(async () => routes.get("/api/info/catalog")?.resolve(CATALOG));
    expect(called("/api/info/items?kind=blog")).toHaveLength(1);
    expect(hiddenPanel("출처")).toBeTruthy();
    await act(async () => routes.get("/api/info/items?kind=blog")?.resolve({ available: true, items: [ITEM], page: 1, size: 10, total: 1, pages: 1 }));
    expect(hiddenPanel("출처")).toBeNull();
    // catalog는 뉴스 목록·출처 패널 두 훅이 부름(실제로는 진행 중 요청 하나를 나눠 씀 — infoWritesKeep) — 예전과 같은 두 번.
    expect(called("/api/info/catalog")).toHaveLength(2);
  });
});
