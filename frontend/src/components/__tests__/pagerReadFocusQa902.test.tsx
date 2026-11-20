/**
 * 쪽을 넘겨 새로 읽는 동안의 포커스 — QA-902(`info-news-pager-focus-body`, P7 검토 '뉴스 쪽 번호 뒤 포커스 body'(낮음, 개편 전부터) — 작업대 P8 키보드 경로).
 *
 * 정보 수집 뉴스 목록에서 쪽 번호('2')나 '다음'을 누르면 경로가 바뀌어, 공용 `useApi`가 새 경로의 값이 올 때까지 이전 값을 내보내지 않고(새 제목에 옛 숫자를
 * 붙이지 않으려는 설계) 목록과 쪽 단추가 `Loading`으로 바뀝니다 — 누른 단추가 사라져 크롬이 포커스를 body로 보냈습니다. 공용 `Pager`·`useApi`를 쓰는 모든
 * 쪽 넘김이 같은 꼴입니다(끝 쪽에서 '다음'이 꺼지는 QA-890과는 다른 원인).
 *
 * 기대(규칙 — '다시 시도' QA-901과 같은 keepFocus): 누른 쪽 단추가 사라지면 다시 읽기를 시작한 자리의 제목(목록 패널 머리 제목)으로 옮깁니다. 값이 오면
 * 포커스는 그 제목에 남고 다음 Tab은 새 목록으로 갑니다. 쪽 단추가 남는 넘김(값을 그대로 둔 채 읽는 화면)은 포커스를 옮기지 않습니다(QA-890 그대로).
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 두 사례 모두 'expected <body>…(1)</body> to be <h2 …(1)>…(1)</h2>' 꼴(활성 요소 body).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { Pager } from "@/components/Pager";
import InfoHub from "@/components/screens/info/InfoHub";
import { Loading, Panel } from "@/components/ui";
import { useApi } from "@/hooks/useApi";

const CATALOG = { checkedAt: null, collectorReachable: true, tabs: [], sources: [], incidents: [] };
const item = (n: number) => ({
  id: `0123456789abcdef0123456${n}`, source: "blog.synthetic", sourceLabel: "Synthetic Blog", kind: "article", url: `https://blog.example/${n}/`, title: `Synthetic ${n}`,
  titleKo: null, author: null, publishedAt: "2026-11-19 09:00 KST", firstSeenAt: "2026-11-19 09:30 KST", summary: null, bodyStatus: "none", fetchTier: null, category: null,
});

/** 쪽마다 경로가 바뀌는 목록 — 값이 없으면 Loading(목록·쪽 단추가 함께 사라짐). */
function PagedList() {
  const [page, setPage] = useState(1);
  const read = useApi<{ page: number; pages: number }>(`/api/synthetic/items?page=${page}`);
  return (
    <Panel title="합성 글 목록">
      {read.loading && !read.data ? <Loading /> : <Pager page={read.data?.page ?? 1} pages={read.data?.pages ?? 1} onChange={setPage} label="합성 글" />}
    </Panel>
  );
}

beforeEach(() => {
  api.apiGetShared.mockReset();
});
afterEach(() => cleanup());

describe("쪽을 넘겨 새로 읽는 동안의 포커스(QA-902)", () => {
  it.fails("합성 목록 — 쪽 번호를 누르면 목록 패널 제목으로, 값이 와도 거기 남는다", async () => {
    let finish: (value: unknown) => void = () => {};
    api.apiGetShared.mockImplementation((path: string) =>
      path.endsWith("page=1") ? Promise.resolve({ page: 1, pages: 3 }) : new Promise((resolve) => (finish = resolve)),
    );
    render(<PagedList />);
    const two = await screen.findByRole("button", { name: "2" });
    two.focus();
    await act(async () => fireEvent.click(two));
    expect(screen.queryByRole("navigation", { name: "합성 글 쪽" })).toBeNull();
    const heading = screen.getByRole("heading", { name: "합성 글 목록" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    await act(async () => finish({ page: 2, pages: 3 }));
    expect(within(screen.getByRole("navigation", { name: "합성 글 쪽" })).getByRole("button", { name: "2" }).getAttribute("aria-current")).toBe("page");
    expect(document.activeElement).toBe(heading);
  });

  it.fails("정보 수집 뉴스 목록 — '다음'을 누르면 '뉴스·글' 패널 제목으로", async () => {
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/info/catalog")) return Promise.resolve(CATALOG);
      if (path.startsWith("/api/info/items?kind=blog") && path.includes("page=1")) {
        return Promise.resolve({ available: true, items: [item(1), item(2)], page: 1, size: 10, total: 25, pages: 3 });
      }
      return new Promise(() => {});
    });
    render(<InfoHub tab="news" />);
    const next = within(await screen.findByRole("navigation", { name: "글 목록 쪽" })).getByRole("button", { name: "다음" });
    next.focus();
    await act(async () => fireEvent.click(next));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "뉴스·글", level: 2 })));
  });
});
